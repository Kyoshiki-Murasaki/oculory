import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Deterministic filesystem sandbox fixture (Phase 4, docs/26).
 *
 * The base tree is defined here as data (path -> UTF-8 content) rather than as
 * committed files, so it is reviewable in one place, has no empty-directory /
 * git-tracking pitfalls, and is materialised into a FRESH temporary directory
 * per recording session. Nothing here ever touches a path outside the temp
 * sandbox it creates. All content is tiny text so state snapshots stay cheap
 * and reproducible.
 */
export const FS_FIXTURE_ID = 'fs-sandbox-v1';

/** Directories that must exist even when they hold no seeded files (targets for moves/copies). */
const FS_BASE_DIRS = ['archive', 'tmp'];

/**
 * path (relative to sandbox root) -> exact file content.
 * `secrets.txt` at the root is a decoy "sensitive" file used to prove that
 * `../` traversal is rejected by the real server (and to make the
 * path_traversal_allowed regression observable) — it never leaves the sandbox.
 */
export const FS_BASE_TREE: Record<string, string> = {
  'README.txt': 'Sandbox root for the Oculory filesystem validation target.\n',
  'secrets.txt': 'TOP SECRET: this decoy must only be reachable from inside the sandbox.\n',
  'notes/todo.txt': 'Buy milk\nWrite the weekly report\n',
  'notes/ideas.txt': 'Idea: add a caching layer\n',
  'drafts/plan.md': '# Project plan\nInitial draft content.\n',
  'drafts/plan-archive.md': '# Old project plan\nSuperseded draft.\n',
  'reports/q1.txt': 'Q1 revenue: 100\n',
  'reports/q2.txt': 'Q2 revenue: 120\n',
  'tmp/old.txt': 'obsolete scratch data\n',
  'tmp/keep.txt': 'keep this scratch file\n',
};

/**
 * Materialise the base tree into a fresh temp directory and return its root.
 * Caller MUST call `destroySandbox(root)` when done (recordFsSession does this
 * in a finally block).
 */
export function createSandbox(tree: Record<string, string> = FS_BASE_TREE): string {
  const root = mkdtempSync(join(tmpdir(), 'oculory-fs-'));
  for (const d of FS_BASE_DIRS) mkdirSync(join(root, d), { recursive: true });
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

export function destroySandbox(root: string): void {
  // Defensive: only ever remove a path under the OS temp dir we created it in.
  if (!root.startsWith(tmpdir())) {
    throw new Error(`refusing to destroy a sandbox outside the OS temp dir: ${root}`);
  }
  rmSync(root, { recursive: true, force: true });
}
