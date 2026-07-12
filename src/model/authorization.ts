import { hashJson } from '../schema/canonical.js';
import type { Json } from '../schema/types.js';
import { ModelExecutionError } from './errors.js';
import { assertLiteralSecretExcluded, validateKeyEnvironmentName } from './redaction.js';

export const GATE_F_AUTHORIZATION_VERSION = 'gate-f-authorization-v1' as const;
export type AuthorizationStatus = 'draft' | 'approved' | 'revoked' | 'expired';

export interface GateFAuthorization {
  schema_version: typeof GATE_F_AUTHORIZATION_VERSION;
  authorization_id: string;
  status: AuthorizationStatus;
  phase: 'F1' | 'F2';
  authorization_statement: string;
  reviewer_identity: string | null;
  approval_timestamp: string | null;
  execution_window_start: string | null;
  execution_window_end: string | null;
  provider_identity: string | null;
  exact_model_identifier: string | null;
  model_snapshot: string | null;
  official_pricing_source: string | null;
  pricing_verification_timestamp: string | null;
  input_price_per_million: number | null;
  output_price_per_million: number | null;
  cached_input_rules: string | null;
  tool_token_rules: string | null;
  currency: string | null;
  tax_treatment: string | null;
  retention_privacy_acknowledgment: string | null;
  regional_restrictions: string | null;
  approved_scenario_ids: string[];
  scenario_manifest_digest: string;
  prompt_manifest_digest: string;
  source_commit: string | null;
  source_tree_digest_policy: string;
  verifier_version: string;
  suite_digest: string;
  target_identity: string;
  lock_digest: string;
  maximum_sessions: number | null;
  trials_per_scenario: number | null;
  maximum_turns_per_session: number | null;
  maximum_mcp_calls_per_session: number | null;
  maximum_input_tokens: number | null;
  maximum_output_tokens: number | null;
  maximum_context_tool_result_tokens: number | null;
  maximum_retries: number | null;
  hard_dollar_cap: number | null;
  unknown_outcome_stop_threshold: number | null;
  provider_endpoint_allowlist: string[];
  evidence_root_policy: string;
  key_environment_variable_name: string | null;
  literal_secrets_excluded: true;
}

export interface AuthorizationBindings {
  phase: 'F1' | 'F2';
  providerIdentity: string;
  modelIdentifier: string;
  modelSnapshot: string;
  scenarioIds: readonly string[];
  scenarioManifestDigest: string;
  promptManifestDigest: string;
  sourceCommit: string;
  verifierVersion: string;
  suiteDigest: string;
  targetIdentity: string;
  lockDigest: string;
  now: Date;
}

export function validateAuthorizationShape(value: unknown): asserts value is GateFAuthorization {
  if (!isObject(value)) throw mismatch('authorization must be an object');
  const required = [
    'schema_version', 'authorization_id', 'status', 'phase', 'authorization_statement',
    'reviewer_identity', 'approval_timestamp', 'execution_window_start', 'execution_window_end',
    'provider_identity', 'exact_model_identifier', 'model_snapshot', 'official_pricing_source',
    'pricing_verification_timestamp', 'input_price_per_million', 'output_price_per_million',
    'cached_input_rules', 'tool_token_rules', 'currency', 'tax_treatment',
    'retention_privacy_acknowledgment', 'regional_restrictions', 'approved_scenario_ids',
    'scenario_manifest_digest', 'prompt_manifest_digest', 'source_commit',
    'source_tree_digest_policy', 'verifier_version', 'suite_digest', 'target_identity',
    'lock_digest', 'maximum_sessions', 'trials_per_scenario', 'maximum_turns_per_session',
    'maximum_mcp_calls_per_session', 'maximum_input_tokens', 'maximum_output_tokens',
    'maximum_context_tool_result_tokens', 'maximum_retries', 'hard_dollar_cap',
    'unknown_outcome_stop_threshold', 'provider_endpoint_allowlist', 'evidence_root_policy',
    'key_environment_variable_name', 'literal_secrets_excluded',
  ];
  for (const field of required) if (!(field in value)) throw mismatch(`missing authorization field ${field}`);
  if (value.schema_version !== GATE_F_AUTHORIZATION_VERSION) throw mismatch('unsupported authorization version');
  if (!['draft', 'approved', 'revoked', 'expired'].includes(String(value.status))) throw mismatch('invalid authorization status');
  if (value.phase !== 'F1' && value.phase !== 'F2') throw mismatch('invalid authorization phase');
  if (!Array.isArray(value.approved_scenario_ids) || !value.approved_scenario_ids.every((entry) => typeof entry === 'string')) throw mismatch('approved_scenario_ids must be strings');
  if (!Array.isArray(value.provider_endpoint_allowlist) || !value.provider_endpoint_allowlist.every((entry) => typeof entry === 'string')) throw mismatch('provider_endpoint_allowlist must be strings');
  if (value.literal_secrets_excluded !== true) throw mismatch('literal secret exclusion must be explicit');
  assertLiteralSecretExcluded(value);
}

export function validateApprovedAuthorization(value: unknown, bindings: AuthorizationBindings): GateFAuthorization {
  validateAuthorizationShape(value);
  if (value.status !== 'approved') throw mismatch(`authorization status is ${value.status}, not approved`);
  const mandatoryStrings: (keyof GateFAuthorization)[] = [
    'authorization_id', 'authorization_statement', 'reviewer_identity', 'approval_timestamp',
    'execution_window_start', 'execution_window_end', 'provider_identity', 'exact_model_identifier',
    'model_snapshot', 'official_pricing_source', 'pricing_verification_timestamp', 'cached_input_rules',
    'tool_token_rules', 'currency', 'tax_treatment', 'retention_privacy_acknowledgment',
    'regional_restrictions', 'scenario_manifest_digest', 'prompt_manifest_digest', 'source_commit',
    'source_tree_digest_policy', 'verifier_version', 'suite_digest', 'target_identity', 'lock_digest',
    'evidence_root_policy', 'key_environment_variable_name',
  ];
  for (const field of mandatoryStrings) if (typeof value[field] !== 'string' || String(value[field]).trim() === '') throw mismatch(`blank mandatory field ${field}`);
  const start = Date.parse(value.execution_window_start!);
  const end = Date.parse(value.execution_window_end!);
  if (!Number.isFinite(start) || !Number.isFinite(end) || bindings.now.getTime() < start || bindings.now.getTime() > end || start >= end) throw mismatch('authorization outside execution window');
  if (value.phase !== bindings.phase || value.provider_identity !== bindings.providerIdentity || value.exact_model_identifier !== bindings.modelIdentifier || value.model_snapshot !== bindings.modelSnapshot) throw mismatch('provider/model/phase binding differs');
  const exact = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((entry, index) => entry === [...b].sort()[index]);
  if (!exact(value.approved_scenario_ids, bindings.scenarioIds)) throw mismatch('scenario IDs differ');
  const pairs: [unknown, unknown, string][] = [
    [value.scenario_manifest_digest, bindings.scenarioManifestDigest, 'scenario manifest'],
    [value.prompt_manifest_digest, bindings.promptManifestDigest, 'prompt manifest'],
    [value.source_commit, bindings.sourceCommit, 'source commit'],
    [value.verifier_version, bindings.verifierVersion, 'verifier'], [value.suite_digest, bindings.suiteDigest, 'suite'],
    [value.target_identity, bindings.targetIdentity, 'target'], [value.lock_digest, bindings.lockDigest, 'lock'],
  ];
  for (const [observed, expected, name] of pairs) if (observed !== expected) throw mismatch(`${name} digest/identity differs`);
  for (const field of ['input_price_per_million', 'output_price_per_million', 'maximum_sessions', 'trials_per_scenario', 'maximum_turns_per_session', 'maximum_mcp_calls_per_session', 'maximum_input_tokens', 'maximum_output_tokens', 'maximum_context_tool_result_tokens', 'maximum_retries', 'hard_dollar_cap', 'unknown_outcome_stop_threshold'] as const) {
    const number = value[field];
    if (typeof number !== 'number' || !Number.isFinite(number)) throw mismatch(`missing numeric cap ${field}`);
    if (number < 0 || (field === 'hard_dollar_cap' && number <= 0)) throw mismatch(`invalid numeric cap ${field}`);
  }
  if (value.provider_endpoint_allowlist.length === 0) throw mismatch('endpoint allowlist is empty');
  validateKeyEnvironmentName(value.key_environment_variable_name!);
  return value;
}

export function authorizationDigest(value: GateFAuthorization): string {
  validateAuthorizationShape(value);
  return hashJson(value as unknown as Json);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mismatch(message: string): ModelExecutionError {
  return new ModelExecutionError('authorization_mismatch', message);
}
