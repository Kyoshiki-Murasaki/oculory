export const MODEL_ERROR_CODES = [
  'provider_authentication_failure', 'provider_permission_failure', 'provider_rate_limit',
  'provider_timeout', 'provider_network_failure', 'provider_malformed_response',
  'provider_identity_mismatch', 'provider_usage_missing', 'provider_usage_invalid',
  'provider_refusal', 'unsupported_tool_call', 'malformed_tool_arguments',
  'duplicate_tool_call_id', 'turn_cap_exceeded', 'mcp_call_cap_exceeded',
  'input_token_cap_exceeded', 'output_token_cap_exceeded', 'context_token_cap_exceeded',
  'session_cap_exceeded', 'retry_cap_exceeded', 'budget_cap_exceeded',
  'prompt_manifest_mismatch', 'scenario_manifest_mismatch', 'authorization_mismatch',
  'verifier_version_mismatch', 'suite_digest_mismatch', 'source_provenance_mismatch',
  'evidence_finalization_failure', 'cleanup_failure', 'process_leak',
  'unauthorized_network_attempt', 'real_repository_access_attempt', 'credential_exposure',
  'historical_evidence_mutation',
] as const;

export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

export class ModelExecutionError extends Error {
  constructor(
    public readonly code: ModelErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'ModelExecutionError';
  }
}

export function modelError(code: ModelErrorCode, message: string, details: Record<string, unknown> = {}): never {
  throw new ModelExecutionError(code, message, details);
}

export function classifyModelError(error: unknown): ModelErrorCode {
  return error instanceof ModelExecutionError ? error.code : 'provider_malformed_response';
}
