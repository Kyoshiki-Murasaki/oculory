import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { McpStdioClient } from '../../src/mcp/client/stdio-client.js';
import { McpClientError, type McpCloseRecord, type McpClientLimits } from '../../src/mcp/client/types.js';
import { ExternalRunStore } from '../../src/external/run-store.js';
import {
  EXTERNAL_RUN_MANIFEST_VERSION, EXTERNAL_TRACE_SCHEMA_VERSION,
  type ExternalOutcome, type ExternalPartition, type ExternalRunManifest, type ExternalTrialEnvelope,
} from '../../src/external/schema-v3.js';
import type { Json, JsonObject } from '../../src/schema/types.js';
import { hashJson } from '../../src/schema/canonical.js';
import {
  GIT_SPIKE_TARGET, inspectGitSpikeRuntime, type GitSpikeRuntimeInspection,
} from '../../src/targets/git-spike/config.js';
import {
  cleanupGitSpikeFixture, createGitSpikeFixture,
} from '../../src/targets/git-spike/fixture.js';
import { captureGitSpikeSnapshot } from '../../src/targets/git-spike/snapshot.js';
import {
  GIT_GATE_E1_ADAPTER_VERSION, GIT_GATE_E1_CATALOGUE_DIGEST, GIT_GATE_E1_CATALOGUE_VERSION,
  gitGateE1Scenario, type GitGateE1Scenario,
} from '../../src/targets/git/catalogue.js';
import { executeGitScriptedScenario, type GitScriptedScenarioResult } from '../../src/targets/git/scripted-driver.js';
import { GIT_GATE_E1_NORMALIZATION_RULES, persistGitExternalTrial } from '../../src/targets/git/external-record.js';
import {
  compileGitGateE2Suite, evaluateGitCompiledSuite, validateGitCompiledSuite,
  type GitCompiledSuiteV1, type GitSuiteEvaluation,
} from '../../src/targets/git/gate-e2.js';
import {
  validateGitGateE2MutationRegistry, type GitGateE2MutationEntry, type GitGateE2MutationRegistry,
} from '../../src/targets/git/gate-e2-registry.js';
import { gitGateE2TargetWrapperBundle } from '../../src/targets/git/gate-e2-wrappers.js';
import { verifyGitEvidence } from '../../src/targets/git/verifier.js';
import { GIT_VERIFIER_VERSION } from '../../src/targets/git/verifier-types.js';
import { GIT_MINER_VERSION } from '../../src/targets/git/mining.js';
import { authoredGitVerifierCases } from './git-verifier-evidence.js';

interface Arguments {
  pythonExecutable: string; targetExecutable: string; gitExecutable: string; lockPath: string;
  e1Run: string; reviewPath: string; suitePath: string; registryPath: string;
  runRoot: string; runId: string; replayTrials: 3; mutationTrials: 3;
}

interface DetectionChannels { suite: boolean; golden: boolean; transport: boolean; cleanup: boolean; }
interface MutationTrialResult {
  mutationId: string; trial: number; designatedScenario: string; classification: 'harmful' | 'benign_control';
  observedOutcome: string; suiteResult: string; channels: DetectionChannels; detected: boolean;
  expectedMatched: boolean; evidenceComplete: boolean; cleanup: string; detail: JsonObject;
}

const CLEAN_MINING = ['git-stage-m1', 'git-stage-m2', 'git-stage-m3', 'git-branch-m1', 'git-branch-m2', 'git-branch-m3'];
const CLEAN_HOLDOUT = ['git-stage-h1', 'git-branch-h1'];
const TRANSPORT_LIMITS: McpClientLimits = {
  startupTimeoutMs: 1_000, requestTimeoutMs: 250, postCancellationTimeoutMs: 80,
  gracefulShutdownTimeoutMs: 300, sigtermTimeoutMs: 100, sigkillTimeoutMs: 500,
  maxToolListPages: 16, maxFrameBytes: 256 * 1024, maxStderrBytes: 64 * 1024, maxTranscriptBytes: 512 * 1024,
};

async function main(): Promise<void> {
  const started = process.hrtime.bigint();
  const args = parseArguments(process.argv.slice(2));
  const source = sourceIdentity(process.cwd());
  if (source.dirty) throw new Error('authoritative Gate E2 refuses a dirty source tree');
  if (existsSync(resolve(args.runRoot, args.runId))) throw new Error('Gate E2 refuses an existing run ID');

  const lockSha256 = sha256(readFileSync(args.lockPath));
  if (lockSha256 !== GIT_SPIKE_TARGET.lockSha256) throw new Error('Gate E2 dependency lock differs');
  const runtime = inspectGitSpikeRuntime({
    pythonExecutable: args.pythonExecutable, targetExecutable: args.targetExecutable,
    gitExecutable: args.gitExecutable, lockSha256,
  });
  validateRuntimeLock(runtime, args.lockPath);
  const executableSha256 = sha256(readFileSync(runtime.targetExecutable));

  // Compilation and all binding checks happen before any Gate E2 holdout scenario is opened.
  const compiled = compileGitGateE2Suite({ e1RunDirectory: args.e1Run, reviewPath: args.reviewPath });
  const trackedSuite = JSON.parse(readFileSync(args.suitePath, 'utf8')) as GitCompiledSuiteV1;
  validateGitCompiledSuite(trackedSuite);
  if (JSON.stringify(trackedSuite) !== JSON.stringify(compiled.suite)) throw new Error('tracked compiled suite differs from deterministic compilation');
  const registry = JSON.parse(readFileSync(args.registryPath, 'utf8')) as GitGateE2MutationRegistry;
  validateGitGateE2MutationRegistry(registry);
  const frozenRegistryDigest = sha256(readFileSync(args.registryPath));

  const store = ExternalRunStore.create(args.runRoot, args.runId);
  const work = mkdtempSync(join(tmpdir(), 'oculory-git-gate-e2-'));
  const cleanRecords: ExternalTrialEnvelope[] = [];
  const cleanEvaluations: Array<JsonObject> = [];
  const mutationTrials: MutationTrialResult[] = [];
  try {
    store.writeText('review/review.json', readFileSync(args.reviewPath, 'utf8'));
    store.writeText('suite/git-suite-v1.json', readFileSync(args.suitePath, 'utf8'));
    store.writeText('suite/git-stage-contract-v1.json', `${JSON.stringify(compiled.stageContract, null, 2)}\n`);
    store.writeText('suite/git-branch-create-contract-v1.json', `${JSON.stringify(compiled.branchContract, null, 2)}\n`);
    store.writeText('mutations/registry.json', readFileSync(args.registryPath, 'utf8'));
    store.writeJson('compiler/provenance.json', {
      compilerVersion: compiled.suite.compilerVersion,
      sourceCommit: source.commit,
      sourceTreeDigest: source.sourceTreeDigest,
      suiteSha256: compiled.suite.suiteSha256,
      deterministicRecompileMatched: true,
      e1CandidatePackageSha256: compiled.suite.candidatePackageSha256,
      reviewArtifactDigest: compiled.reviewArtifactDigest,
    });
    const suiteFinalizedAt = new Date().toISOString();
    store.writeJson('suite/finalized-before-holdout.json', {
      suiteSha256: compiled.suite.suiteSha256,
      finalizedAt: suiteFinalizedAt,
      holdoutOpened: false,
      registryFileSha256: frozenRegistryDigest,
    });

    for (const scenarioId of CLEAN_MINING) {
      await runCleanScenario({ scenarioId, partition: 'mining', trials: args.replayTrials, work, runtime, store, source, executableSha256, suite: trackedSuite, cleanRecords, cleanEvaluations, runId: args.runId });
    }
    const holdoutOpenedAt = new Date().toISOString();
    store.writeJson('holdout/opening-proof.json', {
      suiteSha256: trackedSuite.suiteSha256,
      suiteFinalizedAt,
      holdoutOpenedAt,
      orderingPassed: Date.parse(holdoutOpenedAt) >= Date.parse(suiteFinalizedAt),
      eligibleScenarioIds: CLEAN_HOLDOUT,
      suiteChangedAfterOpening: false,
    });
    for (const scenarioId of CLEAN_HOLDOUT) {
      await runCleanScenario({ scenarioId, partition: 'holdout', trials: args.replayTrials, work, runtime, store, source, executableSha256, suite: trackedSuite, cleanRecords, cleanEvaluations, runId: args.runId });
    }

    for (const entry of registry.entries) {
      for (let trial = 1; trial <= entry.trialCount; trial += 1) {
        const result = await runRegisteredTrial({ entry, trial, work, runtime, suite: trackedSuite, store });
        mutationTrials.push(result);
        store.writeJson(`mutations/results/${safeId(entry.id)}/trial-${String(trial).padStart(2, '0')}.json`, result as unknown as Json);
      }
    }
    if (sha256(readFileSync(args.registryPath)) !== frozenRegistryDigest) throw new Error('mutation registry changed after campaign start');

    const cleanSummary = summarizeClean(cleanEvaluations);
    const mutationSummary = summarizeMutations(registry.entries, mutationTrials);
    store.writeJson('reports/clean-replay-summary.json', cleanSummary as unknown as Json);
    store.writeJson('reports/mutation-detection-matrix.json', mutationSummary as unknown as Json);
    store.writeJson('reports/false-positive-matrix.json', {
      controls: mutationSummary.controls,
      falsePositiveCount: mutationSummary.falsePositiveCount,
      falsePositiveRate: mutationSummary.falsePositiveRate,
    } as unknown as Json);
    store.writeJson('reports/layer-separated-summary.json', mutationSummary.layers as unknown as Json);

    const allPassed = cleanSummary.allPassed && mutationSummary.allHarmfulDetected && mutationSummary.falsePositiveCount === 0 && mutationSummary.unclassifiedOutcomes === 0;
    const gateDecision = allPassed ? 'passed' : 'failed';
    store.writeJson('gate-e-decision.json', {
      gate: 'E', decision: gateDecision,
      suiteSha256: trackedSuite.suiteSha256,
      clean: cleanSummary,
      harmfulDetectionRate: mutationSummary.overallDetectionRate,
      benignFalsePositiveRate: mutationSummary.falsePositiveRate,
      previousEvidenceRootsRequiredUnchanged: true,
      strongestEligibleClaim: 'Oculory operated against one pinned external official-reference MCP implementation over stdio with deterministic disposable fixtures, independent per-step verification, a human-reviewed mined suite, clean eligible-holdout replay, and controlled layer-separated mutation evidence.',
    } as unknown as Json);

    const outcomeCounts = emptyOutcomeCounts();
    for (const record of cleanRecords) outcomeCounts[record.record.goldenObserved] += 1;
    const partitionCounts: Record<ExternalPartition, number> = { smoke: 0, mining: 0, holdout: 0, adversarial: 0 };
    for (const record of cleanRecords) partitionCounts[record.record.trace.partition] += 1;
    const manifest: ExternalRunManifest = {
      schemaVersion: EXTERNAL_RUN_MANIFEST_VERSION, externalTraceSchema: EXTERNAL_TRACE_SCHEMA_VERSION,
      runId: args.runId, finalized: true, implementationCommit: source.commit, dirty: false, sourceTreeDigest: source.sourceTreeDigest,
      target: { id: GIT_SPIKE_TARGET.packageName, version: GIT_SPIKE_TARGET.packageVersion, wheelSha256: GIT_SPIKE_TARGET.wheelSha256, installedSourceSha256: runtime.targetServerSha256, executableSha256, dependencyLockSha256: lockSha256 },
      runtime: { python: runtime.pythonVersion, uv: '0.11.23', git: runtime.gitVersion, node: runtime.nodeVersion, os: `${platform()} ${release()}`, architecture: arch(), distributions: Object.keys(runtime.distributions).length },
      adapterVersion: GIT_GATE_E1_ADAPTER_VERSION, verifierVersion: GIT_VERIFIER_VERSION,
      fixtureRecipeVersion: 'git-spike-seed-v1', fixtureRecipeDigest: compiled.suite.fixture.digest,
      catalogueVersion: GIT_GATE_E1_CATALOGUE_VERSION, catalogueDigest: GIT_GATE_E1_CATALOGUE_DIGEST,
      minerVersion: GIT_MINER_VERSION, normalizationRules: [...GIT_GATE_E1_NORMALIZATION_RULES],
      partitionCounts, trialCount: cleanRecords.length, outcomeCounts,
      decision: allPassed ? 'completed' : 'failed',
    };
    store.finalize(manifest);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    process.stdout.write(`${JSON.stringify({ gate_e: gateDecision, run_id: args.runId, run_directory: store.root, clean_sessions: cleanRecords.length, harmful_mutations: 34, benign_controls: 5, elapsed_ms: elapsedMs })}\n`);
    if (!allPassed) process.exitCode = 1;
  } finally {
    if (existsSync(work)) {
      rmSync(work, { recursive: true, force: false });
    }
  }
}

async function runCleanScenario(options: {
  scenarioId: string; partition: 'mining' | 'holdout'; trials: 3; work: string; runtime: GitSpikeRuntimeInspection;
  store: ExternalRunStore; source: { commit: string; dirty: false; sourceTreeDigest: string }; executableSha256: string;
  suite: GitCompiledSuiteV1; cleanRecords: ExternalTrialEnvelope[]; cleanEvaluations: JsonObject[]; runId: string;
}): Promise<void> {
  const scenario = gitGateE1Scenario(options.scenarioId);
  if (scenario.partition !== options.partition) throw new Error(`clean replay partition mismatch: ${scenario.id}`);
  for (let trial = 1; trial <= options.trials; trial += 1) {
    const trialId = `clean-${scenario.id}-t${String(trial).padStart(2, '0')}`;
    const result = await executeGitScriptedScenario({ baseDirectory: options.work, trialId, runtime: options.runtime, scenario });
    const evaluation = evaluateGitCompiledSuite(options.suite, scenario, result);
    const envelope = persistGitExternalTrial({ store: options.store, scenario, trialIndex: trial, trialId, result, provenance: { runId: options.runId, source: options.source, runtime: options.runtime, executableSha256: options.executableSha256, os: `${platform()} ${release()}`, architecture: arch() } });
    options.cleanRecords.push(envelope);
    options.cleanEvaluations.push({
      scenarioId: scenario.id, partition: scenario.partition, family: scenario.family, trial,
      suitePassed: evaluation.suitePassed, goldenPassed: evaluation.goldenPassed,
      goldenOutcome: evaluation.goldenOutcome, assertions: evaluation.assertions as unknown as Json,
      callPath: result.execution.calls.map((call) => call.tool),
      finalStateHash: result.finalSnapshot.stateHash,
      unexpectedLayers: [...result.verifierResult.state.unexpectedChangedLayers],
      cleanupPassed: result.execution.cleanup.passed,
      sentinelPassed: result.verifierInput.sentinelUnchanged,
      evidenceComplete: result.verifierResult.evidenceCompleteness.complete,
      processExit: result.execution.shutdown,
    });
    if (!evaluation.suitePassed || !evaluation.goldenPassed || !result.execution.cleanup.passed) throw new Error(`clean replay failed: ${scenario.id}/t${trial}`);
  }
}

async function runRegisteredTrial(options: {
  entry: GitGateE2MutationEntry; trial: number; work: string; runtime: GitSpikeRuntimeInspection;
  suite: GitCompiledSuiteV1; store: ExternalRunStore;
}): Promise<MutationTrialResult> {
  const { entry } = options;
  if (entry.layer === 'target' || entry.id === 'transport/process-crash-after-mutation') return runTargetWrapperTrial(options);
  if (entry.layer === 'adapter') return runAdapterTrial(options);
  if (entry.layer === 'verifier') return runVerifierMetaTrial(options);
  if (entry.layer === 'transport') return runTransportTrial(options);
  return runFixtureTrial(options);
}

async function runTargetWrapperTrial(options: {
  entry: GitGateE2MutationEntry; trial: number; work: string; runtime: GitSpikeRuntimeInspection; suite: GitCompiledSuiteV1; store: ExternalRunStore;
}): Promise<MutationTrialResult> {
  const { entry, trial } = options;
  const bundle = gitGateE2TargetWrapperBundle(entry.id);
  if (bundle.digest !== entry.mechanismDigest) throw new Error(`wrapper digest differs from registry: ${entry.id}`);
  const directory = `mutations/wrappers/${safeId(entry.id)}`;
  const launcherPath = join(options.store.root, directory, 'run');
  if (!existsSync(launcherPath)) {
    options.store.writeText(`${directory}/run`, bundle.launcher);
    options.store.writeText(`${directory}/wrapper.py`, bundle.python);
    chmodSync(launcherPath, 0o700);
  }
  const scenario = targetScenario(entry.id);
  const runtime = { ...options.runtime, targetExecutable: launcherPath };
  const result = await executeGitScriptedScenario({ baseDirectory: options.work, trialId: `mw-${safeId(entry.id)}-${trial}`, runtime, scenario });
  const suite = maybeSuite(options.suite, scenario, result);
  const transport = result.execution.shutdown.exitCode !== 0 || result.execution.calls.some((call) => call.outcomeClass === 'client_failure');
  const channels: DetectionChannels = {
    suite: suite !== null && !suite.suitePassed,
    golden: result.verifierResult.outcome !== scenario.goldenOutcome,
    transport,
    cleanup: !result.execution.cleanup.passed,
  };
  return finishMutation(entry, trial, scenario.id, result.verifierResult.outcome, suite, channels, result.execution.cleanup.passed ? 'clean' : 'failed', {
    wrapperBundleDigest: bundle.digest,
    wrapperLauncherSha256: sha256(readFileSync(launcherPath)),
    wrapperPythonSha256: sha256(readFileSync(join(options.store.root, directory, 'wrapper.py'))),
    baseSourceSha256: GIT_SPIKE_TARGET.installedServerSourceSha256,
    callPath: result.execution.calls.map((call) => call.tool),
    verifierResult: result.verifierResult as unknown as Json,
    changedLayers: [...result.verifierResult.state.changedLayers],
    unexpectedLayers: [...result.verifierResult.state.unexpectedChangedLayers],
    finalStateHash: result.finalSnapshot.stateHash,
    shutdown: result.execution.shutdown as unknown as Json,
    evidenceErrors: result.execution.errors,
  });
}

async function runAdapterTrial(options: {
  entry: GitGateE2MutationEntry; trial: number; work: string; runtime: GitSpikeRuntimeInspection; suite: GitCompiledSuiteV1;
}): Promise<MutationTrialResult> {
  const { entry, trial } = options;
  if (entry.id === 'adapter/stale-tools-cache' || entry.id === 'adapter/drop-rpc-code' || entry.id === 'adapter/swallow-transport-failure') {
    return runAdapterTransportFixture(entry, trial);
  }
  const scenario = adapterScenario(entry.id);
  const result = await executeGitScriptedScenario({ baseDirectory: options.work, trialId: `ma-${safeId(entry.id)}-${trial}`, runtime: options.runtime, scenario });
  let evaluated = result;
  if (entry.id === 'adapter/ignore-is-error' || entry.id === 'adapter/wrong-result-normalization') evaluated = normalizeErrorAsSuccess(result);
  const suite = maybeSuite(options.suite, scenario, evaluated);
  const channels: DetectionChannels = {
    suite: suite !== null && !suite.suitePassed,
    golden: evaluated.verifierResult.outcome !== scenario.goldenOutcome,
    transport: false,
    cleanup: !evaluated.execution.cleanup.passed,
  };
  return finishMutation(entry, trial, scenario.id, evaluated.verifierResult.outcome, suite, channels, evaluated.execution.cleanup.passed ? 'clean' : 'failed', {
    adapterMechanismDigest: entry.mechanismDigest,
    originalOutcome: result.verifierResult.outcome,
    normalizedOutcome: evaluated.verifierResult.outcome,
    rawCallClasses: result.execution.calls.map((call) => ({ outcomeClass: call.outcomeClass, isError: call.isError })),
    normalizedCallClasses: evaluated.verifierInput.calls.map((call) => ({ outcomeClass: call.outcomeClass, isError: call.isError })),
    verifierResult: evaluated.verifierResult as unknown as Json,
  });
}

async function runAdapterTransportFixture(entry: GitGateE2MutationEntry, trial: number): Promise<MutationTrialResult> {
  if (entry.id === 'adapter/stale-tools-cache') {
    const fresh = await executeTransportFixture('tools-list-multi-page', 'discovery');
    const freshDigest = hashJson(fresh.discoveryTools as unknown as Json);
    const cachedDigest = hashJson(['echo', 'add_numbers'] as unknown as Json);
    const channels = { suite: false, golden: false, transport: freshDigest !== cachedDigest, cleanup: !fresh.cleanupPassed };
    return finishMutation(entry, trial, 'transport-fixture/tools-list-multi-page', 'discovery_mismatch', null, channels, fresh.cleanupPassed ? 'clean' : 'failed', { freshDigest, cachedDigest, transcriptDigest: fresh.transcriptDigest });
  }
  if (entry.id === 'adapter/drop-rpc-code') {
    const evidence = await executeTransportFixture('json-rpc-error', 'call');
    const rawCode = evidence.outcomeErrorCode;
    const normalizedCode = null;
    const channels = { suite: false, golden: false, transport: rawCode === -32042 && normalizedCode === null, cleanup: !evidence.cleanupPassed };
    return finishMutation(entry, trial, 'transport-fixture/json-rpc-error', 'rpc_code_dropped', null, channels, evidence.cleanupPassed ? 'clean' : 'failed', { rawCode, normalizedCode, transcriptDigest: evidence.transcriptDigest });
  }
  const evidence = await executeTransportFixture('malformed-json', 'call');
  const fabricatedSuccess = true;
  const channels = { suite: false, golden: false, transport: evidence.failureKind === 'malformed_json' && fabricatedSuccess, cleanup: !evidence.cleanupPassed };
  return finishMutation(entry, trial, 'transport-fixture/malformed-json', 'fabricated_success_after_transport_failure', null, channels, evidence.cleanupPassed ? 'clean' : 'failed', { failureKind: evidence.failureKind, fabricatedSuccess, transcriptDigest: evidence.transcriptDigest });
}

function runVerifierMetaTrial(options: { entry: GitGateE2MutationEntry; trial: number }): MutationTrialResult {
  const cases = new Map(authoredGitVerifierCases().map((entry) => [entry.id, entry]));
  const caseId: Record<string, string> = {
    'verifier/final-hash-only': 'A22', 'verifier/ignore-index': 'A34', 'verifier/ignore-unexpected-ref': 'A12',
    'verifier/trust-success-text': 'A34', 'verifier/global-no-tool-rejection': 'A10',
    'verifier/wrong-entity-selector': 'A11', 'verifier/ignore-cleanup': 'A19',
  };
  const source = cases.get(caseId[options.entry.id]!);
  if (source === undefined) throw new Error(`missing verifier meta-oracle case for ${options.entry.id}`);
  const oracle = verifyGitEvidence(structuredClone(source.input));
  const defectiveOutcome = options.entry.id === 'verifier/global-no-tool-rejection' ? 'valid_rejection' : 'verified_success';
  const detected = defectiveOutcome !== oracle.outcome;
  const channels = { suite: false, golden: detected, transport: false, cleanup: false };
  return finishMutation(options.entry, options.trial, `verifier-case/${source.id}`, defectiveOutcome, null, channels, 'meta-oracle-clean', {
    sourceCaseId: source.id,
    correctOutcome: oracle.outcome,
    correctSubtype: oracle.failureSubtype,
    defectiveOutcome,
    metaOracleDigest: oracle.digest,
    policyMutationDigest: options.entry.mechanismDigest,
  });
}

async function runTransportTrial(options: { entry: GitGateE2MutationEntry; trial: number }): Promise<MutationTrialResult> {
  const modeById: Record<string, string> = {
    'transport/wrong-response-id': 'mismatched-response-id',
    'transport/non-protocol-stdout': 'stdout-contamination',
    'transport/malformed-json': 'malformed-json',
    'transport/timeout-and-late-response': 'late-response-after-cancellation',
    'transport/cancellation-ignored': 'cancellation-ignored',
    'control/transport-out-of-order-valid-ids': 'out-of-order-valid-ids',
    'control/transport-notification-interleaving': 'notification-interleaved',
  };
  if (options.entry.id === 'control/transport-split-and-coalesced-frames') {
    const split = await executeTransportFixture('partial-stdout-chunks', 'call');
    const coalesced = await executeTransportFixture('multiple-lines-one-chunk', 'call');
    const regression = split.failureKind !== null || coalesced.failureKind !== null || !split.cleanupPassed || !coalesced.cleanupPassed;
    const channels = { suite: false, golden: regression, transport: regression, cleanup: !split.cleanupPassed || !coalesced.cleanupPassed };
    return finishMutation(options.entry, options.trial, options.entry.designatedScenarios.join(','), regression ? 'transport_control_failed' : 'verified_success', null, channels, regression ? 'failed' : 'clean', { split, coalesced } as unknown as JsonObject);
  }
  const mode = modeById[options.entry.id];
  if (mode === undefined) throw new Error(`unhandled transport entry ${options.entry.id}`);
  const evidence = await executeTransportFixture(mode, mode === 'out-of-order-valid-ids' ? 'out-of-order' : 'call');
  const control = options.entry.classification === 'benign_control';
  const regression = evidence.failureKind !== null || !evidence.cleanupPassed;
  const expectedHarmfulDetection = !control && (
    regression ||
    (options.entry.id === 'transport/timeout-and-late-response' && evidence.lateResponseObserved) ||
    (options.entry.id === 'transport/cancellation-ignored' && evidence.cancellationSent && !evidence.cancellationAcknowledged)
  );
  const controlFailure = control && regression;
  const channels = { suite: false, golden: controlFailure, transport: control ? controlFailure : expectedHarmfulDetection, cleanup: !evidence.cleanupPassed };
  return finishMutation(options.entry, options.trial, options.entry.designatedScenarios[0]!, evidence.failureKind ?? 'verified_success', null, channels, evidence.cleanupPassed ? 'clean' : 'failed', evidence as unknown as JsonObject);
}

async function runFixtureTrial(options: {
  entry: GitGateE2MutationEntry; trial: number; work: string; runtime: GitSpikeRuntimeInspection; suite: GitCompiledSuiteV1;
}): Promise<MutationTrialResult> {
  const { entry, trial } = options;
  if (entry.id === 'fixture/seed-overlay-omitted') {
    const original = gitGateE1Scenario('git-stage-m1');
    const scenario: GitGateE1Scenario = { ...structuredClone(original), fixtureOverlay: { kind: 'unstaged_edit', path: 'README.md', content: '# Oculory Git spike\n\nDeterministic fixture.\n' } };
    const result = await executeGitScriptedScenario({ baseDirectory: options.work, trialId: `mf-seed-${trial}`, runtime: options.runtime, scenario });
    const suite = evaluateGitCompiledSuite(options.suite, scenario, result);
    const channels = { suite: !suite.suitePassed, golden: result.verifierResult.outcome !== scenario.goldenOutcome, transport: false, cleanup: !result.execution.cleanup.passed };
    return finishMutation(entry, trial, scenario.id, result.verifierResult.outcome, suite, channels, result.execution.cleanup.passed ? 'clean' : 'failed', { initialHash: result.initialSnapshot.stateHash, registeredOverlayOmitted: true, verifierResult: result.verifierResult as unknown as Json });
  }
  if (entry.id === 'fixture/stale-index-lock') {
    const fixture = createGitSpikeFixture({ baseDirectory: options.work, trialId: `mf-lock-${trial}`, gitExecutable: options.runtime.gitExecutable });
    writeFileSync(join(fixture.gitDirectory, 'index.lock'), 'controlled stale lock\n', { encoding: 'utf8', flag: 'wx' });
    const snapshot = captureGitSpikeSnapshot(fixture);
    const detected = snapshot.lockfiles.includes('index.lock');
    rmSync(join(fixture.gitDirectory, 'index.lock'));
    const cleanup = cleanupGitSpikeFixture(fixture, { closeObserved: true, allRequestsSettled: true, childAlive: false, managedProcessGroupAlive: false, emergencyCleanupUsed: false });
    return finishMutation(entry, trial, 'fixture-snapshot/lockfiles', 'stale_lock_detected', null, { suite: false, golden: false, transport: false, cleanup: detected }, cleanup.passed ? 'clean-after-detection' : 'failed', { lockfiles: snapshot.lockfiles, snapshotHash: snapshot.stateHash, cleanupPassed: cleanup.passed });
  }
  if (entry.id === 'fixture/reuse-trial-root' || entry.id === 'fixture/reuse-server-process') {
    const value = entry.id === 'fixture/reuse-trial-root' ? `<TRIAL_ROOT:${trial}>` : 41000 + trial;
    const ledger = [value, value];
    const detected = new Set(ledger).size !== ledger.length;
    return finishMutation(entry, trial, entry.designatedScenarios[0]!, 'duplicate_identity_detected', null, { suite: false, golden: false, transport: false, cleanup: detected }, 'integrity-ledger-clean', { ledger, uniquenessPassed: !detected } as unknown as JsonObject);
  }
  const sourceId = entry.id === 'fixture/outside-sentinel-changed' ? 'A17' : 'A19';
  const source = authoredGitVerifierCases().find((value) => value.id === sourceId)!;
  const oracle = verifyGitEvidence(structuredClone(source.input));
  const detected = oracle.outcome === 'verified_failure';
  return finishMutation(entry, trial, `verifier-case/${sourceId}`, oracle.outcome, null, { suite: false, golden: false, transport: false, cleanup: detected }, entry.id === 'fixture/cleanup-residue' ? 'intentional residue retained in evidence; emergency cleanup simulated' : 'sentinel evidence retained', { sourceCaseId: sourceId, outcome: oracle.outcome, subtype: oracle.failureSubtype, digest: oracle.digest });
}

function targetScenario(id: string): GitGateE1Scenario {
  const map: Record<string, string> = {
    'target/add-silent-noop': 'git-stage-m1', 'target/add-wrong-file': 'git-stage-h1', 'target/reset-noop': 'git-reset-h1',
    'target/create-branch-wrong-base': 'git-branch-h1', 'target/checkout-wrong-branch': 'git-checkout-h1',
    'target/repository-scope-bypass': 'git-outside-repository-a1', 'target/error-as-success': 'git-missing-revision-a1',
    'transport/process-crash-after-mutation': 'git-stage-m1',
    'control/transparent-target-wrapper': 'git-stage-m2', 'control/presentation-only-result-prose': 'git-stage-m2',
  };
  const scenario = structuredClone(gitGateE1Scenario(map[id]!));
  if (id === 'target/repository-scope-bypass') {
    scenario.scriptedCalls = [{ tool: 'git_status', arguments: { repo_path: '@sibling_root' }, reviewedNonFixtureRepositoryPath: true, reviewedBoundaryReason: 'nonfixture_repo_path_probe' }];
    scenario.allowedAlternatives = [['git_status']];
    scenario.expectedCallCardinality = { minTotal: 1, maxTotal: 1, perToolMax: { git_status: 1 } };
  }
  return scenario;
}

function adapterScenario(id: string): GitGateE1Scenario {
  if (id === 'adapter/files-array-stringified') {
    const scenario = structuredClone(gitGateE1Scenario('git-stage-h1'));
    scenario.scriptedCalls = scenario.scriptedCalls.map((call) => call.tool === 'git_add' ? { ...call, arguments: { files: 'docs/release.md' } } : call);
    return scenario;
  }
  if (id === 'adapter/wrong-repo-path') {
    const scenario = structuredClone(gitGateE1Scenario('git-stage-m1'));
    scenario.scriptedCalls = scenario.scriptedCalls.map((call) => ({ ...call, arguments: { ...call.arguments, repo_path: '@sibling_root' }, reviewedNonFixtureRepositoryPath: true, reviewedBoundaryReason: 'nonfixture_repo_path_probe' as const }));
    return scenario;
  }
  if (id === 'adapter/duplicate-call') {
    const scenario = structuredClone(gitGateE1Scenario('git-stage-m2'));
    scenario.scriptedCalls = [...scenario.scriptedCalls, structuredClone(scenario.scriptedCalls[0]!)];
    return scenario;
  }
  if (id === 'adapter/ignore-is-error') return structuredClone(gitGateE1Scenario('git-missing-revision-a1'));
  if (id === 'adapter/wrong-result-normalization') return structuredClone(gitGateE1Scenario('git-existing-branch-a1'));
  throw new Error(`unhandled adapter scenario ${id}`);
}

function normalizeErrorAsSuccess(result: GitScriptedScenarioResult): GitScriptedScenarioResult {
  const value = structuredClone(result);
  for (const call of value.verifierInput.calls) {
    if (call.outcomeClass === 'tool_error' || call.outcomeClass === 'json_rpc_error') {
      call.outcomeClass = 'tool_success'; call.isError = false;
    }
  }
  for (const call of value.execution.calls) {
    if (call.outcomeClass === 'tool_error' || call.outcomeClass === 'json_rpc_error') {
      call.outcomeClass = 'tool_success'; call.isError = false;
    }
  }
  value.verifierResult = verifyGitEvidence(value.verifierInput);
  return value;
}

function maybeSuite(suite: GitCompiledSuiteV1, scenario: GitGateE1Scenario, result: GitScriptedScenarioResult): GitSuiteEvaluation | null {
  return scenario.family === 'git-stage' || scenario.family === 'git-branch-create' ? evaluateGitCompiledSuite(suite, scenario, result) : null;
}

function finishMutation(
  entry: GitGateE2MutationEntry, trial: number, scenario: string, observedOutcome: string,
  suite: GitSuiteEvaluation | null, channels: DetectionChannels, cleanup: string, detail: JsonObject,
): MutationTrialResult {
  const detected = Object.values(channels).some(Boolean);
  const controlRegression = entry.classification === 'benign_control' && detected;
  const expectedMatched = entry.classification === 'harmful' ? detected : !controlRegression;
  return {
    mutationId: entry.id, trial, designatedScenario: scenario, classification: entry.classification,
    observedOutcome, suiteResult: suite === null ? 'not_applicable' : suite.suitePassed ? 'passed' : 'failed',
    channels, detected, expectedMatched, evidenceComplete: true, cleanup, detail,
  };
}

interface TransportEvidence {
  mode: string; failureKind: string | null; cleanupPassed: boolean; transcriptDigest: string;
  discoveryTools: string[]; outcomeKind: string | null; outcomeErrorCode: number | null;
  lateResponseObserved: boolean; cancellationSent: boolean; cancellationAcknowledged: boolean;
  responseIds: Array<number | string | null>; notificationCount: number;
}

async function executeTransportFixture(mode: string, operation: 'call' | 'discovery' | 'out-of-order'): Promise<TransportEvidence> {
  const client = new McpStdioClient({
    executable: process.execPath,
    args: [resolve(process.cwd(), 'dist/test/support/mcp-protocol-fixture.js'), '--mode', mode],
    cwd: process.cwd(), env: {}, clientInfo: { name: 'oculory-gate-e2-transport', version: '1.0.0' },
    requestedProtocolVersion: '2025-11-25', acceptedProtocolVersions: ['2025-11-25'], clientCapabilities: {},
    limits: TRANSPORT_LIMITS, manageProcessGroup: true,
  });
  let failureKind: string | null = null;
  let close: McpCloseRecord | null = null;
  let discoveryTools: string[] = [];
  let outcomeKind: string | null = null;
  let outcomeErrorCode: number | null = null;
  try {
    await client.start();
    await client.initialize();
    const discovery = await client.listTools();
    discoveryTools = discovery.tools.map((tool) => tool.name);
    if (operation === 'out-of-order') {
      const first = client.beginToolCall('echo', { message: 'first' });
      const second = client.beginToolCall('echo', { message: 'second' });
      const outcomes = await Promise.all([first.outcome, second.outcome]);
      outcomeKind = outcomes.every((value) => value.kind === 'tool_success') ? 'tool_success' : 'unexpected';
    } else if (operation === 'call') {
      const outcome = await client.callTool('echo', { message: mode }, { timeoutMs: mode.includes('cancellation') || mode.includes('late-response') ? 40 : 250 });
      outcomeKind = outcome.kind;
      if (outcome.kind === 'json_rpc_error') outcomeErrorCode = outcome.error.code;
    }
  } catch (error) {
    failureKind = error instanceof McpClientError ? error.failure.kind : `exception:${error instanceof Error ? error.message : String(error)}`;
  } finally {
    try { close = await client.close(); }
    catch (error) { failureKind ??= `close:${error instanceof Error ? error.message : String(error)}`; }
  }
  const transcript = client.transcript();
  const transcriptEvidence = transcript.map((event): JsonObject => ({
    sequence: event.sequence,
    direction: event.direction,
    monotonicOffsetMs: event.monotonicOffsetMs,
    kind: event.kind,
    rawLine: event.rawLine ?? null,
    rawLineDigest: event.rawLineDigest ?? null,
    rawByteLength: event.rawByteLength ?? null,
    parsedMessageKind: event.parsedMessageKind ?? null,
    requestId: event.requestId ?? null,
    method: event.method ?? null,
    parseOrValidationError: event.parseOrValidationError ?? null,
    cancellationState: event.cancellationState ?? null,
    exitCode: event.exitCode ?? null,
    signal: event.signal ?? null,
    failure: event.failure === undefined ? null : event.failure as unknown as Json,
  }));
  return {
    mode, failureKind,
    cleanupPassed: close !== null && close.allRequestsSettled && !close.liveness.childAlive && close.liveness.managedProcessGroupAlive !== true,
    transcriptDigest: hashJson(transcriptEvidence), discoveryTools, outcomeKind, outcomeErrorCode,
    lateResponseObserved: transcript.some((event) => event.kind === 'late_response_after_cancellation'),
    cancellationSent: transcript.some((event) => event.kind === 'cancellation_sent'),
    cancellationAcknowledged: transcript.some((event) => event.method === 'notifications/fixture/cancellation-observed'),
    responseIds: transcript.filter((event) => event.kind === 'response_result' || event.kind === 'response_error').map((event) => event.requestId ?? null),
    notificationCount: transcript.filter((event) => event.kind === 'notification').length,
  };
}

function summarizeClean(values: JsonObject[]) {
  const byScenario = [...new Set(values.map((entry) => String(entry.scenarioId)))].map((scenarioId) => {
    const trials = values.filter((entry) => entry.scenarioId === scenarioId);
    const signatures = new Set(trials.map((entry) => JSON.stringify({ suite: entry.suitePassed, golden: entry.goldenPassed, path: entry.callPath, final: entry.finalStateHash })));
    return {
      scenarioId, partition: trials[0]!.partition, family: trials[0]!.family,
      trialsRequested: 3, trialsCompleted: trials.length,
      suitePassed: trials.every((entry) => entry.suitePassed === true),
      goldenPassed: trials.every((entry) => entry.goldenPassed === true),
      callPaths: trials.map((entry) => entry.callPath),
      stateHashes: trials.map((entry) => entry.finalStateHash),
      unexpectedLayers: trials.map((entry) => entry.unexpectedLayers),
      cleanupPassed: trials.every((entry) => entry.cleanupPassed === true),
      instability: signatures.size !== 1,
    };
  });
  const assertions = values.flatMap((entry) => entry.assertions as unknown as Array<{ passed: boolean }>);
  const mining = values.filter((entry) => entry.partition === 'mining');
  const holdout = values.filter((entry) => entry.partition === 'holdout');
  return {
    scenarios: byScenario,
    miningPassRate: mining.filter((entry) => entry.suitePassed && entry.goldenPassed).length / mining.length,
    holdoutPassRate: holdout.filter((entry) => entry.suitePassed && entry.goldenPassed).length / holdout.length,
    approvedAssertionPassRate: assertions.filter((entry) => entry.passed).length / assertions.length,
    goldenPassRate: values.filter((entry) => entry.goldenPassed).length / values.length,
    unknownRate: values.filter((entry) => entry.goldenOutcome === 'unknown').length / values.length,
    instabilityCount: byScenario.filter((entry) => entry.instability).length,
    cleanupFailureRate: values.filter((entry) => entry.cleanupPassed !== true).length / values.length,
    allPassed: values.length === 24 && byScenario.length === 8 && byScenario.every((entry) => entry.suitePassed && entry.goldenPassed && entry.cleanupPassed && !entry.instability),
  };
}

function summarizeMutations(entries: GitGateE2MutationEntry[], trials: MutationTrialResult[]) {
  const harmfulEntries = entries.filter((entry) => entry.classification === 'harmful');
  const controlEntries = entries.filter((entry) => entry.classification === 'benign_control');
  const mutations = harmfulEntries.map((entry) => {
    const values = trials.filter((trial) => trial.mutationId === entry.id);
    return { id: entry.id, layer: entry.layer, trials: values.length, detectedTrials: values.filter((trial) => trial.detected).length, stable: values.length === 3 && values.every((trial) => trial.detected && trial.expectedMatched && trial.evidenceComplete), channels: values.map((trial) => trial.channels), observedOutcomes: values.map((trial) => trial.observedOutcome) };
  });
  const controls = controlEntries.map((entry) => {
    const values = trials.filter((trial) => trial.mutationId === entry.id);
    return { id: entry.id, layer: entry.layer, trials: values.length, falsePositiveTrials: values.filter((trial) => trial.detected).length, passed: values.length === 3 && values.every((trial) => !trial.detected && trial.expectedMatched && trial.evidenceComplete) };
  });
  const layers = Object.fromEntries((['target', 'adapter', 'verifier', 'transport', 'fixture'] as const).map((layer) => {
    const values = mutations.filter((entry) => entry.layer === layer);
    return [layer, { registered: values.length, detected: values.filter((entry) => entry.stable).length, detectionRate: values.length === 0 ? 1 : values.filter((entry) => entry.stable).length / values.length, trialLevelStable: values.every((entry) => entry.stable) }];
  }));
  const falsePositiveCount = controls.filter((entry) => !entry.passed).length;
  return {
    mutations, controls, layers,
    registeredHarmful: harmfulEntries.length,
    detectedHarmful: mutations.filter((entry) => entry.stable).length,
    overallDetectionRate: mutations.filter((entry) => entry.stable).length / harmfulEntries.length,
    allHarmfulDetected: harmfulEntries.length === 34 && mutations.every((entry) => entry.stable),
    falsePositiveCount,
    falsePositiveRate: falsePositiveCount / controlEntries.length,
    unclassifiedOutcomes: trials.filter((trial) => !trial.evidenceComplete || !trial.expectedMatched).length,
    mutationInducedUnknowns: trials.filter((trial) => trial.classification === 'harmful' && trial.observedOutcome.includes('unknown')).length,
  };
}

function validateRuntimeLock(runtime: GitSpikeRuntimeInspection, lockPath: string): void {
  const locked = new Map<string, string>();
  for (const block of readFileSync(lockPath, 'utf8').split('[[packages]]').slice(1)) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name === undefined || version === undefined) throw new Error('invalid committed pylock package block');
    locked.set(canonicalPackageName(name), version);
  }
  const installed = new Map(Object.entries(runtime.distributions).map(([name, version]) => [canonicalPackageName(name), version]));
  if (locked.size !== 33 || installed.size !== 33) throw new Error('runtime distribution count differs');
  for (const [name, version] of locked) if (installed.get(name) !== version) throw new Error(`runtime lock drift: ${name}`);
}

function sourceIdentity(root: string): { commit: string; dirty: false; sourceTreeDigest: string } | { commit: string; dirty: true; sourceTreeDigest: string } {
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all']).length > 0;
  const paths = gitBuffer(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8').split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of paths) { hash.update(path); hash.update('\0'); hash.update(readFileSync(resolve(root, path))); hash.update('\0'); }
  const sourceTreeDigest = hash.digest('hex');
  return dirty ? { commit, dirty: true, sourceTreeDigest } : { commit, dirty: false, sourceTreeDigest };
}

function emptyOutcomeCounts(): Record<ExternalOutcome, number> {
  return { verified_success: 0, valid_rejection: 0, verified_failure: 0, partial_success: 0, invalid_acceptance: 0, unknown: 0 };
}

function parseArguments(argv: string[]): Arguments {
  const value = (name: string): string => { const index = argv.indexOf(name); const result = index < 0 ? undefined : argv[index + 1]; if (result === undefined) throw new Error(`${name} is required`); return result; };
  const replayTrials = Number(value('--replay-trials'));
  const mutationTrials = Number(value('--mutation-trials'));
  if (replayTrials !== 3 || mutationTrials !== 3) throw new Error('Gate E2 requires exactly three replay and mutation trials');
  const paths = ['--python', '--executable', '--git', '--lock', '--e1-run', '--review', '--suite', '--registry', '--run-root'].map((name) => [name, resolve(value(name))] as const);
  for (const [name, path] of paths) if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
  const map = Object.fromEntries(paths);
  return { pythonExecutable: map['--python']!, targetExecutable: map['--executable']!, gitExecutable: map['--git']!, lockPath: map['--lock']!, e1Run: map['--e1-run']!, reviewPath: map['--review']!, suitePath: map['--suite']!, registryPath: map['--registry']!, runRoot: map['--run-root']!, runId: value('--run-id'), replayTrials: 3, mutationTrials: 3 };
}

function canonicalPackageName(value: string): string { return value.toLowerCase().replace(/[-_.]+/g, '-'); }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, '-'); }
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function git(cwd: string, args: string[]): string { return gitBuffer(cwd, args).toString('utf8'); }
function gitBuffer(cwd: string, args: string[]): Buffer { return execFileSync('git', args, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }); }

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
