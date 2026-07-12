import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '../schema/canonical.js';
import type { Json } from '../schema/types.js';
import { ModelExecutionError } from './errors.js';

export const MODEL_RUNS_SUBDIR = 'runs-model';

export interface ModelSidecarReference {
  path: string;
  sha256: string;
  bytes: number;
}

export class ModelEvidenceStore {
  readonly root: string;
  private finalized = false;

  private constructor(runRoot: string, readonly runId: string) { this.root = resolve(runRoot, runId); }

  static create(runRoot: string, runId: string): ModelEvidenceStore {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(runId)) throw new ModelExecutionError('evidence_finalization_failure', 'invalid model run ID');
    mkdirSync(resolve(runRoot), { recursive: true, mode: 0o700 });
    const store = new ModelEvidenceStore(runRoot, runId);
    if (existsSync(store.root)) throw new ModelExecutionError('evidence_finalization_failure', `model run ID already exists: ${runId}`);
    mkdirSync(store.root, { recursive: false, mode: 0o700 });
    for (const path of ['sessions', 'faults', 'sidecars', 'reports']) mkdirSync(join(store.root, path), { recursive: true, mode: 0o700 });
    return store;
  }

  static open(path: string): ModelEvidenceStore {
    const root = resolve(path);
    const store = new ModelEvidenceStore(dirname(root), root.split(sep).at(-1)!);
    if (!existsSync(root)) throw new ModelExecutionError('evidence_finalization_failure', 'model run does not exist');
    store.finalized = existsSync(join(root, 'manifest.json'));
    return store;
  }

  writeJson(relativePath: string, value: unknown): ModelSidecarReference {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return this.write(relativePath, bytes);
  }

  writeCanonicalSidecar(kind: string, value: Json): ModelSidecarReference {
    const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
    const digest = sha256(bytes);
    const path = `sidecars/${kind}/${digest}.json`;
    const absolute = this.safe(path);
    if (existsSync(absolute)) {
      const existing = readFileSync(absolute);
      if (sha256(existing) !== digest) throw new ModelExecutionError('evidence_finalization_failure', `corrupt content-addressed sidecar ${path}`);
      return { path, sha256: digest, bytes: existing.length };
    }
    return this.write(path, bytes);
  }

  validate(reference: ModelSidecarReference): void {
    const bytes = readFileSync(this.safe(reference.path));
    if (bytes.length !== reference.bytes || sha256(bytes) !== reference.sha256) throw new ModelExecutionError('evidence_finalization_failure', `missing or corrupt sidecar ${reference.path}`);
  }

  finalize(manifest: unknown): { entryCount: number; manifestDigest: string; fileCount: number; exactBytes: number } {
    this.requireMutable();
    this.writeJson('manifest.json', manifest);
    const files = walk(this.root).filter((path) => relative(this.root, path) !== 'checksums.sha256');
    const lines = files.map((path) => `${sha256(readFileSync(path))}  ${relative(this.root, path).split(sep).join('/')}`);
    const checksumBytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    atomicExclusive(join(this.root, 'checksums.sha256'), checksumBytes);
    this.finalized = true;
    const all = walk(this.root);
    return { entryCount: lines.length, manifestDigest: sha256(checksumBytes), fileCount: all.length, exactBytes: all.reduce((sum, path) => sum + statSync(path).size, 0) };
  }

  reconstructTerminalRecords(): unknown[] {
    const directory = this.safe('sessions');
    const terminals: unknown[] = [];
    for (const session of readdirSync(directory).sort()) {
      const path = join(directory, session, 'terminal.json');
      if (!existsSync(path)) throw new ModelExecutionError('evidence_finalization_failure', `missing terminal record for ${session}`);
      terminals.push(JSON.parse(readFileSync(path, 'utf8')));
    }
    return terminals;
  }

  private write(relativePath: string, bytes: Buffer): ModelSidecarReference {
    this.requireMutable();
    const path = this.safe(relativePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    atomicExclusive(path, bytes);
    return { path: relativePath, sha256: sha256(bytes), bytes: bytes.length };
  }

  private safe(relativePath: string): string {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw new ModelExecutionError('evidence_finalization_failure', 'unsafe evidence path');
    const path = resolve(this.root, relativePath);
    const rel = relative(this.root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ModelExecutionError('evidence_finalization_failure', 'evidence path escapes root');
    return path;
  }

  private requireMutable(): void {
    if (this.finalized || existsSync(join(this.root, 'manifest.json'))) throw new ModelExecutionError('evidence_finalization_failure', 'model evidence is finalized and append-only');
  }
}

function atomicExclusive(path: string, bytes: Buffer): void {
  if (existsSync(path)) throw new ModelExecutionError('evidence_finalization_failure', `refusing evidence overwrite: ${path}`);
  const temp = `${path}.partial-${process.pid}`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function walk(root: string): string[] {
  const values: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) values.push(...walk(path));
    else if (entry.isFile()) values.push(path);
  }
  return values;
}

function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
