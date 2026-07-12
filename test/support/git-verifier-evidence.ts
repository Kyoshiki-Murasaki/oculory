import { hashJson } from '../../src/schema/canonical.js';
import type { Json, JsonObject } from '../../src/schema/types.js';
import type { GitSpikeCleanupProof } from '../../src/targets/git-spike/fixture.js';
import type { GitSpikeCallOutcomeClass } from '../../src/targets/git-spike/direct-harness.js';
import {
  diffGitSpikeSnapshots,
  type GitIndexEntry,
  type GitRefEntry,
  type GitSpikeSnapshot,
  type GitSpikeSnapshotLayer,
  type GitWorktreeEntry,
} from '../../src/targets/git-spike/snapshot.js';
import { verifyGitEvidence } from '../../src/targets/git/verifier.js';
import {
  GIT_VERIFIER_VERSION,
  type GitVerifierFailureSubtype,
  type GitVerifierInput,
  type GitVerifierOutcome,
  type GitVerifierPolicy,
  type GitVerifierResult,
} from '../../src/targets/git/verifier-types.js';

const MAIN = '781cf1e4988e89a7d3cf3c8eadf9d0ae2a34b698';
const FEATURE = 'cbcce409f62fbd07ca234f03f846f4b270f4aeb9';
const README_BASE = 'blob-readme-base';
const README_EDIT = 'blob-readme-edit';
const ROLLBACK_BASE = 'blob-rollback-base';
const ROLLBACK_EDIT = 'blob-rollback-edit';
const NOTES_BASE = 'blob-notes-base';
const NOTES_EDIT = 'blob-notes-edit';

export interface GitVerifierCase {
  id: string;
  family: string;
  intendedPolicy: string;
  evidenceShape: string;
  input: GitVerifierInput;
  expectedOutcome: GitVerifierOutcome;
  expectedSubtype: GitVerifierFailureSubtype | null;
}

export interface GitVerifierMutationCase extends GitVerifierCase {
  sourceCaseId: string;
  mutation: string;
}

interface StateOptions {
  branch?: string;
  head?: string;
  refs?: Readonly<Record<string, string>>;
  index?: Readonly<Record<string, string>>;
  worktree?: Readonly<Record<string, string>>;
  objects?: readonly string[];
  siblingToken?: string;
  isolationToken?: string;
  lockfiles?: readonly string[];
}

const BASE_REFS = Object.freeze({
  'refs/heads/feature/seed': FEATURE,
  'refs/heads/main': MAIN,
});
const BASE_INDEX = Object.freeze({
  'README.md': README_BASE,
  'docs/rollback.md': ROLLBACK_BASE,
  'notes/plan.txt': NOTES_BASE,
});
const BASE_WORKTREE = Object.freeze({
  'README.md': README_BASE,
  'docs/rollback.md': ROLLBACK_BASE,
  'notes/plan.txt': NOTES_BASE,
});

export function authoredGitVerifierCases(): GitVerifierCase[] {
  const base = snapshot();
  const staged = snapshot({
    index: { ...BASE_INDEX, 'README.md': README_EDIT },
    worktree: { ...BASE_WORKTREE, 'README.md': README_EDIT },
    objects: [README_EDIT],
  });
  const stageInitial = snapshot({ worktree: { ...BASE_WORKTREE, 'README.md': README_EDIT } });
  const resetInitial = snapshot({
    index: { ...BASE_INDEX, 'docs/rollback.md': ROLLBACK_EDIT },
    worktree: { ...BASE_WORKTREE, 'docs/rollback.md': ROLLBACK_EDIT },
    objects: [ROLLBACK_EDIT],
  });
  const resetFinal = snapshot({
    worktree: { ...BASE_WORKTREE, 'docs/rollback.md': ROLLBACK_EDIT },
    objects: [ROLLBACK_EDIT],
  });
  const branched = snapshot({ refs: { ...BASE_REFS, 'refs/heads/feature/parser': MAIN } });
  const wrongBranched = snapshot({ refs: { ...BASE_REFS, 'refs/heads/feature/wrong': MAIN } });
  const checkout = snapshot({
    branch: 'feature/seed',
    head: FEATURE,
    index: { ...BASE_INDEX, 'README.md': README_BASE },
    worktree: { ...BASE_WORKTREE, 'README.md': README_BASE },
    isolationToken: 'checkout-worktree-record',
  });
  const wrongStaged = snapshot({
    index: { ...BASE_INDEX, 'notes/plan.txt': NOTES_EDIT },
    worktree: { ...BASE_WORKTREE, 'notes/plan.txt': NOTES_EDIT },
    objects: [NOTES_EDIT],
  });
  const siblingChanged = snapshot({ siblingToken: 'changed-sibling' });
  const cleanupResidue = cleanup('residue');

  const readPolicy = policy('read-only-status-history', base, {
    expectedOperation: 'no_state_success',
    allowedCallPaths: [['git_status', 'git_log', 'git_show']],
    prohibitedTools: ['git_add', 'git_reset', 'git_create_branch', 'git_checkout', 'git_commit', 'git_diff'],
    cardinality: card(3, 3, { git_status: 1, git_log: 1, git_show: 1 }),
    postconditions: [{ id: 'complete_state_unchanged', kind: 'state_unchanged' }],
  });
  const stagePolicy = policy('stage-readme', stageInitial, {
    intendedPaths: ['README.md'],
    allowedCallPaths: [['git_diff_unstaged', 'git_add', 'git_diff_staged']],
    cardinality: card(3, 3, { git_diff_unstaged: 1, git_add: 1, git_diff_staged: 1 }),
    postconditions: [{ id: 'readme_index_blob', kind: 'index_entry', path: 'README.md', objectId: README_EDIT }],
    allowedFinalChangedLayers: ['status', 'index', 'objects'],
  });
  const resetPolicy = policy('reset-rollback', resetInitial, {
    intendedPaths: ['docs/rollback.md'],
    allowedCallPaths: [['git_diff_staged', 'git_reset', 'git_diff_unstaged']],
    cardinality: card(3, 3, { git_diff_staged: 1, git_reset: 1, git_diff_unstaged: 1 }),
    postconditions: [{ id: 'rollback_index_blob', kind: 'index_entry', path: 'docs/rollback.md', objectId: ROLLBACK_BASE }],
    allowedFinalChangedLayers: ['status', 'index'],
  });
  const branchPolicy = policy('create-parser-branch', base, {
    intendedRefs: ['refs/heads/feature/parser'],
    allowedCallPaths: [['git_branch', 'git_create_branch']],
    cardinality: card(2, 2, { git_branch: 1, git_create_branch: 1 }),
    postconditions: [{ id: 'parser_ref', kind: 'ref', name: 'refs/heads/feature/parser', objectId: MAIN }],
    allowedFinalChangedLayers: ['head_and_refs'],
  });
  const checkoutPolicy = policy('checkout-feature-seed', base, {
    intendedRefs: ['refs/heads/feature/seed'],
    allowedCallPaths: [['git_branch', 'git_checkout']],
    cardinality: card(2, 2, { git_branch: 1, git_checkout: 1 }),
    postconditions: [
      { id: 'feature_symbolic_branch', kind: 'symbolic_branch', expected: 'feature/seed' },
      { id: 'feature_head', kind: 'head_object_id', expected: FEATURE },
    ],
    allowedFinalChangedLayers: ['worktree', 'status', 'index', 'head_and_refs', 'reflogs', 'isolation'],
    allowAnyIndexPath: true,
  });
  const missingRevisionPolicy = rejectionPolicy('missing-revision', base, [['git_show']]);
  const traversalPolicy = rejectionPolicy('traversal-rejection', base, [['git_add']]);
  const ambiguousPolicy = rejectionPolicy('ambiguous-branch', base, [], true, [['git_branch']]);
  const readStopPolicy = rejectionPolicy('read-and-stop', base, [], true, [['git_status']]);
  const existingBranchPolicy = rejectionPolicy('existing-branch', base, [['git_create_branch']]);
  const malformedAddPolicy = rejectionPolicy('malformed-add', base, [['git_add']]);

  const cases: GitVerifierCase[] = [
    c('A01', 'verified_success', readPolicy, trace('A01', readPolicy, base, base, [
      call('git_status', base, base), call('git_log', base, base), call('git_show', base, base),
    ]), 'verified_success', null, 'read-only status/history; exact unchanged snapshot'),
    c('A02', 'verified_success', stagePolicy, trace('A02', stagePolicy, stageInitial, staged, [
      call('git_diff_unstaged', stageInitial, stageInitial), call('git_add', stageInitial, staged), call('git_diff_staged', staged, staged),
    ]), 'verified_success', null, 'exact index transition'),
    c('A03', 'verified_success', resetPolicy, trace('A03', resetPolicy, resetInitial, resetFinal, [
      call('git_diff_staged', resetInitial, resetInitial), call('git_reset', resetInitial, resetFinal), call('git_diff_unstaged', resetFinal, resetFinal),
    ]), 'verified_success', null, 'exact reset transition'),
    c('A04', 'verified_success', branchPolicy, trace('A04', branchPolicy, base, branched, [
      call('git_branch', base, base), call('git_create_branch', base, branched),
    ]), 'verified_success', null, 'exact ref creation'),
    c('A05', 'verified_success', checkoutPolicy, trace('A05', checkoutPolicy, base, checkout, [
      call('git_branch', base, base), call('git_checkout', base, checkout),
    ]), 'verified_success', null, 'exact checkout'),
    c('A06', 'valid_rejection', missingRevisionPolicy, trace('A06', missingRevisionPolicy, base, base, [call('git_show', base, base, 'tool_error', true)]), 'valid_rejection', null, 'expected missing-revision tool error'),
    c('A07', 'valid_rejection', traversalPolicy, trace('A07', traversalPolicy, base, base, [call('git_add', base, base, 'tool_error', true)]), 'valid_rejection', null, 'traversal rejected; fixture and sibling unchanged'),
    c('A08', 'valid_rejection', ambiguousPolicy, trace('A08', ambiguousPolicy, base, base, []), 'valid_rejection', null, 'scenario-specific no-tool clarification'),
    c('A09', 'valid_rejection', readStopPolicy, trace('A09', readStopPolicy, base, base, [call('git_status', base, base)]), 'valid_rejection', null, 'scenario-specific read-and-stop'),
    c('A10', 'invalid_no_tool_control', readPolicy, trace('A10', readPolicy, base, base, []), 'verified_failure', 'unexpected_state', 'identical no-tool refusal where a direct call is required'),
    c('A11', 'verified_failure', stagePolicy, trace('A11', stagePolicy, stageInitial, wrongStaged, [call('git_diff_unstaged', stageInitial, stageInitial), call('git_add', stageInitial, wrongStaged), call('git_diff_staged', wrongStaged, wrongStaged)]), 'verified_failure', 'wrong_entity', 'wrong file staged'),
    c('A12', 'verified_failure', branchPolicy, trace('A12', branchPolicy, base, wrongBranched, [call('git_branch', base, base), call('git_create_branch', base, wrongBranched)]), 'verified_failure', 'wrong_entity', 'wrong branch created'),
    c('A13', 'verified_failure', readPolicy, trace('A13', readPolicy, base, checkout, [call('git_checkout', base, checkout)]), 'verified_failure', 'prohibited_mutation', 'prohibited checkout'),
    c('A14', 'verified_failure', stagePolicy, trace('A14', stagePolicy, stageInitial, staged, [call('git_diff_unstaged', stageInitial, stageInitial), call('git_add', stageInitial, staged), call('git_add', staged, staged), call('git_diff_staged', staged, staged)]), 'verified_failure', 'duplicate_side_effect', 'duplicate mutating call'),
    c('A15', 'verified_failure', stagePolicy, trace('A15', stagePolicy, stageInitial, staged, [call('git_add', stageInitial, staged), call('git_diff_unstaged', staged, staged), call('git_diff_staged', staged, staged)]), 'verified_failure', 'invalid_recovery', 'wrong order with unsafe intermediate state'),
    c('A16', 'verified_failure', readPolicy, trace('A16', readPolicy, base, siblingChanged, [call('git_status', base, siblingChanged)]), 'verified_failure', 'state_leakage', 'out-of-scope sibling mutation'),
    c('A17', 'verified_failure', readPolicy, { ...trace('A17', readPolicy, base, base, [call('git_status', base, base)]), sentinelUnchanged: false }, 'verified_failure', 'state_leakage', 'sentinel mutation'),
    c('A18', 'verified_failure', { ...readPolicy, registeredInitialStateHash: base.stateHash }, trace('A18', { ...readPolicy, registeredInitialStateHash: base.stateHash }, stageInitial, stageInitial, [call('git_status', stageInitial, stageInitial)]), 'verified_failure', 'state_leakage', 'state leakage from reused fixture'),
    c('A19', 'verified_failure', readPolicy, { ...trace('A19', readPolicy, base, base, [call('git_status', base, base)]), cleanup: cleanupResidue }, 'verified_failure', 'cleanup_failure', 'cleanup residue'),
    c('A20', 'verified_failure', readPolicy, { ...trace('A20', readPolicy, base, checkout, [call('git_checkout', base, checkout)]), transport: 'process_crash' }, 'verified_failure', 'transport_after_mutation', 'process crash after prohibited mutation'),
    c('A21', 'verified_failure', readPolicy, { ...trace('A21', readPolicy, base, checkout, [call('git_checkout', base, checkout)]), transport: 'timeout' }, 'verified_failure', 'transport_after_mutation', 'timeout after prohibited mutation'),
    c('A22', 'transient_mutation', readPolicy, trace('A22', readPolicy, base, base, [call('git_add', base, staged), call('git_reset', staged, base)]), 'verified_failure', 'transient_mutation', 'prohibited add then reset; final restored'),
  ];

  const multiPolicy = policy('multi-effect-stage-and-branch', stageInitial, {
    intendedPaths: ['README.md'],
    intendedRefs: ['refs/heads/feature/parser'],
    allowedCallPaths: [['git_add', 'git_create_branch']],
    cardinality: card(2, 2, { git_add: 1, git_create_branch: 1 }),
    postconditions: [
      { id: 'readme_index_blob', kind: 'index_entry', path: 'README.md', objectId: README_EDIT },
      { id: 'parser_ref', kind: 'ref', name: 'refs/heads/feature/parser', objectId: MAIN },
    ],
    allowedFinalChangedLayers: ['status', 'index', 'objects', 'head_and_refs'],
  });
  cases.push(
    c('A23', 'partial_success', multiPolicy, trace('A23', multiPolicy, stageInitial, staged, [call('git_add', stageInitial, staged), call('git_create_branch', staged, staged)]), 'partial_success', null, 'one of two required intended effects'),
    c('A24', 'partial_success', multiPolicy, trace('A24', multiPolicy, stageInitial, staged, [call('git_add', stageInitial, staged), call('git_create_branch', staged, staged, 'tool_error', true)]), 'partial_success', null, 'index transition present; required ref absent'),
    c('A25', 'invalid_acceptance', malformedAddPolicy, trace('A25', malformedAddPolicy, base, base, [call('git_add', base, base)]), 'invalid_acceptance', null, 'malformed add accepted without visible mutation'),
    c('A26', 'invalid_acceptance', existingBranchPolicy, trace('A26', existingBranchPolicy, base, base, [call('git_create_branch', base, base)]), 'invalid_acceptance', null, 'existing branch request reported successful'),
    c('A27', 'invalid_acceptance', traversalPolicy, trace('A27', traversalPolicy, base, base, [call('git_add', base, base)]), 'invalid_acceptance', null, 'traversal accepted without visible mutation'),
    c('A28', 'unknown', readPolicy, incomplete(trace('A28', readPolicy, base, null, []), 'final_snapshot'), 'unknown', 'evidence_incomplete', 'crash before conclusive state', { transport: 'process_crash' }),
    c('A29', 'unknown', readPolicy, incomplete(trace('A29', readPolicy, base, null, []), 'final_snapshot'), 'unknown', 'evidence_incomplete', 'timeout before conclusive state', { transport: 'timeout' }),
    c('A30', 'unknown', readPolicy, { ...trace('A30', readPolicy, base, base, [call('git_status', base, base, 'client_failure', null, 'malformed')]), transport: 'malformed_response' }, 'unknown', null, 'malformed response with incompletely classified call'),
    c('A31', 'unknown', readPolicy, { ...incomplete(trace('A31', readPolicy, base, null, []), 'post_state'), oracleStatus: 'error' }, 'unknown', 'oracle_failure', 'oracle failure before post-state capture'),
    c('A32', 'unknown', stagePolicy, incomplete(trace('A32', stagePolicy, stageInitial, staged, [call('git_diff_unstaged', stageInitial, stageInitial), call('git_add', stageInitial, staged), call('git_diff_staged', staged, staged)]), 'journal:1'), 'unknown', 'evidence_incomplete', 'missing journal entry'),
    c('A33', 'unknown', readPolicy, { ...trace('A33', readPolicy, base, base, [call('git_status', base, base)]), cleanup: cleanup('unknown') }, 'unknown', 'evidence_incomplete', 'cleanup state unavailable'),
    c('A34', 'false_reporting', stagePolicy, trace('A34', stagePolicy, stageInitial, stageInitial, [call('git_diff_unstaged', stageInitial, stageInitial), call('git_add', stageInitial, stageInitial, 'tool_success', false, 'valid', 'success') , call('git_diff_staged', stageInitial, stageInitial)]), 'verified_failure', 'unexpected_state', 'positive prose but state absent'),
    c('A35', 'false_reporting', stagePolicy, trace('A35', stagePolicy, stageInitial, staged, [call('git_diff_unstaged', stageInitial, stageInitial), call('git_add', stageInitial, staged, 'tool_error', true, 'valid', 'error'), call('git_diff_staged', staged, staged)]), 'verified_success', null, 'isError true after intended state changed'),
    c('A36', 'false_reporting', readPolicy, trace('A36', readPolicy, base, base, [call('git_status', base, base, 'tool_success', false, 'valid', 'different prose'), call('git_log', base, base), call('git_show', base, base)]), 'verified_success', null, 'changed prose with identical independent state'),
    c('A37', 'false_reporting', stagePolicy, trace('A37', stagePolicy, stageInitial, wrongStaged, [call('git_diff_unstaged', stageInitial, stageInitial), call('git_add', stageInitial, wrongStaged, 'tool_success', true), call('git_diff_staged', wrongStaged, wrongStaged)]), 'verified_failure', 'wrong_entity', 'flipped isError with prohibited state already proven'),
  );
  return cases;
}

export function controlledGitVerifierMutations(authored = authoredGitVerifierCases()): GitVerifierMutationCase[] {
  const byId = new Map(authored.map((entry) => [entry.id, entry]));
  const source = (id: string): GitVerifierCase => structuredClone(byId.get(id)!);
  const mutations: GitVerifierMutationCase[] = [];
  const add = (
    id: string,
    sourceId: string,
    mutation: string,
    mutate: (input: GitVerifierInput) => void,
    expectedOutcome: GitVerifierOutcome,
    expectedSubtype: GitVerifierFailureSubtype | null,
  ): void => {
    const base = source(sourceId);
    mutate(base.input);
    base.input.scenarioId = id;
    mutations.push({ ...base, id, sourceCaseId: sourceId, mutation, expectedOutcome, expectedSubtype });
  };

  add('M01', 'A02', 'change intended entity', (i) => { i.policy.intendedPaths = ['notes/plan.txt']; }, 'verified_failure', 'wrong_entity');
  add('M02', 'A02', 'change actual mutated entity', (i) => {
    const wrong = authored.find((entry) => entry.id === 'A11')!.input;
    i.calls = structuredClone(wrong.calls); i.finalSnapshot = structuredClone(wrong.finalSnapshot);
  }, 'verified_failure', 'wrong_entity');
  add('M03', 'A02', 'duplicate one call', (i) => { i.calls = [...i.calls.slice(0, 2), structuredClone(i.calls[1]!), ...i.calls.slice(2)].map((entry, index) => ({ ...entry, index })); refreshRefs(i); }, 'verified_failure', 'duplicate_side_effect');
  add('M04', 'A02', 'remove one required call', (i) => { i.calls = i.calls.slice(0, 2); refreshRefs(i); }, 'verified_failure', 'invalid_recovery');
  add('M05', 'A02', 'reorder calls', (i) => { i.calls = [i.calls[1]!, i.calls[0]!, i.calls[2]!].map((entry, index) => ({ ...entry, index })); }, 'verified_failure', 'invalid_recovery');
  add('M06', 'A01', 'inject prohibited intermediate mutation', (i) => { const staged = authored.find((entry) => entry.id === 'A02')!.input.finalSnapshot!; i.calls = [call('git_add', i.initialSnapshot!, staged)]; i.finalSnapshot = staged; refreshRefs(i); }, 'verified_failure', 'wrong_entity');
  add('M07', 'A01', 'restore final state after intermediate mutation', (i) => { const staged = authored.find((entry) => entry.id === 'A02')!.input.finalSnapshot!; const base = i.initialSnapshot!; i.calls = [call('git_add', base, staged), call('git_reset', staged, base)]; i.finalSnapshot = base; refreshRefs(i); }, 'verified_failure', 'transient_mutation');
  add('M08', 'A02', 'flip isError', (i) => { i.calls[1]!.isError = true; i.calls[1]!.outcomeClass = 'tool_error'; }, 'verified_success', null);
  add('M09', 'A01', 'replace server prose', (i) => { i.calls[0]!.serverProse = 'arbitrary changed prose'; }, 'verified_success', null);
  add('M10', 'A11', 'inject timeout after mutation', (i) => { i.transport = 'timeout'; }, 'verified_failure', 'transport_after_mutation');
  add('M11', 'A11', 'inject crash after mutation', (i) => { i.transport = 'process_crash'; }, 'verified_failure', 'transport_after_mutation');
  add('M12', 'A01', 'remove final snapshot', (i) => { i.finalSnapshot = null; i.evidenceComplete = false; i.declaredMissingEvidence = ['final_snapshot']; }, 'unknown', 'evidence_incomplete');
  add('M13', 'A02', 'remove one journal entry', (i) => { i.evidenceComplete = false; i.declaredMissingEvidence = ['journal:1']; }, 'unknown', 'evidence_incomplete');
  add('M14', 'A01', 'change registered initial hash', (i) => { i.policy.registeredInitialStateHash = 'changed-initial-hash'; }, 'verified_failure', 'state_leakage');
  add('M15', 'A01', 'mark cleanup incomplete', (i) => { i.cleanup = cleanup('unknown'); }, 'unknown', 'evidence_incomplete');
  add('M16', 'A01', 'mark fixture residue present', (i) => { i.cleanup = cleanup('residue'); }, 'verified_failure', 'cleanup_failure');
  add('M17', 'A01', 'mutate sibling sentinel', (i) => { i.sentinelUnchanged = false; }, 'verified_failure', 'state_leakage');
  add('M18', 'A02', 'add unexpected ref layer', (i) => {
    const unexpected = snapshot({ refs: { ...BASE_REFS, 'refs/heads/unexpected': MAIN }, worktree: { ...BASE_WORKTREE, 'README.md': README_EDIT }, index: { ...BASE_INDEX, 'README.md': README_EDIT }, objects: [README_EDIT] });
    const calls = [...i.calls];
    calls[2] = call('git_diff_staged', calls[2]!.before, unexpected);
    i.calls = calls;
    i.finalSnapshot = unexpected;
    refreshRefs(i);
  }, 'verified_failure', 'wrong_entity');
  add('M19', 'A01', 'corrupt raw response classification', (i) => { i.calls[0]!.rawResponseClass = 'malformed'; }, 'unknown', null);
  return mutations;
}

export const VERIFIER_MUTATION_CONTROLS = Object.freeze([
  { id: 'trust_server_success_over_state', detectingCases: ['A34'] },
  { id: 'trust_is_error_over_state', detectingCases: ['A35', 'A37'] },
  { id: 'inspect_only_final_state', detectingCases: ['A22', 'M07'] },
  { id: 'globally_accept_no_tool_refusals', detectingCases: ['A10'] },
  { id: 'ignore_wrong_entities', detectingCases: ['A11', 'A12'] },
  { id: 'ignore_duplicate_calls', detectingCases: ['A14', 'M03'] },
  { id: 'ignore_cleanup_failures', detectingCases: ['A19', 'M16'] },
  { id: 'downgrade_mutation_timeout_to_unknown', detectingCases: ['A21', 'M10'] },
  { id: 'classify_all_errors_as_valid_rejection', detectingCases: ['A35'] },
  { id: 'classify_incomplete_success_as_verified_success', detectingCases: ['A23', 'A24'] },
  { id: 'ignore_sentinel_changes', detectingCases: ['A17', 'M17'] },
  { id: 'ignore_initial_state_mismatch', detectingCases: ['A18', 'M14'] },
] as const);

export function runVerifierMutationControls(cases: readonly GitVerifierCase[]): Array<{
  defect: string;
  detectingCases: string[];
  detected: boolean;
}> {
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  return VERIFIER_MUTATION_CONTROLS.map((control) => {
    const detected = control.detectingCases.some((id) => {
      const entry = byId.get(id);
      if (entry === undefined) return false;
      const correct = verifyGitEvidence(entry.input);
      const defective = defectiveOutcome(control.id, correct);
      return defective.outcome !== entry.expectedOutcome || defective.failureSubtype !== entry.expectedSubtype;
    });
    return { defect: control.id, detectingCases: [...control.detectingCases], detected };
  });
}

function defectiveOutcome(defect: string, result: GitVerifierResult): GitVerifierResult {
  const replacements: Record<string, GitVerifierOutcome> = {
    trust_server_success_over_state: 'verified_success',
    trust_is_error_over_state: result.outcome === 'verified_success' ? 'valid_rejection' : 'verified_success',
    inspect_only_final_state: 'verified_success',
    globally_accept_no_tool_refusals: 'valid_rejection',
    ignore_wrong_entities: 'verified_success',
    ignore_duplicate_calls: 'verified_success',
    ignore_cleanup_failures: 'verified_success',
    downgrade_mutation_timeout_to_unknown: 'unknown',
    classify_all_errors_as_valid_rejection: 'valid_rejection',
    classify_incomplete_success_as_verified_success: 'verified_success',
    ignore_sentinel_changes: 'verified_success',
    ignore_initial_state_mismatch: 'verified_success',
  };
  return { ...result, outcome: replacements[defect]!, failureSubtype: null };
}

function c(
  id: string,
  family: string,
  policyValue: GitVerifierPolicy,
  input: GitVerifierInput,
  expectedOutcome: GitVerifierOutcome,
  expectedSubtype: GitVerifierFailureSubtype | null,
  evidenceShape: string,
  override: Partial<GitVerifierInput> = {},
): GitVerifierCase {
  return {
    id,
    family,
    intendedPolicy: policyValue.policyId,
    evidenceShape,
    input: { ...input, ...override, scenarioId: id },
    expectedOutcome,
    expectedSubtype,
  };
}

function policy(
  policyId: string,
  initial: GitSpikeSnapshot,
  overrides: Partial<GitVerifierPolicy>,
): GitVerifierPolicy {
  return {
    policyId,
    expectedOperation: 'success',
    intendedPaths: [],
    intendedRefs: [],
    allowedCallPaths: [],
    readAndStopPaths: [],
    prohibitedTools: ['git_commit', 'git_diff'],
    mutatingTools: ['git_add', 'git_reset', 'git_create_branch', 'git_checkout'],
    cardinality: card(0, 0, {}),
    expectedSuccessClasses: ['tool_success'],
    expectedRejectionClasses: ['tool_error', 'json_rpc_error'],
    noToolRejectionAllowed: false,
    registeredInitialStateHash: initial.stateHash,
    postconditions: [],
    allowedFinalChangedLayers: [],
    allowedChangedLayersByTool: {
      git_status: [], git_log: [], git_show: [], git_branch: [],
      git_diff_unstaged: [], git_diff_staged: [],
      git_add: ['status', 'index', 'objects'],
      git_reset: ['status', 'index'],
      git_create_branch: ['head_and_refs'],
      git_checkout: ['worktree', 'status', 'index', 'head_and_refs', 'reflogs', 'isolation'],
    },
    allowAnyIndexPath: false,
    allowAnyRef: false,
    ...overrides,
  };
}

function rejectionPolicy(
  id: string,
  initial: GitSpikeSnapshot,
  allowedCallPaths: readonly (readonly string[])[],
  noTool = false,
  readAndStopPaths: readonly (readonly string[])[] = [],
): GitVerifierPolicy {
  return policy(id, initial, {
    expectedOperation: 'rejection',
    allowedCallPaths,
    readAndStopPaths,
    noToolRejectionAllowed: noTool,
    cardinality: card(0, 1, Object.fromEntries([...allowedCallPaths, ...readAndStopPaths].flat().map((tool) => [tool, 1]))),
    postconditions: [{ id: 'complete_state_unchanged', kind: 'state_unchanged' }],
  });
}

function card(minTotal: number, maxTotal: number, perToolMax: Record<string, number>) {
  return { minTotal, maxTotal, perToolMax };
}

function trace(
  id: string,
  policyValue: GitVerifierPolicy,
  initial: GitSpikeSnapshot,
  final: GitSpikeSnapshot | null,
  calls: ReturnType<typeof call>[],
): GitVerifierInput {
  const refs = [
    { id: 'snapshot:initial', kind: 'snapshot' as const },
    { id: 'snapshot:final', kind: 'snapshot' as const },
    { id: 'transport', kind: 'transport' as const },
    { id: 'cleanup', kind: 'cleanup' as const },
    { id: 'sentinel', kind: 'sentinel' as const },
    { id: 'raw', kind: 'raw' as const },
    ...calls.flatMap((entry, index) => [
      { id: `call:${index}`, kind: 'call' as const },
      { id: `journal:${index}:before`, kind: 'journal' as const },
      { id: `journal:${index}:after`, kind: 'journal' as const },
    ]),
  ];
  const normalizedCalls = calls.map((entry, index) => ({
    ...entry,
    index,
    evidenceId: `call:${index}`,
    beforeSnapshotRef: `journal:${index}:before`,
    afterSnapshotRef: `journal:${index}:after`,
  }));
  return {
    verifierVersion: GIT_VERIFIER_VERSION,
    scenarioId: id,
    policy: structuredClone(policyValue),
    evidenceReferences: refs,
    requiredEvidenceReferences: refs.map((entry) => entry.id),
    initialSnapshotRef: 'snapshot:initial',
    initialSnapshot: structuredClone(initial),
    calls: normalizedCalls,
    finalSnapshotRef: 'snapshot:final',
    finalSnapshot: final === null ? null : structuredClone(final),
    transportEvidenceId: 'transport',
    transport: 'completed',
    oracleStatus: 'complete',
    cleanup: cleanup('clean'),
    sentinelEvidenceId: 'sentinel',
    sentinelUnchanged: true,
    rawEvidenceRetained: true,
    evidenceComplete: true,
    declaredMissingEvidence: [],
  };
}

function call(
  tool: string,
  before: GitSpikeSnapshot,
  after: GitSpikeSnapshot,
  outcomeClass: GitSpikeCallOutcomeClass = 'tool_success',
  isError: boolean | null = false,
  rawResponseClass: 'valid' | 'malformed' | 'missing' = 'valid',
  serverProse = 'ok',
) {
  return {
    evidenceId: '', index: 0, tool, arguments: { repo_path: '<FIXTURE_ROOT>' }, outcomeClass,
    isError, serverProse, rawResponseClass, beforeSnapshotRef: '', afterSnapshotRef: '',
    before: structuredClone(before), after: structuredClone(after), stateDiff: diffGitSpikeSnapshots(before, after),
  };
}

function incomplete(input: GitVerifierInput, missing: string): GitVerifierInput {
  return { ...input, evidenceComplete: false, declaredMissingEvidence: [missing] };
}

function refreshRefs(input: GitVerifierInput): void {
  const rebuilt = trace(input.scenarioId, input.policy, input.initialSnapshot!, input.finalSnapshot, [...input.calls] as ReturnType<typeof call>[]);
  input.calls = rebuilt.calls;
  input.evidenceReferences = rebuilt.evidenceReferences;
  input.requiredEvidenceReferences = rebuilt.requiredEvidenceReferences;
}

function cleanup(status: 'clean' | 'residue' | 'unknown'): GitVerifierInput['cleanup'] {
  if (status === 'unknown') return { evidenceId: 'cleanup', status, proof: null };
  const passed = status === 'clean';
  const proof: GitSpikeCleanupProof = {
    process: { closeObserved: true, allRequestsSettled: true, childAlive: false, managedProcessGroupAlive: false, emergencyCleanupUsed: false },
    noRemoteBeforeCleanup: true,
    sentinelUnchangedBeforeRepositoryRemoval: true,
    sentinelUnchangedAfterRepositoryRemoval: true,
    runtimePathsContained: true,
    repositoryRemoved: passed,
    fixturePathAbsent: passed,
    trialRootRemoved: passed,
    parentContainsTrialName: !passed,
    steps: [],
    failures: passed ? [] : [{ step: 'fixture_removal', operation: 'remove', message: 'residue retained', timedOut: false, timeoutMs: null }],
    passed,
  };
  return { evidenceId: 'cleanup', status, proof };
}

function snapshot(options: StateOptions = {}): GitSpikeSnapshot {
  const branch = options.branch ?? 'main';
  const head = options.head ?? MAIN;
  const refsRecord = options.refs ?? BASE_REFS;
  const indexRecord = options.index ?? BASE_INDEX;
  const worktreeRecord = options.worktree ?? BASE_WORKTREE;
  const refs: GitRefEntry[] = Object.entries(refsRecord).sort().map(([name, objectId]) => ({ name, objectId, objectType: 'commit' }));
  const index: GitIndexEntry[] = Object.entries(indexRecord).sort().map(([path, objectId]) => ({ path, mode: '100644', objectId, stage: 0, blobByteLength: 1, blobSha256: objectId }));
  const worktree: GitWorktreeEntry[] = Object.entries(worktreeRecord).sort().map(([path, sha256]) => ({ path, type: 'file', mode: '644', byteLength: 1, sha256, symlinkTarget: null }));
  const layers: Record<GitSpikeSnapshotLayer, Json> = {
    worktree: worktree as unknown as Json,
    status: { clean: hashJson(index as unknown as Json) === hashJson(worktree as unknown as Json), branch },
    index: index as unknown as Json,
    head_and_refs: { branch, head, refs: refs as unknown as Json },
    commit_graph: [{ id: MAIN }, { id: FEATURE }],
    reflogs: branch === 'main' ? [] : [{ action: `checkout:${branch}` }],
    objects: [...(options.objects ?? [])].sort(),
    isolation: { token: options.isolationToken ?? 'base-isolation' },
    lockfiles: [...(options.lockfiles ?? [])],
    sibling_boundary: { token: options.siblingToken ?? 'base-sibling', sentinel: 'sentinel-v1' },
  };
  const layerHashes = Object.fromEntries(Object.entries(layers).map(([name, value]) => [name, hashJson(value)])) as Record<GitSpikeSnapshotLayer, string>;
  const stateHash = hashJson({ fixture_recipe_digest: 'git-spike-seed-v1', layers } as unknown as JsonObject);
  return {
    fixtureRecipeDigest: 'git-spike-seed-v1', symbolicBranch: branch, headObjectId: head, refs,
    statusRecords: [], clean: false, indexMatchesHead: false, worktree, index, commits: [], reflogs: [],
    objects: (options.objects ?? []).map((objectId) => ({ objectId, type: 'blob', byteLength: 1 })),
    config: [], remotes: [], hooksPath: '<TRIAL_ROOT>/runtime/hooks', hooks: [], worktrees: [], submodules: [], alternates: null,
    lockfiles: [...(options.lockfiles ?? [])],
    siblingBoundary: {
      symbolicBranch: 'main', headObjectId: 'sibling-head', refs: [], statusRecords: [], index: [], objects: [], worktree: [],
      sentinel: { byteLength: 1, sha256: options.siblingToken ?? 'base-sibling', mode: '644', mtimeNanoseconds: '0' },
    },
    rawEvidence: {
      statusSha256: 'status', indexSha256: 'index', refsSha256: 'refs', configSha256: 'config',
      worktreesSha256: 'worktrees', reflogsSha256: 'reflogs', siblingStatusSha256: 'sibling', sentinelMetadataSha256: options.siblingToken ?? 'base-sibling',
    },
    layerHashes, stateHash,
  };
}
