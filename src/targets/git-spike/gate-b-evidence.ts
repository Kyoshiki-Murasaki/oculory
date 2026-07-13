import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson } from '../../schema/canonical.js';
import { syncDirectoryEntry } from '../../schema/durable-write.js';
import type { Json, JsonObject } from '../../schema/types.js';

export const GATE_B_EVIDENCE_SCHEMA = 'oculory-git-gate-b-evidence-v2';
export const GATE_B_RUNNER_VERSION = 'gate-b-runner-v2';

export type GateBTrialKind = 'materialization' | 'direct';

export type GateBTerminalOutcome =
  | 'passed'
  | 'failed_execution'
  | 'failed_oracle'
  | 'failed_shutdown'
  | 'failed_cleanup'
  | 'failed_evidence_finalization'
  | 'inconclusive';

export type GateBFailureClass =
  | 'fixture_creation'
  | 'native_git_snapshot'
  | 'target_startup'
  | 'initialize'
  | 'tools_list'
  | 'tools_call'
  | 'post_call_snapshot'
  | 'target_shutdown'
  | 'process_group_verification'
  | 'sentinel_verification'
  | 'fixture_removal'
  | 'post_removal_absence_check'
  | 'oracle'
  | 'record_write'
  | 'aggregate_finalization'
  | 'report_finalization'
  | 'unexpected_exception';

export type GateBTrialPhase =
  | 'attempt_started'
  | 'fixture_created'
  | 'initial_snapshot_captured'
  | 'target_started'
  | 'initialized'
  | 'tools_list_completed'
  | 'tool_call_completed'
  | 'post_call_snapshot_captured'
  | 'target_shutdown_completed'
  | 'process_group_verified'
  | 'sentinel_verified'
  | 'fixture_removed'
  | 'post_removal_absence_verified'
  | 'terminal_record_prepared'
  | 'terminal_record_written';

export interface GateBFailureEntry {
  sequence: number;
  class: GateBFailureClass;
  phase: string;
  message: string;
  messageDigest: string;
  timeoutDeadlineMs: number | null;
  primary: boolean;
}

export interface GateBCleanupStepResult {
  step: string;
  attempted: boolean;
  passed: boolean | null;
  detail: string | null;
  failureClass: GateBFailureClass | null;
}

export interface GateBProcessEvidence {
  applicable: boolean;
  pid: number | null;
  started: boolean | null;
  exited: boolean | null;
  exitCode: number | null;
  signal: string | null;
  childAlive: boolean | null;
  processGroupManaged: boolean | null;
  processGroupAlive: boolean | null;
  allRequestsSettled: boolean | null;
}

export interface GateBTerminalTrialRecord {
  schema: typeof GATE_B_EVIDENCE_SCHEMA;
  runnerVersion: typeof GATE_B_RUNNER_VERSION;
  attemptId: string;
  parentCanonicalAttemptId: string;
  trialId: string;
  kind: GateBTrialKind;
  subjectId: string;
  trialIndex: number;
  startedAt: string;
  finishedAt: string;
  lastCompletedPhase: GateBTrialPhase;
  targetRuntimeProvenance: JsonObject;
  fixturePathToken: string | null;
  process: GateBProcessEvidence;
  completedCalls: Json[];
  journals: Json[];
  latestSnapshot: JsonObject | null;
  primaryFailure: GateBFailureEntry | null;
  secondaryFailures: GateBFailureEntry[];
  failureChain: GateBFailureEntry[];
  timeoutPhase: string | null;
  timeoutDeadlineMs: number | null;
  cleanupSteps: GateBCleanupStepResult[];
  fixturePresence: boolean | null;
  siblingSentinelUnchanged: boolean | null;
  evidenceComplete: boolean;
  missingEvidenceFields: string[];
  terminalOutcome: GateBTerminalOutcome;
  reportFinalizationStatus: 'pending' | 'written' | 'recovered_after_primary_write_failure';
  semanticSummary: JsonObject | null;
}

export interface GateBTrialEnvelope {
  schema: typeof GATE_B_EVIDENCE_SCHEMA;
  recordSha256: string;
  record: GateBTerminalTrialRecord;
}

export interface GateBAttemptManifest {
  schema: typeof GATE_B_EVIDENCE_SCHEMA;
  runnerVersion: typeof GATE_B_RUNNER_VERSION;
  attemptId: string;
  predecessorFailedAttemptId: string;
  source: JsonObject;
  runtime: JsonObject;
  thresholds: {
    materializationsPerRecipe: number;
    trialsPerPlan: number;
    recipes: string[];
    plans: string[];
  };
  startedAt: string;
  completionStatus: 'running' | 'passed' | 'failed' | 'inconclusive';
}

export interface GateBAggregateReport {
  schema: typeof GATE_B_EVIDENCE_SCHEMA;
  attemptId: string;
  generatedAt: string;
  expectedTerminalRecords: number;
  actualTerminalRecords: number;
  missingTrialIds: string[];
  unexpectedTrialIds: string[];
  duplicateTrialIds: string[];
  invalidRecordFiles: string[];
  temporaryFiles: string[];
  recordChecksumPassed: boolean;
  incompleteAttempt: boolean;
  outcomeCounts: Record<GateBTerminalOutcome, number>;
  reportFinalizationFailure: GateBFailureEntry | null;
  semanticEvaluation: JsonObject | null;
  decision: 'passed' | 'failed' | 'inconclusive';
  trialDigests: Array<{ trialId: string; path: string; sha256: string }>;
}

export interface GateBTrialIdentity {
  attemptId: string;
  parentCanonicalAttemptId: string;
  trialId: string;
  kind: GateBTrialKind;
  subjectId: string;
  trialIndex: number;
  targetRuntimeProvenance: JsonObject;
}

export class GateBTrialRecorder {
  private readonly startedAt = new Date().toISOString();
  private lastCompletedPhase: GateBTrialPhase = 'attempt_started';
  private fixturePathToken: string | null = null;
  private process: GateBProcessEvidence;
  private completedCalls: Json[] = [];
  private journals: Json[] = [];
  private latestSnapshot: JsonObject | null = null;
  private readonly failures: GateBFailureEntry[] = [];
  private readonly cleanupSteps: GateBCleanupStepResult[] = [];
  private fixturePresence: boolean | null = null;
  private siblingSentinelUnchanged: boolean | null = null;
  private semanticSummary: JsonObject | null = null;

  constructor(private readonly identity: GateBTrialIdentity) {
    validateIdentifier(identity.attemptId, 'attempt ID');
    validateIdentifier(identity.parentCanonicalAttemptId, 'parent canonical-attempt ID');
    validateIdentifier(identity.trialId, 'trial ID');
    validateIdentifier(identity.subjectId, 'recipe/plan ID');
    if (!Number.isInteger(identity.trialIndex) || identity.trialIndex <= 0) {
      throw new Error('trial index must be a positive integer');
    }
    this.process = unknownProcess(identity.kind === 'direct');
  }

  complete(phase: GateBTrialPhase): void {
    this.lastCompletedPhase = phase;
  }

  setFixturePathToken(value: string | null): void {
    this.fixturePathToken = value;
  }

  setProcess(value: Partial<GateBProcessEvidence>): void {
    this.process = { ...this.process, ...value };
  }

  setCalls(value: readonly Json[]): void {
    this.completedCalls = structuredClone([...value]);
  }

  setJournals(value: readonly Json[]): void {
    this.journals = structuredClone([...value]);
  }

  setLatestSnapshot(value: JsonObject | null): void {
    this.latestSnapshot = value === null ? null : structuredClone(value);
  }

  setSemanticSummary(value: JsonObject | null): void {
    this.semanticSummary = value === null ? null : structuredClone(value);
  }

  setFixturePresence(value: boolean | null): void {
    this.fixturePresence = value;
  }

  setSentinelUnchanged(value: boolean | null): void {
    this.siblingSentinelUnchanged = value;
  }

  cleanupStep(value: GateBCleanupStepResult): void {
    this.cleanupSteps.push(structuredClone(value));
  }

  fail(
    failureClass: GateBFailureClass,
    phase: string,
    error: unknown,
    timeoutDeadlineMs: number | null = null,
  ): GateBFailureEntry {
    const message = errorMessage(error);
    const entry: GateBFailureEntry = {
      sequence: this.failures.length + 1,
      class: failureClass,
      phase,
      message,
      messageDigest: sha256(Buffer.from(message, 'utf8')),
      timeoutDeadlineMs,
      primary: this.failures.length === 0,
    };
    this.failures.push(entry);
    return entry;
  }

  finalize(outcome?: GateBTerminalOutcome): GateBTerminalTrialRecord {
    const missing = this.missingFields();
    return {
      schema: GATE_B_EVIDENCE_SCHEMA,
      runnerVersion: GATE_B_RUNNER_VERSION,
      ...this.identity,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      lastCompletedPhase: this.lastCompletedPhase,
      fixturePathToken: this.fixturePathToken,
      process: structuredClone(this.process),
      completedCalls: structuredClone(this.completedCalls),
      journals: structuredClone(this.journals),
      latestSnapshot: this.latestSnapshot === null ? null : structuredClone(this.latestSnapshot),
      primaryFailure: this.failures[0] === undefined ? null : structuredClone(this.failures[0]),
      secondaryFailures: structuredClone(this.failures.slice(1)),
      failureChain: structuredClone(this.failures),
      timeoutPhase: this.failures.find((failure) => failure.timeoutDeadlineMs !== null)?.phase ?? null,
      timeoutDeadlineMs: this.failures.find((failure) => failure.timeoutDeadlineMs !== null)?.timeoutDeadlineMs ?? null,
      cleanupSteps: structuredClone(this.cleanupSteps),
      fixturePresence: this.fixturePresence,
      siblingSentinelUnchanged: this.siblingSentinelUnchanged,
      evidenceComplete: missing.length === 0,
      missingEvidenceFields: missing,
      terminalOutcome: outcome ?? outcomeForFailures(this.failures, missing),
      reportFinalizationStatus: 'pending',
      semanticSummary: this.semanticSummary === null ? null : structuredClone(this.semanticSummary),
    };
  }

  private missingFields(): string[] {
    const missing: string[] = [];
    if (this.fixturePathToken === null) missing.push('fixturePathToken');
    if (this.identity.kind === 'direct' && this.process.started === null) missing.push('process.started');
    if (this.latestSnapshot === null) missing.push('latestSnapshot');
    if (this.fixturePresence === null) missing.push('fixturePresence');
    if (this.siblingSentinelUnchanged === null) missing.push('siblingSentinelUnchanged');
    if (this.identity.kind === 'direct' && this.process.childAlive === null) missing.push('process.childAlive');
    if (this.identity.kind === 'direct' && this.process.processGroupAlive === null) missing.push('process.processGroupAlive');
    return missing;
  }
}

export class GateBEvidenceStore {
  public readonly outputDirectory: string;
  public readonly trialsDirectory: string;
  private readonly writtenTrialIds = new Set<string>();
  private initializedAttemptId: string | null = null;

  constructor(outputDirectory: string) {
    this.outputDirectory = resolve(outputDirectory);
    this.trialsDirectory = join(this.outputDirectory, 'trials');
  }

  initialize(manifest: GateBAttemptManifest): void {
    if (existsSync(this.outputDirectory)) throw new Error(`attempt output directory already exists: ${this.outputDirectory}`);
    mkdirSync(this.trialsDirectory, { recursive: true, mode: 0o700 });
    this.writeAtomic(join(this.outputDirectory, 'attempt.json'), manifest as unknown as Json);
    this.initializedAttemptId = manifest.attemptId;
  }

  writeTrial(record: GateBTerminalTrialRecord): GateBTrialEnvelope {
    return this.writeTrialAt(record, this.trialPath(record), 'written');
  }

  writeRecoveredTrial(record: GateBTerminalTrialRecord): GateBTrialEnvelope {
    const path = this.trialPath(record).replace(/\.json$/, '.recovered.json');
    return this.writeTrialAt(record, path, 'recovered_after_primary_write_failure');
  }

  compileAggregate(expectedTrialIds: readonly string[]): GateBAggregateReport {
    const expected = new Set(expectedTrialIds);
    if (expected.size !== expectedTrialIds.length) throw new Error('expected trial IDs contain duplicates');
    const invalidRecordFiles: string[] = [];
    const temporaryFiles = readdirSync(this.trialsDirectory).filter((name) => name.includes('.tmp-')).sort();
    const byTrial = new Map<string, Array<{ envelope: GateBTrialEnvelope; name: string }>>();
    for (const name of readdirSync(this.trialsDirectory).filter((entry) => entry.endsWith('.json')).sort()) {
      const path = join(this.trialsDirectory, name);
      try {
        const envelope = JSON.parse(readFileSync(path, 'utf8')) as GateBTrialEnvelope;
        validateEnvelope(envelope);
        const entries = byTrial.get(envelope.record.trialId) ?? [];
        entries.push({ envelope, name });
        byTrial.set(envelope.record.trialId, entries);
      } catch {
        invalidRecordFiles.push(name);
      }
    }
    const duplicateTrialIds = [...byTrial.entries()].filter(([, entries]) => entries.length !== 1).map(([id]) => id).sort();
    const missingTrialIds = [...expected].filter((id) => !byTrial.has(id)).sort();
    const unexpectedTrialIds = [...byTrial.keys()].filter((id) => !expected.has(id)).sort();
    const validEntries = [...byTrial.values()].filter((entries) => entries.length === 1).map((entries) => entries[0]!);
    const outcomeCounts = emptyOutcomeCounts();
    for (const { envelope } of validEntries) outcomeCounts[envelope.record.terminalOutcome] += 1;
    const incompleteAttempt =
      missingTrialIds.length > 0 || unexpectedTrialIds.length > 0 || duplicateTrialIds.length > 0 || invalidRecordFiles.length > 0 ||
      temporaryFiles.length > 0 || validEntries.length !== expected.size ||
      validEntries.some(({ envelope }) => !envelope.record.evidenceComplete);
    const allPassed = validEntries.length === expected.size && validEntries.every(({ envelope }) => envelope.record.terminalOutcome === 'passed');
    return {
      schema: GATE_B_EVIDENCE_SCHEMA,
      attemptId: validEntries[0]?.envelope.record.attemptId ?? '<unknown>',
      generatedAt: new Date().toISOString(),
      expectedTerminalRecords: expected.size,
      actualTerminalRecords: validEntries.length,
      missingTrialIds,
      unexpectedTrialIds,
      duplicateTrialIds,
      invalidRecordFiles,
      temporaryFiles,
      recordChecksumPassed: invalidRecordFiles.length === 0,
      incompleteAttempt,
      outcomeCounts,
      reportFinalizationFailure: null,
      semanticEvaluation: null,
      decision: allPassed && !incompleteAttempt ? 'passed' : 'failed',
      trialDigests: validEntries.map(({ envelope, name }) => ({
        trialId: envelope.record.trialId,
        path: `trials/${name}`,
        sha256: envelope.recordSha256,
      })).sort((a, b) => a.trialId.localeCompare(b.trialId)),
    };
  }

  writeAggregate(report: GateBAggregateReport): void {
    this.writeAtomic(join(this.outputDirectory, 'aggregate.json'), report as unknown as Json);
    this.writeChecksums();
  }

  writeAggregateFailure(report: GateBAggregateReport, failure: GateBFailureEntry): void {
    const failed: GateBAggregateReport = { ...report, reportFinalizationFailure: failure, decision: 'failed' };
    this.writeAtomic(join(this.outputDirectory, 'aggregate.failed.json'), failed as unknown as Json);
    this.writeChecksums();
  }

  updateAttempt(manifest: GateBAttemptManifest): void {
    this.writeAtomic(join(this.outputDirectory, 'attempt.json'), manifest as unknown as Json);
  }

  private writeTrialAt(
    input: GateBTerminalTrialRecord,
    path: string,
    status: GateBTerminalTrialRecord['reportFinalizationStatus'],
  ): GateBTrialEnvelope {
    if (this.writtenTrialIds.has(input.trialId)) throw new Error(`duplicate terminal trial ID: ${input.trialId}`);
    if (this.initializedAttemptId === null || input.attemptId !== this.initializedAttemptId) {
      throw new Error(`terminal trial attempt ID does not match initialized attempt: ${input.attemptId}`);
    }
    const record = structuredClone(input);
    record.reportFinalizationStatus = status;
    const recordSha256 = sha256(Buffer.from(canonicalJson(record as unknown as JsonObject), 'utf8'));
    const envelope: GateBTrialEnvelope = { schema: GATE_B_EVIDENCE_SCHEMA, recordSha256, record };
    try {
      this.writeAtomic(path, envelope as unknown as Json);
    } catch (error) {
      if (!existsSync(path)) throw error;
      const retained = JSON.parse(readFileSync(path, 'utf8')) as GateBTrialEnvelope;
      validateEnvelope(retained);
      if (retained.record.trialId !== record.trialId) throw error;
      this.writtenTrialIds.add(record.trialId);
      return retained;
    }
    this.writtenTrialIds.add(record.trialId);
    return envelope;
  }

  private trialPath(record: GateBTerminalTrialRecord): string {
    const prefix = record.kind === 'materialization' ? 'materialization' : 'direct';
    return join(this.trialsDirectory, `${prefix}-${record.subjectId}-${String(record.trialIndex).padStart(2, '0')}.json`);
  }

  private writeAtomic(path: string, value: Json): void {
    this.writeAtomicBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
  }

  private writeAtomicText(path: string, value: string): void {
    this.writeAtomicBytes(path, Buffer.from(value, 'utf8'));
  }

  private writeAtomicBytes(path: string, bytes: Buffer): void {
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, path);
      syncDirectoryEntry(dirname(path));
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      throw error;
    }
  }

  private writeChecksums(): void {
    const files = ['attempt.json', ...readdirSync(this.trialsDirectory).filter((name) => name.endsWith('.json')).map((name) => `trials/${name}`)];
    for (const aggregate of ['aggregate.json', 'aggregate.failed.json']) {
      if (existsSync(join(this.outputDirectory, aggregate))) files.push(aggregate);
    }
    const lines = files.sort().map((relativePath) => {
      const digest = sha256(readFileSync(join(this.outputDirectory, relativePath)));
      return `${digest}  ${relativePath}`;
    });
    this.writeAtomicText(join(this.outputDirectory, 'checksums.sha256'), lines.join('\n') + '\n');
  }
}

export function persistTerminalRecord(
  store: GateBEvidenceStore,
  recorder: GateBTrialRecorder,
  outcome?: GateBTerminalOutcome,
  injectPrimaryWriteFailure = false,
): GateBTrialEnvelope {
  let record = recorder.finalize(outcome);
  try {
    if (injectPrimaryWriteFailure) throw new Error('injected primary per-trial record write failure');
    return store.writeTrial(record);
  } catch (error) {
    recorder.fail('record_write', 'per_trial_record_write', error);
    record = recorder.finalize('failed_evidence_finalization');
    return store.writeRecoveredTrial(record);
  }
}

export function aggregateFailureEntry(error: unknown): GateBFailureEntry {
  const message = errorMessage(error);
  return {
    sequence: 1,
    class: 'aggregate_finalization',
    phase: 'aggregate_report_finalization',
    message,
    messageDigest: sha256(Buffer.from(message, 'utf8')),
    timeoutDeadlineMs: null,
    primary: true,
  };
}

export function removeAttemptDirectoryForTest(path: string): void {
  rmSync(resolve(path), { recursive: true, force: true });
}

function validateEnvelope(envelope: GateBTrialEnvelope): void {
  if (envelope.schema !== GATE_B_EVIDENCE_SCHEMA || envelope.record.schema !== GATE_B_EVIDENCE_SCHEMA) {
    throw new Error('terminal record schema mismatch');
  }
  const observed = sha256(Buffer.from(canonicalJson(envelope.record as unknown as JsonObject), 'utf8'));
  if (observed !== envelope.recordSha256) throw new Error('terminal record checksum mismatch');
}

function outcomeForFailures(failures: readonly GateBFailureEntry[], missing: readonly string[]): GateBTerminalOutcome {
  const primary = failures[0];
  if (primary === undefined) return missing.length === 0 ? 'passed' : 'inconclusive';
  if (primary.class === 'record_write' || primary.class === 'report_finalization') return 'failed_evidence_finalization';
  if (primary.class === 'oracle' || primary.class === 'native_git_snapshot' || primary.class === 'post_call_snapshot') return 'failed_oracle';
  if (primary.class === 'target_shutdown') return 'failed_shutdown';
  if (['process_group_verification', 'sentinel_verification', 'fixture_removal', 'post_removal_absence_check'].includes(primary.class)) return 'failed_cleanup';
  return 'failed_execution';
}

function unknownProcess(applicable: boolean): GateBProcessEvidence {
  return {
    applicable,
    pid: null,
    started: applicable ? null : false,
    exited: applicable ? null : false,
    exitCode: null,
    signal: null,
    childAlive: applicable ? null : false,
    processGroupManaged: applicable ? null : false,
    processGroupAlive: applicable ? null : false,
    allRequestsSettled: applicable ? null : true,
  };
}

function emptyOutcomeCounts(): Record<GateBTerminalOutcome, number> {
  return {
    passed: 0,
    failed_execution: 0,
    failed_oracle: 0,
    failed_shutdown: 0,
    failed_cleanup: 0,
    failed_evidence_finalization: 0,
    inconclusive: 0,
  };
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(value)) throw new Error(`invalid ${label}: ${value}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
