import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { McpStdioClient } from '../mcp/client/stdio-client.js';
import type { McpToolCallOutcome } from '../mcp/client/types.js';
import type { JsonObject } from '../schema/types.js';
import { redactEvidence, sanitizeDiagnostic, sensitiveEnvironmentValues } from './redact.js';

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const SESSION_CLOSE_GRACE_MS = 1_000;

export interface ParentProxyConfiguration {
  upstream: {
    command: string;
    arguments: string[];
    cwd: string;
    environment: Readonly<Record<string, string>>;
  };
  private_roots: readonly string[];
  sensitive_values?: readonly string[];
}

export interface ParentProxyResult {
  events: unknown[];
  connected: boolean;
  cleanup_passed: boolean;
  error: string | null;
}

export interface ParentProxyHandle {
  endpoint: string;
  close(): Promise<ParentProxyResult>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface EvidenceRecorder {
  readonly events: unknown[];
  record(kind: string, value: unknown): void;
}

export async function startParentProxy(
  configuration: ParentProxyConfiguration,
  endpoint: string,
): Promise<ParentProxyHandle> {
  validateParentConfiguration(configuration);
  if (endpoint.length === 0) throw new Error('proxy endpoint must not be empty');

  const sensitiveValues = [
    ...sensitiveEnvironmentValues(configuration.upstream.environment),
    ...(configuration.sensitive_values ?? []),
  ];
  const recorder = createEvidenceRecorder(configuration.private_roots, sensitiveValues);
  let accepted = false;
  let socket: Socket | null = null;
  let client: McpStdioClient | null = null;
  let cleanupPassed = false;
  let sessionError: string | null = null;
  let sessionPromise: Promise<void> | null = null;
  let closePromise: Promise<ParentProxyResult> | null = null;
  let stopPromise: Promise<void> | null = null;

  const server = createServer((connection) => {
    if (accepted) {
      connection.destroy();
      return;
    }
    accepted = true;
    socket = connection;
    connection.setNoDelay(true);
    client = createClient(configuration);
    sessionPromise = runProxySession(
      client,
      connection,
      connection,
      recorder,
      configuration.private_roots,
      sensitiveValues,
      (passed) => {
        cleanupPassed = passed;
      },
    );
    void sessionPromise.then(
      () => finishConnection(connection),
      (error: unknown) => {
        sessionError = sanitizeDiagnostic(errorMessage(error), configuration.private_roots, sensitiveValues);
        finishConnection(connection);
      },
    );
  });

  const stopServer = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopPromise = new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
    return stopPromise;
  };

  await listen(server, endpoint);
  if (process.platform !== 'win32') chmodSync(endpoint, 0o600);

  return {
    endpoint,
    close(): Promise<ParentProxyResult> {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        const stopped = stopServer();
        if (socket !== null && !socket.destroyed) socket.end();
        if (sessionPromise !== null && !(await settlesWithin(sessionPromise, SESSION_CLOSE_GRACE_MS))) {
          socket?.destroy();
          try {
            await client?.close();
          } catch (error) {
            if (sessionError === null) sessionError = sanitizeDiagnostic(errorMessage(error), configuration.private_roots, sensitiveValues);
          }
        }
        if (sessionPromise !== null) {
          try {
            await sessionPromise;
          } catch (error) {
            if (sessionError === null) sessionError = sanitizeDiagnostic(errorMessage(error), configuration.private_roots, sensitiveValues);
          }
        }
        try {
          await stopped;
        } catch (error) {
          if (sessionError === null) sessionError = sanitizeDiagnostic(errorMessage(error), configuration.private_roots, sensitiveValues);
        }
        const endpointAbsent = removeOwnedSocket(endpoint);
        return {
          events: [...recorder.events],
          connected: accepted,
          cleanup_passed: accepted && cleanupPassed && endpointAbsent,
          error: sessionError,
        };
      })();
      return closePromise;
    },
  };
}

export async function runRelay(endpoint: string): Promise<void> {
  if (endpoint.length === 0) throw new Error('relay endpoint must not be empty');
  const socket = createConnection(endpoint);
  await once(socket, 'connect');
  process.stdin.pipe(socket);
  socket.pipe(process.stdout, { end: false });
  await new Promise<void>((resolve, reject) => {
    socket.once('close', () => resolve());
    socket.once('error', reject);
    process.stdin.once('error', reject);
    process.stdout.once('error', reject);
  });
}

async function runProxySession(
  client: McpStdioClient,
  input: Readable,
  output: Writable,
  recorder: EvidenceRecorder,
  privateRoots: readonly string[],
  sensitiveValues: readonly string[],
  setCleanup: (passed: boolean) => void,
): Promise<void> {
  let sessionError: unknown = null;
  try {
    const upstreamStart = await client.start();
    recorder.record('proxy_started', { process: upstreamStart });
    for await (const line of boundedLines(input)) {
      let request: JsonRpcRequest;
      try {
        request = parseRequest(line);
      } catch (error) {
        recorder.record('agent_request_rejected', {
          reason: 'malformed_json_rpc',
          frame_bytes: Buffer.byteLength(line),
        });
        await writeResponse(output, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: sanitizeDiagnostic(errorMessage(error), privateRoots, sensitiveValues) },
        });
        continue;
      }
      recorder.record('agent_request', request);
      if (request.id === undefined) {
        recorder.record('agent_notification', { method: request.method });
        continue;
      }
      try {
        const result = scrubSensitiveValues(await forward(client, request), sensitiveValues) as JsonObject;
        const response = { jsonrpc: '2.0' as const, id: request.id, result };
        recorder.record('upstream_response', { request_id: request.id, method: request.method, result });
        await writeResponse(output, response);
      } catch (error) {
        const message = sanitizeDiagnostic(errorMessage(error), privateRoots, sensitiveValues);
        const response = { jsonrpc: '2.0' as const, id: request.id, error: { code: -32000, message } };
        recorder.record('upstream_error', { request_id: request.id, method: request.method, message });
        await writeResponse(output, response);
      }
    }
  } catch (error) {
    sessionError = error;
  } finally {
    try {
      const cleanup = await client.close();
      const passed = cleanup.liveness.childAlive === false &&
        cleanup.liveness.managedProcessGroupAlive === false;
      setCleanup(passed);
      recorder.record('proxy_cleanup', { close: cleanup, diagnostics: client.diagnostics() });
    } catch (error) {
      setCleanup(false);
      if (sessionError === null) sessionError = error;
    }
  }
  if (sessionError !== null) throw sessionError;
}

function createClient(configuration: ParentProxyConfiguration): McpStdioClient {
  return new McpStdioClient({
    executable: configuration.upstream.command,
    args: configuration.upstream.arguments,
    cwd: configuration.upstream.cwd,
    env: configuration.upstream.environment,
    clientInfo: { name: 'oculory-proxy', version: '0.1.0' },
    requestedProtocolVersion: '2024-11-05',
    acceptedProtocolVersions: ['2024-11-05', '2025-03-26', '2025-06-18'],
    limits: {
      startupTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
      maxToolListPages: 50,
      maxFrameBytes: MAX_FRAME_BYTES,
      maxStderrBytes: 64 * 1024,
      maxTranscriptBytes: MAX_EVIDENCE_BYTES,
    },
    manageProcessGroup: true,
  });
}

async function forward(client: McpStdioClient, request: JsonRpcRequest): Promise<JsonObject> {
  if (request.method === 'initialize') return (await client.initialize({ timeoutMs: 2_000 })).rawResult;
  if (request.method === 'tools/list') {
    const discovery = await client.listTools();
    return { tools: discovery.tools.map((tool) => tool.raw) };
  }
  if (request.method === 'tools/call') {
    const params = requireObject(request.params, 'tools/call params');
    if (typeof params.name !== 'string') throw new Error('tools/call params.name must be a string');
    const args = params.arguments === undefined ? {} : requireObject(params.arguments, 'tools/call arguments');
    return outcomeResult(await client.callTool(params.name, args));
  }
  if (request.method === 'ping') return {};
  throw new Error(`unsupported proxied MCP method: ${request.method}`);
}

function outcomeResult(outcome: McpToolCallOutcome): JsonObject {
  if (outcome.kind === 'tool_success' || outcome.kind === 'tool_error') return outcome.rawResult;
  if (outcome.kind === 'json_rpc_error') throw new Error(`upstream JSON-RPC error: ${outcome.error?.message ?? 'unknown error'}`);
  const unsupported: never = outcome;
  throw new Error(`upstream returned an unsupported outcome: ${String(unsupported)}`);
}

async function* boundedLines(input: Readable): AsyncGenerator<string> {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    while (true) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > MAX_FRAME_BYTES) throw new Error('agent MCP frame exceeded the 1 MiB cap');
      let frame = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      yield decoder.decode(frame);
    }
    if (buffered.length > MAX_FRAME_BYTES) throw new Error('agent MCP frame exceeded the 1 MiB cap');
  }
  if (buffered.length > 0) {
    if (buffered.length > MAX_FRAME_BYTES) throw new Error('agent MCP frame exceeded the 1 MiB cap');
    if (buffered.at(-1) === 0x0d) buffered = buffered.subarray(0, -1);
    yield decoder.decode(buffered);
  }
}

function parseRequest(line: string): JsonRpcRequest {
  const value = JSON.parse(line) as unknown;
  const object = requireObject(value, 'JSON-RPC request');
  if (object.jsonrpc !== '2.0' || typeof object.method !== 'string') throw new Error('invalid JSON-RPC request');
  if (object.id !== undefined && object.id !== null && typeof object.id !== 'number' && typeof object.id !== 'string') {
    throw new Error('invalid JSON-RPC request ID');
  }
  return object as unknown as JsonRpcRequest;
}

function requireObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

async function writeResponse(output: Writable, response: unknown): Promise<void> {
  if (!output.write(`${JSON.stringify(response)}\n`)) await once(output, 'drain');
}

function createEvidenceRecorder(privateRoots: readonly string[], sensitiveValues: readonly string[]): EvidenceRecorder {
  const events: unknown[] = [];
  let totalBytes = 0;
  return {
    events,
    record(kind: string, value: unknown): void {
      const event = redactEvidence({ kind, value }, privateRoots, sensitiveValues);
      const eventBytes = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (totalBytes + eventBytes > MAX_EVIDENCE_BYTES) throw new Error('proxy evidence exceeded the 4 MiB cap');
      totalBytes += eventBytes;
      events.push(event);
    },
  };
}

function scrubSensitiveValues(value: unknown, sensitiveValues: readonly string[]): unknown {
  return scrubSensitiveValue(value, [...new Set(sensitiveValues.filter((entry) => entry.length > 0))].sort((left, right) => right.length - left.length));
}

function scrubSensitiveValue(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === 'string') {
    let safe = value;
    for (const sensitive of sensitiveValues) safe = safe.split(sensitive).join('[REDACTED]');
    return safe;
  }
  if (Array.isArray(value)) return value.map((entry) => scrubSensitiveValue(entry, sensitiveValues));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      scrubSensitiveValue(key, sensitiveValues),
      scrubSensitiveValue(entry, sensitiveValues),
    ]),
  );
}

function validateParentConfiguration(configuration: ParentProxyConfiguration): void {
  const upstream = configuration.upstream;
  if (
    typeof upstream.command !== 'string' || upstream.command.length === 0 ||
    !Array.isArray(upstream.arguments) || upstream.arguments.some((entry) => typeof entry !== 'string') ||
    typeof upstream.cwd !== 'string' || upstream.cwd.length === 0 ||
    upstream.environment === null || typeof upstream.environment !== 'object' || Array.isArray(upstream.environment) ||
    Object.entries(upstream.environment).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string') ||
    !Array.isArray(configuration.private_roots) || configuration.private_roots.some((entry) => typeof entry !== 'string') ||
    (configuration.sensitive_values !== undefined && (
      !Array.isArray(configuration.sensitive_values) || configuration.sensitive_values.some((entry) => typeof entry !== 'string')
    ))
  ) throw new Error('invalid parent proxy configuration');
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function finishConnection(socket: Socket): void {
  if (!socket.destroyed) socket.end();
}

function removeOwnedSocket(endpoint: string): boolean {
  if (process.platform === 'win32' || !existsSync(endpoint)) return true;
  try {
    if (!lstatSync(endpoint).isSocket()) return false;
    unlinkSync(endpoint);
    return !existsSync(endpoint);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
