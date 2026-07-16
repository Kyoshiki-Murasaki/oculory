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

function failedReport(): PilotReport {
  const report = validReport();
  report.overallResult = 'failed';
  report.tracks.guidedTrackA.status = 'failed';
  report.stages[0]!.status = 'failed';
  report.stages[0]!.error = { category: 'synthetic_failure', message: 'Synthetic bounded failure.' };
  return report;
}

function reportWithParticipantFeedback(): PilotReport {
  const report = validReport();
  report.participantFeedback = {
    commentsReviewed: true,
    ratings: { usefulness: 5 },
    binaryAnswers: { completedWithoutHelp: true },
    comments: ['The synthetic workflow was clear.'],
  };
  return report;
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

test('pilot report rejects private absolute path spelling variants after comparison-only normalization', () => {
  const jsonDecodedBackslashPath = JSON.parse('"C:\\\\Users\\\\example\\\\private-repository"') as string;
  const prohibited = [
    ['POSIX Users root', '/Users/example/private-repository'],
    ['POSIX home root', '/home/example/private-repository'],
    ['POSIX private root', '/private/example/private-repository'],
    ['POSIX temporary root', '/tmp/example/private-repository'],
    ['POSIX macOS temporary root', '/var/folders/example/private-repository'],
    ['Windows backslashes', String.raw`C:\Users\example\private-repository`],
    ['Windows forward slashes', 'C:/Users/example/private-repository'],
    ['Windows mixed separators from backslash', String.raw`C:\Users/example/private-repository`],
    ['Windows mixed separators from slash', String.raw`C:/Users\example/private-repository`],
    ['Windows lowercase private root', 'c:/users/example/private-repository'],
    ['Windows legacy home root', String.raw`D:\Documents and Settings\example\private-repository`],
    ['Windows home root', 'E:/home/example/private-repository'],
    ['embedded after ordinary text', 'Observed C:/Users/example/private-repository'],
    ['followed by ordinary text', 'C:/Users/example/private-repository was excluded'],
    ['second line of multiline text', 'line one\nC:/Users/example/private-repository\nline three'],
    ['JSON-decoded escaped backslashes', jsonDecodedBackslashPath],
    ['fullwidth slash', 'C:／Users／example／private-repository'],
    ['fullwidth colon and Latin characters', 'Ｃ：／Ｕｓｅｒｓ／ｅｘａｍｐｌｅ／private-repository'],
    ['fullwidth reverse solidus', 'C:＼Users＼example＼private-repository'],
    ['division slash', 'C:∕Users∕example∕private-repository'],
    ['fraction slash', 'C:⁄Users⁄example⁄private-repository'],
    ['UNC backslashes', String.raw`\\server\share\private`],
    ['UNC forward slashes', '//server/share/private'],
    ['UNC mixed separators from backslash', String.raw`\\server/share\private`],
    ['UNC mixed separators from slash', String.raw`//server\share/private`],
    ['private POSIX file URL', 'file:///Users/example/private-repository'],
    ['uppercase-scheme private POSIX file URL', 'FILE:///Users/example/private-repository'],
    ['private Windows file URL', 'file:///C:/Users/example/private-repository'],
    ['UNC file URL', 'file://server/share/private'],
  ] as const;

  for (const [label, value] of prohibited) {
    const report = validReport();
    report.limitations = [value];
    assert.throws(() => validatePilotReport(report), /absolute private path/, label);
  }
});

test('pilot report inspects every retained free-text value and participant-defined key', () => {
  const privatePath = 'C:/Users/example/private-repository';
  const cases: Array<[string, () => PilotReport]> = [
    ['oculory version', () => {
      const report = validReport();
      report.oculory.version = privatePath;
      return report;
    }],
    ['Node version', () => {
      const report = validReport();
      report.system.nodeVersion = privatePath;
      return report;
    }],
    ['npm version', () => {
      const report = validReport();
      report.system.npmVersion = privatePath;
      return report;
    }],
    ['Git version', () => {
      const report = validReport();
      report.system.gitVersion = privatePath;
      return report;
    }],
    ['stage error category', () => {
      const report = failedReport();
      report.stages[0]!.error!.category = privatePath;
      return report;
    }],
    ['stage error message', () => {
      const report = failedReport();
      report.stages[0]!.error!.message = privatePath;
      return report;
    }],
    ['controlled regression mutation ID', () => {
      const report = validReport();
      report.metrics.controlledRegression.mutationId = privatePath;
      return report;
    }],
    ['suite schema version', () => {
      const report = validReport();
      report.metrics.suite.schemaVersion = privatePath;
      return report;
    }],
    ['limitation', () => {
      const report = validReport();
      report.limitations = [privatePath];
      return report;
    }],
    ['participant comment', () => {
      const report = reportWithParticipantFeedback();
      report.participantFeedback!.comments = [privatePath];
      return report;
    }],
    ['participant rating key', () => {
      const report = reportWithParticipantFeedback();
      report.participantFeedback!.ratings = { [privatePath]: 5 };
      return report;
    }],
    ['participant binary-answer key', () => {
      const report = reportWithParticipantFeedback();
      report.participantFeedback!.binaryAnswers = { [privatePath]: true };
      return report;
    }],
  ];

  for (const [label, createReport] of cases) {
    assert.throws(() => validatePilotReport(createReport()), /absolute private path/, label);
  }
});

test('pilot report private-path errors identify the field without repeating sensitive content', () => {
  const privatePath = 'C:/Users/example/private-repository';
  const report = validReport();
  report.limitations = [privatePath];
  assert.throws(
    () => validatePilotReport(report),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\$\.limitations\[0\]/);
      assert.doesNotMatch(error.message, /C:\/Users/);
      return true;
    },
  );

  const keyed = reportWithParticipantFeedback();
  keyed.participantFeedback!.ratings = { [privatePath]: 5 };
  assert.throws(
    () => validatePilotReport(keyed),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\$\.participantFeedback\.ratings key/);
      assert.doesNotMatch(error.message, /C:\/Users/);
      return true;
    },
  );
});

test('pilot report validation never mutates compatibility-obfuscated report text', () => {
  const original = 'Ｃ：／Ｕｓｅｒｓ／ｅｘａｍｐｌｅ／private-repository';
  const report = validReport();
  report.limitations = [original];
  assert.throws(() => validatePilotReport(report), /absolute private path/);
  assert.equal(report.limitations[0], original);
});

test('pilot report continues to allow legitimate slash, backslash, colon, URL, and Unicode text', () => {
  const allowed = [
    'docs/README.md',
    String.raw`src\module.ts`,
    'alpha/beta',
    String.raw`alpha\beta`,
    'adapter/files-array-stringified',
    'git-external-suite-v1',
    'https://example.com/path',
    'file-format://example',
    'file:///docs/README.md',
    'Windows users completed the workflow.',
    'C:relative',
    'C:/Windows/System32',
    '/usr/local/bin',
    'Ordinary Unicode: नमस्ते 世界 résumé.',
    'Café'.normalize('NFC'),
    'Café'.normalize('NFD'),
  ];

  for (const value of allowed) {
    const report = validReport();
    report.limitations = [value];
    assert.doesNotThrow(() => validatePilotReport(report), value);
  }

  const feedback = reportWithParticipantFeedback();
  feedback.participantFeedback!.ratings = { 'docs/README.md': 5 };
  feedback.participantFeedback!.binaryAnswers = { 'Windows users': true };
  assert.doesNotThrow(() => validatePilotReport(feedback));
});
