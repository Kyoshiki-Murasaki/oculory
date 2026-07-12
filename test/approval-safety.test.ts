import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveAllStable, approveOne, type ApproveFlags } from '../src/pipeline/approval.js';
import { annotateCandidates, renderReviewMarkdown } from '../src/pipeline/candidate-risk.js';
import { SCHEMA_VERSION, type CandidateRiskProfile, type CandidateTest } from '../src/schema/types.js';
import type { RecordingInstabilityResult } from '../src/pipeline/instability.js';

const FLAGS: ApproveFlags = { allowSmoke: false, allowUnstable: false, allowRisky: false, reason: 'test', reviewedBy: 'nidhi' };

function profile(overrides: Partial<CandidateRiskProfile> = {}): CandidateRiskProfile {
  return {
    source_policies: ['model/openai/gpt-4.1-mini'],
    model_trace_count: 3,
    scripted_trace_count: 0,
    mixed_sources: false,
    partitions: ['mining'],
    smoke_only: false,
    adversarial_only: false,
    from_unstable_scenario: false,
    min_support: 3,
    min_support_met: true,
    unknown_outcomes_nearby: false,
    constant_args: false,
    alternative_tool_paths: false,
    risky: false,
    safe_to_approve: true,
    advisory_only: false,
    risk_flags: [],
    ...overrides,
  };
}

function candidate(id: string, risk?: CandidateRiskProfile): CandidateTest {
  return {
    schema_version: SCHEMA_VERSION,
    candidate_id: id,
    scenario_family: 'complete_by_id',
    scenario_ids: ['complete_by_id-m1'],
    fixture_id: 'seed-v1',
    intents: ['x'],
    assertions: [
      { assertion_id: 'a', type: 'tool_required', params: { tool: 'complete_task' }, confidence: 1, support: 3, total: 3, stable: true, provenance: { trace_ids: [], miner: 'm' } },
    ],
    status: 'candidate',
    recommended_gate: 'gate_eligible',
    risk_notes: [],
    review: null,
    ...(risk ? { risk_profile: risk } : {}),
  };
}

test('approve --all-stable: smoke-only model candidates are blocked by default, allowed with --allow-smoke', () => {
  const c = candidate('c1', profile({ smoke_only: true, advisory_only: true, safe_to_approve: false, partitions: ['smoke'], risk_flags: ['smoke only'] }));
  const blockedResult = approveAllStable([c], FLAGS);
  assert.equal(blockedResult.approved, 0);
  assert.equal(blockedResult.blocked.length, 1);
  assert.deepEqual(blockedResult.blocked[0]!.reasons, ['smoke_only']);
  assert.equal(blockedResult.blocked[0]!.needs.includes('--allow-smoke'), true);
  assert.equal(blockedResult.candidates[0]!.status, 'candidate', 'left un-approved');

  const allowed = approveAllStable([c], { ...FLAGS, allowSmoke: true });
  assert.equal(allowed.approved, 1);
  assert.equal(allowed.candidates[0]!.status, 'approved');
  assert.deepEqual(allowed.candidates[0]!.review!.overridden_warnings, ['smoke_only']);
});

test('approve --all-stable: unstable-scenario candidates blocked by default, allowed with --allow-unstable', () => {
  const c = candidate('c1', profile({ from_unstable_scenario: true, advisory_only: true, safe_to_approve: false }));
  assert.equal(approveAllStable([c], FLAGS).approved, 0);
  assert.equal(approveAllStable([c], { ...FLAGS, allowUnstable: true }).approved, 1);
});

test('approve --all-stable: risky candidates blocked by default, allowed with --allow-risky', () => {
  const c = candidate('c1', profile({ risky: true, advisory_only: true, safe_to_approve: false, mixed_sources: true, risk_flags: ['mixed sources'] }));
  assert.equal(approveAllStable([c], FLAGS).approved, 0);
  const allowed = approveAllStable([c], { ...FLAGS, allowRisky: true });
  assert.equal(allowed.approved, 1);
  assert.deepEqual(allowed.candidates[0]!.review!.overridden_warnings, ['risky']);
});

test('approve --all-stable: a clean model candidate (no risk flags) is approvable without overrides', () => {
  const c = candidate('c1', profile()); // safe_to_approve: true
  const result = approveAllStable([c], FLAGS);
  assert.equal(result.approved, 1);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.candidates[0]!.review!.approval_mode, 'all-stable');
  assert.equal(result.candidates[0]!.review!.approved_by, 'nidhi');
});

test('approve --all-stable: legacy scripted candidates (no risk_profile) behave exactly as before', () => {
  const scripted = candidate('scripted-1'); // no risk_profile
  const result = approveAllStable([scripted], FLAGS);
  assert.equal(result.approved, 1);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.candidates[0]!.status, 'approved');
  assert.deepEqual(result.candidates[0]!.review!.overridden_warnings, []);

  // ...and a candidate with no stable assertion is rejected, as before.
  const noStable = candidate('c2');
  noStable.assertions = noStable.assertions.map((a) => ({ ...a, stable: false }));
  const r2 = approveAllStable([noStable], FLAGS);
  assert.equal(r2.approved, 0);
  assert.equal(r2.candidates[0]!.status, 'rejected');
});

test('approve <id>: single approval always proceeds but records overridden warnings', () => {
  const c = candidate('c1', profile({ smoke_only: true, advisory_only: true, safe_to_approve: false, partitions: ['smoke'] }));
  const { result, warnings, found } = approveOne([c], 'c1', FLAGS);
  assert.equal(found, true);
  assert.equal(result.candidates[0]!.status, 'approved');
  assert.equal(warnings.includes('smoke_only'), true);
  assert.equal(result.candidates[0]!.review!.approval_mode, 'single');
  assert.deepEqual(result.candidates[0]!.review!.overridden_warnings, warnings);

  const missing = approveOne([c], 'does-not-exist', FLAGS);
  assert.equal(missing.found, false);
});

test('a candidate needing multiple overrides requires all matching --allow-* flags', () => {
  const c = candidate('c1', profile({ smoke_only: true, from_unstable_scenario: true, advisory_only: true, safe_to_approve: false, partitions: ['smoke'] }));
  assert.equal(approveAllStable([c], { ...FLAGS, allowSmoke: true }).approved, 0, 'still blocked on unstable');
  assert.equal(approveAllStable([c], { ...FLAGS, allowSmoke: true, allowUnstable: true }).approved, 1);
});

/* ---------------------------- review clarity ---------------------------- */

test('review markdown surfaces provenance and the exact override flags needed', () => {
  const smoke = candidate('smoke-1', profile({ smoke_only: true, advisory_only: true, safe_to_approve: false, partitions: ['smoke'], risk_flags: ['mined from SMOKE traffic only'] }));
  const mixed = candidate('mixed-1', profile({ mixed_sources: true, risky: true, advisory_only: true, safe_to_approve: false, scripted_trace_count: 2, risk_flags: ['mined from MIXED scripted + model traces'] }));
  const md = renderReviewMarkdown([smoke, mixed], 'Review — test');
  assert.match(md, /SMOKE traffic only/);
  assert.match(md, /MIXED scripted \+ model/);
  assert.match(md, /--allow-smoke/);
  assert.match(md, /--allow-risky/);
  assert.match(md, /None are auto-approved/);
});

test('annotateCandidates: smoke-only + unstable classification from real traces', () => {
  // Two normalized smoke traces backing one candidate, one scenario flagged unstable.
  const mkTrace = (traceId: string, scenarioId: string) =>
    ({
      trace_id: traceId,
      scenario_id: scenarioId,
      scenario_family: 'smoke_complete',
      partition: 'smoke',
      agent: { kind: 'model', id: 'model/openai/gpt-4.1-mini' },
      outcome: { label: 'verified_success' },
    }) as never;
  const normalized = [mkTrace('t1', 'smoke-complete-1'), mkTrace('t2', 'smoke-complete-1')];
  const cand = candidate('c1');
  cand.scenario_ids = ['smoke-complete-1'];
  cand.assertions[0]!.provenance.trace_ids = ['t1', 't2'];
  const instability: RecordingInstabilityResult[] = [
    { scenario_id: 'smoke-complete-1', policy_id: 'model/openai/gpt-4.1-mini', trial_count: 2, tool_sequences: [], outcome_labels: [], unstable: true, detail: '' },
  ];
  const [annotated] = annotateCandidates([cand], normalized, instability);
  assert.equal(annotated!.risk_profile!.smoke_only, true);
  assert.equal(annotated!.risk_profile!.from_unstable_scenario, true);
  assert.equal(annotated!.risk_profile!.safe_to_approve, false);
});
