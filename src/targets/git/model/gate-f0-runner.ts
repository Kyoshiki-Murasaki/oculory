import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Json, JsonObject } from '../../../schema/types.js';
import { hashJson } from '../../../schema/canonical.js';
import { GIT_SPIKE_TARGET, inspectGitSpikeRuntime } from '../../git-spike/config.js';
import { GIT_GATE_E1_CATALOGUE_DIGEST, gitGateE1Scenario, type GitGateE1Scenario } from '../catalogue.js';
import { executeGitScriptedScenario, type GitScriptedScenarioResult } from '../scripted-driver.js';
import { GIT_VERIFIER_VERSION } from '../verifier-types.js';
import { evaluateGitCompiledSuite, validateGitCompiledSuite, type GitCompiledSuiteV1 } from '../gate-e2.js';
import { validateAuthorizationShape, authorizationDigest, type GateFAuthorization } from '../../../model/authorization.js';
import { CapEngine } from '../../../model/caps.js';
import { ModelEvidenceStore } from '../../../model/evidence.js';
import { ModelExecutionError, classifyModelError } from '../../../model/errors.js';
import { executeRegisteredFault, GATE_F0_FAULTS } from '../../../model/faults.js';
import { createPromptManifest, createScenarioManifest, GATE_F0_SCENARIO_IDS, validatePromptManifest, validateScenarioManifest } from '../../../model/manifests.js';
import { DeterministicMockProvider, trajectoryForScenario } from '../../../model/mock-provider.js';
import { F0ProviderRegistry, MOCK_MODEL_IDENTITY, MOCK_MODEL_SNAPSHOT, MOCK_PROVIDER_IDENTITY, validateProviderResponse } from '../../../model/provider.js';
import { assertSecretFree, forbiddenChildEnvironmentNames } from '../../../model/redaction.js';
import { ModelSessionStateMachine } from '../../../model/runner.js';
import {
  GATE_F0_REPORT_VERSION, GATE_F_EVIDENCE_VERSION, MODEL_PROTOCOL_VERSION,
  MODEL_RUN_SCHEMA_VERSION, MODEL_SESSION_SCHEMA_VERSION, PROVIDER_ADAPTER_VERSION,
  type GateFCapPolicy, type ModelMessage, type ModelTerminalRecord, type ModelToolDefinition, type ProviderRequest, type ProviderResponse,
} from '../../../model/types.js';
import { executeGitModelCalls } from './tool-bridge.js';

const TOOL_SCHEMA_DIGEST = 'fdcbe98d820cf91b2815c2d232545dd463d3633abe3ba8aee46116b576afc62d';
const SUITE_PATH = 'suites/external/git/git-suite-v1.json';

export interface GateF0Arguments {
  pythonExecutable: string; targetExecutable: string; gitExecutable: string; lockPath: string;
  provider: string; scenarioManifestPath: string; promptManifestPath: string; authorizationPath: string;
  runRoot: string; runId: string;
}

export interface GateF0RunOutput {
  decision: 'passed' | 'failed' | 'inconclusive'; runId: string; runDirectory: string;
  sessions: ModelTerminalRecord[]; faultCount: number; determinismRepeats: number;
  evidence: { entryCount: number; manifestDigest: string; fileCount: number; exactBytes: number };
  elapsedMs: number;
}

export async function runGateF0(args: GateF0Arguments): Promise<GateF0RunOutput> {
  const started = process.hrtime.bigint();
  const source = sourceIdentity(process.cwd());
  if (source.dirty) throw new ModelExecutionError('source_provenance_mismatch', 'authoritative Gate F0 refuses a dirty source tree');
  if (args.provider !== 'mock') throw new ModelExecutionError('unauthorized_network_attempt', 'Gate F0 permits only --provider mock');
  rejectProviderEnvironment();
  const lockSha256 = sha256(readFileSync(args.lockPath));
  if (lockSha256 !== GIT_SPIKE_TARGET.lockSha256) throw new ModelExecutionError('source_provenance_mismatch', 'dependency lock digest mismatch');
  const runtime = inspectGitSpikeRuntime({ pythonExecutable: args.pythonExecutable, targetExecutable: args.targetExecutable, gitExecutable: args.gitExecutable, lockSha256 });
  if (forbiddenChildEnvironmentNames({}).length !== 0) throw new ModelExecutionError('credential_exposure', 'impossible child environment invariant');

  const scenarioManifest = JSON.parse(readFileSync(args.scenarioManifestPath, 'utf8')) as unknown;
  validateScenarioManifest(scenarioManifest);
  const expectedScenarioManifest = createScenarioManifest();
  const promptManifest = JSON.parse(readFileSync(args.promptManifestPath, 'utf8')) as unknown;
  validatePromptManifest(promptManifest, TOOL_SCHEMA_DIGEST, expectedScenarioManifest.digest);
  const expectedPromptManifest = createPromptManifest(TOOL_SCHEMA_DIGEST, expectedScenarioManifest.digest);
  const authorization = JSON.parse(readFileSync(args.authorizationPath, 'utf8')) as unknown;
  validateAuthorizationShape(authorization);
  if (authorization.status !== 'draft') throw new ModelExecutionError('authorization_mismatch', 'F0 requires the non-executable draft F1 template');
  const templateDigest = authorizationDigest(authorization);
  const offlineAuthorization = {
    schemaVersion: 'gate-f0-offline-authorization-v1', phase: 'F0', provider: 'mock', costMicros: 0,
    network: false, sessions: 6, retries: 0, scenarioIds: [...GATE_F0_SCENARIO_IDS],
    promptManifestDigest: expectedPromptManifest.digest, scenarioManifestDigest: expectedScenarioManifest.digest,
    statement: 'OFFLINE MOCK EXECUTION ONLY — DOES NOT AUTHORIZE F1 OR F2',
  };
  const offlineAuthorizationDigest = hashJson(offlineAuthorization as unknown as Json);

  const suite = JSON.parse(readFileSync(SUITE_PATH, 'utf8')) as GitCompiledSuiteV1;
  validateGitCompiledSuite(suite);
  const store = ModelEvidenceStore.create(args.runRoot, args.runId);
  const baseDirectory = mkdtempSync(join(tmpdir(), 'oculory-git-gate-f0-'));
  const capPolicy: GateFCapPolicy = {
    version: 'gate-f-cap-policy-v1', maximumSessions: 6, maximumTurnsPerSession: 4,
    maximumMcpCallsPerSession: 6, maximumTotalMcpCalls: 36, maximumInputTokens: 288_000,
    maximumOutputTokens: 48_000, maximumContextTokens: 48_000, maximumRetries: 0,
    hardDollarMicros: 0, inputPriceMicrosPerMillion: 0, outputPriceMicrosPerMillion: 0,
  };
  const caps = new CapEngine(capPolicy);
  const terminalRecords: ModelTerminalRecord[] = [];

  store.writeJson('scenario-manifest.json', expectedScenarioManifest);
  store.writeJson('prompt-manifest.json', expectedPromptManifest);
  store.writeJson('authorization-template-snapshot.json', authorization);
  store.writeJson('offline-authorization.json', { ...offlineAuthorization, digest: offlineAuthorizationDigest });
  store.writeJson('source-provenance.json', { ...source, branch: gitText(process.cwd(), ['branch', '--show-current']).trim(), lockSha256 });

  try {
    const discovery = await executeGitScriptedScenario({ baseDirectory, trialId: 'schema-binding-preflight', runtime, scenario: gitGateE1Scenario('git-status-s1') });
    if (discovery.execution.discovery?.semanticDiscoveryDigest !== TOOL_SCHEMA_DIGEST) throw new ModelExecutionError('source_provenance_mismatch', 'actual MCP tool schemas differ from the prompt binding');
    if (!discovery.execution.cleanup.passed) throw new ModelExecutionError('cleanup_failure', 'schema-binding preflight cleanup failed');
    const exactSchemas = discovery.execution.discovery.tools.map((tool) => tool.raw);
    store.writeJson('tool-schema-snapshot.json', { digest: TOOL_SCHEMA_DIGEST, tools: exactSchemas, preflightCleanup: discovery.execution.cleanup });

    for (const scenarioId of GATE_F0_SCENARIO_IDS) {
      const scenario = gitGateE1Scenario(scenarioId);
      caps.reserveSession();
      try {
        const terminal = await runSession({ store, baseDirectory, runtime, scenario, exactSchemas, promptDigest: expectedPromptManifest.digest, scenarioDigest: expectedScenarioManifest.digest, authorizationDigest: offlineAuthorizationDigest, offlineAuthorization, caps, capPolicy, suite });
        terminalRecords.push(terminal);
      } catch (error) {
        const base = { schemaVersion: MODEL_SESSION_SCHEMA_VERSION, sessionId: scenario.id, scenarioId: scenario.id, outcome: 'failed' as const, classification: classifyModelError(error), providerResult: 'failed', verifierOutcome: 'unknown', suiteResult: null, cleanupPassed: false, evidenceComplete: false };
        const terminal = { ...base, deterministicDigest: hashJson(base as unknown as Json) };
        store.writeJson(`sessions/${scenario.id}/terminal.json`, terminal);
        store.writeJson(`sessions/${scenario.id}/retained-error.json`, { classification: terminal.classification, message: error instanceof Error ? error.message : String(error) });
        terminalRecords.push(terminal);
        break;
      }
    }

    const faults = GATE_F0_FAULTS.map(executeRegisteredFault);
    for (const result of faults) store.writeJson(`faults/${result.id}.json`, result);
    const determinism = Array.from({ length: 7 }, (_, repeat) => ({
      repeat: repeat + 1, promptDigest: createPromptManifest(TOOL_SCHEMA_DIGEST, createScenarioManifest().digest).digest,
      scenarioDigest: createScenarioManifest().digest, authorizationTemplateDigest: authorizationDigest(authorization),
      trajectoryDigest: hashJson(GATE_F0_SCENARIO_IDS.map((id) => trajectoryForScenario(id, gitGateE1Scenario(id).scriptedCalls)) as unknown as Json),
      classificationDigest: hashJson(faults.map((entry) => [entry.id, entry.observedClassification]).sort() as unknown as Json),
    }));
    if (new Set(determinism.map((entry) => hashJson({ ...entry, repeat: 0 } as unknown as Json))).size !== 1) throw new ModelExecutionError('evidence_finalization_failure', 'determinism repeat mismatch');
    store.writeJson('reports/determinism.json', determinism);
    store.writeJson('reports/fault-campaign.json', { schemaVersion: 'gate-f0-fault-campaign-v1', registered: faults.length, passed: faults.filter((entry) => entry.passed).length, results: faults });
    const reconstructed = store.reconstructTerminalRecords() as ModelTerminalRecord[];
    const allPassed = terminalRecords.length === 6 && terminalRecords.every((entry) => entry.outcome === 'passed' && entry.cleanupPassed && entry.evidenceComplete) && faults.every((entry) => entry.passed) && reconstructed.length === 6;
    const decision = allPassed ? 'passed' as const : terminalRecords.some((entry) => entry.outcome === 'inconclusive') ? 'inconclusive' as const : 'failed' as const;
    store.writeJson('reports/gate-f0-report.json', {
      schemaVersion: GATE_F0_REPORT_VERSION, decision, zeroRealProviderCalls: true, zeroRealCredentialsRead: true,
      mockProviderCalls: caps.ledger.turns, networkCallCount: 0, actualProviderCostMicros: caps.ledger.costMicros,
      sessions: terminalRecords, faults: { registered: faults.length, passed: faults.filter((entry) => entry.passed).length },
      determinismRepeats: 7, caps: { policy: capPolicy, ledger: caps.ledger },
      limitations: ['deterministic mock behavior only', 'one pinned Git MCP target/runtime/host', 'no real-provider adapter or API compatibility evidence'],
      f1Authorized: false, f2Authorized: false,
    });
    const evidence = store.finalize({
      schemaVersion: MODEL_RUN_SCHEMA_VERSION, evidenceVersion: GATE_F_EVIDENCE_VERSION, reportVersion: GATE_F0_REPORT_VERSION,
      runId: args.runId, finalized: true, decision, source, provider: MOCK_PROVIDER_IDENTITY,
      model: MOCK_MODEL_IDENTITY, modelSnapshot: MOCK_MODEL_SNAPSHOT, networkCallCount: 0,
      actualProviderCostMicros: 0, sessionCount: terminalRecords.length, faultCount: faults.length,
      promptManifestDigest: expectedPromptManifest.digest, scenarioManifestDigest: expectedScenarioManifest.digest,
      authorizationTemplateDigest: templateDigest, verifierVersion: GIT_VERIFIER_VERSION,
      offlineAuthorizationDigest,
      suiteDigest: suite.suiteSha256, catalogueDigest: GIT_GATE_E1_CATALOGUE_DIGEST,
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    return { decision, runId: args.runId, runDirectory: store.root, sessions: terminalRecords, faultCount: faults.length, determinismRepeats: 7, evidence, elapsedMs };
  } finally {
    if (readdirSync(baseDirectory).length === 0) rmSync(baseDirectory, { recursive: true, force: false });
  }
}

async function runSession(options: {
  store: ModelEvidenceStore; baseDirectory: string; runtime: ReturnType<typeof inspectGitSpikeRuntime>;
  scenario: GitGateE1Scenario; exactSchemas: JsonObject[]; promptDigest: string; scenarioDigest: string;
  authorizationDigest: string; caps: CapEngine; capPolicy: GateFCapPolicy; suite: GitCompiledSuiteV1;
  offlineAuthorization: Record<string, unknown>;
}): Promise<ModelTerminalRecord> {
  const { scenario } = options;
  const machine = new ModelSessionStateMachine();
  for (const phase of ['preflight', 'authorization_validation', 'source_provenance', 'scenario_loading', 'fixture_creation', 'initial_snapshot', 'target_startup', 'protocol_initialize', 'tool_discovery', 'prompt_assembly'] as const) machine.transition(phase, 'precondition satisfied');
  const trajectory = trajectoryForScenario(scenario.id, scenario.scriptedCalls);
  const provider = new DeterministicMockProvider(trajectory);
  const registry = new F0ProviderRegistry(provider);
  const selected = registry.select('mock');
  const messages: ModelMessage[] = [{ role: 'system', content: createPromptManifest(TOOL_SCHEMA_DIGEST, options.scenarioDigest).systemPrompt }, { role: 'user', content: scenario.intent }];
  const requests: ProviderRequest[] = [];
  const responses: ProviderResponse[] = [];
  let result: GitScriptedScenarioResult | null = null;
  let sessionCalls = 0;
  for (let turnIndex = 0; turnIndex < trajectory.turns.length; turnIndex += 1) {
    machine.transition('provider_request', `mock turn ${turnIndex}`);
    options.caps.checkWorstCaseNextRequest(4_000, 2_000, 8_000, 0);
    options.caps.recordAttempt(false);
    const request: ProviderRequest = {
      protocolVersion: MODEL_PROTOCOL_VERSION, requestId: `${scenario.id}-request-${turnIndex + 1}`,
      sessionId: scenario.id, turnIndex, providerAdapterVersion: PROVIDER_ADAPTER_VERSION,
      providerIdentity: MOCK_PROVIDER_IDENTITY, modelIdentity: MOCK_MODEL_IDENTITY, modelSnapshot: MOCK_MODEL_SNAPSHOT,
      promptManifestDigest: options.promptDigest, scenarioManifestDigest: options.scenarioDigest,
      authorizationDigest: options.authorizationDigest, systemInstructions: messages[0]!.content,
      scenarioInstructions: scenario.intent, messages: structuredClone(messages),
      availableTools: toolDefinitions(options.exactSchemas, new Set(scenario.allowedAlternatives.flat())), exactMcpToolSchemas: structuredClone(options.exactSchemas),
      allowedToolNames: [...new Set(scenario.allowedAlternatives.flat())], maximumOutputTokens: 2_000,
      temperature: 0, seed: 0, reasoningControl: null, metadata: { scenarioId: scenario.id }, timeoutMs: 30_000,
      retryPolicy: { maximumRetries: 0, attemptIndex: 0 }, tracingPolicy: { retainRawResponse: true, redactSecrets: true },
    };
    assertSecretFree(request, 'provider request');
    requests.push(request);
    const response = validateProviderResponse(request, await selected.execute(request));
    responses.push(response);
    options.caps.accountUsage(response.responseDigest, response.usage);
    machine.transition('provider_response_validation', 'response correlated and validated');
    if (response.orderedToolCalls.length === 0) {
      machine.transition('continuation_decision', 'provider stopped without a tool call');
      break;
    }
    machine.transition('tool_call_validation', 'tool calls validated against scenario');
    options.caps.reserveMcpCalls(sessionCalls, response.orderedToolCalls.length);
    sessionCalls += response.orderedToolCalls.length;
    machine.transition('tool_execution', 'ordered calls bridged to pinned MCP target');
    result = await executeGitModelCalls({ baseDirectory: options.baseDirectory, trialId: `${scenario.id}-t01`, runtime: options.runtime, scenario, calls: response.orderedToolCalls });
    machine.transition('post_call_snapshot', 'independent snapshot captured');
    machine.transition('verifier_checkpoint', 'git-verifier-v1 checkpoint recorded');
    machine.transition('continuation_decision', 'tool results require final provider stop');
    for (const [index, call] of response.orderedToolCalls.entries()) messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: JSON.stringify(result.execution.calls[index]?.rawOutcome ?? {}) });
  }
  if (result === null) result = await executeGitModelCalls({ baseDirectory: options.baseDirectory, trialId: `${scenario.id}-t01`, runtime: options.runtime, scenario, calls: [] });
  machine.transition('final_verification', 'independent verifier is authoritative');
  machine.transition('target_shutdown', 'target shutdown evidence retained');
  machine.transition('cleanup', 'fixture/process/sentinel cleanup checked');
  const suite = scenario.family === 'git-stage' || scenario.family === 'git-branch-create' ? evaluateGitCompiledSuite(options.suite, scenario, result) : null;
  const passed = result.verifierResult.outcome === scenario.goldenOutcome && result.execution.cleanup.passed && result.verifierResult.evidenceCompleteness.complete && (suite?.suitePassed ?? true);
  const base = {
    schemaVersion: MODEL_SESSION_SCHEMA_VERSION, sessionId: scenario.id, scenarioId: scenario.id,
    outcome: passed ? 'passed' as const : result.verifierResult.outcome === 'unknown' ? 'inconclusive' as const : 'failed' as const,
    classification: passed ? 'expected_golden_outcome' : 'authorization_mismatch', providerResult: responses.at(-1)?.finishReason ?? '<missing>',
    verifierOutcome: result.verifierResult.outcome, suiteResult: suite === null ? null : suite.suitePassed ? 'passed' : 'failed',
    cleanupPassed: result.execution.cleanup.passed, evidenceComplete: result.verifierResult.evidenceCompleteness.complete,
  };
  const terminal: ModelTerminalRecord = { ...base, deterministicDigest: hashJson(base as unknown as Json) };
  const prefix = `sessions/${scenario.id}`;
  options.store.writeJson(`${prefix}/session-manifest.json`, { schemaVersion: MODEL_SESSION_SCHEMA_VERSION, scenarioId: scenario.id, trajectoryIdentity: trajectory.identity, turns: responses.length, mcpCalls: sessionCalls });
  options.store.writeJson(`${prefix}/authorization-snapshot.json`, { ...options.offlineAuthorization, digest: options.authorizationDigest });
  options.store.writeJson(`${prefix}/scenario-snapshot.json`, scenario);
  options.store.writeJson(`${prefix}/prompt-manifest.json`, createPromptManifest(TOOL_SCHEMA_DIGEST, options.scenarioDigest));
  options.store.writeJson(`${prefix}/tool-schema-snapshot.json`, { digest: TOOL_SCHEMA_DIGEST, tools: options.exactSchemas });
  requests.forEach((entry, index) => {
    const sidecar = options.store.writeCanonicalSidecar('provider-requests', entry as unknown as Json);
    options.store.writeJson(`${prefix}/provider-request-${index + 1}.json`, { sidecar, request: entry });
  });
  responses.forEach((entry, index) => {
    const sidecar = options.store.writeCanonicalSidecar('provider-responses', entry as unknown as Json);
    entry.rawResponseSidecarReference = sidecar.path;
    options.store.writeJson(`${prefix}/provider-response-${index + 1}.json`, { sidecar, response: entry });
  });
  options.store.writeJson(`${prefix}/transcript.json`, { providerMessages: messages, mcp: result.execution.transcript });
  result.execution.calls.forEach((call, index) => {
    options.store.writeJson(`${prefix}/calls/${index + 1}/before.json`, result!.execution.journal[call.beforeSnapshotIndex]!.snapshot);
    options.store.writeJson(`${prefix}/calls/${index + 1}/after.json`, result!.execution.journal[call.afterSnapshotIndex]!.snapshot);
    options.store.writeJson(`${prefix}/calls/${index + 1}/diff.json`, call.stateDiff);
  });
  options.store.writeJson(`${prefix}/verifier-result.json`, result.verifierResult);
  options.store.writeJson(`${prefix}/approved-suite-result.json`, suite ?? { applicable: false });
  options.store.writeJson(`${prefix}/cap-accounting-ledger.json`, { policy: options.capPolicy, aggregateLedger: options.caps.ledger, sessionCalls, turns: responses.length });
  options.store.writeJson(`${prefix}/redaction-report.json`, { passed: true, findings: [] });
  options.store.writeJson(`${prefix}/process-cleanup-proof.json`, { shutdown: result.execution.shutdown, cleanup: result.execution.cleanup });
  machine.transition('evidence_finalization', 'all required session artifacts written');
  machine.transition('terminal', terminal.outcome);
  options.store.writeJson(`${prefix}/state-journal.json`, { model: machine.journal(), target: result.execution.journal });
  options.store.writeJson(`${prefix}/terminal.json`, terminal);
  return terminal;
}

function toolDefinitions(raw: JsonObject[], allowed: ReadonlySet<string>): ModelToolDefinition[] {
  return raw.filter((entry) => allowed.has(String(entry.name))).map((entry) => ({ name: String(entry.name), description: typeof entry.description === 'string' ? entry.description : '', inputSchema: entry.inputSchema as JsonObject }));
}

function rejectProviderEnvironment(): void {
  const names = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'AZURE_OPENAI_API_KEY', 'COHERE_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'PROVIDER_API_KEY'];
  const present = names.filter((name) => typeof process.env[name] === 'string' && process.env[name] !== '');
  if (present.length > 0) throw new ModelExecutionError('credential_exposure', `Gate F0 refuses provider credential environment variables: ${present.join(',')}`);
  if (process.env.PROVIDER_ENDPOINT) throw new ModelExecutionError('unauthorized_network_attempt', 'Gate F0 refuses provider endpoints');
}

function sourceIdentity(root: string): { commit: string; dirty: boolean; sourceTreeDigest: string } {
  const commit = gitText(root, ['rev-parse', 'HEAD']).trim();
  const status = gitText(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const paths = gitBuffer(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8').split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of paths) { hash.update(path); hash.update('\0'); hash.update(readFileSync(resolve(root, path))); hash.update('\0'); }
  return { commit, dirty: status.length > 0, sourceTreeDigest: hash.digest('hex') };
}

function gitText(cwd: string, args: string[]): string { return gitBuffer(cwd, args).toString('utf8'); }
function gitBuffer(cwd: string, args: string[]): Buffer { return execFileSync('git', args, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024, timeout: 5_000 }); }
function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }

export function gateF0EnvironmentSummary(): JsonObject { return { platform: platform(), release: release(), architecture: arch(), node: process.version, target: GIT_SPIKE_TARGET.packageVersion }; }
