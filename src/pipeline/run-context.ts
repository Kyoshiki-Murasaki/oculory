import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { RunKind, RunManifest } from '../schema/run-manifest.js';
import { RUN_MANIFEST_SCHEMA_VERSION } from '../schema/run-manifest.js';
import { LIVE_RUNS_SUBDIR } from './store.js';

/**
 * Run-directory management (Phase 3.1).
 *
 * The one job of this module is to make model runs isolated and safe:
 *  - a fresh run gets its own directory under `.oculory/runs-live/`;
 *  - writing into a non-empty directory FAILS unless the caller explicitly
 *    passed --clean / --append / --force (constraints 6 & 7 in docs/24);
 *  - path safety refuses directories that would let a --clean delete the
 *    project (the cwd or any ancestor of it, or the filesystem root).
 *
 * No command may write to `.oculory/` root anymore — that root belongs to the
 * legacy scripted experiment and must never be mixed with live model traffic.
 */

export const DEFAULT_LIVE_RUNS_ROOT = join('.oculory', LIVE_RUNS_SUBDIR);

export type RunWriteMode = 'create' | 'clean' | 'append' | 'force';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Reject run ids that are not safe single path segments. */
export function assertSafeRunId(runId: string): void {
  if (!runId || !SAFE_SEGMENT.test(runId) || runId === '.' || runId === '..') {
    throw new Error(
      `invalid --run-id '${runId}': must be a single path segment of [A-Za-z0-9._-] (no slashes, no '..')`,
    );
  }
}

/** `model-smoke-2026-07-04T08-15-00-000Z` — sortable, filesystem-safe, unique per second. */
export function runIdFor(kind: RunKind, when: Date, explicit?: string | null): string {
  if (explicit && explicit.trim().length > 0) {
    const id = explicit.trim();
    assertSafeRunId(id);
    return id;
  }
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  return `${kind}-${stamp}`;
}

export function resolveRunDir(opts: { outDir?: string | null; runId: string }): string {
  if (opts.outDir && opts.outDir.trim().length > 0) return opts.outDir.trim();
  return join(DEFAULT_LIVE_RUNS_ROOT, opts.runId);
}

/**
 * Refuse a run directory that is the cwd, an ancestor of the cwd, or the
 * filesystem root — a later --clean on any of those would delete real work.
 */
export function assertRunDirSafe(dir: string): void {
  const abs = resolve(dir);
  const cwd = resolve('.');
  if (abs === resolve('/')) throw new Error('refusing to use the filesystem root as a run directory');
  if (abs === cwd) throw new Error(`refusing to use the current working directory '${abs}' as a run directory`);
  const rel = relative(abs, cwd);
  // cwd lives inside `abs`  ⇒  abs is an ancestor of cwd  ⇒  unsafe.
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
    throw new Error(`refusing to use '${abs}' as a run directory: it contains the current working directory`);
  }
}

export function isNonEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export interface PreparedRun {
  dir: string;
  mode: RunWriteMode;
  /** True when the directory already existed and was non-empty before this call. */
  reused: boolean;
}

/**
 * Enforce the isolation contract, then ensure the directory exists.
 *   create : fail if the target is non-empty.
 *   clean  : delete the target run directory, then start fresh.
 *   append : keep everything; caller appends and updates the manifest.
 *   force  : keep the directory (do NOT delete unrelated files); caller
 *            truncates only its own append-only outputs before re-writing.
 */
export function prepareRunDir(dir: string, mode: RunWriteMode): PreparedRun {
  assertRunDirSafe(dir);
  const reused = isNonEmptyDir(dir);
  if (reused) {
    if (mode === 'create') {
      throw new Error(
        `run directory '${dir}' already exists and is not empty. Pass --clean to replace it, ` +
          `--append to add to it, or --force to overwrite its generated files (or choose a fresh --run-id / --out-dir).`,
      );
    }
    if (mode === 'clean') rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  return { dir, mode, reused };
}

function gitCommitBestEffort(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface BuildManifestOptions {
  kind: RunKind;
  runId: string;
  rootDir: string;
  command: string;
  when: Date;
  policyId: string;
  model?: string | null;
  provider?: string | null;
  trials?: number | null;
  budgetUsd?: number | null;
  temperature?: number | null;
  scenarioFilter?: string | null;
  partition?: string | null;
}

export function buildRunManifest(opts: BuildManifestOptions): RunManifest {
  return {
    schema_version: RUN_MANIFEST_SCHEMA_VERSION,
    run_id: opts.runId,
    kind: opts.kind,
    created_at: opts.when.toISOString(),
    root_dir: opts.rootDir,
    model: opts.model ?? null,
    provider: opts.provider ?? null,
    policy_id: opts.policyId,
    trials: opts.trials ?? null,
    budget_usd: opts.budgetUsd ?? null,
    temperature: opts.temperature ?? null,
    scenario_filter: opts.scenarioFilter ?? null,
    partition: opts.partition ?? null,
    git_commit: gitCommitBestEffort(),
    node_version: process.versions.node,
    command: opts.command,
    updated_at: null,
    append_count: 0,
  };
}

/** For --append: keep created_at/run_id, bump the append counter, stamp updated_at + latest command. */
export function updateManifestForAppend(prev: RunManifest, opts: { when: Date; command: string }): RunManifest {
  return {
    ...prev,
    updated_at: opts.when.toISOString(),
    append_count: (prev.append_count ?? 0) + 1,
    command: opts.command,
  };
}
