import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMAL_GATE_B_PLANS,
  FORMAL_GATE_B_RECIPES,
  deduplicateFormalRecipes,
  evaluateFormalGateB,
  recipe,
  type FormalGateBMaterializationSummary,
  type FormalGateBTrialSummary,
} from '../src/targets/git-spike/formal-gate-b.js';

function validEvidence(): {
  materializations: FormalGateBMaterializationSummary[];
  trials: FormalGateBTrialSummary[];
} {
  const materializations = FORMAL_GATE_B_RECIPES.flatMap((definition) =>
    Array.from({ length: 20 }, (_, index): FormalGateBMaterializationSummary => ({
      recipeId: definition.id,
      materializationIndex: index + 1,
      stateHash: definition.expectedInitialHash,
      semanticSignature: definition.expectedSemanticSignature,
      cleanupPassed: true,
      sentinelPassed: true,
      rawEvidenceRetained: true,
      normalizedFields: ['trial_root', 'reflog_timestamp_timezone', 'sentinel_mtime'],
    })),
  );
  const trials = FORMAL_GATE_B_PLANS.flatMap((definition) =>
    Array.from({ length: 10 }, (_, index): FormalGateBTrialSummary => ({
      planName: definition.name,
      trialIndex: index + 1,
      initialStateHash: recipe(definition.recipeId).expectedInitialHash,
      requestedProtocol: '2025-11-25',
      negotiatedProtocol: '2025-11-25',
      serverInfoDigest: 'server',
      capabilitiesDigest: 'capabilities',
      inventoryDigest: 'inventory',
      discoveryDigest: 'discovery',
      schemaDigestsDigest: 'schemas',
      resultClasses: [...definition.expectedResultClasses],
      targetedStateDigest: `targeted:${definition.name}`,
      finalStateHash: definition.expectedFinalHash,
      unchangedState: definition.objectiveClasses.includes('successful_no_state_change') || definition.objectiveClasses.includes('unchanged_state_rejection'),
      unexpectedChangedLayers: [],
      shutdownPassed: true,
      cleanupPassed: true,
      sentinelPassed: true,
      rawEvidenceRetained: true,
      normalizedFields: ['fixture_root', 'monotonic_timing'],
      toolsCalled: [...definition.toolSequence],
      passed: true,
      reasons: [],
    })),
  );
  return { materializations, trials };
}

test('formal Gate B aggregation: unique recipes are deduplicated by semantic recipe ID', () => {
  const grouped = deduplicateFormalRecipes();
  assert.equal(grouped.length, 3);
  assert.deepEqual(grouped.find((entry) => entry.recipeId === 'unstaged-readme-edit-v1')?.plans, ['stage']);
  assert.deepEqual(grouped.find((entry) => entry.recipeId === 'staged-rollback-edit-v1')?.plans, ['reset']);
  assert.equal(grouped.find((entry) => entry.recipeId === 'clean-base-v1')?.plans.length, 8);
});

test('formal Gate B aggregation: valid canonical evidence passes', () => {
  const evidence = validEvidence();
  const result = evaluateFormalGateB(evidence.materializations, evidence.trials);
  assert.equal(result.decision, 'passed');
  assert.equal(result.reasons.length, 0);
  assert.equal(result.toolCoverage.every((entry) => entry.passed), true);
  assert.equal(result.objectiveCoverage.every((entry) => entry.passed), true);
});

test('formal Gate B aggregation: materialization count is enforced', () => {
  const evidence = validEvidence();
  evidence.materializations.pop();
  const result = evaluateFormalGateB(evidence.materializations, evidence.trials);
  assert.equal(result.decision, 'failed');
  assert.ok(result.reasons.some((reason) => reason.includes('fixture recipe')));
});

test('formal Gate B aggregation: direct-plan trial count is enforced', () => {
  const evidence = validEvidence();
  const index = evidence.trials.findIndex((trial) => trial.planName === 'read_only');
  evidence.trials.splice(index, 1);
  const result = evaluateFormalGateB(evidence.materializations, evidence.trials);
  assert.ok(result.reasons.some((reason) => reason.includes('direct plan read_only')));
});

test('formal Gate B aggregation: inconsistent initial hash fails', () => {
  const evidence = validEvidence();
  evidence.materializations[0] = { ...evidence.materializations[0]!, stateHash: 'different' };
  const result = evaluateFormalGateB(evidence.materializations, evidence.trials);
  assert.equal(result.recipeResults[0]?.passed, false);
});

test('formal Gate B aggregation: inconsistent discovery fails', () => {
  const evidence = validEvidence();
  evidence.trials[0] = { ...evidence.trials[0]!, discoveryDigest: 'different' };
  const result = evaluateFormalGateB(evidence.materializations, evidence.trials);
  assert.equal(result.planResults.find((entry) => entry.planName === evidence.trials[0]!.planName)?.stable, false);
});

test('formal Gate B aggregation: inconsistent result class fails', () => {
  const evidence = validEvidence();
  evidence.trials[0] = { ...evidence.trials[0]!, resultClasses: ['tool_error'] };
  const result = evaluateFormalGateB(evidence.materializations, evidence.trials);
  assert.equal(result.decision, 'failed');
});

test('formal Gate B aggregation: unexpected changed layer fails', () => {
  const evidence = validEvidence();
  evidence.trials[0] = { ...evidence.trials[0]!, unexpectedChangedLayers: ['objects'] };
  assert.equal(evaluateFormalGateB(evidence.materializations, evidence.trials).decision, 'failed');
});

test('formal Gate B aggregation: cleanup failure is fail-closed', () => {
  const evidence = validEvidence();
  evidence.materializations[0] = { ...evidence.materializations[0]!, cleanupPassed: false };
  evidence.trials[0] = { ...evidence.trials[0]!, cleanupPassed: false };
  const result = evaluateFormalGateB(evidence.materializations, evidence.trials);
  assert.equal(result.decision, 'failed');
});

test('formal Gate B aggregation: sentinel failure is fail-closed', () => {
  const evidence = validEvidence();
  evidence.trials[0] = { ...evidence.trials[0]!, sentinelPassed: false };
  assert.equal(evaluateFormalGateB(evidence.materializations, evidence.trials).decision, 'failed');
});

test('formal Gate B aggregation: objective-class coverage is enforced', () => {
  const evidence = validEvidence();
  evidence.trials = evidence.trials.map((trial) =>
    trial.planName === 'read_only' ? { ...trial, passed: false } : trial,
  );
  const result = evaluateFormalGateB(evidence.materializations, evidence.trials);
  assert.ok(result.reasons.some((reason) => reason.includes('successful_no_state_change')));
});

test('formal Gate B aggregation: all ten included tools require direct coverage', () => {
  const evidence = validEvidence();
  evidence.trials = evidence.trials.map((trial) => ({
    ...trial,
    toolsCalled: trial.toolsCalled.filter((tool) => tool !== 'git_reset'),
  }));
  const result = evaluateFormalGateB(evidence.materializations, evidence.trials);
  assert.ok(result.reasons.some((reason) => reason.includes('git_reset')));
});

test('formal Gate B aggregation: raw evidence retention is mandatory', () => {
  const evidence = validEvidence();
  evidence.trials[0] = { ...evidence.trials[0]!, rawEvidenceRetained: false };
  assert.equal(evaluateFormalGateB(evidence.materializations, evidence.trials).decision, 'failed');
});

test('formal Gate B aggregation: normalized fields must be explicitly allowlisted', () => {
  const evidence = validEvidence();
  evidence.materializations[0] = { ...evidence.materializations[0]!, normalizedFields: ['target_behavior'] };
  evidence.trials[0] = { ...evidence.trials[0]!, normalizedFields: ['server_result'] };
  assert.equal(evaluateFormalGateB(evidence.materializations, evidence.trials).decision, 'failed');
});
