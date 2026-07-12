import { canonicalJson, hashJson, sha256 } from '../../schema/canonical.js';
import type { Json, JsonObject } from '../../schema/types.js';
import { McpStdioClient } from '../../mcp/client/stdio-client.js';
import {
  McpClientError,
  type McpCloseRecord,
  type McpDiscoveredTool,
  type McpInitializeRecord,
  type McpProcessStartRecord,
  type McpToolCallOutcome,
  type McpTranscriptEvent,
} from '../../mcp/client/types.js';
import {
  EXPECTED_GIT_TOOL_ORDER,
  GATE_B_EXCLUDED_TOOLS,
  assertExactFixtureRepositoryPath,
  buildGitSpikeChildEnvironment,
  buildGitSpikeClientOptions,
  environmentNameSummary,
  type ExpectedGitToolName,
  type GitSpikeRuntimeInspection,
} from './config.js';
import {
  cleanupGitSpikeFixture,
  createGitSpikeFixture,
  type GitSpikeCleanupProof,
  type GitSpikeFixture,
} from './fixture.js';
import {
  captureGitSpikeSnapshot,
  diffGitSpikeSnapshots,
  type GitSpikeSnapshot,
  type GitSpikeSnapshotDiff,
  type GitSpikeSnapshotLayer,
} from './snapshot.js';

export type GitSpikeCallOutcomeClass =
  | 'tool_success'
  | 'tool_error'
  | 'json_rpc_error'
  | 'client_failure';

export type GitSpikeStateClass = 'unchanged' | 'expected_delta' | 'unexpected_delta';

export interface GitSpikeCallSpec {
  tool: ExpectedGitToolName;
  arguments?: JsonObject;
  /** Only the named wrong-repository rejection probe may bypass the exact-root guard. */
  reviewedNonFixtureRepositoryPath?: boolean;
  reviewedBoundaryReason?: 'nonfixture_repo_path_probe';
}

export interface GitSpikeTrialPlan {
  name: string;
  prepare?: (fixture: GitSpikeFixture) => void;
  calls: (fixture: GitSpikeFixture) => readonly GitSpikeCallSpec[];
}

export interface GitSpikeJournalEntry {
  stage: string;
  snapshot: GitSpikeSnapshot;
  diffFromPrevious: GitSpikeSnapshotDiff | null;
}

export interface GitSpikeCallEvidence {
  index: number;
  tool: ExpectedGitToolName;
  arguments: JsonObject;
  requestId: number | null;
  outcomeClass: GitSpikeCallOutcomeClass;
  clientFailureKind: string | null;
  isError: boolean | null;
  contentTypes: string[];
  rawResponseDigest: string | null;
  semanticOutcomeDigest: string;
  rawOutcome: JsonObject;
  inputSchemaDigest: string;
  requestTranscriptSequence: number | null;
  responseTranscriptSequence: number | null;
  requestRawLineDigest: string | null;
  responseRawLineDigest: string | null;
  beforeSnapshotIndex: number;
  afterSnapshotIndex: number;
  stateDiff: GitSpikeSnapshotDiff;
}

export interface GitSpikeDiscoveryEvidence {
  toolNames: string[];
  pageCount: number;
  pageRawLineDigests: string[];
  rawDiscoveryDigest: string;
  semanticDiscoveryDigest: string;
  tools: Array<{
    name: string;
    semanticDigest: string;
    raw: JsonObject;
  }>;
}

export interface GitSpikeTranscriptEvidence {
  digest: string;
  semanticDigest: string;
  byteCount: number;
  stderrByteCount: number;
  stderrDigests: string[];
  unexpectedStdout: boolean;
  events: JsonObject[];
}

export interface GitSpikeTrialExecution {
  planName: string;
  trialId: string;
  fixture: {
    recipeDigest: string;
    firstCommit: string;
    mainHead: string;
    featureSeedHead: string;
    siblingHead: string;
  };
  processStart: McpProcessStartRecord | null;
  initialization: {
    requestedProtocolVersion: string;
    negotiatedProtocolVersion: string;
    serverInfo: JsonObject;
    capabilities: JsonObject;
    rawResult: JsonObject;
  } | null;
  discovery: GitSpikeDiscoveryEvidence | null;
  environmentNames: string[];
  command: { executable: string; args: string[]; cwd: string };
  calls: GitSpikeCallEvidence[];
  journal: GitSpikeJournalEntry[];
  transcript: GitSpikeTranscriptEvidence;
  shutdown: {
    observed: boolean;
    graceful: boolean;
    escalation: string;
    exitCode: number | null;
    signal: string | null;
    childAlive: boolean;
    managedProcessGroupAlive: boolean | null;
    allRequestsSettled: boolean;
    emergencyCleanupUsed: boolean;
  };
  cleanup: GitSpikeCleanupProof;
  errors: string[];
}

export interface RunGitSpikeTrialOptions {
  baseDirectory: string;
  trialId: string;
  runtime: GitSpikeRuntimeInspection;
  plan: GitSpikeTrialPlan;
}

export async function runGitSpikeTrial(
  options: RunGitSpikeTrialOptions,
): Promise<GitSpikeTrialExecution> {
  const fixture = createGitSpikeFixture({
    baseDirectory: options.baseDirectory,
    trialId: options.trialId,
    gitExecutable: options.runtime.gitExecutable,
  });
  const clientOptions = buildGitSpikeClientOptions(options.runtime, fixture.environmentPaths);
  const childEnvironment = buildGitSpikeChildEnvironment(options.runtime, fixture.environmentPaths);
  const client = new McpStdioClient(clientOptions);
  const journal: GitSpikeJournalEntry[] = [];
  const calls: GitSpikeCallEvidence[] = [];
  const errors: string[] = [];
  let start: McpProcessStartRecord | null = null;
  let initialization: McpInitializeRecord | null = null;
  let discoveryTools: readonly McpDiscoveredTool[] = [];
  let discovery: GitSpikeDiscoveryEvidence | null = null;
  let close: McpCloseRecord | null = null;
  let emergencyCleanupUsed = false;

  const appendSnapshot = (stage: string): number => {
    const snapshot = captureGitSpikeSnapshot(fixture);
    const previous = journal.at(-1)?.snapshot;
    journal.push({
      stage,
      snapshot,
      diffFromPrevious: previous === undefined ? null : diffGitSpikeSnapshots(previous, snapshot),
    });
    return journal.length - 1;
  };

  try {
    appendSnapshot('fixture_created');
    options.plan.prepare?.(fixture);
    appendSnapshot('before_server_start');
    start = await client.start();
    initialization = await client.initialize({ timeoutMs: 5_000 });
    appendSnapshot('after_server_start_and_initialize');
    const discoveryRecord = await client.listTools({ maxPages: 16, timeoutMs: 5_000 });
    discoveryTools = discoveryRecord.tools;
    assertExpectedDiscovery(discoveryTools);
    discovery = buildDiscoveryEvidence(client, discoveryRecord.tools, discoveryRecord.pages.map((page) => page.requestId));
    appendSnapshot('after_tool_discovery');

    const specs = options.plan.calls(fixture);
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index]!;
      assertCallableTool(spec.tool);
      const beforeSnapshotIndex = appendSnapshot(`before_call:${index}:${spec.tool}`);
      const args = prepareCallArguments(spec, fixture);
      let outcome: McpToolCallOutcome | null = null;
      let error: unknown = null;
      try {
        outcome = await client.callTool(spec.tool, args, { timeoutMs: 5_000 });
      } catch (caught) {
        error = caught;
      }
      const afterSnapshotIndex = appendSnapshot(`after_call:${index}:${spec.tool}`);
      const before = journal[beforeSnapshotIndex]!.snapshot;
      const after = journal[afterSnapshotIndex]!.snapshot;
      const tool = discoveryTools.find((entry) => entry.name === spec.tool);
      if (tool === undefined) throw new Error(`discovered schema missing for invoked tool ${spec.tool}`);
      calls.push(buildCallEvidence(
        client.transcript(),
        fixture,
        index,
        spec,
        args,
        tool,
        outcome,
        error,
        beforeSnapshotIndex,
        afterSnapshotIndex,
        diffGitSpikeSnapshots(before, after),
      ));
      if (error !== null) throw error;
    }
    appendSnapshot('after_final_response');
  } catch (error) {
    errors.push(errorMessage(error));
    tryAppendSnapshot(appendSnapshot, 'after_final_response_error', errors);
  } finally {
    try {
      close = await client.close();
    } catch (error) {
      errors.push(`client close failed: ${errorMessage(error)}`);
    }
    if (
      close === null ||
      close.liveness.childAlive ||
      close.liveness.managedProcessGroupAlive === true
    ) {
      emergencyCleanupUsed = await emergencyTerminate(start, errors);
    }
    tryAppendSnapshot(appendSnapshot, 'after_server_shutdown', errors);
    tryAppendSnapshot(appendSnapshot, 'before_cleanup', errors);
  }

  const transcript = buildTranscriptEvidence(client.transcript(), client.diagnostics().resourceUsage.stderrBytes, fixture);
  const shutdown = {
    observed: close !== null,
    graceful: close?.graceful ?? false,
    escalation: close?.escalation ?? 'unobserved',
    exitCode: close?.processExit?.code ?? null,
    signal: close?.processExit?.signal ?? null,
    childAlive: close?.liveness.childAlive ?? processRecordAlive(start),
    managedProcessGroupAlive:
      close?.liveness.managedProcessGroupAlive ?? processGroupRecordAlive(start),
    allRequestsSettled: close?.allRequestsSettled ?? false,
    emergencyCleanupUsed,
  };
  const cleanup = cleanupGitSpikeFixture(fixture, {
    closeObserved: shutdown.observed,
    allRequestsSettled: shutdown.allRequestsSettled,
    childAlive: shutdown.childAlive,
    managedProcessGroupAlive: shutdown.managedProcessGroupAlive,
    emergencyCleanupUsed,
  });
  if (!cleanup.passed) errors.push('fixture cleanup proof failed');

  return {
    planName: options.plan.name,
    trialId: options.trialId,
    fixture: {
      recipeDigest: fixture.seedRecipeDigest,
      firstCommit: fixture.firstCommit,
      mainHead: fixture.mainHead,
      featureSeedHead: fixture.featureSeedHead,
      siblingHead: fixture.siblingHead,
    },
    processStart: start === null ? null : { ...start },
    initialization:
      initialization === null
        ? null
        : {
            requestedProtocolVersion: initialization.requestedProtocolVersion,
            negotiatedProtocolVersion: initialization.negotiatedProtocolVersion,
            serverInfo: tokenizeJson(initialization.serverInfo.raw, fixture) as JsonObject,
            capabilities: tokenizeJson(initialization.serverCapabilities, fixture) as JsonObject,
            rawResult: tokenizeJson(initialization.rawResult, fixture) as JsonObject,
          },
    discovery,
    environmentNames: environmentNameSummary(childEnvironment),
    command: {
      executable: options.runtime.targetExecutable,
      args: ['--repository', '<FIXTURE_ROOT>'],
      cwd: '<FIXTURE_ROOT>',
    },
    calls,
    journal,
    transcript,
    shutdown,
    cleanup,
    errors,
  };
}

export function classifyStateDiff(
  diff: GitSpikeSnapshotDiff,
  expected: 'unchanged' | readonly GitSpikeSnapshotLayer[],
): GitSpikeStateClass {
  if (expected === 'unchanged') return diff.changedLayers.length === 0 ? 'unchanged' : 'unexpected_delta';
  const allowed = new Set(expected);
  if (diff.changedLayers.length === 0) return 'unexpected_delta';
  return diff.changedLayers.every((layer) => allowed.has(layer)) ? 'expected_delta' : 'unexpected_delta';
}

export function trialHasUnexpectedIntermediateChange(
  execution: Pick<GitSpikeTrialExecution, 'calls'>,
  expectedLayersByCall: readonly ('unchanged' | readonly GitSpikeSnapshotLayer[])[],
): boolean {
  if (execution.calls.length !== expectedLayersByCall.length) return true;
  return execution.calls.some((call, index) => {
    const expected = expectedLayersByCall[index]!;
    const classification = classifyStateDiff(call.stateDiff, expected);
    return expected === 'unchanged'
      ? classification !== 'unchanged'
      : classification !== 'expected_delta';
  });
}

function prepareCallArguments(spec: GitSpikeCallSpec, fixture: GitSpikeFixture): JsonObject {
  const args = structuredClone(spec.arguments ?? {});
  if (spec.reviewedNonFixtureRepositoryPath === true) {
    if (spec.reviewedBoundaryReason !== 'nonfixture_repo_path_probe') {
      throw new Error('non-fixture repo_path requires the reviewed boundary-probe reason');
    }
    if (args.repo_path !== fixture.siblingRepositoryRoot) {
      throw new Error('reviewed non-fixture probe must target the registered sibling repository exactly');
    }
    return args;
  }
  if (args.repo_path === undefined) args.repo_path = fixture.repositoryRoot;
  if (typeof args.repo_path !== 'string') throw new Error('repo_path must be a string');
  args.repo_path = assertExactFixtureRepositoryPath(args.repo_path, fixture.repositoryRoot);
  return args;
}

function buildCallEvidence(
  transcript: readonly McpTranscriptEvent[],
  fixture: GitSpikeFixture,
  index: number,
  spec: GitSpikeCallSpec,
  args: JsonObject,
  tool: McpDiscoveredTool,
  outcome: McpToolCallOutcome | null,
  error: unknown,
  beforeSnapshotIndex: number,
  afterSnapshotIndex: number,
  stateDiff: GitSpikeSnapshotDiff,
): GitSpikeCallEvidence {
  let requestId: number | null = null;
  let outcomeClass: GitSpikeCallOutcomeClass;
  let clientFailureKind: string | null = null;
  let isError: boolean | null = null;
  let contentTypes: string[] = [];
  let rawResponse: JsonObject | null = null;
  let requestTranscriptSequence: number | null = null;
  let responseTranscriptSequence: number | null = null;

  if (outcome !== null) {
    requestId = outcome.requestId;
    outcomeClass = outcome.kind;
    rawResponse = outcome.rawResponse;
    requestTranscriptSequence = outcome.requestTranscriptSequence;
    responseTranscriptSequence = outcome.responseTranscriptSequence;
    if (outcome.kind === 'tool_success' || outcome.kind === 'tool_error') {
      isError = outcome.isError;
      contentTypes = outcome.content.map((block) =>
        typeof block === 'object' && block !== null && !Array.isArray(block) && typeof block.type === 'string'
          ? block.type
          : 'invalid',
      );
    }
  } else {
    outcomeClass = 'client_failure';
    if (error instanceof McpClientError) {
      clientFailureKind = error.failure.kind;
      requestId = typeof error.failure.requestId === 'number' ? error.failure.requestId : null;
    } else {
      clientFailureKind = 'non_mcp_exception';
    }
  }

  const rawOutcome: JsonObject = outcome === null
    ? {
        kind: 'client_failure',
        failure_kind: clientFailureKind,
        message_digest: sha256(errorMessage(error)),
      }
    : tokenizeJson(outcomeToJson(outcome), fixture) as JsonObject;
  const requestEvent = requestTranscriptSequence === null
    ? undefined
    : transcript.find((event) => event.sequence === requestTranscriptSequence);
  const responseEvent = responseTranscriptSequence === null
    ? undefined
    : transcript.find((event) => event.sequence === responseTranscriptSequence);

  return {
    index,
    tool: spec.tool,
    arguments: tokenizeJson(args, fixture) as JsonObject,
    requestId,
    outcomeClass,
    clientFailureKind,
    isError,
    contentTypes,
    rawResponseDigest: rawResponse === null ? null : hashJson(rawResponse),
    semanticOutcomeDigest: hashJson(normalizePresentationJson(rawOutcome)),
    rawOutcome,
    inputSchemaDigest: tool.canonicalDigest,
    requestTranscriptSequence,
    responseTranscriptSequence,
    requestRawLineDigest: requestEvent?.rawLineDigest ?? null,
    responseRawLineDigest: responseEvent?.rawLineDigest ?? null,
    beforeSnapshotIndex,
    afterSnapshotIndex,
    stateDiff,
  };
}

function buildDiscoveryEvidence(
  client: McpStdioClient,
  tools: readonly McpDiscoveredTool[],
  responseIds: readonly number[],
): GitSpikeDiscoveryEvidence {
  const transcript = client.transcript();
  const pageRawLineDigests = responseIds.map((id) => {
    const event = transcript.find(
      (entry) =>
        entry.direction === 'server_to_client' &&
        (entry.kind === 'response_result' || entry.kind === 'response_error') &&
        entry.requestId === id,
    );
    if (event?.rawLineDigest === undefined) throw new Error(`missing raw tools/list response digest for request ${id}`);
    return event.rawLineDigest;
  });
  return {
    toolNames: tools.map((tool) => tool.name),
    pageCount: responseIds.length,
    pageRawLineDigests,
    rawDiscoveryDigest: sha256(pageRawLineDigests.join('\n')),
    semanticDiscoveryDigest: hashJson(tools.map((tool) => tool.raw) as unknown as Json),
    tools: tools.map((tool) => ({
      name: tool.name,
      semanticDigest: tool.canonicalDigest,
      raw: structuredClone(tool.raw),
    })),
  };
}

function buildTranscriptEvidence(
  transcript: readonly McpTranscriptEvent[],
  stderrByteCount: number,
  fixture: GitSpikeFixture,
): GitSpikeTranscriptEvidence {
  const events = transcript.map((event): JsonObject => {
    const value: JsonObject = {
      sequence: event.sequence,
      direction: event.direction,
      kind: event.kind,
      raw_line_digest: event.rawLineDigest ?? null,
      raw_byte_length: event.rawByteLength ?? null,
      parsed_message_kind: event.parsedMessageKind ?? null,
      request_id: event.requestId ?? null,
      method: event.method ?? null,
      cancellation_state: event.cancellationState ?? null,
      exit_code: event.exitCode ?? null,
      signal: event.signal ?? null,
      validation_error_digest:
        event.parseOrValidationError === undefined ? null : sha256(event.parseOrValidationError),
    };
    if (event.rawLine !== undefined) value.raw_line = tokenizeString(event.rawLine, fixture);
    return value;
  });
  const stderrDigests = transcript
    .filter((event) => event.direction === 'stderr' && event.rawLineDigest !== undefined)
    .map((event) => event.rawLineDigest!);
  const unexpectedStdout = transcript.some(
    (event) =>
      event.kind === 'stdout_contamination' ||
      event.kind === 'malformed_json' ||
      event.kind === 'invalid_jsonrpc',
  );
  const semanticEvents = events.map((event) => {
    const normalized: JsonObject = { ...event, raw_line_digest: null };
    if (typeof event.raw_line === 'string') {
      normalized.raw_line = normalizePresentationString(event.raw_line);
    } else {
      delete normalized.raw_line;
    }
    return normalized;
  });
  return {
    digest: hashJson(events as unknown as Json),
    semanticDigest: hashJson(semanticEvents as unknown as Json),
    byteCount: Buffer.byteLength(canonicalJson(events as unknown as Json), 'utf8'),
    stderrByteCount,
    stderrDigests,
    unexpectedStdout,
    events,
  };
}

function assertExpectedDiscovery(tools: readonly McpDiscoveredTool[]): void {
  const names = tools.map((tool) => tool.name);
  if (canonicalJson(names) !== canonicalJson([...EXPECTED_GIT_TOOL_ORDER])) {
    throw new Error(
      `unexpected Git MCP tool inventory/order: expected ${EXPECTED_GIT_TOOL_ORDER.join(', ')}, observed ${names.join(', ')}`,
    );
  }
}

function assertCallableTool(tool: ExpectedGitToolName): void {
  if ((GATE_B_EXCLUDED_TOOLS as readonly string[]).includes(tool)) {
    throw new Error(`Gate B spike may not invoke excluded tool ${tool}`);
  }
}

function outcomeToJson(outcome: McpToolCallOutcome): JsonObject {
  if (outcome.kind === 'json_rpc_error') {
    return {
      kind: outcome.kind,
      request_id: outcome.requestId,
      method: outcome.method,
      tool_name: outcome.toolName,
      arguments: outcome.arguments,
      error: outcome.error.raw,
      raw_response: outcome.rawResponse,
    };
  }
  return {
    kind: outcome.kind,
    request_id: outcome.requestId,
    tool_name: outcome.toolName,
    arguments: outcome.arguments,
    is_error: outcome.isError,
    content: [...outcome.content],
    structured_content: outcome.structuredContent,
    raw_result: outcome.rawResult,
    raw_response: outcome.rawResponse,
  };
}

function tokenizeJson(value: Json, fixture: GitSpikeFixture): Json {
  if (typeof value === 'string') return tokenizeString(value, fixture);
  if (Array.isArray(value)) return value.map((entry) => tokenizeJson(entry, fixture));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, tokenizeJson(entry, fixture)]),
    );
  }
  return value;
}

function tokenizeString(value: string, fixture: GitSpikeFixture): string {
  return value
    .split(fixture.repositoryRoot).join('<FIXTURE_ROOT>')
    .split(fixture.siblingRepositoryRoot).join('<SIBLING_ROOT>')
    .split(fixture.trialRoot).join('<TRIAL_ROOT>');
}

function normalizePresentationJson(value: Json): Json {
  if (typeof value === 'string') return normalizePresentationString(value);
  if (Array.isArray(value)) return value.map(normalizePresentationJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizePresentationJson(entry)]),
    );
  }
  return value;
}

function normalizePresentationString(value: string): string {
  return value.replace(
    /<git\.objects\.util\.tzoffset object at 0x[0-9a-fA-F]+>/g,
    '<GITPYTHON_TZOFFSET_OBJECT>',
  );
}

function tryAppendSnapshot(
  append: (stage: string) => number,
  stage: string,
  errors: string[],
): void {
  try {
    append(stage);
  } catch (error) {
    errors.push(`snapshot '${stage}' failed: ${errorMessage(error)}`);
  }
}

async function emergencyTerminate(
  start: McpProcessStartRecord | null,
  errors: string[],
): Promise<boolean> {
  if (start === null) return false;
  const childAlive = processExists(start.pid);
  const groupAlive =
    start.processGroupManaged && start.processGroupId !== null
      ? processExists(-start.processGroupId)
      : false;
  if (!childAlive && !groupAlive) return false;
  const target = start.processGroupManaged && start.processGroupId !== null
    ? -start.processGroupId
    : start.pid;
  try {
    process.kill(target, 'SIGKILL');
  } catch (error) {
    if (!isNoSuchProcess(error)) errors.push(`emergency SIGKILL failed: ${errorMessage(error)}`);
  }
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!processExists(start.pid) && !(
      start.processGroupManaged &&
      start.processGroupId !== null &&
      processExists(-start.processGroupId)
    )) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  errors.push('emergency cleanup could not prove child/process-group absence');
  return true;
}

function processRecordAlive(start: McpProcessStartRecord | null): boolean {
  return start !== null && processExists(start.pid);
}

function processGroupRecordAlive(start: McpProcessStartRecord | null): boolean | null {
  if (start === null || !start.processGroupManaged || start.processGroupId === null) return null;
  return processExists(-start.processGroupId);
}

function processExists(pid: number): boolean {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
