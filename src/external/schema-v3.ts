import { hashJson } from '../schema/canonical.js';
import type { Json, JsonObject } from '../schema/types.js';

export const EXTERNAL_TRACE_SCHEMA_VERSION = 'external-trace-v3' as const;
export const EXTERNAL_RUN_MANIFEST_VERSION = 'external-run-manifest-v1' as const;

export type ExternalPartition = 'smoke' | 'mining' | 'holdout' | 'adversarial';
export type ExternalOutcome =
  | 'verified_success'
  | 'valid_rejection'
  | 'verified_failure'
  | 'partial_success'
  | 'invalid_acceptance'
  | 'unknown';

export type ExternalCallClass =
  | 'tool_success'
  | 'tool_error'
  | 'json_rpc_error'
  | 'invalid_response'
  | 'transport_eof'
  | 'process_crash'
  | 'timeout'
  | 'cancelled'
  | 'oracle_failure'
  | 'cleanup_failure';

export interface ExternalSidecarReference {
  path: string;
  sha256: string;
  bytes: number;
  mediaType: 'application/json' | 'application/jsonl' | 'text/plain';
  pointer?: string;
}

export interface ExternalCallRecord {
  index: number;
  tool: string;
  arguments: JsonObject;
  requestId: number | null;
  classification: ExternalCallClass;
  isError: boolean | null;
  jsonRpcError: { code: number; message: string; data: Json | null } | null;
  rawResultDigest: string | null;
  beforeSnapshot: ExternalSidecarReference;
  afterSnapshot: ExternalSidecarReference;
  exactDiff: ExternalSidecarReference;
}

export interface ExternalTraceV3 {
  schemaVersion: typeof EXTERNAL_TRACE_SCHEMA_VERSION;
  traceId: string;
  runId: string;
  trialId: string;
  trialIndex: number;
  scenarioId: string;
  scenarioVersion: string;
  partition: ExternalPartition;
  scenarioFamilyId: string;
  target: {
    id: 'mcp-server-git';
    packageVersion: string;
    wheelSha256: string;
    sourceSha256: string;
    executableSha256: string;
    dependencyLockSha256: string;
  };
  runtime: {
    python: string;
    git: string;
    node: string;
    os: string;
    architecture: string;
  };
  source: { commit: string; dirty: boolean; sourceTreeDigest: string };
  adapterVersion: string;
  verifierVersion: string;
  fixtureRecipe: { version: string; digest: string };
  catalogue: { version: string; digest: string };
  negotiatedProtocol: string;
  serverInfo: JsonObject;
  capabilities: JsonObject;
  discoveryDigest: string;
  discovery: ExternalSidecarReference;
  intendedEntities: JsonObject;
  orderedCalls: ExternalCallRecord[];
  transcript: ExternalSidecarReference;
  stateJournal: ExternalSidecarReference;
  finalSnapshot: ExternalSidecarReference;
  verifierResult: JsonObject;
  cleanup: ExternalSidecarReference;
  siblingSentinelPassed: boolean;
  normalizationRules: string[];
  evidenceCompleteness: { complete: boolean; missing: string[]; corrupt: string[] };
  terminalRecordDigest: string;
}

export interface ExternalTrialRecord {
  schemaVersion: typeof EXTERNAL_TRACE_SCHEMA_VERSION;
  trace: ExternalTraceV3;
  goldenExpected: ExternalOutcome;
  goldenObserved: ExternalOutcome;
  verifierSubtype: string | null;
  allowedCallPath: boolean;
  unexpectedLayers: string[];
  cleanupPassed: boolean;
  siblingSentinelPassed: boolean;
  terminalStatus: 'passed' | 'failed' | 'inconclusive';
}

export interface ExternalTrialEnvelope {
  schemaVersion: typeof EXTERNAL_TRACE_SCHEMA_VERSION;
  recordSha256: string;
  record: ExternalTrialRecord;
}

export interface ExternalRunManifest {
  schemaVersion: typeof EXTERNAL_RUN_MANIFEST_VERSION;
  externalTraceSchema: typeof EXTERNAL_TRACE_SCHEMA_VERSION;
  runId: string;
  finalized: true;
  implementationCommit: string;
  dirty: false;
  sourceTreeDigest: string;
  target: JsonObject;
  runtime: JsonObject;
  adapterVersion: string;
  verifierVersion: string;
  fixtureRecipeVersion: string;
  fixtureRecipeDigest: string;
  catalogueVersion: string;
  catalogueDigest: string;
  minerVersion: string;
  normalizationRules: string[];
  partitionCounts: Record<ExternalPartition, number>;
  trialCount: number;
  outcomeCounts: Record<ExternalOutcome, number>;
  decision: 'completed' | 'failed' | 'inconclusive';
}

const PARTITIONS = ['smoke', 'mining', 'holdout', 'adversarial'] as const;
const OUTCOMES = ['verified_success', 'valid_rejection', 'verified_failure', 'partial_success', 'invalid_acceptance', 'unknown'] as const;
const CALL_CLASSES = ['tool_success', 'tool_error', 'json_rpc_error', 'invalid_response', 'transport_eof', 'process_crash', 'timeout', 'cancelled', 'oracle_failure', 'cleanup_failure'] as const;

export function validateExternalTraceV3(value: unknown): asserts value is ExternalTraceV3 {
  const trace = object(value, '$');
  literal(trace.schemaVersion, EXTERNAL_TRACE_SCHEMA_VERSION, '$.schemaVersion');
  for (const field of ['traceId', 'runId', 'trialId', 'scenarioId', 'scenarioVersion', 'scenarioFamilyId', 'adapterVersion', 'verifierVersion', 'negotiatedProtocol', 'discoveryDigest', 'terminalRecordDigest'] as const) {
    string(trace[field], `$.${field}`);
  }
  integer(trace.trialIndex, '$.trialIndex');
  member(trace.partition, PARTITIONS, '$.partition');
  const target = object(trace.target, '$.target');
  literal(target.id, 'mcp-server-git', '$.target.id');
  string(target.packageVersion, '$.target.packageVersion');
  for (const field of ['wheelSha256', 'sourceSha256', 'executableSha256', 'dependencyLockSha256'] as const) digest(target[field], `$.target.${field}`);
  const runtime = object(trace.runtime, '$.runtime');
  for (const field of ['python', 'git', 'node', 'os', 'architecture'] as const) string(runtime[field], `$.runtime.${field}`);
  const source = object(trace.source, '$.source');
  string(source.commit, '$.source.commit');
  boolean(source.dirty, '$.source.dirty');
  digest(source.sourceTreeDigest, '$.source.sourceTreeDigest');
  const fixtureRecipe = object(trace.fixtureRecipe, '$.fixtureRecipe');
  string(fixtureRecipe.version, '$.fixtureRecipe.version');
  digest(fixtureRecipe.digest, '$.fixtureRecipe.digest');
  const catalogue = object(trace.catalogue, '$.catalogue');
  string(catalogue.version, '$.catalogue.version');
  digest(catalogue.digest, '$.catalogue.digest');
  object(trace.serverInfo, '$.serverInfo');
  object(trace.capabilities, '$.capabilities');
  object(trace.intendedEntities, '$.intendedEntities');
  reference(trace.discovery, '$.discovery');
  reference(trace.transcript, '$.transcript');
  reference(trace.stateJournal, '$.stateJournal');
  reference(trace.finalSnapshot, '$.finalSnapshot');
  reference(trace.cleanup, '$.cleanup');
  const calls = array(trace.orderedCalls, '$.orderedCalls');
  for (let index = 0; index < calls.length; index += 1) {
    const call = object(calls[index], `$.orderedCalls[${index}]`);
    integer(call.index, `$.orderedCalls[${index}].index`);
    if (call.index !== index) fail(`$.orderedCalls[${index}].index`, 'call indexes must be contiguous and ordered');
    string(call.tool, `$.orderedCalls[${index}].tool`);
    object(call.arguments, `$.orderedCalls[${index}].arguments`);
    nullableInteger(call.requestId, `$.orderedCalls[${index}].requestId`);
    member(call.classification, CALL_CLASSES, `$.orderedCalls[${index}].classification`);
    nullableBoolean(call.isError, `$.orderedCalls[${index}].isError`);
    nullableDigest(call.rawResultDigest, `$.orderedCalls[${index}].rawResultDigest`);
    if (call.jsonRpcError !== null) {
      const rpc = object(call.jsonRpcError, `$.orderedCalls[${index}].jsonRpcError`);
      signedInteger(rpc.code, `$.orderedCalls[${index}].jsonRpcError.code`);
      string(rpc.message, `$.orderedCalls[${index}].jsonRpcError.message`);
      if (!('data' in rpc)) fail(`$.orderedCalls[${index}].jsonRpcError.data`, 'required');
    }
    if (call.classification === 'tool_success' && call.isError !== false) fail(`$.orderedCalls[${index}].isError`, 'tool_success requires false');
    if (call.classification === 'tool_error' && call.isError !== true) fail(`$.orderedCalls[${index}].isError`, 'tool_error requires true');
    if (call.classification === 'json_rpc_error' && call.jsonRpcError === null) fail(`$.orderedCalls[${index}].jsonRpcError`, 'json_rpc_error requires error data');
    reference(call.beforeSnapshot, `$.orderedCalls[${index}].beforeSnapshot`);
    reference(call.afterSnapshot, `$.orderedCalls[${index}].afterSnapshot`);
    reference(call.exactDiff, `$.orderedCalls[${index}].exactDiff`);
  }
  object(trace.verifierResult, '$.verifierResult');
  array(trace.normalizationRules, '$.normalizationRules').forEach((entry, index) => string(entry, `$.normalizationRules[${index}]`));
  const completeness = object(trace.evidenceCompleteness, '$.evidenceCompleteness');
  boolean(completeness.complete, '$.evidenceCompleteness.complete');
  stringArray(completeness.missing, '$.evidenceCompleteness.missing');
  stringArray(completeness.corrupt, '$.evidenceCompleteness.corrupt');
  boolean(trace.siblingSentinelPassed, '$.siblingSentinelPassed');
  digest(trace.discoveryDigest, '$.discoveryDigest');
  digest(trace.terminalRecordDigest, '$.terminalRecordDigest');
}

export function validateExternalTrialEnvelope(value: unknown): asserts value is ExternalTrialEnvelope {
  const envelope = object(value, '$');
  literal(envelope.schemaVersion, EXTERNAL_TRACE_SCHEMA_VERSION, '$.schemaVersion');
  digest(envelope.recordSha256, '$.recordSha256');
  const record = object(envelope.record, '$.record');
  literal(record.schemaVersion, EXTERNAL_TRACE_SCHEMA_VERSION, '$.record.schemaVersion');
  validateExternalTraceV3(record.trace);
  member(record.goldenExpected, OUTCOMES, '$.record.goldenExpected');
  member(record.goldenObserved, OUTCOMES, '$.record.goldenObserved');
  if (record.verifierSubtype !== null) string(record.verifierSubtype, '$.record.verifierSubtype');
  boolean(record.allowedCallPath, '$.record.allowedCallPath');
  stringArray(record.unexpectedLayers, '$.record.unexpectedLayers');
  boolean(record.cleanupPassed, '$.record.cleanupPassed');
  boolean(record.siblingSentinelPassed, '$.record.siblingSentinelPassed');
  member(record.terminalStatus, ['passed', 'failed', 'inconclusive'] as const, '$.record.terminalStatus');
  const verifier = object(record.trace.verifierResult, '$.record.trace.verifierResult');
  member(verifier.outcome, OUTCOMES, '$.record.trace.verifierResult.outcome');
  if (verifier.outcome !== record.goldenObserved) fail('$.record.goldenObserved', 'must equal verifier outcome');
  if (record.trace.siblingSentinelPassed !== record.siblingSentinelPassed) fail('$.record.siblingSentinelPassed', 'must match trace sentinel result');
  const qualifiesAsPass = record.goldenExpected === record.goldenObserved && record.allowedCallPath &&
    record.unexpectedLayers.length === 0 && record.cleanupPassed && record.siblingSentinelPassed && record.trace.evidenceCompleteness.complete;
  if (record.terminalStatus === 'passed' && !qualifiesAsPass) fail('$.record.terminalStatus', 'passed record does not meet terminal criteria');
  if (record.terminalStatus === 'inconclusive' && record.goldenObserved !== 'unknown') fail('$.record.terminalStatus', 'inconclusive requires unknown outcome');
  const observed = hashJson(record as unknown as Json);
  if (observed !== envelope.recordSha256) fail('$.recordSha256', 'terminal-record digest mismatch');
  const terminalDigestInput = {
    ...record,
    trace: { ...record.trace, terminalRecordDigest: '<BOUND_BY_ENVELOPE>' },
  };
  const terminalDigest = hashJson(terminalDigestInput as unknown as Json);
  if (terminalDigest !== record.trace.terminalRecordDigest) {
    fail('$.record.trace.terminalRecordDigest', 'terminal trace binding mismatch');
  }
}

export function validateExternalRunManifest(value: unknown): asserts value is ExternalRunManifest {
  const manifest = object(value, '$');
  literal(manifest.schemaVersion, EXTERNAL_RUN_MANIFEST_VERSION, '$.schemaVersion');
  literal(manifest.externalTraceSchema, EXTERNAL_TRACE_SCHEMA_VERSION, '$.externalTraceSchema');
  string(manifest.runId, '$.runId');
  if (manifest.finalized !== true) fail('$.finalized', 'expected true');
  string(manifest.implementationCommit, '$.implementationCommit');
  if (manifest.dirty !== false) fail('$.dirty', 'authoritative manifests require false');
  digest(manifest.sourceTreeDigest, '$.sourceTreeDigest');
  const target = object(manifest.target, '$.target');
  for (const field of ['id', 'version'] as const) string(target[field], `$.target.${field}`);
  for (const field of ['wheelSha256', 'installedSourceSha256', 'executableSha256', 'dependencyLockSha256'] as const) digest(target[field], `$.target.${field}`);
  const runtime = object(manifest.runtime, '$.runtime');
  for (const field of ['python', 'uv', 'git', 'node', 'os', 'architecture'] as const) string(runtime[field], `$.runtime.${field}`);
  integer(runtime.distributions, '$.runtime.distributions');
  for (const field of ['adapterVersion', 'verifierVersion', 'fixtureRecipeVersion', 'catalogueVersion', 'minerVersion'] as const) string(manifest[field], `$.${field}`);
  for (const field of ['fixtureRecipeDigest', 'catalogueDigest'] as const) digest(manifest[field], `$.${field}`);
  stringArray(manifest.normalizationRules, '$.normalizationRules');
  const partitionCounts = object(manifest.partitionCounts, '$.partitionCounts');
  const outcomeCounts = object(manifest.outcomeCounts, '$.outcomeCounts');
  for (const partition of PARTITIONS) integer(partitionCounts[partition], `$.partitionCounts.${partition}`);
  for (const outcome of OUTCOMES) integer(outcomeCounts[outcome], `$.outcomeCounts.${outcome}`);
  integer(manifest.trialCount, '$.trialCount');
  const partitionTotal = PARTITIONS.reduce((sum, partition) => sum + Number(partitionCounts[partition]), 0);
  const outcomeTotal = OUTCOMES.reduce((sum, outcome) => sum + Number(outcomeCounts[outcome]), 0);
  if (partitionTotal !== manifest.trialCount) fail('$.partitionCounts', 'counts do not sum to trialCount');
  if (outcomeTotal !== manifest.trialCount) fail('$.outcomeCounts', 'counts do not sum to trialCount');
  member(manifest.decision, ['completed', 'failed', 'inconclusive'] as const, '$.decision');
}

export function externalSidecarReferences(trace: ExternalTraceV3): ExternalSidecarReference[] {
  return [
    trace.discovery,
    trace.transcript,
    trace.stateJournal,
    trace.finalSnapshot,
    trace.cleanup,
    ...trace.orderedCalls.flatMap((call) => [call.beforeSnapshot, call.afterSnapshot, call.exactDiff]),
  ];
}

function reference(value: unknown, path: string): asserts value is ExternalSidecarReference {
  const ref = object(value, path);
  string(ref.path, `${path}.path`);
  if (ref.path.startsWith('/') || ref.path.split(/[\\/]/).includes('..')) fail(`${path}.path`, 'expected safe run-relative path');
  digest(ref.sha256, `${path}.sha256`);
  integer(ref.bytes, `${path}.bytes`);
  member(ref.mediaType, ['application/json', 'application/jsonl', 'text/plain'] as const, `${path}.mediaType`);
  if (ref.pointer !== undefined && (typeof ref.pointer !== 'string' || (!ref.pointer.startsWith('/') && ref.pointer !== ''))) {
    fail(`${path}.pointer`, 'expected JSON Pointer');
  }
}

function object(value: unknown, path: string): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  return value as Record<string, any>;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected array');
  return value;
}
function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected non-empty string');
}
function integer(value: unknown, path: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0) fail(path, 'expected non-negative integer');
}
function signedInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isInteger(value)) fail(path, 'expected integer');
}
function nullableInteger(value: unknown, path: string): void {
  if (value !== null) integer(value, path);
}
function nullableBoolean(value: unknown, path: string): void {
  if (value !== null) boolean(value, path);
}
function digest(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(path, 'expected SHA-256 hex digest');
}
function nullableDigest(value: unknown, path: string): void {
  if (value !== null) digest(value, path);
}
function stringArray(value: unknown, path: string): void {
  array(value, path).forEach((entry, index) => string(entry, `${path}[${index}]`));
}
function member<T extends string>(value: unknown, values: readonly T[], path: string): asserts value is T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(path, `expected one of ${values.join(', ')}`);
}
function boolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(path, 'expected boolean');
}
function literal(value: unknown, expected: string, path: string): void {
  if (value !== expected) fail(path, `expected ${expected}`);
}
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}
