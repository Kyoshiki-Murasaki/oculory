import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalRunStore } from '../src/external/run-store.js';
import {
  EXTERNAL_RUN_MANIFEST_VERSION,
  EXTERNAL_TRACE_SCHEMA_VERSION,
  validateExternalRunManifest,
  validateExternalTraceV3,
  type ExternalRunManifest,
  type ExternalSidecarReference,
  type ExternalTraceV3,
} from '../src/external/schema-v3.js';
import { Store, EXTERNAL_RUNS_SUBDIR, LIVE_RUNS_SUBDIR } from '../src/pipeline/store.js';
import { rawTraceCheck, validate } from '../src/schema/validate.js';
import type { JsonObject, RawTrace } from '../src/schema/types.js';
import {
  GIT_GATE_E1_CATALOGUE_DIGEST,
  GIT_GATE_E1_SCENARIOS,
} from '../src/targets/git/catalogue.js';
import {
  GitMiningLoader,
  compileGitApprovedSuite,
  mineGitAssertions,
} from '../src/targets/git/mining.js';

function temp(prefix = 'oculory-e1-'): string { return mkdtempSync(join(tmpdir(), prefix)); }

test('external schema v3 validates without changing schema-v2 compatibility', () => {
  const trace = syntheticTrace('git-stage-m1', 'git-stage', 'mining', 1, ['git_add']);
  assert.doesNotThrow(() => validateExternalTraceV3(trace));
  const v2 = minimalV2Trace();
  assert.doesNotThrow(() => validate(v2 as never, rawTraceCheck));
  assert.equal(v2.schema_version, 2);
  const malformed = structuredClone(trace) as unknown as Record<string, unknown>;
  (malformed.target as Record<string, unknown>).wheelSha256 = 'not-a-digest';
  assert.throws(() => validateExternalTraceV3(malformed), /wheelSha256/);
  const badClass = structuredClone(trace);
  badClass.orderedCalls[0]!.classification = 'tool_error';
  assert.throws(() => validateExternalTraceV3(badClass), /tool_error requires true/);
});

test('external sidecars are digest-bound and missing/corrupt evidence fails closed', () => {
  const root = temp();
  const store = ExternalRunStore.create(root, 'sidecar-test');
  const ref = store.writeSidecar('journals', { value: 'evidence' });
  assert.doesNotThrow(() => store.validateSidecar(ref));
  writeFileSync(join(store.root, ref.path), '{"corrupt":true}\n');
  assert.throws(() => store.validateSidecar(ref), /digest mismatch|size mismatch/);
  rmSync(join(store.root, ref.path));
  assert.throws(() => store.validateSidecar(ref), /missing external sidecar/);

  const pointerStore = ExternalRunStore.create(root, 'pointer-test');
  const validPointer = pointerStore.writeSidecar('journals', [{ snapshot: { state: 'ok' } }], '/0/snapshot');
  assert.doesNotThrow(() => pointerStore.validateSidecar(validPointer));
  assert.throws(() => pointerStore.validateSidecar({ ...validPointer, pointer: '/journal/0/snapshot' }), /pointer does not resolve/);
});

test('external run IDs cannot be overwritten and finalized provenance is append-only', () => {
  const root = temp();
  const store = ExternalRunStore.create(root, 'append-only-test');
  assert.throws(() => ExternalRunStore.create(root, 'append-only-test'), /already exists/);
  const manifest = minimalManifest('append-only-test');
  assert.doesNotThrow(() => validateExternalRunManifest(manifest));
  store.finalize(manifest);
  assert.equal(JSON.parse(readFileSync(join(store.root, 'manifest.json'), 'utf8')).implementationCommit, 'implementation-commit');
  assert.equal(existsSync(join(store.root, 'checksums.sha256')), true);
  assert.throws(() => store.writeJson('late.json', { bad: true }), /finalized and append-only/);
  const badStore = ExternalRunStore.create(root, 'invalid-manifest-test');
  assert.throws(() => badStore.finalize({ ...minimalManifest('invalid-manifest-test'), target: {} }), /target.id/);
});

test('Store.clean preserves both evidence roots unless their distinct destructive flags are present', () => {
  const root = temp();
  mkdirSync(join(root, LIVE_RUNS_SUBDIR), { recursive: true });
  mkdirSync(join(root, EXTERNAL_RUNS_SUBDIR), { recursive: true });
  writeFileSync(join(root, LIVE_RUNS_SUBDIR, 'live.txt'), 'live');
  writeFileSync(join(root, EXTERNAL_RUNS_SUBDIR, 'external.txt'), 'external');
  writeFileSync(join(root, 'scripted.txt'), 'scripted');
  new Store(root).clean();
  assert.equal(existsSync(join(root, LIVE_RUNS_SUBDIR, 'live.txt')), true);
  assert.equal(existsSync(join(root, EXTERNAL_RUNS_SUBDIR, 'external.txt')), true);
  assert.equal(existsSync(join(root, 'scripted.txt')), false);
  new Store(root).clean({ includeLiveRuns: true });
  assert.equal(existsSync(join(root, LIVE_RUNS_SUBDIR)), false);
  assert.equal(existsSync(join(root, EXTERNAL_RUNS_SUBDIR)), true);
  new Store(root).clean({ includeExternalRuns: true });
  assert.equal(existsSync(join(root, EXTERNAL_RUNS_SUBDIR)), false);
});

test('Git Gate E1 catalogue is unique, complete, deterministic, and partitioned 2/6/4/8', () => {
  assert.equal(GIT_GATE_E1_SCENARIOS.length, 20);
  assert.equal(new Set(GIT_GATE_E1_SCENARIOS.map((scenario) => scenario.id)).size, 20);
  assert.deepEqual(Object.fromEntries(['smoke', 'mining', 'holdout', 'adversarial'].map((partition) => [partition, GIT_GATE_E1_SCENARIOS.filter((scenario) => scenario.partition === partition).length])), {
    smoke: 2, mining: 6, holdout: 4, adversarial: 8,
  });
  assert.match(GIT_GATE_E1_CATALOGUE_DIGEST, /^[a-f0-9]{64}$/);
  for (const scenario of GIT_GATE_E1_SCENARIOS) {
    assert.equal(scenario.version, '1');
    assert.equal(scenario.cleanupRequirements, 'CP-1');
    assert.equal(scenario.allowedAlternatives.some((path) => samePath(path, scenario.scriptedCalls.map((call) => call.tool))), true, scenario.id);
    assert.equal(scenario.prohibitedTools.includes('git_commit'), true, scenario.id);
    assert.equal(scenario.prohibitedTools.includes('git_diff'), true, scenario.id);
    assert.equal(scenario.mutationDesignation.length > 0, true, scenario.id);
  }
  assert.deepEqual(GIT_GATE_E1_SCENARIOS.filter((scenario) => scenario.miningEligible).map((scenario) => scenario.id), [
    'git-stage-m1', 'git-stage-m2', 'git-stage-m3', 'git-branch-m1', 'git-branch-m2', 'git-branch-m3',
  ]);
});

test('golden catalogue mapping has 14 success and 6 narrow rejection scenarios', () => {
  assert.equal(GIT_GATE_E1_SCENARIOS.filter((scenario) => scenario.goldenOutcome === 'verified_success').length, 14);
  assert.equal(GIT_GATE_E1_SCENARIOS.filter((scenario) => scenario.goldenOutcome === 'valid_rejection').length, 6);
  assert.equal(GIT_GATE_E1_SCENARIOS.every((scenario) => !scenario.scriptedCalls.some((call) => call.tool === 'git_commit' || call.tool === 'git_diff')), true);
});

test('Git mining uses distinct scenario support, not repeated trials, and generalizes entities', () => {
  const traces = miningCorpus();
  const result = mineGitAssertions(traces);
  assert.equal(result.miningTraceIds.length, 18);
  assert.deepEqual(result.miningScenarioIds, ['git-branch-m1', 'git-branch-m2', 'git-branch-m3', 'git-stage-m1', 'git-stage-m2', 'git-stage-m3']);
  assert.equal(result.candidates.length, 10);
  assert.equal(result.candidates.every((candidate) => candidate.distinctScenarioSupport === 3 && candidate.trialSupport === 9), true);
  assert.equal(result.candidates.every((candidate) => candidate.provenanceTraceIds.every((id) => id.includes('-m'))), true);
  const entityCandidates = result.candidates.filter((candidate) => candidate.assertionType === 'argument_entity_mapping');
  assert.equal(entityCandidates.some((candidate) => JSON.stringify(candidate.generalizedPredicate).includes('@entity:path')), true);
  assert.equal(entityCandidates.some((candidate) => JSON.stringify(candidate.generalizedPredicate).includes('@entity:branch')), true);
  const repeatedOneScenario = traces.filter((trace) => trace.scenarioId === 'git-stage-m1');
  assert.equal(mineGitAssertions(repeatedOneScenario).candidates.length, 0, 'three trials of one scenario do not inflate support');

  const reorderedEvidence = traces.map((trace, index) => ({ ...trace, traceId: `trace-order-${String(traces.length - index).padStart(2, '0')}` }));
  const reordered = mineGitAssertions(reorderedEvidence);
  assert.deepEqual(
    reordered.candidates.map((candidate) => ({ id: candidate.candidateId, predicate: candidate.generalizedPredicate })),
    result.candidates.map((candidate) => ({ id: candidate.candidateId, predicate: candidate.generalizedPredicate })),
    'candidate identity and predicates must not depend on trace-ID ordering',
  );
});

test('Git mining rejects attractive constants and completes leave-one-scenario-out analysis', () => {
  const traces = miningCorpus().map((trace) => ({
    ...trace,
    serverInfo: { ...trace.serverInfo, fixture_root: '/private/tmp/attractive', oid: '0123456789012345678901234567890123456789', prose: 'freeze me' },
    capabilities: { pid: 4242, elapsed_ms: 0.01 },
    intendedEntities: { ...trace.intendedEntities, incidental_path: '/Users/example/fixture', incidental_oid: '0123456789012345678901234567890123456789' },
  }));
  const result = mineGitAssertions(traces);
  assert.equal(result.candidates.every((candidate) => candidate.constantLeakagePassed), true);
  assert.equal(result.candidates.every((candidate) => candidate.leaveOneOut.length === 3), true);
  assert.equal(result.candidates.every((candidate) => candidate.leaveOneOut.every((entry) => entry.predicateSurvived && entry.distinctScenarioSupport === 2 && entry.trialSupport === 6)), true);
  assert.equal(result.candidates.filter((candidate) => candidate.assertionType === 'exhaustive_allowed_tool_path').every((candidate) => candidate.risk === 'high' && candidate.recommendation === 'advisory only'), true);
  const serialized = JSON.stringify(result.candidates.map((candidate) => candidate.generalizedPredicate));
  assert.equal(serialized.includes('/private/tmp'), false);
  assert.equal(serialized.includes('0123456789012345678901234567890123456789'), false);

  const uniformStage = miningCorpus()
    .filter((trace) => trace.scenarioFamilyId === 'git-stage')
    .map((trace) => ({ ...trace, orderedCalls: trace.orderedCalls.filter((call) => call.tool === 'git_add').map((call, index) => ({ ...call, index })) }));
  const uniformPathCandidate = mineGitAssertions(uniformStage).candidates.find((candidate) => candidate.assertionType === 'exhaustive_allowed_tool_path');
  assert.ok(uniformPathCandidate);
  assert.equal(uniformPathCandidate.leaveOneOut.every((entry) => entry.predicateSurvived && !entry.becameMoreSpecific), true,
    'leave-one-out specificity is derived by re-mining each subset, not hard-coded by assertion type');
});

test('mining loader cannot open holdout and holdout deletion/value changes do not affect candidates', () => {
  const root = temp();
  const store = ExternalRunStore.create(root, 'partition-isolation');
  const sidecar = store.writeSidecar('journals', { stable: true });
  for (const trace of miningCorpus()) store.writeTrace({ ...withSidecar(trace, sidecar), runId: 'partition-isolation' });
  const holdout = { ...withSidecar(syntheticTrace('git-stage-h1', 'git-stage', 'holdout', 1, ['git_add']), sidecar), runId: 'partition-isolation' };
  store.writeTrace(holdout);
  const loader = new GitMiningLoader(store);
  const before = mineGitAssertions(loader.loadAll());
  assert.throws(() => loader.open(holdout.traceId, 'holdout'), /rejects holdout/);
  assert.equal(loader.traceIds().includes(holdout.traceId), false);
  rmSync(join(store.root, 'traces', 'holdout', `${holdout.traceId}.json`));
  const afterDelete = mineGitAssertions(loader.loadAll());
  writeFileSync(join(store.root, 'traces', 'holdout', `${holdout.traceId}.json`), JSON.stringify({ changed: 'hostile holdout value' }));
  const afterChange = mineGitAssertions(loader.loadAll());
  assert.equal(before.digest, afterDelete.digest);
  assert.equal(before.digest, afterChange.digest);
  assert.equal(before.candidates.every((candidate) => candidate.scenarioIds.every((id) => id.endsWith('-m1') || id.endsWith('-m2') || id.endsWith('-m3'))), true);
});

test('Git miner excludes non-mining/failure traces and candidates remain unapproved/uncompilable', () => {
  const adversarial = syntheticTrace('git-existing-branch-a1', 'git-existing-branch', 'adversarial', 1, ['git_create_branch']);
  assert.throws(() => mineGitAssertions([adversarial]), /refuses adversarial/);
  const failed = syntheticTrace('git-stage-m1', 'git-stage', 'mining', 1, ['git_add']);
  failed.verifierResult.outcome = 'verified_failure';
  assert.throws(() => mineGitAssertions([failed]), /refuses non-success/);
  const candidates = mineGitAssertions(miningCorpus()).candidates;
  assert.equal(candidates.every((candidate) => candidate.approvalStatus === 'unapproved'), true);
  assert.throws(() => compileGitApprovedSuite(candidates), /explicit human approval/);
});

function miningCorpus(): ExternalTraceV3[] {
  const values: ExternalTraceV3[] = [];
  for (const [scenarioId, family, path] of [
    ['git-stage-m1', 'git-stage', ['git_diff_unstaged', 'git_add', 'git_diff_staged']],
    ['git-stage-m2', 'git-stage', ['git_add']],
    ['git-stage-m3', 'git-stage', ['git_status', 'git_add']],
    ['git-branch-m1', 'git-branch-create', ['git_create_branch']],
    ['git-branch-m2', 'git-branch-create', ['git_create_branch']],
    ['git-branch-m3', 'git-branch-create', ['git_branch', 'git_create_branch']],
  ] as const) {
    for (let trial = 1; trial <= 3; trial += 1) values.push(syntheticTrace(scenarioId, family, 'mining', trial, [...path]));
  }
  return values;
}

function syntheticTrace(scenarioId: string, family: string, partition: ExternalTraceV3['partition'], trial: number, tools: string[]): ExternalTraceV3 {
  const dummy: ExternalSidecarReference = { path: 'sidecars/journals/dummy.json', sha256: 'a'.repeat(64), bytes: 1, mediaType: 'application/json' };
  const entity: JsonObject = family === 'git-stage' ? { path: `${scenarioId}.txt` } : family === 'git-branch-create' ? { branch: `branch/${scenarioId}` } : {};
  return {
    schemaVersion: EXTERNAL_TRACE_SCHEMA_VERSION, traceId: `trace-${scenarioId}-t${trial}`, runId: 'synthetic-run', trialId: `${scenarioId}-t${trial}`, trialIndex: trial,
    scenarioId, scenarioVersion: '1', partition, scenarioFamilyId: family,
    target: { id: 'mcp-server-git', packageVersion: '2026.7.10', wheelSha256: '1'.repeat(64), sourceSha256: '2'.repeat(64), executableSha256: '3'.repeat(64), dependencyLockSha256: '4'.repeat(64) },
    runtime: { python: '3.12.13', git: '2.55.0', node: '26.4.0', os: 'darwin', architecture: 'arm64' },
    source: { commit: 'c', dirty: false, sourceTreeDigest: '5'.repeat(64) }, adapterVersion: 'a', verifierVersion: 'git-verifier-v1',
    fixtureRecipe: { version: 'v', digest: '6'.repeat(64) }, catalogue: { version: 'v', digest: '7'.repeat(64) }, negotiatedProtocol: '2025-11-25', serverInfo: { name: 'mcp-git' }, capabilities: {},
    discoveryDigest: '8'.repeat(64), discovery: dummy, intendedEntities: entity,
    orderedCalls: tools.map((tool, index) => ({ index, tool, arguments: (tool === 'git_add' ? { files: [entity.path as string] } : tool === 'git_create_branch' ? { branch_name: entity.branch as string } : {}) as JsonObject, requestId: index + 3, classification: 'tool_success', isError: false, jsonRpcError: null, rawResultDigest: '9'.repeat(64), beforeSnapshot: dummy, afterSnapshot: dummy, exactDiff: dummy })),
    transcript: dummy, stateJournal: dummy, finalSnapshot: dummy,
    verifierResult: { outcome: 'verified_success', failureSubtype: null, state: { unexpectedChangedLayers: [] } }, cleanup: dummy, siblingSentinelPassed: true,
    normalizationRules: ['fixture roots'], evidenceCompleteness: { complete: true, missing: [], corrupt: [] }, terminalRecordDigest: '0'.repeat(64),
  };
}

function withSidecar(trace: ExternalTraceV3, reference: ExternalSidecarReference): ExternalTraceV3 {
  return {
    ...trace, discovery: reference, transcript: reference, stateJournal: reference, finalSnapshot: reference, cleanup: reference,
    orderedCalls: trace.orderedCalls.map((call) => ({ ...call, beforeSnapshot: reference, afterSnapshot: reference, exactDiff: reference })),
  };
}

function minimalManifest(runId: string): ExternalRunManifest {
  return {
    schemaVersion: EXTERNAL_RUN_MANIFEST_VERSION, externalTraceSchema: EXTERNAL_TRACE_SCHEMA_VERSION, runId, finalized: true,
    implementationCommit: 'implementation-commit', dirty: false, sourceTreeDigest: 'a'.repeat(64),
    target: { id: 'mcp-server-git', version: '2026.7.10', wheelSha256: 'b'.repeat(64), installedSourceSha256: 'c'.repeat(64), executableSha256: 'd'.repeat(64), dependencyLockSha256: 'e'.repeat(64) },
    runtime: { python: '3.12.13', uv: '0.11.23', git: 'git version 2.55.0', node: 'v26.4.0', os: 'darwin', architecture: 'arm64', distributions: 33 },
    adapterVersion: 'adapter', verifierVersion: 'verifier', fixtureRecipeVersion: 'fixture', fixtureRecipeDigest: 'f'.repeat(64),
    catalogueVersion: 'catalogue', catalogueDigest: '1'.repeat(64), minerVersion: 'miner',
    normalizationRules: [], partitionCounts: { smoke: 0, mining: 0, holdout: 0, adversarial: 0 }, trialCount: 0,
    outcomeCounts: { verified_success: 0, valid_rejection: 0, verified_failure: 0, partial_success: 0, invalid_acceptance: 0, unknown: 0 }, decision: 'completed',
  };
}

function minimalV2Trace(): RawTrace {
  return {
    schema_version: 2, trace_id: 'v2', session_id: 's', recorded_at: new Date(0).toISOString(), scenario_id: 'x', scenario_family: 'x', partition: 'mining',
    agent: { kind: 'scripted', id: 'p', temperature: null, seed: 0, provider: null, model: null, tokens_in: null, tokens_out: null, cost_usd: null, budget_usd: null },
    client: 'c', user_intent: 'i', system_prompt_digest: null, tool_schema_hash: 'h', tools: [], fixture_id: 'f',
    env_before: { state_hash: 'a', rows: [] }, steps: [], final_response: null, env_after: { state_hash: 'a', rows: [] }, server_version: 'v', mutation_id: null, trial: null,
  };
}

function samePath(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((entry, index) => entry === b[index]); }
