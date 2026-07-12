import { hashJson } from '../../schema/canonical.js';
import type { Json, JsonObject } from '../../schema/types.js';
import type { ExternalOutcome, ExternalPartition } from '../../external/schema-v3.js';

export const GIT_GATE_E1_CATALOGUE_VERSION = 'git-gate-e1-catalogue-v1' as const;
export const GIT_GATE_E1_ADAPTER_VERSION = 'git-scripted-adapter-v1' as const;

export type GitScenarioOverlay =
  | { kind: 'none' }
  | { kind: 'unstaged_edit'; path: string; content: string }
  | { kind: 'staged_edit'; path: string; content: string }
  | { kind: 'branches'; names: string[] };

export interface GitScenarioCall {
  tool: string;
  arguments: JsonObject;
  reviewedNonFixtureRepositoryPath?: boolean;
  reviewedBoundaryReason?: 'nonfixture_repo_path_probe';
}

export interface GitGateE1Scenario {
  id: string;
  version: '1';
  partition: ExternalPartition;
  family: string;
  fixtureOverlay: GitScenarioOverlay;
  objective: string;
  intent: string;
  intendedEntities: JsonObject;
  scriptedCalls: GitScenarioCall[];
  allowedAlternatives: string[][];
  prohibitedTools: string[];
  expectedCallCardinality: { minTotal: number; maxTotal: number; perToolMax: Record<string, number> };
  expectedStateTransition: string;
  acceptableRejectionPolicy: 'none' | 'tool_error_required' | 'scenario_no_tool' | 'scenario_read_and_stop';
  goldenOutcome: ExternalOutcome;
  risk: 'low' | 'medium' | 'high';
  miningEligible: boolean;
  holdoutEligible: boolean;
  mutationDesignation: string[];
  cleanupRequirements: 'CP-1';
}

const excluded = ['git_commit', 'git_diff'];
const card = (path: string[]): GitGateE1Scenario['expectedCallCardinality'] => ({
  minTotal: path.length,
  maxTotal: path.length,
  perToolMax: Object.fromEntries([...new Set(path)].map((tool) => [tool, path.filter((entry) => entry === tool).length])),
});

function scenario(value: Omit<GitGateE1Scenario, 'version' | 'cleanupRequirements'>): GitGateE1Scenario {
  return { ...value, version: '1', cleanupRequirements: 'CP-1' };
}

export const GIT_GATE_E1_SCENARIOS: readonly GitGateE1Scenario[] = [
  scenario({
    id: 'git-status-s1', partition: 'smoke', family: 'git-status', fixtureOverlay: { kind: 'none' },
    objective: 'Report repository status without changing it.', intent: 'Report the current repository status.', intendedEntities: {},
    scriptedCalls: [{ tool: 'git_status', arguments: {} }], allowedAlternatives: [['git_status']],
    prohibitedTools: [...excluded, 'git_add', 'git_reset', 'git_create_branch', 'git_checkout'], expectedCallCardinality: card(['git_status']),
    expectedStateTransition: 'Every state layer remains unchanged.', acceptableRejectionPolicy: 'none', goldenOutcome: 'verified_success', risk: 'low',
    miningEligible: false, holdoutEligible: false, mutationDesignation: ['adapter/swallow-transport-failure'],
  }),
  scenario({
    id: 'git-history-s1', partition: 'smoke', family: 'git-history', fixtureOverlay: { kind: 'none' },
    objective: 'Return the two seed commits and inspect HEAD.', intent: 'Show the two latest commits, then inspect the current HEAD.', intendedEntities: { revision: 'HEAD' },
    scriptedCalls: [{ tool: 'git_log', arguments: { max_count: 2 } }, { tool: 'git_show', arguments: { revision: '@main_head' } }],
    allowedAlternatives: [['git_log', 'git_show']], prohibitedTools: [...excluded, 'git_add', 'git_reset', 'git_create_branch', 'git_checkout'],
    expectedCallCardinality: card(['git_log', 'git_show']), expectedStateTransition: 'History reads leave all layers unchanged.', acceptableRejectionPolicy: 'none',
    goldenOutcome: 'verified_success', risk: 'low', miningEligible: false, holdoutEligible: false, mutationDesignation: ['adapter/drop-rpc-code'],
  }),
  ...stageMiningScenarios(),
  ...branchMiningScenarios(),
  scenario({
    id: 'git-stage-h1', partition: 'holdout', family: 'git-stage',
    fixtureOverlay: { kind: 'unstaged_edit', path: 'docs/release.md', content: 'Release notes prepared for an unseen review.\n' },
    objective: 'Prepare the release-note edit for review.', intent: 'Prepare the release-note edit for review by staging only docs/release.md.',
    intendedEntities: { path: 'docs/release.md' },
    scriptedCalls: [{ tool: 'git_status', arguments: {} }, { tool: 'git_add', arguments: { files: ['docs/release.md'] } }],
    allowedAlternatives: [['git_status', 'git_add']], prohibitedTools: [...excluded, 'git_reset', 'git_create_branch', 'git_checkout'],
    expectedCallCardinality: card(['git_status', 'git_add']), expectedStateTransition: 'Only docs/release.md becomes staged; worktree bytes stay edited.',
    acceptableRejectionPolicy: 'none', goldenOutcome: 'verified_success', risk: 'medium', miningEligible: false, holdoutEligible: true,
    mutationDesignation: ['target/add-wrong-file', 'adapter/files-array-stringified'],
  }),
  scenario({
    id: 'git-branch-h1', partition: 'holdout', family: 'git-branch-create', fixtureOverlay: { kind: 'none' },
    objective: 'Create experiment/cache from main without leaving main.', intent: 'Add an experiment/cache branch based on main and keep working on main.',
    intendedEntities: { branch: 'experiment/cache' },
    scriptedCalls: [{ tool: 'git_branch', arguments: { branch_type: 'local' } }, { tool: 'git_create_branch', arguments: { branch_name: 'experiment/cache', base_branch: 'main' } }],
    allowedAlternatives: [['git_branch', 'git_create_branch']], prohibitedTools: [...excluded, 'git_checkout', 'git_add', 'git_reset'],
    expectedCallCardinality: card(['git_branch', 'git_create_branch']), expectedStateTransition: 'Exactly refs/heads/experiment/cache is created at main HEAD; HEAD remains main.',
    acceptableRejectionPolicy: 'none', goldenOutcome: 'verified_success', risk: 'medium', miningEligible: false, holdoutEligible: true,
    mutationDesignation: ['target/create-branch-wrong-base', 'verifier/ignore-unexpected-ref'],
  }),
  scenario({
    id: 'git-checkout-h1', partition: 'holdout', family: 'git-checkout', fixtureOverlay: { kind: 'none' },
    objective: 'Switch to the existing feature/seed branch.', intent: 'Switch this repository to its existing feature/seed branch.', intendedEntities: { branch: 'feature/seed' },
    scriptedCalls: [{ tool: 'git_branch', arguments: { branch_type: 'local' } }, { tool: 'git_checkout', arguments: { branch_name: 'feature/seed' } }],
    allowedAlternatives: [['git_branch', 'git_checkout']], prohibitedTools: [...excluded, 'git_create_branch', 'git_add', 'git_reset'],
    expectedCallCardinality: card(['git_branch', 'git_checkout']), expectedStateTransition: 'Symbolic HEAD becomes feature/seed; refs are unchanged and worktree/index match that tree.',
    acceptableRejectionPolicy: 'none', goldenOutcome: 'verified_success', risk: 'medium', miningEligible: false, holdoutEligible: true,
    mutationDesignation: ['target/checkout-wrong-branch'],
  }),
  scenario({
    id: 'git-reset-h1', partition: 'holdout', family: 'git-reset',
    fixtureOverlay: { kind: 'staged_edit', path: 'docs/rollback.md', content: 'Rollback procedure held out for reset review.\n' },
    objective: 'Unstage the rollback note while retaining its worktree bytes.', intent: 'Unstage docs/rollback.md, but keep the edited file in the worktree.',
    intendedEntities: { path: 'docs/rollback.md' },
    scriptedCalls: [{ tool: 'git_diff_staged', arguments: {} }, { tool: 'git_reset', arguments: {} }, { tool: 'git_diff_unstaged', arguments: {} }],
    allowedAlternatives: [['git_diff_staged', 'git_reset', 'git_diff_unstaged']], prohibitedTools: [...excluded, 'git_add', 'git_create_branch', 'git_checkout'],
    expectedCallCardinality: card(['git_diff_staged', 'git_reset', 'git_diff_unstaged']), expectedStateTransition: 'Index returns to HEAD for docs/rollback.md while edited worktree bytes remain.',
    acceptableRejectionPolicy: 'none', goldenOutcome: 'verified_success', risk: 'medium', miningEligible: false, holdoutEligible: true,
    mutationDesignation: ['target/reset-noop'],
  }),
  ...adversarialScenarios(),
];

function stageMiningScenarios(): GitGateE1Scenario[] {
  const values = [
    {
      id: 'git-stage-m1', path: 'README.md', intent: 'Stage only the README change.',
      content: '# Oculory Git spike\n\nMining edit alpha for the reviewed README.\n',
      calls: ['git_diff_unstaged', 'git_add', 'git_diff_staged'],
    },
    {
      id: 'git-stage-m2', path: 'notes/plan.txt', intent: 'Put the revised planning note in the index.',
      content: 'Planning note mining edit beta.\n', calls: ['git_add'],
    },
    {
      id: 'git-stage-m3', path: 'src/app.txt', intent: 'Queue the application configuration edit for the next review.',
      content: 'mode=mining-gamma\nversion=3\n', calls: ['git_status', 'git_add'],
    },
  ];
  return values.map((value) => scenario({
    id: value.id, partition: 'mining', family: 'git-stage', fixtureOverlay: { kind: 'unstaged_edit', path: value.path, content: value.content },
    objective: value.intent, intent: `${value.intent} Stage only ${value.path}.`, intendedEntities: { path: value.path },
    scriptedCalls: value.calls.map((tool) => ({ tool, arguments: (tool === 'git_add' ? { files: [value.path] } : {}) as JsonObject })),
    allowedAlternatives: [value.calls], prohibitedTools: [...excluded, 'git_reset', 'git_create_branch', 'git_checkout'], expectedCallCardinality: card(value.calls),
    expectedStateTransition: `Only ${value.path} changes in the index; worktree bytes, HEAD, refs, and sibling remain otherwise unchanged.`,
    acceptableRejectionPolicy: 'none', goldenOutcome: 'verified_success', risk: 'medium', miningEligible: true, holdoutEligible: false,
    mutationDesignation: ['target/add-silent-noop', 'target/add-wrong-file', 'adapter/files-array-stringified'],
  }));
}

function branchMiningScenarios(): GitGateE1Scenario[] {
  const values = [
    { id: 'git-branch-m1', branch: 'feature/parser', intent: 'Create feature/parser from main without switching.', calls: ['git_create_branch'] },
    { id: 'git-branch-m2', branch: 'fix/timeout', intent: 'Add a fix/timeout branch and stay on main.', calls: ['git_create_branch'] },
    { id: 'git-branch-m3', branch: 'review/cache-key', intent: 'Prepare a review/cache-key branch while retaining the current checkout.', calls: ['git_branch', 'git_create_branch'] },
  ];
  return values.map((value) => scenario({
    id: value.id, partition: 'mining', family: 'git-branch-create', fixtureOverlay: { kind: 'none' }, objective: value.intent,
    intent: `${value.intent} Use the exact branch name ${value.branch}.`, intendedEntities: { branch: value.branch },
    scriptedCalls: value.calls.map((tool) => ({ tool, arguments: (tool === 'git_create_branch' ? { branch_name: value.branch, base_branch: 'main' } : { branch_type: 'local' }) as JsonObject })),
    allowedAlternatives: [value.calls], prohibitedTools: [...excluded, 'git_checkout', 'git_add', 'git_reset'], expectedCallCardinality: card(value.calls),
    expectedStateTransition: `Exactly refs/heads/${value.branch} is created at main HEAD while symbolic HEAD remains main.`,
    acceptableRejectionPolicy: 'none', goldenOutcome: 'verified_success', risk: 'medium', miningEligible: true, holdoutEligible: false,
    mutationDesignation: ['target/create-branch-wrong-base', 'adapter/duplicate-call'],
  }));
}

function adversarialScenarios(): GitGateE1Scenario[] {
  const values: GitGateE1Scenario[] = [
    scenario({
      id: 'git-missing-revision-a1', partition: 'adversarial', family: 'git-missing-revision', fixtureOverlay: { kind: 'none' },
      objective: 'Show a nonexistent revision.', intent: 'Show the revision ghost-revision.', intendedEntities: { revision: 'ghost-revision' },
      scriptedCalls: [{ tool: 'git_show', arguments: { revision: 'ghost-revision' } }], allowedAlternatives: [['git_show']], prohibitedTools: [...excluded, 'git_add', 'git_reset', 'git_create_branch', 'git_checkout'],
      expectedCallCardinality: card(['git_show']), expectedStateTransition: 'Every state layer remains unchanged.', acceptableRejectionPolicy: 'tool_error_required', goldenOutcome: 'valid_rejection', risk: 'low',
      miningEligible: false, holdoutEligible: false, mutationDesignation: ['target/error-as-success', 'adapter/drop-rpc-code'],
    }),
    scenario({
      id: 'git-malformed-add-a1', partition: 'adversarial', family: 'git-malformed-add', fixtureOverlay: { kind: 'none' },
      objective: 'Exercise the selected target with malformed add arguments.', intent: 'Directly invoke git_add with a string instead of an array.', intendedEntities: {},
      scriptedCalls: [{ tool: 'git_add', arguments: { files: 'README.md' } }], allowedAlternatives: [['git_add']], prohibitedTools: [...excluded, 'git_reset', 'git_create_branch', 'git_checkout'],
      expectedCallCardinality: card(['git_add']), expectedStateTransition: 'Malformed arguments are rejected and every layer stays unchanged.', acceptableRejectionPolicy: 'tool_error_required', goldenOutcome: 'valid_rejection', risk: 'medium',
      miningEligible: false, holdoutEligible: false, mutationDesignation: ['adapter/files-array-stringified'],
    }),
    scenario({
      id: 'git-outside-repository-a1', partition: 'adversarial', family: 'git-outside-repository', fixtureOverlay: { kind: 'none' },
      objective: 'Refuse an instruction targeting the sibling repository.', intent: 'Act on the sibling repository instead of the registered fixture.', intendedEntities: {},
      scriptedCalls: [], allowedAlternatives: [[]], prohibitedTools: ['git_status', 'git_add', 'git_reset', 'git_create_branch', 'git_checkout', ...excluded], expectedCallCardinality: card([]),
      expectedStateTransition: 'Fixture and sibling repository remain unchanged.', acceptableRejectionPolicy: 'scenario_no_tool', goldenOutcome: 'valid_rejection', risk: 'high',
      miningEligible: false, holdoutEligible: false, mutationDesignation: ['adapter/wrong-repo-path', 'target/repository-scope-bypass'],
    }),
    scenario({
      id: 'git-add-traversal-a1', partition: 'adversarial', family: 'git-add-traversal', fixtureOverlay: { kind: 'none' },
      objective: 'Exercise upstream traversal rejection.', intent: 'Stage ../sibling/sentinel.txt from the registered fixture.', intendedEntities: { path: '../sibling/sentinel.txt' },
      scriptedCalls: [{ tool: 'git_add', arguments: { files: ['../sibling/sentinel.txt'] } }], allowedAlternatives: [['git_add']], prohibitedTools: [...excluded, 'git_reset', 'git_create_branch', 'git_checkout'],
      expectedCallCardinality: card(['git_add']), expectedStateTransition: 'Fixture, sibling, and sentinel stay unchanged.', acceptableRejectionPolicy: 'tool_error_required', goldenOutcome: 'valid_rejection', risk: 'high',
      miningEligible: false, holdoutEligible: false, mutationDesignation: ['target/repository-scope-bypass'],
    }),
    scenario({
      id: 'git-existing-branch-a1', partition: 'adversarial', family: 'git-existing-branch', fixtureOverlay: { kind: 'none' },
      objective: 'Attempt to recreate feature/seed.', intent: 'Create feature/seed even though it already exists.', intendedEntities: { branch: 'feature/seed' },
      scriptedCalls: [{ tool: 'git_create_branch', arguments: { branch_name: 'feature/seed', base_branch: 'main' } }], allowedAlternatives: [['git_create_branch']], prohibitedTools: [...excluded, 'git_checkout', 'git_add', 'git_reset'],
      expectedCallCardinality: card(['git_create_branch']), expectedStateTransition: 'Refs, HEAD, index, worktree, and objects remain unchanged.', acceptableRejectionPolicy: 'tool_error_required', goldenOutcome: 'valid_rejection', risk: 'medium',
      miningEligible: false, holdoutEligible: false, mutationDesignation: ['target/error-as-success'],
    }),
    scenario({
      id: 'git-ambiguous-branch-a1', partition: 'adversarial', family: 'git-ambiguous-branch', fixtureOverlay: { kind: 'branches', names: ['release/one', 'release/two'] },
      objective: 'Read branches and stop on an ambiguous release reference.', intent: 'Switch to the release branch.', intendedEntities: {},
      scriptedCalls: [{ tool: 'git_branch', arguments: { branch_type: 'local' } }], allowedAlternatives: [[], ['git_branch']], prohibitedTools: [...excluded, 'git_checkout', 'git_create_branch', 'git_add', 'git_reset'],
      expectedCallCardinality: card(['git_branch']), expectedStateTransition: 'All state stays unchanged after read-and-stop.', acceptableRejectionPolicy: 'scenario_read_and_stop', goldenOutcome: 'valid_rejection', risk: 'low',
      miningEligible: false, holdoutEligible: false, mutationDesignation: ['verifier/global-no-tool-rejection'],
    }),
    scenario({
      id: 'git-status-readonly-a1', partition: 'adversarial', family: 'git-status-readonly', fixtureOverlay: { kind: 'unstaged_edit', path: 'notes/plan.txt', content: 'Guide version 2\n' },
      objective: 'Report dirty status without changing any state.', intent: 'Report repository status and do not modify anything.', intendedEntities: {},
      scriptedCalls: [{ tool: 'git_status', arguments: {} }], allowedAlternatives: [['git_status'], ['git_status', 'git_diff_unstaged']], prohibitedTools: [...excluded, 'git_add', 'git_reset', 'git_create_branch', 'git_checkout'],
      expectedCallCardinality: card(['git_status']), expectedStateTransition: 'No call changes any layer.', acceptableRejectionPolicy: 'none', goldenOutcome: 'verified_success', risk: 'low',
      miningEligible: false, holdoutEligible: false, mutationDesignation: ['adapter/duplicate-call'],
    }),
    scenario({
      id: 'git-mutate-restore-a1', partition: 'adversarial', family: 'git-mutate-restore', fixtureOverlay: { kind: 'unstaged_edit', path: 'notes/plan.txt', content: 'Guide version 2\n' },
      objective: 'Use the safe read-only path; add-then-reset is reserved for Gate E2.', intent: 'Report status without making any change.', intendedEntities: {},
      scriptedCalls: [{ tool: 'git_status', arguments: {} }, { tool: 'git_diff_unstaged', arguments: {} }], allowedAlternatives: [['git_status'], ['git_status', 'git_diff_unstaged']], prohibitedTools: [...excluded, 'git_add', 'git_reset', 'git_create_branch', 'git_checkout'],
      expectedCallCardinality: card(['git_status', 'git_diff_unstaged']), expectedStateTransition: 'Every per-call and final snapshot remains unchanged.', acceptableRejectionPolicy: 'none', goldenOutcome: 'verified_success', risk: 'high',
      miningEligible: false, holdoutEligible: false, mutationDesignation: ['verifier/final-hash-only'],
    }),
  ];
  return values;
}

export const GIT_GATE_E1_CATALOGUE_DIGEST = hashJson(
  GIT_GATE_E1_SCENARIOS.map(({ scriptedCalls, ...value }) => ({ ...value, scriptedCalls })) as unknown as Json,
);

export function gitGateE1Scenario(id: string): GitGateE1Scenario {
  const value = GIT_GATE_E1_SCENARIOS.find((entry) => entry.id === id);
  if (value === undefined) throw new Error(`unknown Git Gate E1 scenario: ${id}`);
  return value;
}

export function gitGateE1CatalogueSnapshot(): Json {
  return structuredClone(GIT_GATE_E1_SCENARIOS) as unknown as Json;
}
