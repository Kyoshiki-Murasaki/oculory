import { createHash } from 'node:crypto';
import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  closeSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, hashJson } from '../schema/canonical.js';
import { syncDirectoryEntry } from '../schema/durable-write.js';
import type { Json } from '../schema/types.js';
import {
  EXTERNAL_TRACE_SCHEMA_VERSION,
  externalSidecarReferences,
  validateExternalRunManifest,
  validateExternalTraceV3,
  validateExternalTrialEnvelope,
  type ExternalPartition,
  type ExternalRunManifest,
  type ExternalSidecarReference,
  type ExternalTraceV3,
  type ExternalTrialEnvelope,
  type ExternalTrialRecord,
} from './schema-v3.js';

export const EXTERNAL_RUNS_SUBDIR = 'runs-external';

export class ExternalRunStore {
  readonly root: string;
  private finalized = false;

  private constructor(runRoot: string, readonly runId: string) {
    this.root = resolve(runRoot, runId);
  }

  static create(runRoot: string, runId: string): ExternalRunStore {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(runId)) throw new Error(`invalid external run ID: ${runId}`);
    const store = new ExternalRunStore(resolve(runRoot), runId);
    if (existsSync(store.root)) throw new Error(`external run ID already exists: ${store.root}`);
    mkdirSync(store.root, { recursive: false, mode: 0o700 });
    for (const path of [
      'sidecars/discovery', 'sidecars/transcripts', 'sidecars/journals', 'sidecars/cleanup',
      'traces/smoke', 'traces/mining', 'traces/holdout', 'traces/adversarial',
      'trials', 'reports', 'mining',
    ]) mkdirSync(join(store.root, path), { recursive: true, mode: 0o700 });
    return store;
  }

  static open(runDirectory: string): ExternalRunStore {
    const root = resolve(runDirectory);
    const store = new ExternalRunStore(dirname(root), root.split(sep).at(-1)!);
    if (!existsSync(root)) throw new Error(`external run does not exist: ${root}`);
    store.finalized = existsSync(join(root, 'manifest.json'));
    return store;
  }

  writeJson(relativePath: string, value: Json): string {
    this.requireMutable();
    const path = this.safePath(relativePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeExclusive(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
    return path;
  }

  writeText(relativePath: string, value: string): string {
    this.requireMutable();
    const path = this.safePath(relativePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeExclusive(path, Buffer.from(value, 'utf8'));
    return path;
  }

  writeSidecar(kind: 'discovery' | 'transcripts' | 'journals' | 'cleanup', value: Json, pointer?: string): ExternalSidecarReference {
    this.requireMutable();
    const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
    const digest = sha256(bytes);
    const relativePath = `sidecars/${kind}/${digest}.json`;
    const path = this.safePath(relativePath);
    if (existsSync(path)) {
      const existing = readFileSync(path);
      if (sha256(existing) !== digest) throw new Error(`corrupt content-addressed sidecar: ${relativePath}`);
    } else {
      writeExclusive(path, bytes);
    }
    return { path: relativePath, sha256: digest, bytes: bytes.length, mediaType: 'application/json', ...(pointer === undefined ? {} : { pointer }) };
  }

  writeTrace(trace: ExternalTraceV3): void {
    validateExternalTraceV3(trace);
    if (trace.runId !== this.runId) throw new Error('trace run ID does not match external store');
    this.validateTraceSidecars(trace);
    this.writeJson(`traces/${trace.partition}/${trace.traceId}.json`, trace as unknown as Json);
  }

  writeTerminalRecord(record: ExternalTrialRecord): ExternalTrialEnvelope {
    const digestInput = { ...record, trace: { ...record.trace, terminalRecordDigest: '<BOUND_BY_ENVELOPE>' } };
    const recordSha256 = hashJson(digestInput as unknown as Json);
    const boundRecord: ExternalTrialRecord = {
      ...record,
      trace: { ...record.trace, terminalRecordDigest: recordSha256 },
    };
    const envelope: ExternalTrialEnvelope = {
      schemaVersion: EXTERNAL_TRACE_SCHEMA_VERSION,
      recordSha256: hashJson(boundRecord as unknown as Json),
      record: boundRecord,
    };
    validateExternalTrialEnvelope(envelope);
    this.writeJson(`trials/${boundRecord.trace.trialId}.json`, envelope as unknown as Json);
    return envelope;
  }

  loadTrace(partition: ExternalPartition, traceId: string): ExternalTraceV3 {
    const value = JSON.parse(readFileSync(this.safePath(`traces/${partition}/${traceId}.json`), 'utf8')) as unknown;
    validateExternalTraceV3(value);
    this.validateTraceSidecars(value);
    return value;
  }

  listTraceIds(partition: ExternalPartition): string[] {
    return readdirSync(this.safePath(`traces/${partition}`))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .sort();
  }

  validateSidecar(reference: ExternalSidecarReference): void {
    const path = this.safePath(reference.path);
    if (!existsSync(path)) throw new Error(`missing external sidecar: ${reference.path}`);
    const bytes = readFileSync(path);
    if (bytes.length !== reference.bytes) throw new Error(`external sidecar size mismatch: ${reference.path}`);
    if (sha256(bytes) !== reference.sha256) throw new Error(`external sidecar digest mismatch: ${reference.path}`);
    if (reference.pointer !== undefined) validateJsonPointer(bytes, reference.pointer, reference.path);
  }

  finalize(manifest: ExternalRunManifest): void {
    this.requireMutable();
    validateExternalRunManifest(manifest);
    if (manifest.runId !== this.runId || manifest.finalized !== true || manifest.dirty !== false) {
      throw new Error('invalid finalized external run manifest');
    }
    this.writeJson('manifest.json', manifest as unknown as Json);
    const files = walkFiles(this.root).filter((path) => relative(this.root, path) !== 'checksums.sha256');
    const lines = files.map((path) => `${sha256(readFileSync(path))}  ${relative(this.root, path).split(sep).join('/')}`);
    writeExclusive(join(this.root, 'checksums.sha256'), Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
    this.finalized = true;
  }

  private validateTraceSidecars(trace: ExternalTraceV3): void {
    for (const reference of externalSidecarReferences(trace)) this.validateSidecar(reference);
  }

  private requireMutable(): void {
    if (this.finalized || existsSync(join(this.root, 'manifest.json'))) throw new Error(`external run is finalized and append-only: ${this.root}`);
  }

  private safePath(relativePath: string): string {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw new Error(`unsafe external evidence path: ${relativePath}`);
    const path = resolve(this.root, relativePath);
    const rel = relative(this.root, path);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error(`external evidence path escapes run root: ${relativePath}`);
    return path;
  }
}

function validateJsonPointer(bytes: Buffer, pointer: string, path: string): void {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new Error(`external sidecar pointer requires valid JSON: ${path}`); }
  if (pointer === '') return;
  for (const encoded of pointer.slice(1).split('/')) {
    const token = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= value.length) throw new Error(`external sidecar pointer does not resolve: ${path}#${pointer}`);
      value = value[Number(token)];
    } else if (value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, token)) {
      value = (value as Record<string, unknown>)[token];
    } else throw new Error(`external sidecar pointer does not resolve: ${path}#${pointer}`);
  }
}

function writeExclusive(path: string, bytes: Buffer): void {
  if (existsSync(path)) throw new Error(`refusing to overwrite external evidence: ${path}`);
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
  }
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (lstatSync(path).isDirectory()) visit(path);
      else out.push(path);
    }
  };
  visit(root);
  return out.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
