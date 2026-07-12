import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/pipeline/store.js';
import { RunStore } from '../src/pipeline/run-store.js';
import { SCHEMA_VERSION, type ApprovedSuite, type CandidateTest } from '../src/schema/types.js';
import { approveAllStable } from '../src/pipeline/approval.js';
import { runFsExperiment } from '../src/examples/filesystem/experiment.js';
import { runFsModelSmoke, runFsModelExperiment, runFsModelReplay } from '../src/examples/filesystem/model-run.js';
import { StubModelClient } from './support/stub-model-client.js';
import { fsGoodCitizen } from './support/fs-stub-model-client.js';

function store(): Store {
  return new Store(mkdtempSync(join(tmpdir(), 'oculory-fs-val-')));
}
function runStore(): RunStore {
  return new RunStore(mkdtempSync(join(tmpdir(), 'oculory-fs-run-')));
}

/* ================= scripted experiment + induced regressions ============ */

test('fs scripted experiment: 100% unmutated pass, detects regressions the schema-smoke baseline misses', async () => {
  const m = await runFsExperiment(store());
  assert.ok(m.traces_recorded > 0, 'traffic recorded');
  assert.equal(m.other_outcomes, 0, 'every trace verified_success or valid_rejection');
  assert.equal(m.baseline_run_pass_rate, 1, 'unmutated suite must be 100% (no suite noise)');

  // The mined suite catches meaningful behavioural regressions with no false positives...
  assert.equal(m.mined.fp, 0, 'no false positives from the mined suite');
  assert.ok(m.mined.tp >= 5, `mined suite detects several meaningful regressions (got ${m.mined.tp})`);
  // ...that the naive schema-smoke baseline misses entirely.
  assert.equal(m.baseline.tp, 0, 'schema-smoke baseline misses every behavioural regression');
  assert.ok(m.unique_detections_beyond_baseline.length >= 3, 'at least 3 unique detections beyond baseline');
  assert.equal(m.decision, 'meaningful_technical_success');

  // Security regression specifically: the removed path-traversal rejection is detected.
  const traversal = m.mutations.find((x) => x.mutation_id === 'path_traversal_allowed')!;
  assert.ok(traversal.mined_detected && traversal.golden_detected, 'path_traversal_allowed detected');
  assert.equal(traversal.baseline_detected, false, 'baseline misses the security regression');
});

/* ============================== model smoke ============================= */

test('fs model-smoke (stub): verifies cleanly, mines advisory candidates, never auto-approves', async () => {
  const s = runStore();
  const summary = await runFsModelSmoke(
    s,
    { runId: 'fs-model-smoke-1', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 1, mine: true },
    { client: new StubModelClient(fsGoodCitizen()) },
  );
  assert.equal(summary.provider, 'stub');
  assert.equal(summary.trace_count, 6, '2 smoke scenarios × 3 trials');
  assert.equal(summary.outcome_counts.verified_success, 6);
  assert.equal(summary.instability.unstable_groups, 0);
  assert.equal(summary.recommended_next_step, 'run_larger_model_experiment');
  assert.ok(summary.candidate_count >= 1);
  assert.ok(summary.spent_usd > 0, 'spend is metered');

  const candidates = s.loadCandidates();
  assert.equal(candidates.every((c) => c.status === 'candidate'), true, 'nothing auto-approved');
  assert.equal(candidates.every((c) => c.risk_profile?.smoke_only === true), true, 'every smoke candidate flagged smoke-only');
  for (const rel of ['reports/model-smoke-summary.json', 'reports/model-smoke-summary.md', 'reports/recording-instability.json']) {
    assert.equal(existsSync(join(s.root, rel)), true, `${rel} written inside the run dir`);
  }
});

/* =========================== model experiment =========================== */

test('fs model-experiment (stub): capped mining run, candidates mined, never auto-approved', async () => {
  const s = runStore();
  const summary = await runFsModelExperiment(
    s,
    { runId: 'fs-me-1', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 5, partition: 'mining', maxScenarios: 2, mine: true, review: true },
    { client: new StubModelClient(fsGoodCitizen()) },
  );
  assert.equal(summary.partition, 'mining');
  assert.equal(summary.scenario_count, 2);
  assert.equal(summary.trace_count, 6);
  assert.equal(summary.verified_success_count, 6);
  assert.ok(summary.candidate_count >= 1);
  assert.equal(s.loadCandidates().every((c) => c.status === 'candidate'), true, 'never auto-approves');
  assert.ok(summary.candidate_count >= 1 && s.loadCandidates().some((c) => c.assertions.some((a) => a.type === 'state_postcondition')), 'fs state postconditions mined');
  for (const rel of ['reports/model-experiment-summary.json', 'reports/review.md']) {
    assert.equal(existsSync(join(s.root, rel)), true, `${rel} written`);
  }
});

test('fs model-experiment (stub): holdout partition is never mined (leakage isolation)', async () => {
  const s = runStore();
  const summary = await runFsModelExperiment(
    s,
    { runId: 'fs-me-h', model: 'gpt-4.1-mini', trials: 1, budgetUsd: 5, partition: 'holdout', maxScenarios: 3, mine: true, review: false },
    { client: new StubModelClient(fsGoodCitizen()) },
  );
  assert.ok(summary.trace_count > 0, 'holdout traffic still recorded');
  assert.equal(summary.candidate_count, 0, 'nothing mined from holdout');
});

/* ============================ approval safety =========================== */

test('fs approval safety: adversarial-derived candidates are BLOCKED from bulk approval', async () => {
  const s = runStore();
  await runFsModelExperiment(
    s,
    { runId: 'fs-adv', model: 'gpt-4.1-mini', trials: 2, budgetUsd: 5, partition: 'adversarial', maxScenarios: null, mine: true, review: false },
    { client: new StubModelClient(fsGoodCitizen()) },
  );
  const candidates = s.loadCandidates();
  assert.ok(candidates.length >= 1, 'adversarial candidates mined');
  const result = approveAllStable(candidates, { allowSmoke: false, allowUnstable: false, allowRisky: false, reason: 'x' });
  assert.ok(result.blocked.length >= 1, 'at least one adversarial candidate is blocked without --allow-risky');
  // The blocked candidates are NOT approved.
  const blockedIds = new Set(result.blocked.map((b) => b.candidate_id));
  assert.ok(result.candidates.filter((c) => blockedIds.has(c.candidate_id)).every((c) => c.status === 'candidate'));
});

/* =============================== replay ================================= */

function fsWriteSuite(): ApprovedSuite {
  const test0: CandidateTest = {
    schema_version: SCHEMA_VERSION,
    candidate_id: 'fs-cand-write',
    scenario_family: 'fs_write_file',
    scenario_ids: ['fs-write-m1'],
    fixture_id: 'fs-sandbox-v1',
    intents: ['x'],
    assertions: [
      { assertion_id: 'a1', type: 'tool_required', params: { tool: 'write_file' }, confidence: 1, support: 2, total: 2, stable: true, provenance: { trace_ids: [], miner: 't' } },
      { assertion_id: 'a2', type: 'state_postcondition', params: { check: 'file_exists', path: '@entity:path', expected: true }, confidence: 1, support: 2, total: 2, stable: true, provenance: { trace_ids: [], miner: 't' } },
      { assertion_id: 'a3', type: 'state_postcondition', params: { check: 'content_equals', path: '@entity:path', expected: '@entity:content' }, confidence: 1, support: 2, total: 2, stable: true, provenance: { trace_ids: [], miner: 't' } },
    ],
    status: 'approved',
    recommended_gate: 'gate_eligible',
    risk_notes: [],
    review: null,
  };
  return { schema_version: SCHEMA_VERSION, suite_id: 'fs-suite-test', created_at: '2026-07-08T00:00:00.000Z', suite_hash: 'deadbeef00', tests: [test0] };
}

test('fs model-replay (stub): passes clean on a good model', async () => {
  const s = runStore();
  const summary = await runFsModelReplay(
    s,
    { runId: 'fs-replay-1', model: 'gpt-4.1-mini', trials: 1, budgetUsd: 5, suite: fsWriteSuite() },
    { client: new StubModelClient(fsGoodCitizen()) },
  );
  assert.equal(summary.totals.tests, 3, 'fs_write_file has m1, m2 (mining) + h1 (holdout)');
  assert.equal(summary.totals.passed, 3);
  assert.equal(summary.totals.replay_unstable, 0);
});

test('fs model-replay (stub): the write_silent_noop regression is caught during replay', async () => {
  const s = runStore();
  const summary = await runFsModelReplay(
    s,
    { runId: 'fs-replay-reg', model: 'gpt-4.1-mini', trials: 1, budgetUsd: 5, suite: fsWriteSuite(), mutationId: 'write_silent_noop' },
    { client: new StubModelClient(fsGoodCitizen()) },
  );
  assert.ok(summary.totals.failed >= 1, 'the silent-write regression fails the mined state postcondition on replay');
});

test('fs model-replay (stub): budget guard stops replay and reports it', async () => {
  const s = runStore();
  const responder = () => ({ content: 'done', tool_calls: null, usage: { input_tokens: 10_000, output_tokens: 1_000 } });
  const summary = await runFsModelReplay(
    s,
    { runId: 'fs-replay-budget', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 0.01, suite: fsWriteSuite() },
    { client: new StubModelClient(responder) },
  );
  assert.equal(summary.stopped_on_budget, true);
});
