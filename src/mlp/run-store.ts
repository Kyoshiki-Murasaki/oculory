import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '../schema/canonical.js';
import { syncDirectoryEntry } from '../schema/durable-write.js';
import { assertPublicWritablePath } from './path-policy.js';

export const PUBLIC_RUNS_ROOT = '.oculory/runs';

const MAX_PUBLIC_RUN_FILES = 8_192;
const MAX_PUBLIC_RUN_ENTRIES = 10_000;
const MAX_PUBLIC_RUN_DEPTH = 16;
const MAX_PUBLIC_RUN_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PUBLIC_RUN_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_PUBLIC_RUN_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_RUN_ROOT_ENTRIES = 100_000;

export class PublicRunStore {
  readonly root: string;
  readonly taskRoot: string;
  readonly projectRoot: string;

  constructor(root = PUBLIC_RUNS_ROOT) {
    this.root = assertPublicWritablePath(root, 'public run store');
    this.taskRoot = assertPublicWritablePath(resolve(dirname(this.root), 'tasks'), 'public task registry');
    this.projectRoot = realpathSync(resolve(dirname(this.root), '..'));
  }

  allocateRunId(): string {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, '.sequence.lock');
    let descriptor: number | null = null;
    try {
      descriptor = openSync(lock, 'wx', 0o600);
      const last = boundedDirectoryNames(this.root, MAX_PUBLIC_RUN_ROOT_ENTRIES, 'public run root')
        .map((name) => /^run_(\d{4,})$/.exec(name)?.[1])
        .filter((value): value is string => value !== undefined)
        .reduce((max, value) => Math.max(max, Number(value)), 0);
      const next = last + 1;
      const id = `run_${String(next).padStart(4, '0')}`;
      mkdirSync(join(this.root, id), { recursive: false, mode: 0o700 });
      return id;
    } finally {
      if (descriptor !== null) {
        closeSync(descriptor);
        if (existsSync(lock)) unlinkSync(lock);
      }
    }
  }

  runPath(runId: string): string {
    assertRunId(runId);
    const target = resolve(this.root, runId);
    if (!inside(this.root, target)) throw new Error('run path escapes the public run root');
    return target;
  }

  writeJson(runId: string, relativePath: string, value: unknown): string {
    this.assertMutable(runId);
    const target = this.safeRunFile(runId, relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(`${canonicalJson(value as never)}\n`, 'utf8');
    assertFileSize(bytes.length, relativePath);
    atomicWrite(target, bytes);
    return target;
  }

  writeText(runId: string, relativePath: string, value: string): string {
    this.assertMutable(runId);
    const target = this.safeRunFile(runId, relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(value, 'utf8');
    assertFileSize(bytes.length, relativePath);
    atomicWrite(target, bytes);
    return target;
  }

  replaceJsonBeforeFinalize(runId: string, relativePath: string, value: unknown): string {
    const root = this.runPath(runId);
    if (existsSync(join(root, 'checksums.sha256'))) throw new Error(`run ${runId} is finalized and append-only`);
    const target = this.safeRunFile(runId, relativePath);
    if (!existsSync(target)) throw new Error(`cannot replace missing public run evidence: ${relativePath}`);
    const bytes = Buffer.from(`${canonicalJson(value as never)}\n`, 'utf8');
    assertFileSize(bytes.length, relativePath);
    atomicReplace(target, bytes);
    return target;
  }

  readJson<T>(runId: string, relativePath: string): T {
    return JSON.parse(readBoundedFile(
      this.safeRunFile(runId, relativePath),
      MAX_PUBLIC_RUN_FILE_BYTES,
      `public run evidence ${relativePath}`,
    ).toString('utf8')) as T;
  }

  listJsonFiles(runId: string, relativeDirectory: string): string[] {
    const directory = this.safeRunFile(runId, relativeDirectory);
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
      throw new Error(`invalid public run evidence directory: ${relativeDirectory}`);
    }
    return boundedDirectoryNames(directory, MAX_PUBLIC_RUN_FILES, `public run evidence directory ${relativeDirectory}`)
      .filter((name) => {
        const path = join(directory, name);
        const info = lstatSync(path);
        if (!info.isFile()) throw new Error(`unsupported public run entry: ${relativeDirectory}/${name}`);
        return name.endsWith('.json');
      })
      .sort();
  }

  exists(runId: string): boolean {
    try { return existsSync(this.runPath(runId)); }
    catch { return false; }
  }

  registerTask(taskId: string, taskPath: string, expectedSource?: string): string {
    assertTaskId(taskId);
    const livePath = this.resolveTaskPath(taskPath, expectedSource);
    mkdirSync(this.taskRoot, { recursive: true, mode: 0o700 });
    const registrationPath = this.taskRegistrationPath(taskId);
    const relativePath = relative(this.projectRoot, livePath).split(sep).join('/');
    if (existsSync(registrationPath)) {
      const registered = this.registeredTaskPath(taskId);
      if (registered !== livePath) {
        throw new Error(`task '${taskId}' is already registered to a different local task path; use a new task_id`);
      }
      return registered;
    }
    atomicWrite(registrationPath, Buffer.from(`${canonicalJson({
      schema_version: 'oculory-task-registration-v1',
      task_id: taskId,
      path: relativePath,
    })}\n`, 'utf8'));
    return livePath;
  }

  registeredTaskPath(taskId: string): string {
    assertTaskId(taskId);
    const registrationPath = this.taskRegistrationPath(taskId);
    if (!existsSync(registrationPath)) throw new Error(`no registered local task for '${taskId}'; pass --task <task.yaml>`);
    if (!lstatSync(registrationPath).isFile()) throw new Error(`invalid local task registration for '${taskId}'`);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(registrationPath, 'utf8')) as unknown;
    } catch {
      throw new Error(`invalid local task registration for '${taskId}'`);
    }
    if (!isTaskRegistration(value, taskId)) throw new Error(`invalid local task registration for '${taskId}'`);
    return this.resolveTaskPath(resolve(this.projectRoot, value.path));
  }

  resolveTaskPath(taskPath: string, expectedSource?: string): string {
    const livePath = this.containedTaskPath(taskPath);
    if (expectedSource !== undefined && readFileSync(livePath, 'utf8') !== expectedSource) {
      throw new Error('task changed while it was being validated; retry the command');
    }
    return livePath;
  }

  finalize(runId: string): string {
    const root = this.runPath(runId);
    const files = walk(root, MAX_PUBLIC_RUN_FILES, MAX_PUBLIC_RUN_TOTAL_BYTES)
      .filter((path) => relative(root, path) !== 'checksums.sha256');
    const lines = files.map((path) => `${sha256(readBoundedFile(path, MAX_PUBLIC_RUN_FILE_BYTES, 'public run evidence'))}  ${relative(root, path).split(sep).join('/')}`);
    const checksumPath = join(root, 'checksums.sha256');
    const manifest = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    if (manifest.length > MAX_PUBLIC_RUN_MANIFEST_BYTES) throw new Error('public run checksum manifest exceeds its byte inspection limit');
    atomicWrite(checksumPath, manifest);
    return checksumPath;
  }

  verify(runId: string): void {
    const root = this.runPath(runId);
    const manifestPath = this.safeRunFile(runId, 'checksums.sha256');
    const lines = readBoundedFile(manifestPath, MAX_PUBLIC_RUN_MANIFEST_BYTES, 'public run checksum manifest')
      .toString('utf8').trim().split('\n').filter(Boolean);
    if (lines.length > MAX_PUBLIC_RUN_FILES) throw new Error('public run checksum manifest exceeds its file-count inspection limit');
    const listed = new Set<string>();
    let totalBytes = 0;
    for (const line of lines) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      if (!match) throw new Error(`invalid checksum line for ${runId}`);
      if (listed.has(match[2]!)) throw new Error(`duplicate checksum entry for ${runId}: ${match[2]}`);
      listed.add(match[2]!);
      const path = this.safeRunFile(runId, match[2]!);
      if (!existsSync(path)) throw new Error(`run evidence checksum mismatch: ${match[2]}`);
      const bytes = readBoundedFile(path, MAX_PUBLIC_RUN_FILE_BYTES, `public run evidence ${match[2]}`);
      totalBytes += bytes.length;
      if (totalBytes > MAX_PUBLIC_RUN_TOTAL_BYTES) throw new Error('public run evidence exceeds its total byte inspection limit');
      if (sha256(bytes) !== match[1]) throw new Error(`run evidence checksum mismatch: ${match[2]}`);
    }
    const actual = walk(root, MAX_PUBLIC_RUN_FILES + 1, MAX_PUBLIC_RUN_TOTAL_BYTES + MAX_PUBLIC_RUN_MANIFEST_BYTES)
      .map((path) => relative(root, path).split(sep).join('/'))
      .filter((path) => path !== 'checksums.sha256');
    if (actual.length !== listed.size || actual.some((path) => !listed.has(path))) {
      throw new Error(`run ${runId} contains evidence outside its finalized checksum manifest`);
    }
  }

  private assertMutable(runId: string): void {
    if (existsSync(join(this.runPath(runId), 'checksums.sha256'))) throw new Error(`run ${runId} is finalized and append-only`);
  }

  private safeRunFile(runId: string, relativePath: string): string {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw new Error('unsafe public run path');
    const root = this.runPath(runId);
    if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`run ${runId} is not a real local directory`);
    const target = resolve(root, relativePath);
    if (!inside(root, target)) throw new Error('public run path escapes its run root');
    let current = root;
    for (const segment of relative(root, dirname(target)).split(sep).filter((entry) => entry !== '')) {
      current = join(current, segment);
      if (!existsSync(current)) break;
      if (!lstatSync(current).isDirectory()) throw new Error(`public run path crosses a non-directory entry: ${segment}`);
    }
    return target;
  }

  private taskRegistrationPath(taskId: string): string {
    const path = resolve(this.taskRoot, `${taskId}.json`);
    if (!inside(this.taskRoot, path)) throw new Error('task registry path escapes its root');
    return path;
  }

  private containedTaskPath(taskPath: string): string {
    const resolved = resolve(taskPath);
    if (!existsSync(resolved) || !lstatSync(resolved).isFile()) throw new Error('registered task must be a regular file');
    const canonical = realpathSync(resolved);
    if (!inside(this.projectRoot, canonical)) throw new Error('registered task must stay inside the public project root');
    return canonical;
  }
}

function atomicWrite(path: string, bytes: Buffer): void {
  if (existsSync(path)) throw new Error(`refusing to overwrite public run evidence: ${path}`);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    syncDirectoryEntry(dirname(path));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function atomicReplace(path: string, bytes: Buffer): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    unlinkSync(path);
    renameSync(temporary, path);
    syncDirectoryEntry(dirname(path));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function walk(root: string, maxFiles: number, maxBytes: number): string[] {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error('public run root is not a real directory');
  const output: string[] = [];
  let entries = 0;
  let totalBytes = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_PUBLIC_RUN_DEPTH) throw new Error('public run evidence exceeds its directory-depth inspection limit');
    for (const name of boundedDirectoryNames(directory, MAX_PUBLIC_RUN_ENTRIES, 'public run evidence directory')) {
      entries += 1;
      if (entries > MAX_PUBLIC_RUN_ENTRIES) throw new Error('public run evidence exceeds its entry-count inspection limit');
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isDirectory()) visit(path, depth + 1);
      else if (info.isFile()) {
        assertFileSize(info.size, relative(root, path));
        totalBytes += info.size;
        if (totalBytes > maxBytes) throw new Error('public run evidence exceeds its total byte inspection limit');
        output.push(path);
        if (output.length > maxFiles) throw new Error('public run evidence exceeds its file-count inspection limit');
      }
      else throw new Error(`unsupported public run entry: ${relative(root, path)}`);
    }
  };
  visit(root, 0);
  return output.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

function boundedDirectoryNames(directory: string, limit: number, label: string): string[] {
  const handle = opendirSync(directory);
  const names: string[] = [];
  try {
    let entry = handle.readSync();
    while (entry !== null) {
      names.push(entry.name);
      if (names.length > limit) throw new Error(`${label} exceeds its entry-count inspection limit`);
      entry = handle.readSync();
    }
  } finally {
    handle.closeSync();
  }
  return names.sort();
}

function readBoundedFile(path: string, limit: number, label: string): Buffer {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${label} must be a regular file`);
  const descriptor = openSync(path, 'r');
  try {
    const initial = fstatSync(descriptor);
    if (!initial.isFile()) throw new Error(`${label} must be a regular file`);
    if (initial.size > limit) throw new Error(`${label} exceeds its byte inspection limit`);
    const bytes = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error(`${label} changed while it was being read`);
      offset += read;
    }
    const probe = Buffer.alloc(1);
    if (readSync(descriptor, probe, 0, 1, offset) !== 0 || fstatSync(descriptor).size !== initial.size) {
      throw new Error(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function assertFileSize(size: number, relativePath: string): void {
  if (size > MAX_PUBLIC_RUN_FILE_BYTES) {
    throw new Error(`public run evidence exceeds its per-file byte inspection limit: ${relativePath}`);
  }
}

function assertRunId(runId: string): void {
  if (!/^run_[0-9]{4,}$/.test(runId)) throw new Error(`invalid public run ID: ${runId}`);
}

function assertTaskId(taskId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(taskId)) throw new Error(`invalid task ID: ${taskId}`);
}

function isTaskRegistration(
  value: unknown,
  taskId: string,
): value is { schema_version: 'oculory-task-registration-v1'; task_id: string; path: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const registration = value as Record<string, unknown>;
  if (Object.keys(registration).sort().join(',') !== 'path,schema_version,task_id') return false;
  if (registration.schema_version !== 'oculory-task-registration-v1' || registration.task_id !== taskId) return false;
  if (typeof registration.path !== 'string' || registration.path === '' || isAbsolute(registration.path)) return false;
  return !registration.path.replaceAll('\\', '/').split('/').includes('..');
}

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
