import { hashJson } from '../../schema/canonical.js';
import type { Json } from '../../schema/types.js';

export const GIT_VERIFIER_DECISION_TABLE = Object.freeze([
  ['success_exact_state_clean_result', 'verified_success'],
  ['success_no_state_effect', 'verified_failure'],
  ['success_partial_intended_effect', 'partial_success'],
  ['success_wrong_entity', 'verified_failure:wrong_entity'],
  ['success_duplicate_effect', 'verified_failure:duplicate_side_effect'],
  ['rejection_expected_tool_error_unchanged', 'valid_rejection'],
  ['rejection_allowed_no_tool_unchanged', 'valid_rejection'],
  ['rejection_disallowed_no_tool', 'verified_failure'],
  ['rejection_successful_call_unchanged', 'invalid_acceptance'],
  ['rejection_successful_call_prohibited_state', 'verified_failure:prohibited_mutation'],
  ['success_prose_required_state_absent', 'verified_failure'],
  ['error_prose_intended_state_present', 'verified_success'],
  ['timeout_inconclusive_state', 'unknown'],
  ['timeout_after_prohibited_mutation', 'verified_failure:transport_after_mutation'],
  ['crash_inconclusive_state', 'unknown'],
  ['crash_after_prohibited_mutation', 'verified_failure:transport_after_mutation'],
  ['restored_final_state_prohibited_intermediate', 'verified_failure:transient_mutation'],
  ['cleanup_uncertain', 'unknown'],
  ['cleanup_residue', 'verified_failure:cleanup_failure'],
  ['sibling_or_sentinel_mutation', 'verified_failure:state_leakage'],
  ['initial_state_mismatch', 'verified_failure:state_leakage'],
  ['oracle_error', 'unknown:oracle_failure'],
  ['incomplete_journal', 'unknown:evidence_incomplete'],
  ['malformed_result', 'unknown'],
  ['duplicate_call', 'verified_failure:duplicate_side_effect'],
  ['wrong_call_order_correct_final_state', 'verified_failure:invalid_recovery'],
] as const);

export const GIT_VERIFIER_POLICY_TABLE_DIGEST = hashJson(
  GIT_VERIFIER_DECISION_TABLE as unknown as Json,
);
