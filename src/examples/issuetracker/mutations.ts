import type { MutationDef } from '../../schema/types.js';

/**
 * Issue-tracker induced-regression harness (Phase 5, docs/28).
 *
 * Mirrors src/server/mutations.ts (task) and src/examples/filesystem/mutations.ts:
 * each flag switches ONE realistic behavioural defect on inside the real server
 * code paths — never a simulated failure. `meaningful` is the ground truth for
 * the detection metrics in docs/28. Every mutation stays inside this process'
 * in-memory tracker; none of them touch anything external.
 */
export interface IssueMutationFlags {
  /** close_issue reports success but never changes the status (silent no-op). */
  close_noop: boolean;
  /** assign_issue assigns a DIFFERENT known user than the one requested. */
  assign_wrong_user: boolean;
  /** label_issue applies the label to a different issue, not the requested one. */
  label_wrong_issue: boolean;
  /** comment_issue appends the comment to a different issue. */
  comment_wrong_issue: boolean;
  /** search_issues silently drops a real match (partial / wrong result set). */
  search_returns_partial_wrong_match: boolean;
  /** operations on a nonexistent id succeed (fabricated) instead of NOT_FOUND. */
  missing_id_succeeds: boolean;
  /** assign_issue accepts an unknown user instead of rejecting with INVALID_USER. */
  invalid_user_allowed: boolean;
  /** label_issue accepts a disallowed label instead of rejecting with INVALID_LABEL. */
  invalid_label_allowed: boolean;
  /** closing an already-closed issue becomes a silent no-op instead of INVALID_STATE. */
  already_closed_policy_changed: boolean;
  /** search_issues (a read-only tool) mutates state as a side effect. */
  readonly_search_mutates_state: boolean;
  /** tools/list order shuffled; behaviour identical (benign — false-positive probe). */
  tool_order_changed: boolean;
}

export const NO_ISSUE_MUTATIONS: IssueMutationFlags = {
  close_noop: false,
  assign_wrong_user: false,
  label_wrong_issue: false,
  comment_wrong_issue: false,
  search_returns_partial_wrong_match: false,
  missing_id_succeeds: false,
  invalid_user_allowed: false,
  invalid_label_allowed: false,
  already_closed_policy_changed: false,
  readonly_search_mutates_state: false,
  tool_order_changed: false,
};

export const ISSUE_MUTATIONS: MutationDef[] = [
  { mutation_id: 'close_noop', category: 'silent_write_failure', meaningful: true,
    description: 'close_issue reports success but the status never changes (silent write failure)' },
  { mutation_id: 'assign_wrong_user', category: 'wrong_success', meaningful: true,
    description: 'assign_issue assigns a different known user than the one requested' },
  { mutation_id: 'label_wrong_issue', category: 'wrong_success', meaningful: true,
    description: 'label_issue applies the label to a different issue; the requested issue is untouched' },
  { mutation_id: 'comment_wrong_issue', category: 'wrong_success', meaningful: true,
    description: 'comment_issue appends the comment to a different issue than requested' },
  { mutation_id: 'search_returns_partial_wrong_match', category: 'partial_match_changed', meaningful: true,
    description: 'search_issues silently drops a real match (partial / wrong result set)' },
  { mutation_id: 'missing_id_succeeds', category: 'error_changed', meaningful: true,
    description: 'operations on a nonexistent id succeed (fabricated) instead of rejecting with NOT_FOUND' },
  { mutation_id: 'invalid_user_allowed', category: 'error_changed', meaningful: true,
    description: 'assign_issue accepts an unknown user instead of rejecting with INVALID_USER' },
  { mutation_id: 'invalid_label_allowed', category: 'error_changed', meaningful: true,
    description: 'label_issue accepts a disallowed label instead of rejecting with INVALID_LABEL' },
  { mutation_id: 'already_closed_policy_changed', category: 'default_changed', meaningful: true,
    description: 'closing an already-closed issue is now a silent no-op instead of an INVALID_STATE rejection' },
  { mutation_id: 'readonly_search_mutates_state', category: 'wrong_success', meaningful: true,
    description: 'search_issues (read-only) mutates state as a side effect — a read tool that writes' },
  { mutation_id: 'tool_order_changed', category: 'tool_order_changed', meaningful: false,
    description: 'tools/list returns tools in a different order; behaviour identical (benign — false-positive probe)' },
];

export function issueFlagsFor(mutationId: string | null): IssueMutationFlags {
  const flags = { ...NO_ISSUE_MUTATIONS };
  if (mutationId === null) return flags;
  if (!(mutationId in flags)) throw new Error(`unknown issue-tracker mutation: ${mutationId}`);
  (flags as unknown as Record<string, boolean>)[mutationId] = true;
  return flags;
}
