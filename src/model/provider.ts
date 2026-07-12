import { hashJson } from '../schema/canonical.js';
import type { Json } from '../schema/types.js';
import { ModelExecutionError } from './errors.js';
import { assertSecretFree } from './redaction.js';
import {
  MODEL_PROTOCOL_VERSION, PROVIDER_ADAPTER_VERSION,
  type ProviderAdapter, type ProviderRequest, type ProviderResponse, type ProviderToolCall,
} from './types.js';

export const MOCK_PROVIDER_IDENTITY = 'deterministic-mock-provider-v1' as const;
export const MOCK_MODEL_IDENTITY = 'offline-deterministic-model' as const;
export const MOCK_MODEL_SNAPSHOT = 'offline-deterministic-model-snapshot-v1' as const;

export class F0ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();

  constructor(mock: ProviderAdapter) {
    if (mock.providerIdentity !== MOCK_PROVIDER_IDENTITY || mock.networkCapable !== false) throw new ModelExecutionError('unauthorized_network_attempt', 'F0 registry accepts only the deterministic non-network mock');
    this.providers.set('mock', mock);
  }

  select(alias: string, endpoint?: string): ProviderAdapter {
    if (endpoint !== undefined) throw new ModelExecutionError('unauthorized_network_attempt', 'F0 provider endpoints are disabled');
    const provider = this.providers.get(alias);
    if (provider === undefined) throw new ModelExecutionError('unauthorized_network_attempt', `provider ${alias} is unavailable in F0`);
    return provider;
  }

  aliases(): string[] { return [...this.providers.keys()]; }
}

export function validateFutureEndpoint(endpoint: string, allowlist: readonly string[], allowLocalTestHarness = false): void {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new ModelExecutionError('unauthorized_network_attempt', 'provider endpoint is not an absolute URL'); }
  if (url.protocol !== 'https:' && !(allowLocalTestHarness && url.protocol === 'http:')) throw new ModelExecutionError('unauthorized_network_attempt', 'provider endpoint scheme is forbidden');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (local && !allowLocalTestHarness) throw new ModelExecutionError('unauthorized_network_attempt', 'localhost provider endpoint is forbidden');
  if (!allowlist.includes(url.origin)) throw new ModelExecutionError('unauthorized_network_attempt', 'provider endpoint is outside authorization allowlist');
  if (url.username !== '' || url.password !== '') throw new ModelExecutionError('credential_exposure', 'credentials in provider endpoint are forbidden');
}

export function validateProviderRequest(request: ProviderRequest): void {
  if (request.protocolVersion !== MODEL_PROTOCOL_VERSION || request.providerAdapterVersion !== PROVIDER_ADAPTER_VERSION) throw new ModelExecutionError('provider_malformed_response', 'unsupported request version');
  for (const field of ['requestId', 'sessionId', 'providerIdentity', 'modelIdentity', 'modelSnapshot', 'promptManifestDigest', 'scenarioManifestDigest', 'authorizationDigest'] as const) {
    if (request[field].trim() === '') throw new ModelExecutionError('provider_malformed_response', `blank request field ${field}`);
  }
  if (!Number.isSafeInteger(request.turnIndex) || request.turnIndex < 0 || !Number.isSafeInteger(request.maximumOutputTokens) || request.maximumOutputTokens <= 0) throw new ModelExecutionError('provider_malformed_response', 'invalid request numeric field');
  const allowed = new Set(request.allowedToolNames);
  if (allowed.size !== request.allowedToolNames.length || request.availableTools.some((tool) => !allowed.has(tool.name))) throw new ModelExecutionError('unsupported_tool_call', 'request tool binding is inconsistent');
  assertSecretFree(request, 'provider request');
}

export function validateProviderResponse(request: ProviderRequest, response: ProviderResponse): ProviderResponse {
  if (response.protocolVersion !== MODEL_PROTOCOL_VERSION) throw new ModelExecutionError('provider_malformed_response', 'unsupported response version');
  if (response.requestId !== request.requestId) throw new ModelExecutionError('provider_malformed_response', 'response/request correlation missing');
  if (response.providerIdentity !== request.providerIdentity || response.reportedModelIdentity !== request.modelIdentity || response.reportedModelSnapshot !== request.modelSnapshot) throw new ModelExecutionError('provider_identity_mismatch', 'provider or model identity mismatch');
  if (!['tool_calls', 'stop', 'refusal'].includes(response.finishReason)) throw new ModelExecutionError('provider_malformed_response', 'unknown finish reason');
  if (!Number.isSafeInteger(response.attemptCount) || response.attemptCount !== 1) throw new ModelExecutionError('retry_cap_exceeded', 'provider performed or reported a hidden retry');
  validateToolCalls(response.orderedToolCalls, new Set(request.allowedToolNames));
  if (response.finishReason === 'tool_calls' && response.orderedToolCalls.length === 0) throw new ModelExecutionError('provider_malformed_response', 'tool_calls finish reason has no calls');
  if (response.finishReason !== 'tool_calls' && response.orderedToolCalls.length > 0) throw new ModelExecutionError('provider_malformed_response', 'ambiguous tool ordering/finish reason');
  if (response.finishReason === 'refusal' && response.refusalClassification === null) throw new ModelExecutionError('provider_refusal', 'provider refusal lacks classification');
  const expectedDigest = hashResponse(response);
  if (response.responseDigest !== expectedDigest) throw new ModelExecutionError('provider_malformed_response', 'response digest mismatch');
  assertSecretFree(response, 'provider response');
  return response;
}

export function validateToolCalls(calls: readonly ProviderToolCall[], allowed: ReadonlySet<string>): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) throw new ModelExecutionError('duplicate_tool_call_id', `duplicate tool-call ID ${call.id}`);
    ids.add(call.id);
    if (!allowed.has(call.name)) throw new ModelExecutionError('unsupported_tool_call', `tool ${call.name} is not authorized`);
    if (call.arguments === null || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new ModelExecutionError('malformed_tool_arguments', `tool ${call.name} arguments must be an object`);
  }
}

export function hashResponse(response: ProviderResponse): string {
  const { responseDigest: _ignored, rawResponseSidecarReference: _sidecar, ...semantic } = response;
  return hashJson(semantic as unknown as Json);
}
