import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizationDigest, validateApprovedAuthorization, validateAuthorizationShape, type GateFAuthorization } from '../src/model/authorization.js';
import { CapEngine, EMPTY_LEDGER, tokenCost } from '../src/model/caps.js';
import { ModelEvidenceStore } from '../src/model/evidence.js';
import { ModelExecutionError, MODEL_ERROR_CODES } from '../src/model/errors.js';
import { executeRegisteredFault, GATE_F0_FAULTS } from '../src/model/faults.js';
import { createPromptManifest, createScenarioManifest, GATE_F0_SCENARIO_IDS, semanticManifestDigest, validatePromptManifest, validateScenarioManifest } from '../src/model/manifests.js';
import { DeterministicMockProvider, trajectoryForScenario } from '../src/model/mock-provider.js';
import { F0ProviderRegistry, hashResponse, MOCK_MODEL_IDENTITY, MOCK_MODEL_SNAPSHOT, MOCK_PROVIDER_IDENTITY, validateFutureEndpoint, validateProviderRequest, validateProviderResponse, validateToolCalls } from '../src/model/provider.js';
import { assertSecretFree, containsSecret, forbiddenChildEnvironmentNames, redactSecrets, sanitizeChildEnvironment, validateKeyEnvironmentName } from '../src/model/redaction.js';
import { ModelSessionStateMachine } from '../src/model/runner.js';
import { MODEL_PROTOCOL_VERSION, PROVIDER_ADAPTER_VERSION, type GateFCapPolicy, type ProviderRequest, type ProviderResponse } from '../src/model/types.js';
import { gitGateE1Scenario } from '../src/targets/git/catalogue.js';
import { assertRepositoryBoundary, validateGitModelCalls } from '../src/targets/git/model/tool-bridge.js';

const TOOL_DIGEST = 'fdcbe98d820cf91b2815c2d232545dd463d3633abe3ba8aee46116b576afc62d';

function policy(overrides: Partial<GateFCapPolicy> = {}): GateFCapPolicy {
  return { version: 'gate-f-cap-policy-v1', maximumSessions: 1, maximumTurnsPerSession: 2, maximumMcpCallsPerSession: 2, maximumTotalMcpCalls: 2, maximumInputTokens: 10, maximumOutputTokens: 10, maximumContextTokens: 10, maximumRetries: 0, hardDollarMicros: 0, inputPriceMicrosPerMillion: 0, outputPriceMicrosPerMillion: 0, ...overrides };
}

function request(): ProviderRequest {
  const scenario = createScenarioManifest();
  const prompt = createPromptManifest(TOOL_DIGEST, scenario.digest);
  return {
    protocolVersion: MODEL_PROTOCOL_VERSION, requestId: 'request-1', sessionId: 'session-1', turnIndex: 0,
    providerAdapterVersion: PROVIDER_ADAPTER_VERSION, providerIdentity: MOCK_PROVIDER_IDENTITY,
    modelIdentity: MOCK_MODEL_IDENTITY, modelSnapshot: MOCK_MODEL_SNAPSHOT,
    promptManifestDigest: prompt.digest, scenarioManifestDigest: scenario.digest, authorizationDigest: 'a'.repeat(64),
    systemInstructions: prompt.systemPrompt, scenarioInstructions: 'Report status.', messages: [{ role: 'user', content: 'Report status.' }],
    availableTools: [{ name: 'git_status', description: 'status', inputSchema: { type: 'object' } }],
    exactMcpToolSchemas: [{ name: 'git_status', inputSchema: { type: 'object' } }], allowedToolNames: ['git_status'],
    maximumOutputTokens: 100, temperature: 0, seed: 0, reasoningControl: null, metadata: {}, timeoutMs: 1000,
    retryPolicy: { maximumRetries: 0, attemptIndex: 0 }, tracingPolicy: { retainRawResponse: true, redactSecrets: true },
  };
}

function response(req = request()): ProviderResponse {
  const value: ProviderResponse = {
    protocolVersion: MODEL_PROTOCOL_VERSION, requestId: req.requestId, providerRequestId: 'mock-1',
    providerIdentity: MOCK_PROVIDER_IDENTITY, reportedModelIdentity: MOCK_MODEL_IDENTITY,
    reportedModelSnapshot: MOCK_MODEL_SNAPSHOT, responseMessages: [{ role: 'assistant', content: '' }],
    orderedToolCalls: [{ id: 'call-1', name: 'git_status', arguments: {} }], textOutput: '', finishReason: 'tool_calls',
    usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0, toolResultTokens: 0 }, providerWarnings: [],
    refusalClassification: null, rawResponseSidecarReference: null, responseDigest: '', attemptCount: 1, latencyMs: 7,
  };
  value.responseDigest = hashResponse(value);
  return value;
}

test('Gate F0 version identities and error taxonomy are stable and unique', () => {
  assert.equal(MODEL_PROTOCOL_VERSION, 'oculory-model-protocol-v1');
  assert.equal(PROVIDER_ADAPTER_VERSION, 'provider-adapter-v1');
  assert.equal(new Set(MODEL_ERROR_CODES).size, MODEL_ERROR_CODES.length);
  assert.ok(MODEL_ERROR_CODES.includes('historical_evidence_mutation'));
});

test('provider-neutral request and response validate correlation, identity, tools, and digests', () => {
  const req = request();
  validateProviderRequest(req);
  assert.equal(validateProviderResponse(req, response(req)).finishReason, 'tool_calls');
  assert.throws(() => validateProviderResponse(req, { ...response(req), requestId: 'wrong' }), /correlation/);
  const mismatch = { ...response(req), reportedModelIdentity: 'wrong' };
  mismatch.responseDigest = hashResponse(mismatch);
  assert.throws(() => validateProviderResponse(req, mismatch), /provider_identity_mismatch/);
});

test('provider-neutral validation rejects unknown tools, duplicate IDs, malformed args, finish ambiguity, and hidden retries', () => {
  assert.throws(() => validateToolCalls([{ id: '1', name: 'unknown', arguments: {} }], new Set(['git_status'])), /unsupported_tool_call/);
  assert.throws(() => validateToolCalls([{ id: '1', name: 'git_status', arguments: {} }, { id: '1', name: 'git_status', arguments: {} }], new Set(['git_status'])), /duplicate_tool_call_id/);
  assert.throws(() => validateToolCalls([{ id: '1', name: 'git_status', arguments: 'bad' as never }], new Set(['git_status'])), /malformed_tool_arguments/);
  const req = request();
  const ambiguous = { ...response(req), finishReason: 'stop' as const };
  ambiguous.responseDigest = hashResponse(ambiguous);
  assert.throws(() => validateProviderResponse(req, ambiguous), /ambiguous/);
  const retry = { ...response(req), attemptCount: 2 };
  retry.responseDigest = hashResponse(retry);
  assert.throws(() => validateProviderResponse(req, retry), /retry_cap_exceeded/);
});

test('F0 registry exposes only a non-network deterministic mock and rejects endpoints/aliases', () => {
  const provider = new DeterministicMockProvider(trajectoryForScenario('git-status-s1', gitGateE1Scenario('git-status-s1').scriptedCalls));
  const registry = new F0ProviderRegistry(provider);
  assert.deepEqual(registry.aliases(), ['mock']);
  assert.equal(registry.select('mock').networkCapable, false);
  assert.throws(() => registry.select('real'), /unauthorized_network_attempt/);
  assert.throws(() => registry.select('mock', 'https:\/\/example.invalid'), /endpoints are disabled/);
});

test('future endpoint policy rejects arbitrary, localhost, credential-bearing, and non-allowlisted URLs', () => {
  assert.throws(() => validateFutureEndpoint('not-a-url', []), /absolute URL/);
  assert.throws(() => validateFutureEndpoint('http:\/\/localhost:9999', ['http:\/\/localhost:9999']), /scheme|localhost/);
  assert.throws(() => validateFutureEndpoint('https:\/\/user:pass@example.invalid', ['https:\/\/example.invalid']), /credentials/);
  assert.throws(() => validateFutureEndpoint('https:\/\/else.invalid', ['https:\/\/example.invalid']), /allowlist/);
  assert.doesNotThrow(() => validateFutureEndpoint('https:\/\/example.invalid\/v1', ['https:\/\/example.invalid']));
});

test('mock trajectories are declared, deterministic, scenario-bound, and contain exact ordered calls', async () => {
  for (const id of GATE_F0_SCENARIO_IDS) {
    const scenario = gitGateE1Scenario(id);
    const a = trajectoryForScenario(id, scenario.scriptedCalls);
    const b = trajectoryForScenario(id, scenario.scriptedCalls);
    assert.deepEqual(a, b);
    assert.equal(a.identity, `${id}-mock-v1`);
    assert.deepEqual(a.turns[0]!.toolCalls?.map((call) => call.name) ?? [], scenario.scriptedCalls.map((call) => call.tool));
  }
  const provider = new DeterministicMockProvider(trajectoryForScenario('git-status-s1', gitGateE1Scenario('git-status-s1').scriptedCalls));
  const observed = await provider.execute(request());
  assert.equal(observed.providerRequestId, 'mock-git-status-s1-mock-v1-01');
  assert.equal(observed.latencyMs, 7);
});

test('draft authorization template is structurally valid, deterministic, and always non-executable', () => {
  const value = JSON.parse(readFileSync('authorizations/gate-f1-authorization-template.json', 'utf8')) as GateFAuthorization;
  validateAuthorizationShape(value);
  assert.equal(value.status, 'draft');
  assert.equal(value.authorization_statement, 'NOT AUTHORIZED — TEMPLATE ONLY');
  assert.equal(authorizationDigest(value), authorizationDigest(structuredClone(value)));
  assert.throws(() => validateApprovedAuthorization(value, approvedBindings()), /not approved/);
});

test('approved authorization fails closed on window, bindings, caps, endpoint, and literal secrets', () => {
  const value = approvedAuthorization();
  assert.equal(validateApprovedAuthorization(value, approvedBindings()).status, 'approved');
  assert.throws(() => validateApprovedAuthorization({ ...value, hard_dollar_cap: 0 }, approvedBindings()), /hard_dollar_cap/);
  assert.throws(() => validateApprovedAuthorization({ ...value, provider_endpoint_allowlist: [] }, approvedBindings()), /allowlist/);
  assert.throws(() => validateApprovedAuthorization({ ...value, scenario_manifest_digest: '0'.repeat(64) }, approvedBindings()), /scenario manifest/);
  assert.throws(() => validateAuthorizationShape({ ...value, api_key: 'synthetic-value' }), /literal secret/);
  assert.throws(() => validateApprovedAuthorization(value, { ...approvedBindings(), now: new Date('2030-01-01T00:00:00Z') }), /window/);
});

test('cap engine passes exact bounds and rejects one unit over before action', () => {
  const exact = new CapEngine(policy());
  exact.reserveSession();
  exact.checkWorstCaseNextRequest(10, 10, 10, 0);
  exact.recordAttempt(false);
  exact.reserveMcpCalls(0, 2);
  exact.accountUsage('a', { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, toolResultTokens: 10 });
  assert.equal(exact.ledger.inputTokens, 10);
  assert.throws(() => new CapEngine(policy()).checkWorstCaseNextRequest(11, 0, 0, 0), /input_token_cap_exceeded/);
  assert.throws(() => new CapEngine(policy()).checkWorstCaseNextRequest(0, 11, 0, 0), /output_token_cap_exceeded/);
  assert.throws(() => new CapEngine(policy()).checkWorstCaseNextRequest(0, 0, 11, 0), /context_token_cap_exceeded/);
});

test('cap engine enforces sessions, calls, retries, dollar worst case, usage consistency, duplicates, negatives, and overflow', () => {
  const sessions = new CapEngine(policy()); sessions.reserveSession();
  assert.throws(() => sessions.reserveSession(), /session_cap_exceeded/);
  const calls = new CapEngine(policy()); calls.reserveMcpCalls(0, 2);
  assert.throws(() => calls.reserveMcpCalls(2, 1), /mcp_call_cap_exceeded/);
  assert.throws(() => new CapEngine(policy()).recordAttempt(true), /retry_cap_exceeded/);
  assert.equal(tokenCost(1, 0, policy({ inputPriceMicrosPerMillion: 1_000_000 })), 1);
  assert.throws(() => new CapEngine(policy({ hardDollarMicros: 1, inputPriceMicrosPerMillion: 1_000_000 })).checkWorstCaseNextRequest(2, 0, 0, 0), /budget_cap_exceeded/);
  const usage = new CapEngine(policy());
  assert.throws(() => usage.accountUsage('a', null), /provider_usage_missing/);
  assert.throws(() => usage.accountUsage('a', { inputTokens: 1, outputTokens: 0, cachedInputTokens: 2, toolResultTokens: 0 }), /cached input/);
  usage.accountUsage('a', { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, toolResultTokens: 0 });
  assert.throws(() => usage.accountUsage('a', { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, toolResultTokens: 0 }), /duplicate/);
  assert.throws(() => new CapEngine(policy({ maximumInputTokens: -1 })), /non-negative/);
  assert.throws(() => new CapEngine(policy()).accountUsage('x', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, cachedInputTokens: 0, toolResultTokens: 0 }), /cap|overflow/);
});

test('prompt and scenario manifests are byte-semantic, deterministic, and reject changes/unknown versions', () => {
  const scenario = createScenarioManifest();
  const prompt = createPromptManifest(TOOL_DIGEST, scenario.digest);
  validateScenarioManifest(JSON.parse(readFileSync('manifests/git-gate-f-scenario-manifest-v1.json', 'utf8')));
  validatePromptManifest(JSON.parse(readFileSync('manifests/git-gate-f-prompt-manifest-v1.json', 'utf8')), TOOL_DIGEST, scenario.digest);
  assert.equal(semanticManifestDigest(prompt), prompt.digest);
  assert.equal(createScenarioManifest().digest, scenario.digest);
  assert.notEqual(createPromptManifest(TOOL_DIGEST, scenario.digest).digest, createPromptManifest('0'.repeat(64), scenario.digest).digest);
  assert.throws(() => validateScenarioManifest({ ...scenario, version: 'unknown' }), /scenario_manifest_mismatch/);
});

test('canonical manifests are stable across seven repeats, object key order, paths, and timestamps', () => {
  const values = Array.from({ length: 7 }, () => createScenarioManifest().digest);
  assert.equal(new Set(values).size, 1);
  assert.equal(semanticManifestDigest({ version: 'x', path: '<FIXTURE_ROOT>', digest: '', at: '<TIMESTAMP>' }), semanticManifestDigest({ at: '<TIMESTAMP>', digest: 'ignored', path: '<FIXTURE_ROOT>', version: 'x' }));
});

test('model state machine records legal paths and rejects illegal transitions', () => {
  const machine = new ModelSessionStateMachine();
  for (const phase of ['preflight', 'authorization_validation', 'source_provenance'] as const) machine.transition(phase, 'ok');
  assert.equal(machine.journal().length, 3);
  assert.throws(() => machine.transition('terminal', 'skip'), /illegal session transition/);
  const loop = new ModelSessionStateMachine();
  for (const phase of ['preflight', 'authorization_validation', 'source_provenance', 'scenario_loading', 'fixture_creation', 'initial_snapshot', 'target_startup', 'protocol_initialize', 'tool_discovery', 'prompt_assembly', 'provider_request', 'provider_response_validation', 'tool_call_validation', 'tool_execution', 'post_call_snapshot', 'verifier_checkpoint', 'continuation_decision', 'provider_request'] as const) loop.transition(phase, 'ok');
  assert.equal(loop.phase(), 'provider_request');
});

test('secret policy validates names, redacts sentinels, rejects artifacts, and strips child environment', () => {
  validateKeyEnvironmentName('OCULORY_PROVIDER_KEY');
  assert.throws(() => validateKeyEnvironmentName('bad-name'), /invalid/);
  const sentinel = 'FAKE_GATE_F_SECRET_SENTINEL';
  assert.equal(containsSecret(sentinel), true);
  assert.equal(redactSecrets(`error ${sentinel}`), 'error <REDACTED>');
  assert.throws(() => assertSecretFree({ prompt: sentinel }, 'prompt'), /credential_exposure/);
  const child = sanitizeChildEnvironment({ PATH: '/usr/bin', PROVIDER_API_KEY: sentinel, HOME: '/tmp/home' });
  assert.deepEqual(Object.keys(child).sort(), ['HOME', 'PATH']);
  assert.deepEqual(forbiddenChildEnvironmentNames({ PATH: '/bin', OPENAI_API_KEY: 'x' }), ['OPENAI_API_KEY']);
});

test('Git bridge enforces allowed path, intended entity, real-repository boundary, remote and absolute-path rejection', () => {
  const scenario = gitGateE1Scenario('git-stage-h1');
  const calls = scenario.scriptedCalls.map((entry, index) => ({ id: `c${index}`, name: entry.tool, arguments: entry.arguments }));
  assert.equal(validateGitModelCalls(scenario, calls).length, 2);
  const wrong = structuredClone(calls); (wrong[1]!.arguments as { files: string[] }).files = ['README.md'];
  assert.throws(() => validateGitModelCalls(scenario, wrong), /wrong entity/);
  assert.throws(() => validateGitModelCalls(gitGateE1Scenario('git-status-s1'), [{ id: 'x', name: 'git_status', arguments: { repo_path: '/Users/person/repo' } }]), /real_repository_access_attempt/);
  assert.throws(() => validateGitModelCalls(gitGateE1Scenario('git-status-s1'), [{ id: 'x', name: 'git_status', arguments: { url: 'https:\/\/example.invalid\/repo.git' } }]), /real_repository_access_attempt/);
  assert.doesNotThrow(() => assertRepositoryBoundary('/tmp/fixture', '/tmp/fixture'));
  assert.throws(() => assertRepositoryBoundary('/real/repo', '/tmp/fixture'), /real_repository_access_attempt/);
});

test('model evidence is atomic, content-addressed, reconstructable, append-only, and fails closed on missing/corrupt records', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-f0-evidence-test-'));
  try {
    const store = ModelEvidenceStore.create(join(root, 'runs-model'), 'run-one');
    const sidecar = store.writeCanonicalSidecar('requests', { request: 1 });
    store.validate(sidecar);
    store.writeJson('sessions/s1/terminal.json', { outcome: 'passed' });
    assert.equal(store.reconstructTerminalRecords().length, 1);
    const finalized = store.finalize({ decision: 'passed' });
    assert.equal(finalized.entryCount, 3);
    assert.throws(() => store.writeJson('late.json', {}), /append-only|finalized/);

    const missing = ModelEvidenceStore.create(join(root, 'runs-model'), 'run-missing');
    missing.writeJson('sessions/s2/manifest.json', {});
    assert.throws(() => missing.reconstructTerminalRecords(), /missing terminal/);

    const corrupt = ModelEvidenceStore.create(join(root, 'runs-model'), 'run-corrupt');
    const reference = corrupt.writeCanonicalSidecar('responses', { response: 1 });
    writeFileSync(join(corrupt.root, reference.path), '{}\n');
    assert.throws(() => corrupt.validate(reference), /corrupt sidecar/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fault registry covers every required category with stable IDs and expected retained terminal evidence', () => {
  assert.equal(new Set(GATE_F0_FAULTS.map((entry) => entry.id)).size, GATE_F0_FAULTS.length);
  assert.deepEqual([...new Set(GATE_F0_FAULTS.map((entry) => entry.category))].sort(), ['cleanup_process', 'evidence', 'provider', 'runner_cap', 'security', 'tool_call']);
  for (const definition of GATE_F0_FAULTS) {
    const result = executeRegisteredFault(definition);
    assert.equal(result.observedClassification, definition.expectedClassification, definition.id);
    assert.equal(result.terminalOutcome, definition.expectedTerminal, definition.id);
    assert.equal(result.evidenceRetained, true, definition.id);
    assert.equal(result.passed, true, definition.id);
  }
});

test('F0 synthetic usage and price policy prove exact zero actual provider cost', () => {
  const engine = new CapEngine(policy());
  engine.accountUsage('response', { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0, toolResultTokens: 0 });
  assert.equal(engine.ledger.costMicros, 0);
});

function approvedBindings() {
  const scenario = createScenarioManifest();
  const prompt = createPromptManifest(TOOL_DIGEST, scenario.digest);
  return { phase: 'F1' as const, providerIdentity: 'synthetic-provider', modelIdentifier: 'synthetic-model', modelSnapshot: 'snapshot-v1', scenarioIds: [...GATE_F0_SCENARIO_IDS], scenarioManifestDigest: scenario.digest, promptManifestDigest: prompt.digest, sourceCommit: 'a'.repeat(40), verifierVersion: 'git-verifier-v1', suiteDigest: 'b'.repeat(64), targetIdentity: 'mcp-server-git==2026.7.10', lockDigest: 'c'.repeat(64), now: new Date('2026-07-13T00:00:00Z') };
}

function approvedAuthorization(): GateFAuthorization {
  const bindings = approvedBindings();
  return {
    schema_version: 'gate-f-authorization-v1', authorization_id: 'synthetic-approved-test', status: 'approved', phase: 'F1',
    authorization_statement: 'Synthetic unit-test authorization only', reviewer_identity: 'unit-test-reviewer',
    approval_timestamp: '2026-07-12T00:00:00Z', execution_window_start: '2026-07-12T00:00:00Z', execution_window_end: '2026-07-14T00:00:00Z',
    provider_identity: bindings.providerIdentity, exact_model_identifier: bindings.modelIdentifier, model_snapshot: bindings.modelSnapshot,
    official_pricing_source: 'https:\/\/example.invalid\/pricing', pricing_verification_timestamp: '2026-07-12T00:00:00Z',
    input_price_per_million: 1, output_price_per_million: 1, cached_input_rules: 'none', tool_token_rules: 'counted as input',
    currency: 'USD', tax_treatment: 'excluded', retention_privacy_acknowledgment: 'synthetic test terms acknowledged', regional_restrictions: 'none',
    approved_scenario_ids: [...GATE_F0_SCENARIO_IDS], scenario_manifest_digest: bindings.scenarioManifestDigest,
    prompt_manifest_digest: bindings.promptManifestDigest, source_commit: bindings.sourceCommit, source_tree_digest_policy: 'clean exact tree',
    verifier_version: bindings.verifierVersion, suite_digest: bindings.suiteDigest, target_identity: bindings.targetIdentity, lock_digest: bindings.lockDigest,
    maximum_sessions: 6, trials_per_scenario: 1, maximum_turns_per_session: 4, maximum_mcp_calls_per_session: 6,
    maximum_input_tokens: 1, maximum_output_tokens: 1, maximum_context_tool_result_tokens: 1, maximum_retries: 0,
    hard_dollar_cap: 1, unknown_outcome_stop_threshold: 1, provider_endpoint_allowlist: ['https:\/\/example.invalid'],
    evidence_root_policy: 'isolated', key_environment_variable_name: 'OCULORY_TEST_KEY', literal_secrets_excluded: true,
  };
}
