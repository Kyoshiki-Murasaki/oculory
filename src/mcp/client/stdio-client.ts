import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256 } from '../../schema/canonical.js';
import type { Json, JsonObject } from '../../schema/types.js';
import {
  McpClientError,
  type AsyncMcpClient,
  type JsonRpcId,
  type McpCancellationRecord,
  type McpCancellationState,
  type McpClientDiagnostics,
  type McpClientFailure,
  type McpClientFailureKind,
  type McpClientLimits,
  type McpClientRequestId,
  type McpClientState,
  type McpCloseRecord,
  type McpDiscoveredTool,
  type McpInitializeRecord,
  type McpJsonRpcErrorObject,
  type McpProcessExitRecord,
  type McpProcessLivenessProof,
  type McpProcessStartRecord,
  type McpRequestHandle,
  type McpRequestOptions,
  type McpShutdownEscalation,
  type McpStdioClientOptions,
  type McpToolCallOutcome,
  type McpToolDiscoveryPage,
  type McpToolDiscoveryRecord,
  type McpToolListOptions,
  type McpTranscriptEvent,
  type McpTranscriptEventKind,
} from './types.js';

const DEFAULT_LIMITS: McpClientLimits = {
  startupTimeoutMs: 2_000,
  requestTimeoutMs: 2_000,
  postCancellationTimeoutMs: 100,
  gracefulShutdownTimeoutMs: 500,
  sigtermTimeoutMs: 500,
  sigkillTimeoutMs: 500,
  maxToolListPages: 32,
  maxFrameBytes: 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  maxTranscriptBytes: 5 * 1024 * 1024,
};

interface InternalRpcResult {
  kind: 'result';
  result: Json;
  rawResponse: JsonObject;
  responseTranscriptSequence: number;
}

interface InternalRpcError {
  kind: 'error';
  error: McpJsonRpcErrorObject;
  rawResponse: JsonObject;
  responseTranscriptSequence: number;
}

type InternalRpcOutcome = InternalRpcResult | InternalRpcError;

interface PendingRequest {
  id: McpClientRequestId;
  method: string;
  requestTranscriptSequence: number;
  cancelAllowed: boolean;
  timer: NodeJS.Timeout;
  responseReceived: boolean;
  candidate: InternalRpcOutcome | null;
  resolve: (outcome: InternalRpcOutcome) => void;
  reject: (error: McpClientError) => void;
}

interface CancelledRequestTombstone {
  state: 'cancelled' | 'timed_out';
  reason: string;
  lateResponseSeen: boolean;
}

interface InternalRequestHandle extends McpRequestHandle<InternalRpcOutcome> {
  readonly method: string;
  readonly requestTranscriptSequence: number;
}

interface OutboundFrameRecord {
  sequence: number;
  flushed: Promise<void>;
}

interface AppendEventInput extends Omit<McpTranscriptEvent, 'sequence' | 'monotonicOffsetMs'> {
  bypassLimit?: boolean;
}

interface ParsedInboundResponse {
  id: JsonRpcId;
  kind: 'result' | 'error';
  result?: Json;
  error?: McpJsonRpcErrorObject;
  raw: JsonObject;
}

interface FrameLimitContext {
  direction: 'client_to_server' | 'server_to_client';
  requestId: JsonRpcId;
  method: string | null;
  digest: string;
}

/**
 * A deliberately narrow, evidence-preserving MCP client for newline-delimited
 * JSON-RPC over child-process stdio. It is additive to the frozen synchronous
 * McpEndpoint and is not a complete MCP implementation.
 */
export class McpStdioClient implements AsyncMcpClient {
  private readonly options: McpStdioClientOptions;
  private readonly limits: McpClientLimits;
  private readonly shouldManageProcessGroup: boolean;
  private readonly startedAt = process.hrtime.bigint();

  private state: McpClientState = 'created';
  private child: ChildProcessWithoutNullStreams | null = null;
  private pid: number | null = null;
  private processGroupId: number | null = null;
  private processGroupManaged = false;
  private nextRequestId = 1;
  private stdoutBuffer = Buffer.alloc(0);
  private stdoutEof = false;
  private stderrEof = false;
  private processExit: McpProcessExitRecord | null = null;
  private exitWaiters: (() => void)[] = [];

  private nextTranscriptSequence = 1;
  private transcriptBytes = 0;
  private stderrBytes = 0;
  private largestFrameBytes = 0;
  private transcriptLimitTriggered = false;
  private transcriptLimitEvent: McpTranscriptEvent | null = null;
  private stderrLimitTriggered = false;
  private frameLimitTriggered = false;
  private readonly transcriptEvents: McpTranscriptEvent[] = [];
  private readonly failures: McpClientFailure[] = [];
  private fatalFailure: McpClientFailure | null = null;

  private readonly pending = new Map<McpClientRequestId, PendingRequest>();
  private readonly settled = new Set<McpClientRequestId>();
  private readonly cancelled = new Map<McpClientRequestId, CancelledRequestTombstone>();
  private closePromise: Promise<McpCloseRecord> | null = null;

  constructor(options: McpStdioClientOptions) {
    this.options = copyAndValidateOptions(options);
    this.limits = resolveLimits(this.options.limits);
    this.shouldManageProcessGroup =
      (this.options.manageProcessGroup ?? true) && process.platform !== 'win32';
  }

  async start(): Promise<McpProcessStartRecord> {
    this.requireState('created', 'start');
    this.state = 'starting';

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.executable, [...this.options.args], {
        cwd: this.options.cwd,
        env: { ...this.options.env },
        shell: false,
        detached: this.shouldManageProcessGroup,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = this.failure(
        'spawn_error',
        `failed to spawn executable: ${errorMessage(error)}`,
        null,
        null,
        { executable: this.options.executable },
      );
      this.addFailure(failure, true);
      throw new McpClientError(failure);
    }

    this.child = child;
    this.pid = child.pid ?? null;
    this.processGroupManaged = this.shouldManageProcessGroup && this.pid !== null;
    this.processGroupId = this.processGroupManaged ? this.pid : null;
    this.attachChildHandlers(child);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const failure = this.failure(
          'spawn_error',
          `process did not spawn within ${this.limits.startupTimeoutMs}ms`,
          null,
          null,
          { timeout_ms: this.limits.startupTimeoutMs },
        );
        this.addFailure(failure, true);
        reject(new McpClientError(failure));
      }, this.limits.startupTimeoutMs);

      child.once('spawn', () => {
        if (settled) return;
        this.pid = child.pid ?? this.pid;
        this.processGroupManaged = this.shouldManageProcessGroup && this.pid !== null;
        this.processGroupId = this.processGroupManaged ? this.pid : null;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const failure = this.failure(
          'spawn_error',
          `child process error before spawn: ${error.message}`,
          null,
          null,
          { executable: this.options.executable },
        );
        this.addFailure(failure, true);
        reject(new McpClientError(failure));
      });
    });

    if (child.pid === undefined) {
      const failure = this.failure('spawn_error', 'spawned process has no PID', null, null, {});
      this.addFailure(failure, true);
      throw new McpClientError(failure);
    }

    this.pid = child.pid;
    this.processGroupManaged = this.shouldManageProcessGroup;
    this.processGroupId = this.processGroupManaged ? child.pid : null;
    this.state = 'running';
    const event = this.appendEvent({
      direction: 'process',
      kind: 'spawn',
      requestId: null,
    });
    if (this.fatalFailure !== null) throw new McpClientError(this.fatalFailure);

    return {
      pid: child.pid,
      processGroupId: this.processGroupId,
      processGroupManaged: this.processGroupManaged,
      startedAtOffsetMs: event.monotonicOffsetMs,
    };
  }

  async initialize(options: McpRequestOptions = {}): Promise<McpInitializeRecord> {
    this.requireState('running', 'initialize');
    this.state = 'initializing';
    const clientCapabilities = cloneJsonObject(this.options.clientCapabilities ?? {});
    const handle = this.beginRequest(
      'initialize',
      {
        protocolVersion: this.options.requestedProtocolVersion,
        capabilities: clientCapabilities,
        clientInfo: implementationInfoJson(this.options.clientInfo),
      },
      options.timeoutMs,
      false,
    );

    try {
      const response = await handle.outcome;
      if (response.kind === 'error') {
        throw this.methodFailure(
          'json_rpc_error',
          `initialize returned JSON-RPC error ${response.error.code}`,
          handle.id,
          'initialize',
          { rpc_code: response.error.code, rpc_message: response.error.message },
        );
      }
      const result = requireObjectResult(
        response.result,
        () =>
          this.methodFailure(
            'invalid_initialize_response',
            'initialize result must be an object',
            handle.id,
            'initialize',
            {},
          ),
      );
      const negotiated = result.protocolVersion;
      if (typeof negotiated !== 'string') {
        throw this.methodFailure(
          'invalid_initialize_response',
          'initialize result.protocolVersion must be a string',
          handle.id,
          'initialize',
          {},
        );
      }
      if (!this.options.acceptedProtocolVersions.includes(negotiated)) {
        throw this.methodFailure(
          'unsupported_protocol_version',
          `server negotiated unaccepted protocol version '${negotiated}'`,
          handle.id,
          'initialize',
          {
            requested: this.options.requestedProtocolVersion,
            negotiated,
            accepted: [...this.options.acceptedProtocolVersions],
          },
        );
      }
      if (!isJsonObject(result.capabilities)) {
        throw this.methodFailure(
          'invalid_initialize_response',
          'initialize result.capabilities must be an object',
          handle.id,
          'initialize',
          {},
        );
      }
      if (!isJsonObject(result.serverInfo)) {
        throw this.methodFailure(
          'invalid_initialize_response',
          'initialize result.serverInfo must be an object',
          handle.id,
          'initialize',
          {},
        );
      }
      const serverInfo = result.serverInfo;
      if (typeof serverInfo.name !== 'string' || typeof serverInfo.version !== 'string') {
        throw this.methodFailure(
          'invalid_initialize_response',
          'initialize serverInfo requires string name and version',
          handle.id,
          'initialize',
          {},
        );
      }
      if (serverInfo.title !== undefined && typeof serverInfo.title !== 'string') {
        throw this.methodFailure(
          'invalid_initialize_response',
          'initialize serverInfo.title must be a string when present',
          handle.id,
          'initialize',
          {},
        );
      }

      const initialized = this.writeOutbound(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        'notification',
        'notification',
        null,
        'notifications/initialized',
      );
      const initializedTimeoutMs = options.timeoutMs ?? this.limits.requestTimeoutMs;
      if (!(await awaitWithin(initialized.flushed, initializedTimeoutMs))) {
        throw this.methodFailure(
          'request_timeout',
          `notifications/initialized did not flush within ${initializedTimeoutMs}ms`,
          null,
          'notifications/initialized',
          { timeout_ms: initializedTimeoutMs },
        );
      }
      this.state = 'initialized';

      return {
        requestId: handle.id,
        requestedProtocolVersion: this.options.requestedProtocolVersion,
        negotiatedProtocolVersion: negotiated,
        clientInfo: cloneImplementationInfo(this.options.clientInfo),
        clientCapabilities,
        serverInfo: {
          name: serverInfo.name,
          version: serverInfo.version,
          title: typeof serverInfo.title === 'string' ? serverInfo.title : null,
          raw: cloneJsonObject(serverInfo),
        },
        serverCapabilities: cloneJsonObject(result.capabilities),
        rawResult: cloneJsonObject(result),
        rawResponse: cloneJsonObject(response.rawResponse),
        requestTranscriptSequence: handle.requestTranscriptSequence,
        responseTranscriptSequence: response.responseTranscriptSequence,
        initializedNotificationSequence: initialized.sequence,
      };
    } catch (error) {
      if (this.state === 'initializing') this.state = 'failed';
      void this.close();
      throw error;
    }
  }

  async listTools(options: McpToolListOptions = {}): Promise<McpToolDiscoveryRecord> {
    this.requireInitialized('listTools');
    const maxPages = options.maxPages ?? this.limits.maxToolListPages;
    assertPositiveInteger(maxPages, 'maxPages');
    const overallTimeoutMs = options.timeoutMs ?? this.limits.requestTimeoutMs;
    assertPositiveInteger(overallTimeoutMs, 'tools/list timeout');
    const deadline = Date.now() + overallTimeoutMs;

    const pages: McpToolDiscoveryPage[] = [];
    const tools: McpDiscoveredTool[] = [];
    const seenCursors = new Set<string>();
    const seenNames = new Set<string>();
    let cursor: string | null = null;

    while (true) {
      if (pages.length >= maxPages) {
        throw this.methodFailure(
          'page_limit_exceeded',
          `tools/list exceeded the configured ${maxPages}-page limit`,
          null,
          'tools/list',
          { max_pages: maxPages },
        );
      }

      const params: JsonObject = cursor === null ? {} : { cursor };
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw this.methodFailure(
          'request_timeout',
          `tools/list pagination exceeded its ${overallTimeoutMs}ms overall deadline`,
          null,
          'tools/list',
          { timeout_ms: overallTimeoutMs, completed_pages: pages.length },
        );
      }
      const handle = this.beginRequest('tools/list', params, remainingMs, true);
      const response = await handle.outcome;
      if (response.kind === 'error') {
        throw this.methodFailure(
          'json_rpc_error',
          `tools/list returned JSON-RPC error ${response.error.code}`,
          handle.id,
          'tools/list',
          { rpc_code: response.error.code, rpc_message: response.error.message },
        );
      }
      if (!isJsonObject(response.result)) {
        throw this.methodFailure(
          'invalid_tool_list',
          'tools/list result must be an object',
          handle.id,
          'tools/list',
          {},
        );
      }
      const result = response.result;
      if (!Array.isArray(result.tools)) {
        throw this.methodFailure(
          'invalid_tool_list',
          'tools/list result.tools must be an array',
          handle.id,
          'tools/list',
          {},
        );
      }

      const pageIndex = pages.length;
      for (let indexWithinPage = 0; indexWithinPage < result.tools.length; indexWithinPage += 1) {
        const rawTool = result.tools[indexWithinPage];
        if (!isJsonObject(rawTool) || typeof rawTool.name !== 'string' || !isJsonObject(rawTool.inputSchema)) {
          throw this.methodFailure(
            'invalid_tool_list',
            `tools/list page ${pageIndex} tool ${indexWithinPage} lacks a string name or object inputSchema`,
            handle.id,
            'tools/list',
            { page_index: pageIndex, tool_index: indexWithinPage },
          );
        }
        if (seenNames.has(rawTool.name)) {
          throw this.methodFailure(
            'invalid_tool_list',
            `tools/list returned duplicate tool name '${rawTool.name}'`,
            handle.id,
            'tools/list',
            { tool_name: rawTool.name },
          );
        }
        if (rawTool.title !== undefined && typeof rawTool.title !== 'string') {
          throw this.methodFailure(
            'invalid_tool_list',
            `tool '${rawTool.name}' title must be a string when present`,
            handle.id,
            'tools/list',
            { tool_name: rawTool.name },
          );
        }
        if (rawTool.description !== undefined && typeof rawTool.description !== 'string') {
          throw this.methodFailure(
            'invalid_tool_list',
            `tool '${rawTool.name}' description must be a string when present`,
            handle.id,
            'tools/list',
            { tool_name: rawTool.name },
          );
        }
        if (rawTool.outputSchema !== undefined && !isJsonObject(rawTool.outputSchema)) {
          throw this.methodFailure(
            'invalid_tool_list',
            `tool '${rawTool.name}' outputSchema must be an object when present`,
            handle.id,
            'tools/list',
            { tool_name: rawTool.name },
          );
        }
        if (rawTool.annotations !== undefined && !isJsonObject(rawTool.annotations)) {
          throw this.methodFailure(
            'invalid_tool_list',
            `tool '${rawTool.name}' annotations must be an object when present`,
            handle.id,
            'tools/list',
            { tool_name: rawTool.name },
          );
        }

        const raw = cloneJsonObject(rawTool);
        const canonical = canonicalJson(raw);
        tools.push({
          name: rawTool.name,
          title: typeof rawTool.title === 'string' ? rawTool.title : null,
          description: typeof rawTool.description === 'string' ? rawTool.description : null,
          inputSchema: cloneJsonObject(rawTool.inputSchema),
          outputSchema: isJsonObject(rawTool.outputSchema) ? cloneJsonObject(rawTool.outputSchema) : null,
          annotations: isJsonObject(rawTool.annotations) ? cloneJsonObject(rawTool.annotations) : null,
          raw,
          canonicalJson: canonical,
          canonicalDigest: sha256(canonical),
          discoveryIndex: tools.length,
          pageIndex,
          indexWithinPage,
        });
        seenNames.add(rawTool.name);
      }

      let nextCursor: string | null = null;
      if (Object.hasOwn(result, 'nextCursor')) {
        if (typeof result.nextCursor !== 'string') {
          throw this.methodFailure(
            'invalid_tool_list',
            'tools/list nextCursor must be a string when present',
            handle.id,
            'tools/list',
            {},
          );
        }
        nextCursor = result.nextCursor;
      }

      pages.push({
        pageIndex,
        requestId: handle.id,
        requestCursor: cursor,
        nextCursor,
        rawResult: cloneJsonObject(result),
        rawResponse: cloneJsonObject(response.rawResponse),
        requestTranscriptSequence: handle.requestTranscriptSequence,
        responseTranscriptSequence: response.responseTranscriptSequence,
      });

      if (nextCursor === null) break;
      if (seenCursors.has(nextCursor)) {
        throw this.methodFailure(
          'cursor_cycle',
          `tools/list repeated cursor '${nextCursor}'`,
          handle.id,
          'tools/list',
          { cursor: nextCursor, page_index: pageIndex },
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return { tools, pages, maxPages };
  }

  beginToolCall(
    name: string,
    args: JsonObject,
    options: McpRequestOptions = {},
  ): McpRequestHandle<McpToolCallOutcome> {
    this.requireInitialized('beginToolCall');
    if (name.length === 0) {
      throw this.stateError('invalid_client_configuration', 'tool name must not be empty', 'tools/call');
    }
    const copiedArgs = cloneJsonObject(args);
    const internal = this.beginRequest(
      'tools/call',
      { name, arguments: copiedArgs },
      options.timeoutMs,
      true,
    );

    const outcome = internal.outcome.then((response): McpToolCallOutcome => {
      if (response.kind === 'error') {
        return {
          kind: 'json_rpc_error',
          requestId: internal.id,
          method: 'tools/call',
          toolName: name,
          arguments: copiedArgs,
          error: response.error,
          rawResponse: cloneJsonObject(response.rawResponse),
          requestTranscriptSequence: internal.requestTranscriptSequence,
          responseTranscriptSequence: response.responseTranscriptSequence,
        };
      }
      if (!isJsonObject(response.result)) {
        throw this.methodFailure(
          'invalid_tool_result',
          'tools/call result must be an object',
          internal.id,
          'tools/call',
          { tool_name: name },
        );
      }
      const result = response.result;
      if (!Array.isArray(result.content)) {
        throw this.methodFailure(
          'invalid_tool_result',
          'tools/call result.content must be an array',
          internal.id,
          'tools/call',
          { tool_name: name },
        );
      }
      if (
        result.content.some(
          (block) => !isJsonObject(block) || typeof block.type !== 'string' || block.type.length === 0,
        )
      ) {
        throw this.methodFailure(
          'invalid_tool_result',
          'tools/call result.content entries must be objects with a non-empty string type',
          internal.id,
          'tools/call',
          { tool_name: name },
        );
      }
      if (result.isError !== undefined && typeof result.isError !== 'boolean') {
        throw this.methodFailure(
          'invalid_tool_result',
          'tools/call result.isError must be boolean when present',
          internal.id,
          'tools/call',
          { tool_name: name },
        );
      }
      if (result.structuredContent !== undefined && !isJsonObject(result.structuredContent)) {
        throw this.methodFailure(
          'invalid_tool_result',
          'tools/call result.structuredContent must be an object when present',
          internal.id,
          'tools/call',
          { tool_name: name },
        );
      }
      const isError = result.isError === true;
      return {
        kind: isError ? 'tool_error' : 'tool_success',
        requestId: internal.id,
        toolName: name,
        arguments: copiedArgs,
        isError,
        content: cloneJson(result.content),
        structuredContent: isJsonObject(result.structuredContent)
          ? cloneJsonObject(result.structuredContent)
          : null,
        rawResult: cloneJsonObject(result),
        rawResponse: cloneJsonObject(response.rawResponse),
        requestTranscriptSequence: internal.requestTranscriptSequence,
        responseTranscriptSequence: response.responseTranscriptSequence,
      } as McpToolCallOutcome;
    });

    return {
      id: internal.id,
      outcome,
      cancel: (reason: string) => internal.cancel(reason),
    };
  }

  callTool(name: string, args: JsonObject, options: McpRequestOptions = {}): Promise<McpToolCallOutcome> {
    return this.beginToolCall(name, args, options).outcome;
  }

  transcript(): readonly McpTranscriptEvent[] {
    return this.transcriptEvents.map(cloneTranscriptEvent);
  }

  diagnostics(): McpClientDiagnostics {
    return {
      state: this.state,
      pid: this.pid,
      processGroupId: this.processGroupId,
      processGroupManaged: this.processGroupManaged,
      nextRequestId: this.nextRequestId,
      outstandingRequestIds: [...this.pending.keys()].sort((a, b) => a - b),
      settledRequestIds: [...this.settled].sort((a, b) => a - b),
      cancelledRequestIds: [...this.cancelled.keys()].sort((a, b) => a - b),
      stdoutEof: this.stdoutEof,
      stderrEof: this.stderrEof,
      processExit: this.processExit === null ? null : { ...this.processExit },
      resolvedLimits: { ...this.limits },
      resourceUsage: {
        stderrBytes: this.stderrBytes,
        transcriptBytes: this.transcriptBytes,
        largestFrameBytes: this.largestFrameBytes,
        transcriptEventCount: this.transcriptEvents.length,
      },
      failures: this.failures.map(cloneFailure),
      fatalFailure: this.fatalFailure === null ? null : cloneFailure(this.fatalFailure),
    };
  }

  close(): Promise<McpCloseRecord> {
    if (this.closePromise !== null) return this.closePromise;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private attachChildHandlers(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on('data', (chunk: Buffer | Uint8Array | string) => {
      this.onStdoutData(toBuffer(chunk));
    });
    child.stdout.on('end', () => this.onStdoutEof());
    child.stdout.on('error', (error) => {
      if (this.state === 'closing' || this.state === 'closed') return;
      const failure = this.failure(
        'transport_eof',
        `stdout stream error: ${error.message}`,
        null,
        null,
        {},
      );
      this.addFailure(failure, true);
    });

    child.stderr.on('data', (chunk: Buffer | Uint8Array | string) => {
      this.onStderrData(toBuffer(chunk));
    });
    child.stderr.on('end', () => {
      this.stderrEof = true;
      this.updateExitStreamFlags();
      this.appendEvent({ direction: 'process', kind: 'stderr_eof', requestId: null });
    });
    child.stderr.on('error', (error) => {
      if (this.state === 'closing' || this.state === 'closed') return;
      const failure = this.failure(
        'process_crash',
        `stderr stream error: ${error.message}`,
        null,
        null,
        {},
      );
      this.addFailure(failure, true);
    });

    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if ((this.state === 'closing' || this.state === 'closed') && error.code === 'EPIPE') return;
      const failure = this.failure(
        'stdin_write_error',
        `stdin stream error: ${error.message}`,
        null,
        null,
        { code: error.code ?? null },
      );
      this.addFailure(failure, true);
    });

    child.on('exit', (code, signal) => this.onProcessExit(code, signal));
    child.on('error', (error) => {
      if (this.state === 'starting') return;
      const failure = this.failure(
        'process_crash',
        `child process error: ${error.message}`,
        null,
        null,
        {},
      );
      this.addFailure(failure, true);
    });
  }

  private onStdoutData(chunk: Buffer): void {
    if (
      chunk.length === 0 ||
      this.state === 'closed' ||
      this.frameLimitTriggered ||
      this.transcriptLimitTriggered
    ) {
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline === -1) break;
      let frame = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (frame.length > 0 && frame[frame.length - 1] === 0x0d) frame = frame.subarray(0, frame.length - 1);
      if (
        !this.checkFrameLimit(frame, {
          direction: 'server_to_client',
          requestId: null,
          method: null,
          digest: digestBytes(frame),
        })
      ) {
        return;
      }
      this.processFrame(Buffer.from(frame));
      if (this.fatalFailure !== null) return;
    }

    if (this.stdoutBuffer.length > this.limits.maxFrameBytes) {
      this.frameLimitFailure(this.stdoutBuffer.length, {
        direction: 'server_to_client',
        requestId: null,
        method: null,
        digest: digestBytes(this.stdoutBuffer),
      });
    }
  }

  private processFrame(frame: Buffer): void {
    this.largestFrameBytes = Math.max(this.largestFrameBytes, frame.length);
    const digest = digestBytes(frame);
    let line: string;
    try {
      line = new TextDecoder('utf-8', { fatal: true }).decode(frame);
    } catch (error) {
      const event = this.appendEvent({
        direction: 'server_to_client',
        kind: 'malformed_json',
        rawBytes: Uint8Array.from(frame),
        rawLineDigest: digest,
        rawByteLength: frame.length,
        parsedMessageKind: 'invalid',
        parseOrValidationError: `invalid UTF-8: ${errorMessage(error)}`,
      });
      const failure = this.failure(
        'malformed_json',
        'stdout frame is not valid UTF-8 JSON',
        null,
        null,
        { raw_digest: digest },
        event.sequence,
      );
      this.addFailure(failure, true, false);
      return;
    }

    if (line.length === 0) {
      const event = this.appendEvent({
        direction: 'server_to_client',
        kind: 'stdout_contamination',
        rawBytes: Uint8Array.from(frame),
        rawLine: line,
        rawLineDigest: digest,
        rawByteLength: frame.length,
        parsedMessageKind: 'invalid',
        parseOrValidationError: 'blank stdout frame',
      });
      const failure = this.failure(
        'stdout_contamination',
        'blank line on protocol stdout',
        null,
        null,
        { raw_digest: digest },
        event.sequence,
      );
      this.addFailure(failure, true, false);
      return;
    }

    let parsed: Json;
    try {
      parsed = JSON.parse(line) as Json;
    } catch (error) {
      const contamination = !line.trimStart().startsWith('{');
      const kind: McpTranscriptEventKind = contamination ? 'stdout_contamination' : 'malformed_json';
      const failureKind: McpClientFailureKind = contamination ? 'stdout_contamination' : 'malformed_json';
      const event = this.appendEvent({
        direction: 'server_to_client',
        kind,
        rawBytes: Uint8Array.from(frame),
        rawLine: line,
        rawLineDigest: digest,
        rawByteLength: frame.length,
        parsedMessageKind: 'invalid',
        parseOrValidationError: errorMessage(error),
      });
      const failure = this.failure(
        failureKind,
        contamination ? 'non-protocol content on stdout' : 'malformed JSON on stdout',
        null,
        null,
        { raw_digest: digest },
        event.sequence,
      );
      this.addFailure(failure, true, false);
      return;
    }

    if (!isJsonObject(parsed) || parsed.jsonrpc !== '2.0') {
      const event = this.appendEvent({
        direction: 'server_to_client',
        kind: 'invalid_jsonrpc',
        rawBytes: Uint8Array.from(frame),
        rawLine: line,
        rawLineDigest: digest,
        rawByteLength: frame.length,
        parsedMessageKind: 'invalid',
        parseOrValidationError: 'message must be an object with jsonrpc="2.0"',
      });
      const failure = this.failure(
        'invalid_jsonrpc',
        'structurally invalid JSON-RPC message',
        null,
        null,
        { raw_digest: digest },
        event.sequence,
      );
      this.addFailure(failure, true, false);
      return;
    }

    const message = parsed;
    if (typeof message.method === 'string') {
      if (
        Object.hasOwn(message, 'result') ||
        Object.hasOwn(message, 'error') ||
        (Object.hasOwn(message, 'params') && !isJsonObject(message.params))
      ) {
        this.invalidJsonRpcFrame(
          frame,
          line,
          digest,
          'method messages cannot contain result/error and must use object params when present',
        );
        return;
      }
      const hasId = Object.hasOwn(message, 'id');
      if (hasId) {
        if (!isJsonRpcId(message.id)) {
          this.invalidJsonRpcFrame(frame, line, digest, 'server request has an invalid id');
          return;
        }
        const event = this.appendEvent({
          direction: 'server_to_client',
          kind: 'server_request',
          rawBytes: Uint8Array.from(frame),
          rawLine: line,
          rawLineDigest: digest,
          rawByteLength: frame.length,
          parsedMessageKind: 'request',
          requestId: message.id,
          method: message.method,
        });
        this.handleUnexpectedServerRequest(message.id, message.method, event.sequence);
        return;
      }

      this.appendEvent({
        direction: 'server_to_client',
        kind: 'notification',
        rawBytes: Uint8Array.from(frame),
        rawLine: line,
        rawLineDigest: digest,
        rawByteLength: frame.length,
        parsedMessageKind: 'notification',
        requestId: null,
        method: message.method,
      });
      return;
    }

    const response = this.parseInboundResponse(message);
    if (response instanceof McpClientError) {
      const event = this.appendEvent({
        direction: 'server_to_client',
        kind: 'invalid_jsonrpc',
        rawBytes: Uint8Array.from(frame),
        rawLine: line,
        rawLineDigest: digest,
        rawByteLength: frame.length,
        parsedMessageKind: 'invalid',
        parseOrValidationError: response.failure.message,
      });
      const failure = { ...response.failure, transcriptSequence: event.sequence };
      this.addFailure(failure, true, false);
      return;
    }

    const pending = typeof response.id === 'number' ? this.pending.get(response.id) : undefined;
    const tombstone = typeof response.id === 'number' ? this.cancelled.get(response.id) : undefined;
    const isLate = tombstone !== undefined && !tombstone.lateResponseSeen;
    const eventKind: McpTranscriptEventKind = isLate
      ? 'late_response_after_cancellation'
      : response.kind === 'result'
        ? 'response_result'
        : 'response_error';
    const event = this.appendEvent({
      direction: 'server_to_client',
      kind: eventKind,
      rawBytes: Uint8Array.from(frame),
      rawLine: line,
      rawLineDigest: digest,
      rawByteLength: frame.length,
      parsedMessageKind: response.kind === 'result' ? 'response_result' : 'response_error',
      requestId: response.id,
      method: pending?.method,
      cancellationState: isLate ? 'late_response' : 'none',
    });

    this.handleInboundResponse(response, event.sequence);
  }

  private parseInboundResponse(message: JsonObject): ParsedInboundResponse | McpClientError {
    if (!Object.hasOwn(message, 'id') || !isJsonRpcId(message.id)) {
      return this.errorOnly(
        'malformed_response',
        'JSON-RPC response must contain a valid id',
        null,
        null,
        {},
      );
    }
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError) {
      return this.errorOnly(
        'malformed_response',
        'JSON-RPC response must contain exactly one of result or error',
        message.id,
        null,
        {},
      );
    }
    if (hasError) {
      if (!isJsonObject(message.error)) {
        return this.errorOnly(
          'invalid_response',
          'JSON-RPC error must be an object',
          message.id,
          null,
          {},
        );
      }
      const rawError = message.error;
      if (!Number.isInteger(rawError.code) || typeof rawError.message !== 'string') {
        return this.errorOnly(
          'invalid_response',
          'JSON-RPC error requires an integer code and string message',
          message.id,
          null,
          {},
        );
      }
      const error: McpJsonRpcErrorObject = {
        code: rawError.code as number,
        message: rawError.message,
        raw: cloneJsonObject(rawError),
      };
      if (Object.hasOwn(rawError, 'data')) error.data = cloneJson(rawError.data!);
      return { id: message.id, kind: 'error', error, raw: cloneJsonObject(message) };
    }
    return {
      id: message.id,
      kind: 'result',
      result: cloneJson(message.result!),
      raw: cloneJsonObject(message),
    };
  }

  private handleInboundResponse(response: ParsedInboundResponse, transcriptSequence: number): void {
    if (typeof response.id !== 'number' || !Number.isInteger(response.id) || response.id <= 0) {
      const failure = this.failure(
        'unmatched_response',
        `response id ${JSON.stringify(response.id)} does not match a client request`,
        response.id,
        null,
        {},
        transcriptSequence,
      );
      this.addFailure(failure, true, false);
      return;
    }

    const tombstone = this.cancelled.get(response.id);
    if (tombstone !== undefined) {
      if (!tombstone.lateResponseSeen) {
        tombstone.lateResponseSeen = true;
        const failure = this.failure(
          'late_response_after_cancellation',
          `response arrived after request ${response.id} was ${tombstone.state}`,
          response.id,
          null,
          { cancellation_state: tombstone.state, reason: tombstone.reason },
          transcriptSequence,
        );
        this.addFailure(failure, false, false);
        return;
      }
      const failure = this.failure(
        'duplicate_response',
        `more than one response arrived for cancelled request ${response.id}`,
        response.id,
        null,
        {},
        transcriptSequence,
      );
      this.addFailure(failure, true, false);
      return;
    }

    const pending = this.pending.get(response.id);
    if (pending === undefined) {
      const kind: McpClientFailureKind = this.settled.has(response.id)
        ? 'duplicate_response'
        : 'unmatched_response';
      const failure = this.failure(
        kind,
        kind === 'duplicate_response'
          ? `duplicate response for completed request ${response.id}`
          : `unmatched response id ${response.id}`,
        response.id,
        null,
        {},
        transcriptSequence,
      );
      this.addFailure(failure, true, false);
      return;
    }
    if (pending.responseReceived) {
      const failure = this.failure(
        'duplicate_response',
        `duplicate response for request ${response.id}`,
        response.id,
        pending.method,
        {},
        transcriptSequence,
      );
      this.addFailure(failure, true, false);
      return;
    }

    pending.responseReceived = true;
    clearTimeout(pending.timer);
    pending.candidate =
      response.kind === 'result'
        ? {
            kind: 'result',
            result: response.result!,
            rawResponse: response.raw,
            responseTranscriptSequence: transcriptSequence,
          }
        : {
            kind: 'error',
            error: response.error!,
            rawResponse: response.raw,
            responseTranscriptSequence: transcriptSequence,
          };

    queueMicrotask(() => {
      const current = this.pending.get(response.id as number);
      if (current !== pending || pending.candidate === null) return;
      this.pending.delete(pending.id);
      this.settled.add(pending.id);
      pending.resolve(pending.candidate);
    });
  }

  private handleUnexpectedServerRequest(id: JsonRpcId, method: string, sequence: number): void {
    let reply: OutboundFrameRecord | null = null;
    try {
      reply = this.writeOutbound(
        {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `client does not support server request: ${method}` },
        },
        'response_error',
        'response_error',
        id,
        method,
      );
    } catch {
      // The original unexpected request remains the primary classified failure.
    }
    const failure = this.failure(
      'unexpected_server_request',
      `unsupported server-to-client request '${method}'`,
      id,
      method,
      {},
      sequence,
    );
    this.failures.push(failure);
    this.fatalFailure ??= failure;
    if (this.state !== 'closing' && this.state !== 'closed') this.state = 'failed';
    this.appendEvent({
      direction: 'client',
      kind: 'client_failure',
      requestId: id,
      method,
      parseOrValidationError: failure.message,
      failure,
    });
    this.rejectAllPending(failure);
    void (async () => {
      if (reply !== null) {
        await awaitWithin(reply.flushed, this.limits.postCancellationTimeoutMs);
      }
      await this.close();
    })();
  }

  private invalidJsonRpcFrame(frame: Buffer, line: string, digest: string, message: string): void {
    const event = this.appendEvent({
      direction: 'server_to_client',
      kind: 'invalid_jsonrpc',
      rawBytes: Uint8Array.from(frame),
      rawLine: line,
      rawLineDigest: digest,
      rawByteLength: frame.length,
      parsedMessageKind: 'invalid',
      parseOrValidationError: message,
    });
    const failure = this.failure('invalid_jsonrpc', message, null, null, {}, event.sequence);
    this.addFailure(failure, true, false);
  }

  private onStdoutEof(): void {
    this.stdoutEof = true;
    this.updateExitStreamFlags();
    this.appendEvent({ direction: 'process', kind: 'stdout_eof', requestId: null });
    if (this.stdoutBuffer.length > 0) {
      const remaining = Buffer.from(this.stdoutBuffer);
      this.stdoutBuffer = Buffer.alloc(0);
      if (
        !this.checkFrameLimit(remaining, {
          direction: 'server_to_client',
          requestId: null,
          method: null,
          digest: digestBytes(remaining),
        })
      ) {
        return;
      }
      const digest = digestBytes(remaining);
      const event = this.appendEvent({
        direction: 'server_to_client',
        kind: 'malformed_json',
        rawBytes: Uint8Array.from(remaining),
        rawLineDigest: digest,
        rawByteLength: remaining.length,
        parsedMessageKind: 'invalid',
        parseOrValidationError: 'EOF with an unterminated stdout frame',
      });
      const failure = this.failure(
        'malformed_json',
        'EOF with an unterminated stdout frame',
        null,
        null,
        { raw_digest: digest },
        event.sequence,
      );
      this.addFailure(failure, true, false);
      return;
    }

    if (this.pending.size > 0) {
      void (async () => {
        // stdout can close just before Node delivers the child exit event. Give
        // that event one short bounded window so a nonzero exit remains a
        // process_crash instead of being prematurely collapsed into EOF.
        await this.waitForExitOrDelay(50);
        if (this.pending.size === 0 || this.processExit !== null || this.fatalFailure !== null) return;
        const failure = this.failure(
          'transport_eof',
          'protocol stdout reached EOF with outstanding requests',
          firstPendingId(this.pending),
          firstPendingMethod(this.pending),
          { outstanding_request_ids: [...this.pending.keys()] },
        );
        this.addFailure(failure, true);
      })();
    }
  }

  private onStderrData(chunk: Buffer): void {
    if (chunk.length === 0 || this.state === 'closed') return;
    this.stderrBytes += chunk.length;
    if (this.stderrLimitTriggered || this.transcriptLimitTriggered) return;
    const digest = digestBytes(chunk);
    if (this.stderrBytes > this.limits.maxStderrBytes) {
      this.stderrLimitTriggered = true;
      const event = this.appendEvent({
        direction: 'stderr',
        kind: 'limit_exceeded',
        rawLineDigest: digest,
        rawByteLength: chunk.length,
        parseOrValidationError: `stderr exceeded ${this.limits.maxStderrBytes} bytes`,
        bypassLimit: true,
      });
      const failure = this.failure(
        'stderr_limit_exceeded',
        `stderr exceeded the ${this.limits.maxStderrBytes}-byte cap`,
        null,
        null,
        { observed_bytes: this.stderrBytes, cap_bytes: this.limits.maxStderrBytes, chunk_digest: digest },
        event.sequence,
      );
      this.addFailure(failure, true, false);
      return;
    }
    this.appendEvent({
      direction: 'stderr',
      kind: 'stderr',
      rawBytes: Uint8Array.from(chunk),
      rawLineDigest: digest,
      rawByteLength: chunk.length,
    });
  }

  private onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const expected = this.state === 'closing' || this.state === 'closed';
    const event = this.appendEvent({
      direction: 'process',
      kind: 'process_exit',
      requestId: null,
      exitCode: code,
      signal,
    });
    this.processExit = {
      code,
      signal,
      expected,
      observedAtOffsetMs: event.monotonicOffsetMs,
      stdoutEof: this.stdoutEof,
      stderrEof: this.stderrEof,
    };
    for (const waiter of this.exitWaiters.splice(0)) waiter();

    if (this.pending.size > 0) {
      const crashed = signal !== null || (code !== null && code !== 0);
      const failure = this.failure(
        crashed ? 'process_crash' : 'transport_eof',
        crashed
          ? `child process exited while requests were outstanding (code=${String(code)}, signal=${String(signal)})`
          : 'child process exited cleanly while requests were outstanding',
        firstPendingId(this.pending),
        firstPendingMethod(this.pending),
        { exit_code: code, signal },
        event.sequence,
      );
      this.addFailure(failure, true, false);
      return;
    }

    if (!expected) {
      const crashed = signal !== null || (code !== null && code !== 0);
      const failure = this.failure(
        crashed ? 'process_crash' : 'transport_eof',
        crashed
          ? `child process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`
          : 'child process exited cleanly before client shutdown',
        null,
        null,
        { exit_code: code, signal },
        event.sequence,
      );
      this.addFailure(failure, true, false);
    }
  }

  private beginRequest(
    method: string,
    params: JsonObject,
    timeoutOverride: number | undefined,
    cancelAllowed: boolean,
  ): InternalRequestHandle {
    if (this.state !== 'running' && this.state !== 'initializing' && this.state !== 'initialized') {
      throw this.stateError('invalid_client_state', `cannot request '${method}' while client is ${this.state}`, method);
    }
    if (this.fatalFailure !== null) throw new McpClientError(this.fatalFailure);
    const timeoutMs = timeoutOverride ?? this.limits.requestTimeoutMs;
    assertPositiveInteger(timeoutMs, 'request timeout');
    const id = this.nextRequestId++;
    const outbound = this.writeOutbound(
      { jsonrpc: '2.0', id, method, params: cloneJsonObject(params) },
      'request',
      'request',
      id,
      method,
    );

    let resolveOutcome!: (outcome: InternalRpcOutcome) => void;
    let rejectOutcome!: (error: McpClientError) => void;
    const outcome = new Promise<InternalRpcOutcome>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    const timer = setTimeout(() => void this.timeoutRequest(id), timeoutMs);
    const pending: PendingRequest = {
      id,
      method,
      requestTranscriptSequence: outbound.sequence,
      cancelAllowed,
      timer,
      responseReceived: false,
      candidate: null,
      resolve: resolveOutcome,
      reject: rejectOutcome,
    };
    this.pending.set(id, pending);
    void outbound.flushed.catch((error) => {
      const current = this.pending.get(id);
      if (current !== pending) return;
      const failure = this.failure(
        'stdin_write_error',
        `failed to write request ${id}: ${errorMessage(error)}`,
        id,
        method,
        {},
        outbound.sequence,
      );
      this.addFailure(failure, true, false);
    });

    return {
      id,
      method,
      requestTranscriptSequence: outbound.sequence,
      outcome,
      cancel: (reason: string) => this.cancelRequest(id, reason, false),
    };
  }

  private async timeoutRequest(id: McpClientRequestId): Promise<void> {
    const pending = this.pending.get(id);
    if (pending === undefined || pending.responseReceived) return;
    const event = this.appendEvent({
      direction: 'client',
      kind: 'request_timeout',
      requestId: id,
      method: pending.method,
      cancellationState: 'timed_out',
    });
    const failure = this.failure(
      'request_timeout',
      `request ${id} (${pending.method}) timed out`,
      id,
      pending.method,
      {},
      event.sequence,
    );
    this.failures.push(failure);
    this.fatalFailure ??= failure;
    if (this.state !== 'closing' && this.state !== 'closed') this.state = 'failed';
    const cancellation = await this.cancelSettledPending(
      pending,
      'request deadline exceeded',
      true,
      false,
    );
    await delay(this.limits.postCancellationTimeoutMs);
    const closing = this.close();
    pending.reject(new McpClientError(cancellation.failure));
    await closing;
  }

  private async cancelRequest(
    id: McpClientRequestId,
    reason: string,
    timedOut: boolean,
  ): Promise<McpCancellationRecord> {
    const pending = this.pending.get(id);
    if (pending === undefined || pending.responseReceived) {
      return {
        requestId: id,
        reason,
        notificationSent: false,
        alreadySettled: true,
        transcriptSequence: Math.max(0, this.nextTranscriptSequence - 1),
      };
    }
    const { record } = await this.cancelSettledPending(pending, reason, timedOut, true);
    await delay(this.limits.postCancellationTimeoutMs);
    return record;
  }

  private async cancelSettledPending(
    pending: PendingRequest,
    reason: string,
    timedOut: boolean,
    rejectOutcome: boolean,
  ): Promise<{ record: McpCancellationRecord; failure: McpClientFailure }> {
    clearTimeout(pending.timer);
    this.pending.delete(pending.id);
    const state: 'cancelled' | 'timed_out' = timedOut ? 'timed_out' : 'cancelled';
    this.cancelled.set(pending.id, { state, reason, lateResponseSeen: false });

    let sequence = Math.max(0, this.nextTranscriptSequence - 1);
    let notificationSent = false;
    if (pending.cancelAllowed && this.child?.stdin.writable === true && !this.child.stdin.destroyed) {
      try {
        const outbound = this.writeOutbound(
          {
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: pending.id, reason },
          },
          'cancellation_sent',
          'notification',
          pending.id,
          'notifications/cancelled',
          timedOut ? 'timed_out' : 'requested',
          timedOut,
        );
        sequence = outbound.sequence;
        notificationSent = await awaitWithin(
          outbound.flushed,
          this.limits.postCancellationTimeoutMs,
        );
      } catch {
        notificationSent = false;
      }
    }

    const kind: McpClientFailureKind = timedOut ? 'request_timeout' : 'cancelled';
    const failure = this.failure(
      kind,
      timedOut ? `request ${pending.id} timed out` : `request ${pending.id} was cancelled: ${reason}`,
      pending.id,
      pending.method,
      { reason, notification_sent: notificationSent },
      sequence,
    );
    if (!timedOut) this.addFailure(failure, false, false);
    if (rejectOutcome) pending.reject(new McpClientError(failure));
    return {
      failure,
      record: {
        requestId: pending.id,
        reason,
        notificationSent,
        alreadySettled: false,
        transcriptSequence: sequence,
      },
    };
  }

  private writeOutbound(
    message: JsonObject,
    eventKind: McpTranscriptEventKind,
    parsedMessageKind: 'request' | 'notification' | 'response_error',
    requestId: JsonRpcId,
    method: string,
    cancellationState: McpCancellationState = 'none',
    allowDuringTimeout = false,
  ): OutboundFrameRecord {
    const child = this.child;
    if (child === null || child.stdin.destroyed || !child.stdin.writable) {
      throw this.stateError('stdin_write_error', 'child stdin is not writable', method, requestId);
    }
    const line = JSON.stringify(message);
    const bytes = Buffer.from(line, 'utf8');
    if (
      !this.checkFrameLimit(bytes, {
        direction: 'client_to_server',
        requestId,
        method,
        digest: digestBytes(bytes),
      })
    ) {
      throw new McpClientError(this.fatalFailure!);
    }
    const event = this.appendEvent({
      direction: 'client_to_server',
      kind: eventKind,
      rawBytes: Uint8Array.from(bytes),
      rawLine: line,
      rawLineDigest: digestBytes(bytes),
      rawByteLength: bytes.length,
      parsedMessageKind,
      requestId,
      method,
      cancellationState,
    });
    if (
      this.fatalFailure !== null &&
      !(allowDuringTimeout && this.fatalFailure.kind === 'request_timeout')
    ) {
      throw new McpClientError(this.fatalFailure);
    }

    const flushed = new Promise<void>((resolve, reject) => {
      try {
        child.stdin.write(Buffer.concat([bytes, Buffer.from('\n')]), (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
    return { sequence: event.sequence, flushed };
  }

  private async performClose(): Promise<McpCloseRecord> {
    if (this.state === 'closed') return this.buildCloseRecord('none');
    if (this.state === 'created') {
      this.state = 'closed';
      return this.buildCloseRecord('none');
    }

    this.state = 'closing';
    this.settlePendingForClose();
    const child = this.child;
    let escalation: McpShutdownEscalation = 'none';

    if (child !== null && !child.stdin.destroyed && child.stdin.writable) {
      this.appendEvent({ direction: 'client', kind: 'stdin_closed', requestId: null });
      try {
        child.stdin.end();
      } catch {
        // Escalation below remains authoritative.
      }
    }

    let dead = await this.waitForManagedDeath(this.limits.gracefulShutdownTimeoutMs);
    if (!dead) {
      escalation = 'sigterm';
      this.sendSignal('SIGTERM');
      dead = await this.waitForManagedDeath(this.limits.sigtermTimeoutMs);
    }
    if (!dead) {
      escalation = 'sigkill';
      this.sendSignal('SIGKILL');
      dead = await this.waitForManagedDeath(this.limits.sigkillTimeoutMs);
    }

    const liveness = this.probeLiveness();
    if (!dead || liveness.childAlive || liveness.managedProcessGroupAlive === true) {
      const failure = this.failure(
        liveness.managedProcessGroupAlive === true ? 'orphaned_process_group' : 'shutdown_timeout',
        'managed child process did not terminate within shutdown deadlines',
        null,
        null,
        {
          child_alive: liveness.childAlive,
          process_group_alive: liveness.managedProcessGroupAlive,
          escalation,
        },
      );
      this.addFailure(failure, true);
    }

    this.state = 'closed';
    return this.buildCloseRecord(escalation, liveness);
  }

  private settlePendingForClose(): void {
    for (const pending of [...this.pending.values()]) {
      clearTimeout(pending.timer);
      this.pending.delete(pending.id);
      this.cancelled.set(pending.id, {
        state: 'cancelled',
        reason: 'client shutdown',
        lateResponseSeen: false,
      });
      const failure = this.failure(
        'cancelled',
        `request ${pending.id} cancelled during client shutdown`,
        pending.id,
        pending.method,
        { reason: 'client shutdown' },
      );
      this.addFailure(failure, false);
      pending.reject(new McpClientError(failure));
    }
  }

  private sendSignal(signal: NodeJS.Signals): void {
    const target = this.processGroupManaged && this.processGroupId !== null ? -this.processGroupId : this.pid;
    this.appendEvent({
      direction: 'process',
      kind: 'signal_sent',
      requestId: null,
      signal,
    });
    if (target === null) return;
    try {
      process.kill(target, signal);
    } catch (error) {
      if (!isNoSuchProcess(error)) {
        const failure = this.failure(
          'shutdown_timeout',
          `failed to send ${signal}: ${errorMessage(error)}`,
          null,
          null,
          { signal },
        );
        this.addFailure(failure, false);
      }
    }
  }

  private async waitForManagedDeath(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const proof = this.probeLiveness();
      if (!proof.childAlive && proof.managedProcessGroupAlive !== true) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await this.waitForExitOrDelay(Math.min(10, remaining));
    }
  }

  private waitForExitOrDelay(timeoutMs: number): Promise<void> {
    if (this.processExit !== null) return delay(timeoutMs);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.exitWaiters.indexOf(onExit);
        if (index >= 0) this.exitWaiters.splice(index, 1);
        resolve();
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.exitWaiters.push(onExit);
    });
  }

  private probeLiveness(): McpProcessLivenessProof {
    let childAlive = false;
    if (this.pid !== null) childAlive = probePid(this.pid);
    if (this.processGroupManaged && this.processGroupId !== null) {
      return {
        method: 'posix_process_group',
        childAlive,
        managedProcessGroupAlive: probePid(-this.processGroupId),
        checkedAtOffsetMs: this.offsetMs(),
      };
    }
    return {
      method: this.pid === null ? 'unsupported' : 'child_process_only',
      childAlive,
      managedProcessGroupAlive: null,
      checkedAtOffsetMs: this.offsetMs(),
    };
  }

  private buildCloseRecord(
    escalation: McpShutdownEscalation,
    liveness: McpProcessLivenessProof = this.probeLiveness(),
  ): McpCloseRecord {
    return {
      graceful:
        escalation === 'none' &&
        !liveness.childAlive &&
        liveness.managedProcessGroupAlive !== true &&
        (this.processExit === null ||
          (this.processExit.code === 0 && this.processExit.signal === null)),
      escalation,
      processExit: this.processExit === null ? null : { ...this.processExit },
      liveness,
      allRequestsSettled: this.pending.size === 0,
      diagnostics: this.diagnostics(),
    };
  }

  private checkFrameLimit(frame: Buffer, context: FrameLimitContext): boolean {
    this.largestFrameBytes = Math.max(this.largestFrameBytes, frame.length);
    if (frame.length <= this.limits.maxFrameBytes) return true;
    this.frameLimitFailure(frame.length, context);
    return false;
  }

  private frameLimitFailure(observedBytes: number, context: FrameLimitContext): void {
    if (this.frameLimitTriggered) return;
    this.frameLimitTriggered = true;
    this.stdoutBuffer = Buffer.alloc(0);
    this.child?.stdout.pause();
    const event = this.appendEvent({
      direction: context.direction,
      kind: 'limit_exceeded',
      requestId: context.requestId,
      method: context.method ?? undefined,
      rawLineDigest: context.digest,
      rawByteLength: observedBytes,
      parseOrValidationError: `frame exceeded ${this.limits.maxFrameBytes} bytes`,
      bypassLimit: true,
    });
    const failure = this.failure(
      'frame_limit_exceeded',
      `protocol frame exceeded the ${this.limits.maxFrameBytes}-byte cap`,
      context.requestId,
      context.method,
      {
        observed_bytes: observedBytes,
        cap_bytes: this.limits.maxFrameBytes,
        raw_digest: context.digest,
        direction: context.direction,
      },
      event.sequence,
    );
    this.addFailure(failure, true, false);
  }

  private appendEvent(input: AppendEventInput): McpTranscriptEvent {
    const { bypassLimit = false, ...fields } = input;
    if (this.transcriptLimitTriggered && this.transcriptLimitEvent !== null) {
      return this.transcriptLimitEvent;
    }
    const event: McpTranscriptEvent = {
      sequence: this.nextTranscriptSequence++,
      monotonicOffsetMs: this.offsetMs(),
      ...fields,
    };
    const estimate = transcriptEventSize(event);
    if (
      !bypassLimit &&
      !this.transcriptLimitTriggered &&
      this.transcriptBytes + estimate > this.limits.maxTranscriptBytes
    ) {
      this.transcriptLimitTriggered = true;
      const failure = this.failure(
        'transcript_limit_exceeded',
        `transcript exceeded the ${this.limits.maxTranscriptBytes}-byte cap`,
        event.requestId ?? null,
        event.method ?? null,
        {
          retained_bytes: this.transcriptBytes,
          rejected_event_bytes: estimate,
          cap_bytes: this.limits.maxTranscriptBytes,
          raw_digest: event.rawLineDigest ?? null,
        },
        event.sequence,
      );
      this.failures.push(failure);
      this.fatalFailure ??= failure;
      const terminal: McpTranscriptEvent = {
        sequence: event.sequence,
        monotonicOffsetMs: event.monotonicOffsetMs,
        direction: 'client',
        kind: 'limit_exceeded',
        requestId: event.requestId,
        method: event.method,
        parseOrValidationError: failure.message,
        failure,
      };
      this.transcriptEvents.push(terminal);
      this.transcriptLimitEvent = terminal;
      this.transcriptBytes += transcriptEventSize(terminal);
      this.rejectAllPending(failure);
      if (this.state !== 'closing' && this.state !== 'closed') this.state = 'failed';
      queueMicrotask(() => void this.close());
      return terminal;
    }

    this.transcriptEvents.push(event);
    this.transcriptBytes += estimate;
    return event;
  }

  private failure(
    kind: McpClientFailureKind,
    message: string,
    requestId: JsonRpcId,
    method: string | null,
    details: JsonObject,
    transcriptSequence: number | null = null,
  ): McpClientFailure {
    return { kind, message, requestId, method, details, transcriptSequence } as McpClientFailure;
  }

  private addFailure(failure: McpClientFailure, fatal: boolean, append = true): void {
    this.failures.push(failure);
    if (append) {
      this.appendEvent({
        direction: 'client',
        kind: 'client_failure',
        requestId: failure.requestId,
        method: failure.method ?? undefined,
        parseOrValidationError: failure.message,
        failure,
        bypassLimit: failure.kind === 'transcript_limit_exceeded',
      });
    }
    if (!fatal) return;
    this.fatalFailure ??= failure;
    this.rejectAllPending(failure);
    if (this.state !== 'closing' && this.state !== 'closed') this.state = 'failed';
    queueMicrotask(() => void this.close());
  }

  private rejectAllPending(failure: McpClientFailure): void {
    for (const pending of [...this.pending.values()]) {
      clearTimeout(pending.timer);
      this.pending.delete(pending.id);
      pending.reject(new McpClientError(failure));
    }
  }

  private methodFailure(
    kind: McpClientFailureKind,
    message: string,
    requestId: JsonRpcId,
    method: string,
    details: JsonObject,
  ): McpClientError {
    const failure = this.failure(kind, message, requestId, method, details);
    this.addFailure(failure, true);
    return new McpClientError(failure);
  }

  private stateError(
    kind: McpClientFailureKind,
    message: string,
    method: string,
    requestId: JsonRpcId = null,
  ): McpClientError {
    const failure = this.failure(kind, message, requestId, method, {});
    this.addFailure(failure, false);
    return new McpClientError(failure);
  }

  private errorOnly(
    kind: McpClientFailureKind,
    message: string,
    requestId: JsonRpcId,
    method: string | null,
    details: JsonObject,
  ): McpClientError {
    return new McpClientError(this.failure(kind, message, requestId, method, details));
  }

  private requireState(expected: McpClientState, operation: string): void {
    if (this.state === expected) return;
    throw this.stateError(
      'invalid_client_state',
      `${operation} requires client state '${expected}', current state is '${this.state}'`,
      operation,
    );
  }

  private requireInitialized(operation: string): void {
    if (this.state === 'initialized' && this.fatalFailure === null) return;
    const kind: McpClientFailureKind =
      this.state === 'running' || this.state === 'initializing'
        ? 'operation_before_initialization'
        : 'invalid_client_state';
    throw this.stateError(kind, `${operation} requires successful initialization`, operation);
  }

  private updateExitStreamFlags(): void {
    if (this.processExit === null) return;
    this.processExit = {
      ...this.processExit,
      stdoutEof: this.stdoutEof,
      stderrEof: this.stderrEof,
    };
  }

  private offsetMs(): number {
    return Number(process.hrtime.bigint() - this.startedAt) / 1_000_000;
  }
}

function copyAndValidateOptions(options: McpStdioClientOptions): McpStdioClientOptions {
  if (typeof options.executable !== 'string' || options.executable.length === 0) {
    throw configurationError('executable must be a non-empty string');
  }
  if (!Array.isArray(options.args) || options.args.some((arg) => typeof arg !== 'string')) {
    throw configurationError('args must be an array of strings');
  }
  if (typeof options.cwd !== 'string' || options.cwd.length === 0) {
    throw configurationError('cwd must be a non-empty string');
  }
  if (!isStringRecord(options.env)) throw configurationError('env must contain only string values');
  if (
    !isJsonObject(options.clientInfo as unknown as Json) ||
    typeof options.clientInfo.name !== 'string' ||
    options.clientInfo.name.length === 0 ||
    typeof options.clientInfo.version !== 'string' ||
    options.clientInfo.version.length === 0 ||
    (options.clientInfo.title !== undefined && typeof options.clientInfo.title !== 'string')
  ) {
    throw configurationError('clientInfo requires non-empty name/version and optional string title');
  }
  if (typeof options.requestedProtocolVersion !== 'string' || options.requestedProtocolVersion.length === 0) {
    throw configurationError('requestedProtocolVersion must be a non-empty string');
  }
  if (
    !Array.isArray(options.acceptedProtocolVersions) ||
    options.acceptedProtocolVersions.length === 0 ||
    options.acceptedProtocolVersions.some((version) => typeof version !== 'string' || version.length === 0)
  ) {
    throw configurationError('acceptedProtocolVersions must contain at least one non-empty string');
  }
  if (options.clientCapabilities !== undefined && !isJsonObject(options.clientCapabilities)) {
    throw configurationError('clientCapabilities must be a JSON object');
  }
  if (
    options.clientCapabilities !== undefined &&
    Object.keys(options.clientCapabilities).length > 0
  ) {
    throw configurationError(
      'this milestone implements no client capabilities; clientCapabilities must be empty',
    );
  }
  resolveLimits(options.limits);

  return {
    executable: options.executable,
    args: [...options.args],
    cwd: options.cwd,
    env: { ...options.env },
    clientInfo: cloneImplementationInfo(options.clientInfo),
    requestedProtocolVersion: options.requestedProtocolVersion,
    acceptedProtocolVersions: [...options.acceptedProtocolVersions],
    clientCapabilities: cloneJsonObject(options.clientCapabilities ?? {}),
    limits: options.limits === undefined ? undefined : { ...options.limits },
    manageProcessGroup: options.manageProcessGroup,
  };
}

function resolveLimits(overrides: Partial<McpClientLimits> | undefined): McpClientLimits {
  const limits = { ...DEFAULT_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(limits)) assertPositiveInteger(value, name);
  return limits;
}

function configurationError(message: string): McpClientError {
  const failure: McpClientFailure = {
    kind: 'invalid_client_configuration',
    message,
    requestId: null,
    method: null,
    transcriptSequence: null,
    details: {},
  };
  return new McpClientError(failure);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw configurationError(`${name} must be a positive integer`);
}

function cloneImplementationInfo(info: McpStdioClientOptions['clientInfo']): McpStdioClientOptions['clientInfo'] {
  return info.title === undefined
    ? { name: info.name, version: info.version }
    : { name: info.name, version: info.version, title: info.title };
}

function implementationInfoJson(info: McpStdioClientOptions['clientInfo']): JsonObject {
  const value: JsonObject = { name: info.name, version: info.version };
  if (info.title !== undefined) value.title = info.title;
  return value;
}

function cloneJson<T extends Json>(value: T): T {
  return structuredClone(value);
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return cloneJson(value);
}

function isJsonObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonRpcId(value: Json | undefined): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function requireObjectResult(value: Json, error: () => McpClientError): JsonObject {
  if (!isJsonObject(value)) throw error();
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toBuffer(chunk: Buffer | Uint8Array | string): Buffer {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return Buffer.from(chunk);
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function transcriptEventSize(event: McpTranscriptEvent): number {
  const rawLength = event.rawBytes?.byteLength ?? 0;
  const summary = {
    ...event,
    rawBytes: undefined,
    failure: event.failure === undefined ? undefined : { ...event.failure },
  };
  return rawLength + Buffer.byteLength(JSON.stringify(summary), 'utf8');
}

function cloneFailure(failure: McpClientFailure): McpClientFailure {
  return { ...failure, details: cloneJsonObject(failure.details) } as McpClientFailure;
}

function cloneTranscriptEvent(event: McpTranscriptEvent): McpTranscriptEvent {
  return {
    ...event,
    rawBytes: event.rawBytes === undefined ? undefined : Uint8Array.from(event.rawBytes),
    failure: event.failure === undefined ? undefined : cloneFailure(event.failure),
  };
}

function probePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH';
}

function firstPendingId(pending: ReadonlyMap<McpClientRequestId, PendingRequest>): McpClientRequestId | null {
  return pending.keys().next().value ?? null;
}

function firstPendingMethod(pending: ReadonlyMap<McpClientRequestId, PendingRequest>): string | null {
  return pending.values().next().value?.method ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => false,
    ),
    delay(timeoutMs).then(() => false),
  ]);
}
