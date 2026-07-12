import { canonicalJson, hashJson } from '../../schema/canonical.js';
import type { Json, JsonObject } from '../../schema/types.js';
import { GATE_B_DIRECT_TOOLS, GIT_SPIKE_TARGET } from './config.js';
import {
  applyFixtureEdit,
  stageFixturePath,
  type GitSpikeFixture,
} from './fixture.js';
import type {
  GitSpikeCallOutcomeClass,
  GitSpikeCallSpec,
  GitSpikeTrialPlan,
} from './direct-harness.js';
import type {
  GitSpikeSnapshot,
  GitSpikeSnapshotLayer,
} from './snapshot.js';

export const FORMAL_GATE_B_MATERIALIZATIONS = 20;
export const FORMAL_GATE_B_TRIALS = 10;

export const FORMAL_GATE_B_NORMALIZATION_ALLOWLIST = Object.freeze([
  'fixture_root',
  'sibling_root',
  'trial_root',
  'monotonic_timing',
  'reflog_timestamp_timezone',
  'sentinel_mtime',
  'gitpython_tzoffset_object',
] as const);

export type FormalGateBNormalizationField =
  (typeof FORMAL_GATE_B_NORMALIZATION_ALLOWLIST)[number];

export type FormalGateBObjectiveClass =
  | 'successful_state_changing'
  | 'successful_no_state_change'
  | 'expected_error'
  | 'unchanged_state_rejection';

export interface FormalGateBRecipeDefinition {
  id: string;
  baseSeedVersion: 'git-spike-seed-v1';
  overlay: JsonObject;
  expectedCurrentBranch: 'main';
  expectedHead: string;
  expectedRefs: Readonly<Record<string, string>>;
  expectedWorktreeState: string;
  expectedIndexState: string;
  expectedInitialHash: string;
  expectedSemanticSignature: string;
  planNames: readonly string[];
  prepare: (fixture: GitSpikeFixture) => void;
}

export interface FormalGateBPlanDefinition {
  name: string;
  recipeId: string;
  trialPlan: GitSpikeTrialPlan;
  toolSequence: readonly string[];
  expectedResultClasses: readonly GitSpikeCallOutcomeClass[];
  expectedChangedLayers: readonly (
    | 'unchanged'
    | readonly GitSpikeSnapshotLayer[]
  )[];
  expectedFinalHash: string;
  objectiveClasses: readonly FormalGateBObjectiveClass[];
  targetedIndependentOracle: string;
}

const FIRST_COMMIT = 'cbcce409f62fbd07ca234f03f846f4b270f4aeb9';
const MAIN_HEAD = '781cf1e4988e89a7d3cf3c8eadf9d0ae2a34b698';

const CLEAN_RECIPE_PLANS = Object.freeze([
  'read_only',
  'branch_create',
  'checkout',
  'reject_missing_revision',
  'reject_malformed_add',
  'reject_existing_branch',
  'reject_add_traversal',
  'reject_nonfixture_repo_path',
]);

export const FORMAL_GATE_B_RECIPES: readonly FormalGateBRecipeDefinition[] = [
  {
    id: 'clean-base-v1',
    baseSeedVersion: 'git-spike-seed-v1',
    overlay: { kind: 'none' },
    expectedCurrentBranch: 'main',
    expectedHead: MAIN_HEAD,
    expectedRefs: {
      'refs/heads/feature/seed': FIRST_COMMIT,
      'refs/heads/main': MAIN_HEAD,
    },
    expectedWorktreeState: 'clean and byte-identical to main HEAD',
    expectedIndexState: 'stage-0 index byte-identical to main HEAD',
    expectedInitialHash: '20ed7a344289cb0bb10206858b4604c52f76a589b862d66d666bbb0f7305d498',
    expectedSemanticSignature: 'd65cac8ca654907455e6a29fc665e8f0dc7b3a14376007cd8cf51117bef4ee75',
    planNames: CLEAN_RECIPE_PLANS,
    prepare: () => undefined,
  },
  {
    id: 'unstaged-readme-edit-v1',
    baseSeedVersion: 'git-spike-seed-v1',
    overlay: {
      kind: 'unstaged_edit',
      path: 'README.md',
      content: '# Oculory Git spike\n\nDeterministic staged Gate B edit.\n',
    },
    expectedCurrentBranch: 'main',
    expectedHead: MAIN_HEAD,
    expectedRefs: {
      'refs/heads/feature/seed': FIRST_COMMIT,
      'refs/heads/main': MAIN_HEAD,
    },
    expectedWorktreeState: 'README.md contains the registered unstaged edit; all other files match main HEAD',
    expectedIndexState: 'stage-0 index byte-identical to main HEAD',
    expectedInitialHash: '6e002a192c1f68f384c64e06f7de81436de6b276235d2144796d45dbc062aacd',
    expectedSemanticSignature: 'ed9b8167c37323e194c9ab5011d0e2e898421e0e7a1958051032592472c0758b',
    planNames: ['stage'],
    prepare: (fixture) => applyFixtureEdit(
      fixture,
      'README.md',
      '# Oculory Git spike\n\nDeterministic staged Gate B edit.\n',
    ),
  },
  {
    id: 'staged-rollback-edit-v1',
    baseSeedVersion: 'git-spike-seed-v1',
    overlay: {
      kind: 'staged_edit',
      path: 'docs/rollback.md',
      content: 'Rollback procedure with staged Gate B edit.\n',
    },
    expectedCurrentBranch: 'main',
    expectedHead: MAIN_HEAD,
    expectedRefs: {
      'refs/heads/feature/seed': FIRST_COMMIT,
      'refs/heads/main': MAIN_HEAD,
    },
    expectedWorktreeState: 'docs/rollback.md contains the registered edit; all other files match main HEAD',
    expectedIndexState: 'docs/rollback.md is staged with the registered bytes; all other entries match main HEAD',
    expectedInitialHash: '60bf9d8fab99122452628f99243d0ec1a539ca296f3ef0f3e19ba0c55cfc0df1',
    expectedSemanticSignature: 'bc3927ebb34a1e404c9258a4d46bb09d012b48dfaef93d4988e3acd35fe7609d',
    planNames: ['reset'],
    prepare: (fixture) => {
      applyFixtureEdit(fixture, 'docs/rollback.md', 'Rollback procedure with staged Gate B edit.\n');
      stageFixturePath(fixture, 'docs/rollback.md');
    },
  },
];

function rejectionPlan(
  name: string,
  call: FormalGateBPlanDefinition['trialPlan']['calls'],
): GitSpikeTrialPlan {
  return { name, calls: (fixture) => [call(fixture)[0]!] };
}

export const FORMAL_GATE_B_PLANS: readonly FormalGateBPlanDefinition[] = [
  {
    name: 'read_only',
    recipeId: 'clean-base-v1',
    trialPlan: {
      name: 'read_only',
      calls: (fixture: GitSpikeFixture): readonly GitSpikeCallSpec[] => [
        { tool: 'git_status' },
        { tool: 'git_log', arguments: { max_count: 2 } },
        { tool: 'git_show', arguments: { revision: fixture.mainHead } },
      ],
    },
    toolSequence: ['git_status', 'git_log', 'git_show'],
    expectedResultClasses: ['tool_success', 'tool_success', 'tool_success'],
    expectedChangedLayers: ['unchanged', 'unchanged', 'unchanged'],
    expectedFinalHash: '20ed7a344289cb0bb10206858b4604c52f76a589b862d66d666bbb0f7305d498',
    objectiveClasses: ['successful_no_state_change'],
    targetedIndependentOracle: 'porcelain-v2 cleanliness plus fixed two-commit graph and known HEAD tree; every layer unchanged',
  },
  {
    name: 'stage',
    recipeId: 'unstaged-readme-edit-v1',
    trialPlan: {
      name: 'stage',
      prepare: (fixture: GitSpikeFixture) => recipe('unstaged-readme-edit-v1').prepare(fixture),
      calls: (): readonly GitSpikeCallSpec[] => [
        { tool: 'git_diff_unstaged' },
        { tool: 'git_add', arguments: { files: ['README.md'] } },
        { tool: 'git_diff_staged' },
      ],
    },
    toolSequence: ['git_diff_unstaged', 'git_add', 'git_diff_staged'],
    expectedResultClasses: ['tool_success', 'tool_success', 'tool_success'],
    expectedChangedLayers: ['unchanged', ['status', 'index', 'objects'], 'unchanged'],
    expectedFinalHash: '46e7a18edd013aae5da3e77538b196a3ff6a586588e9530dd155e1e18ac3944e',
    objectiveClasses: ['successful_state_changing'],
    targetedIndependentOracle: 'only README.md index entry becomes the edited worktree blob; worktree bytes, HEAD, and refs remain unchanged',
  },
  {
    name: 'reset',
    recipeId: 'staged-rollback-edit-v1',
    trialPlan: {
      name: 'reset',
      prepare: (fixture: GitSpikeFixture) => recipe('staged-rollback-edit-v1').prepare(fixture),
      calls: (): readonly GitSpikeCallSpec[] => [
        { tool: 'git_diff_staged' },
        { tool: 'git_reset' },
        { tool: 'git_diff_unstaged' },
      ],
    },
    toolSequence: ['git_diff_staged', 'git_reset', 'git_diff_unstaged'],
    expectedResultClasses: ['tool_success', 'tool_success', 'tool_success'],
    expectedChangedLayers: ['unchanged', ['status', 'index'], 'unchanged'],
    expectedFinalHash: '88f6841332c6633fe436af71e1a316d5cb2a2ac39f79f91f7637b2d2e7727e9e',
    objectiveClasses: ['successful_state_changing'],
    targetedIndependentOracle: 'docs/rollback.md index returns to HEAD while its edited worktree bytes remain; no unrelated layer changes',
  },
  {
    name: 'branch_create',
    recipeId: 'clean-base-v1',
    trialPlan: {
      name: 'branch_create',
      calls: (): readonly GitSpikeCallSpec[] => [
        { tool: 'git_branch', arguments: { branch_type: 'local' } },
        { tool: 'git_create_branch', arguments: { branch_name: 'feature/parser', base_branch: 'main' } },
      ],
    },
    toolSequence: ['git_branch', 'git_create_branch'],
    expectedResultClasses: ['tool_success', 'tool_success'],
    expectedChangedLayers: ['unchanged', ['head_and_refs']],
    expectedFinalHash: '1ca779376038b69914a040eb28a9ccdf33868d58165e88b237508bf4230ac400',
    objectiveClasses: ['successful_state_changing'],
    targetedIndependentOracle: 'exactly refs/heads/feature/parser is created at main HEAD; symbolic HEAD remains main',
  },
  {
    name: 'checkout',
    recipeId: 'clean-base-v1',
    trialPlan: {
      name: 'checkout',
      calls: (): readonly GitSpikeCallSpec[] => [
        { tool: 'git_branch', arguments: { branch_type: 'local' } },
        { tool: 'git_checkout', arguments: { branch_name: 'feature/seed' } },
      ],
    },
    toolSequence: ['git_branch', 'git_checkout'],
    expectedResultClasses: ['tool_success', 'tool_success'],
    expectedChangedLayers: ['unchanged', ['worktree', 'status', 'index', 'head_and_refs', 'reflogs', 'isolation']],
    expectedFinalHash: '28904a9893b067253c7380bcbb9a8d5b2993d853651a3b9d5231c4e3e15822f6',
    objectiveClasses: ['successful_state_changing'],
    targetedIndependentOracle: 'symbolic HEAD changes to feature/seed; worktree and index match its tree; ref targets otherwise remain unchanged',
  },
  rejectionDefinition('reject_missing_revision', 'git_show', { revision: 'ghost-revision' }, 'missing revision is rejected and all primary/sibling layers remain unchanged'),
  rejectionDefinition('reject_malformed_add', 'git_add', { files: 'README.md' }, 'malformed array argument is rejected without coercion or mutation'),
  rejectionDefinition('reject_existing_branch', 'git_create_branch', { branch_name: 'feature/seed', base_branch: 'main' }, 'existing branch is rejected with refs, HEAD, index, worktree, objects, sibling, and sentinel unchanged'),
  rejectionDefinition('reject_add_traversal', 'git_add', { files: ['../sibling/sentinel.txt'] }, 'upstream traversal rejection leaves fixture, sibling repository, and sentinel unchanged'),
  {
    ...rejectionDefinition('reject_nonfixture_repo_path', 'git_status', {}, 'non-fixture repo_path is rejected and both repositories plus sentinel remain unchanged'),
    trialPlan: rejectionPlan('reject_nonfixture_repo_path', (fixture) => [{
      tool: 'git_status',
      arguments: { repo_path: fixture.siblingRepositoryRoot },
      reviewedNonFixtureRepositoryPath: true,
      reviewedBoundaryReason: 'nonfixture_repo_path_probe',
    }]),
  },
];

function rejectionDefinition(
  name: string,
  tool: 'git_show' | 'git_add' | 'git_create_branch' | 'git_status',
  args: JsonObject,
  oracle: string,
): FormalGateBPlanDefinition {
  return {
    name,
    recipeId: 'clean-base-v1',
    trialPlan: rejectionPlan(name, () => [{ tool, arguments: args }]),
    toolSequence: [tool],
    expectedResultClasses: ['tool_error'],
    expectedChangedLayers: ['unchanged'],
    expectedFinalHash: '20ed7a344289cb0bb10206858b4604c52f76a589b862d66d666bbb0f7305d498',
    objectiveClasses: ['expected_error', 'unchanged_state_rejection'],
    targetedIndependentOracle: oracle,
  };
}

export interface FormalGateBMaterializationSummary {
  recipeId: string;
  materializationIndex: number;
  stateHash: string;
  semanticSignature: string;
  cleanupPassed: boolean;
  sentinelPassed: boolean;
  rawEvidenceRetained: boolean;
  normalizedFields: readonly string[];
}

export interface FormalGateBTrialSummary {
  planName: string;
  trialIndex: number;
  initialStateHash: string;
  requestedProtocol: string;
  negotiatedProtocol: string;
  serverInfoDigest: string;
  capabilitiesDigest: string;
  inventoryDigest: string;
  discoveryDigest: string;
  schemaDigestsDigest: string;
  resultClasses: readonly string[];
  targetedStateDigest: string;
  finalStateHash: string;
  unchangedState: boolean;
  unexpectedChangedLayers: readonly string[];
  shutdownPassed: boolean;
  cleanupPassed: boolean;
  sentinelPassed: boolean;
  rawEvidenceRetained: boolean;
  normalizedFields: readonly string[];
  toolsCalled: readonly string[];
  passed: boolean;
  reasons: readonly string[];
}

export interface FormalGateBEvaluation {
  decision: 'passed' | 'failed' | 'inconclusive';
  passed: boolean;
  reasons: string[];
  recipeResults: Array<{
    recipeId: string;
    requested: number;
    completed: number;
    stateHashes: string[];
    semanticSignatures: string[];
    cleanupPasses: number;
    sentinelPasses: number;
    passed: boolean;
  }>;
  planResults: Array<{
    planName: string;
    requested: number;
    completed: number;
    stable: boolean;
    cleanupPasses: number;
    sentinelPasses: number;
    passed: boolean;
  }>;
  toolCoverage: Array<{ tool: string; trialCount: number; plans: string[]; passed: boolean }>;
  objectiveCoverage: Array<{ objectiveClass: FormalGateBObjectiveClass; trialCount: number; plans: string[]; passed: boolean }>;
}

export function deduplicateFormalRecipes(
  plans: readonly Pick<FormalGateBPlanDefinition, 'name' | 'recipeId'>[] = FORMAL_GATE_B_PLANS,
): Array<{ recipeId: string; plans: string[] }> {
  const grouped = new Map<string, string[]>();
  for (const plan of plans) {
    const names = grouped.get(plan.recipeId) ?? [];
    names.push(plan.name);
    grouped.set(plan.recipeId, names);
  }
  return [...grouped.entries()].map(([recipeId, names]) => ({ recipeId, plans: names }));
}

export function semanticSnapshotSignature(snapshot: GitSpikeSnapshot): string {
  return hashJson({
    state_hash: snapshot.stateHash,
    layer_hashes: snapshot.layerHashes as unknown as JsonObject,
  });
}

export function evaluateFormalGateB(
  materializations: readonly FormalGateBMaterializationSummary[],
  trials: readonly FormalGateBTrialSummary[],
  requestedMaterializations = FORMAL_GATE_B_MATERIALIZATIONS,
  requestedTrials = FORMAL_GATE_B_TRIALS,
): FormalGateBEvaluation {
  const reasons: string[] = [];
  const allowlist = new Set<string>(FORMAL_GATE_B_NORMALIZATION_ALLOWLIST);
  const recipeResults = FORMAL_GATE_B_RECIPES.map((definition) => {
    const entries = materializations.filter((entry) => entry.recipeId === definition.id);
    const hashes = unique(entries.map((entry) => entry.stateHash));
    const signatures = unique(entries.map((entry) => entry.semanticSignature));
    const cleanupPasses = entries.filter((entry) => entry.cleanupPassed).length;
    const sentinelPasses = entries.filter((entry) => entry.sentinelPassed).length;
    const normalizedValid = entries.every((entry) => entry.normalizedFields.every((field) => allowlist.has(field)));
    const rawRetained = entries.every((entry) => entry.rawEvidenceRetained);
    const passed =
      entries.length >= requestedMaterializations &&
      hashes.length === 1 && hashes[0] === definition.expectedInitialHash &&
      signatures.length === 1 && signatures[0] === definition.expectedSemanticSignature &&
      cleanupPasses === entries.length && sentinelPasses === entries.length &&
      normalizedValid && rawRetained;
    if (!passed) reasons.push(`fixture recipe ${definition.id} failed formal materialization enforcement`);
    return {
      recipeId: definition.id,
      requested: requestedMaterializations,
      completed: entries.length,
      stateHashes: hashes,
      semanticSignatures: signatures,
      cleanupPasses,
      sentinelPasses,
      passed,
    };
  });

  const planResults = FORMAL_GATE_B_PLANS.map((definition) => {
    const entries = trials.filter((entry) => entry.planName === definition.name);
    const stableFields: Array<keyof FormalGateBTrialSummary> = [
      'initialStateHash', 'requestedProtocol', 'negotiatedProtocol', 'serverInfoDigest',
      'capabilitiesDigest', 'inventoryDigest', 'discoveryDigest', 'schemaDigestsDigest',
      'resultClasses', 'targetedStateDigest', 'finalStateHash', 'unchangedState',
    ];
    const stable = stableFields.every((field) =>
      unique(entries.map((entry) => canonicalJson(entry[field] as Json))).length === 1,
    );
    const cleanupPasses = entries.filter((entry) => entry.cleanupPassed).length;
    const sentinelPasses = entries.filter((entry) => entry.sentinelPassed).length;
    const expectedInitial = recipe(definition.recipeId).expectedInitialHash;
    const passed =
      entries.length >= requestedTrials && stable &&
      entries.every((entry) =>
        entry.passed && entry.initialStateHash === expectedInitial &&
        canonicalJson(entry.resultClasses as unknown as Json) === canonicalJson(definition.expectedResultClasses as unknown as Json) &&
        entry.finalStateHash === definition.expectedFinalHash &&
        entry.unexpectedChangedLayers.length === 0 && entry.shutdownPassed &&
        entry.cleanupPassed && entry.sentinelPassed && entry.rawEvidenceRetained &&
        entry.normalizedFields.every((field) => allowlist.has(field)),
      );
    if (!passed) reasons.push(`direct plan ${definition.name} failed formal trial or stability enforcement`);
    return {
      planName: definition.name,
      requested: requestedTrials,
      completed: entries.length,
      stable,
      cleanupPasses,
      sentinelPasses,
      passed,
    };
  });

  const toolCoverage = GATE_B_DIRECT_TOOLS.map((tool) => {
    const covering = trials.filter((trial) => trial.toolsCalled.includes(tool));
    const plans = unique(covering.map((trial) => trial.planName));
    const passed = covering.length >= requestedTrials;
    if (!passed) reasons.push(`direct tool coverage is below threshold for ${tool}`);
    return { tool, trialCount: covering.length, plans, passed };
  });

  const objectiveClasses: FormalGateBObjectiveClass[] = [
    'successful_state_changing',
    'successful_no_state_change',
    'expected_error',
    'unchanged_state_rejection',
  ];
  const objectiveCoverage = objectiveClasses.map((objectiveClass) => {
    const planNames = FORMAL_GATE_B_PLANS
      .filter((plan) => plan.objectiveClasses.includes(objectiveClass))
      .map((plan) => plan.name);
    const entries = trials.filter((trial) => planNames.includes(trial.planName) && trial.passed);
    const plans = unique(entries.map((trial) => trial.planName));
    const passed = entries.length >= requestedTrials;
    if (!passed) reasons.push(`objective-class coverage is below threshold for ${objectiveClass}`);
    return { objectiveClass, trialCount: entries.length, plans, passed };
  });

  const unexpectedRecipes = materializations.filter((entry) => !FORMAL_GATE_B_RECIPES.some((recipeValue) => recipeValue.id === entry.recipeId));
  const unexpectedPlans = trials.filter((entry) => !FORMAL_GATE_B_PLANS.some((plan) => plan.name === entry.planName));
  if (unexpectedRecipes.length > 0) reasons.push('unregistered fixture recipe evidence was supplied');
  if (unexpectedPlans.length > 0) reasons.push('unregistered direct-plan evidence was supplied');

  const passed = reasons.length === 0;
  return {
    decision: passed ? 'passed' : 'failed',
    passed,
    reasons,
    recipeResults,
    planResults,
    toolCoverage,
    objectiveCoverage,
  };
}

export function recipe(id: string): FormalGateBRecipeDefinition {
  const value = FORMAL_GATE_B_RECIPES.find((entry) => entry.id === id);
  if (value === undefined) throw new Error(`unknown formal Gate B recipe: ${id}`);
  return value;
}

export function plan(name: string): FormalGateBPlanDefinition {
  const value = FORMAL_GATE_B_PLANS.find((entry) => entry.name === name);
  if (value === undefined) throw new Error(`unknown formal Gate B plan: ${name}`);
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

if (deduplicateFormalRecipes().length !== FORMAL_GATE_B_RECIPES.length) {
  throw new Error('formal Gate B recipe registry and plan mappings disagree');
}
if (GIT_SPIKE_TARGET.packageVersion !== '2026.7.10') {
  throw new Error('formal Gate B registry may only run against mcp-server-git 2026.7.10');
}
