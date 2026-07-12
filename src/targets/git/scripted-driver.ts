import type { JsonObject } from '../../schema/types.js';
import type { GitSpikeRuntimeInspection, ExpectedGitToolName } from '../git-spike/config.js';
import {
  applyFixtureEdit,
  runFixtureGit,
  stageFixturePath,
  type GitSpikeFixture,
} from '../git-spike/fixture.js';
import {
  runGitSpikeTrial,
  type GitSpikeCallSpec,
  type GitSpikeTrialExecution,
  type GitSpikeTrialPlan,
} from '../git-spike/direct-harness.js';
import type { GitSpikeSnapshot, GitSpikeSnapshotLayer } from '../git-spike/snapshot.js';
import { verifyGitEvidence } from './verifier.js';
import {
  GIT_VERIFIER_VERSION,
  type GitVerifierInput,
  type GitVerifierPostcondition,
  type GitVerifierPolicy,
  type GitVerifierResult,
  type GitVerifierTransportClass,
} from './verifier-types.js';
import type { GitGateE1Scenario } from './catalogue.js';

export interface GitScriptedScenarioResult {
  execution: GitSpikeTrialExecution;
  verifierInput: GitVerifierInput;
  verifierResult: GitVerifierResult;
  initialSnapshot: GitSpikeSnapshot;
  finalSnapshot: GitSpikeSnapshot;
}

interface ExpectedValues {
  indexObjectId: string | null;
  mainHead: string | null;
  featureSeedHead: string | null;
}

export async function executeGitScriptedScenario(options: {
  baseDirectory: string;
  trialId: string;
  runtime: GitSpikeRuntimeInspection;
  scenario: GitGateE1Scenario;
}): Promise<GitScriptedScenarioResult> {
  const expected: ExpectedValues = { indexObjectId: null, mainHead: null, featureSeedHead: null };
  const plan: GitSpikeTrialPlan = {
    name: options.scenario.id,
    prepare: (fixture) => prepareScenarioFixture(options.scenario, fixture, expected),
    calls: (fixture) => resolveCalls(options.scenario, fixture),
  };
  const execution = await runGitSpikeTrial({
    baseDirectory: options.baseDirectory,
    trialId: options.trialId,
    runtime: options.runtime,
    plan,
  });
  const initialSnapshot = requiredSnapshot(execution, 'before_server_start');
  const finalSnapshot = execution.calls.at(-1) === undefined
    ? requiredSnapshot(execution, 'after_final_response')
    : execution.journal[execution.calls.at(-1)!.afterSnapshotIndex]!.snapshot;
  const verifierInput = buildVerifierInput(options.scenario, execution, initialSnapshot, finalSnapshot, expected);
  return {
    execution,
    verifierInput,
    verifierResult: verifyGitEvidence(verifierInput),
    initialSnapshot,
    finalSnapshot,
  };
}

function prepareScenarioFixture(
  scenario: GitGateE1Scenario,
  fixture: GitSpikeFixture,
  expected: ExpectedValues,
): void {
  expected.mainHead = fixture.mainHead;
  expected.featureSeedHead = fixture.featureSeedHead;
  const overlay = scenario.fixtureOverlay;
  if (overlay.kind === 'unstaged_edit' || overlay.kind === 'staged_edit') {
    applyFixtureEdit(fixture, overlay.path, overlay.content);
    expected.indexObjectId = overlay.kind === 'staged_edit'
      ? runFixtureGit(fixture, ['rev-parse', `HEAD:${overlay.path}`]).toString('utf8').trim()
      : runFixtureGit(fixture, ['hash-object', '--', overlay.path]).toString('utf8').trim();
    if (overlay.kind === 'staged_edit') stageFixturePath(fixture, overlay.path);
  }
  if (overlay.kind === 'branches') {
    for (const name of overlay.names) runFixtureGit(fixture, ['branch', name, 'main']);
  }
}

function resolveCalls(scenario: GitGateE1Scenario, fixture: GitSpikeFixture): GitSpikeCallSpec[] {
  return scenario.scriptedCalls.map((call) => {
    const args = substitute(call.arguments, fixture) as JsonObject;
    const spec: GitSpikeCallSpec = { tool: call.tool as ExpectedGitToolName, arguments: args };
    if (call.reviewedNonFixtureRepositoryPath === true) {
      spec.reviewedNonFixtureRepositoryPath = true;
      spec.reviewedBoundaryReason = call.reviewedBoundaryReason;
    }
    return spec;
  });
}

function substitute(value: unknown, fixture: GitSpikeFixture): unknown {
  if (value === '@main_head') return fixture.mainHead;
  if (value === '@feature_seed_head') return fixture.featureSeedHead;
  if (value === '@sibling_root') return fixture.siblingRepositoryRoot;
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, fixture));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, fixture)]));
  }
  return value;
}

function buildVerifierInput(
  scenario: GitGateE1Scenario,
  execution: GitSpikeTrialExecution,
  initial: GitSpikeSnapshot,
  final: GitSpikeSnapshot,
  expected: ExpectedValues,
): GitVerifierInput {
  const policy = buildPolicy(scenario, initial, expected);
  const calls = execution.calls.map((call, index) => ({
    evidenceId: `call:${index}`,
    index,
    tool: call.tool,
    arguments: structuredClone(call.arguments),
    outcomeClass: call.outcomeClass,
    isError: call.isError,
    serverProse: JSON.stringify(call.rawOutcome),
    rawResponseClass: call.outcomeClass === 'client_failure' ? 'missing' as const : 'valid' as const,
    beforeSnapshotRef: `journal:${index}:before`,
    afterSnapshotRef: `journal:${index}:after`,
    before: structuredClone(execution.journal[call.beforeSnapshotIndex]!.snapshot),
    after: structuredClone(execution.journal[call.afterSnapshotIndex]!.snapshot),
    stateDiff: structuredClone(call.stateDiff),
  }));
  const references = [
    { id: 'snapshot:initial', kind: 'snapshot' as const },
    { id: 'snapshot:final', kind: 'snapshot' as const },
    { id: 'transport', kind: 'transport' as const },
    { id: 'cleanup', kind: 'cleanup' as const },
    { id: 'sentinel', kind: 'sentinel' as const },
    { id: 'raw', kind: 'raw' as const },
    ...calls.flatMap((_, index) => [
      { id: `call:${index}`, kind: 'call' as const },
      { id: `journal:${index}:before`, kind: 'journal' as const },
      { id: `journal:${index}:after`, kind: 'journal' as const },
    ]),
  ];
  const sentinelUnchanged = execution.cleanup.sentinelUnchangedBeforeRepositoryRemoval &&
    execution.cleanup.sentinelUnchangedAfterRepositoryRemoval &&
    calls.every((call) => !call.stateDiff.sentinelMetadataChanged && !call.stateDiff.changedLayers.includes('sibling_boundary'));
  const complete = execution.initialization !== null && execution.discovery !== null && execution.cleanup.passed &&
    execution.errors.length === 0 && execution.shutdown.observed && calls.length === scenario.scriptedCalls.length;
  return {
    verifierVersion: GIT_VERIFIER_VERSION,
    scenarioId: scenario.id,
    policy,
    evidenceReferences: references,
    requiredEvidenceReferences: references.map((entry) => entry.id),
    initialSnapshotRef: 'snapshot:initial',
    initialSnapshot: structuredClone(initial),
    calls,
    finalSnapshotRef: 'snapshot:final',
    finalSnapshot: structuredClone(final),
    transportEvidenceId: 'transport',
    transport: transportClass(execution),
    oracleStatus: 'complete',
    cleanup: { evidenceId: 'cleanup', status: execution.cleanup.passed ? 'clean' : 'residue', proof: structuredClone(execution.cleanup) },
    sentinelEvidenceId: 'sentinel',
    sentinelUnchanged,
    rawEvidenceRetained: true,
    evidenceComplete: complete,
    declaredMissingEvidence: complete ? [] : execution.errors.length > 0 ? [...execution.errors] : ['incomplete_execution'],
  };
}

function buildPolicy(
  scenario: GitGateE1Scenario,
  initial: GitSpikeSnapshot,
  expected: ExpectedValues,
): GitVerifierPolicy {
  const path = scenario.intendedEntities.path;
  const branch = scenario.intendedEntities.branch;
  const isRejection = scenario.goldenOutcome === 'valid_rejection';
  const readOnly = isRejection || ['git-status-s1', 'git-history-s1', 'git-status-readonly-a1', 'git-mutate-restore-a1'].includes(scenario.id);
  const postconditions: GitVerifierPostcondition[] = [];
  if (readOnly) postconditions.push({ id: 'complete_state_unchanged', kind: 'state_unchanged' });
  if (scenario.family === 'git-stage') {
    if (typeof path !== 'string' || expected.indexObjectId === null) throw new Error(`missing stage expectation for ${scenario.id}`);
    postconditions.push({ id: 'selected_index_entry', kind: 'index_entry', path, objectId: expected.indexObjectId });
  }
  if (scenario.family === 'git-branch-create') {
    if (typeof branch !== 'string' || expected.mainHead === null) throw new Error(`missing branch expectation for ${scenario.id}`);
    postconditions.push({ id: 'selected_ref', kind: 'ref', name: `refs/heads/${branch}`, objectId: expected.mainHead });
    postconditions.push({ id: 'head_stays_main', kind: 'symbolic_branch', expected: 'main' });
  }
  if (scenario.id === 'git-checkout-h1') {
    postconditions.push({ id: 'selected_head', kind: 'symbolic_branch', expected: 'feature/seed' });
    postconditions.push({ id: 'selected_head_oid', kind: 'head_object_id', expected: expected.featureSeedHead! });
  }
  if (scenario.id === 'git-reset-h1') {
    postconditions.push({ id: 'selected_index_reset', kind: 'index_entry', path: 'docs/rollback.md', objectId: expected.indexObjectId });
  }
  const allowedFinalChangedLayers = allowedFinalLayers(scenario);
  return {
    policyId: `${scenario.id}-policy-v1`,
    expectedOperation: isRejection ? 'rejection' : readOnly ? 'no_state_success' : 'success',
    intendedPaths: typeof path === 'string' ? [path] : [],
    intendedRefs: typeof branch === 'string' ? [`refs/heads/${branch}`] : [],
    allowedCallPaths: scenario.allowedAlternatives,
    readAndStopPaths: scenario.acceptableRejectionPolicy === 'scenario_read_and_stop' ? scenario.allowedAlternatives : [],
    prohibitedTools: scenario.prohibitedTools,
    mutatingTools: ['git_add', 'git_reset', 'git_create_branch', 'git_checkout'],
    cardinality: scenario.expectedCallCardinality,
    expectedSuccessClasses: ['tool_success'],
    expectedRejectionClasses: ['tool_error', 'json_rpc_error'],
    noToolRejectionAllowed: scenario.acceptableRejectionPolicy === 'scenario_no_tool',
    registeredInitialStateHash: initial.stateHash,
    postconditions,
    allowedFinalChangedLayers,
    allowedChangedLayersByTool: {
      git_status: [], git_log: [], git_show: [], git_branch: [], git_diff_unstaged: [], git_diff_staged: [],
      git_add: ['status', 'index', 'objects'], git_reset: ['status', 'index'],
      git_create_branch: ['head_and_refs'],
      git_checkout: ['worktree', 'status', 'index', 'head_and_refs', 'reflogs', 'isolation'],
    },
    allowAnyIndexPath: scenario.id === 'git-checkout-h1',
    allowAnyRef: scenario.id === 'git-checkout-h1',
  };
}

function allowedFinalLayers(scenario: GitGateE1Scenario): GitSpikeSnapshotLayer[] {
  if (scenario.family === 'git-stage') return ['status', 'index', 'objects'];
  if (scenario.family === 'git-branch-create') return ['head_and_refs'];
  if (scenario.id === 'git-checkout-h1') return ['worktree', 'status', 'index', 'head_and_refs', 'reflogs', 'isolation'];
  if (scenario.id === 'git-reset-h1') return ['status', 'index'];
  return [];
}

function transportClass(execution: GitSpikeTrialExecution): GitVerifierTransportClass {
  const clientFailure = execution.calls.find((call) => call.outcomeClass === 'client_failure')?.clientFailureKind;
  if (clientFailure === 'request_timeout') return 'timeout';
  if (clientFailure === 'process_crash') return 'process_crash';
  if (clientFailure === 'transport_eof') return 'transport_eof';
  if (clientFailure !== undefined) return 'malformed_response';
  if (!execution.shutdown.observed || execution.shutdown.childAlive || execution.shutdown.managedProcessGroupAlive === true) return 'process_crash';
  return 'completed';
}

function requiredSnapshot(execution: GitSpikeTrialExecution, stage: string): GitSpikeSnapshot {
  const snapshot = execution.journal.find((entry) => entry.stage === stage)?.snapshot;
  if (snapshot === undefined) throw new Error(`missing ${stage} snapshot for ${execution.trialId}`);
  return snapshot;
}
