/**
 * Run manifest (Phase 3.1 — run isolation).
 *
 * Every isolated run (under `.oculory/runs-live/<run-id>/`) carries a
 * `manifest.json` describing exactly how it was produced, so a later reader
 * can tell one run apart from another and reproduce it. This is the anti-
 * contamination anchor: a directory is only a valid oculory run if it has a
 * manifest, and each command writes its artifacts strictly inside that one
 * directory (see docs/24).
 */
export const RUN_MANIFEST_SCHEMA_VERSION = 1;

export type RunKind =
  | 'scripted-experiment'
  | 'model-smoke'
  | 'model-experiment'
  | 'manual-recording'
  | 'replay'
  | 'mutation-comparison';

export const RUN_KINDS: RunKind[] = [
  'scripted-experiment',
  'model-smoke',
  'model-experiment',
  'manual-recording',
  'replay',
  'mutation-comparison',
];

export interface RunManifest {
  schema_version: number;
  run_id: string;
  kind: RunKind;
  created_at: string;
  root_dir: string;
  model?: string | null;
  provider?: string | null;
  policy_id: string;
  trials?: number | null;
  budget_usd?: number | null;
  /** Temperature in force (reproducibility metadata, docs/24). */
  temperature?: number | null;
  scenario_filter?: string | null;
  partition?: string | null;
  git_commit?: string | null;
  node_version: string;
  command: string;
  /** Set when a run is re-opened with --append. */
  updated_at?: string | null;
  append_count?: number;
}

/** Minimal shape check — enough to reject a directory that is not an oculory run. */
export function isRunManifest(value: unknown): value is RunManifest {
  if (value === null || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.run_id === 'string' &&
    typeof m.kind === 'string' &&
    RUN_KINDS.includes(m.kind as RunKind) &&
    typeof m.created_at === 'string' &&
    typeof m.node_version === 'string'
  );
}
