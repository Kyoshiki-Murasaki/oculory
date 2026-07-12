import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson } from '../src/schema/canonical.js';
import type { Json } from '../src/schema/types.js';
import { validatePhase6EvidenceIndex } from './support/validate-phase6-evidence-index.js';

const PATH = resolve(process.cwd(), 'docs/evidence/phase6-external-git-evidence-index-v1.json');

function index(): any { return JSON.parse(readFileSync(PATH, 'utf8')); }
function validate(value: any): void { validatePhase6EvidenceIndex(value, `${canonicalJson(value as Json)}\n`); }

test('Phase 6 evidence index is canonical, deterministic, and valid', () => {
  const serialized = readFileSync(PATH, 'utf8');
  const value = JSON.parse(serialized);
  assert.doesNotThrow(() => validatePhase6EvidenceIndex(value, serialized));
  assert.equal(serialized, `${canonicalJson(value)}\n`);
});

test('Phase 6 evidence index rejects duplicate run IDs and authoritative identities', () => {
  const duplicateId = index(); duplicateId.runs.push(structuredClone(duplicateId.runs[0]));
  assert.throws(() => validate(duplicateId), /duplicate run ID/);
  const duplicateAuthority = index(); duplicateAuthority.runs.find((run: any) => run.runId.includes('033132')).status = 'authoritative'; duplicateAuthority.runs.find((run: any) => run.runId.includes('033132')).decision = 'completed'; duplicateAuthority.runs.find((run: any) => run.runId.includes('033132')).authoritativeIdentity = 'gate-e1-scripted';
  assert.throws(() => validate(duplicateAuthority), /duplicate authoritative identity/);
});

test('Phase 6 evidence index rejects missing and malformed digests', () => {
  const missing = index(); missing.runs.find((run: any) => run.authoritativeIdentity === 'gate-e1-scripted').sourceTreeDigest = null;
  assert.throws(() => validate(missing), /sourceTreeDigest/);
  const malformed = index(); malformed.bindings.suiteSha256 = 'not-a-digest';
  assert.throws(() => validate(malformed), /SHA-256/);
});

test('Phase 6 evidence index rejects impossible status and decision combinations', () => {
  const authoritativeFailed = index(); authoritativeFailed.runs.find((run: any) => run.authoritativeIdentity === 'gate-e1-scripted').decision = 'failed';
  assert.throws(() => validate(authoritativeFailed), /authoritative run marked failed/);
  const failedPassed = index(); failedPassed.runs.find((run: any) => run.status === 'failed').decision = 'passed';
  assert.throws(() => validate(failedPassed), /failed historical run/);
});

test('Phase 6 evidence index rejects missing documentation and inconsistent bindings', () => {
  const missingDoc = index(); missingDoc.runs[0].documentationReference = '';
  assert.throws(() => validate(missingDoc), /documentationReference/);
  const binding = index(); binding.runs.find((run: any) => run.authoritativeIdentity === 'gate-e-replay-mutation').artifactHashes.suiteSha256 = '0'.repeat(64);
  assert.throws(() => validate(binding), /inconsistent candidate\/review\/suite\/registry bindings/);
});

test('Phase 6 evidence index rejects absolute paths and noncanonical serialization', () => {
  const absolute = index(); absolute.runs[0].documentationReference = ['', 'tmp', 'report.json'].join('/');
  assert.throws(() => validate(absolute), /absolute paths/);
  const value = index();
  assert.throws(() => validatePhase6EvidenceIndex(value, `${JSON.stringify(value, null, 2)}\n`), /nondeterministic serialization/);
});
