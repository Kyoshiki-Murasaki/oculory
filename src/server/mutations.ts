import type { MutationDef } from '../schema/types.js';

/**
 * Mutation harness. Each flag switches ONE realistic defect on inside the
 * demo server (real code paths — no simulated failures). `meaningful` marks
 * whether users would observe a behaviour change (ground truth for the
 * detection metrics in docs/05).
 */
export interface MutationFlags {
  description_weakened: boolean; // search_tasks description loses discriminating keywords
  arg_renamed: boolean; // create_task: `title` renamed to `task_title`
  enum_changed: boolean; // priority enum low/medium/high -> p1/p2/p3
  default_changed: boolean; // list_tasks default limit 50 -> 3 (truncates silently)
  silent_write_failure: boolean; // complete_task returns ok but does not write
  wrong_success: boolean; // complete_task on nonexistent id returns ok
  partial_match_changed: boolean; // search switches substring -> exact match
  error_changed: boolean; // NOT_FOUND errors become generic INTERNAL
  tool_order_changed: boolean; // tools/list order shuffled (schema content identical)
  overlapping_tool_added: boolean; // adds near-duplicate `find_tasks` tool
}

export const NO_MUTATIONS: MutationFlags = {
  description_weakened: false,
  arg_renamed: false,
  enum_changed: false,
  default_changed: false,
  silent_write_failure: false,
  wrong_success: false,
  partial_match_changed: false,
  error_changed: false,
  tool_order_changed: false,
  overlapping_tool_added: false,
};

export const MUTATIONS: MutationDef[] = [
  { mutation_id: 'description_weakened', category: 'description_weakened', meaningful: true,
    description: 'description drift: search_tasks loses its discriminating text while list_tasks broadens to claim searching — the cue separating the two overlapping tools migrates' },
  { mutation_id: 'arg_renamed', category: 'arg_renamed', meaningful: true,
    description: "create_task argument 'title' renamed to 'task_title'; clients with cached schemas send an unknown argument" },
  { mutation_id: 'enum_changed', category: 'enum_changed', meaningful: true,
    description: "priority enum changed from low/medium/high to p1/p2/p3; previously valid values are rejected" },
  { mutation_id: 'default_changed', category: 'default_changed', meaningful: true,
    description: 'list_tasks default limit drops from 50 to 3; listings silently truncate' },
  { mutation_id: 'silent_write_failure', category: 'silent_write_failure', meaningful: true,
    description: 'complete_task reports success but the row is never updated' },
  { mutation_id: 'wrong_success', category: 'wrong_success', meaningful: true,
    description: 'complete_task on a nonexistent id returns success instead of NOT_FOUND' },
  { mutation_id: 'partial_match_changed', category: 'partial_match_changed', meaningful: true,
    description: 'search_tasks switches from substring to exact-title matching; partial queries return nothing' },
  { mutation_id: 'error_changed', category: 'error_changed', meaningful: true,
    description: 'structured NOT_FOUND errors replaced by opaque INTERNAL errors' },
  { mutation_id: 'tool_order_changed', category: 'tool_order_changed', meaningful: false,
    description: 'tools/list returns tools in a different order; content identical (benign — false-positive probe)' },
  { mutation_id: 'overlapping_tool_added', category: 'overlapping_tool_added', meaningful: true,
    description: 'a near-duplicate find_tasks tool is added, creating tool-selection ambiguity' },
];

export function flagsFor(mutationId: string | null): MutationFlags {
  const flags = { ...NO_MUTATIONS };
  if (mutationId === null) return flags;
  if (!(mutationId in flags)) throw new Error(`unknown mutation: ${mutationId}`);
  (flags as unknown as Record<string, boolean>)[mutationId] = true;
  return flags;
}
