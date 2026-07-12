import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/pipeline/store.js';
import { RunStore } from '../src/pipeline/run-store.js';
import { SCHEMA_VERSION, type ApprovedSuite, type CandidateTest } from '../src/schema/types.js';
import { runIssueExperiment } from '../src/examples/issuetracker/experiment.js';
import { runIssueModelSmoke, runIssueModelExperiment, runIssueModelReplay } from '../src/examples/issuetracker/model-run.js';
import { StubModelClient } from './support/stub-model-client.js';
import { issueGoodCitizen } from './support/issue-stub-model-client.js';

function store(): Store {
  return new Store(mkdtempSync(join(tmpdir(), 'oculory-issue-val-')));
}
function runStore(): RunStore {
  return new RunStore(mkdtempSync(join(tmpdir(), 'oculory-issue-runval-')));
}

/* ================= scripted experiment + induced regressions ============ */

test('issue scripted experiment: 100% unmutated pass, detects regressions the schema-smoke baseline misses', async () => {
  const m = await runIssueExperiment(store());
  assert.ok(m.traces_recorded > 0, 'traffic recorded');
  assert.equal(m.other_outcomes, 0, 'every trace verified_success or valid_rejection');
  assert.equal(m.baseline_run_pass_rate, 1, 'unmutated suite must be 100% (no suite noise)');

  // The mined suite catches meaningful behavioural regressions with no false positives...
  assert.equal(m.mined.fp, 0, 'no false positives from the mined suite');
  assert.ok(m.mined.tp >= 8, `mined suite detects the meaningful regressions (got ${m.mined.tp})`);
  // ...that the naive schema-smoke baseline misses entirely.
  assert.equal(m.baseline.tp, 0, 'schema-smoke baseline misses every behavioural regression');
  assert.ok(m.unique_detections_beyond_baseline.length >= 3, 'at least 3 unique detections beyond baseline');
  assert.equal(m.decision, 'meaningful_technical_success');

  // Adversarial policy regressions specifically: invalid user/label and already-closed are detected.
  for (const id of ['invalid_user_allowed', 'invalid_label_allowed', 'already_closed_policy_changed', 'missing_id_succeeds']) {
    const row = m.mutations.find((x) => x.mutation_id === id)!;
    assert.ok(row.golden_detected, `${id} detected by golden checks`);
    assert.equal(row.baseline_detected, false, `${id} missed by the schema-smoke baseline`);
  }
});

/* ============================== model smoke ============================= */

test('issue model-smoke (stub): verifies cleanly, mines advisory candidates, never auto-approves', async () => {
  const s = runStore();
  const summary = await runIssueModelSmoke(
    s,
    { runId: 'issue-model-smoke-1', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 1, mine: true },
    { client: new StubModelClient(issueGoodCitizen()) },
  );
  assert.equal(summary.provider, 'stub');
  assert.equal(summary.trace_count, 6, '2 smoke scenarios × 3 trials');
  assert.equal(summary.outcome_counts.verified_success, 6);
  assert.equal(summary.instability.unstable_groups, 0);
  assert.equal(summary.recommended_next_step, 'run_larger_model_experiment');
  assert.ok(summary.spent_usd > 0, 'spend is metered');

  const candidates = s.loadCandidates();
  assert.equal(candidates.every((c) => c.status === 'candidate'), true, 'nothing auto-approved');
  assert.equal(candidates.every((c) => c.risk_profile?.smoke_only === true), true, 'every smoke candidate flagged smoke-only');
  for (const rel of ['reports/model-smoke-summary.json', 'reports/model-smoke-summary.md', 'reports/recording-instability.json']) {
    assert.equal(existsSync(join(s.root, rel)), true, `${rel} written inside the run dir`);
  }
});

/* =========================== model experiment =========================== */

test('issue model-experiment (stub): capped mining run mines state postconditions, never auto-approves', async () => {
  const s = runStore();
  const summary = await runIssueModelExperiment(
    s,
    { runId: 'issue-me-1', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 5, partition: 'mining', maxScenarios: 2, mine: true, review: true },
    { client: new StubModelClient(issueGoodCitizen()) },
  );
  assert.equal(summary.partition, 'mining');
  assert.equal(summary.scenario_count, 2);
  assert.equal(summary.trace_count, 6);
  assert.equal(summary.verified_success_count, 6);
  assert.ok(summary.candidate_count >= 1);
  assert.equal(s.loadCandidates().every((c) => c.status === 'candidate'), true, 'never auto-approves');
  assert.ok(s.loadCandidates().some((c) => c.assertions.some((a) => a.type === 'state_postcondition')), 'issue state postconditions mined');
  for (const rel of ['reports/model-experiment-summary.json', 'reports/review.md']) {
    assert.equal(existsSync(join(s.root, rel)), true, `${rel} written`);
  }
});

test('issue model-experiment (stub): holdout partition is never mined (leakage isolation)', async () => {
  const s = runStore();
  const summary = await runIssueModelExperiment(
    s,
    { runId: 'issue-me-h', model: 'gpt-4.1-mini', trials: 1, budgetUsd: 5, partition: 'holdout', maxScenarios: 3, mine: true, review: false },
    { client: new StubModelClient(issueGoodCitizen()) },
  );
  assert.ok(summary.trace_count > 0, 'holdout traffic still recorded');
  assert.equal(summary.candidate_count, 0, 'nothing mined from holdout');
});

/* =============================== replay ================================= */

function closeSuite(): ApprovedSuite {
  const test0: CandidateTest = {
    schema_version: SCHEMA_VERSION,
    candidate_id: 'issue-cand-close',
    scenario_family: 'issue_close',
    scenario_ids: ['issue-close-m1'],
    fixture_id: 'issue-tracker-v1',
    intents: ['x'],
    assertions: [
      { assertion_id: 'a1', type: 'tool_required', params: { tool: 'close_issue' }, confidence: 1, support: 2, total: 2, stable: true, provenance: { trace_ids: [], miner: 't' } },
      { assertion_id: 'a2', type: 'state_postcondition', params: { selector_entity: 'id', field: 'exists', expected: true }, confidence: 1, support: 2, total: 2, stable: true, provenance: { trace_ids: [], miner: 't' } },
      { assertion_id: 'a3', type: 'state_postcondition', params: { selector_entity: 'id', field: 'status', expected: 'closed' }, confidence: 1, support: 2, total: 2, stable: true, provenance: { trace_ids: [], miner: 't' } },
    ],
    status: 'approved',
    recommended_gate: 'gate_eligible',
    risk_notes: [],
    review: null,
  };
  return { schema_version: SCHEMA_VERSION, suite_id: 'issue-suite-test', created_at: '2026-07-09T00:00:00.000Z', suite_hash: 'deadbeef00', tests: [test0] };
}

test('issue model-replay (stub): passes clean on a good model', async () => {
  const s = runStore();
  const summary = await runIssueModelReplay(
    s,
    { runId: 'issue-replay-1', model: 'gpt-4.1-mini', trials: 1, budgetUsd: 5, suite: closeSuite() },
    { client: new StubModelClient(issueGoodCitizen()) },
  );
  assert.equal(summary.totals.tests, 3, 'issue_close has m1, m2 (mining) + h1 (holdout)');
  assert.equal(summary.totals.passed, 3);
  assert.equal(summary.totals.replay_unstable, 0);
});

test('issue model-replay (stub): the close_noop regression is caught during replay', async () => {
  const s = runStore();
  const summary = await runIssueModelReplay(
    s,
    { runId: 'issue-replay-reg', model: 'gpt-4.1-mini', trials: 1, budgetUsd: 5, suite: closeSuite(), mutationId: 'close_noop' },
    { client: new StubModelClient(issueGoodCitizen()) },
  );
  assert.ok(summary.totals.failed >= 1, 'the silent-close regression fails the mined status postcondition on replay');
});

test('issue model-replay (stub): budget guard stops replay and reports it', async () => {
  const s = runStore();
  const responder = () => ({ content: 'done', tool_calls: null, usage: { input_tokens: 10_000, output_tokens: 1_000 } });
  const summary = await runIssueModelReplay(
    s,
    { runId: 'issue-replay-budget', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 0.01, suite: closeSuite() },
    { client: new StubModelClient(responder) },
  );
  assert.equal(summary.stopped_on_budget, true);
});

/* ============================= run isolation ============================ */

test('issue run isolation: two model runs write only inside their own run directories', async () => {
  const a = runStore();
  const b = runStore();
  await runIssueModelSmoke(a, { runId: 'iso-a', model: 'gpt-4.1-mini', trials: 1, budgetUsd: 1, mine: true }, { client: new StubModelClient(issueGoodCitizen()) });
  await runIssueModelExperiment(
    b,
    { runId: 'iso-b', model: 'gpt-4.1-mini', trials: 1, budgetUsd: 5, partition: 'mining', maxScenarios: 2, mine: true, review: false },
    { client: new StubModelClient(issueGoodCitizen()) },
  );
  assert.notEqual(a.root, b.root, 'distinct run directories');
  // Each run's traces live under its own root only.
  assert.ok(existsSync(join(a.root, 'traces', 'raw.jsonl')));
  assert.ok(existsSync(join(b.root, 'traces', 'raw.jsonl')));
  // The smoke run (a) recorded only smoke scenarios; the experiment run (b) only its 2 mining scenarios.
  const aScenarios = new Set(a.loadRawTraces().map((t) => t.scenario_id));
  const bScenarios = new Set(b.loadRawTraces().map((t) => t.scenario_id));
  assert.ok([...aScenarios].every((id) => id.startsWith('issue-smoke')), 'run A holds only smoke traces');
  assert.ok(![...bScenarios].some((id) => id.startsWith('issue-smoke')), 'run B holds no smoke traces');
  // Run A's smoke summary never leaks into run B's directory and vice-versa.
  assert.ok(readdirSync(a.root).includes('reports'), 'run A has its own reports dir');
  assert.equal(existsSync(join(a.root, 'reports', 'model-experiment-summary.json')), false, 'run A has no experiment summary (that is run B)');
  assert.equal(existsSync(join(b.root, 'reports', 'model-smoke-summary.json')), false, 'run B has no smoke summary (that is run A)');
});
