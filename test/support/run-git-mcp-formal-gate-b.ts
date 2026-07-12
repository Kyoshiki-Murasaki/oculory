import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalJson, hashJson } from '../../src/schema/canonical.js';
import type { Json, JsonObject } from '../../src/schema/types.js';
import {
  EXPECTED_GIT_TOOL_ORDER,
  GATE_B_EXCLUDED_TOOLS,
  GIT_SPIKE_TARGET,
  inspectGitSpikeRuntime,
  type GitSpikeRuntimeInspection,
} from '../../src/targets/git-spike/config.js';
import {
  cleanupGitSpikeFixture,
  createGitSpikeFixture,
} from '../../src/targets/git-spike/fixture.js';
import {
  classifyStateDiff,
  runGitSpikeTrial,
  type GitSpikeTrialExecution,
} from '../../src/targets/git-spike/direct-harness.js';
import {
  captureGitSpikeSnapshot,
  changedIndexPaths,
  changedRefNames,
  snapshotIndexMatchesCommit,
  snapshotWorktreeMatchesCommit,
  type GitSpikeSnapshot,
  type GitSpikeSnapshotLayer,
} from '../../src/targets/git-spike/snapshot.js';
import {
  FORMAL_GATE_B_MATERIALIZATIONS,
  FORMAL_GATE_B_NORMALIZATION_ALLOWLIST,
  FORMAL_GATE_B_PLANS,
  FORMAL_GATE_B_RECIPES,
  FORMAL_GATE_B_TRIALS,
  evaluateFormalGateB,
  recipe,
  semanticSnapshotSignature,
  type FormalGateBMaterializationSummary,
  type FormalGateBPlanDefinition,
  type FormalGateBTrialSummary,
} from '../../src/targets/git-spike/formal-gate-b.js';
import {
  GATE_B_EVIDENCE_SCHEMA,
  GATE_B_RUNNER_VERSION,
  GateBEvidenceStore,
  GateBTrialRecorder,
  aggregateFailureEntry,
  persistTerminalRecord,
  type GateBAttemptManifest,
  type GateBTerminalOutcome,
} from '../../src/targets/git-spike/gate-b-evidence.js';

interface Arguments {
  pythonExecutable: string;
  targetExecutable: string;
  gitExecutable: string;
  lockPath: string;
  outputDirectory: string;
  attemptId: string;
  predecessorAttemptId: string;
  materializations: number;
  trials: number;
}

interface MaterializationEvidence extends FormalGateBMaterializationSummary {
  snapshot: GitSpikeSnapshot;
  cleanup: ReturnType<typeof cleanupGitSpikeFixture>;
  expectedStateHash: string;
  expectedSemanticSignature: string;
  semanticLayersEqualExpected: boolean;
  differences: DifferenceFinding[];
}

interface DifferenceFinding {
  field: string;
  classification: 'semantic' | 'presentation-only' | 'environment-derived' | 'unexplained';
  detail: string;
}

interface TrialEvidence {
  elapsedMs: number;
  execution: GitSpikeTrialExecution;
  summary: FormalGateBTrialSummary;
  targetedOracle: JsonObject;
  differences: DifferenceFinding[];
}

interface LockedDistribution {
  name: string;
  canonicalName: string;
  version: string;
  wheelHashes: string[];
}

interface FormalGateBReport {
  schema: 'oculory-git-formal-gate-b-temporary-v1';
  generatedAt: string;
  oculorySource: { head: string; dirty: boolean; sourceTreeDigest: string };
  host: { os: string; osRelease: string; architecture: string; nodeVersion: string };
  target: typeof GIT_SPIKE_TARGET;
  runtime: GitSpikeRuntimeInspection & {
    executableSha256: string;
    lockPath: string;
    lockFileSha256: string;
    uvVersion: string;
    lockedDistributions: LockedDistribution[];
    resolvedDistributionCount: number;
    lockDrift: boolean;
    lockDriftReasons: string[];
    lockContainsLocalPath: boolean;
    wheelHashBoundInLock: boolean;
    environmentIsolation: {
      userSiteDisabled: true;
      safePathEnabled: true;
      credentialsInherited: false;
      userGitConfigurationInherited: false;
    };
  };
  normalizationRules: Array<{ field: string; classification: 'presentation-only' | 'environment-derived'; justification: string }>;
  requestedMaterializationsPerRecipe: number;
  requestedTrialsPerPlan: number;
  uniqueFixtureRecipes: Array<Omit<(typeof FORMAL_GATE_B_RECIPES)[number], 'prepare'>>;
  directPlanDefinitions: Array<Omit<(typeof FORMAL_GATE_B_PLANS)[number], 'trialPlan'>>;
  materializations: MaterializationEvidence[];
  directTrials: TrialEvidence[];
  aggregate: ReturnType<typeof evaluateFormalGateB> & {
    totalMaterializations: number;
    totalDirectSessions: number;
    parentClean: boolean;
    elapsedMs: number;
    diagnosticReruns: number;
    rawEvidenceRetained: boolean;
    unexplainedDifferences: DifferenceFinding[];
    attemptFailures: Array<{ kind: string; message: string; evidenceDigest: string }>;
  };
  toolCoverageMatrix: Array<{
    tool: string;
    directPlans: string[];
    callPositions: number[];
    trialCount: number;
    resultClasses: string[];
    targetedIndependentOracle: string[];
    stableSchemaDigests: string[];
  }>;
  objectiveClassMatrix: Array<{
    objectiveClass: string;
    directPlans: string[];
    trialCount: number;
  }>;
  formalGateBDecision: 'passed' | 'failed' | 'inconclusive';
  reportSha256?: string;
}

const NORMALIZATION_RULES: FormalGateBReport['normalizationRules'] = [
  { field: 'fixture_root', classification: 'environment-derived', justification: 'Each trial requires a fresh absolute primary repository root; raw frame digests retain it and semantic comparisons replace only that registered root.' },
  { field: 'sibling_root', classification: 'environment-derived', justification: 'Each trial requires a fresh registered sibling boundary root; raw frame digests retain it and semantic comparisons replace only that root.' },
  { field: 'trial_root', classification: 'environment-derived', justification: 'HOME, XDG, TMP, hooks, and Git configuration paths are deliberately trial-local and are tokenized only after containment is proven.' },
  { field: 'monotonic_timing', classification: 'environment-derived', justification: 'Elapsed and transcript monotonic offsets are diagnostic; ordering and bounded deadlines remain semantic.' },
  { field: 'reflog_timestamp_timezone', classification: 'presentation-only', justification: 'The snapshot preserves old/new OIDs, ref, actor, and action while raw reflog digests retain timestamp/timezone presentation, as documented in docs/32 and docs/34.' },
  { field: 'sentinel_mtime', classification: 'environment-derived', justification: 'Fresh sentinel creation time differs; byte length, digest, mode, repository state, and raw metadata digest remain retained and checked.' },
  { field: 'gitpython_tzoffset_object', classification: 'presentation-only', justification: 'git_show prose includes a per-process Python object address; only that address is replaced while raw response/frame digests and all revision semantics are retained, as documented in docs/34.' },
];

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const overallStart = process.hrtime.bigint();
  const lockBytes = readFileSync(args.lockPath);
  const lockText = lockBytes.toString('utf8');
  const lockFileSha256 = digest(lockBytes);
  if (lockFileSha256 !== GIT_SPIKE_TARGET.lockSha256) {
    throw new Error(`lock digest mismatch: expected ${GIT_SPIKE_TARGET.lockSha256}, observed ${lockFileSha256}`);
  }
  const runtime = inspectGitSpikeRuntime({
    pythonExecutable: args.pythonExecutable,
    targetExecutable: args.targetExecutable,
    gitExecutable: args.gitExecutable,
    lockSha256: lockFileSha256,
  });
  const uvExecutable = findExecutableOnPath('uv');
  const uvVersion = execFileSync(uvExecutable, ['--version'], {
    encoding: 'utf8',
    env: minimalCommandEnv(runtime.gitExecutable),
    timeout: 5_000,
  }).trim();
  const lockedDistributions = parseLockedDistributions(lockText);
  const lockDriftReasons = assessLockDrift(runtime, lockedDistributions);
  const targetLock = lockedDistributions.find((entry) => entry.canonicalName === canonicalPackageName(GIT_SPIKE_TARGET.packageName));
  const wheelHashBoundInLock = targetLock?.wheelHashes.includes(GIT_SPIKE_TARGET.wheelSha256) === true;
  if (!wheelHashBoundInLock) lockDriftReasons.push('target wheel hash is not bound in the committed lock');
  if (lockedDistributions.length !== 33) lockDriftReasons.push(`expected 33 locked distributions, observed ${lockedDistributions.length}`);
  const lockContainsLocalPath = /(?:file:|\/Users\/|\/private\/|\/tmp\/)/.test(lockText);
  if (lockContainsLocalPath) lockDriftReasons.push('lock contains a local machine path');
  if (lockDriftReasons.length > 0) throw new Error(`runtime/lock drift: ${lockDriftReasons.join('; ')}`);

  const source = readOculorySourceState(runtime.gitExecutable);
  const runtimeEvidence: JsonObject = {
    ...runtime as unknown as JsonObject,
    executableSha256: digest(readFileSync(runtime.targetExecutable)),
    lockPath: '<COMMITTED_LOCK>',
    lockFileSha256,
    uvVersion,
    lockedDistributionCount: lockedDistributions.length,
    resolvedDistributionCount: Object.keys(runtime.distributions).length,
    lockDrift: false,
    lockContainsLocalPath,
    wheelHashBoundInLock,
    credentialsInherited: false,
    userGitConfigurationInherited: false,
  };
  const manifest: GateBAttemptManifest = {
    schema: GATE_B_EVIDENCE_SCHEMA,
    runnerVersion: GATE_B_RUNNER_VERSION,
    attemptId: args.attemptId,
    predecessorFailedAttemptId: args.predecessorAttemptId,
    source: source as unknown as JsonObject,
    runtime: runtimeEvidence,
    thresholds: {
      materializationsPerRecipe: args.materializations,
      trialsPerPlan: args.trials,
      recipes: FORMAL_GATE_B_RECIPES.map((definition) => definition.id),
      plans: FORMAL_GATE_B_PLANS.map((definition) => definition.name),
    },
    startedAt: new Date().toISOString(),
    completionStatus: 'running',
  };
  const store = new GateBEvidenceStore(args.outputDirectory);
  store.initialize(manifest);
  const baseDirectory = mkdtempSync(join(tmpdir(), 'oculory-git-formal-gate-b-'));
  const materializations: MaterializationEvidence[] = [];
  const directTrials: TrialEvidence[] = [];
  let parentClean = false;
  const expectedTrialIds: string[] = [];

  try {
    for (const definition of FORMAL_GATE_B_RECIPES) {
      for (let index = 1; index <= args.materializations; index += 1) {
        const trialId = `materialization-${definition.id}-${String(index).padStart(2, '0')}`;
        expectedTrialIds.push(trialId);
        const recorder = new GateBTrialRecorder({
          attemptId: args.attemptId,
          parentCanonicalAttemptId: args.predecessorAttemptId,
          trialId,
          kind: 'materialization',
          subjectId: definition.id,
          trialIndex: index,
          targetRuntimeProvenance: runtimeEvidence,
        });
        let outcome: GateBTerminalOutcome = 'failed_execution';
        try {
          const evidence = runMaterialization(baseDirectory, runtime.gitExecutable, definition.id, index);
          materializations.push(evidence);
          recorder.setFixturePathToken('<FIXTURE_ROOT>');
          recorder.complete('fixture_created');
          recorder.setLatestSnapshot(evidence.snapshot as unknown as JsonObject);
          recorder.setJournals([{ stage: 'initial_snapshot', snapshot: evidence.snapshot } as unknown as Json]);
          recorder.complete('initial_snapshot_captured');
          applyCleanupToRecorder(recorder, evidence.cleanup);
          recorder.setSemanticSummary(evidence as unknown as JsonObject);
          if (!evidence.semanticLayersEqualExpected) recorder.fail('oracle', 'materialization_oracle', new Error('materialization semantic state differs'));
          if (!evidence.cleanup.passed) recordCleanupFailures(recorder, evidence.cleanup);
          outcome = evidence.semanticLayersEqualExpected && evidence.cleanup.passed ? 'passed' :
            evidence.cleanup.passed ? 'failed_oracle' : 'failed_cleanup';
        } catch (error) {
          recorder.fail('fixture_creation', 'fixture_creation_or_initial_snapshot', error);
          const path = join(baseDirectory, `materialize-${definition.id}-${String(index).padStart(2, '0')}`);
          recorder.cleanupStep({ step: 'emergency_fixture_removal', attempted: true, passed: removePath(path), detail: null, failureClass: 'fixture_removal' });
          recorder.setFixturePresence(existsSync(path));
        }
        persistTerminalRecord(store, recorder, outcome);
      }
      process.stdout.write(`${JSON.stringify({ progress: 'materializations_complete', recipe: definition.id, count: args.materializations })}\n`);
    }
    for (const definition of FORMAL_GATE_B_PLANS) {
      for (let index = 1; index <= args.trials; index += 1) {
        const start = process.hrtime.bigint();
        const trialId = `direct-${definition.name}-${String(index).padStart(2, '0')}`;
        expectedTrialIds.push(trialId);
        const recorder = new GateBTrialRecorder({
          attemptId: args.attemptId,
          parentCanonicalAttemptId: args.predecessorAttemptId,
          trialId,
          kind: 'direct',
          subjectId: definition.name,
          trialIndex: index,
          targetRuntimeProvenance: runtimeEvidence,
        });
        let outcome: GateBTerminalOutcome = 'failed_execution';
        try {
          const execution = await runGitSpikeTrial({ baseDirectory, trialId, runtime, plan: definition.trialPlan });
          const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
          populateDirectRecorder(recorder, execution);
          if (!execution.cleanup.passed) recordCleanupFailures(recorder, execution.cleanup);
          const assessed = assessTrial(definition, execution, index, elapsedMs);
          directTrials.push(assessed);
          recorder.setSemanticSummary({
            elapsedMs,
            summary: assessed.summary as unknown as Json,
            targetedOracle: assessed.targetedOracle,
            differences: assessed.differences as unknown as Json,
            initialization: execution.initialization as unknown as Json,
            discovery: execution.discovery as unknown as Json,
            transcript: execution.transcript as unknown as Json,
            shutdown: execution.shutdown as unknown as Json,
            cleanup: execution.cleanup as unknown as Json,
          });
          if (!assessed.summary.passed && execution.cleanup.passed) recorder.fail('oracle', 'direct_trial_assessment', new Error(assessed.summary.reasons.join('; ')));
          outcome = assessed.summary.passed && execution.cleanup.passed ? 'passed' :
            execution.cleanup.passed ? 'failed_oracle' : 'failed_cleanup';
        } catch (error) {
          recorder.fail('fixture_creation', 'direct_trial_setup_or_execution', error);
          const path = join(baseDirectory, trialId);
          recorder.cleanupStep({ step: 'emergency_fixture_removal', attempted: true, passed: removePath(path), detail: null, failureClass: 'fixture_removal' });
          recorder.setFixturePresence(existsSync(path));
        }
        persistTerminalRecord(store, recorder, outcome);
      }
      process.stdout.write(`${JSON.stringify({ progress: 'direct_plan_complete', plan: definition.name, completed: directTrials.filter((trial) => trial.summary.planName === definition.name).length, requested: args.trials })}\n`);
    }
    parentClean = readdirSync(baseDirectory).length === 0;

    const evaluation = evaluateFormalGateB(
      materializations,
      directTrials.map((entry) => entry.summary),
      args.materializations,
      args.trials,
    );
    if (!parentClean) evaluation.reasons.push('formal-run temporary parent retained residue');
    const unexplainedDifferences = [
      ...materializations.flatMap((entry) => entry.differences),
      ...directTrials.flatMap((entry) => entry.differences),
    ].filter((entry) => entry.classification === 'unexplained');
    if (unexplainedDifferences.length > 0) evaluation.reasons.push('unexplained semantic differences remain');
    const rawEvidenceRetained =
      materializations.every((entry) => entry.rawEvidenceRetained) &&
      directTrials.every((entry) => entry.summary.rawEvidenceRetained);
    if (!rawEvidenceRetained) evaluation.reasons.push('raw evidence retention requirement failed');
    const decision = evaluation.reasons.length === 0 && evaluation.passed && parentClean
      ? 'passed'
      : 'failed';
    const elapsedMs = Number(process.hrtime.bigint() - overallStart) / 1_000_000;
    const aggregate = store.compileAggregate(expectedTrialIds);
    aggregate.semanticEvaluation = {
      evaluation: evaluation as unknown as Json,
      parentClean,
      elapsedMs,
      rawEvidenceRetained,
      unexplainedDifferences: unexplainedDifferences as unknown as Json,
      toolCoverageMatrix: buildToolCoverageMatrix(directTrials) as unknown as Json,
      normalizationRules: NORMALIZATION_RULES as unknown as Json,
    };
    if (decision !== 'passed') aggregate.decision = 'failed';
    manifest.completionStatus = aggregate.decision;
    try {
      store.updateAttempt(manifest);
      store.writeAggregate(aggregate);
    } catch (error) {
      store.writeAggregateFailure(aggregate, aggregateFailureEntry(error));
      manifest.completionStatus = 'failed';
      try { store.updateAttempt(manifest); } catch { /* aggregate.failed.json remains authoritative */ }
      throw error;
    }
    process.stdout.write(`${JSON.stringify({
      formal_gate_b_decision: aggregate.decision,
      attempt_id: args.attemptId,
      unique_recipes: FORMAL_GATE_B_RECIPES.length,
      materializations: materializations.length,
      direct_sessions: directTrials.length,
      elapsed_ms: elapsedMs,
      diagnostic_reruns: 0,
      output_directory: args.outputDirectory,
      terminal_records: aggregate.actualTerminalRecords,
    })}\n`);
    if (aggregate.decision !== 'passed') process.exitCode = 1;
  } finally {
    rmSync(baseDirectory, { recursive: true, force: true });
  }
}

function populateDirectRecorder(recorder: GateBTrialRecorder, execution: GitSpikeTrialExecution): void {
  recorder.setFixturePathToken('<FIXTURE_ROOT>');
  recorder.complete('fixture_created');
  const initial = snapshot(execution, 'before_server_start');
  if (initial !== null) {
    recorder.setLatestSnapshot(initial as unknown as JsonObject);
    recorder.complete('initial_snapshot_captured');
  }
  recorder.setProcess({
    applicable: true,
    pid: execution.processStart?.pid ?? null,
    started: execution.processStart !== null,
    exited: execution.shutdown.observed && !execution.shutdown.childAlive,
    exitCode: execution.shutdown.exitCode,
    signal: execution.shutdown.signal,
    childAlive: execution.shutdown.childAlive,
    processGroupManaged: execution.processStart?.processGroupManaged ?? null,
    processGroupAlive: execution.shutdown.managedProcessGroupAlive,
    allRequestsSettled: execution.shutdown.allRequestsSettled,
  });
  if (execution.processStart !== null) recorder.complete('target_started');
  if (execution.initialization !== null) recorder.complete('initialized');
  if (execution.discovery !== null) recorder.complete('tools_list_completed');
  if (execution.calls.length > 0) recorder.complete('tool_call_completed');
  recorder.setCalls(execution.calls as unknown as Json[]);
  recorder.setJournals(execution.journal as unknown as Json[]);
  const latest = execution.journal.at(-1)?.snapshot;
  if (latest !== undefined) {
    recorder.setLatestSnapshot(latest as unknown as JsonObject);
    recorder.complete('post_call_snapshot_captured');
  }
  if (execution.shutdown.observed) recorder.complete('target_shutdown_completed');
  if (!execution.shutdown.childAlive && execution.shutdown.managedProcessGroupAlive !== true) {
    recorder.complete('process_group_verified');
  }
  applyCleanupToRecorder(recorder, execution.cleanup);
  for (const message of execution.errors) {
    if (message === 'fixture cleanup proof failed') continue;
    recorder.fail(classifyHarnessFailure(execution), 'direct_harness', new Error(message));
  }
}

function applyCleanupToRecorder(
  recorder: GateBTrialRecorder,
  cleanup: ReturnType<typeof cleanupGitSpikeFixture>,
): void {
  for (const step of cleanup.steps) {
    recorder.cleanupStep({
      step: step.name,
      attempted: step.attempted,
      passed: step.passed,
      detail: step.detail,
      failureClass: cleanupFailureClass(step.name),
    });
  }
  const sentinel = cleanup.sentinelUnchangedBeforeRepositoryRemoval && cleanup.sentinelUnchangedAfterRepositoryRemoval;
  recorder.setSentinelUnchanged(sentinel);
  if (sentinel) recorder.complete('sentinel_verified');
  recorder.setFixturePresence(!cleanup.trialRootRemoved);
  if (cleanup.repositoryRemoved) recorder.complete('fixture_removed');
  if (cleanup.trialRootRemoved && !cleanup.parentContainsTrialName) recorder.complete('post_removal_absence_verified');
}

function recordCleanupFailures(
  recorder: GateBTrialRecorder,
  cleanup: ReturnType<typeof cleanupGitSpikeFixture>,
): void {
  for (const failure of cleanup.failures) {
    recorder.fail(
      cleanupFailureClass(failure.step),
      failure.step,
      new Error(failure.message),
      failure.timedOut ? failure.timeoutMs : null,
    );
  }
}

function cleanupFailureClass(step: string):
  | 'process_group_verification'
  | 'sentinel_verification'
  | 'fixture_removal'
  | 'post_removal_absence_check' {
  if (step.includes('sentinel')) return 'sentinel_verification';
  if (step.includes('parent_absence') || step.includes('absence_check')) return 'post_removal_absence_check';
  if (step.includes('process')) return 'process_group_verification';
  return 'fixture_removal';
}

function classifyHarnessFailure(execution: GitSpikeTrialExecution):
  | 'target_startup'
  | 'initialize'
  | 'tools_list'
  | 'tools_call'
  | 'post_call_snapshot'
  | 'target_shutdown'
  | 'unexpected_exception' {
  if (execution.processStart === null) return 'target_startup';
  if (execution.initialization === null) return 'initialize';
  if (execution.discovery === null) return 'tools_list';
  if (!execution.shutdown.observed) return 'target_shutdown';
  if (execution.errors.some((message) => message.includes('snapshot'))) return 'post_call_snapshot';
  if (execution.calls.some((call) => call.outcomeClass === 'client_failure')) return 'tools_call';
  return 'unexpected_exception';
}

function removePath(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return !existsSync(path);
  } catch {
    return false;
  }
}

function runMaterialization(
  baseDirectory: string,
  gitExecutable: string,
  recipeId: string,
  index: number,
): MaterializationEvidence {
  const definition = recipe(recipeId);
  const fixture = createGitSpikeFixture({
    baseDirectory,
    trialId: `materialize-${recipeId}-${String(index).padStart(2, '0')}`,
    gitExecutable,
  });
  try {
    definition.prepare(fixture);
    const snapshot = captureGitSpikeSnapshot(fixture);
    const semanticSignature = semanticSnapshotSignature(snapshot);
    const differences: DifferenceFinding[] = [];
    if (snapshot.stateHash !== definition.expectedInitialHash) {
      differences.push({ field: 'state_hash', classification: 'semantic', detail: `expected ${definition.expectedInitialHash}, observed ${snapshot.stateHash}` });
    }
    if (semanticSignature !== definition.expectedSemanticSignature) {
      differences.push({ field: 'semantic_snapshot_signature', classification: 'semantic', detail: `expected ${definition.expectedSemanticSignature}, observed ${semanticSignature}` });
    }
    if (snapshot.rawEvidence.reflogsSha256.length > 0) {
      differences.push({ field: 'raw_reflog_digest_across_fresh_roots', classification: 'presentation-only', detail: 'Raw reflog timestamps/timezones are retained; semantic transitions are compared separately.' });
    }
    const sentinelBefore = snapshot.siblingBoundary.sentinel;
    const cleanup = cleanupGitSpikeFixture(fixture, {
      closeObserved: true,
      allRequestsSettled: true,
      childAlive: false,
      managedProcessGroupAlive: false,
      emergencyCleanupUsed: false,
    });
    return {
      recipeId,
      materializationIndex: index,
      stateHash: snapshot.stateHash,
      semanticSignature,
      cleanupPassed: cleanup.passed,
      sentinelPassed: cleanup.sentinelUnchangedBeforeRepositoryRemoval && cleanup.sentinelUnchangedAfterRepositoryRemoval,
      rawEvidenceRetained: Object.values(snapshot.rawEvidence).every((value) => value.length === 64),
      normalizedFields: ['fixture_root', 'sibling_root', 'trial_root', 'reflog_timestamp_timezone', 'sentinel_mtime'],
      snapshot,
      cleanup,
      expectedStateHash: definition.expectedInitialHash,
      expectedSemanticSignature: definition.expectedSemanticSignature,
      semanticLayersEqualExpected: snapshot.stateHash === definition.expectedInitialHash && semanticSignature === definition.expectedSemanticSignature,
      differences,
    };
  } catch (error) {
    if (readdirSync(fixture.baseDirectory).includes(fixture.id)) rmSync(fixture.trialRoot, { recursive: true, force: true });
    throw error;
  }
}

function assessTrial(
  definition: FormalGateBPlanDefinition,
  execution: GitSpikeTrialExecution,
  trialIndex: number,
  elapsedMs: number,
): TrialEvidence {
  const reasons: string[] = [];
  const initial = snapshot(execution, 'before_server_start');
  const final = snapshot(execution, 'after_final_response');
  require(initial !== null, 'before_server_start snapshot missing', reasons);
  require(final !== null, 'after_final_response snapshot missing', reasons);
  const recipeDefinition = recipe(definition.recipeId);
  if (initial !== null) {
    require(initial.stateHash === recipeDefinition.expectedInitialHash, 'registered initial state hash differs', reasons);
    require(semanticSnapshotSignature(initial) === recipeDefinition.expectedSemanticSignature, 'registered semantic snapshot signature differs', reasons);
    require(initial.symbolicBranch === recipeDefinition.expectedCurrentBranch, 'initial symbolic branch differs', reasons);
    require(initial.headObjectId === recipeDefinition.expectedHead, 'initial HEAD differs', reasons);
    require(canonicalJson(Object.fromEntries(initial.refs.map((entry) => [entry.name, entry.objectId])) as JsonObject) === canonicalJson(recipeDefinition.expectedRefs as JsonObject), 'initial refs differ', reasons);
  }
  require(execution.errors.length === 0, `harness errors: ${execution.errors.join('; ')}`, reasons);
  require(execution.initialization?.requestedProtocolVersion === GIT_SPIKE_TARGET.requestedProtocolVersion, 'requested protocol differs', reasons);
  require(execution.initialization?.negotiatedProtocolVersion === GIT_SPIKE_TARGET.requestedProtocolVersion, 'negotiated protocol differs', reasons);
  require(execution.discovery?.pageCount === 1, 'discovery page count differs', reasons);
  require(canonicalJson(execution.discovery?.toolNames ?? []) === canonicalJson([...EXPECTED_GIT_TOOL_ORDER]), 'complete 12-tool inventory differs', reasons);
  require(execution.transcript.unexpectedStdout === false, 'unexpected stdout observed', reasons);
  require(execution.transcript.stderrByteCount === 0, 'stderr was not empty', reasons);
  const protocolFindings = execution.transcript.events.filter((event) =>
    ['malformed_json', 'invalid_jsonrpc', 'stdout_contamination', 'limit_exceeded', 'client_failure'].includes(String(event.kind)),
  );
  require(protocolFindings.length === 0, 'protocol finding observed', reasons);
  require(responseIdsValid(execution), 'unmatched or duplicate response ID observed', reasons);
  require(execution.shutdown.observed && execution.shutdown.graceful, 'shutdown was not observed and graceful', reasons);
  require(execution.shutdown.escalation === 'none', 'shutdown escalated', reasons);
  require(execution.shutdown.exitCode === 0 && execution.shutdown.signal === null, 'process did not exit code 0 without signal', reasons);
  require(!execution.shutdown.childAlive && execution.shutdown.managedProcessGroupAlive !== true, 'process or managed group remained alive', reasons);
  require(execution.shutdown.allRequestsSettled, 'request remained unsettled', reasons);
  require(!execution.shutdown.emergencyCleanupUsed, 'emergency cleanup was used', reasons);
  require(execution.cleanup.passed, 'cleanup proof failed', reasons);
  require(execution.cleanup.sentinelUnchangedBeforeRepositoryRemoval && execution.cleanup.sentinelUnchangedAfterRepositoryRemoval, 'sentinel proof failed', reasons);

  for (const [beforeStage, afterStage, label] of [
    ['before_server_start', 'after_server_start_and_initialize', 'startup/initialize'],
    ['after_server_start_and_initialize', 'after_tool_discovery', 'discovery'],
    ['after_final_response', 'after_server_shutdown', 'shutdown'],
    ['after_server_shutdown', 'before_cleanup', 'pre-cleanup'],
  ] as const) {
    const before = snapshot(execution, beforeStage);
    const after = snapshot(execution, afterStage);
    require(before !== null && after !== null && before.stateHash === after.stateHash, `${label} changed repository state`, reasons);
  }

  require(canonicalJson(execution.calls.map((call) => call.tool)) === canonicalJson(definition.toolSequence as unknown as Json), 'tool sequence differs', reasons);
  require(canonicalJson(execution.calls.map((call) => call.outcomeClass)) === canonicalJson(definition.expectedResultClasses as unknown as Json), 'result classes differ', reasons);
  const unexpectedChangedLayers: string[] = [];
  execution.calls.forEach((call, index) => {
    const expected = definition.expectedChangedLayers[index];
    if (expected === undefined) {
      unexpectedChangedLayers.push(...call.stateDiff.changedLayers);
      return;
    }
    const expectedClass = expected === 'unchanged' ? 'unchanged' : 'expected_delta';
    if (classifyStateDiff(call.stateDiff, expected) !== expectedClass ||
        (expected !== 'unchanged' && !sameSet(call.stateDiff.changedLayers, expected))) {
      unexpectedChangedLayers.push(...call.stateDiff.changedLayers);
      reasons.push(`call ${index} ${call.tool} changed unexpected layers`);
    }
    require(call.inputSchemaDigest.length === 64, `call ${index} lost schema digest`, reasons);
    require(call.rawResponseDigest !== null && call.responseRawLineDigest !== null && call.requestRawLineDigest !== null, `call ${index} lost raw response/frame evidence`, reasons);
    require(Object.keys(call.rawOutcome).length > 0, `call ${index} lost structured outcome evidence`, reasons);
  });
  require(final?.stateHash === definition.expectedFinalHash, 'final canonical state hash differs from registered expectation', reasons);
  if (initial !== null && final !== null) {
    require(canonicalJson(initial.siblingBoundary as unknown as Json) === canonicalJson(final.siblingBoundary as unknown as Json), 'sibling boundary state changed', reasons);
  }

  const targeted = targetedOracle(definition, execution, reasons);
  const unchangedState = initial !== null && final !== null && initial.stateHash === final.stateHash && execution.calls.every((call) => call.stateDiff.changedLayers.length === 0);
  const normalizedFields = [
    'fixture_root', 'sibling_root', 'trial_root', 'monotonic_timing',
    'reflog_timestamp_timezone', 'sentinel_mtime',
    ...(definition.name === 'read_only' ? ['gitpython_tzoffset_object'] : []),
  ];
  const rawEvidenceRetained =
    execution.transcript.digest.length === 64 && execution.transcript.semanticDigest.length === 64 &&
    execution.transcript.events.length > 0 &&
    execution.calls.every((call) => call.rawResponseDigest !== null && call.requestRawLineDigest !== null && call.responseRawLineDigest !== null);
  require(rawEvidenceRetained, 'raw evidence retention requirement failed', reasons);
  const summary: FormalGateBTrialSummary = {
    planName: definition.name,
    trialIndex,
    initialStateHash: initial?.stateHash ?? '<missing>',
    requestedProtocol: execution.initialization?.requestedProtocolVersion ?? '<missing>',
    negotiatedProtocol: execution.initialization?.negotiatedProtocolVersion ?? '<missing>',
    serverInfoDigest: hashJson(execution.initialization?.serverInfo ?? null),
    capabilitiesDigest: hashJson(execution.initialization?.capabilities ?? null),
    inventoryDigest: hashJson((execution.discovery?.toolNames ?? []) as unknown as Json),
    discoveryDigest: execution.discovery?.semanticDiscoveryDigest ?? '<missing>',
    schemaDigestsDigest: hashJson((execution.discovery?.tools.map((tool) => ({ name: tool.name, digest: tool.semanticDigest })) ?? []) as unknown as Json),
    resultClasses: execution.calls.map((call) => call.outcomeClass),
    targetedStateDigest: hashJson(targeted),
    finalStateHash: final?.stateHash ?? '<missing>',
    unchangedState,
    unexpectedChangedLayers: [...new Set(unexpectedChangedLayers)].sort(),
    shutdownPassed: execution.shutdown.observed && execution.shutdown.graceful && execution.shutdown.escalation === 'none' && execution.shutdown.exitCode === 0 && execution.shutdown.signal === null && !execution.shutdown.childAlive && execution.shutdown.managedProcessGroupAlive !== true && execution.shutdown.allRequestsSettled && !execution.shutdown.emergencyCleanupUsed,
    cleanupPassed: execution.cleanup.passed,
    sentinelPassed: execution.cleanup.sentinelUnchangedBeforeRepositoryRemoval && execution.cleanup.sentinelUnchangedAfterRepositoryRemoval,
    rawEvidenceRetained,
    normalizedFields,
    toolsCalled: execution.calls.map((call) => call.tool),
    passed: reasons.length === 0,
    reasons,
  };
  const differences: DifferenceFinding[] = [
    { field: 'elapsed_ms', classification: 'environment-derived', detail: 'Wall-clock duration is diagnostic only.' },
    { field: 'raw_transcript_digest', classification: 'environment-derived', detail: 'Raw frame digests retain fresh absolute roots; tokenized semantic transcript content is compared separately.' },
  ];
  if (definition.name === 'read_only') {
    differences.push({ field: 'gitpython_tzoffset_object_address', classification: 'presentation-only', detail: 'Only the documented per-process GitPython timezone object address is normalized in semantic output.' });
  }
  return { elapsedMs, execution, summary, targetedOracle: targeted, differences };
}

function targetedOracle(definition: FormalGateBPlanDefinition, execution: GitSpikeTrialExecution, reasons: string[]): JsonObject {
  const initial = snapshot(execution, 'before_server_start');
  const final = snapshot(execution, 'after_final_response');
  if (initial === null || final === null) return { missing: true };
  switch (definition.name) {
    case 'read_only':
      require(execution.calls.every((call) => call.stateDiff.changedLayers.length === 0), 'read-only call changed state', reasons);
      require(final.commits.length === 2 && final.headObjectId === execution.fixture.mainHead, 'known history/HEAD oracle failed', reasons);
      return { unchanged: initial.stateHash === final.stateHash, head: final.headObjectId, commits: final.commits.map((commit) => ({ id: commit.objectId, parents: commit.parents, tree: commit.treeId, message: commit.message })) as unknown as Json };
    case 'stage': {
      const call = execution.calls[1];
      const before = call === undefined ? undefined : execution.journal[call.beforeSnapshotIndex]?.snapshot;
      const after = call === undefined ? undefined : execution.journal[call.afterSnapshotIndex]?.snapshot;
      if (before === undefined || after === undefined) return { missing: true };
      const changedPaths = changedIndexPaths(before, after);
      const index = after.index.find((entry) => entry.path === 'README.md' && entry.stage === 0);
      const file = after.worktree.find((entry) => entry.path === 'README.md' && entry.type === 'file');
      require(canonicalJson(changedPaths) === canonicalJson(['README.md']), 'stage changed unexpected index path', reasons);
      require(index?.blobSha256 === file?.sha256, 'stage index blob differs from worktree bytes', reasons);
      require(before.layerHashes.worktree === after.layerHashes.worktree && before.headObjectId === after.headObjectId && changedRefNames(before, after).length === 0, 'stage changed worktree, HEAD, or refs', reasons);
      return { changed_paths: changedPaths, index_blob: index?.blobSha256 ?? null, worktree_blob: file?.sha256 ?? null, head: after.headObjectId, refs: after.refs as unknown as Json };
    }
    case 'reset': {
      const call = execution.calls[1];
      const before = call === undefined ? undefined : execution.journal[call.beforeSnapshotIndex]?.snapshot;
      const after = call === undefined ? undefined : execution.journal[call.afterSnapshotIndex]?.snapshot;
      if (before === undefined || after === undefined) return { missing: true };
      const changedPaths = changedIndexPaths(before, after);
      const beforeFile = before.worktree.find((entry) => entry.path === 'docs/rollback.md' && entry.type === 'file');
      const afterFile = after.worktree.find((entry) => entry.path === 'docs/rollback.md' && entry.type === 'file');
      require(canonicalJson(changedPaths) === canonicalJson(['docs/rollback.md']), 'reset changed unexpected index path', reasons);
      require(after.indexMatchesHead && snapshotIndexMatchesCommit(after, after.headObjectId), 'reset index does not match HEAD', reasons);
      require(beforeFile?.sha256 === afterFile?.sha256, 'reset changed edited worktree bytes', reasons);
      return { changed_paths: changedPaths, index_matches_head: after.indexMatchesHead, edited_worktree_blob: afterFile?.sha256 ?? null, head: after.headObjectId };
    }
    case 'branch_create': {
      const changedRefs = changedRefNames(initial, final);
      const created = final.refs.find((entry) => entry.name === 'refs/heads/feature/parser');
      require(canonicalJson(changedRefs) === canonicalJson(['refs/heads/feature/parser']), 'branch create changed unexpected refs', reasons);
      require(created?.objectId === execution.fixture.mainHead && final.symbolicBranch === 'main', 'branch create target or current branch differs', reasons);
      require(initial.layerHashes.worktree === final.layerHashes.worktree && initial.layerHashes.index === final.layerHashes.index, 'branch create changed worktree/index', reasons);
      return { changed_refs: changedRefs, created_target: created?.objectId ?? null, symbolic_branch: final.symbolicBranch, head: final.headObjectId };
    }
    case 'checkout': {
      require(changedRefNames(initial, final).length === 0, 'checkout changed ref targets', reasons);
      require(final.symbolicBranch === 'feature/seed' && final.headObjectId === execution.fixture.featureSeedHead, 'checkout selected wrong branch/commit', reasons);
      require(snapshotIndexMatchesCommit(final, execution.fixture.featureSeedHead) && snapshotWorktreeMatchesCommit(final, execution.fixture.featureSeedHead), 'checkout index/worktree does not match feature tree', reasons);
      require(initial.layerHashes.objects === final.layerHashes.objects, 'checkout changed object inventory', reasons);
      return { symbolic_branch: final.symbolicBranch, head: final.headObjectId, refs: final.refs as unknown as Json, index_matches: snapshotIndexMatchesCommit(final, execution.fixture.featureSeedHead), worktree_matches: snapshotWorktreeMatchesCommit(final, execution.fixture.featureSeedHead) };
    }
    default:
      require(execution.calls.length === 1, 'rejection plan did not make exactly one call', reasons);
      require(initial.stateHash === final.stateHash && execution.calls.every((call) => call.stateDiff.changedLayers.length === 0), 'rejection changed state', reasons);
      return {
        unchanged: initial.stateHash === final.stateHash,
        initial_hash: initial.stateHash,
        final_hash: final.stateHash,
        sibling_hash: hashJson({
          symbolic_branch: final.siblingBoundary.symbolicBranch,
          head_object_id: final.siblingBoundary.headObjectId,
          refs: final.siblingBoundary.refs as unknown as Json,
          status_records: final.siblingBoundary.statusRecords,
          index: final.siblingBoundary.index as unknown as Json,
          objects: final.siblingBoundary.objects as unknown as Json,
          worktree: final.siblingBoundary.worktree as unknown as Json,
          sentinel: {
            byte_length: final.siblingBoundary.sentinel.byteLength,
            sha256: final.siblingBoundary.sentinel.sha256,
            mode: final.siblingBoundary.sentinel.mode,
          },
        }),
        result_class: execution.calls[0]?.outcomeClass ?? null,
      };
  }
}

function buildToolCoverageMatrix(trials: readonly TrialEvidence[]): FormalGateBReport['toolCoverageMatrix'] {
  return EXPECTED_GIT_TOOL_ORDER.map((tool) => {
    const calls = trials.flatMap((trial) => trial.execution.calls
      .filter((call) => call.tool === tool)
      .map((call) => ({ trial, call })));
    return {
      tool,
      directPlans: [...new Set(calls.map(({ trial }) => trial.summary.planName))],
      callPositions: [...new Set(calls.map(({ call }) => call.index + 1))].sort((a, b) => a - b),
      trialCount: calls.length,
      resultClasses: [...new Set(calls.map(({ call }) => call.outcomeClass))],
      targetedIndependentOracle: [...new Set(calls.map(({ trial }) => FORMAL_GATE_B_PLANS.find((plan) => plan.name === trial.summary.planName)!.targetedIndependentOracle))],
      stableSchemaDigests: [...new Set(calls.map(({ call }) => call.inputSchemaDigest))],
    };
  });
}

function responseIdsValid(execution: GitSpikeTrialExecution): boolean {
  const requestIds = execution.transcript.events
    .filter((event) => event.direction === 'client_to_server' && event.kind === 'request')
    .map((event) => event.request_id)
    .filter((value): value is number => typeof value === 'number');
  const responseIds = execution.transcript.events
    .filter((event) => event.kind === 'response_result' || event.kind === 'response_error')
    .map((event) => event.request_id)
    .filter((value): value is number => typeof value === 'number');
  return responseIds.every((id) => requestIds.includes(id)) && responseIds.length === new Set(responseIds).size;
}

function parseLockedDistributions(lockText: string): LockedDistribution[] {
  return lockText.split('[[packages]]').slice(1).map((section) => {
    const name = /^\s*name = "([^"]+)"/m.exec(section)?.[1];
    const version = /^\s*version = "([^"]+)"/m.exec(section)?.[1];
    if (name === undefined || version === undefined) throw new Error('lock package entry is missing name/version');
    return {
      name,
      canonicalName: canonicalPackageName(name),
      version,
      wheelHashes: [...section.matchAll(/sha256 = "([a-f0-9]{64})"/g)].map((match) => match[1]!),
    };
  });
}

function assessLockDrift(runtime: GitSpikeRuntimeInspection, locked: readonly LockedDistribution[]): string[] {
  const reasons: string[] = [];
  const expected = new Map(locked.map((entry) => [entry.canonicalName, entry.version]));
  const installed = new Map(Object.entries(runtime.distributions).map(([name, version]) => [canonicalPackageName(name), version]));
  for (const [name, version] of expected) {
    if (installed.get(name) !== version) reasons.push(`${name}: expected ${version}, installed ${String(installed.get(name))}`);
  }
  for (const name of installed.keys()) if (!expected.has(name)) reasons.push(`unlocked installed distribution: ${name}`);
  for (const entry of locked) if (entry.wheelHashes.length === 0) reasons.push(`unhashed distribution: ${entry.name}`);
  return reasons;
}

function canonicalPackageName(value: string): string {
  return value.toLowerCase().replace(/[-_.]+/g, '-');
}

function readOculorySourceState(gitExecutable: string): FormalGateBReport['oculorySource'] {
  const env = minimalCommandEnv(gitExecutable);
  const cwd = process.cwd();
  const head = execFileSync(gitExecutable, ['rev-parse', 'HEAD'], { cwd, env, encoding: 'utf8', timeout: 5_000 }).trim();
  const status = execFileSync(gitExecutable, ['status', '--porcelain=v1', '--untracked-files=all'], { cwd, env, encoding: 'utf8', timeout: 5_000 });
  const paths = execFileSync(gitExecutable, ['ls-files', '--modified', '--others', '--exclude-standard', '-z'], { cwd, env, encoding: 'buffer', timeout: 5_000 })
    .toString('utf8').split('\0').filter(Boolean).sort();
  const source = createHash('sha256').update(head).update('\0').update(status);
  for (const path of paths) source.update(path).update('\0').update(readFileSync(path));
  return { head, dirty: status.length > 0, sourceTreeDigest: source.digest('hex') };
}

function minimalCommandEnv(gitExecutable: string): Record<string, string> {
  return { PATH: [dirname(process.execPath), dirname(gitExecutable), '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'), LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    const value = argv[index + 1];
    if (!name.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`invalid argument near ${name}`);
    if (values.has(name)) throw new Error(`duplicate argument: ${name}`);
    values.set(name, value);
    index += 1;
  }
  const allowed = new Set(['--python', '--executable', '--git', '--lock', '--output-dir', '--attempt-id', '--predecessor-attempt-id', '--materializations', '--trials']);
  for (const name of values.keys()) if (!allowed.has(name)) throw new Error(`unexpected argument: ${name}`);
  const requiredPath = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
    return resolve(value);
  };
  const materializations = Number(values.get('--materializations') ?? String(FORMAL_GATE_B_MATERIALIZATIONS));
  const trials = Number(values.get('--trials') ?? String(FORMAL_GATE_B_TRIALS));
  const attemptId = values.get('--attempt-id');
  const predecessorAttemptId = values.get('--predecessor-attempt-id');
  if (materializations !== FORMAL_GATE_B_MATERIALIZATIONS) throw new Error(`--materializations must be exactly ${FORMAL_GATE_B_MATERIALIZATIONS}`);
  if (trials !== FORMAL_GATE_B_TRIALS) throw new Error(`--trials must be exactly ${FORMAL_GATE_B_TRIALS}`);
  if (attemptId === undefined) throw new Error('--attempt-id is required');
  if (predecessorAttemptId === undefined) throw new Error('--predecessor-attempt-id is required');
  return {
    pythonExecutable: requiredPath('--python'),
    targetExecutable: requiredPath('--executable'),
    gitExecutable: requiredPath('--git'),
    lockPath: requiredPath('--lock'),
    outputDirectory: requiredPath('--output-dir'),
    attemptId,
    predecessorAttemptId,
    materializations,
    trials,
  };
}

function findExecutableOnPath(name: string): string {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      if (!existsSync(candidate)) continue;
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue until an executable path is found.
    }
  }
  throw new Error(`${name} was not found on the runner PATH`);
}

function snapshot(execution: GitSpikeTrialExecution, stage: string): GitSpikeSnapshot | null {
  return execution.journal.find((entry) => entry.stage === stage)?.snapshot ?? null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return canonicalJson([...a].sort()) === canonicalJson([...b].sort());
}

function require(condition: boolean, reason: string, reasons: string[]): void {
  if (!condition) reasons.push(reason);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

void main().catch((error: unknown) => {
  process.stderr.write(`formal Git MCP Gate B failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
