/**
 * Deterministic, test-only MCP/JSON-RPC stdio fixture.
 *
 * This process deliberately implements only the newline-delimited subset that
 * the generic stdio-client tests exercise. It never reads files or environment
 * variables, opens sockets, uses credentials, or writes outside stdout/stderr.
 * Faults are selected explicitly with `--mode <name>` (or the first argument).
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type JsonRpcId = number | string | null;

const FIXTURE_MODES = [
  'valid-initialize',
  'protocol-version-negotiation',
  'tools-list-one-page',
  'tools-list-multi-page',
  'cycling-cursor',
  'duplicate-cursor',
  'tool-call-success',
  'tool-call-is-error',
  'json-rpc-error',
  'out-of-order-valid-ids',
  'notification-interleaved',
  'unsupported-server-request',
  'mismatched-response-id',
  'duplicate-response-id',
  'malformed-json',
  'invalid-json-rpc',
  'malformed-response',
  'invalid-response',
  'invalid-tool-result',
  'stdout-contamination',
  'bounded-stderr',
  'excessive-stderr',
  'delayed-response',
  'request-timeout',
  'late-response-after-cancellation',
  'cancellation-ignored',
  'eof-outstanding',
  'nonzero-exit',
  'refuse-exit',
  'partial-stdout-chunks',
  'multiple-lines-one-chunk',
  'transcript-excess',
] as const;

type FixtureMode = (typeof FIXTURE_MODES)[number];

const MODE_ALIASES: Readonly<Record<string, FixtureMode>> = {
  valid: 'valid-initialize',
  initialize: 'valid-initialize',
  negotiation: 'protocol-version-negotiation',
  'one-page': 'tools-list-one-page',
  'single-page': 'tools-list-one-page',
  'multi-page': 'tools-list-multi-page',
  'cursor-cycle': 'cycling-cursor',
  'cycle-cursor': 'cycling-cursor',
  'cursor-duplicate': 'duplicate-cursor',
  success: 'tool-call-success',
  'is-error': 'tool-call-is-error',
  'rpc-error': 'json-rpc-error',
  'out-of-order': 'out-of-order-valid-ids',
  'interleaved-notification': 'notification-interleaved',
  'server-request': 'unsupported-server-request',
  'mismatched-id': 'mismatched-response-id',
  'duplicate-id': 'duplicate-response-id',
  malformed: 'malformed-json',
  invalid: 'invalid-json-rpc',
  'bad-response-shape': 'malformed-response',
  'bad-rpc-error': 'invalid-response',
  'bad-tool-result': 'invalid-tool-result',
  contamination: 'stdout-contamination',
  stderr: 'bounded-stderr',
  'stderr-excess': 'excessive-stderr',
  delayed: 'delayed-response',
  timeout: 'request-timeout',
  'late-response': 'late-response-after-cancellation',
  'ignore-cancellation': 'cancellation-ignored',
  eof: 'eof-outstanding',
  crash: 'nonzero-exit',
  'forced-shutdown': 'refuse-exit',
  partial: 'partial-stdout-chunks',
  'multiple-lines': 'multiple-lines-one-chunk',
  'transcript-cap': 'transcript-excess',
};

interface RpcMessage {
  jsonrpc?: Json;
  id?: Json;
  method?: Json;
  params?: Json;
  result?: Json;
  error?: Json;
  [key: string]: Json | undefined;
}

interface HeldToolCall {
  id: JsonRpcId;
  params: JsonObject;
}

const mode = readMode(process.argv.slice(2));
const excessiveStderrBytes = readBoundedIntegerOption(
  process.argv.slice(2),
  '--stderr-bytes',
  64 * 1024,
  1,
  2 * 1024 * 1024,
);
const transcriptLines = readBoundedIntegerOption(process.argv.slice(2), '--transcript-lines', 128, 1, 2_048);

let initialized = false;
let inputBuffer = '';
let stdoutEnded = false;
let heldToolCall: HeldToolCall | null = null;
let pendingServerRequestCall: HeldToolCall | null = null;
let keepAlive: NodeJS.Timeout | null = null;

const ECHO_TOOL: JsonObject = {
  name: 'echo',
  title: 'Fixture echo',
  description: 'Return the supplied message and metadata.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message to return' },
      metadata: {
        type: 'object',
        properties: { labels: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    },
    required: ['message'],
    additionalProperties: false,
    'x-input-extension': { retained: true },
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      tool: { type: 'string' },
      arguments: { type: 'object' },
    },
    required: ['ok', 'tool', 'arguments'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    'x-annotation-extension': 'preserve-me',
  },
  'x-fixture-extension': { nested: { value: 7 }, values: ['alpha', 'beta'] },
};

const ADD_TOOL: JsonObject = {
  name: 'add_numbers',
  title: 'Add numbers',
  description: 'Add a list of finite numbers.',
  inputSchema: {
    type: 'object',
    properties: { values: { type: 'array', items: { type: 'number' }, minItems: 1 } },
    required: ['values'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { total: { type: 'number' } },
    required: ['total'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  'x-page-marker': 2,
};

const METADATA_TOOL: JsonObject = {
  name: 'inspect_metadata',
  title: 'Inspect metadata',
  description: 'Return deterministic fixture metadata.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  'x-page-marker': 3,
};

if (mode === 'bounded-stderr') {
  process.stderr.write('fixture stderr: bounded diagnostic\n');
}

if (mode === 'excessive-stderr') {
  process.stderr.write('E'.repeat(excessiveStderrBytes));
}

if (mode === 'refuse-exit') {
  keepAlive = setInterval(() => undefined, 1_000);
  process.on('SIGTERM', () => {
    process.stderr.write('fixture intentionally ignored SIGTERM\n');
  });
}

process.stdout.on('error', handlePipeError);
process.stderr.on('error', handlePipeError);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  inputBuffer += chunk;
  drainInputLines();
});
process.stdin.on('end', () => {
  if (inputBuffer.length > 0) {
    const trailing = inputBuffer;
    inputBuffer = '';
    handleInputLine(trailing.endsWith('\r') ? trailing.slice(0, -1) : trailing);
  }
  if (mode !== 'refuse-exit' && keepAlive !== null) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
});

function readMode(args: string[]): FixtureMode {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--mode') {
      raw = args[i + 1];
      break;
    }
    if (arg.startsWith('--mode=')) {
      raw = arg.slice('--mode='.length);
      break;
    }
    if (!arg.startsWith('-')) {
      raw = arg;
      break;
    }
  }

  const candidate = raw ?? 'valid-initialize';
  if ((FIXTURE_MODES as readonly string[]).includes(candidate)) return candidate as FixtureMode;
  const alias = MODE_ALIASES[candidate];
  if (alias !== undefined) return alias;

  process.stderr.write(`unknown fixture mode '${candidate}'; expected one of: ${FIXTURE_MODES.join(', ')}\n`);
  process.exit(64);
}

function readBoundedIntegerOption(
  args: string[],
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === name) {
      raw = args[i + 1];
      break;
    }
    if (arg.startsWith(`${name}=`)) {
      raw = arg.slice(name.length + 1);
      break;
    }
  }
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    process.stderr.write(`${name} must be an integer from ${minimum} through ${maximum}\n`);
    process.exit(64);
  }
  return parsed;
}

function handlePipeError(error: Error & { code?: string }): void {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
}

function drainInputLines(): void {
  while (true) {
    const newline = inputBuffer.indexOf('\n');
    if (newline === -1) return;
    let line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    handleInputLine(line);
  }
}

function handleInputLine(line: string): void {
  if (line.length === 0) {
    sendError(null, -32600, 'blank request frame');
    return;
  }

  let parsed: Json;
  try {
    parsed = JSON.parse(line) as Json;
  } catch {
    sendError(null, -32700, 'parse error');
    return;
  }

  if (!isObject(parsed)) {
    sendError(null, -32600, 'request must be an object');
    return;
  }

  const message = parsed as RpcMessage;
  if (message.jsonrpc !== '2.0') {
    sendError(validId(message.id) ? message.id : null, -32600, 'jsonrpc must be 2.0');
    return;
  }

  if (typeof message.method === 'string') {
    const id = validId(message.id) ? message.id : undefined;
    if (id === undefined) handleNotification(message.method, asObject(message.params));
    else handleRequest(id, message.method, asObject(message.params));
    return;
  }

  if (validId(message.id) && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
    handleClientResponse(message.id);
    return;
  }

  sendError(validId(message.id) ? message.id : null, -32600, 'invalid JSON-RPC message');
}

function handleRequest(id: JsonRpcId, method: string, params: JsonObject): void {
  switch (method) {
    case 'initialize':
      sendInitializeResponse(id, params);
      return;
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      if (!requireInitialized(id)) return;
      sendToolsPage(id, params);
      return;
    case 'tools/call':
      if (!requireInitialized(id)) return;
      handleToolCall({ id, params });
      return;
    default:
      sendError(id, -32601, `fixture method not found: ${method}`);
  }
}

function handleNotification(method: string, params: JsonObject): void {
  switch (method) {
    case 'notifications/initialized':
      initialized = true;
      return;
    case 'notifications/cancelled':
      handleCancellation(params);
      return;
    case 'notifications/fixture/release':
      if (heldToolCall !== null) {
        const held = heldToolCall;
        heldToolCall = null;
        setImmediate(() => sendSuccessfulToolResult(held));
      }
      return;
    default:
      // Unknown client notifications intentionally receive no response.
      return;
  }
}

function handleClientResponse(id: JsonRpcId): void {
  if (id !== 'fixture-server-request-1' || pendingServerRequestCall === null) return;
  const call = pendingServerRequestCall;
  pendingServerRequestCall = null;
  setImmediate(() => sendSuccessfulToolResult(call));
}

function sendInitializeResponse(id: JsonRpcId, params: JsonObject): void {
  const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
  const negotiated = mode === 'protocol-version-negotiation' ? '2025-06-18' : requested;
  sendResult(id, {
    protocolVersion: negotiated,
    capabilities: {
      tools: { listChanged: true },
      logging: {},
      experimental: { deterministicFixture: true, mode },
    },
    serverInfo: {
      name: 'oculory-test-protocol-fixture',
      version: '1.0.0',
      title: 'Oculory deterministic protocol fixture',
      'x-server-extension': 'retained',
    },
    instructions: 'Deterministic test fixture only.',
    'x-initialize-extension': { retained: true },
  });
}

function requireInitialized(id: JsonRpcId): boolean {
  if (initialized) return true;
  sendError(id, -32002, 'fixture is not initialized');
  return false;
}

function sendToolsPage(id: JsonRpcId, params: JsonObject): void {
  const cursor = typeof params.cursor === 'string' ? params.cursor : null;

  switch (mode) {
    case 'tools-list-multi-page':
      if (cursor === null) sendResult(id, { tools: [ECHO_TOOL], nextCursor: 'page-2' });
      else if (cursor === 'page-2') sendResult(id, { tools: [ADD_TOOL], nextCursor: 'page-3' });
      else if (cursor === 'page-3') sendResult(id, { tools: [METADATA_TOOL] });
      else sendError(id, -32602, `unknown fixture cursor: ${cursor}`);
      return;
    case 'cycling-cursor':
      if (cursor === null) sendResult(id, { tools: [ECHO_TOOL], nextCursor: 'cycle-a' });
      else if (cursor === 'cycle-a') sendResult(id, { tools: [ADD_TOOL], nextCursor: 'cycle-b' });
      else if (cursor === 'cycle-b') sendResult(id, { tools: [METADATA_TOOL], nextCursor: 'cycle-a' });
      else sendError(id, -32602, `unknown fixture cursor: ${cursor}`);
      return;
    case 'duplicate-cursor':
      if (cursor === null) sendResult(id, { tools: [ECHO_TOOL], nextCursor: 'duplicate' });
      else if (cursor === 'duplicate') sendResult(id, { tools: [ADD_TOOL], nextCursor: 'duplicate' });
      else sendError(id, -32602, `unknown fixture cursor: ${cursor}`);
      return;
    default:
      sendResult(id, { tools: [ECHO_TOOL, ADD_TOOL] });
  }
}

function handleToolCall(call: HeldToolCall): void {
  switch (mode) {
    case 'tool-call-is-error':
      sendResult(call.id, {
        content: [{ type: 'text', text: 'fixture tool error' }],
        structuredContent: { code: 'FIXTURE_TOOL_ERROR', rejected: true },
        isError: true,
        'x-result-extension': { retained: true },
      });
      return;
    case 'json-rpc-error':
      sendError(call.id, -32042, 'fixture JSON-RPC error', { category: 'fixture', retryable: false });
      return;
    case 'out-of-order-valid-ids':
      if (heldToolCall === null) {
        heldToolCall = call;
        sendNotification('notifications/fixture/waiting-for-second-request', { requestId: call.id });
      } else {
        const first = heldToolCall;
        heldToolCall = null;
        sendSuccessfulToolResult(call);
        setImmediate(() => sendSuccessfulToolResult(first));
      }
      return;
    case 'notification-interleaved':
      sendNotification('notifications/progress', {
        progressToken: 'fixture-progress-1',
        progress: 1,
        total: 1,
        message: 'before tool response',
      });
      sendSuccessfulToolResult(call);
      return;
    case 'unsupported-server-request':
      pendingServerRequestCall = call;
      sendLine({
        jsonrpc: '2.0',
        id: 'fixture-server-request-1',
        method: 'sampling/createMessage',
        params: { messages: [], maxTokens: 1 },
      });
      return;
    case 'mismatched-response-id':
      sendResult(mismatchedId(call.id), successfulToolResult(call.params));
      return;
    case 'duplicate-response-id': {
      const line = encodeLine({ jsonrpc: '2.0', id: call.id, result: successfulToolResult(call.params) });
      writeRaw(line + line);
      return;
    }
    case 'malformed-json':
      writeRaw('{"jsonrpc":"2.0","id":\n');
      return;
    case 'invalid-json-rpc':
      sendLine({ jsonrpc: '1.0', id: call.id, result: successfulToolResult(call.params) });
      return;
    case 'malformed-response':
      sendLine({
        jsonrpc: '2.0',
        id: call.id,
        result: successfulToolResult(call.params),
        error: { code: -32000, message: 'result and error cannot coexist' },
      });
      return;
    case 'invalid-response':
      sendLine({
        jsonrpc: '2.0',
        id: call.id,
        error: { code: 'not-an-integer', message: 'invalid error object' },
      });
      return;
    case 'invalid-tool-result':
      sendResult(call.id, { isError: false, structuredContent: { missingContent: true } });
      return;
    case 'stdout-contamination':
      writeRaw('fixture diagnostic incorrectly written to stdout\n');
      return;
    case 'delayed-response':
      if (asObject(call.params.arguments).waitForRelease === true) {
        heldToolCall = call;
        sendNotification('notifications/fixture/waiting', { requestId: call.id });
      } else {
        setImmediate(() => sendSuccessfulToolResult(call));
      }
      return;
    case 'request-timeout':
      heldToolCall = call;
      sendNotification('notifications/fixture/waiting-for-cancellation', { requestId: call.id });
      return;
    case 'late-response-after-cancellation':
      heldToolCall = call;
      sendNotification('notifications/fixture/waiting-for-cancellation', { requestId: call.id });
      return;
    case 'cancellation-ignored':
      heldToolCall = call;
      sendNotification('notifications/fixture/waiting-for-cancellation', { requestId: call.id });
      return;
    case 'eof-outstanding':
      stdoutEnded = true;
      process.stdout.end();
      return;
    case 'nonzero-exit':
      setImmediate(() => process.exit(23));
      return;
    case 'multiple-lines-one-chunk': {
      const notification = encodeLine({
        jsonrpc: '2.0',
        method: 'notifications/fixture/batched',
        params: { beforeResponse: true },
      });
      const response = encodeLine({ jsonrpc: '2.0', id: call.id, result: successfulToolResult(call.params) });
      writeRaw(notification + response);
      return;
    }
    case 'transcript-excess': {
      let output = '';
      for (let index = 0; index < transcriptLines; index += 1) {
        output += encodeLine({
          jsonrpc: '2.0',
          method: 'notifications/fixture/transcript-fill',
          params: { index, text: 'T'.repeat(96) },
        });
      }
      writeRaw(output);
      return;
    }
    default:
      sendSuccessfulToolResult(call);
  }
}

function handleCancellation(params: JsonObject): void {
  if (mode === 'cancellation-ignored') return;
  const cancelledId = validId(params.requestId) ? params.requestId : null;
  if (heldToolCall === null || heldToolCall.id !== cancelledId) return;

  const held = heldToolCall;
  heldToolCall = null;

  if (mode === 'late-response-after-cancellation') {
    setImmediate(() => {
      sendResult(held.id, {
        content: [{ type: 'text', text: 'late fixture response after cancellation' }],
        structuredContent: { late: true, cancelledRequestId: held.id },
        isError: false,
      });
    });
    return;
  }

  if (mode === 'request-timeout') {
    sendNotification('notifications/fixture/cancellation-observed', {
      requestId: held.id,
      reason: typeof params.reason === 'string' ? params.reason : null,
    });
  }
}

function sendSuccessfulToolResult(call: HeldToolCall): void {
  sendResult(call.id, successfulToolResult(call.params));
}

function successfulToolResult(params: JsonObject): JsonObject {
  const name = typeof params.name === 'string' ? params.name : 'unknown';
  const args = asObject(params.arguments);
  return {
    content: [{ type: 'text', text: 'fixture tool success' }],
    structuredContent: { ok: true, tool: name, arguments: args },
    isError: false,
    'x-result-extension': { retained: true },
  };
}

function mismatchedId(id: JsonRpcId): JsonRpcId {
  if (typeof id === 'number') return id + 1_000;
  if (typeof id === 'string') return `${id}-mismatch`;
  return 'mismatched-null-id';
}

function sendResult(id: JsonRpcId, result: Json): void {
  sendLine({ jsonrpc: '2.0', id, result });
}

function sendError(id: JsonRpcId, code: number, message: string, data?: Json): void {
  const error: JsonObject = { code, message };
  if (data !== undefined) error.data = data;
  sendLine({ jsonrpc: '2.0', id, error });
}

function sendNotification(method: string, params: JsonObject): void {
  sendLine({ jsonrpc: '2.0', method, params });
}

function sendLine(message: JsonObject): void {
  const line = encodeLine(message);
  if (mode !== 'partial-stdout-chunks') {
    writeRaw(line);
    return;
  }

  const bytes = Buffer.from(line, 'utf8');
  const firstEnd = Math.min(1, bytes.length);
  const secondEnd = Math.max(firstEnd, Math.floor(bytes.length / 2));
  const chunks = [bytes.subarray(0, firstEnd), bytes.subarray(firstEnd, secondEnd), bytes.subarray(secondEnd)];
  writeBufferChunks(chunks, 0);
}

function writeBufferChunks(chunks: Buffer[], index: number): void {
  if (index >= chunks.length || stdoutEnded) return;
  const chunk = chunks[index]!;
  if (chunk.length > 0) process.stdout.write(chunk);
  if (index + 1 < chunks.length) setImmediate(() => writeBufferChunks(chunks, index + 1));
}

function writeRaw(text: string): void {
  if (stdoutEnded || process.stdout.writableEnded) return;
  process.stdout.write(text);
}

function encodeLine(message: JsonObject): string {
  return `${JSON.stringify(message)}\n`;
}

function validId(value: Json | undefined): value is JsonRpcId {
  return value === null || typeof value === 'number' || typeof value === 'string';
}

function asObject(value: Json | undefined): JsonObject {
  return isObject(value) ? value : {};
}

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
