import type { Json, JsonObject } from '../schema/types.js';

export const MODEL_PROTOCOL_VERSION = 'oculory-model-protocol-v1' as const;
export const PROVIDER_ADAPTER_VERSION = 'provider-adapter-v1' as const;
export const MODEL_RUN_SCHEMA_VERSION = 'model-run-v1' as const;
export const MODEL_SESSION_SCHEMA_VERSION = 'model-session-v1' as const;
export const GATE_F_EVIDENCE_VERSION = 'gate-f-evidence-v1' as const;
export const GATE_F0_REPORT_VERSION = 'git-gate-f0-report-v1' as const;

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolResultTokens: number;
}

export interface ProviderRequest {
  protocolVersion: typeof MODEL_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  turnIndex: number;
  providerAdapterVersion: typeof PROVIDER_ADAPTER_VERSION;
  providerIdentity: string;
  modelIdentity: string;
  modelSnapshot: string;
  promptManifestDigest: string;
  scenarioManifestDigest: string;
  authorizationDigest: string;
  systemInstructions: string;
  scenarioInstructions: string;
  messages: ModelMessage[];
  availableTools: ModelToolDefinition[];
  exactMcpToolSchemas: JsonObject[];
  allowedToolNames: string[];
  maximumOutputTokens: number;
  temperature: number | null;
  seed: number | null;
  reasoningControl: JsonObject | null;
  metadata: JsonObject;
  timeoutMs: number;
  retryPolicy: { maximumRetries: number; attemptIndex: number };
  tracingPolicy: { retainRawResponse: boolean; redactSecrets: true };
}

export interface ProviderResponse {
  protocolVersion: typeof MODEL_PROTOCOL_VERSION;
  requestId: string;
  providerRequestId: string | null;
  providerIdentity: string;
  reportedModelIdentity: string;
  reportedModelSnapshot: string;
  responseMessages: ModelMessage[];
  orderedToolCalls: ProviderToolCall[];
  textOutput: string;
  finishReason: 'tool_calls' | 'stop' | 'refusal';
  usage: ModelUsage | null;
  providerWarnings: string[];
  refusalClassification: string | null;
  rawResponseSidecarReference: string | null;
  responseDigest: string;
  attemptCount: number;
  latencyMs: number;
}

export interface ProviderAdapter {
  readonly adapterVersion: typeof PROVIDER_ADAPTER_VERSION;
  readonly providerIdentity: string;
  readonly modelIdentity: string;
  readonly modelSnapshot: string;
  readonly networkCapable: false;
  execute(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface GateFCapPolicy {
  version: 'gate-f-cap-policy-v1';
  maximumSessions: number;
  maximumTurnsPerSession: number;
  maximumMcpCallsPerSession: number;
  maximumTotalMcpCalls: number;
  maximumInputTokens: number;
  maximumOutputTokens: number;
  maximumContextTokens: number;
  maximumRetries: number;
  hardDollarMicros: number;
  inputPriceMicrosPerMillion: number;
  outputPriceMicrosPerMillion: number;
}

export interface AccountingLedger {
  sessions: number;
  turns: number;
  mcpCalls: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  retries: number;
  costMicros: number;
  responseDigests: string[];
}

export type ModelSessionPhase =
  | 'preflight' | 'authorization_validation' | 'source_provenance' | 'scenario_loading'
  | 'fixture_creation' | 'initial_snapshot' | 'target_startup' | 'protocol_initialize'
  | 'tool_discovery' | 'prompt_assembly' | 'provider_request' | 'provider_response_validation'
  | 'tool_call_validation' | 'tool_execution' | 'post_call_snapshot' | 'verifier_checkpoint'
  | 'continuation_decision' | 'final_verification' | 'target_shutdown' | 'cleanup'
  | 'evidence_finalization' | 'terminal';

export interface StateTransition {
  index: number;
  from: ModelSessionPhase | null;
  to: ModelSessionPhase;
  reason: string;
}

export interface ModelTerminalRecord {
  schemaVersion: typeof MODEL_SESSION_SCHEMA_VERSION;
  sessionId: string;
  scenarioId: string;
  outcome: 'passed' | 'failed' | 'inconclusive';
  classification: string;
  providerResult: string;
  verifierOutcome: string;
  suiteResult: string | null;
  cleanupPassed: boolean;
  evidenceComplete: boolean;
  deterministicDigest: string;
}

export type UnknownJson = Json;
