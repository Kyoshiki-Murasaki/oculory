# 33 — Generic asynchronous MCP stdio client architecture

_Architecture decision for the Phase 6 client-foundation milestone. This record authorizes only a target-independent, test-only-validated stdio client foundation. It does not authorize an external target, an external trace schema, persisted external sessions, or model traffic._

## Decision

Add a narrow custom asynchronous JSON-RPC/MCP client under `src/mcp/client/`, with newline-delimited stdio as its first transport. Keep `src/mcp/mcp.ts` and the three frozen synchronous recorders unchanged. The new client has no Git-specific behavior and does not write production transcript artifacts.

The implementation is deliberately a reviewed subset, not a general MCP client or conformance implementation. Its supported MCP surface is initialization, the initialized notification, paginated tool discovery, generic tool calls, request cancellation for tool operations, observable protocol faults, and bounded child-process shutdown.

## Required client surface

The public boundary for this milestone is:

- construct with an explicit executable, argument array, working directory, exact child-environment allowlist, client identity, requested protocol version, accepted-version allowlist, implemented client capabilities, deadlines, resource caps, page cap, and process-group policy;
- `start()` to spawn the executable directly without a shell and return process identity/group evidence;
- `initialize()` to send and validate `initialize`, retain requested and negotiated versions, server identity, capabilities, raw result/response, and then send `notifications/initialized`;
- `listTools()` to follow `nextCursor` with cycle and page-limit checks while retaining raw tools, schemas, annotations, titles, unknown fields, discovery order, page provenance, and canonical semantic representations;
- `beginToolCall()` to return a monotonically numbered request handle with an outcome promise and explicit cancellation method;
- `callTool()` as the awaiting convenience form of the same generic `tools/call` operation;
- `transcript()` and `diagnostics()` for ordered in-memory evidence and current failure/process/resource state;
- idempotent `close()` for stdin-close, SIGTERM, and SIGKILL escalation plus liveness proof.

Arbitrary MCP methods and arbitrary client notifications are intentionally not public. This avoids implying support for protocol areas that this client does not implement.

## Why this path is additive

The existing `McpEndpoint` is synchronous and its only implementation wraps Oculory's locally authored `DemoServer`. The task recorder depends directly on that boundary; the filesystem and issue-tracker recorders call their own local server objects. Converting those paths to asynchronous external-process ownership would alter frozen Phase 1–5 behavior without being necessary to answer the current architectural question.

The external-client path therefore lives beside the existing path. It does not change `ToolSpec`, schema version 2, recorder behavior, verifier semantics, scenario catalogues, or persisted evidence. A later reviewed change may extract shared abstractions only after a real consumer proves which ones are needed.

The frozen demo server is used only for one narrow backward-compatibility smoke. It is not modified for this client, is not an MCP conformance oracle, and cannot prove full protocol correctness or external compatibility. Lifecycle and fault semantics are tested primarily with a deterministic test-only stdio protocol fixture.

## Official SDK versus custom subset

This milestone uses a narrow custom implementation rather than the official TypeScript MCP SDK.

The decision is based on the active repository and its evidence requirements:

- the package currently has zero runtime dependencies and the SDK is not installed;
- Oculory must retain exact raw frames and their digests, malformed and structurally invalid frames, request IDs, unmatched and duplicate responses, stdout contamination, stderr bytes, exit/signal order, timeouts, cancellation, and late responses;
- the checked-in repository does not prove that an SDK-level client exposes all of those facts before parsing or correlation;
- wrapping the SDK with a second observable framing/process layer would retain most of the custom complexity while adding a runtime dependency.

This is not a claim that the official SDK cannot provide useful hooks. It is a narrow decision about what this milestone can prove. No runtime dependency is added.

The consequence is maintenance responsibility: supported protocol versions must be explicitly reviewed; the client must reject unsupported negotiation; new MCP behavior is not inherited automatically; and the implementation must continue to describe itself as a limited JSON-RPC/MCP stdio subset. Reconsider the SDK when its exact evidence hooks can be demonstrated without erasing Oculory's required observations.

## Protocol and evidence model

### Framing and raw observability

Stdout is buffered as bytes and split only on LF, with CRLF accepted as a line terminator. Frame-size limits are enforced before decoding. UTF-8 decoding is strict. Every frame retains bounded raw bytes, byte length, and SHA-256 digest before JSON parsing. Partial chunks are reassembled, and multiple frames in one chunk are processed in order.

Malformed JSON, invalid UTF-8, blank/non-protocol stdout, invalid JSON-RPC structure, unterminated EOF data, and exceeded caps are transcript events and typed failures. They are never skipped or converted into stderr or tool results. Stderr has a separate byte stream, transcript direction, and cap; it never enters the protocol parser.

### IDs, correlation, and inbound order

Client request IDs are positive monotonically increasing integers. A response must match an outstanding ID exactly. Unknown IDs, IDs that already completed, and IDs retained as cancelled tombstones are classified separately as unmatched, duplicate, and late-after-cancellation evidence.

All stdout frames are processed through one ordered handler. Notifications may interleave with responses and remain visible. An unexpected server request is recorded, receives a JSON-RPC method-not-found reply when the pipe is writable, and fails the session clearly instead of deadlocking.

### Initialization and discovery

Normal tool operations are prohibited before a valid initialization. Protocol versions are compared only against an explicit accepted-version allowlist, never lexicographically. The initialize record retains the requested and negotiated versions, client and server identity, capabilities, raw initialize result, and raw response.

Tool discovery validates only the required shape and preserves the complete raw discovery object. It does not flatten external schemas into schema-v2 `ToolSpec`. Missing `nextCursor` ends pagination; a present cursor must be a string. Repeated cursors fail as cycles, and a configurable maximum page count fails closed.

### Results and failures

Returned tool outcomes distinguish successful MCP tool results, MCP results with `isError: true`, and valid JSON-RPC errors. Typed failures separately distinguish malformed or invalid responses, unmatched and duplicate responses, EOF, process crash, timeout, cancellation, late response after cancellation, unexpected server requests, write/spawn failures, and resource-cap failures. No class is collapsed into a generic failure string.

Timeouts use per-request deadlines. A tool-operation timeout sends `notifications/cancelled`, records the notification, retains the request ID as a tombstone, waits only for the configured bounded post-cancellation window, retains any late response, and then shuts the client down before settling the timeout outcome. Explicit caller cancellation uses the same bounded notification/late-response evidence path without automatically ending an otherwise healthy session. Initialization cancellation is deliberately unsupported: an initialize timeout is classified and followed by shutdown. Process exit or terminal transport failure settles every outstanding promise.

### Transcript ordering and caps

One append path assigns every outbound frame, inbound frame, stderr chunk, timeout/cancellation event, signal, EOF, exit, and client failure a sequence number and monotonic offset. Events retain message kind, request ID, method, parse/validation error, cancellation state, exit code, and signal where applicable.

Configurable limits cover frame bytes, stderr bytes, transcript bytes, page count, startup, requests, post-cancellation wait, and every shutdown phase. Caps fail closed. A small terminal limit event may be recorded even when the ordinary transcript budget is exhausted so truncation is observable. Transcripts remain in memory for this milestone; tests use only temporary process state and clean it during teardown.

## Process lifecycle

The client calls the configured executable and argument array directly with `shell: false`, the configured working directory, and the exact supplied environment object. It never spreads `process.env` into the child.

On POSIX, managed mode creates a child process group. Shutdown stops new requests, closes stdin, waits for the graceful deadline, signals the managed group with SIGTERM, waits again, and uses SIGKILL if necessary. Exit code, signal, stdout/stderr EOF, escalation, and liveness checks are retained. A negative process-group liveness probe proves that no child or descendant remains in the managed group. It cannot prove the absence of a malicious descendant that deliberately creates a different session; that boundary is documented rather than overstated. Platforms without equivalent group support record child-only or unavailable descendant proof.

Startup, shutdown, and liveness checks are bounded. A process exit rejects all outstanding requests, and test teardown always closes the client and asserts that no managed process remains.

## Deliberately unsupported behavior

This milestone does not implement:

- Streamable HTTP, legacy HTTP/SSE, or any non-stdio transport;
- Roots, sampling, elicitation, tasks, resources, prompts, subscriptions, or broad server-to-client capabilities;
- progress/logging semantics beyond retaining unsolicited notifications;
- initialization cancellation;
- concurrent target scenarios, reconnection, session resumption, or process reuse across trials;
- external target installation, Git fixtures, Git-specific normalization, scenarios, or verification;
- external trace schema version 3 or persistence into schema version 2;
- production transcript files, credential handling, live-model calls, or provider integration;
- complete MCP conformance or compatibility with arbitrary implementations.

## Future transport boundary

The consumer boundary exposes lifecycle, initialization, discovery, generic tool calls, cancellation handles, outcomes, transcript evidence, diagnostics, and close records without exposing child-process pipes. A future transport may implement the same boundary with transport-specific startup and shutdown.

A Streamable HTTP implementation would still need to preserve raw messages, IDs, ordered unsolicited events, HTTP-versus-JSON-RPC failures, session headers, cancellation, deadlines, and resource caps. It would add HTTP/SSE parsing, connection and redirect policy, TLS/proxy/authentication rules, and session resumption without changing target verification code. No such implementation is part of this milestone.

## Evidentiary limits

Passing the deterministic fixture tests proves only that this implementation handles its explicitly tested stdio JSON-RPC/MCP subset and failure modes under controlled local conditions. The demo-server smoke proves only narrow backward compatibility with Oculory's frozen local server.

This milestone does not prove compatibility with an external MCP server, validate `mcp-server-git`, establish full MCP conformance, pass any Phase 6 scientific gate, add a fourth validation target, or authorize model testing.
