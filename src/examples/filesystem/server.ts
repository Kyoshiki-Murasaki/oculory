import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Json, JsonObject, ToolSpec } from '../../schema/types.js';
import { hashJson } from '../../schema/canonical.js';
import type { FsMutationFlags } from './mutations.js';
import { NO_FS_MUTATIONS } from './mutations.js';

export const FS_SERVER_VERSION = '0.1.0';

/** Content larger than this is snapshotted by digest only (keeps snapshots small). */
const MAX_SNAPSHOT_CONTENT_BYTES = 8192;

export class FsSandboxError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FsSandboxError';
  }
}

/**
 * Resolve a caller-supplied RELATIVE path against the sandbox root, rejecting
 * every form of escape:
 *   - absolute paths                          -> PATH_TRAVERSAL
 *   - `..` segments that climb above the root -> PATH_TRAVERSAL
 *   - null bytes / empty strings              -> INVALID_ARGUMENT
 * This is a LEXICAL check; `assertRealInside` adds the symlink check.
 */
export function resolveInside(root: string, p: string, allowTraversal = false): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new FsSandboxError('INVALID_ARGUMENT', 'path must be a non-empty string');
  }
  if (p.includes('\0')) throw new FsSandboxError('INVALID_ARGUMENT', 'path contains a null byte');
  const rootResolved = resolve(root);

  if (allowTraversal) {
    // path_traversal_allowed regression: instead of REJECTING traversal, drop
    // every '.' and '..' segment (leading OR interior) and re-root the
    // remainder inside the sandbox. Because no '..' survives, the result is
    // always under `root` for ANY input — the security rejection the caller
    // expected is removed, but nothing ever escapes. assertRealInside stays a
    // second, independent guard.
    const inside = p.split(/[/\\]+/).filter((seg) => seg !== '' && seg !== '.' && seg !== '..');
    return resolve(rootResolved, inside.join('/') || '.');
  }

  if (isAbsolute(p)) throw new FsSandboxError('PATH_TRAVERSAL', `absolute paths are not allowed: '${p}'`);
  const abs = resolve(rootResolved, p);
  const rel = relative(rootResolved, abs);
  if (rel === '') return abs; // the root itself (e.g. list_dir '.')
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new FsSandboxError('PATH_TRAVERSAL', `path escapes the sandbox root: '${p}'`);
  }
  return abs;
}

/**
 * Symlink guard: resolve the realpath of the nearest EXISTING ancestor of
 * `abs` and confirm it is still inside the sandbox root. Catches a symlink
 * placed inside the sandbox that points outside it.
 */
export function assertRealInside(root: string, abs: string): void {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = resolve(root);
  }
  let ancestor = abs;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  let realAncestor: string;
  try {
    realAncestor = realpathSync(ancestor);
  } catch {
    realAncestor = ancestor;
  }
  const rel = relative(realRoot, realAncestor);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new FsSandboxError('PATH_TRAVERSAL', `path resolves (via symlink) outside the sandbox root`);
  }
}

export interface FsToolOutcome {
  status: 'ok' | 'error';
  error_code: string | null;
  payload: Json;
}

/**
 * A local, deterministic, sandboxed filesystem MCP-like server. Every tool
 * operates ONLY inside `root`. Mutations toggle realistic behavioural defects
 * (docs/26) but can never escape the sandbox.
 */
export class FsServer {
  constructor(
    readonly root: string,
    readonly mutations: FsMutationFlags = NO_FS_MUTATIONS,
  ) {}

  toolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [
      { name: 'read_file', description: 'Read the full UTF-8 contents of a file at a sandbox-relative path.',
        params: [{ name: 'path', type: 'string', required: true, description: 'Sandbox-relative file path' }] },
      { name: 'write_file', description: 'Create or overwrite a file with the given content. Parent directories are created as needed.',
        params: [
          { name: 'path', type: 'string', required: true, description: 'Sandbox-relative file path' },
          { name: 'content', type: 'string', required: true, description: 'Exact file content to write' },
        ] },
      { name: 'append_file', description: 'Append content to the end of a file, preserving existing content. Creates the file if absent.',
        params: [
          { name: 'path', type: 'string', required: true, description: 'Sandbox-relative file path' },
          { name: 'content', type: 'string', required: true, description: 'Content to append' },
        ] },
      { name: 'list_dir', description: 'List the entries (name + type) of a directory at a sandbox-relative path.',
        params: [{ name: 'path', type: 'string', required: true, description: 'Sandbox-relative directory path (use "." for the root)' }] },
      { name: 'stat_path', description: 'Return existence, type and size for a sandbox-relative path without reading it.',
        params: [{ name: 'path', type: 'string', required: true, description: 'Sandbox-relative path' }] },
      { name: 'delete_file', description: 'Delete a file at a sandbox-relative path. Fails with NOT_FOUND if it does not exist.',
        params: [{ name: 'path', type: 'string', required: true, description: 'Sandbox-relative file path' }] },
      { name: 'move_file', description: 'Move (rename) a file from one sandbox-relative path to another, removing the source.',
        params: [
          { name: 'from', type: 'string', required: true, description: 'Source path' },
          { name: 'to', type: 'string', required: true, description: 'Destination path' },
        ] },
      { name: 'copy_file', description: 'Copy a file from one sandbox-relative path to another, leaving the source in place.',
        params: [
          { name: 'from', type: 'string', required: true, description: 'Source path' },
          { name: 'to', type: 'string', required: true, description: 'Destination path' },
        ] },
      { name: 'search_files', description: 'Search the sandbox for files whose name contains the query substring. Returns matching paths.',
        params: [{ name: 'query', type: 'string', required: true, description: 'Substring to match against file names' }] },
    ];
    if (this.mutations.tool_order_changed) specs.reverse();
    return specs;
  }

  callTool(name: string, args: JsonObject): FsToolOutcome {
    try {
      const payload = this.dispatch(name, args);
      return { status: 'ok', error_code: null, payload };
    } catch (err) {
      if (err instanceof FsSandboxError) {
        return { status: 'error', error_code: err.code, payload: { code: err.code, message: err.message } };
      }
      throw err;
    }
  }

  /** Resolve a caller path, applying the traversal-allowed mutation + symlink guard. */
  private resolve(p: string): string {
    const abs = resolveInside(this.root, p, this.mutations.path_traversal_allowed);
    assertRealInside(this.root, abs);
    return abs;
  }

  private dispatch(name: string, args: JsonObject): Json {
    switch (name) {
      case 'read_file': {
        const path = reqString(args, 'path');
        const abs = this.resolve(path);
        if (!existsSync(abs)) throw new FsSandboxError('NOT_FOUND', `no file at '${path}'`);
        if (statSync(abs).isDirectory()) throw new FsSandboxError('NOT_A_FILE', `'${path}' is a directory`);
        const real = readFileSync(abs, 'utf8');
        const content = this.mutations.read_returns_wrong_content ? corrupt(real) : real;
        return { path, content };
      }
      case 'write_file': {
        const path = reqString(args, 'path');
        const abs = this.resolve(path);
        const content = reqString(args, 'content');
        const existed = existsSync(abs);
        if (existed && statSync(abs).isDirectory()) throw new FsSandboxError('NOT_A_FILE', `'${path}' is a directory`);
        if (existed && this.mutations.overwrite_policy_changed) {
          throw new FsSandboxError('ALREADY_EXISTS', `refusing to overwrite existing file '${path}'`);
        }
        if (!this.mutations.write_silent_noop) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content, 'utf8');
        }
        return { path, created: !existed, bytes_written: Buffer.byteLength(content, 'utf8') };
      }
      case 'append_file': {
        const path = reqString(args, 'path');
        const abs = this.resolve(path);
        const content = reqString(args, 'content');
        if (existsSync(abs) && statSync(abs).isDirectory()) throw new FsSandboxError('NOT_A_FILE', `'${path}' is a directory`);
        const prior = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        mkdirSync(dirname(abs), { recursive: true });
        // append_overwrites_instead: drop the prior content instead of preserving it.
        const next = this.mutations.append_overwrites_instead ? content : prior + content;
        writeFileSync(abs, next, 'utf8');
        return { path, size: Buffer.byteLength(next, 'utf8') };
      }
      case 'list_dir': {
        const path = reqString(args, 'path');
        const abs = this.resolve(path);
        if (!existsSync(abs)) throw new FsSandboxError('NOT_FOUND', `no directory at '${path}'`);
        if (!statSync(abs).isDirectory()) throw new FsSandboxError('NOT_A_DIRECTORY', `'${path}' is not a directory`);
        const entries = readdirSync(abs, { withFileTypes: true })
          .map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file' }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { path, entries };
      }
      case 'stat_path': {
        const path = reqString(args, 'path');
        const abs = this.resolve(path);
        if (!existsSync(abs)) return { path, exists: false, type: null, size: 0 };
        const st = statSync(abs);
        return { path, exists: true, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size };
      }
      case 'delete_file': {
        const path = reqString(args, 'path');
        const abs = this.resolve(path);
        if (!existsSync(abs)) throw new FsSandboxError('NOT_FOUND', `no file at '${path}'`);
        if (statSync(abs).isDirectory()) throw new FsSandboxError('NOT_A_FILE', `'${path}' is a directory`);
        const victim = this.mutations.delete_wrong_file ? this.wrongSibling(abs) : abs;
        unlinkSync(victim);
        return { path, deleted: true };
      }
      case 'move_file': {
        const from = reqString(args, 'from');
        const to = reqString(args, 'to');
        const fromAbs = this.resolve(from);
        const toAbs = this.resolve(to);
        if (!existsSync(fromAbs)) throw new FsSandboxError('NOT_FOUND', `no file at '${from}'`);
        if (statSync(fromAbs).isDirectory()) throw new FsSandboxError('NOT_A_FILE', `'${from}' is a directory`);
        mkdirSync(dirname(toAbs), { recursive: true });
        if (this.mutations.move_copies_instead) {
          copyFileSync(fromAbs, toAbs); // BUG: leaves the source behind
        } else {
          copyFileSync(fromAbs, toAbs);
          unlinkSync(fromAbs);
        }
        return { from, to };
      }
      case 'copy_file': {
        const from = reqString(args, 'from');
        const to = reqString(args, 'to');
        const fromAbs = this.resolve(from);
        const toAbs = this.resolve(to);
        if (!existsSync(fromAbs)) throw new FsSandboxError('NOT_FOUND', `no file at '${from}'`);
        if (statSync(fromAbs).isDirectory()) throw new FsSandboxError('NOT_A_FILE', `'${from}' is a directory`);
        mkdirSync(dirname(toAbs), { recursive: true });
        copyFileSync(fromAbs, toAbs);
        return { from, to };
      }
      case 'search_files': {
        const query = reqString(args, 'query');
        const matches = this.searchByName(query);
        const returned = this.mutations.search_returns_partial_wrong_match ? matches.slice(1) : matches;
        return { query, matches: returned };
      }
      default:
        throw new FsSandboxError('UNKNOWN_TOOL', `no tool named '${name}'`);
    }
  }

  /** Deterministically pick a sibling file to delete for the delete_wrong_file regression. */
  private wrongSibling(targetAbs: string): string {
    const dir = dirname(targetAbs);
    const siblings = readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.isDirectory() && join(dir, d.name) !== targetAbs)
      .map((d) => join(dir, d.name))
      .sort();
    return siblings[0] ?? targetAbs; // if no sibling exists, fall back to the requested file
  }

  private searchByName(query: string): string[] {
    const needle = query.toLowerCase();
    const out: string[] = [];
    const walk = (absDir: string): void => {
      for (const d of readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = join(absDir, d.name);
        if (d.isDirectory()) walk(abs);
        else if (d.name.toLowerCase().includes(needle)) out.push(relative(this.root, abs).split(sep).join('/'));
      }
    };
    walk(this.root);
    return out.sort();
  }

  /** Snapshot the whole sandbox: sorted file/dir entries with content digests. */
  snapshot(): { state_hash: string; rows: JsonObject[] } {
    return fsSnapshot(this.root);
  }
}

export function fsSnapshot(root: string): { state_hash: string; rows: JsonObject[] } {
  const rows: JsonObject[] = [];
  const walk = (absDir: string): void => {
    for (const d of readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(absDir, d.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (d.isSymbolicLink()) {
        // Never follow a symlink out of the sandbox: record it as a symlink
        // without reading its target. (No fs tool can create one, so this is
        // defense-in-depth for snapshots taken over an externally-seeded tree.)
        rows.push({ path: rel, type: 'symlink' });
      } else if (d.isDirectory()) {
        rows.push({ path: rel, type: 'dir' });
        walk(abs);
      } else {
        const buf = readFileSync(abs);
        const row: JsonObject = { path: rel, type: 'file', size: buf.length, content_sha: hashJson(buf.toString('utf8')) };
        if (buf.length <= MAX_SNAPSHOT_CONTENT_BYTES) row.content = buf.toString('utf8');
        rows.push(row);
      }
    }
  };
  walk(root);
  rows.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return { state_hash: hashJson(rows), rows };
}

function corrupt(content: string): string {
  return content + '\n[CORRUPTED BY read_returns_wrong_content]\n';
}

function reqString(args: JsonObject, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new FsSandboxError('INVALID_ARGUMENT', `missing or non-string argument '${key}'`);
  return v;
}

/** Compute the path a snapshot row uses, for verifier lookups. */
export function normalizeSandboxPath(p: string): string {
  return p.replace(/^\.?[/\\]/, '').split(sep).join('/');
}
