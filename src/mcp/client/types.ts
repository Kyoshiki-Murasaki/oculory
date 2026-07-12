/**
 * Lossless public types for Oculory's narrow asynchronous MCP stdio client.
 *
 * This boundary is additive to the frozen synchronous `McpEndpoint`. It models
 * only initialize, tools/list, tools/call, cancellation, transcript evidence,
 * and bounded process shutdown. It is not a complete MCP client or a persisted
 * external-trace schema.
 */
import type { Json, JsonObject } from '../../schema/types.js';

/** Oculory emits positive integer IDs, but inbound server requests may use any JSON-RPC ID. */
export type JsonRpcId = number | string | null;
export type McpClientRequestId = number;

export interface McpImplementationInfo {
  name: string;
  version: string;
  title?: string;
}

export interface McpClientLimits {
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  postCancellationTimeoutMs: number;
  gracefulShutdownTimeoutMs: number;
  sigtermTimeoutMs: number;
  sigkillTimeoutMs: number;
  maxToolListPages: number;
  maxFrameBytes: number;
  maxStderrBytes: number;
  maxTranscriptBytes: number;
}

export interface McpStdioClientOptions {
  /** Executed directly with `shell: false`. */
  executable: string;
  args: readonly string[];
  cwd: string;
  /** Exact child environment allowlist. Implementations must not merge process.env. */
  env: Readonly<Record<string, string>>;
  clientInfo: McpImplementationInfo;
  requestedProtocolVersion: string;
  /** Negotiated versions accepted by this caller; never interpreted lexicographically. */
  acceptedProtocolVersions: readonly string[];
  /** Capabilities actually implemented by the client. Defaults to an empty object. */
  clientCapabilities?: JsonObject;
  /** Overrides implementation defaults; diagnostics expose the fully resolved limits. */
  limits?: Partial<McpClientLimits>;
  /** Defaults to true where managed process groups are supported. */
  manageProcessGroup?: boolean;
}

export interface McpRequestOptions {
  timeoutMs?: number;
}

export interface McpToolListOptions extends McpRequestOptions {
  maxPages?: number;
}

export type McpClientState =
  | 'created'
  | 'starting'
  | 'running'
  | 'initializing'
  | 'initialized'
  | 'closing'
  | 'closed'
  | 'failed';

/* ------------------------ Failure classification ----------------------- */

export type McpClientFailureKind =
  | 'invalid_client_configuration'
  | 'invalid_client_state'
  | 'operation_before_initialization'
  | 'spawn_error'
  | 'stdin_write_error'
  | 'malformed_json'
  | 'stdout_contamination'
  | 'invalid_jsonrpc'
  | 'malformed_response'
  | 'invalid_response'
  | 'unmatched_response'
  | 'duplicate_response'
  | 'late_response_after_cancellation'
  | 'unexpected_server_request'
  | 'invalid_initialize_response'
  | 'unsupported_protocol_version'
  | 'invalid_tool_list'
  | 'cursor_cycle'
  | 'page_limit_exceeded'
  | 'invalid_tool_result'
  | 'json_rpc_error'
  | 'transport_eof'
  | 'process_crash'
  | 'request_timeout'
  | 'cancelled'
  | 'frame_limit_exceeded'
  | 'stderr_limit_exceeded'
  | 'transcript_limit_exceeded'
  | 'shutdown_timeout'
  | 'orphaned_process_group';

interface McpClientFailureBase<K extends McpClientFailureKind> {
  kind: K;
  message: string;
  requestId: JsonRpcId;
  method: string | null;
  transcriptSequence: number | null;
  /** Small structured context only; raw wire evidence remains in the transcript. */
  details: JsonObject;
}

/** A discriminated record for every client, protocol, transport, or process failure. */
export type McpClientFailure = {
  [K in McpClientFailureKind]: McpClientFailureBase<K>;
}[McpClientFailureKind];

/** Promise rejection wrapper used for failures outside valid MCP/JSON-RPC outcomes. */
export class McpClientError extends Error {
  public readonly failure: McpClientFailure;

  constructor(failure: McpClientFailure) {
    super(`${failure.kind}: ${failure.message}`);
    this.name = 'McpClientError';
    this.failure = deepFreeze(structuredClone(failure));
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/* --------------------------- Lifecycle records ------------------------- */

export interface McpProcessStartRecord {
  pid: number;
  processGroupId: number | null;
  processGroupManaged: boolean;
  startedAtOffsetMs: number;
}

export interface McpServerInfoRecord {
  name: string;
  version: string;
  title: string | null;
  /** Full parsed serverInfo object, including unknown extension fields. */
  raw: JsonObject;
}

export interface McpInitializeRecord {
  requestId: McpClientRequestId;
  requestedProtocolVersion: string;
  negotiatedProtocolVersion: string;
  clientInfo: McpImplementationInfo;
  clientCapabilities: JsonObject;
  serverInfo: McpServerInfoRecord;
  /** Full parsed capabilities object, including unknown capability fields. */
  serverCapabilities: JsonObject;
  /** Full initialize result and JSON-RPC response as received. */
  rawResult: JsonObject;
  rawResponse: JsonObject;
  requestTranscriptSequence: number;
  responseTranscriptSequence: number;
  initializedNotificationSequence: number;
}

/* ---------------------------- Tool discovery --------------------------- */

export interface McpDiscoveredTool {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: JsonObject;
  outputSchema: JsonObject | null;
  annotations: JsonObject | null;
  /** Full parsed discovery object, including every unknown extension field. */
  raw: JsonObject;
  /** Stable semantic representation; exact wire bytes remain in the transcript. */
  canonicalJson: string;
  canonicalDigest: string;
  discoveryIndex: number;
  pageIndex: number;
  indexWithinPage: number;
}

export interface McpToolDiscoveryPage {
  pageIndex: number;
  requestId: McpClientRequestId;
  requestCursor: string | null;
  nextCursor: string | null;
  rawResult: JsonObject;
  rawResponse: JsonObject;
  requestTranscriptSequence: number;
  responseTranscriptSequence: number;
}

export interface McpToolDiscoveryRecord {
  tools: readonly McpDiscoveredTool[];
  pages: readonly McpToolDiscoveryPage[];
  maxPages: number;
}

/* -------------------------- Tool call outcomes ------------------------- */

interface McpToolResultBase<K extends 'tool_success' | 'tool_error'> {
  kind: K;
  requestId: McpClientRequestId;
  toolName: string;
  arguments: JsonObject;
  isError: K extends 'tool_error' ? true : false;
  content: readonly Json[];
  structuredContent: JsonObject | null;
  /** Full parsed tools/call result and JSON-RPC response, with unknown fields retained. */
  rawResult: JsonObject;
  rawResponse: JsonObject;
  requestTranscriptSequence: number;
  responseTranscriptSequence: number;
}

export type McpToolSuccess = McpToolResultBase<'tool_success'>;
export type McpToolError = McpToolResultBase<'tool_error'>;

export interface McpJsonRpcErrorObject {
  code: number;
  message: string;
  data?: Json;
  /** Full parsed error object, including unknown extension fields. */
  raw: JsonObject;
}

/** A valid JSON-RPC error is an observed protocol outcome, not a transport exception. */
export interface McpJsonRpcErrorOutcome {
  kind: 'json_rpc_error';
  requestId: McpClientRequestId;
  method: string;
  toolName: string | null;
  arguments: JsonObject | null;
  error: McpJsonRpcErrorObject;
  rawResponse: JsonObject;
  requestTranscriptSequence: number;
  responseTranscriptSequence: number;
}

export type McpToolCallOutcome = McpToolSuccess | McpToolError | McpJsonRpcErrorOutcome;

export interface McpCancellationRecord {
  requestId: McpClientRequestId;
  reason: string;
  notificationSent: boolean;
  alreadySettled: boolean;
  transcriptSequence: number;
}

export interface McpRequestHandle<T> {
  readonly id: McpClientRequestId;
  readonly outcome: Promise<T>;
  cancel(reason: string): Promise<McpCancellationRecord>;
}

/* ----------------------- Transcript and diagnostics -------------------- */

export type McpTranscriptDirection =
  | 'client_to_server'
  | 'server_to_client'
  | 'stderr'
  | 'process'
  | 'client';

export type McpParsedMessageKind =
  | 'request'
  | 'notification'
  | 'response_result'
  | 'response_error'
  | 'invalid';

export type McpTranscriptEventKind =
  | 'spawn'
  | 'request'
  | 'notification'
  | 'response_result'
  | 'response_error'
  | 'server_request'
  | 'malformed_json'
  | 'invalid_jsonrpc'
  | 'stdout_contamination'
  | 'stderr'
  | 'request_timeout'
  | 'cancellation_sent'
  | 'late_response_after_cancellation'
  | 'stdin_closed'
  | 'stdout_eof'
  | 'stderr_eof'
  | 'signal_sent'
  | 'process_exit'
  | 'limit_exceeded'
  | 'client_failure';

export type McpCancellationState =
  | 'none'
  | 'requested'
  | 'timed_out'
  | 'cancelled'
  | 'late_response';

export interface McpTranscriptEvent {
  sequence: number;
  direction: McpTranscriptDirection;
  monotonicOffsetMs: number;
  kind: McpTranscriptEventKind;
  /** Exact bounded bytes for a frame or stderr chunk; callers must treat them as immutable. */
  rawBytes?: Uint8Array;
  /** Decoded frame without its line terminator, present only when strict UTF-8 decoding succeeded. */
  rawLine?: string;
  /** SHA-256 over the exact raw frame/chunk bytes represented by this event. */
  rawLineDigest?: string;
  rawByteLength?: number;
  parsedMessageKind?: McpParsedMessageKind;
  requestId?: JsonRpcId;
  method?: string;
  parseOrValidationError?: string;
  cancellationState?: McpCancellationState;
  exitCode?: number | null;
  signal?: string | null;
  failure?: McpClientFailure;
}

export interface McpProcessExitRecord {
  code: number | null;
  signal: string | null;
  expected: boolean;
  observedAtOffsetMs: number;
  stdoutEof: boolean;
  stderrEof: boolean;
}

export interface McpProcessLivenessProof {
  method: 'posix_process_group' | 'child_process_only' | 'unsupported';
  childAlive: boolean;
  managedProcessGroupAlive: boolean | null;
  checkedAtOffsetMs: number;
}

export interface McpResourceUsage {
  stderrBytes: number;
  transcriptBytes: number;
  largestFrameBytes: number;
  transcriptEventCount: number;
}

export interface McpClientDiagnostics {
  state: McpClientState;
  pid: number | null;
  processGroupId: number | null;
  processGroupManaged: boolean;
  nextRequestId: McpClientRequestId;
  outstandingRequestIds: readonly McpClientRequestId[];
  settledRequestIds: readonly McpClientRequestId[];
  cancelledRequestIds: readonly McpClientRequestId[];
  stdoutEof: boolean;
  stderrEof: boolean;
  processExit: McpProcessExitRecord | null;
  resolvedLimits: McpClientLimits;
  resourceUsage: McpResourceUsage;
  /** All observed findings; duplicate and late responses remain visible after promise settlement. */
  failures: readonly McpClientFailure[];
  fatalFailure: McpClientFailure | null;
}

export type McpShutdownEscalation = 'none' | 'sigterm' | 'sigkill';

export interface McpCloseRecord {
  graceful: boolean;
  escalation: McpShutdownEscalation;
  processExit: McpProcessExitRecord | null;
  liveness: McpProcessLivenessProof;
  allRequestsSettled: boolean;
  diagnostics: McpClientDiagnostics;
}

/** Transport-independent consumer surface implemented initially only by stdio. */
export interface AsyncMcpClient {
  start(): Promise<McpProcessStartRecord>;
  initialize(options?: McpRequestOptions): Promise<McpInitializeRecord>;
  listTools(options?: McpToolListOptions): Promise<McpToolDiscoveryRecord>;
  beginToolCall(
    name: string,
    args: JsonObject,
    options?: McpRequestOptions,
  ): McpRequestHandle<McpToolCallOutcome>;
  callTool(name: string, args: JsonObject, options?: McpRequestOptions): Promise<McpToolCallOutcome>;
  transcript(): readonly McpTranscriptEvent[];
  diagnostics(): McpClientDiagnostics;
  close(): Promise<McpCloseRecord>;
}
