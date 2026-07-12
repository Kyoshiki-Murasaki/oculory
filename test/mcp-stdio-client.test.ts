import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { McpStdioClient } from '../src/mcp/client/stdio-client.js';
import {
  McpClientError,
  type McpClientFailureKind,
  type McpClientLimits,
  type McpCloseRecord,
  type McpProcessStartRecord,
  type McpStdioClientOptions,
  type McpTranscriptEvent,
} from '../src/mcp/client/types.js';

const ROOT = process.cwd();
const FIXTURE_ENTRY = resolve(ROOT, 'dist/test/support/mcp-protocol-fixture.js');
const DEMO_ENTRY = resolve(ROOT, 'dist/src/server/main.js');
const DEMO_FIXTURE = resolve(ROOT, 'fixtures/seed.json');

const TEST_LIMITS: McpClientLimits = {
  startupTimeoutMs: 1_000,
  requestTimeoutMs: 500,
  postCancellationTimeoutMs: 30,
  gracefulShutdownTimeoutMs: 300,
  sigtermTimeoutMs: 100,
  sigkillTimeoutMs: 500,
  maxToolListPages: 16,
  maxFrameBytes: 256 * 1024,
  maxStderrBytes: 64 * 1024,
  maxTranscriptBytes: 512 * 1024,
};

interface FixtureOptions {
  acceptedProtocolVersions?: readonly string[];
  limits?: Partial<McpClientLimits>;
  fixtureArgs?: readonly string[];
}

function fixtureClient(mode: string, options: FixtureOptions = {}): McpStdioClient {
  return new McpStdioClient({
    executable: process.execPath,
    args: [FIXTURE_ENTRY, '--mode', mode, ...(options.fixtureArgs ?? [])],
    cwd: ROOT,
    env: {},
    clientInfo: { name: 'oculory-client-test', version: '1.0.0', title: 'Oculory client test' },
    requestedProtocolVersion: '2025-11-25',
    acceptedProtocolVersions: options.acceptedProtocolVersions ?? ['2025-11-25'],
    clientCapabilities: {},
    limits: { ...TEST_LIMITS, ...(options.limits ?? {}) },
  });
}

async function withFixture<T>(
  mode: string,
  body: (client: McpStdioClient, start: McpProcessStartRecord) => Promise<T>,
  options: FixtureOptions = {},
): Promise<T> {
  const client = fixtureClient(mode, options);
  return withStartedClient(client, body);
}

async function withStartedClient<T>(
  client: McpStdioClient,
  body: (client: McpStdioClient, start: McpProcessStartRecord) => Promise<T>,
): Promise<T> {
  let start: McpProcessStartRecord | null = null;
  let value!: T;
  let operationFailed = false;
  let operationError: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;
  let emergencyFailed = false;
  let emergencyError: unknown;
  try {
    start = await client.start();
    value = await body(client, start);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    const close = await withCleanupDeadline(client.close(), 2_500);
    assertNoManagedProcess(close, start);
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  } finally {
    if (start !== null && cleanupFailed) {
      try {
        emergencyKill(start);
        await waitForProcessAbsence(start);
      } catch (error) {
        emergencyFailed = true;
        emergencyError = error;
      }
    }
  }

  const errors: unknown[] = [];
  if (operationFailed) errors.push(operationError);
  if (cleanupFailed) errors.push(cleanupError);
  if (emergencyFailed) errors.push(emergencyError);
  if (errors.length > 1) throw new AggregateError(errors, 'client operation or teardown failed');
  if (errors.length === 1) throw errors[0];
  return value;
}

async function withCleanupDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`client.close() exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function assertNoManagedProcess(close: McpCloseRecord, start: McpProcessStartRecord | null): void {
  assert.equal(close.allRequestsSettled, true, 'every request promise must be settled at teardown');
  assert.equal(close.liveness.childAlive, false, 'child process remained alive after teardown');
  assert.notEqual(
    close.liveness.managedProcessGroupAlive,
    true,
    'a process remained in the managed child process group',
  );
  if (start !== null) {
    assert.equal(processExists(start.pid), false, `child PID ${start.pid} remained alive`);
    if (start.processGroupManaged && start.processGroupId !== null) {
      assert.equal(
        processExists(-start.processGroupId),
        false,
        `managed process group ${start.processGroupId} remained alive`,
      );
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

function emergencyKill(start: McpProcessStartRecord): void {
  const target = start.processGroupManaged && start.processGroupId !== null
    ? -start.processGroupId
    : start.pid;
  try {
    process.kill(target, 'SIGKILL');
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ESRCH'
      )
    ) {
      throw error;
    }
  }
}

async function waitForProcessAbsence(start: McpProcessStartRecord): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const childAlive = processExists(start.pid);
    const groupAlive =
      start.processGroupManaged && start.processGroupId !== null
        ? processExists(-start.processGroupId)
        : false;
    if (!childAlive && !groupAlive) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(`emergency teardown could not remove child/process group for PID ${start.pid}`);
}

async function captureMcpError(promise: Promise<unknown>): Promise<McpClientError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof McpClientError, `expected McpClientError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected operation to reject with McpClientError');
}

function isMcpErrorKind(error: unknown, kind: McpClientFailureKind): boolean {
  return error instanceof McpClientError && error.failure.kind === kind;
}

async function waitForTranscriptEvent(
  client: McpStdioClient,
  predicate: (event: McpTranscriptEvent) => boolean,
  description: string,
): Promise<McpTranscriptEvent> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const event = client.transcript().find(predicate);
    if (event !== undefined) return event;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(`timed out waiting for transcript event: ${description}`);
}

async function waitForFailure(client: McpStdioClient, kind: McpClientFailureKind): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (client.diagnostics().failures.some((failure) => failure.kind === kind)) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(`timed out waiting for failure: ${kind}`);
}

test('stdio client: initialize → initialized → tools/list → tools/call → graceful shutdown', async () => {
  await withFixture('tool-call-success', async (client) => {
    const initialized = await client.initialize();
    const discovery = await client.listTools();
    const outcome = await client.callTool('echo', { message: 'hello' });
    const close = await client.close();

    assert.equal(initialized.negotiatedProtocolVersion, '2025-11-25');
    assert.deepEqual(discovery.tools.map((tool) => tool.name), ['echo', 'add_numbers']);
    assert.equal(outcome.kind, 'tool_success');
    assert.equal(close.graceful, true);
    assert.equal(close.escalation, 'none');

    const transcript = client.transcript();
    assert.deepEqual(
      transcript
        .filter((event) => event.direction === 'client_to_server' && event.kind === 'request')
        .map((event) => event.requestId),
      [1, 2, 3],
      'request IDs must be monotonically allocated and observable',
    );
    assert.deepEqual(
      transcript.map((event) => event.sequence),
      transcript.map((_, index) => index + 1),
      'all transcript events must share one ordered sequence',
    );
  });
});

test('stdio client: normal tool operations are prohibited before initialization', async () => {
  await withFixture('valid-initialize', async (client) => {
    assert.throws(
      () => client.beginToolCall('echo', { message: 'too early' }),
      (error: unknown) => isMcpErrorKind(error, 'operation_before_initialization'),
    );
    await assert.rejects(
      client.listTools(),
      (error: unknown) => isMcpErrorKind(error, 'operation_before_initialization'),
    );
    await client.initialize();
  });
});

test('stdio client: requested and negotiated protocol versions are retained distinctly', async () => {
  await withFixture(
    'protocol-version-negotiation',
    async (client) => {
      const initialized = await client.initialize();
      assert.equal(initialized.requestedProtocolVersion, '2025-11-25');
      assert.equal(initialized.negotiatedProtocolVersion, '2025-06-18');
      assert.equal(initialized.rawResult.protocolVersion, '2025-06-18');
    },
    { acceptedProtocolVersions: ['2025-11-25', '2025-06-18'] },
  );
});

test('stdio client: server identity, capabilities, and unknown initialize fields are retained', async () => {
  await withFixture('valid-initialize', async (client) => {
    const initialized = await client.initialize();
    assert.equal(initialized.serverInfo.name, 'oculory-test-protocol-fixture');
    assert.equal(initialized.serverInfo.version, '1.0.0');
    assert.equal(initialized.serverInfo.raw['x-server-extension'], 'retained');
    assert.deepEqual(initialized.serverCapabilities.tools, { listChanged: true });
    assert.deepEqual(initialized.rawResult['x-initialize-extension'], { retained: true });
  });
});

test('stdio client: one-page tool discovery retains page provenance', async () => {
  await withFixture('tools-list-one-page', async (client) => {
    await client.initialize();
    const discovery = await client.listTools();
    assert.equal(discovery.pages.length, 1);
    assert.equal(discovery.pages[0]!.requestCursor, null);
    assert.equal(discovery.pages[0]!.nextCursor, null);
    assert.deepEqual(discovery.tools.map((tool) => [tool.discoveryIndex, tool.pageIndex]), [
      [0, 0],
      [1, 0],
    ]);
  });
});

test('stdio client: multi-page discovery is complete and ordered', async () => {
  await withFixture('tools-list-multi-page', async (client) => {
    await client.initialize();
    const discovery = await client.listTools();
    assert.deepEqual(discovery.tools.map((tool) => tool.name), ['echo', 'add_numbers', 'inspect_metadata']);
    assert.deepEqual(discovery.pages.map((page) => page.requestCursor), [null, 'page-2', 'page-3']);
    assert.deepEqual(discovery.pages.map((page) => page.nextCursor), ['page-2', 'page-3', null]);
  });
});

test('stdio client: cycling pagination cursor fails clearly', async () => {
  await withFixture('cycling-cursor', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.listTools());
    assert.equal(error.failure.kind, 'cursor_cycle');
    assert.equal(error.failure.details.cursor, 'cycle-a');
  });
});

test('stdio client: immediately duplicated pagination cursor fails clearly', async () => {
  await withFixture('duplicate-cursor', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.listTools());
    assert.equal(error.failure.kind, 'cursor_cycle');
    assert.equal(error.failure.details.cursor, 'duplicate');
  });
});

test('stdio client: configured tool-list page limit is enforced', async () => {
  await withFixture('tools-list-multi-page', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.listTools({ maxPages: 2 }));
    assert.equal(error.failure.kind, 'page_limit_exceeded');
    assert.equal(error.failure.details.max_pages, 2);
  });
});

test('stdio client: raw schemas, annotations, title, unknown fields, and canonical form are preserved', async () => {
  await withFixture('tools-list-one-page', async (client) => {
    await client.initialize();
    const discovery = await client.listTools();
    const echo = discovery.tools[0]!;
    assert.equal(echo.title, 'Fixture echo');
    assert.deepEqual(echo.inputSchema.properties, {
      message: { type: 'string', description: 'Message to return' },
      metadata: {
        type: 'object',
        properties: { labels: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    });
    assert.equal(echo.outputSchema?.type, 'object');
    assert.equal(echo.annotations?.['x-annotation-extension'], 'preserve-me');
    assert.deepEqual(echo.raw['x-fixture-extension'], {
      nested: { value: 7 },
      values: ['alpha', 'beta'],
    });
    assert.deepEqual(JSON.parse(echo.canonicalJson), echo.raw);
    assert.match(echo.canonicalDigest, /^[a-f0-9]{64}$/);
  });
});

test('stdio client: successful MCP tool result remains a typed success', async () => {
  await withFixture('tool-call-success', async (client) => {
    await client.initialize();
    const outcome = await client.callTool('echo', { message: 'success' });
    assert.equal(outcome.kind, 'tool_success');
    if (outcome.kind !== 'tool_success') assert.fail('expected tool_success');
    assert.equal(outcome.isError, false);
    assert.deepEqual(outcome.structuredContent, {
      ok: true,
      tool: 'echo',
      arguments: { message: 'success' },
    });
    assert.deepEqual(outcome.rawResult['x-result-extension'], { retained: true });
  });
});

test('stdio client: MCP isError result remains distinct from successful and JSON-RPC outcomes', async () => {
  await withFixture('tool-call-is-error', async (client) => {
    await client.initialize();
    const outcome = await client.callTool('echo', { message: 'rejected' });
    assert.equal(outcome.kind, 'tool_error');
    if (outcome.kind !== 'tool_error') assert.fail('expected tool_error');
    assert.equal(outcome.isError, true);
    assert.deepEqual(outcome.structuredContent, { code: 'FIXTURE_TOOL_ERROR', rejected: true });
  });
});

test('stdio client: JSON-RPC error remains a valid outcome distinct from MCP tool error', async () => {
  await withFixture('json-rpc-error', async (client) => {
    await client.initialize();
    const outcome = await client.callTool('echo', { message: 'rpc failure' });
    assert.equal(outcome.kind, 'json_rpc_error');
    if (outcome.kind !== 'json_rpc_error') assert.fail('expected json_rpc_error');
    assert.equal(outcome.error.code, -32042);
    assert.equal(outcome.error.message, 'fixture JSON-RPC error');
    assert.deepEqual(outcome.error.data, { category: 'fixture', retryable: false });
  });
});

test('stdio client: malformed JSON is retained and classified', async () => {
  await withFixture('malformed-json', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.callTool('echo', { message: 'malformed' }));
    assert.equal(error.failure.kind, 'malformed_json');
    const event = client.transcript().find((entry) => entry.kind === 'malformed_json');
    assert.ok(event?.rawLineDigest);
    assert.match(event.rawLineDigest, /^[a-f0-9]{64}$/);
  });
});

test('stdio client: structurally invalid JSON-RPC is retained and classified', async () => {
  await withFixture('invalid-json-rpc', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.callTool('echo', { message: 'invalid' }));
    assert.equal(error.failure.kind, 'invalid_jsonrpc');
    assert.ok(client.transcript().some((entry) => entry.kind === 'invalid_jsonrpc'));
  });
});

test('stdio client: malformed matched response is distinct from malformed JSON', async () => {
  await withFixture('malformed-response', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.callTool('echo', { message: 'bad response shape' }));
    assert.equal(error.failure.kind, 'malformed_response');
    assert.equal(client.diagnostics().failures.some((failure) => failure.kind === 'malformed_json'), false);
  });
});

test('stdio client: invalid JSON-RPC error object is an invalid_response', async () => {
  await withFixture('invalid-response', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.callTool('echo', { message: 'bad rpc error' }));
    assert.equal(error.failure.kind, 'invalid_response');
  });
});

test('stdio client: structurally invalid MCP tool result is an invalid_tool_result', async () => {
  await withFixture('invalid-tool-result', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.callTool('echo', { message: 'bad tool result' }));
    assert.equal(error.failure.kind, 'invalid_tool_result');
  });
});

test('stdio client: stdout contamination is never interpreted as stderr or a tool result', async () => {
  await withFixture('stdout-contamination', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.callTool('echo', { message: 'contamination' }));
    assert.equal(error.failure.kind, 'stdout_contamination');
    const event = client.transcript().find((entry) => entry.kind === 'stdout_contamination');
    assert.equal(event?.direction, 'server_to_client');
    assert.equal(client.transcript().some((entry) => entry.direction === 'stderr'), false);
  });
});

test('stdio client: bounded stderr stays separate from protocol parsing', async () => {
  await withFixture('bounded-stderr', async (client) => {
    await client.initialize();
    const outcome = await client.callTool('echo', { message: 'stderr-safe' });
    assert.equal(outcome.kind, 'tool_success');
    const stderr = client.transcript().filter((entry) => entry.kind === 'stderr');
    assert.equal(stderr.length >= 1, true);
    assert.equal(stderr.every((entry) => entry.direction === 'stderr'), true);
    assert.equal(
      client.transcript().some((entry) => entry.kind === 'malformed_json' || entry.kind === 'stdout_contamination'),
      false,
    );
  });
});

test('stdio client: mismatched response ID fails the outstanding request', async () => {
  await withFixture('mismatched-response-id', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.callTool('echo', { message: 'mismatch' }));
    assert.equal(error.failure.kind, 'unmatched_response');
    assert.equal(client.diagnostics().outstandingRequestIds.length, 0);
  });
});

test('stdio client: duplicate response ID is detected before a coalesced duplicate can be accepted', async () => {
  await withFixture('duplicate-response-id', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.callTool('echo', { message: 'duplicate' }));
    assert.equal(error.failure.kind, 'duplicate_response');
    assert.ok(client.diagnostics().failures.some((failure) => failure.kind === 'duplicate_response'));
  });
});

test('stdio client: notification interleaving is retained before the matching response', async () => {
  await withFixture('notification-interleaved', async (client) => {
    await client.initialize();
    const outcome = await client.callTool('echo', { message: 'notify' });
    assert.equal(outcome.kind, 'tool_success');
    const transcript = client.transcript();
    const notification = transcript.find(
      (event) => event.kind === 'notification' && event.method === 'notifications/progress',
    );
    const response = transcript.find(
      (event) => event.kind === 'response_result' && event.requestId === outcome.requestId,
    );
    assert.ok(notification);
    assert.ok(response);
    assert.ok(notification.sequence < response.sequence);
  });
});

test('stdio client: unsupported server request receives an error and cannot deadlock the client', async () => {
  await withFixture('unsupported-server-request', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.callTool('echo', { message: 'server request' }));
    assert.equal(error.failure.kind, 'unexpected_server_request');
    const transcript = client.transcript();
    const request = transcript.find((event) => event.kind === 'server_request');
    const rejection = transcript.find(
      (event) =>
        event.direction === 'client_to_server' &&
        event.kind === 'response_error' &&
        event.requestId === 'fixture-server-request-1',
    );
    assert.ok(request);
    assert.ok(rejection);
    assert.ok(request.sequence < rejection.sequence);
  });
});

test('stdio client: request timeout is explicit, sends cancellation, and settles the promise', async () => {
  await withFixture('request-timeout', async (client) => {
    await client.initialize();
    const handle = client.beginToolCall('echo', { message: 'timeout' }, { timeoutMs: 40 });
    const error = await captureMcpError(handle.outcome);
    assert.equal(error.failure.kind, 'request_timeout');
    await waitForTranscriptEvent(
      client,
      (event) => event.kind === 'cancellation_sent' && event.requestId === handle.id,
      'timeout cancellation notification',
    );
    await waitForTranscriptEvent(
      client,
      (event) => event.method === 'notifications/fixture/cancellation-observed',
      'fixture cancellation acknowledgement',
    );
    const close = await client.close();
    assert.equal(close.allRequestsSettled, true);
    assert.ok(close.processExit, 'timeout teardown must observe process exit after settling the request');
    assert.equal(client.diagnostics().outstandingRequestIds.length, 0);
  });
});

test('stdio client: explicit cancellation is classified and recorded', async () => {
  await withFixture('request-timeout', async (client) => {
    await client.initialize();
    const handle = client.beginToolCall('echo', { message: 'cancel' }, { timeoutMs: 500 });
    const outcomeError = captureMcpError(handle.outcome);
    await waitForTranscriptEvent(
      client,
      (event) => event.method === 'notifications/fixture/waiting-for-cancellation',
      'fixture waiting for cancellation',
    );
    const cancellation = await handle.cancel('explicit test cancellation');
    const error = await outcomeError;
    assert.equal(error.failure.kind, 'cancelled');
    assert.equal(cancellation.notificationSent, true);
    assert.equal(cancellation.alreadySettled, false);
    assert.ok(client.diagnostics().cancelledRequestIds.includes(handle.id));
  });
});

test('stdio client: deterministic late response after cancellation remains visible evidence', async () => {
  await withFixture('late-response-after-cancellation', async (client) => {
    await client.initialize();
    const handle = client.beginToolCall('echo', { message: 'late' }, { timeoutMs: 500 });
    const outcomeError = captureMcpError(handle.outcome);
    await waitForTranscriptEvent(
      client,
      (event) => event.method === 'notifications/fixture/waiting-for-cancellation',
      'fixture waiting before late response',
    );
    await handle.cancel('retain late response');
    const error = await outcomeError;
    assert.equal(error.failure.kind, 'cancelled');
    const late = await waitForTranscriptEvent(
      client,
      (event) => event.kind === 'late_response_after_cancellation' && event.requestId === handle.id,
      'late response after cancellation',
    );
    assert.equal(late.cancellationState, 'late_response');
    assert.ok(client.diagnostics().failures.some((failure) => failure.kind === 'late_response_after_cancellation'));
  });
});

test('stdio client: valid out-of-order responses remain correlated by request ID', async () => {
  await withFixture('out-of-order-valid-ids', async (client) => {
    await client.initialize();
    await client.listTools();
    const first = client.beginToolCall('echo', { message: 'first' });
    const second = client.beginToolCall('echo', { message: 'second' });
    const [firstOutcome, secondOutcome] = await Promise.all([first.outcome, second.outcome]);
    assert.equal(firstOutcome.kind, 'tool_success');
    assert.equal(secondOutcome.kind, 'tool_success');
    const responses = client.transcript().filter((event) =>
      event.direction === 'server_to_client' && event.kind === 'response_result' &&
      (event.requestId === first.id || event.requestId === second.id));
    assert.deepEqual(responses.map((event) => event.requestId), [second.id, first.id]);
  });
});

test('stdio client: ignored cancellation remains a bounded timeout with clean teardown', async () => {
  await withFixture('cancellation-ignored', async (client) => {
    await client.initialize();
    await client.listTools();
    const handle = client.beginToolCall('echo', { message: 'ignore cancellation' }, { timeoutMs: 40 });
    const error = await captureMcpError(handle.outcome);
    assert.equal(error.failure.kind, 'request_timeout');
    assert.equal(client.transcript().some((event) => event.kind === 'cancellation_sent' && event.requestId === handle.id), true);
    assert.equal(client.transcript().some((event) => event.method === 'notifications/fixture/cancellation-observed'), false);
  });
});

test('stdio client: EOF with an outstanding request is a transport_eof, not success or rejection', async () => {
  await withFixture('eof-outstanding', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.callTool('echo', { message: 'eof' }));
    assert.equal(error.failure.kind, 'transport_eof');
    assert.equal(client.diagnostics().stdoutEof, true);
    assert.equal(client.diagnostics().outstandingRequestIds.length, 0);
  });
});

test('stdio client: nonzero process exit is classified distinctly as process_crash', async () => {
  await withFixture('nonzero-exit', async (client) => {
    await client.initialize();
    const error = await captureMcpError(client.callTool('echo', { message: 'crash' }));
    assert.equal(error.failure.kind, 'process_crash');
    await waitForTranscriptEvent(client, (event) => event.kind === 'process_exit', 'nonzero process exit');
    assert.equal(client.diagnostics().processExit?.code, 23);
    assert.equal(client.diagnostics().outstandingRequestIds.length, 0);
  });
});

test('stdio client: delayed response remains within an explicit per-request deadline', async () => {
  await withFixture('delayed-response', async (client) => {
    await client.initialize();
    const outcome = await client.callTool('echo', { message: 'delayed' }, { timeoutMs: 300 });
    assert.equal(outcome.kind, 'tool_success');
    assert.equal(client.diagnostics().failures.some((failure) => failure.kind === 'request_timeout'), false);
  });
});

test('stdio client: stdin-close graceful shutdown succeeds for a cooperative fixture', async () => {
  await withFixture('valid-initialize', async (client) => {
    await client.initialize();
    const close = await client.close();
    assert.equal(close.graceful, true);
    assert.equal(close.escalation, 'none');
    assert.equal(close.processExit?.code, 0);
    assert.equal(close.processExit?.signal, null);
  });
});

test('stdio client: refusal to exit escalates through SIGTERM to bounded SIGKILL', async () => {
  await withFixture(
    'refuse-exit',
    async (client) => {
      await client.initialize();
      const close = await client.close();
      assert.equal(close.graceful, false);
      assert.equal(close.escalation, 'sigkill');
      assert.equal(close.processExit?.signal, 'SIGKILL');
      assert.equal(close.liveness.childAlive, false);
      assert.notEqual(close.liveness.managedProcessGroupAlive, true);
    },
    {
      limits: {
        gracefulShutdownTimeoutMs: 40,
        sigtermTimeoutMs: 40,
        sigkillTimeoutMs: 500,
      },
    },
  );
});

test('stdio client: stderr cap fails closed without feeding stderr to the JSON parser', async () => {
  await withFixture(
    'excessive-stderr',
    async (client) => {
      await waitForFailure(client, 'stderr_limit_exceeded');
      await client.close();
      const diagnostic = client.diagnostics();
      assert.ok(diagnostic.resourceUsage.stderrBytes > diagnostic.resolvedLimits.maxStderrBytes);
      assert.equal(diagnostic.failures.some((failure) => failure.kind === 'malformed_json'), false);
      assert.equal(diagnostic.failures.some((failure) => failure.kind === 'stdout_contamination'), false);
      assert.equal(
        client.transcript().filter((event) => event.kind === 'limit_exceeded').length,
        1,
        'stderr breach must retain one bounded terminal event',
      );
    },
    { limits: { maxStderrBytes: 1_024 }, fixtureArgs: ['--stderr-bytes', '4096'] },
  );
});

test('stdio client: transcript cap fails closed and retains a terminal limit event', async () => {
  await withFixture(
    'transcript-excess',
    async (client) => {
      await client.initialize();
      const error = await captureMcpError(client.callTool('echo', { message: 'fill transcript' }));
      assert.equal(error.failure.kind, 'transcript_limit_exceeded');
      await client.close();
      assert.equal(client.transcript().filter((event) => event.kind === 'limit_exceeded').length, 1);
      assert.equal(client.diagnostics().fatalFailure?.kind, 'transcript_limit_exceeded');
      assert.ok(
        client.diagnostics().resourceUsage.transcriptBytes <= 10_000,
        'terminal cap evidence must stay bounded after shutdown',
      );
    },
    { limits: { maxTranscriptBytes: 8_000 }, fixtureArgs: ['--transcript-lines', '128'] },
  );
});

test('stdio client: configured frame cap fails closed before an oversized outbound tool call', async () => {
  await withFixture(
    'tool-call-success',
    async (client) => {
      await client.initialize();
      assert.throws(
        () => client.beginToolCall('echo', { message: 'X'.repeat(4_096) }),
        (error: unknown) => isMcpErrorKind(error, 'frame_limit_exceeded'),
      );
      assert.equal(client.diagnostics().fatalFailure?.kind, 'frame_limit_exceeded');
      const limit = client.transcript().find((event) => event.kind === 'limit_exceeded');
      assert.equal(limit?.direction, 'client_to_server');
      assert.equal(limit?.requestId, 2);
      assert.equal(limit?.method, 'tools/call');
      assert.match(limit?.rawLineDigest ?? '', /^[a-f0-9]{64}$/);
    },
    { limits: { maxFrameBytes: 1_024 } },
  );
});

test('stdio client: partial stdout chunks are reassembled without evidence loss', async () => {
  await withFixture('partial-stdout-chunks', async (client) => {
    await client.initialize();
    const discovery = await client.listTools();
    const outcome = await client.callTool('echo', { message: 'partial' });
    assert.equal(discovery.tools.length, 2);
    assert.equal(outcome.kind, 'tool_success');
    assert.equal(client.diagnostics().failures.length, 0);
    assert.ok(
      client
        .transcript()
        .filter((event) => event.direction === 'server_to_client' && event.rawLineDigest !== undefined)
        .every((event) => event.rawBytes !== undefined && event.rawByteLength === event.rawBytes.byteLength),
    );
  });
});

test('stdio client: multiple protocol lines in one stdout chunk remain ordered', async () => {
  await withFixture('multiple-lines-one-chunk', async (client) => {
    await client.initialize();
    const outcome = await client.callTool('echo', { message: 'coalesced' });
    assert.equal(outcome.kind, 'tool_success');
    const transcript = client.transcript();
    const notification = transcript.find(
      (event) => event.method === 'notifications/fixture/batched',
    );
    const response = transcript.find(
      (event) => event.kind === 'response_result' && event.requestId === outcome.requestId,
    );
    assert.ok(notification);
    assert.ok(response);
    assert.equal(notification.sequence + 1, response.sequence);
  });
});

test('demo server compatibility smoke: frozen local server works without modification', async () => {
  const options: McpStdioClientOptions = {
    executable: process.execPath,
    args: ['--experimental-sqlite', '--no-warnings', DEMO_ENTRY],
    cwd: ROOT,
    env: { OCULORY_FIXTURE: DEMO_FIXTURE },
    clientInfo: { name: 'oculory-demo-compatibility-smoke', version: '1.0.0' },
    requestedProtocolVersion: '2025-11-25',
    acceptedProtocolVersions: ['2025-06-18'],
    clientCapabilities: {},
    limits: TEST_LIMITS,
  };
  await withStartedClient(new McpStdioClient(options), async (client) => {
    const initialized = await client.initialize();
    const discovery = await client.listTools();
    const outcome = await client.callTool('search_tasks', { query: 'login' });
    const close = await client.close();
    assert.equal(initialized.negotiatedProtocolVersion, '2025-06-18');
    assert.equal(initialized.serverInfo.name, 'oculory-demo-tasks');
    assert.equal(discovery.tools.length, 8);
    assert.equal(outcome.kind, 'tool_success');
    assert.equal(close.graceful, true);
  });
});
