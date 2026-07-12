import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSession, type FixtureFile } from '../src/runner/record.js';
import { scenarioById, SCENARIOS } from '../src/runner/catalogue.js';
import { plannerV1, plannerLite, DEFAULT_POLICIES } from '../src/runner/policies.js';
import { verifyOutcome } from '../src/pipeline/verify.js';
import { normalizeTrace } from '../src/pipeline/normalize.js';
import { mineAll, mineFamily, groupByFamily } from '../src/pipeline/mine.js';
import { evaluateAssertion } from '../src/pipeline/evaluate.js';
import { Store } from '../src/pipeline/store.js';
import type { NormalizedTrace } from '../src/schema/types.js';

const fixture = JSON.parse(readFileSync('fixtures/seed.json', 'utf8')) as FixtureFile;

async function normalized(scenarioId: string, policy = plannerV1): Promise<NormalizedTrace> {
  const scenario = scenarioById(scenarioId);
  const raw = await recordSession({ scenario, policy, fixture, mutationId: null });
  return normalizeTrace(raw, verifyOutcome(scenario, raw));
}

test('verifier: success requires the intended state, not merely ok tool calls', async () => {
  const good = await normalized('complete_by_id-m1');
  assert.equal(good.outcome.label, 'verified_success');
  // Same scenario under silent_write_failure: tool says ok, state says no.
  const scenario = scenarioById('complete_by_id-m1');
  const raw = await recordSession({ scenario, policy: plannerLite, fixture, mutationId: 'silent_write_failure' });
  const outcome = verifyOutcome(scenario, raw);
  assert.equal(raw.steps.every((s) => s.result_status === 'ok'), true);
  assert.equal(outcome.label, 'verified_failure');
});

test('verifier: expected structured error yields valid_rejection; wrong_success yields invalid_acceptance', async () => {
  const scenario = scenarioById('complete_nonexistent-a1');
  const ok = await recordSession({ scenario, policy: plannerLite, fixture, mutationId: null });
  assert.equal(verifyOutcome(scenario, ok).label, 'valid_rejection');
  const lying = await recordSession({ scenario, policy: plannerLite, fixture, mutationId: 'wrong_success' });
  assert.equal(verifyOutcome(scenario, lying).label, 'invalid_acceptance');
});

test('miner: refuses verified_failure traces and requires minimum support', async () => {
  const scenario = scenarioById('complete_by_id-m1');
  const bad = await recordSession({ scenario, policy: plannerLite, fixture, mutationId: 'silent_write_failure' });
  const nt = normalizeTrace(bad, verifyOutcome(scenario, bad));
  assert.equal(mineFamily({ family: nt.scenario_family, traces: [nt, nt] }), null); // failures only → nothing mined
  assert.equal(mineFamily({ family: 'x', traces: [await normalized('complete_by_id-m1')] }), null); // below MIN_SUPPORT
});

test('miner: single-scenario incidental constants are never frozen (anti-overfit)', async () => {
  const traces = await Promise.all(DEFAULT_POLICIES.map((p) => normalized('assign_task-m1', p)));
  const cand = mineFamily({ family: 'assign_task', traces })!;
  const postconds = cand.assertions.filter((a) => a.type === 'state_postcondition' && a.params.field === 'assignee');
  assert.equal(postconds.length, 1);
  assert.equal(postconds[0]!.params.expected, '@entity:assignee'); // generalised, not 'dana'
  // Untouched field must not be mined at all:
  assert.equal(cand.assertions.some((a) => a.type === 'state_postcondition' && a.params.field === 'priority'), false);
});

test('miner: corroborated constants across scenarios are kept; alternative paths become one_of', async () => {
  const traces = await Promise.all([
    ...DEFAULT_POLICIES.map((p) => normalized('complete_by_id-m1', p)),
    ...DEFAULT_POLICIES.map((p) => normalized('complete_by_id-m2', p)),
  ]);
  const cand = mineFamily({ family: 'complete_by_id', traces })!;
  const status = cand.assertions.find((a) => a.type === 'state_postcondition' && a.params.field === 'status')!;
  assert.equal(status.params.expected, 'done');
  const oneOf = cand.assertions.find((a) => a.type === 'one_of_tools')!;
  assert.deepEqual((oneOf.params.tools as string[]).sort(), ['complete_task', 'update_task']);
  for (const a of cand.assertions) {
    assert.equal(a.provenance.trace_ids.length > 0, true, 'every assertion carries provenance');
  }
});

test('evaluator: entity-generalised assertions pass on differently-worded holdout scenarios', async () => {
  const mined = mineFamily({
    family: 'assign_task',
    traces: await Promise.all(DEFAULT_POLICIES.map((p) => normalized('assign_task-m1', p))),
  })!;
  const holdoutTrace = await recordSession({ scenario: scenarioById('assign_task-h1'), policy: plannerV1, fixture, mutationId: null });
  for (const a of mined.assertions.filter((x) => x.stable)) {
    const r = evaluateAssertion(a, holdoutTrace);
    assert.equal(r.passed, true, `${a.type} ${JSON.stringify(a.params)}: ${r.detail}`);
  }
});

test('evaluator: conditional assertions pass vacuously; required tools fail loudly', async () => {
  const trace = await recordSession({ scenario: scenarioById('list_open-m1'), policy: plannerV1, fixture, mutationId: null });
  const vacuous = evaluateAssertion(
    { assertion_id: 'x', type: 'arg_present', params: { tool: 'complete_task', arg: 'id' }, confidence: 1, support: 2, total: 2, stable: true, provenance: { trace_ids: [], miner: 't' } },
    trace,
  );
  assert.equal(vacuous.passed, true);
  const required = evaluateAssertion(
    { assertion_id: 'y', type: 'tool_required', params: { tool: 'search_tasks' }, confidence: 1, support: 2, total: 2, stable: true, provenance: { trace_ids: [], miner: 't' } },
    trace,
  );
  assert.equal(required.passed, false);
});

test('holdout isolation: the miner-facing loader never yields holdout or smoke traces', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'oculory-')));
  for (const sid of ['complete_by_id-m1', 'complete_by_id-h1', 'smoke-list-1', 'reopen_invalid-a1']) {
    store.appendNormalizedTrace(await normalized(sid));
  }
  const partitions = new Set(store.loadMiningTraces().map((t) => t.partition));
  assert.deepEqual([...partitions].sort(), ['adversarial', 'mining']);
  store.clean();
});

test('reproducibility: mining the same traces twice yields identical candidates', async () => {
  const traces = await Promise.all(
    SCENARIOS.filter((s) => s.partition === 'mining').flatMap((s) =>
      DEFAULT_POLICIES.map((p) => normalized(s.scenario_id, p)),
    ),
  );
  const a = JSON.stringify(mineAll(traces).map((c) => ({ id: c.candidate_id, n: c.assertions.map((x) => x.assertion_id) })));
  const b = JSON.stringify(mineAll(traces).map((c) => ({ id: c.candidate_id, n: c.assertions.map((x) => x.assertion_id) })));
  assert.equal(a, b);
});
