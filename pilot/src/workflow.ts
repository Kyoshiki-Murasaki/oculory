import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ExternalRunStore } from '../../src/external/run-store.js';
import { CapEngine } from '../../src/model/caps.js';
import { createPromptManifest, createScenarioManifest } from '../../src/model/manifests.js';
import { ModelSessionStateMachine } from '../../src/model/runner.js';
import type { GateFCapPolicy } from '../../src/model/types.js';
import { hashJson } from '../../src/schema/canonical.js';
import type { Json, JsonObject } from '../../src/schema/types.js';
import { GIT_SPIKE_TARGET, type GitSpikeRuntimeInspection } from '../../src/targets/git-spike/config.js';
import { gitGateE2AdapterScenario } from '../../src/targets/git/gate-e2-adapter-mutations.js';
import {
  GIT_GATE_E2_APPROVED_IDS,
  evaluateGitCompiledSuite,
  validateGitCompiledSuite,
  type GitCompiledSuiteV1,
} from '../../src/targets/git/gate-e2.js';
import {
  buildGitGateE2MutationRegistry,
  validateGitGateE2MutationRegistry,
} from '../../src/targets/git/gate-e2-registry.js';
import {
  GIT_GATE_E1_SCENARIOS,
  gitGateE1Scenario,
  type GitGateE1Scenario,
} from '../../src/targets/git/catalogue.js';
import { persistGitExternalTrial } from '../../src/targets/git/external-record.js';
import {
  GitMiningLoader,
  compileGitApprovedSuite,
  mineGitAssertions,
  renderGitCandidateReview,
  type GitMiningResult,
} from '../../src/targets/git/mining.js';
import { executeGitScriptedScenario, type GitScriptedScenarioResult } from '../../src/targets/git/scripted-driver.js';
import { executeDeterministicMockGitTurns } from '../../src/targets/git/model/offline-session.js';
import {
  PILOT_CONTROLLED_REGRESSION_ID,
  PILOT_REPORT_SCHEMA_VERSION,
  PILOT_STAGE_IDS,
  PILOT_TOTAL_TIMEOUT_MS,
  type PilotStageId,
} from './constants.js';
import { runPilotDoctor, type PilotDoctorOptions } from './doctor.js';
import {
  sanitizePilotMessage,
  validatePilotReport,
  type PilotReport,
  type PilotStageResult,
} from './report.js';
import { validatePilotOutputPath } from './safety.js';

const SUITE_PATH = 'suites/external/git/git-suite-v1.json';

export interface PilotWorkflowOptions {
  repositoryRoot: string;
  outputDirectory: string;
  pythonExecutable?: string;
  targetExecutable?: string;
  gitExecutable?: string;
  signal?: AbortSignal;
  now?: () => number;
}

export interface PilotWorkflowResult {
  report: PilotReport;
  reportPath: string;
}

interface WorkflowMetrics {
  targetSessions: number;
  mockProviderSessions: number;
  mockProviderTurns: number;
  mcpToolCalls: number;
  toolCatalogueSize: number;
  candidates: PilotReport['metrics']['candidates'];
  suite: PilotReport['metrics']['suite'];
  replay: PilotReport['metrics']['replay'];
  controlledRegression: PilotReport['metrics']['controlledRegression'];
}

export class PilotCancellationError extends Error {
  constructor(message = 'participant cancelled the pilot') {
    super(message);
    this.name = 'PilotCancellationError';
  }
}

export async function runPilotWorkflow(options: PilotWorkflowOptions): Promise<PilotWorkflowResult> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const outputDirectory = validatePilotOutputPath(repositoryRoot, resolve(options.outputDirectory));
  if (existsSync(outputDirectory)) throw new Error('pilot output directory already exists; choose a new path');
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const rawRoot = join(outputDirectory, 'raw-local-artifacts');
  mkdirSync(rawRoot, { recursive: false, mode: 0o700 });
  const now = options.now ?? Date.now;
  const recorder = new StageRecorder(now);
  const deadline = now() + PILOT_TOTAL_TIMEOUT_MS;
  let workingBase: string | null = null;
  let doctor: Awaited<ReturnType<typeof runPilotDoctor>> | null = null;
  let source = sourceIdentity(repositoryRoot);
  let fullSuite = loadSuite(repositoryRoot);
  let store: ExternalRunStore | null = null;
  let mining: GitMiningResult | null = null;
  let primaryFailure: unknown = null;
  const metrics: WorkflowMetrics = emptyMetrics(fullSuite);
  const cleanup = {
    allChildProcessesExited: true,
    allFixtureRootsRemoved: true,
    workingDirectoryRemoved: true,
    emergencyCleanupUsed: false,
    rawArtifactsLocalOnly: true as const,
  };

  const active = (): void => assertPilotActive(options.signal, deadline, now());

  try {
    doctor = await recorder.run('install_check', async () => {
      active();
      const doctorOptions: PilotDoctorOptions = {
        repositoryRoot,
        outputDirectory,
        ...(options.pythonExecutable === undefined ? {} : { pythonExecutable: options.pythonExecutable }),
        ...(options.targetExecutable === undefined ? {} : { targetExecutable: options.targetExecutable }),
        ...(options.gitExecutable === undefined ? {} : { gitExecutable: options.gitExecutable }),
      };
      const result = await runPilotDoctor(doctorOptions);
      if (!result.report.ok || result.runtime === null || result.paths === null || result.outputDirectory === null) {
        throw new Error('pilot doctor failed; follow its bounded recovery instructions');
      }
      active();
      return result;
    });

    const runtime = doctor.runtime!;
    const promptScenarioManifest = createScenarioManifest();
    const promptManifest = createPromptManifest(fullSuite.toolInventoryDigest, promptScenarioManifest.digest);
    const authorizationDigest = hashJson({
      schemaVersion: 'pilot-offline-authorization-v1',
      provider: 'mock',
      network: false,
      providerCalls: 0,
      f1Authorized: false,
      f2Authorized: false,
    } as unknown as Json);
    const capPolicy: GateFCapPolicy = {
      version: 'gate-f-cap-policy-v1',
      maximumSessions: 20,
      maximumTurnsPerSession: 4,
      maximumMcpCallsPerSession: 6,
      maximumTotalMcpCalls: 100,
      maximumInputTokens: 1_000_000,
      maximumOutputTokens: 250_000,
      maximumContextTokens: 250_000,
      maximumRetries: 0,
      hardDollarMicros: 0,
      inputPriceMicrosPerMillion: 0,
      outputPriceMicrosPerMillion: 0,
    };
    const caps = new CapEngine(capPolicy);
    const executableSha256 = sha256(readFileSync(runtime.targetExecutable));

    await recorder.run('deterministic_session', async () => {
      active();
      workingBase = mkdtempSync(join(tmpdir(), 'oculory-pilot-work-'));
      store = ExternalRunStore.create(rawRoot, 'pilot-track-a');
      const preflight = await executeGitScriptedScenario({
        baseDirectory: workingBase,
        trialId: 'pilot-schema-preflight',
        runtime,
        scenario: gitGateE1Scenario('git-status-s1'),
      });
      observeExecution(preflight, metrics);
      if (preflight.execution.discovery?.semanticDiscoveryDigest !== fullSuite.toolInventoryDigest) {
        throw new Error('pinned Git MCP tool catalogue differs from the compiled suite binding');
      }
      metrics.toolCatalogueSize = preflight.execution.discovery.tools.length;
      const exactSchemas = preflight.execution.discovery.tools.map((tool) => tool.raw);

      for (const scenario of GIT_GATE_E1_SCENARIOS.filter((entry) => entry.partition === 'mining')) {
        for (let trialIndex = 1; trialIndex <= 3; trialIndex += 1) {
          active();
          const trialId = `${scenario.id}-t${String(trialIndex).padStart(2, '0')}`;
          const outcome = await runMockSession({
            baseDirectory: workingBase,
            trialId,
            runtime,
            scenario,
            exactSchemas,
            promptDigest: promptManifest.digest,
            scenarioDigest: promptScenarioManifest.digest,
            authorizationDigest,
            systemInstructions: promptManifest.systemPrompt,
            caps,
          });
          observeExecution(outcome.result, metrics);
          metrics.mockProviderSessions += 1;
          metrics.mockProviderTurns += outcome.turns;
          persistGitExternalTrial({
            store,
            scenario,
            trialIndex,
            trialId,
            result: outcome.result,
            provenance: {
              runId: store.runId,
              source,
              runtime,
              executableSha256,
              os: `${platform()} ${release()}`,
              architecture: arch(),
            },
          });
          active();
        }
      }
      if (metrics.mockProviderSessions !== 18) throw new Error('guided mining did not complete exactly 18 mock sessions');
    });

    let miningTraces: ReturnType<GitMiningLoader['loadAll']> = [];
    await recorder.run('evidence_inspection', async () => {
      active();
      if (store === null) throw new Error('pilot evidence store was not created');
      miningTraces = new GitMiningLoader(store).loadAll();
      if (miningTraces.length !== 18 || miningTraces.some((trace) => !trace.evidenceCompleteness.complete)) {
        throw new Error('pilot evidence is incomplete or has an unexpected session count');
      }
      active();
    });

    await recorder.run('candidate_review', async () => {
      active();
      if (store === null) throw new Error('pilot evidence store was not created');
      mining = mineGitAssertions(miningTraces);
      store.writeJson('candidates.json', mining as unknown as Json);
      store.writeText('reports/candidate-review.md', renderGitCandidateReview(mining));
      const approved = mining.candidates.filter((candidate) => GIT_GATE_E2_APPROVED_IDS.includes(candidate.candidateId as never));
      const rejected = mining.candidates.filter((candidate) => !approved.includes(candidate));
      metrics.candidates = {
        total: mining.candidates.length,
        byRisk: {
          low: mining.candidates.filter((candidate) => candidate.risk === 'low').length,
          medium: mining.candidates.filter((candidate) => candidate.risk === 'medium').length,
          high: mining.candidates.filter((candidate) => candidate.risk === 'high').length,
        },
        approved: approved.length,
        rejected: rejected.length,
      };
      if (approved.length !== 8 || rejected.length !== 2) throw new Error('reference review did not produce the expected 8 approved and 2 rejected candidates');
      active();
    });

    await recorder.run('suite_compilation', async () => {
      active();
      if (mining === null) throw new Error('candidate review did not produce a mining result');
      const approved = mining.candidates
        .filter((candidate) => GIT_GATE_E2_APPROVED_IDS.includes(candidate.candidateId as never))
        .map((candidate) => ({ ...candidate, approvalStatus: 'approved' }));
      const compiled = compileGitApprovedSuite(approved);
      const compiledIds = compiled.candidateIds as unknown as string[];
      const expectedIds = [...GIT_GATE_E2_APPROVED_IDS].sort();
      if (!sameStrings(compiledIds, expectedIds) || !sameStrings(fullSuite.approvedCandidateIds, expectedIds)) {
        throw new Error('freshly compiled candidate IDs differ from the tracked approved suite');
      }
      validateGitCompiledSuite(fullSuite);
      metrics.suite = {
        compiled: true,
        schemaVersion: fullSuite.schema,
        candidateCount: compiledIds.length,
        digest: fullSuite.suiteSha256,
      };
      active();
    });

    await recorder.run('suite_replay', async () => {
      active();
      if (workingBase === null) throw new Error('pilot working directory was not created');
      const exactSchemas = await freshSchemas(workingBase, runtime, fullSuite, metrics);
      for (const scenarioId of ['git-stage-h1', 'git-branch-h1']) {
        const scenario = gitGateE1Scenario(scenarioId);
        const trialId = `pilot-replay-${scenarioId}`;
        const outcome = await runMockSession({
          baseDirectory: workingBase,
          trialId,
          runtime,
          scenario,
          exactSchemas,
          promptDigest: promptManifest.digest,
          scenarioDigest: promptScenarioManifest.digest,
          authorizationDigest,
          systemInstructions: promptManifest.systemPrompt,
          caps,
        });
        observeExecution(outcome.result, metrics);
        metrics.mockProviderSessions += 1;
        metrics.mockProviderTurns += outcome.turns;
        const evaluation = evaluateGitCompiledSuite(fullSuite, scenario, outcome.result);
        metrics.replay.sessions += 1;
        if (evaluation.suitePassed && evaluation.goldenPassed) metrics.replay.passed += 1;
        active();
      }
      metrics.replay.suitePassed = metrics.replay.sessions === 2 && metrics.replay.passed === 2;
      if (!metrics.replay.suitePassed) throw new Error('compiled suite replay did not pass both guided holdouts');
    });

    await recorder.run('controlled_regression', async () => {
      active();
      if (workingBase === null) throw new Error('pilot working directory was not created');
      const registry = buildGitGateE2MutationRegistry(repositoryRoot);
      validateGitGateE2MutationRegistry(registry, repositoryRoot);
      if (!registry.entries.some((entry) => entry.id === PILOT_CONTROLLED_REGRESSION_ID && entry.classification === 'harmful')) {
        throw new Error('controlled regression is not present in the reviewed mutation registry');
      }
      const scenario = gitGateE2AdapterScenario(PILOT_CONTROLLED_REGRESSION_ID);
      const result = await executeGitScriptedScenario({
        baseDirectory: workingBase,
        trialId: 'pilot-controlled-regression',
        runtime,
        scenario,
      });
      observeExecution(result, metrics);
      const evaluation = evaluateGitCompiledSuite(fullSuite, scenario, result);
      const suiteDetected = !evaluation.suitePassed;
      const independentVerifierDetected = result.verifierResult.outcome !== scenario.goldenOutcome;
      metrics.controlledRegression = {
        mutationId: PILOT_CONTROLLED_REGRESSION_ID,
        detected: suiteDetected || independentVerifierDetected,
        suiteDetected,
        independentVerifierDetected,
      };
      if (!metrics.controlledRegression.detected) throw new Error('controlled regression was not detected');
      active();
    });
  } catch (error) {
    primaryFailure = error;
  }

  recorder.skipUntil('cleanup');
  try {
    await recorder.run('cleanup', async () => {
      if (workingBase === null) return;
      const residues = readdirSync(workingBase);
      cleanup.allFixtureRootsRemoved = residues.length === 0;
      cleanup.allChildProcessesExited = residues.length === 0;
      if (residues.length !== 0) {
        cleanup.emergencyCleanupUsed = true;
        rmSync(workingBase, { recursive: true, force: true });
        cleanup.workingDirectoryRemoved = !existsSync(workingBase);
        throw new Error('pilot detected process or fixture residue and used emergency cleanup');
      }
      rmSync(workingBase, { recursive: true, force: false });
      cleanup.workingDirectoryRemoved = !existsSync(workingBase);
      if (!cleanup.workingDirectoryRemoved) throw new Error('pilot working directory remains after cleanup');
    });
  } catch (cleanupError) {
    primaryFailure ??= cleanupError;
  }

  recorder.skipUntil('report_export');
  await recorder.run('report_export', async () => {});
  recorder.complete();

  const overallResult: PilotReport['overallResult'] = primaryFailure === null
    ? 'passed'
    : primaryFailure instanceof PilotCancellationError
      ? 'cancelled'
      : 'failed';
  const report = buildReport({
    repositoryRoot,
    source,
    doctor,
    stages: recorder.results,
    metrics,
    cleanup,
    overallResult,
  });
  validatePilotReport(report);
  const reportPath = join(outputDirectory, 'pilot-report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { report, reportPath };
}

async function runMockSession(options: {
  baseDirectory: string;
  trialId: string;
  runtime: GitSpikeRuntimeInspection;
  scenario: GitGateE1Scenario;
  exactSchemas: JsonObject[];
  promptDigest: string;
  scenarioDigest: string;
  authorizationDigest: string;
  systemInstructions: string;
  caps: CapEngine;
}): Promise<{ result: GitScriptedScenarioResult; turns: number }> {
  options.caps.reserveSession();
  const machine = new ModelSessionStateMachine();
  for (const phase of ['preflight', 'authorization_validation', 'source_provenance', 'scenario_loading', 'fixture_creation', 'initial_snapshot', 'target_startup', 'protocol_initialize', 'tool_discovery', 'prompt_assembly'] as const) {
    machine.transition(phase, 'provider-free pilot precondition satisfied');
  }
  const turns = await executeDeterministicMockGitTurns({
    machine,
    caps: options.caps,
    baseDirectory: options.baseDirectory,
    trialId: options.trialId,
    sessionId: options.trialId,
    runtime: options.runtime,
    scenario: options.scenario,
    exactSchemas: options.exactSchemas,
    promptDigest: options.promptDigest,
    scenarioDigest: options.scenarioDigest,
    authorizationDigest: options.authorizationDigest,
    systemInstructions: options.systemInstructions,
  });
  machine.transition('final_verification', 'independent Git verifier is authoritative');
  machine.transition('target_shutdown', 'bounded target shutdown observed');
  machine.transition('cleanup', 'fixture and process cleanup checked');
  machine.transition('evidence_finalization', 'pilot retains local evidence only');
  machine.transition('terminal', 'provider-free session complete');
  return { result: turns.result, turns: turns.responses.length };
}

async function freshSchemas(
  workingBase: string,
  runtime: GitSpikeRuntimeInspection,
  suite: GitCompiledSuiteV1,
  metrics: WorkflowMetrics,
): Promise<JsonObject[]> {
  const preflight = await executeGitScriptedScenario({
    baseDirectory: workingBase,
    trialId: 'pilot-replay-schema-preflight',
    runtime,
    scenario: gitGateE1Scenario('git-status-s1'),
  });
  observeExecution(preflight, metrics);
  if (preflight.execution.discovery?.semanticDiscoveryDigest !== suite.toolInventoryDigest) throw new Error('replay tool catalogue differs from compiled suite binding');
  return preflight.execution.discovery.tools.map((tool) => tool.raw);
}

function observeExecution(result: GitScriptedScenarioResult, metrics: WorkflowMetrics): void {
  metrics.targetSessions += 1;
  metrics.mcpToolCalls += result.execution.calls.length;
  if (!result.execution.cleanup.passed) throw new Error('fixture cleanup proof failed');
  if (!result.execution.shutdown.observed || result.execution.shutdown.childAlive || result.execution.shutdown.managedProcessGroupAlive === true || result.execution.shutdown.emergencyCleanupUsed) {
    throw new Error('target process cleanup proof failed');
  }
}

function buildReport(options: {
  repositoryRoot: string;
  source: ReturnType<typeof sourceIdentity>;
  doctor: Awaited<ReturnType<typeof runPilotDoctor>> | null;
  stages: PilotStageResult[];
  metrics: WorkflowMetrics;
  cleanup: PilotReport['cleanup'];
  overallResult: PilotReport['overallResult'];
}): PilotReport {
  const packageJson = JSON.parse(readFileSync(resolve(options.repositoryRoot, 'package.json'), 'utf8')) as { version: string };
  const osFamily = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  return {
    schemaVersion: PILOT_REPORT_SCHEMA_VERSION,
    reportToken: randomBytes(12).toString('hex'),
    overallResult: options.overallResult,
    oculory: {
      version: packageJson.version,
      commit: options.source.commit,
      worktreeState: options.source.dirty ? 'modified' : 'clean',
    },
    system: {
      osFamily,
      nodeVersion: process.version.replace(/^v/, ''),
      npmVersion: options.doctor?.versions.npm ?? 'unavailable',
      gitVersion: options.doctor?.versions.git ?? 'unavailable',
    },
    tracks: {
      guidedTrackA: { status: options.overallResult === 'passed' ? 'completed' : options.overallResult },
      readinessTrackB: { status: 'not_run', automaticIntegrationGenerated: false },
    },
    stages: options.stages,
    metrics: options.metrics,
    cleanup: options.cleanup,
    providerAccounting: {
      providerCalls: 0,
      providerNetworkCalls: 0,
      providerCredentialsRead: 0,
      providerCostMicros: 0,
      mockProviderTurns: options.metrics.mockProviderTurns,
    },
    privacy: {
      telemetryEnabled: false,
      automaticUpload: false,
      privatePathsIncluded: false,
      rawTranscriptsIncluded: false,
      rawToolPayloadsIncluded: false,
      rawEnvironmentIncluded: false,
      participantIdentityIncluded: false,
      credentialsIncluded: false,
      protectedEvidenceIncluded: false,
      manualReviewRequiredBeforeSharing: true,
    },
    participantFeedback: null,
    limitations: [
      'This report covers one pinned Git MCP target, one deterministic fixture recipe, and one controlled adapter regression.',
      'Track B is a readiness assessment only and was not run by the automated Track A command.',
      'No human pilot, production-readiness claim, security certification, Gate F1, or Gate F2 is represented.',
      'Raw local artifacts are excluded from this report and must not be shared without a separate privacy review.',
    ],
  };
}

function emptyMetrics(suite: GitCompiledSuiteV1): WorkflowMetrics {
  return {
    targetSessions: 0,
    mockProviderSessions: 0,
    mockProviderTurns: 0,
    mcpToolCalls: 0,
    toolCatalogueSize: 0,
    candidates: { total: 0, byRisk: { low: 0, medium: 0, high: 0 }, approved: 0, rejected: 0 },
    suite: { compiled: false, schemaVersion: suite.schema, candidateCount: 0, digest: suite.suiteSha256 },
    replay: { sessions: 0, passed: 0, suitePassed: false },
    controlledRegression: {
      mutationId: PILOT_CONTROLLED_REGRESSION_ID,
      detected: false,
      suiteDetected: false,
      independentVerifierDetected: false,
    },
  };
}

function loadSuite(repositoryRoot: string): GitCompiledSuiteV1 {
  const suite = JSON.parse(readFileSync(resolve(repositoryRoot, SUITE_PATH), 'utf8')) as GitCompiledSuiteV1;
  validateGitCompiledSuite(suite);
  return suite;
}

function sourceIdentity(root: string): { commit: string; dirty: boolean; sourceTreeDigest: string } {
  const commit = gitBuffer(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  const dirty = gitBuffer(root, ['status', '--porcelain=v1', '--untracked-files=all']).length > 0;
  const paths = gitBuffer(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(resolve(root, path)));
    hash.update('\0');
  }
  return { commit, dirty, sourceTreeDigest: hash.digest('hex') };
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' },
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'buffer',
  });
}

class StageRecorder {
  readonly results: PilotStageResult[] = [];

  constructor(private readonly now: () => number) {}

  async run<T>(id: PilotStageId, operation: () => Promise<T>): Promise<T> {
    const expected = PILOT_STAGE_IDS[this.results.length];
    if (expected !== id) throw new Error(`pilot stage order mismatch: expected ${String(expected)}, received ${id}`);
    const started = this.now();
    try {
      const value = await operation();
      const ended = Math.max(started, this.now());
      this.results.push(stage(id, 'passed', started, ended, null));
      return value;
    } catch (error) {
      const ended = Math.max(started, this.now());
      const cancelled = error instanceof PilotCancellationError;
      this.results.push(stage(
        id,
        cancelled ? 'cancelled' : 'failed',
        started,
        ended,
        { category: cancelled ? 'participant_cancelled' : errorCategory(error), message: sanitizePilotMessage(error) },
      ));
      throw error;
    }
  }

  skipUntil(id: PilotStageId): void {
    const target = PILOT_STAGE_IDS.indexOf(id);
    while (this.results.length < target) {
      const time = this.now();
      this.results.push(stage(PILOT_STAGE_IDS[this.results.length]!, 'skipped', time, time, null));
    }
  }

  complete(): void {
    if (this.results.length !== PILOT_STAGE_IDS.length) throw new Error('pilot report is missing required stages');
  }
}

function stage(
  id: PilotStageId,
  status: PilotStageResult['status'],
  started: number,
  ended: number,
  error: PilotStageResult['error'],
): PilotStageResult {
  return {
    id,
    status,
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
    error,
  };
}

function assertPilotActive(signal: AbortSignal | undefined, deadline: number, now: number): void {
  if (signal?.aborted === true) throw new PilotCancellationError();
  if (now > deadline) throw new Error('pilot exceeded the bounded ten-minute workflow timeout');
}

function errorCategory(error: unknown): string {
  if (error instanceof Error && /doctor/i.test(error.message)) return 'prerequisite_failure';
  if (error instanceof Error && /cleanup|residue|process/i.test(error.message)) return 'cleanup_failure';
  if (error instanceof Error && /timeout/i.test(error.message)) return 'timeout';
  if (error instanceof Error && /regression/i.test(error.message)) return 'controlled_regression_failure';
  return 'workflow_failure';
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((entry, index) => entry === [...right].sort()[index]);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
