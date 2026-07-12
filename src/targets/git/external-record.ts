import { hashJson } from '../../schema/canonical.js';
import type { Json, JsonObject } from '../../schema/types.js';
import type { ExternalRunStore } from '../../external/run-store.js';
import {
  EXTERNAL_TRACE_SCHEMA_VERSION,
  type ExternalCallClass,
  type ExternalTraceV3,
  type ExternalTrialEnvelope,
  type ExternalTrialRecord,
} from '../../external/schema-v3.js';
import { GIT_SPIKE_TARGET, type GitSpikeRuntimeInspection } from '../git-spike/config.js';
import type { GitScriptedScenarioResult } from './scripted-driver.js';
import {
  GIT_GATE_E1_ADAPTER_VERSION,
  GIT_GATE_E1_CATALOGUE_DIGEST,
  GIT_GATE_E1_CATALOGUE_VERSION,
  type GitGateE1Scenario,
} from './catalogue.js';
import { GIT_VERIFIER_VERSION } from './verifier-types.js';

export const GIT_GATE_E1_NORMALIZATION_RULES = Object.freeze([
  'registered fixture root -> <FIXTURE_ROOT>',
  'registered sibling root -> <SIBLING_ROOT>',
  'registered trial root -> <TRIAL_ROOT>',
  'monotonic timing excluded from semantic equality',
  'reflog timestamp/timezone presentation excluded while raw digest retained',
  'sentinel mtime excluded while bytes/mode/raw metadata retained',
  'GitPython tzoffset object address -> <GITPYTHON_TZOFFSET_OBJECT>',
]);

export interface ExternalRecordingProvenance {
  runId: string;
  source: { commit: string; dirty: false; sourceTreeDigest: string };
  runtime: GitSpikeRuntimeInspection;
  executableSha256: string;
  os: string;
  architecture: string;
}

export function persistGitExternalTrial(options: {
  store: ExternalRunStore;
  scenario: GitGateE1Scenario;
  trialIndex: number;
  trialId: string;
  result: GitScriptedScenarioResult;
  provenance: ExternalRecordingProvenance;
}): ExternalTrialEnvelope {
  const { store, scenario, result, provenance } = options;
  const discovery = store.writeSidecar('discovery', {
    tool_names: result.execution.discovery?.toolNames ?? [],
    raw_discovery_digest: result.execution.discovery?.rawDiscoveryDigest ?? null,
    canonical_discovery_digest: result.execution.discovery?.semanticDiscoveryDigest ?? null,
    tools: result.execution.discovery?.tools ?? [],
  } as unknown as Json);
  const transcript = store.writeSidecar('transcripts', result.execution.transcript.events as unknown as Json);
  const journal = store.writeSidecar('journals', result.execution.journal as unknown as Json);
  const cleanup = store.writeSidecar('cleanup', result.execution.cleanup as unknown as Json);
  const finalSnapshotIndex = result.execution.journal.findIndex((entry) => entry.snapshot === result.finalSnapshot);
  if (finalSnapshotIndex < 0) throw new Error(`final snapshot is not present in journal for ${options.trialId}`);
  const finalSnapshot = { ...journal, pointer: `/${finalSnapshotIndex}/snapshot` };
  const calls = result.execution.calls.map((call) => ({
    index: call.index,
    tool: call.tool,
    arguments: structuredClone(call.arguments),
    requestId: call.requestId,
    classification: classifyCall(call.outcomeClass, call.clientFailureKind),
    isError: call.isError,
    jsonRpcError: jsonRpcError(call.rawOutcome),
    rawResultDigest: call.rawResponseDigest,
    beforeSnapshot: { ...journal, pointer: `/${call.beforeSnapshotIndex}/snapshot` },
    afterSnapshot: { ...journal, pointer: `/${call.afterSnapshotIndex}/snapshot` },
    exactDiff: { ...journal, pointer: `/${call.afterSnapshotIndex}/diffFromPrevious` },
  }));
  const traceId = `ext-${hashJson({ run: provenance.runId, scenario: scenario.id, trial: options.trialIndex }).slice(0, 20)}`;
  const trace: ExternalTraceV3 = {
    schemaVersion: EXTERNAL_TRACE_SCHEMA_VERSION,
    traceId,
    runId: provenance.runId,
    trialId: options.trialId,
    trialIndex: options.trialIndex,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    partition: scenario.partition,
    scenarioFamilyId: scenario.family,
    target: {
      id: 'mcp-server-git', packageVersion: GIT_SPIKE_TARGET.packageVersion,
      wheelSha256: GIT_SPIKE_TARGET.wheelSha256, sourceSha256: provenance.runtime.targetServerSha256,
      executableSha256: provenance.executableSha256, dependencyLockSha256: provenance.runtime.lockSha256,
    },
    runtime: {
      python: provenance.runtime.pythonVersion, git: provenance.runtime.gitVersion, node: provenance.runtime.nodeVersion,
      os: provenance.os, architecture: provenance.architecture,
    },
    source: provenance.source,
    adapterVersion: GIT_GATE_E1_ADAPTER_VERSION,
    verifierVersion: GIT_VERIFIER_VERSION,
    fixtureRecipe: { version: 'git-spike-seed-v1', digest: result.execution.fixture.recipeDigest },
    catalogue: { version: GIT_GATE_E1_CATALOGUE_VERSION, digest: GIT_GATE_E1_CATALOGUE_DIGEST },
    negotiatedProtocol: result.execution.initialization?.negotiatedProtocolVersion ?? '<missing>',
    serverInfo: result.execution.initialization?.serverInfo ?? {},
    capabilities: result.execution.initialization?.capabilities ?? {},
    discoveryDigest: result.execution.discovery?.semanticDiscoveryDigest ?? '<missing>',
    discovery,
    intendedEntities: structuredClone(scenario.intendedEntities),
    orderedCalls: calls,
    transcript,
    stateJournal: journal,
    finalSnapshot,
    verifierResult: structuredClone(result.verifierResult) as unknown as JsonObject,
    cleanup,
    siblingSentinelPassed: result.verifierInput.sentinelUnchanged === true,
    normalizationRules: [...GIT_GATE_E1_NORMALIZATION_RULES],
    evidenceCompleteness: {
      complete: result.verifierResult.evidenceCompleteness.complete && result.execution.cleanup.passed,
      missing: [...result.verifierResult.evidenceCompleteness.declaredMissing, ...result.verifierResult.evidenceCompleteness.unresolvedReferences],
      corrupt: [],
    },
    terminalRecordDigest: '<BOUND_BY_ENVELOPE>',
  };
  const observed = result.verifierResult.outcome;
  const allowedCallPath = result.verifierResult.callPath.matched ||
    (scenario.acceptableRejectionPolicy === 'scenario_read_and_stop' && scenario.allowedAlternatives.some((path) => samePath(path, result.verifierResult.callPath.observed)));
  const unexpectedLayers = [...result.verifierResult.state.unexpectedChangedLayers];
  const cleanupPassed = result.execution.cleanup.passed;
  const siblingSentinelPassed = result.verifierInput.sentinelUnchanged === true;
  const record: ExternalTrialRecord = {
    schemaVersion: EXTERNAL_TRACE_SCHEMA_VERSION,
    trace,
    goldenExpected: scenario.goldenOutcome,
    goldenObserved: observed,
    verifierSubtype: result.verifierResult.failureSubtype,
    allowedCallPath,
    unexpectedLayers,
    cleanupPassed,
    siblingSentinelPassed,
    terminalStatus: observed === scenario.goldenOutcome && allowedCallPath && unexpectedLayers.length === 0 &&
      trace.evidenceCompleteness.complete && cleanupPassed && siblingSentinelPassed
      ? 'passed'
      : observed === 'unknown' ? 'inconclusive' : 'failed',
  };
  const envelope = store.writeTerminalRecord(record);
  store.writeTrace(envelope.record.trace);
  return envelope;
}

function classifyCall(outcome: string, failure: string | null): ExternalCallClass {
  if (outcome === 'tool_success' || outcome === 'tool_error' || outcome === 'json_rpc_error') return outcome;
  if (failure === 'transport_eof') return 'transport_eof';
  if (failure === 'process_crash') return 'process_crash';
  if (failure === 'request_timeout') return 'timeout';
  if (failure === 'cancelled') return 'cancelled';
  return 'invalid_response';
}

function jsonRpcError(raw: JsonObject): { code: number; message: string; data: Json | null } | null {
  const error = raw.error;
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return null;
  const value = error as JsonObject;
  if (typeof value.code !== 'number' || typeof value.message !== 'string') return null;
  return { code: value.code, message: value.message, data: value.data ?? null };
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}
