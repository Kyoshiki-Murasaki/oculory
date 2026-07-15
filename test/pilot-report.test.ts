import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PILOT_REPORT_SCHEMA_VERSION, PILOT_STAGE_IDS } from '../pilot/src/constants.js';
import { validatePilotReport, type PilotReport } from '../pilot/src/report.js';

function validReport(): PilotReport {
  const epoch = Date.parse('2026-01-01T00:00:00.000Z');
  return {
    schemaVersion: PILOT_REPORT_SCHEMA_VERSION,
    reportToken: '0123456789abcdef01234567',
    overallResult: 'passed',
    oculory: { version: '0.1.0', commit: 'a'.repeat(40), worktreeState: 'clean' },
    system: { osFamily: 'linux', nodeVersion: '24.0.0', npmVersion: '11.0.0', gitVersion: '2.50.0' },
    tracks: {
      guidedTrackA: { status: 'completed' },
      readinessTrackB: { status: 'not_run', automaticIntegrationGenerated: false },
    },
    stages: PILOT_STAGE_IDS.map((id, index) => ({
      id,
      status: 'passed',
      startedAt: new Date(epoch + index * 20).toISOString(),
      endedAt: new Date(epoch + index * 20 + 10).toISOString(),
      durationMs: 10,
      error: null,
    })),
    metrics: {
      targetSessions: 23,
      mockProviderSessions: 20,
      mockProviderTurns: 40,
      mcpToolCalls: 40,
      toolCatalogueSize: 12,
      candidates: { total: 10, byRisk: { low: 4, medium: 4, high: 2 }, approved: 8, rejected: 2 },
      suite: { compiled: true, schemaVersion: 'git-external-suite-v1', candidateCount: 8, digest: 'b'.repeat(64) },
      replay: { sessions: 2, passed: 2, suitePassed: true },
      controlledRegression: {
        mutationId: 'adapter/files-array-stringified',
        detected: true,
        suiteDetected: true,
        independentVerifierDetected: true,
      },
    },
    cleanup: {
      allChildProcessesExited: true,
      allFixtureRootsRemoved: true,
      workingDirectoryRemoved: true,
      emergencyCleanupUsed: false,
      rawArtifactsLocalOnly: true,
    },
    providerAccounting: {
      providerCalls: 0,
      providerNetworkCalls: 0,
      providerCredentialsRead: 0,
      providerCostMicros: 0,
      mockProviderTurns: 40,
    },
    privacy: {
      telemetryEnabled: false,
      automaticUpload: false,
      privatePathsIncluded: false,
      rawTranscriptsIncluded: false,
      rawToolPayloadsIncluded: false,
      rawEnvironmentIncluded: false,
      participantIdentityIncluded: false,
      credentialsIncluded: false,
      protectedEvidenceIncluded: false,
      manualReviewRequiredBeforeSharing: true,
    },
    participantFeedback: null,
    limitations: ['One pinned target and deterministic fixture only.'],
  };
}

test('pilot report schema accepts a complete sanitized provider-free report', () => {
  assert.doesNotThrow(() => validatePilotReport(validReport()));
});

test('pilot report rejects an unknown schema version and missing required stage', () => {
  const version = validReport() as unknown as Record<string, unknown>;
  version.schemaVersion = 'oculory-pilot-report-v999';
  assert.throws(() => validatePilotReport(version), /schemaVersion/);

  const missing = validReport();
  missing.stages.pop();
  assert.throws(() => validatePilotReport(missing), /required stages/);
});

test('pilot report rejects inconsistent timestamps and durations', () => {
  const report = validReport();
  report.stages[0]!.durationMs = 11;
  assert.throws(() => validatePilotReport(report), /duration/);
});

test('pilot report rejects impossible success combinations and failed regression detection', () => {
  const replay = validReport();
  replay.metrics.replay.suitePassed = false;
  assert.throws(() => validatePilotReport(replay), /passed requires/);

  const regression = validReport();
  regression.metrics.controlledRegression = {
    mutationId: 'adapter/files-array-stringified',
    detected: false,
    suiteDetected: false,
    independentVerifierDetected: false,
  };
  assert.throws(() => validatePilotReport(regression), /passed requires/);
});

test('pilot report rejects provider calls above zero and incomplete cleanup', () => {
  const provider = validReport() as unknown as { providerAccounting: Record<string, number> };
  provider.providerAccounting.providerCalls = 1;
  assert.throws(() => validatePilotReport(provider), /must be zero/);

  const cleanup = validReport();
  cleanup.cleanup.allFixtureRootsRemoved = false;
  assert.throws(() => validatePilotReport(cleanup), /cleanup proof/);
});

test('pilot report rejects absolute home paths, raw transcripts, raw tool payloads, and raw environment values', () => {
  const home = validReport();
  home.limitations = ['Observed /Users/example/private-repository'];
  assert.throws(() => validatePilotReport(home), /absolute private path/);

  const transcript = validReport() as unknown as Record<string, unknown>;
  transcript.transcript = { jsonrpc: '2.0' };
  assert.throws(() => validatePilotReport(transcript), /unexpected or missing fields/);

  const payload = validReport();
  payload.limitations = ['Observed {"method":"tools/call","params":{}}'];
  assert.throws(() => validatePilotReport(payload), /raw transcript or tool payload/);

  const environment = validReport();
  environment.limitations = ['OPENAI_API_KEY=synthetic-value'];
  assert.throws(() => validatePilotReport(environment), /raw environment value/);
});

test('pilot report rejects credential-shaped values', () => {
  const report = validReport();
  report.limitations = [`synthetic sk-${'a'.repeat(32)}`];
  assert.throws(() => validatePilotReport(report), /credential-shaped/);
});
