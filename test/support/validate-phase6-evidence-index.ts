import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson } from '../../src/schema/canonical.js';
import type { Json } from '../../src/schema/types.js';

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ABSOLUTE_PATH = /(?:^|[\s"'])(?:\/(?:Users|home|private|tmp|var\/folders)\/|[A-Za-z]:[\\/])/;
const VALID_STATUSES = new Set(['authoritative', 'failed', 'diagnostic', 'preflight', 'incomplete']);

type RecordValue = Record<string, unknown>;

function object(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as RecordValue;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function digest(value: unknown, label: string, required = true): string | null {
  if (value === null && !required) return null;
  const result = string(value, label);
  if (!SHA256.test(result)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${label} must be a string array`);
  return value as string[];
}

export function validatePhase6EvidenceIndex(value: unknown, serialized?: string): void {
  const root = object(value, 'index');
  if (root.schema !== 'oculory-phase6-external-git-evidence-index-v1') throw new Error('unexpected evidence-index schema');
  if (root.auditedSourceCommit !== '5ef4fa176fc5ac2e042f473a43ca2d57097269e7') throw new Error('audited source commit mismatch');
  if (!COMMIT.test(string(root.auditedSourceCommit, 'auditedSourceCommit'))) throw new Error('invalid audited source commit');
  if (root.auditedBranch !== 'master') throw new Error('audited branch mismatch');
  if (root.auditedTreeClean !== true) throw new Error('audited tree must be clean');
  string(root.generatedAt, 'generatedAt');
  if (root.rawEvidencePolicy !== 'Raw evidence is local, gitignored, and not stored in GitHub.') throw new Error('raw evidence policy mismatch');

  const live = object(root.historicalLiveEvidence, 'historicalLiveEvidence');
  integer(live.fileCount, 'historicalLiveEvidence.fileCount');
  integer(live.exactBytes, 'historicalLiveEvidence.exactBytes');
  digest(live.manifestSha256, 'historicalLiveEvidence.manifestSha256');

  const gates = root.gates;
  if (!Array.isArray(gates) || gates.length !== 6) throw new Error('exactly six gate records (A, B, C, D, E1, E) are required');
  const gateIds = gates.map((entry, index) => string(object(entry, `gates[${index}]`).gate, `gates[${index}].gate`));
  if (new Set(gateIds).size !== gateIds.length) throw new Error('duplicate gate record');
  for (const [index, entry] of gates.entries()) {
    const gate = object(entry, `gates[${index}]`);
    string(gate.decision, `gates[${index}].decision`);
    string(gate.documentationReference, `gates[${index}].documentationReference`);
    strings(gate.knownLimitations, `gates[${index}].knownLimitations`);
  }

  const runs = root.runs;
  if (!Array.isArray(runs) || runs.length === 0) throw new Error('run records are required');
  const runIds = new Set<string>();
  const authoritativeIdentities = new Set<string>();
  for (const [index, entry] of runs.entries()) {
    const run = object(entry, `runs[${index}]`);
    const id = string(run.runId, `runs[${index}].runId`);
    if (runIds.has(id)) throw new Error(`duplicate run ID: ${id}`);
    runIds.add(id);
    const status = string(run.status, `runs[${index}].status`);
    if (!VALID_STATUSES.has(status)) throw new Error(`invalid run status: ${status}`);
    const decision = string(run.decision, `runs[${index}].decision`);
    string(run.purpose, `runs[${index}].purpose`);
    string(run.documentationReference, `runs[${index}].documentationReference`);
    strings(run.knownLimitations, `runs[${index}].knownLimitations`);
    integer(run.fileCount, `runs[${index}].fileCount`);
    integer(run.exactBytes, `runs[${index}].exactBytes`);
    integer(run.checksumEntryCount, `runs[${index}].checksumEntryCount`);
    digest(run.checksumManifestSha256, `runs[${index}].checksumManifestSha256`, false);

    const sourceCommit = run.sourceCommit;
    if (sourceCommit !== null && !COMMIT.test(string(sourceCommit, `runs[${index}].sourceCommit`))) throw new Error(`runs[${index}].sourceCommit must be a commit hash or null`);
    const needsSourceDigest = status === 'authoritative';
    digest(run.sourceTreeDigest, `runs[${index}].sourceTreeDigest`, needsSourceDigest);

    const counts = object(run.terminalCounts, `runs[${index}].terminalCounts`);
    const total = integer(counts.total, `runs[${index}].terminalCounts.total`);
    const passed = integer(counts.passed, `runs[${index}].terminalCounts.passed`);
    const failed = integer(counts.failed, `runs[${index}].terminalCounts.failed`);
    const incomplete = integer(counts.incomplete, `runs[${index}].terminalCounts.incomplete`);
    if (passed + failed + incomplete !== total) throw new Error(`impossible terminal counts for ${id}`);

    const artifactHashes = object(run.artifactHashes, `runs[${index}].artifactHashes`);
    for (const [name, value] of Object.entries(artifactHashes)) digest(value, `runs[${index}].artifactHashes.${name}`);

    if (status === 'authoritative') {
      if (['failed', 'incomplete', 'insufficient', 'failed-preflight'].includes(decision)) throw new Error(`authoritative run marked failed: ${id}`);
      const identity = string(run.authoritativeIdentity, `runs[${index}].authoritativeIdentity`);
      if (authoritativeIdentities.has(identity)) throw new Error(`duplicate authoritative identity: ${identity}`);
      authoritativeIdentities.add(identity);
    } else if (run.authoritativeIdentity !== null) {
      throw new Error(`non-authoritative run has authoritative identity: ${id}`);
    }
    if (status === 'failed' && ['passed', 'completed'].includes(decision)) throw new Error(`failed historical run marked authoritative/passing: ${id}`);
  }

  const bindings = object(root.bindings, 'bindings');
  const candidate = digest(bindings.candidatePackageSha256, 'bindings.candidatePackageSha256');
  const review = digest(bindings.reviewArtifactSha256, 'bindings.reviewArtifactSha256');
  const suite = digest(bindings.suiteSha256, 'bindings.suiteSha256');
  const registry = digest(bindings.mutationRegistrySha256, 'bindings.mutationRegistrySha256');
  const e1 = runs.map((entry) => object(entry, 'run')).find((run) => run.authoritativeIdentity === 'gate-e1-scripted');
  const e2 = runs.map((entry) => object(entry, 'run')).find((run) => run.authoritativeIdentity === 'gate-e-replay-mutation');
  if (!e1 || !e2) throw new Error('authoritative Gate E1 and Gate E run bindings are required');
  if (object(e1.artifactHashes, 'Gate E1 artifact hashes').candidatePackageSha256 !== candidate) throw new Error('inconsistent candidate binding');
  const e2Hashes = object(e2.artifactHashes, 'Gate E artifact hashes');
  if (e2Hashes.candidatePackageSha256 !== candidate || e2Hashes.reviewArtifactSha256 !== review || e2Hashes.suiteSha256 !== suite || e2Hashes.mutationRegistrySha256 !== registry) {
    throw new Error('inconsistent candidate/review/suite/registry bindings');
  }

  const searchable = JSON.stringify(value);
  if (ABSOLUTE_PATH.test(searchable)) throw new Error('absolute paths are forbidden');
  if (serialized !== undefined && serialized !== `${canonicalJson(value as Json)}\n`) throw new Error('nondeterministic serialization: expected canonical JSON plus newline');
}

export function validatePhase6EvidenceIndexFile(path: string): string {
  const serialized = readFileSync(path, 'utf8');
  const parsed = JSON.parse(serialized) as unknown;
  validatePhase6EvidenceIndex(parsed, serialized);
  return path;
}

if (process.argv[1] && process.argv[1].endsWith('validate-phase6-evidence-index.js')) {
  const requested = process.argv[2];
  if (!requested) throw new Error('usage: validate-phase6-evidence-index <path>');
  const path = resolve(requested);
  validatePhase6EvidenceIndexFile(path);
  process.stdout.write(`validated ${requested}\n`);
}
