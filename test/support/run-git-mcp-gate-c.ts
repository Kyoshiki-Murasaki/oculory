import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalJson, hashJson } from '../../src/schema/canonical.js';
import type { Json, JsonObject } from '../../src/schema/types.js';
import {
  EXPECTED_GIT_TOOL_ORDER,
  GIT_SPIKE_TARGET,
  inspectGitSpikeRuntime,
  type GitSpikeRuntimeInspection,
} from '../../src/targets/git-spike/config.js';
import {
  runGitSpikeTrial,
  type GitSpikeTrialExecution,
  type GitSpikeTrialPlan,
} from '../../src/targets/git-spike/direct-harness.js';

interface Arguments {
  pythonExecutable: string;
  targetExecutable: string;
  gitExecutable: string;
  lockPath: string;
  outputPath: string;
  sessions: number;
}

interface DifferenceFinding {
  field: string;
  classification: 'semantic' | 'presentation-only' | 'environment-derived' | 'unexplained';
  detail: string;
}

interface SessionAssessment {
  passed: boolean;
  reasons: string[];
  semanticSignature: string;
  protocolFindings: {
    unmatchedResponseIds: number;
    duplicateResponseIds: number;
    invalidProtocolLines: number;
    unexpectedStdout: number;
    transcriptTruncations: number;
    clientFailures: number;
  };
}

interface GateCSession {
  sessionIndex: number;
  elapsedMs: number;
  executableSha256: string;
  lockSha256: string;
  fixtureRecipeDigest: string;
  initialStateDigest: string | null;
  execution: GitSpikeTrialExecution;
  assessment: SessionAssessment;
}

interface FaultCriterion {
  criterion: string;
  testName: string;
  location: string;
}

interface GateCReport {
  schema: 'oculory-git-gate-c-temporary-v1';
  generatedAt: string;
  oculorySource: { head: string; dirty: boolean; sourceTreeDigest: string };
  host: { os: string; osRelease: string; architecture: string; nodeVersion: string };
  target: typeof GIT_SPIKE_TARGET;
  runtime: GitSpikeRuntimeInspection & {
    lockPath: string;
    lockFileSha256: string;
    executableSha256: string;
  };
  requestedSessions: number;
  completedSessions: number;
  faultTests: {
    command: string[];
    passed: boolean;
    exitCode: number | null;
    signal: string | null;
    stdoutSha256: string;
    stderrSha256: string;
    criteria: readonly FaultCriterion[];
  };
  sessions: GateCSession[];
  aggregate: {
    semanticStable: boolean;
    semanticSignature: string | null;
    rawTranscriptStable: boolean;
    tokenizedTranscriptStable: boolean;
    protocolFindingTotals: SessionAssessment['protocolFindings'];
    successCalls: number;
    expectedErrorCalls: number;
    unchangedSuccessCalls: number;
    unchangedErrorCalls: number;
    gracefulShutdowns: number;
    cleanupPasses: number;
    sentinelPasses: number;
    differences: DifferenceFinding[];
    unexplainedDifferences: DifferenceFinding[];
  };
  parentClean: boolean;
  gateCDecision: 'passed' | 'failed' | 'inconclusive';
  reportSha256?: string;
}

const PLAN: GitSpikeTrialPlan = {
  name: 'gate_c_transport',
  calls: () => [
    { tool: 'git_status' },
    { tool: 'git_show', arguments: { revision: 'oculory-gate-c-nonexistent-revision' } },
  ],
};

const FAULT_CRITERIA: readonly FaultCriterion[] = [
  map('notification interleaving', 'stdio client: notification interleaving is retained before the matching response', 497),
  map('server-to-client request', 'stdio client: unsupported server request receives an error and cannot deadlock the client', 515),
  map('request timeout and cancellation notification', 'stdio client: request timeout is explicit, sends cancellation, and settles the promise', 534),
  map('explicit cancellation notification', 'stdio client: explicit cancellation is classified and recorded', 557),
  map('late response retention', 'stdio client: deterministic late response after cancellation remains visible evidence', 576),
  map('process crash', 'stdio client: nonzero process exit is classified distinctly as process_crash', 609),
  map('EOF with outstanding request', 'stdio client: EOF with an outstanding request is a transport_eof, not success or rejection', 599),
  map('malformed JSON/framing', 'stdio client: malformed JSON is retained and classified', 408),
  map('structurally invalid JSON-RPC', 'stdio client: structurally invalid JSON-RPC is retained and classified', 419),
  map('mismatched response ID', 'stdio client: mismatched response ID fails the outstanding request', 479),
  map('duplicate response ID', 'stdio client: duplicate response ID is detected before a coalesced duplicate can be accepted', 488),
  map('stdout contamination', 'stdio client: stdout contamination is never interpreted as stderr or a tool result', 453),
  map('stderr separation', 'stdio client: bounded stderr stays separate from protocol parsing', 464),
  map('excessive stderr', 'stdio client: stderr cap fails closed without feeding stderr to the JSON parser', 662),
  map('transcript overflow', 'stdio client: transcript cap fails closed and retains a terminal limit event', 682),
  map('partial frames', 'stdio client: partial stdout chunks are reassembled without evidence loss', 721),
  map('coalesced frames', 'stdio client: multiple protocol lines in one stdout chunk remain ordered', 738),
];

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const lockFileSha256 = sha256File(args.lockPath);
  if (lockFileSha256 !== GIT_SPIKE_TARGET.lockSha256) {
    throw new Error(`lock digest mismatch: expected ${GIT_SPIKE_TARGET.lockSha256}, observed ${lockFileSha256}`);
  }
  const runtime = inspectGitSpikeRuntime({
    pythonExecutable: args.pythonExecutable,
    targetExecutable: args.targetExecutable,
    gitExecutable: args.gitExecutable,
    lockSha256: lockFileSha256,
  });
  const executableSha256 = sha256File(runtime.targetExecutable);
  const source = readOculorySourceState(runtime.gitExecutable);
  const faultTests = runFaultTests(runtime.gitExecutable);
  const baseDirectory = mkdtempSync(join(tmpdir(), 'oculory-git-gate-c-'));
  const sessions: GateCSession[] = [];
  let parentClean = false;

  try {
    for (let sessionIndex = 1; sessionIndex <= args.sessions; sessionIndex += 1) {
      const start = process.hrtime.bigint();
      const execution = await runGitSpikeTrial({
        baseDirectory,
        trialId: `gate-c-${String(sessionIndex).padStart(2, '0')}`,
        runtime,
        plan: PLAN,
      });
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      sessions.push({
        sessionIndex,
        elapsedMs,
        executableSha256,
        lockSha256: lockFileSha256,
        fixtureRecipeDigest: execution.fixture.recipeDigest,
        initialStateDigest: findSnapshot(execution, 'fixture_created')?.stateHash ?? null,
        execution,
        assessment: assessSession(execution),
      });
    }
    parentClean = readdirSync(baseDirectory).length === 0;
    const aggregate = buildAggregate(sessions);
    const gateCDecision =
      sessions.length === args.sessions &&
      sessions.every((session) => session.assessment.passed) &&
      aggregate.semanticStable &&
      aggregate.unexplainedDifferences.length === 0 &&
      faultTests.passed &&
      parentClean
        ? 'passed'
        : 'failed';
    const report: GateCReport = {
      schema: 'oculory-git-gate-c-temporary-v1',
      generatedAt: new Date().toISOString(),
      oculorySource: source,
      host: { os: platform(), osRelease: release(), architecture: arch(), nodeVersion: process.version },
      target: GIT_SPIKE_TARGET,
      runtime: {
        ...runtime,
        lockPath: args.lockPath,
        lockFileSha256,
        executableSha256,
      },
      requestedSessions: args.sessions,
      completedSessions: sessions.length,
      faultTests,
      sessions,
      aggregate,
      parentClean,
      gateCDecision,
    };
    const withoutDigest = JSON.stringify(report, null, 2);
    report.reportSha256 = createHash('sha256').update(withoutDigest, 'utf8').digest('hex');
    writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'w',
    });
    process.stdout.write(`${JSON.stringify({
      gate_c_decision: gateCDecision,
      sessions: sessions.length,
      fault_tests_passed: faultTests.passed,
      output: args.outputPath,
      report_sha256: report.reportSha256,
    })}\n`);
    if (gateCDecision !== 'passed') process.exitCode = 1;
  } finally {
    rmSync(baseDirectory, { recursive: true, force: true });
  }
}

function assessSession(execution: GitSpikeTrialExecution): SessionAssessment {
  const reasons: string[] = [];
  const events = execution.transcript.events;
  const requestIds = events
    .filter((event) => event.direction === 'client_to_server' && event.kind === 'request')
    .map((event) => event.request_id)
    .filter((id): id is number => typeof id === 'number');
  const responseIds = events
    .filter((event) => event.kind === 'response_result' || event.kind === 'response_error')
    .map((event) => event.request_id)
    .filter((id): id is number => typeof id === 'number');
  const unmatchedResponseIds = responseIds.filter((id) => !requestIds.includes(id)).length;
  const duplicateResponseIds = responseIds.length - new Set(responseIds).size;
  const invalidProtocolLines = events.filter((event) =>
    event.kind === 'malformed_json' || event.kind === 'invalid_jsonrpc').length;
  const unexpectedStdout = events.filter((event) => event.kind === 'stdout_contamination').length;
  const transcriptTruncations = events.filter((event) => event.kind === 'limit_exceeded').length;
  const clientFailures = events.filter((event) => event.kind === 'client_failure').length;
  const protocolFindings = {
    unmatchedResponseIds,
    duplicateResponseIds,
    invalidProtocolLines,
    unexpectedStdout,
    transcriptTruncations,
    clientFailures,
  };

  require(execution.errors.length === 0, `harness errors: ${execution.errors.join('; ')}`, reasons);
  require(execution.initialization?.requestedProtocolVersion === GIT_SPIKE_TARGET.requestedProtocolVersion, 'requested protocol differs', reasons);
  require(execution.initialization?.negotiatedProtocolVersion === GIT_SPIKE_TARGET.requestedProtocolVersion, 'negotiated protocol differs', reasons);
  require(execution.discovery?.pageCount === 1, 'tools/list did not complete in one page', reasons);
  require(canonicalJson(execution.discovery?.toolNames ?? []) === canonicalJson([...EXPECTED_GIT_TOOL_ORDER]), 'tool inventory differs', reasons);
  require(execution.calls.length === 2, 'session did not retain exactly two tool calls', reasons);
  const success = execution.calls[0];
  const expectedError = execution.calls[1];
  require(success?.tool === 'git_status', 'first call was not git_status', reasons);
  require(success?.outcomeClass === 'tool_success' && success.isError === false, 'git_status was not a successful MCP tool result', reasons);
  require(expectedError?.tool === 'git_show', 'second call was not git_show', reasons);
  require(expectedError?.outcomeClass === 'tool_error' && expectedError.isError === true, 'git_show missing-revision result was not retained as MCP tool_error', reasons);
  require(callUnchanged(success), 'git_status changed independently observed state', reasons);
  require(callUnchanged(expectedError), 'expected git_show error changed independently observed state', reasons);
  require(events.some((event) => event.direction === 'client_to_server' && event.kind === 'notification' && event.method === 'notifications/initialized'), 'notifications/initialized is absent', reasons);
  require(Object.values(protocolFindings).every((count) => count === 0), 'protocol finding count was nonzero', reasons);
  require(execution.transcript.stderrByteCount === 0, 'stderr was not empty', reasons);
  require(events.some((event) => event.kind === 'stdin_closed'), 'stdin close was not recorded', reasons);
  require(events.some((event) => event.kind === 'stdout_eof'), 'stdout EOF was not recorded', reasons);
  require(events.some((event) => event.kind === 'stderr_eof'), 'stderr EOF was not recorded', reasons);
  require(events.some((event) => event.kind === 'process_exit'), 'process exit was not recorded', reasons);
  require(execution.shutdown.observed && execution.shutdown.graceful, 'shutdown was not unambiguously graceful', reasons);
  require(execution.shutdown.escalation === 'none', 'shutdown escalated', reasons);
  require(execution.shutdown.exitCode === 0 && execution.shutdown.signal === null, 'process did not exit cleanly', reasons);
  require(!execution.shutdown.childAlive && execution.shutdown.managedProcessGroupAlive !== true, 'process or managed group remained alive', reasons);
  require(execution.shutdown.allRequestsSettled, 'a request remained unsettled', reasons);
  require(!execution.shutdown.emergencyCleanupUsed, 'emergency cleanup was used', reasons);
  require(execution.cleanup.passed, 'fixture cleanup failed', reasons);
  require(execution.cleanup.sentinelUnchangedBeforeRepositoryRemoval, 'sibling sentinel changed before repository removal', reasons);
  require(execution.cleanup.sentinelUnchangedAfterRepositoryRemoval, 'sibling sentinel changed after repository removal', reasons);

  return {
    passed: reasons.length === 0,
    reasons,
    semanticSignature: hashJson(semanticSession(execution)),
    protocolFindings,
  };
}

function buildAggregate(sessions: readonly GateCSession[]): GateCReport['aggregate'] {
  const signatures = new Set(sessions.map((session) => session.assessment.semanticSignature));
  const rawTranscriptDigests = new Set(sessions.map((session) => session.execution.transcript.digest));
  const semanticTranscriptDigests = new Set(sessions.map((session) => session.execution.transcript.semanticDigest));
  const differences: DifferenceFinding[] = [];
  if (new Set(sessions.map((session) => session.elapsedMs)).size > 1) {
    differences.push({ field: 'elapsed_ms', classification: 'environment-derived', detail: 'Wall-clock timings varied and are diagnostic only.' });
  }
  if (rawTranscriptDigests.size > 1) {
    differences.push({ field: 'raw_transcript_digest', classification: 'environment-derived', detail: 'Fresh absolute fixture paths differ; tokenized transcript evidence is compared separately.' });
  }
  if (semanticTranscriptDigests.size > 1) {
    differences.push({ field: 'tokenized_transcript_digest', classification: 'unexplained', detail: 'Tokenized protocol transcripts differed across otherwise identical sessions.' });
  }
  if (signatures.size > 1) {
    differences.push({ field: 'semantic_session_signature', classification: 'semantic', detail: 'Protocol, discovery, call, state, shutdown, or cleanup evidence differed.' });
  }
  return {
    semanticStable: signatures.size === 1 && sessions.every((session) => session.assessment.passed),
    semanticSignature: signatures.size === 1 ? [...signatures][0]! : null,
    rawTranscriptStable: rawTranscriptDigests.size === 1,
    tokenizedTranscriptStable: semanticTranscriptDigests.size === 1,
    protocolFindingTotals: sumProtocolFindings(sessions),
    successCalls: sessions.filter((session) => session.execution.calls[0]?.outcomeClass === 'tool_success').length,
    expectedErrorCalls: sessions.filter((session) => session.execution.calls[1]?.outcomeClass === 'tool_error').length,
    unchangedSuccessCalls: sessions.filter((session) => callUnchanged(session.execution.calls[0])).length,
    unchangedErrorCalls: sessions.filter((session) => callUnchanged(session.execution.calls[1])).length,
    gracefulShutdowns: sessions.filter((session) => session.execution.shutdown.graceful && session.execution.shutdown.escalation === 'none').length,
    cleanupPasses: sessions.filter((session) => session.execution.cleanup.passed).length,
    sentinelPasses: sessions.filter((session) => session.execution.cleanup.sentinelUnchangedBeforeRepositoryRemoval && session.execution.cleanup.sentinelUnchangedAfterRepositoryRemoval).length,
    differences,
    unexplainedDifferences: differences.filter((difference) => difference.classification === 'unexplained'),
  };
}

function semanticSession(execution: GitSpikeTrialExecution): JsonObject {
  return {
    fixture_recipe_digest: execution.fixture.recipeDigest,
    initial_state_digest: findSnapshot(execution, 'fixture_created')?.stateHash ?? null,
    requested_protocol: execution.initialization?.requestedProtocolVersion ?? null,
    negotiated_protocol: execution.initialization?.negotiatedProtocolVersion ?? null,
    server_info: execution.initialization?.serverInfo ?? null,
    capabilities: execution.initialization?.capabilities ?? null,
    discovery_page_count: execution.discovery?.pageCount ?? null,
    discovery_digest: execution.discovery?.semanticDiscoveryDigest ?? null,
    tools: execution.discovery?.tools.map((tool) => ({ name: tool.name, digest: tool.semanticDigest })) ?? [],
    calls: execution.calls.map((call) => ({
      tool: call.tool,
      outcome_class: call.outcomeClass,
      is_error: call.isError,
      semantic_outcome_digest: call.semanticOutcomeDigest,
      changed_layers: call.stateDiff.changedLayers,
      before_state_hash: call.stateDiff.beforeStateHash,
      after_state_hash: call.stateDiff.afterStateHash,
    })),
    transcript_semantic_digest: execution.transcript.semanticDigest,
    stderr_bytes: execution.transcript.stderrByteCount,
    shutdown: execution.shutdown,
    cleanup_passed: execution.cleanup.passed,
  };
}

function runFaultTests(gitExecutable: string): GateCReport['faultTests'] {
  const testPath = resolve('dist/test/mcp-stdio-client.test.js');
  const command = [process.execPath, '--test', testPath];
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: process.cwd(),
    env: {
      PATH: [dirname(process.execPath), dirname(gitExecutable), '/usr/bin', '/bin'].join(':'),
      NODE_OPTIONS: '--experimental-sqlite --no-warnings',
      LC_ALL: 'C',
      LANG: 'C',
      TZ: 'UTC',
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    command,
    passed: result.status === 0 && result.signal === null && result.error === undefined,
    exitCode: result.status,
    signal: result.signal,
    stdoutSha256: sha256Text(stdout),
    stderrSha256: sha256Text(stderr),
    criteria: FAULT_CRITERIA,
  };
}

function sumProtocolFindings(sessions: readonly GateCSession[]): SessionAssessment['protocolFindings'] {
  const total: SessionAssessment['protocolFindings'] = {
    unmatchedResponseIds: 0,
    duplicateResponseIds: 0,
    invalidProtocolLines: 0,
    unexpectedStdout: 0,
    transcriptTruncations: 0,
    clientFailures: 0,
  };
  for (const session of sessions) {
    for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += session.assessment.protocolFindings[key];
  }
  return total;
}

function callUnchanged(call: GitSpikeTrialExecution['calls'][number] | undefined): boolean {
  return call !== undefined && call.stateDiff.changedLayers.length === 0 && call.stateDiff.beforeStateHash === call.stateDiff.afterStateHash;
}

function findSnapshot(execution: GitSpikeTrialExecution, stage: string) {
  return execution.journal.find((entry) => entry.stage === stage)?.snapshot;
}

function map(criterion: string, testName: string, line: number): FaultCriterion {
  return { criterion, testName, location: `test/mcp-stdio-client.test.ts:${line}` };
}

function require(condition: boolean, reason: string, reasons: string[]): void {
  if (!condition) reasons.push(reason);
}

function readOculorySourceState(gitExecutable: string): GateCReport['oculorySource'] {
  const env = { PATH: [dirname(gitExecutable), '/usr/bin', '/bin'].join(':'), LC_ALL: 'C' };
  const head = execFileSync(gitExecutable, ['rev-parse', 'HEAD'], { cwd: process.cwd(), env, encoding: 'utf8' }).trim();
  const status = execFileSync(gitExecutable, ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: process.cwd(), env, encoding: 'utf8' });
  const paths = execFileSync(gitExecutable, ['ls-files', '--modified', '--others', '--exclude-standard', '-z'], { cwd: process.cwd(), env, encoding: 'buffer' })
    .toString('utf8').split('\0').filter(Boolean).sort();
  const source = createHash('sha256').update(head).update('\0').update(status);
  for (const path of paths) source.update(path).update('\0').update(readFileSync(path));
  return { head, dirty: status.length > 0, sourceTreeDigest: source.digest('hex') };
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    const value = argv[index + 1];
    if (!name.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`invalid argument near ${name}`);
    values.set(name, value);
    index += 1;
  }
  const requiredPath = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
    return resolve(value);
  };
  const sessions = Number(values.get('--sessions') ?? '20');
  if (sessions !== 20) throw new Error('--sessions must be exactly 20 for Gate C');
  return {
    pythonExecutable: requiredPath('--python'),
    targetExecutable: requiredPath('--executable'),
    gitExecutable: requiredPath('--git'),
    lockPath: requiredPath('--lock'),
    outputPath: requiredPath('--output'),
    sessions,
  };
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

void main().catch((error: unknown) => {
  process.stderr.write(`Git MCP Gate C failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
