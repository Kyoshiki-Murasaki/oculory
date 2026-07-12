import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATE_B_EVIDENCE_SCHEMA,
  GATE_B_RUNNER_VERSION,
  GateBEvidenceStore,
  GateBTrialRecorder,
  aggregateFailureEntry,
  persistTerminalRecord,
  type GateBAttemptManifest,
  type GateBFailureClass,
  type GateBTerminalOutcome,
  type GateBTrialPhase,
} from '../src/targets/git-spike/gate-b-evidence.js';
import { runGitRaw } from '../src/targets/git-spike/fixture.js';

interface FaultCase {
  name: string;
  failureClass: GateBFailureClass;
  failurePhase: string;
  lastPhaseBeforeFailure: GateBTrialPhase;
  expectedOutcome: GateBTerminalOutcome;
  timeoutMs?: number;
}

const PHASE_FAULTS: readonly FaultCase[] = [
  { name: 'fixture creation', failureClass: 'fixture_creation', failurePhase: 'fixture_creation', lastPhaseBeforeFailure: 'attempt_started', expectedOutcome: 'failed_execution' },
  { name: 'initial native-Git snapshot', failureClass: 'native_git_snapshot', failurePhase: 'initial_native_git_snapshot', lastPhaseBeforeFailure: 'fixture_created', expectedOutcome: 'failed_oracle', timeoutMs: 17 },
  { name: 'target startup', failureClass: 'target_startup', failurePhase: 'target_startup', lastPhaseBeforeFailure: 'initial_snapshot_captured', expectedOutcome: 'failed_execution' },
  { name: 'initialize', failureClass: 'initialize', failurePhase: 'initialize', lastPhaseBeforeFailure: 'target_started', expectedOutcome: 'failed_execution' },
  { name: 'tools/list', failureClass: 'tools_list', failurePhase: 'tools_list', lastPhaseBeforeFailure: 'initialized', expectedOutcome: 'failed_execution' },
  { name: 'tools/call', failureClass: 'tools_call', failurePhase: 'tools_call', lastPhaseBeforeFailure: 'tools_list_completed', expectedOutcome: 'failed_execution', timeoutMs: 23 },
  { name: 'post-call snapshot', failureClass: 'post_call_snapshot', failurePhase: 'post_call_snapshot', lastPhaseBeforeFailure: 'tool_call_completed', expectedOutcome: 'failed_oracle', timeoutMs: 19 },
  { name: 'target shutdown', failureClass: 'target_shutdown', failurePhase: 'target_shutdown', lastPhaseBeforeFailure: 'post_call_snapshot_captured', expectedOutcome: 'failed_shutdown' },
  { name: 'process-group verification', failureClass: 'process_group_verification', failurePhase: 'process_group_verification', lastPhaseBeforeFailure: 'target_shutdown_completed', expectedOutcome: 'failed_cleanup' },
  { name: 'sentinel verification', failureClass: 'sentinel_verification', failurePhase: 'sentinel_verification', lastPhaseBeforeFailure: 'process_group_verified', expectedOutcome: 'failed_cleanup' },
  { name: 'fixture removal', failureClass: 'fixture_removal', failurePhase: 'fixture_removal', lastPhaseBeforeFailure: 'sentinel_verified', expectedOutcome: 'failed_cleanup' },
  { name: 'post-removal absence check', failureClass: 'post_removal_absence_check', failurePhase: 'post_removal_absence_check', lastPhaseBeforeFailure: 'fixture_removed', expectedOutcome: 'failed_cleanup' },
];

for (const fault of PHASE_FAULTS) {
  test(`Gate B evidence fault: ${fault.name} retains one terminal record and continues safe cleanup`, () => {
    withAttempt(`fault-${fault.failureClass}`, ({ store, attemptRoot, trialId }) => {
      const fixture = join(attemptRoot, 'synthetic-fixture');
      mkdirSync(fixture, { mode: 0o700 });
      const recorder = recorderFor(trialId);
      primeRecorder(recorder, fault.lastPhaseBeforeFailure);
      recorder.fail(fault.failureClass, fault.failurePhase, new Error(`injected ${fault.name} failure`), fault.timeoutMs ?? null);
      recorder.fail('sentinel_verification', 'secondary_cleanup_probe', new Error('injected secondary cleanup finding'));

      recorder.cleanupStep({ step: 'process_cleanup', attempted: true, passed: true, detail: null, failureClass: 'process_group_verification' });
      recorder.setProcess({ started: fault.lastPhaseBeforeFailure !== 'attempt_started', exited: true, childAlive: false, processGroupManaged: true, processGroupAlive: false, allRequestsSettled: true });
      rmSync(fixture, { recursive: true, force: true });
      recorder.cleanupStep({ step: 'fixture_removal_retry', attempted: true, passed: true, detail: null, failureClass: 'fixture_removal' });
      recorder.setFixturePresence(existsSync(fixture));
      recorder.setSentinelUnchanged(true);
      recorder.complete('post_removal_absence_verified');

      const envelope = persistTerminalRecord(store, recorder, fault.expectedOutcome);
      assert.equal(envelope.record.primaryFailure?.class, fault.failureClass);
      assert.equal(envelope.record.primaryFailure?.timeoutDeadlineMs, fault.timeoutMs ?? null);
      assert.equal(envelope.record.secondaryFailures[0]?.class, 'sentinel_verification');
      assert.equal(envelope.record.terminalOutcome, fault.expectedOutcome);
      assert.equal(envelope.record.lastCompletedPhase, 'post_removal_absence_verified');
      assert.equal(envelope.record.cleanupSteps.every((step) => step.attempted), true);
      assert.equal(envelope.record.process.childAlive, false);
      assert.equal(envelope.record.process.processGroupAlive, false);
      assert.equal(envelope.record.fixturePresence, false);
      assert.equal(existsSync(fixture), false);

      const aggregate = store.compileAggregate([trialId]);
      assert.equal(aggregate.actualTerminalRecords, 1);
      assert.equal(aggregate.decision, 'failed');
      assert.equal(aggregate.outcomeCounts[fault.expectedOutcome], 1);
      assert.throws(() => store.writeTrial(envelope.record), /duplicate terminal trial ID/);
    });
  });
}

test('Gate B evidence fault: per-trial primary write failure is recovered as one failed terminal record', () => {
  withAttempt('fault-record-write', ({ store, trialId }) => {
    const recorder = recorderFor(trialId);
    primeRecorder(recorder, 'post_removal_absence_verified');
    const envelope = persistTerminalRecord(store, recorder, 'passed', true);
    assert.equal(envelope.record.terminalOutcome, 'failed_evidence_finalization');
    assert.equal(envelope.record.primaryFailure?.class, 'record_write');
    assert.equal(envelope.record.reportFinalizationStatus, 'recovered_after_primary_write_failure');
    assert.equal(readdirSync(store.trialsDirectory).filter((name) => name.endsWith('.json')).length, 1);
    const aggregate = store.compileAggregate([trialId]);
    assert.equal(aggregate.actualTerminalRecords, 1);
    assert.equal(aggregate.decision, 'failed');
  });
});

test('Gate B evidence fault: aggregate finalization failure retains parseable trials and a failed aggregate', () => {
  withAttempt('fault-aggregate-write', ({ store, trialId }) => {
    const recorder = recorderFor(trialId);
    primeRecorder(recorder, 'post_removal_absence_verified');
    persistTerminalRecord(store, recorder, 'passed');
    const aggregate = store.compileAggregate([trialId]);
    assert.equal(aggregate.decision, 'passed');
    const failure = aggregateFailureEntry(new Error('injected aggregate report finalization failure'));
    store.writeAggregateFailure(aggregate, failure);
    const failed = JSON.parse(readFileSync(join(store.outputDirectory, 'aggregate.failed.json'), 'utf8')) as { decision: string; reportFinalizationFailure: { class: string } };
    assert.equal(failed.decision, 'failed');
    assert.equal(failed.reportFinalizationFailure.class, 'aggregate_finalization');
    assert.equal(store.compileAggregate([trialId]).actualTerminalRecords, 1);
    const checksumPath = join(store.outputDirectory, 'checksums.sha256');
    assert.equal(existsSync(checksumPath), true);
    for (const line of readFileSync(checksumPath, 'utf8').trimEnd().split('\n')) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      assert.notEqual(match, null);
      const observed = createHash('sha256').update(readFileSync(join(store.outputDirectory, match![2]!))).digest('hex');
      assert.equal(match![1], observed);
    }
  });
});

test('Gate B evidence aggregation rejects missing, duplicate, corrupted, and partial records', () => {
  withAttempt('fault-aggregate-integrity', ({ store, trialId }) => {
    const recorder = recorderFor(trialId);
    primeRecorder(recorder, 'post_removal_absence_verified');
    const envelope = persistTerminalRecord(store, recorder, 'passed');
    writeFileSync(join(store.trialsDirectory, 'partial.json.tmp-1'), '{', 'utf8');
    writeFileSync(join(store.trialsDirectory, 'corrupt.json'), '{', 'utf8');
    writeFileSync(join(store.trialsDirectory, 'duplicate.json'), `${JSON.stringify(envelope)}\n`, 'utf8');
    const aggregate = store.compileAggregate([trialId, 'direct-other-01']);
    assert.deepEqual(aggregate.missingTrialIds, ['direct-other-01']);
    assert.deepEqual(aggregate.duplicateTrialIds, [trialId]);
    assert.deepEqual(aggregate.invalidRecordFiles, ['corrupt.json']);
    assert.deepEqual(aggregate.temporaryFiles, ['partial.json.tmp-1']);
    assert.equal(aggregate.incompleteAttempt, true);
    assert.equal(aggregate.decision, 'failed');
  });
});

test('Gate B evidence native-Git timeout fixture deterministically raises the configured timeout', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-git-timeout-fixture-'));
  try {
    const executable = join(root, 'fake-git');
    writeFileSync(executable, '#!/bin/sh\nsleep 1\n', { encoding: 'utf8', mode: 0o700 });
    chmodSync(executable, 0o700);
    assert.throws(
      () => runGitRaw(executable, root, { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, ['remote'], 10),
      (error: unknown) => error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function withAttempt(
  name: string,
  body: (value: { store: GateBEvidenceStore; attemptRoot: string; trialId: string }) => void,
): void {
  const parent = mkdtempSync(join(tmpdir(), 'oculory-gate-b-evidence-test-'));
  const attemptRoot = join(parent, name);
  const store = new GateBEvidenceStore(attemptRoot);
  const trialId = 'direct-read-only-01';
  store.initialize(manifest('fault-attempt'));
  try {
    body({ store, attemptRoot, trialId });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function manifest(attemptId: string): GateBAttemptManifest {
  return {
    schema: GATE_B_EVIDENCE_SCHEMA,
    runnerVersion: GATE_B_RUNNER_VERSION,
    attemptId,
    predecessorFailedAttemptId: 'formal-gate-b-attempt-1',
    source: { head: 'test', dirty: true, sourceTreeDigest: '0'.repeat(64) },
    runtime: { target: 'synthetic-test-only' },
    thresholds: { materializationsPerRecipe: 20, trialsPerPlan: 10, recipes: ['clean-base-v1'], plans: ['read-only'] },
    startedAt: '2026-07-11T00:00:00.000Z',
    completionStatus: 'running',
  };
}

function recorderFor(trialId: string): GateBTrialRecorder {
  return new GateBTrialRecorder({
    attemptId: 'fault-attempt',
    parentCanonicalAttemptId: 'formal-gate-b-attempt-1',
    trialId,
    kind: 'direct',
    subjectId: 'read-only',
    trialIndex: 1,
    targetRuntimeProvenance: { target: 'synthetic-test-only' },
  });
}

function primeRecorder(recorder: GateBTrialRecorder, through: GateBTrialPhase): void {
  recorder.setFixturePathToken('<FIXTURE_ROOT>');
  recorder.setLatestSnapshot({ stateHash: 'snapshot-before-fault' });
  recorder.setCalls([{ tool: 'synthetic', outcome: 'retained' }]);
  recorder.setJournals([{ phase: 'retained' }]);
  recorder.setProcess({ applicable: true, pid: 123, started: true, exited: false, childAlive: true, processGroupManaged: true, processGroupAlive: true, allRequestsSettled: false });
  recorder.setFixturePresence(true);
  recorder.setSentinelUnchanged(true);
  recorder.complete(through);
}
