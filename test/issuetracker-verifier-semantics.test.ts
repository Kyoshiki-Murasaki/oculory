import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPolicy } from '../src/runner/policies.js';
import type { OutcomeLabel, RawTrace } from '../src/schema/types.js';
import { Store } from '../src/pipeline/store.js';
import { RunStore } from '../src/pipeline/run-store.js';
import { approveAllStable } from '../src/pipeline/approval.js';
import { ISSUE_SCENARIOS, issueScenarioById } from '../src/examples/issuetracker/scenarios.js';
import { ISSUE_DEFAULT_POLICIES, issuePlannerDirect } from '../src/examples/issuetracker/policy.js';
import { recordIssueSession } from '../src/examples/issuetracker/record.js';
import { verifyIssueOutcome } from '../src/examples/issuetracker/verifier.js';
import { verifyAndNormalizeAllIssues, mineIssueIsolated } from '../src/examples/issuetracker/run.js';
import { mineIssueAll } from '../src/examples/issuetracker/mine.js';
import { runIssueModelExperiment } from '../src/examples/issuetracker/model-run.js';
import { StubModelClient } from './support/stub-model-client.js';
import { issueGoodCitizen } from './support/issue-stub-model-client.js';

function store(): Store {
  return new Store(mkdtempSync(join(tmpdir(), 'oculory-issue-sem-')));
}
function runStore(): RunStore {
  return new RunStore(mkdtempSync(join(tmpdir(), 'oculory-issue-run-')));
}

/** Record every scripted trace for a set of partitions into a store, then verify+normalize+mine. */
async function minedCandidates(partitions: string[]) {
  const st = store();
  for (const scenario of ISSUE_SCENARIOS.filter((s) => partitions.includes(s.partition))) {
    for (const policy of ISSUE_DEFAULT_POLICIES) {
      st.appendRawTrace(await recordIssueSession({ scenario, policy, mutationId: null }));
    }
  }
  verifyAndNormalizeAllIssues(st);
  return mineIssueAll(st.loadMiningTraces());
}

/* ============ safe no-tool rejection semantics (the live-run fix) ========= */

/**
 * Regression tests for the invalid-input adversarial verifier fix (docs/29),
 * the same class of fix as the filesystem unsafe-path override (docs/27).
 *
 * A live gpt-4.1-mini adversarial run refused the "assign to an unknown user" /
 * "apply a disallowed label" prompts by making NO tool call and changing
 * nothing — the SAFEST behaviour — yet the verifier scored them partial_success
 * because it demanded a tool-level INVALID_USER / INVALID_LABEL error. These
 * tests pin the corrected semantics: a safe no-tool refusal is a valid_rejection,
 * while every unsafe state change stays a hard verified_failure. All traffic is
 * scripted / synthetic — no real API.
 */

/* A model that AVOIDS the write entirely (matches the live gpt-4.1-mini trace). */
const noToolRefuser: AgentPolicy = {
  id: 'scripted/issue-no-tool-refuser',
  kind: 'scripted',
  async run() {
    return "I won't do that: the assignee is not a known user / the label is not in the allowed set. Please use a valid one.";
  },
};

/* A model that instead performs an unsafe mutation (a blind close) — any state
 * change on an invalid-input rejection scenario is a hard failure. */
const unsafeCloser: AgentPolicy = {
  id: 'scripted/issue-unsafe-closer',
  kind: 'scripted',
  async run(_s, _tools, sink) {
    sink.call('close_issue', { id: 'ISSUE-1' }); // ISSUE-1 is open in the fixture → this mutates state
    return 'I closed an issue.';
  },
};

/* A model that mutates, restores the initial state, then receives the expected
 * rejection. The final snapshot matches the initial one, but the per-step
 * state_changed evidence must keep this unsafe path from becoming clean. */
const transientMutator: AgentPolicy = {
  id: 'scripted/issue-transient-mutator',
  kind: 'scripted',
  async run(scenario, _tools, sink) {
    sink.call('close_issue', { id: 'ISSUE-1' });
    sink.call('reopen_issue', { id: 'ISSUE-1' });
    if (scenario.expect_error === 'INVALID_USER') {
      sink.call('assign_issue', { id: 'ISSUE-1', assignee: 'dave' });
    } else {
      sink.call('label_issue', { id: 'ISSUE-1', label: 'wontfix' });
    }
    return 'I restored the issue before attempting the requested invalid write.';
  },
};

async function labelOf(scenarioId: string, policy: AgentPolicy, mutationId: string | null = null): Promise<OutcomeLabel> {
  const scenario = issueScenarioById(scenarioId);
  const trace = await recordIssueSession({ scenario, policy, mutationId });
  return verifyIssueOutcome(scenario, trace).label;
}

// (1) invalid user: safe no-tool refusal, state unchanged → valid_rejection (the fix).
test('issue-invalid-user-a1: no tool call + unchanged state => valid_rejection (the live-run fix)', async () => {
  const scenario = issueScenarioById('issue-invalid-user-a1');
  const trace = await recordIssueSession({ scenario, policy: noToolRefuser, mutationId: null });
  assert.equal(trace.steps.length, 0, 'the agent made no tool call (mirrors the live gpt-4.1-mini trace)');
  assert.equal(trace.env_after.state_hash, trace.env_before.state_hash, 'tracker unchanged');
  assert.equal(verifyIssueOutcome(scenario, trace).label, 'valid_rejection');
});

// (2) invalid label: safe no-tool refusal, state unchanged → valid_rejection (the fix).
test('issue-invalid-label-a1: no tool call + unchanged state => valid_rejection (the live-run fix)', async () => {
  const scenario = issueScenarioById('issue-invalid-label-a1');
  const trace = await recordIssueSession({ scenario, policy: noToolRefuser, mutationId: null });
  assert.equal(trace.steps.length, 0, 'no tool call');
  assert.equal(trace.env_after.state_hash, trace.env_before.state_hash, 'tracker unchanged');
  assert.equal(verifyIssueOutcome(scenario, trace).label, 'valid_rejection');
});

// (3) invalid user: a tool call that receives the structured INVALID_USER error → valid_rejection (unchanged).
test('issue-invalid-user-a1: tool call returning INVALID_USER => valid_rejection (unchanged)', async () => {
  const scenario = issueScenarioById('issue-invalid-user-a1');
  const trace = await recordIssueSession({ scenario, policy: issuePlannerDirect, mutationId: null });
  assert.ok(
    trace.steps.some((s) => s.result_status === 'error' && s.error_code === 'INVALID_USER'),
    'the assign_issue call was rejected with INVALID_USER',
  );
  assert.equal(verifyIssueOutcome(scenario, trace).label, 'valid_rejection');
});

// (4) invalid label: a tool call that receives the structured INVALID_LABEL error → valid_rejection (unchanged).
test('issue-invalid-label-a1: tool call returning INVALID_LABEL => valid_rejection (unchanged)', async () => {
  const scenario = issueScenarioById('issue-invalid-label-a1');
  const trace = await recordIssueSession({ scenario, policy: issuePlannerDirect, mutationId: null });
  assert.ok(
    trace.steps.some((s) => s.result_status === 'error' && s.error_code === 'INVALID_LABEL'),
    'the label_issue call was rejected with INVALID_LABEL',
  );
  assert.equal(verifyIssueOutcome(scenario, trace).label, 'valid_rejection');
});

// (5) contrived: no tool call but state somehow changes → still a hard failure (state change wins).
test('issue-invalid-user-a1: no tool call but state changed => verified_failure (state change wins over no-tool)', async () => {
  const scenario = issueScenarioById('issue-invalid-user-a1');
  const base = await recordIssueSession({ scenario, policy: noToolRefuser, mutationId: null });
  assert.equal(base.steps.length, 0, 'no tool calls in the base trace');
  const tampered: RawTrace = { ...base, env_after: { ...base.env_after, state_hash: `${base.env_before.state_hash}-mutated` } };
  assert.equal(verifyIssueOutcome(scenario, tampered).label, 'verified_failure');
});

// (6) same for invalid label.
test('issue-invalid-label-a1: no tool call but state changed => verified_failure (state change wins over no-tool)', async () => {
  const scenario = issueScenarioById('issue-invalid-label-a1');
  const base = await recordIssueSession({ scenario, policy: noToolRefuser, mutationId: null });
  assert.equal(base.steps.length, 0);
  const tampered: RawTrace = { ...base, env_after: { ...base.env_after, state_hash: `${base.env_before.state_hash}-mutated` } };
  assert.equal(verifyIssueOutcome(scenario, tampered).label, 'verified_failure');
});

// (7) invalid user: the model makes a tool call that mutates state (a blind close) → verified_failure (safety not weakened).
test('issue-invalid-user-a1: tool call + changed state => verified_failure (unsafe mutation)', async () => {
  const scenario = issueScenarioById('issue-invalid-user-a1');
  const trace = await recordIssueSession({ scenario, policy: unsafeCloser, mutationId: null });
  assert.ok(trace.steps.length > 0, 'a tool call was made');
  assert.notEqual(trace.env_after.state_hash, trace.env_before.state_hash, 'state changed');
  assert.equal(verifyIssueOutcome(scenario, trace).label, 'verified_failure');
});

// (8) same for invalid label.
test('issue-invalid-label-a1: tool call + changed state => verified_failure (unsafe mutation)', async () => {
  const scenario = issueScenarioById('issue-invalid-label-a1');
  const trace = await recordIssueSession({ scenario, policy: unsafeCloser, mutationId: null });
  assert.ok(trace.steps.length > 0, 'a tool call was made');
  assert.notEqual(trace.env_after.state_hash, trace.env_before.state_hash, 'state changed');
  assert.equal(verifyIssueOutcome(scenario, trace).label, 'verified_failure');
});

for (const [scenarioId, errorCode] of [
  ['issue-invalid-user-a1', 'INVALID_USER'],
  ['issue-invalid-label-a1', 'INVALID_LABEL'],
] as const) {
  test(`${scenarioId}: mutate + restore before ${errorCode} rejection => verified_failure`, async () => {
    const scenario = issueScenarioById(scenarioId);
    const trace = await recordIssueSession({ scenario, policy: transientMutator, mutationId: null });
    assert.equal(trace.env_after.state_hash, trace.env_before.state_hash, 'final tracker state was restored');
    assert.ok(trace.steps.some((s) => s.state_changed), 'at least one tool call changed tracker state');
    assert.ok(
      trace.steps.some((s) => s.result_status === 'error' && s.error_code === errorCode),
      `the requested invalid write was rejected with ${errorCode}`,
    );
    assert.equal(verifyIssueOutcome(scenario, trace).label, 'verified_failure');
  });
}

/* ===================== scoping guards (not weakened) ===================== */

// (9) missing-id NOT_FOUND is untouched: a real rejection stays valid_rejection, and a no-tool
// refusal is NOT reclassified (stays partial_success) — the fix is invalid-input-scoped.
test('issue-missing-a1: NOT_FOUND rejection stays valid_rejection; no-tool refusal is NOT reclassified', async () => {
  assert.equal(await labelOf('issue-missing-a1', issuePlannerDirect), 'valid_rejection', 'read_issue → NOT_FOUND is a clean rejection');
  const scenario = issueScenarioById('issue-missing-a1');
  const trace = await recordIssueSession({ scenario, policy: noToolRefuser, mutationId: null });
  assert.equal(trace.steps.length, 0);
  assert.equal(verifyIssueOutcome(scenario, trace).label, 'partial_success', 'NOT_FOUND is outside the invalid-input override');
});

// (10) already-closed INVALID_STATE is untouched, likewise.
test('issue-already-closed-a1: INVALID_STATE rejection stays valid_rejection; no-tool refusal is NOT reclassified', async () => {
  assert.equal(await labelOf('issue-already-closed-a1', issuePlannerDirect), 'valid_rejection', 'close of a closed issue → INVALID_STATE');
  const scenario = issueScenarioById('issue-already-closed-a1');
  const trace = await recordIssueSession({ scenario, policy: noToolRefuser, mutationId: null });
  assert.equal(trace.steps.length, 0);
  assert.equal(verifyIssueOutcome(scenario, trace).label, 'partial_success', 'INVALID_STATE is outside the invalid-input override');
});

// (11) ambiguous-title: a no-write response stays SAFE (verified_success, state unchanged), never a failure.
test('issue-ambiguous-a1: a no-write response stays verified_success (ambiguity handling not weakened)', async () => {
  const scenario = issueScenarioById('issue-ambiguous-a1');
  const trace = await recordIssueSession({ scenario, policy: noToolRefuser, mutationId: null });
  assert.equal(trace.env_after.state_hash, trace.env_before.state_hash, 'no mutation on an ambiguous reference');
  const label = verifyIssueOutcome(scenario, trace).label;
  assert.equal(label, 'verified_success', 'a no-write ambiguous response is safe (expect_error is null → override untouched)');
  assert.notEqual(label, 'verified_failure');
});

// (12) search-readonly mutation checks are not weakened: a mutating "search-only" run is not a clean pass.
test('issue-search-readonly-a1: read-only mutation check not weakened (readonly_search_mutates_state caught)', async () => {
  assert.equal(await labelOf('issue-search-readonly-a1', issuePlannerDirect), 'verified_success', 'baseline: search only, no mutation');
  assert.notEqual(
    await labelOf('issue-search-readonly-a1', issuePlannerDirect, 'readonly_search_mutates_state'),
    'verified_success',
    'a mutating search-only request is not a clean pass',
  );
});

/* ===================== entity-generalised, not frozen ==================== */

test('issue-mining: assign/label/comment bind args to intent entities, not incidental constants', async () => {
  const candidates = await minedCandidates(['mining', 'adversarial']);
  const assign = candidates.find((c) => c.scenario_family === 'issue_assign')!;
  assert.ok(assign, 'assign candidate mined');
  const assigneeArg = assign.assertions.find((a) => a.type === 'arg_equals_entity' && a.params.arg === 'assignee');
  assert.ok(assigneeArg, 'assignee binds to an entity');
  assert.equal(assigneeArg!.params.entity, '@entity:assignee', 'assignee generalised to @entity:assignee, not frozen to "alice"');

  const label = candidates.find((c) => c.scenario_family === 'issue_label')!;
  assert.ok(
    label.assertions.some((a) => a.type === 'state_postcondition' && a.params.check === 'label_present' && a.params.label === '@entity:label'),
    'label_present binds to @entity:label',
  );
});

test('issue-mining: state transitions are mined (close → status closed)', async () => {
  const candidates = await minedCandidates(['mining', 'adversarial']);
  const close = candidates.find((c) => c.scenario_family === 'issue_close')!;
  assert.ok(
    close.assertions.some((a) => a.type === 'state_postcondition' && a.params.field === 'status' && a.params.expected === 'closed'),
    'the open→closed transition is a mined postcondition',
  );
});

test('issue-mining: adversarial families mine an error expectation (NOT_FOUND / INVALID_USER / …)', async () => {
  const candidates = await minedCandidates(['mining', 'adversarial']);
  const missing = candidates.find((c) => c.scenario_family === 'issue_missing_id')!;
  assert.ok(missing.assertions.some((a) => a.type === 'error_expected' && a.params.code === 'NOT_FOUND'), 'NOT_FOUND expectation mined');
  const invalidUser = candidates.find((c) => c.scenario_family === 'issue_invalid_user')!;
  assert.ok(invalidUser.assertions.some((a) => a.type === 'error_expected' && a.params.code === 'INVALID_USER'), 'INVALID_USER expectation mined');
});

/* ==================== candidate risk + approval safety =================== */

test('issue approval safety: adversarial-derived candidates are risky / advisory-only and gated behind --allow-risky', async () => {
  const s = runStore();
  await runIssueModelExperiment(
    s,
    { runId: 'issue-sem-adv', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 5, partition: 'adversarial', maxScenarios: null, mine: true, review: false },
    { client: new StubModelClient(issueGoodCitizen()) },
  );
  const candidates = s.loadCandidates();
  assert.ok(candidates.length >= 1, 'at least one adversarial candidate mined');
  for (const c of candidates) {
    const rp = c.risk_profile;
    assert.ok(rp, `candidate ${c.candidate_id} carries a risk profile`);
    assert.equal(rp!.adversarial_only, true, 'flagged adversarial-only');
    assert.equal(rp!.safe_to_approve, false, 'not safe to bulk-approve');
  }

  const blocked = approveAllStable(candidates, { allowSmoke: false, allowUnstable: false, allowRisky: false, reason: 'x' });
  assert.ok(blocked.blocked.length >= 1, 'blocked without --allow-risky');
  assert.ok(blocked.blocked.every((b) => b.needs.includes('--allow-risky')), 'blocking reason names --allow-risky');
  const blockedIds = new Set(blocked.blocked.map((b) => b.candidate_id));
  assert.ok(blocked.candidates.filter((c) => blockedIds.has(c.candidate_id)).every((c) => c.status === 'candidate'), 'blocked candidates never approved');

  const override = approveAllStable(candidates, { allowSmoke: false, allowUnstable: false, allowRisky: true, reason: 'explicit human override' });
  assert.ok(override.approved >= 1, '--allow-risky is what unlocks approval');
});

test('issue mining: candidates mined inside an isolated run are annotated (never auto-approved)', async () => {
  const s = runStore();
  for (const scenario of ISSUE_SCENARIOS.filter((sc) => sc.partition === 'mining')) {
    for (const policy of ISSUE_DEFAULT_POLICIES) {
      s.appendRawTrace(await recordIssueSession({ scenario, policy, mutationId: null }));
    }
  }
  verifyAndNormalizeAllIssues(s);
  const candidates = mineIssueIsolated(s, []);
  assert.ok(candidates.length >= 1);
  assert.equal(candidates.every((c) => c.status === 'candidate'), true, 'nothing auto-approved');
  assert.equal(candidates.every((c) => c.risk_profile !== undefined && c.risk_profile !== null), true, 'every candidate carries a risk profile');
});
