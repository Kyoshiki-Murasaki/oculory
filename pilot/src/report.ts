import { readFileSync } from 'node:fs';
import { PILOT_REPORT_SCHEMA_VERSION, PILOT_STAGE_IDS, type PilotStageId } from './constants.js';

export type PilotStageStatus = 'passed' | 'failed' | 'cancelled' | 'skipped';

export interface PilotStageResult {
  id: PilotStageId;
  status: PilotStageStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error: { category: string; message: string } | null;
}

export interface PilotReport {
  schemaVersion: typeof PILOT_REPORT_SCHEMA_VERSION;
  reportToken: string;
  overallResult: 'passed' | 'failed' | 'cancelled';
  oculory: {
    version: string;
    commit: string;
    worktreeState: 'clean' | 'modified';
  };
  system: {
    osFamily: 'linux' | 'macos' | 'windows';
    nodeVersion: string;
    npmVersion: string;
    gitVersion: string;
  };
  tracks: {
    guidedTrackA: { status: 'completed' | 'failed' | 'cancelled' };
    readinessTrackB: { status: 'not_run'; automaticIntegrationGenerated: false };
  };
  stages: PilotStageResult[];
  metrics: {
    targetSessions: number;
    mockProviderSessions: number;
    mockProviderTurns: number;
    mcpToolCalls: number;
    toolCatalogueSize: number;
    candidates: {
      total: number;
      byRisk: { low: number; medium: number; high: number };
      approved: number;
      rejected: number;
    };
    suite: {
      compiled: boolean;
      schemaVersion: string;
      candidateCount: number;
      digest: string;
    };
    replay: { sessions: number; passed: number; suitePassed: boolean };
    controlledRegression: {
      mutationId: string;
      detected: boolean;
      suiteDetected: boolean;
      independentVerifierDetected: boolean;
    };
  };
  cleanup: {
    allChildProcessesExited: boolean;
    allFixtureRootsRemoved: boolean;
    workingDirectoryRemoved: boolean;
    emergencyCleanupUsed: boolean;
    rawArtifactsLocalOnly: true;
  };
  providerAccounting: {
    providerCalls: 0;
    providerNetworkCalls: 0;
    providerCredentialsRead: 0;
    providerCostMicros: 0;
    mockProviderTurns: number;
  };
  privacy: {
    telemetryEnabled: false;
    automaticUpload: false;
    privatePathsIncluded: false;
    rawTranscriptsIncluded: false;
    rawToolPayloadsIncluded: false;
    rawEnvironmentIncluded: false;
    participantIdentityIncluded: false;
    credentialsIncluded: false;
    protectedEvidenceIncluded: false;
    manualReviewRequiredBeforeSharing: true;
  };
  participantFeedback: null | {
    commentsReviewed: true;
    ratings: Record<string, number>;
    binaryAnswers: Record<string, boolean>;
    comments: string[];
  };
  limitations: string[];
}

export function loadAndValidatePilotReport(path: string): PilotReport {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`pilot report is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  validatePilotReport(value);
  return value;
}

export function validatePilotReport(value: unknown): asserts value is PilotReport {
  const report = object(value, '$');
  exactKeys(report, [
    'schemaVersion', 'reportToken', 'overallResult', 'oculory', 'system', 'tracks', 'stages',
    'metrics', 'cleanup', 'providerAccounting', 'privacy', 'participantFeedback', 'limitations',
  ], '$');
  literal(report.schemaVersion, PILOT_REPORT_SCHEMA_VERSION, '$.schemaVersion');
  match(report.reportToken, /^[a-f0-9]{24}$/, '$.reportToken', 'expected an identity-free 96-bit token');
  member(report.overallResult, ['passed', 'failed', 'cancelled'] as const, '$.overallResult');

  const oculory = object(report.oculory, '$.oculory');
  exactKeys(oculory, ['version', 'commit', 'worktreeState'], '$.oculory');
  nonempty(oculory.version, '$.oculory.version');
  match(oculory.commit, /^[a-f0-9]{40}$/, '$.oculory.commit', 'expected a Git SHA-1');
  member(oculory.worktreeState, ['clean', 'modified'] as const, '$.oculory.worktreeState');

  const system = object(report.system, '$.system');
  exactKeys(system, ['osFamily', 'nodeVersion', 'npmVersion', 'gitVersion'], '$.system');
  member(system.osFamily, ['linux', 'macos', 'windows'] as const, '$.system.osFamily');
  for (const field of ['nodeVersion', 'npmVersion', 'gitVersion'] as const) nonempty(system[field], `$.system.${field}`);

  const tracks = object(report.tracks, '$.tracks');
  exactKeys(tracks, ['guidedTrackA', 'readinessTrackB'], '$.tracks');
  const trackA = object(tracks.guidedTrackA, '$.tracks.guidedTrackA');
  exactKeys(trackA, ['status'], '$.tracks.guidedTrackA');
  member(trackA.status, ['completed', 'failed', 'cancelled'] as const, '$.tracks.guidedTrackA.status');
  const trackB = object(tracks.readinessTrackB, '$.tracks.readinessTrackB');
  exactKeys(trackB, ['status', 'automaticIntegrationGenerated'], '$.tracks.readinessTrackB');
  literal(trackB.status, 'not_run', '$.tracks.readinessTrackB.status');
  if (trackB.automaticIntegrationGenerated !== false) fail('$.tracks.readinessTrackB.automaticIntegrationGenerated', 'must be false');

  const stages = array(report.stages, '$.stages');
  if (stages.length !== PILOT_STAGE_IDS.length) fail('$.stages', `expected ${PILOT_STAGE_IDS.length} required stages`);
  let priorEnd = 0;
  let nonPassCount = 0;
  for (let index = 0; index < stages.length; index += 1) {
    const stage = object(stages[index], `$.stages[${index}]`);
    exactKeys(stage, ['id', 'status', 'startedAt', 'endedAt', 'durationMs', 'error'], `$.stages[${index}]`);
    literal(stage.id, PILOT_STAGE_IDS[index]!, `$.stages[${index}].id`);
    member(stage.status, ['passed', 'failed', 'cancelled', 'skipped'] as const, `$.stages[${index}].status`);
    const start = timestamp(stage.startedAt, `$.stages[${index}].startedAt`);
    const end = timestamp(stage.endedAt, `$.stages[${index}].endedAt`);
    integer(stage.durationMs, `$.stages[${index}].durationMs`);
    if (end < start) fail(`$.stages[${index}]`, 'stage end precedes start');
    if (stage.durationMs !== end - start) fail(`$.stages[${index}].durationMs`, 'duration does not match timestamps');
    if (index > 0 && start < priorEnd) fail(`$.stages[${index}].startedAt`, 'stages overlap or run out of order');
    priorEnd = end;
    if (stage.status === 'passed' || stage.status === 'skipped') {
      if (stage.error !== null) fail(`$.stages[${index}].error`, 'passed/skipped stage must not have an error');
    } else {
      nonPassCount += 1;
      const error = object(stage.error, `$.stages[${index}].error`);
      exactKeys(error, ['category', 'message'], `$.stages[${index}].error`);
      nonempty(error.category, `$.stages[${index}].error.category`);
      bounded(error.message, `$.stages[${index}].error.message`, 400);
    }
  }

  const metrics = object(report.metrics, '$.metrics');
  exactKeys(metrics, [
    'targetSessions', 'mockProviderSessions', 'mockProviderTurns', 'mcpToolCalls',
    'toolCatalogueSize', 'candidates', 'suite', 'replay', 'controlledRegression',
  ], '$.metrics');
  for (const field of ['targetSessions', 'mockProviderSessions', 'mockProviderTurns', 'mcpToolCalls', 'toolCatalogueSize'] as const) integer(metrics[field], `$.metrics.${field}`);
  const candidates = object(metrics.candidates, '$.metrics.candidates');
  exactKeys(candidates, ['total', 'byRisk', 'approved', 'rejected'], '$.metrics.candidates');
  for (const field of ['total', 'approved', 'rejected'] as const) integer(candidates[field], `$.metrics.candidates.${field}`);
  const byRisk = object(candidates.byRisk, '$.metrics.candidates.byRisk');
  exactKeys(byRisk, ['low', 'medium', 'high'], '$.metrics.candidates.byRisk');
  for (const field of ['low', 'medium', 'high'] as const) integer(byRisk[field], `$.metrics.candidates.byRisk.${field}`);
  if (byRisk.low + byRisk.medium + byRisk.high !== candidates.total) fail('$.metrics.candidates.byRisk', 'risk counts do not sum to total');
  if (candidates.approved + candidates.rejected !== candidates.total) fail('$.metrics.candidates', 'review counts do not sum to total');
  const suite = object(metrics.suite, '$.metrics.suite');
  exactKeys(suite, ['compiled', 'schemaVersion', 'candidateCount', 'digest'], '$.metrics.suite');
  boolean(suite.compiled, '$.metrics.suite.compiled');
  nonempty(suite.schemaVersion, '$.metrics.suite.schemaVersion');
  integer(suite.candidateCount, '$.metrics.suite.candidateCount');
  match(suite.digest, /^[a-f0-9]{64}$/, '$.metrics.suite.digest', 'expected SHA-256');
  const replay = object(metrics.replay, '$.metrics.replay');
  exactKeys(replay, ['sessions', 'passed', 'suitePassed'], '$.metrics.replay');
  integer(replay.sessions, '$.metrics.replay.sessions');
  integer(replay.passed, '$.metrics.replay.passed');
  boolean(replay.suitePassed, '$.metrics.replay.suitePassed');
  if (replay.passed > replay.sessions) fail('$.metrics.replay.passed', 'cannot exceed replay sessions');
  const regression = object(metrics.controlledRegression, '$.metrics.controlledRegression');
  exactKeys(regression, ['mutationId', 'detected', 'suiteDetected', 'independentVerifierDetected'], '$.metrics.controlledRegression');
  nonempty(regression.mutationId, '$.metrics.controlledRegression.mutationId');
  for (const field of ['detected', 'suiteDetected', 'independentVerifierDetected'] as const) boolean(regression[field], `$.metrics.controlledRegression.${field}`);
  if (regression.detected !== (regression.suiteDetected || regression.independentVerifierDetected)) fail('$.metrics.controlledRegression.detected', 'must equal the union of detection channels');

  const cleanup = object(report.cleanup, '$.cleanup');
  exactKeys(cleanup, ['allChildProcessesExited', 'allFixtureRootsRemoved', 'workingDirectoryRemoved', 'emergencyCleanupUsed', 'rawArtifactsLocalOnly'], '$.cleanup');
  for (const field of ['allChildProcessesExited', 'allFixtureRootsRemoved', 'workingDirectoryRemoved', 'emergencyCleanupUsed', 'rawArtifactsLocalOnly'] as const) boolean(cleanup[field], `$.cleanup.${field}`);
  if (!cleanup.allChildProcessesExited || !cleanup.allFixtureRootsRemoved || !cleanup.workingDirectoryRemoved || cleanup.emergencyCleanupUsed || cleanup.rawArtifactsLocalOnly !== true) {
    fail('$.cleanup', 'complete non-emergency cleanup proof is required');
  }

  const accounting = object(report.providerAccounting, '$.providerAccounting');
  exactKeys(accounting, ['providerCalls', 'providerNetworkCalls', 'providerCredentialsRead', 'providerCostMicros', 'mockProviderTurns'], '$.providerAccounting');
  for (const field of ['providerCalls', 'providerNetworkCalls', 'providerCredentialsRead', 'providerCostMicros', 'mockProviderTurns'] as const) integer(accounting[field], `$.providerAccounting.${field}`);
  if (accounting.providerCalls !== 0 || accounting.providerNetworkCalls !== 0 || accounting.providerCredentialsRead !== 0 || accounting.providerCostMicros !== 0) {
    fail('$.providerAccounting', 'real provider, network, credential, and cost accounting must be zero');
  }
  if (accounting.mockProviderTurns !== metrics.mockProviderTurns) fail('$.providerAccounting.mockProviderTurns', 'must match metrics');

  const privacy = object(report.privacy, '$.privacy');
  exactKeys(privacy, [
    'telemetryEnabled', 'automaticUpload', 'privatePathsIncluded', 'rawTranscriptsIncluded',
    'rawToolPayloadsIncluded', 'rawEnvironmentIncluded', 'participantIdentityIncluded',
    'credentialsIncluded', 'protectedEvidenceIncluded', 'manualReviewRequiredBeforeSharing',
  ], '$.privacy');
  for (const field of ['telemetryEnabled', 'automaticUpload', 'privatePathsIncluded', 'rawTranscriptsIncluded', 'rawToolPayloadsIncluded', 'rawEnvironmentIncluded', 'participantIdentityIncluded', 'credentialsIncluded', 'protectedEvidenceIncluded'] as const) {
    if (privacy[field] !== false) fail(`$.privacy.${field}`, 'must be false');
  }
  if (privacy.manualReviewRequiredBeforeSharing !== true) fail('$.privacy.manualReviewRequiredBeforeSharing', 'must be true');

  if (report.participantFeedback !== null) validateParticipantFeedback(report.participantFeedback);
  const limitations = array(report.limitations, '$.limitations');
  if (limitations.length < 1 || limitations.length > 12) fail('$.limitations', 'expected 1–12 bounded limitations');
  limitations.forEach((entry, index) => bounded(entry, `$.limitations[${index}]`, 300));

  if (report.overallResult === 'passed') {
    if (nonPassCount !== 0 || stages.some((stage) => object(stage, '$.stages[]').status !== 'passed')) fail('$.overallResult', 'passed requires every stage to pass');
    if (trackA.status !== 'completed' || !suite.compiled || !replay.suitePassed || replay.sessions === 0 || replay.passed !== replay.sessions || !regression.detected) {
      fail('$.overallResult', 'passed requires compilation, replay, and controlled-regression detection');
    }
  } else if (nonPassCount === 0) {
    fail('$.overallResult', 'failed/cancelled report requires a failed or cancelled stage');
  }
  if (report.overallResult === 'failed' && trackA.status !== 'failed') fail('$.tracks.guidedTrackA.status', 'must match overall failure');
  if (report.overallResult === 'cancelled' && trackA.status !== 'cancelled') fail('$.tracks.guidedTrackA.status', 'must match cancellation');

  rejectSensitiveContent(report);
}

export function sanitizePilotMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/(?:\/Users|\/home|\/private|\/tmp|\/var\/folders)\/[\w./\\ -]+/gi, '<path>')
    .replace(/[A-Za-z]:\\[^\r\n]+/g, '<path>')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '<redacted>')
    .replace(/\b(?:sk-ant-|sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/g, '<redacted>')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 400) || 'bounded pilot failure';
}

function validateParticipantFeedback(value: unknown): void {
  const feedback = object(value, '$.participantFeedback');
  exactKeys(feedback, ['commentsReviewed', 'ratings', 'binaryAnswers', 'comments'], '$.participantFeedback');
  if (feedback.commentsReviewed !== true) fail('$.participantFeedback.commentsReviewed', 'must be true before comments enter a shareable report');
  const ratings = object(feedback.ratings, '$.participantFeedback.ratings');
  for (const [key, rating] of Object.entries(ratings)) {
    nonempty(key, '$.participantFeedback.ratings key');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(`$.participantFeedback.ratings.${key}`, 'expected 1–5');
  }
  const binary = object(feedback.binaryAnswers, '$.participantFeedback.binaryAnswers');
  for (const [key, answer] of Object.entries(binary)) {
    nonempty(key, '$.participantFeedback.binaryAnswers key');
    boolean(answer, `$.participantFeedback.binaryAnswers.${key}`);
  }
  array(feedback.comments, '$.participantFeedback.comments').forEach((entry, index) => bounded(entry, `$.participantFeedback.comments[${index}]`, 500));
}

function containsPrivateAbsolutePath(value: string): boolean {
  const comparison = value
    .normalize('NFKC')
    .replace(/[\u2044\u2215]/gu, '/')
    .replace(/\\/gu, '/');

  const privatePosixPath = /(?:^|[\s`"'([{<,;=:])\/(?:Users|home|private|tmp|var\/folders)\//;
  const privateWindowsPath = /(?:^|[\s`"'([{<,;=:])[A-Za-z]:\/(?:users|documents and settings|home)\//i;
  const uncPath = /(?:^|[\s`"'([{<,;=])\/\/[^/\s]+\/[^/\s]+(?:\/|$)/;
  const privatePosixFileUrl = /(?:^|[\s`"'([{<,;=])[Ff][Ii][Ll][Ee]:\/\/\/(?:Users|home|private|tmp|var\/folders)\//;
  const privateWindowsFileUrl = /(?:^|[\s`"'([{<,;=])file:\/\/\/[A-Za-z]:\/(?:users|documents and settings|home)\//i;
  const uncFileUrl = /(?:^|[\s`"'([{<,;=])file:\/\/[^/\s]+\/[^/\s]+(?:\/|$)/i;

  return privatePosixPath.test(comparison)
    || privateWindowsPath.test(comparison)
    || uncPath.test(comparison)
    || privatePosixFileUrl.test(comparison)
    || privateWindowsFileUrl.test(comparison)
    || uncFileUrl.test(comparison);
}

function rejectSensitiveString(value: string, path: string): void {
  if (containsPrivateAbsolutePath(value)) fail(path, 'absolute private path is forbidden');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-ant-|sk-|gh[pousr]_)[A-Za-z0-9_-]{20,}\b/.test(value)) fail(path, 'credential-shaped value is forbidden');
  if (/\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|AZURE_OPENAI_API_KEY|PATH|HOME)=/.test(value)) fail(path, 'raw environment value is forbidden');
  if (/"(?:jsonrpc|method|params|result)"\s*:|tools\/call/.test(value)) fail(path, 'raw transcript or tool payload content is forbidden');
}

function rejectSensitiveContent(report: Record<string, unknown>): void {
  const forbiddenKeys = new Set([
    'username', 'email', 'ipAddress', 'homeDirectory', 'repositoryPath', 'environment',
    'environmentVariables', 'transcript', 'rawTranscript', 'toolPayload', 'rawToolPayload',
    'rawRequest', 'rawResponse', 'sourceCode', 'credentialValue', 'protectedEvidence',
  ]);
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      rejectSensitiveString(value, path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        rejectSensitiveString(key, `${path} key`);
        if (forbiddenKeys.has(key)) fail(`${path}.${key}`, 'forbidden sensitive field');
        visit(entry, `${path}.${key}`);
      }
    }
  };
  visit(report, '$');
}

function object(value: unknown, path: string): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  return value as Record<string, any>;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected array');
  return value;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = [...keys].sort();
  const observed = Object.keys(value).sort();
  if (expected.length !== observed.length || expected.some((entry, index) => entry !== observed[index])) fail(path, `unexpected or missing fields: expected ${expected.join(', ')}`);
}
function nonempty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(path, 'expected non-empty string');
}
function bounded(value: unknown, path: string, maximum: number): asserts value is string {
  nonempty(value, path);
  if (value.length > maximum) fail(path, `string exceeds ${maximum} characters`);
}
function match(value: unknown, pattern: RegExp, path: string, message: string): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(path, message);
}
function member<T extends string>(value: unknown, values: readonly T[], path: string): asserts value is T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(path, `expected one of ${values.join(', ')}`);
}
function literal(value: unknown, expected: string, path: string): void {
  if (value !== expected) fail(path, `expected ${expected}`);
}
function integer(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(path, 'expected non-negative safe integer');
}
function boolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(path, 'expected boolean');
}
function timestamp(value: unknown, path: string): number {
  nonempty(value, path);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(path, 'expected canonical ISO-8601 timestamp');
  return parsed;
}
function fail(path: string, message: string): never {
  throw new Error(`invalid pilot report at ${path}: ${message}`);
}
