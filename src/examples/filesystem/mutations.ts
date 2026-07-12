import type { MutationDef } from '../../schema/types.js';

/**
 * Filesystem induced-regression harness (Phase 4, docs/26).
 *
 * Mirrors src/server/mutations.ts for the task server: each flag switches ONE
 * realistic behavioural defect on inside the sandboxed filesystem server (real
 * code paths — no simulated failures). `meaningful` is the ground truth for the
 * detection metrics in docs/26. Every mutation stays STRICTLY inside the
 * sandbox root; none of them can read or write real files outside it.
 */
export interface FsMutationFlags {
  /** write_file reports success but never writes the bytes (data loss). */
  write_silent_noop: boolean;
  /** append_file overwrites the file instead of appending (previous content lost). */
  append_overwrites_instead: boolean;
  /** delete_file removes a different sibling file, not the requested one. */
  delete_wrong_file: boolean;
  /** move_file copies instead of moving (the source is left behind). */
  move_copies_instead: boolean;
  /** the server stops rejecting `../` traversal and clamps it into the sandbox instead. */
  path_traversal_allowed: boolean;
  /** read_file returns corrupted content that does not match the file on disk. */
  read_returns_wrong_content: boolean;
  /** search_files returns a partial / wrong match set. */
  search_returns_partial_wrong_match: boolean;
  /** write_file refuses to overwrite an existing file (returns an error) instead of overwriting. */
  overwrite_policy_changed: boolean;
  /** tools/list order shuffled; content identical (benign — false-positive probe). */
  tool_order_changed: boolean;
}

export const NO_FS_MUTATIONS: FsMutationFlags = {
  write_silent_noop: false,
  append_overwrites_instead: false,
  delete_wrong_file: false,
  move_copies_instead: false,
  path_traversal_allowed: false,
  read_returns_wrong_content: false,
  search_returns_partial_wrong_match: false,
  overwrite_policy_changed: false,
  tool_order_changed: false,
};

export const FS_MUTATIONS: MutationDef[] = [
  { mutation_id: 'write_silent_noop', category: 'silent_write_failure', meaningful: true,
    description: 'write_file reports success but the bytes are never written (silent data loss)' },
  { mutation_id: 'append_overwrites_instead', category: 'wrong_success', meaningful: true,
    description: 'append_file overwrites the target instead of appending; previous content is destroyed' },
  { mutation_id: 'delete_wrong_file', category: 'wrong_success', meaningful: true,
    description: 'delete_file deletes a different sibling file; the requested file survives and an unrelated one is lost' },
  { mutation_id: 'move_copies_instead', category: 'wrong_success', meaningful: true,
    description: 'move_file copies instead of moving; the source path is left behind (stale duplicate)' },
  { mutation_id: 'path_traversal_allowed', category: 'error_changed', meaningful: true,
    description: 'the server stops rejecting `../` traversal (clamps it into the sandbox) — a SECURITY regression' },
  { mutation_id: 'read_returns_wrong_content', category: 'partial_match_changed', meaningful: true,
    description: 'read_file returns corrupted content that does not match the file on disk' },
  { mutation_id: 'search_returns_partial_wrong_match', category: 'partial_match_changed', meaningful: true,
    description: 'search_files silently drops a real match (partial / wrong result set)' },
  { mutation_id: 'overwrite_policy_changed', category: 'default_changed', meaningful: true,
    description: 'write_file refuses to overwrite an existing file (errors) instead of overwriting it' },
  { mutation_id: 'tool_order_changed', category: 'tool_order_changed', meaningful: false,
    description: 'tools/list returns tools in a different order; content identical (benign — false-positive probe)' },
];

export function fsFlagsFor(mutationId: string | null): FsMutationFlags {
  const flags = { ...NO_FS_MUTATIONS };
  if (mutationId === null) return flags;
  if (!(mutationId in flags)) throw new Error(`unknown filesystem mutation: ${mutationId}`);
  (flags as unknown as Record<string, boolean>)[mutationId] = true;
  return flags;
}
