import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../src/pipeline/run-store.js';
import {
  recommendExperiment,
  recommendSmoke,
  runModelExperiment,
  runModelReplay,
  runModelSmoke,
  selectScenarios,
} from '../src/pipeline/model-run.js';
import { SCENARIOS, scenariosByPartition } from '../src/runner/catalogue.js';
import { loadFixture } from '../src/pipeline/experiment.js';
import { SCHEMA_VERSION, type ApprovedSuite, type CandidateTest } from '../src/schema/types.js';
import {
  StubModelClient,
  finalMessage,
  goodCitizen,
  hasToolResult,
  intentOf,
  toolCall,
} from './support/stub-model-client.js';

const fixture = loadFixture('fixtures/seed.json');

function runStore(): RunStore {
  return new RunStore(mkdtempSync(join(tmpdir(), 'oculory-modelrun-')));
}

/* ============================== model-smoke ============================== */

test('model-smoke: clean run verifies, mines advisory candidates, recommends scaling up', async () => {
  const store = runStore();
  const summary = await runModelSmoke(
    store,
    { runId: 'model-smoke-1', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 1, mine: true },
    { client: new StubModelClient(goodCitizen()), fixture },
  );

  assert.equal(summary.provider, 'stub');
  assert.equal(summary.trace_count, 6, '2 smoke scenarios × 3 trials');
  assert.equal(summary.outcome_counts.verified_success, 6);
  assert.equal(summary.instability.unstable_groups, 0);
  assert.equal(summary.recommended_next_step, 'run_larger_model_experiment');
  assert.ok(summary.candidate_count >= 1, 'smoke traffic yields at least one candidate');
  assert.equal(summary.risky_candidate_count, summary.candidate_count, 'every smoke candidate is advisory-only');
  assert.ok(summary.spent_usd > 0, 'spend is metered');

  // Nothing was auto-approved and every candidate is flagged smoke-only.
  const candidates = store.loadCandidates();
  assert.equal(candidates.every((c) => c.status === 'candidate'), true);
  assert.equal(candidates.every((c) => c.risk_profile?.smoke_only === true), true);

  // Isolated artifacts exist inside the run directory.
  for (const rel of ['reports/model-smoke-summary.json', 'reports/model-smoke-summary.md', 'reports/recording-instability.json']) {
    assert.equal(existsSync(join(store.root, rel)), true, `${rel} written`);
  }
  const written = JSON.parse(readFileSync(join(store.root, 'reports', 'model-smoke-summary.json'), 'utf8'));
  assert.equal(written.run_id, 'model-smoke-1');
});

test('model-smoke: unstable trial group is detected and downgrades the recommendation', async () => {
  const store = runStore();
  let completeSessions = 0;
  const responder = (_i: number, req: Parameters<typeof intentOf>[0]) => {
    if (hasToolResult(req)) return finalMessage('Done.');
    const intent = intentOf(req);
    if (/list/.test(intent)) return toolCall('list_tasks', {});
    const useUpdate = completeSessions++ === 1; // the 2nd complete trial takes a different path
    return useUpdate ? toolCall('update_task', { id: 1, status: 'done' }) : toolCall('complete_task', { id: 1 });
  };
  const summary = await runModelSmoke(
    store,
    { runId: 'r', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 1, mine: true },
    { client: new StubModelClient(responder), fixture },
  );
  assert.ok(summary.instability.unstable_groups >= 1);
  assert.ok(summary.instability.unstable_scenario_ids.includes('smoke-complete-1'));
  assert.equal(summary.recommended_next_step, 'inspect_traces');
});

test('model-smoke: a model that does not mutate yields non-verified outcomes, not "scale up"', async () => {
  const store = runStore();
  const responder = (_i: number, req: Parameters<typeof intentOf>[0]) => {
    if (hasToolResult(req)) return finalMessage('Done.');
    if (/list/.test(intentOf(req))) return toolCall('list_tasks', {});
    return finalMessage('I have completed it.'); // never actually completes anything
  };
  const summary = await runModelSmoke(
    store,
    { runId: 'r', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 1, mine: true },
    { client: new StubModelClient(responder), fixture },
  );
  assert.equal(summary.outcome_counts.verified_failure, 3);
  assert.notEqual(summary.recommended_next_step, 'run_larger_model_experiment');
});

test('model-smoke: malformed model tool calls are captured and recommend fixing the adapter', async () => {
  const store = runStore();
  const responder = (_i: number, req: Parameters<typeof intentOf>[0]) => {
    if (hasToolResult(req)) return finalMessage('Done.');
    if (/list/.test(intentOf(req))) return toolCall('list_tasks', {});
    return { content: null, tool_calls: [{ id: 'c', name: 'complete_task', argumentsJson: '{not json' }], usage: null };
  };
  const summary = await runModelSmoke(
    store,
    { runId: 'r', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 1, mine: true },
    { client: new StubModelClient(responder), fixture },
  );
  assert.ok(summary.trace_count > 0, 'the well-formed list traces still recorded');
  assert.equal(summary.recording_errors.some((e) => e.kind === 'malformed_tool_call'), true);
  assert.equal(summary.recommended_next_step, 'fix_provider_adapter');
});

test('model-smoke: budget guard fails closed mid-run and is reported, not hidden', async () => {
  const store = runStore();
  const responder = () => finalMessage('done', { input_tokens: 10_000, output_tokens: 1_000 });
  const summary = await runModelSmoke(
    store,
    { runId: 'r', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 0.01, mine: false },
    { client: new StubModelClient(responder), fixture },
  );
  assert.equal(summary.recording_errors.some((e) => e.kind === 'budget_exceeded'), true);
  assert.ok(summary.trace_count < 6, 'recording stopped before all trials ran');
  assert.ok(summary.spent_usd > 0);
});

/* ============================ model-experiment =========================== */

test('selectScenarios: partition filtering and max-scenarios cap', () => {
  assert.equal(selectScenarios('mining', null).length, scenariosByPartition('mining').length);
  assert.equal(selectScenarios('mining', null).every((s) => s.partition === 'mining'), true);
  assert.equal(selectScenarios('all', null).length, SCENARIOS.length);
  assert.equal(selectScenarios('mining', 2).length, 2);
  assert.equal(selectScenarios('adversarial', null).every((s) => s.partition === 'adversarial'), true);
});

test('model-experiment: capped mining run — counts, isolation, no auto-approval, replay recommendation', async () => {
  const store = runStore();
  const summary = await runModelExperiment(
    store,
    { runId: 'me-1', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 5, partition: 'mining', maxScenarios: 2, mine: true, review: true },
    { client: new StubModelClient(goodCitizen()), fixture },
  );
  assert.equal(summary.partition, 'mining');
  assert.equal(summary.scenario_count, 2);
  assert.equal(summary.trace_count, 6);
  assert.equal(summary.verified_success_count, 6);
  assert.ok(summary.candidate_count >= 1);
  assert.equal(store.loadCandidates().every((c) => c.status === 'candidate'), true, 'never auto-approves');
  assert.equal(summary.recommendation, 'inspect_candidates_then_try_replay');
  for (const rel of ['reports/model-experiment-summary.json', 'reports/model-experiment-summary.md', 'reports/review.md']) {
    assert.equal(existsSync(join(store.root, rel)), true, `${rel} written`);
  }
});

test('model-experiment: holdout partition is never mined (leakage isolation)', async () => {
  const store = runStore();
  const summary = await runModelExperiment(
    store,
    { runId: 'me-h', model: 'gpt-4.1-mini', trials: 2, budgetUsd: 5, partition: 'holdout', maxScenarios: 2, mine: true, review: false },
    { client: new StubModelClient(goodCitizen()), fixture },
  );
  assert.ok(summary.trace_count > 0, 'holdout traffic is still recorded');
  assert.equal(summary.candidate_count, 0, 'but nothing is mined from holdout');
});

test('model-experiment: budget stop leaves a partial, honestly-reported run', async () => {
  const store = runStore();
  const responder = () => finalMessage('done', { input_tokens: 10_000, output_tokens: 1_000 });
  const summary = await runModelExperiment(
    store,
    { runId: 'me-b', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 0.01, partition: 'mining', maxScenarios: null, mine: true, review: false },
    { client: new StubModelClient(responder), fixture },
  );
  assert.equal(summary.recording_errors.some((e) => e.kind === 'budget_exceeded'), true);
  assert.ok(summary.trace_count < selectScenarios('mining', null).length * 3);
});

/* ======================= recommendation logic (pure) ==================== */

test('recommendSmoke: conservative branch coverage', () => {
  assert.equal(recommendSmoke({ traceCount: 0, verified: 0, nonClean: 0, unstableGroups: 0, providerBroken: false, budgetHit: false }).step, 'stop_model_validation');
  assert.equal(recommendSmoke({ traceCount: 6, verified: 6, nonClean: 0, unstableGroups: 0, providerBroken: true, budgetHit: false }).step, 'fix_provider_adapter');
  assert.equal(recommendSmoke({ traceCount: 6, verified: 5, nonClean: 0, unstableGroups: 1, providerBroken: false, budgetHit: false }).step, 'inspect_traces');
  assert.equal(recommendSmoke({ traceCount: 6, verified: 5, nonClean: 1, unstableGroups: 0, providerBroken: false, budgetHit: false }).step, 'inspect_traces');
  assert.equal(recommendSmoke({ traceCount: 6, verified: 6, nonClean: 0, unstableGroups: 0, providerBroken: false, budgetHit: false }).step, 'run_larger_model_experiment');
});

test('recommendExperiment: conservative branch coverage', () => {
  const base = { traceCount: 10, verifiedClean: 10, nonClean: 0, unstableGroups: 0, candidateCount: 3, providerBroken: false, budgetHit: false };
  assert.equal(recommendExperiment({ ...base, traceCount: 0 }).recommendation, 'stop_model_validation');
  assert.equal(recommendExperiment({ ...base, providerBroken: true }).recommendation, 'fix_provider_adapter');
  assert.equal(recommendExperiment({ ...base, nonClean: 3 }).recommendation, 'improve_outcome_verifier');
  assert.equal(recommendExperiment({ ...base, unstableGroups: 2 }).recommendation, 'inspect_instability_before_mining');
  assert.equal(recommendExperiment({ ...base }).recommendation, 'inspect_candidates_then_try_replay');
  assert.equal(recommendExperiment({ ...base, candidateCount: 0 }).recommendation, 'rerun_with_more_trials');
  // Never claims full validation from one run:
  assert.ok(recommendExperiment({ ...base }).reasons.some((r) => /one run is never enough/.test(r)));
});

/* ============================== model-replay ============================= */

function suiteRequiring(family: string, tool: string): ApprovedSuite {
  const test0: CandidateTest = {
    schema_version: SCHEMA_VERSION,
    candidate_id: 'cand-1',
    scenario_family: family,
    scenario_ids: [`${family}-m1`],
    fixture_id: 'seed-v1',
    intents: ['x'],
    assertions: [
      { assertion_id: 'a1', type: 'tool_required', params: { tool }, confidence: 1, support: 2, total: 2, stable: true, provenance: { trace_ids: [], miner: 't' } },
    ],
    status: 'approved',
    recommended_gate: 'gate_eligible',
    risk_notes: [],
    review: null,
  };
  return { schema_version: SCHEMA_VERSION, suite_id: 'suite-test', created_at: '2026-07-04T00:00:00.000Z', suite_hash: 'deadbeef00', tests: [test0] };
}

test('model-replay: replays an approved suite under a model policy and passes on a good model', async () => {
  const store = runStore();
  const summary = await runModelReplay(
    store,
    { runId: 'replay-1', model: 'gpt-4.1-mini', trials: 2, budgetUsd: 5, suite: suiteRequiring('complete_by_id', 'complete_task') },
    { client: new StubModelClient(goodCitizen()), fixture },
  );
  assert.equal(summary.totals.tests, 3, 'complete_by_id has m1, m2 (mining) + h1 (holdout)');
  assert.equal(summary.totals.passed, 3);
  assert.equal(summary.totals.replay_unstable, 0);
  assert.equal(existsSync(join(store.root, 'reports', 'model-replay-summary.json')), true);
});

test('model-replay: pass/fail flipping across trials is flagged replay-unstable (distinct from recording instability)', async () => {
  const store = runStore();
  let n = 0;
  const responder = (_i: number, req: Parameters<typeof intentOf>[0]) => {
    if (hasToolResult(req)) return finalMessage('done');
    n += 1;
    if (n % 2 === 0) return finalMessage('I claim it is done.'); // no tool → assertion + golden fail
    const id = Number(intentOf(req).match(/(\d+)/)?.[1] ?? 1);
    return toolCall('complete_task', { id });
  };
  const summary = await runModelReplay(
    store,
    { runId: 'r', model: 'gpt-4.1-mini', trials: 2, budgetUsd: 5, suite: suiteRequiring('complete_by_id', 'complete_task') },
    { client: new StubModelClient(responder), fixture },
  );
  assert.ok(summary.totals.replay_unstable >= 1);
});

test('model-replay: budget guard stops replay and reports it', async () => {
  const store = runStore();
  const responder = () => finalMessage('done', { input_tokens: 10_000, output_tokens: 1_000 });
  const summary = await runModelReplay(
    store,
    { runId: 'r', model: 'gpt-4.1-mini', trials: 3, budgetUsd: 0.01, suite: suiteRequiring('complete_by_id', 'complete_task') },
    { client: new StubModelClient(responder), fixture },
  );
  assert.equal(summary.stopped_on_budget, true);
});
