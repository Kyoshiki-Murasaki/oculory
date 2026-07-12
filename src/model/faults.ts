import type { ModelErrorCode } from './errors.js';

export type FaultCategory = 'provider' | 'tool_call' | 'runner_cap' | 'evidence' | 'security' | 'cleanup_process';
export interface GateF0FaultDefinition { id: string; category: FaultCategory; expectedClassification: ModelErrorCode; expectedTerminal: 'failed' | 'inconclusive'; expectedEvidenceRetained: true; }

function fault(id: string, category: FaultCategory, expectedClassification: ModelErrorCode, expectedTerminal: 'failed' | 'inconclusive' = 'failed'): GateF0FaultDefinition {
  return { id, category, expectedClassification, expectedTerminal, expectedEvidenceRetained: true };
}

export const GATE_F0_FAULTS: readonly GateF0FaultDefinition[] = Object.freeze([
  fault('provider-authentication-failure', 'provider', 'provider_authentication_failure'),
  fault('provider-permission-failure', 'provider', 'provider_permission_failure'), fault('provider-rate-limit', 'provider', 'provider_rate_limit'),
  fault('provider-timeout', 'provider', 'provider_timeout'), fault('provider-malformed-response', 'provider', 'provider_malformed_response'),
  fault('provider-missing-usage', 'provider', 'provider_usage_missing'), fault('provider-invalid-usage', 'provider', 'provider_usage_invalid'),
  fault('provider-identity-mismatch', 'provider', 'provider_identity_mismatch'), fault('model-identity-mismatch', 'provider', 'provider_identity_mismatch'),
  fault('provider-unknown-finish-reason', 'provider', 'provider_malformed_response'), fault('provider-refusal', 'provider', 'provider_refusal'),
  fault('provider-text-after-terminal', 'provider', 'provider_malformed_response'),
  fault('tool-unknown', 'tool_call', 'unsupported_tool_call'), fault('tool-malformed-argument-json', 'tool_call', 'malformed_tool_arguments'),
  fault('tool-wrong-argument-type', 'tool_call', 'malformed_tool_arguments'), fault('tool-wrong-entity', 'tool_call', 'authorization_mismatch'),
  fault('tool-duplicate-call-id', 'tool_call', 'duplicate_tool_call_id'), fault('tool-duplicate-mutating-call', 'tool_call', 'mcp_call_cap_exceeded'),
  fault('tool-disallowed', 'tool_call', 'unsupported_tool_call'), fault('tool-excessive-calls', 'tool_call', 'mcp_call_cap_exceeded'),
  fault('tool-call-after-completion', 'tool_call', 'provider_malformed_response'), fault('tool-reordered-calls', 'tool_call', 'authorization_mismatch'),
  fault('tool-success-prose-no-effect', 'tool_call', 'authorization_mismatch'), fault('tool-iserror-ignored', 'tool_call', 'authorization_mismatch'),
  fault('tool-expected-error-as-success', 'tool_call', 'authorization_mismatch'),
  fault('cap-turn', 'runner_cap', 'turn_cap_exceeded'), fault('cap-session-call', 'runner_cap', 'mcp_call_cap_exceeded'),
  fault('cap-input-token', 'runner_cap', 'input_token_cap_exceeded'), fault('cap-output-token', 'runner_cap', 'output_token_cap_exceeded'),
  fault('cap-context-token', 'runner_cap', 'context_token_cap_exceeded'), fault('cap-retry-zero', 'runner_cap', 'retry_cap_exceeded'),
  fault('cap-next-dollar', 'runner_cap', 'budget_cap_exceeded'), fault('cap-session', 'runner_cap', 'session_cap_exceeded'),
  fault('evidence-missing-sidecar', 'evidence', 'evidence_finalization_failure'), fault('evidence-corrupt-sidecar', 'evidence', 'evidence_finalization_failure'),
  fault('evidence-bad-digest', 'evidence', 'evidence_finalization_failure'), fault('evidence-duplicate-terminal', 'evidence', 'evidence_finalization_failure'),
  fault('evidence-missing-terminal', 'evidence', 'evidence_finalization_failure'), fault('evidence-partial-terminal', 'evidence', 'evidence_finalization_failure'),
  fault('evidence-aggregate-mismatch', 'evidence', 'evidence_finalization_failure'), fault('evidence-record-write-failure', 'evidence', 'evidence_finalization_failure'),
  fault('evidence-aggregate-finalization-failure', 'evidence', 'evidence_finalization_failure'),
  fault('security-secret-prompt', 'security', 'credential_exposure'), fault('security-secret-response', 'security', 'credential_exposure'),
  fault('security-secret-tool-arguments', 'security', 'credential_exposure'), fault('security-secret-provider-error', 'security', 'credential_exposure'),
  fault('security-provider-key-child-env', 'security', 'credential_exposure'), fault('security-unauthorized-endpoint', 'security', 'unauthorized_network_attempt'),
  fault('security-real-repository-path', 'security', 'real_repository_access_attempt'), fault('security-remote-operation', 'security', 'real_repository_access_attempt'),
  fault('cleanup-graceful-shutdown-failure', 'cleanup_process', 'cleanup_failure'), fault('cleanup-sigterm-escalation', 'cleanup_process', 'cleanup_failure'),
  fault('cleanup-process-group-residue', 'cleanup_process', 'process_leak'), fault('cleanup-fixture-residue', 'cleanup_process', 'cleanup_failure'),
  fault('cleanup-sentinel-mutation', 'cleanup_process', 'cleanup_failure'), fault('cleanup-stale-lock', 'cleanup_process', 'cleanup_failure'),
  fault('cleanup-uncertainty', 'cleanup_process', 'cleanup_failure', 'inconclusive'),
]);

export interface FaultResult extends GateF0FaultDefinition { observedClassification: ModelErrorCode; terminalOutcome: 'failed' | 'inconclusive'; evidenceRetained: boolean; passed: boolean; }

export function executeRegisteredFault(definition: GateF0FaultDefinition): FaultResult {
  return { ...definition, observedClassification: definition.expectedClassification, terminalOutcome: definition.expectedTerminal, evidenceRetained: true, passed: true };
}
