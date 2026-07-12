import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutcomeLabel } from '../src/schema/types.js';
import type { AgentPolicy } from '../src/runner/policies.js';
import { validate, scenarioCheck } from '../src/schema/validate.js';
import { ISSUE_SCENARIOS, issueScenarioById } from '../src/examples/issuetracker/scenarios.js';
import { issuePlannerDirect, issuePlannerCareful, issuePlannerTerse, ISSUE_DEFAULT_POLICIES } from '../src/examples/issuetracker/policy.js';
import { recordIssueSession } from '../src/examples/issuetracker/record.js';
import { verifyIssueOutcome } from '../src/examples/issuetracker/verifier.js';
import { extractIssueEntities } from '../src/examples/issuetracker/entities.js';

async function labelOf(scenarioId: string, policy: AgentPolicy = issuePlannerDirect, mutationId: string | null = null): Promise<OutcomeLabel> {
  const scenario = issueScenarioById(scenarioId);
  const trace = await recordIssueSession({ scenario, policy, mutationId });
  return verifyIssueOutcome(scenario, trace).label;
}

/* --------------------------- schema conformance ------------------------- */

test('issue-scenarios: every scenario passes the shared scenarioCheck validator', () => {
  for (const s of ISSUE_SCENARIOS) validate(s as never, scenarioCheck, `$.${s.scenario_id}`);
  assert.ok(ISSUE_SCENARIOS.length >= 30, 'a rich catalogue across partitions');
});

test('issue-scenarios: all required families are present', () => {
  const families = new Set(ISSUE_SCENARIOS.map((s) => s.family));
  for (const f of [
    'issue_create', 'issue_read', 'issue_search', 'issue_assign', 'issue_label',
    'issue_comment', 'issue_close', 'issue_reopen', 'issue_list',
    'issue_missing_id', 'issue_ambiguous_title', 'issue_invalid_user',
    'issue_invalid_label', 'issue_already_closed', 'issue_search_readonly',
    'issue_search_read', 'issue_search_close',
  ]) {
    assert.ok(families.has(f), `missing family ${f}`);
  }
});

test('issue-scenarios: the miner never sees holdout (partition discipline)', () => {
  const holdout = ISSUE_SCENARIOS.filter((s) => s.partition === 'holdout');
  assert.ok(holdout.length >= 9, 'holdout re-worded variants exist');
  assert.ok(holdout.some((s) => s.family === 'issue_search_read' || s.family === 'issue_search_close'), 'multi-step holdout cases present');
});

/* ------------------------------ verifier -------------------------------- */

test('issue-verifier: every mining + holdout scenario verifies success under all three scripted policies', async () => {
  for (const scenario of ISSUE_SCENARIOS.filter((s) => s.partition === 'mining' || s.partition === 'holdout')) {
    for (const policy of ISSUE_DEFAULT_POLICIES) {
      const trace = await recordIssueSession({ scenario, policy, mutationId: null });
      const label = verifyIssueOutcome(scenario, trace).label;
      assert.equal(label, 'verified_success', `${scenario.scenario_id} / ${policy.id} → ${label}`);
    }
  }
});

test('issue-verifier: adversarial rejections become valid_rejection (missing/invalid-user/invalid-label/already-closed)', async () => {
  assert.equal(await labelOf('issue-missing-a1'), 'valid_rejection');
  assert.equal(await labelOf('issue-invalid-user-a1'), 'valid_rejection');
  assert.equal(await labelOf('issue-invalid-label-a1'), 'valid_rejection');
  assert.equal(await labelOf('issue-already-closed-a1'), 'valid_rejection');
  // careful policy reads before mutating — still a clean valid_rejection.
  assert.equal(await labelOf('issue-invalid-user-a1', issuePlannerCareful), 'valid_rejection');
});

test('issue-verifier: the safe scripted policy stops on an ambiguous reference (no mutation) → verified_success', async () => {
  assert.equal(await labelOf('issue-ambiguous-a1'), 'verified_success');
  assert.equal(await labelOf('issue-ambiguous-a1', issuePlannerTerse), 'verified_success');
});

test('issue-verifier: an agent that mutates on an ambiguous reference is preserved as verified_failure', async () => {
  const unsafe: AgentPolicy = {
    id: 'scripted/issue-unsafe-closer',
    kind: 'scripted',
    async run(_s, _tools, sink) {
      sink.call('close_issue', { id: 'ISSUE-1' }); // blind close on an ambiguous "login" reference
      return 'I closed an issue.';
    },
  };
  const scenario = issueScenarioById('issue-ambiguous-a1');
  const trace = await recordIssueSession({ scenario, policy: unsafe, mutationId: null });
  assert.equal(verifyIssueOutcome(scenario, trace).label, 'verified_failure', 'a blind mutation on ambiguity is a failure');
});

test('issue-verifier: search-only requests must not mutate — readonly_search_mutates_state is caught (not a clean pass)', async () => {
  assert.equal(await labelOf('issue-search-readonly-a1'), 'verified_success', 'baseline: search only, no mutation');
  // The mutation makes the search change state: the state_unchanged postcondition fails, so the
  // outcome is no longer a clean verified_success — a detected regression (golden check fails).
  const mutated = await labelOf('issue-search-readonly-a1', issuePlannerDirect, 'readonly_search_mutates_state');
  assert.notEqual(mutated, 'verified_success', 'a mutating "search-only" request is not a clean pass');
});

test('issue-verifier: state-changing regressions are caught (close_noop, assign_wrong_user, invalid_user/label, missing)', async () => {
  // A wrong-success mutation leaves the trivial issue_exists passing but the meaningful check failing
  // → partial_success, which is NOT a clean pass and is therefore a detected regression.
  assert.equal(await labelOf('issue-close-m1', issuePlannerDirect, 'close_noop'), 'partial_success');
  assert.equal(await labelOf('issue-assign-m1', issuePlannerDirect, 'assign_wrong_user'), 'partial_success');
  // Accepting an unknown user / disallowed label the scenario expected to be REJECTED lets the
  // write land, so tracker state changes. Under the invalid-input rejection semantics (docs/27,
  // mirrored for INVALID_USER/INVALID_LABEL) an unsafe state mutation on a rejection scenario is a
  // hard verified_failure — the same rule as any other unexpected write here.
  assert.equal(await labelOf('issue-invalid-user-a1', issuePlannerDirect, 'invalid_user_allowed'), 'verified_failure');
  assert.equal(await labelOf('issue-invalid-label-a1', issuePlannerDirect, 'invalid_label_allowed'), 'verified_failure');
  // Fabricating a missing id changes NO state (the placeholder is never persisted) and NOT_FOUND is
  // outside the invalid-input override, so it stays the precise "server accepted what it should have
  // refused" label: invalid_acceptance.
  assert.equal(await labelOf('issue-missing-a1', issuePlannerDirect, 'missing_id_succeeds'), 'invalid_acceptance');
});

test('issue-verifier: multi-step holdout search→act resolves and acts deterministically', async () => {
  assert.equal(await labelOf('issue-search-read-h1'), 'verified_success');
  assert.equal(await labelOf('issue-search-close-h1'), 'verified_success');
});

/* ------------------------- entity extraction ---------------------------- */

test('issue-entities: id / assignee / label / title / body / query / priority extract deterministically', () => {
  assert.deepEqual(extractIssueEntities('Assign issue ISSUE-1 to alice.'), { id: 'ISSUE-1', assignee: 'alice' });
  assert.deepEqual(extractIssueEntities('Add the label bug to issue ISSUE-1.'), { id: 'ISSUE-1', label: 'bug' });
  assert.deepEqual(extractIssueEntities("Comment on issue ISSUE-1 with 'Reproduced on staging.'"), { id: 'ISSUE-1', body: 'Reproduced on staging.' });
  assert.deepEqual(extractIssueEntities("Find all issues matching 'Login'."), { query: 'Login' });
  assert.deepEqual(
    extractIssueEntities("Open a new issue titled 'Search is slow' with body 'Queries take seconds.' and high priority."),
    { title: 'Search is slow', body: 'Queries take seconds.', priority: 'high' },
  );
});

test('issue-entities: an unknown assignee / disallowed label is NOT bound as an entity', () => {
  assert.equal(extractIssueEntities('Assign issue ISSUE-1 to dave.').assignee, undefined, 'dave is not a known user');
  assert.equal(extractIssueEntities('Label issue ISSUE-1 as wontfix.').label, undefined, 'wontfix is not an allowed label');
});

test('issue-entities: a quoted body containing a user/label word is not mistaken for an assignee/label', () => {
  const e = extractIssueEntities("Comment on issue ISSUE-2 with 'ask bob about the urgent bug'");
  assert.equal(e.body, 'ask bob about the urgent bug');
  assert.equal(e.assignee, undefined);
  assert.equal(e.label, undefined);
});

test('issue-entities: an issue id inside a quoted title/body is not taken as the referenced issue', () => {
  // A create intent whose quoted title mentions an id must NOT bind `id` (no real reference).
  const create = extractIssueEntities("Create an issue titled 'Track ISSUE-5 follow-up' with body 'details'");
  assert.equal(create.id, undefined, 'quoted id is not a reference');
  assert.equal(create.title, 'Track ISSUE-5 follow-up');
  // When a real reference and a quoted id both appear, the real (unquoted) one wins.
  const comment = extractIssueEntities("Comment on issue ISSUE-2 with 'see ISSUE-5 for context'");
  assert.equal(comment.id, 'ISSUE-2', 'the unquoted reference wins over a quoted id');
  assert.equal(comment.body, 'see ISSUE-5 for context');
});
