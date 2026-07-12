import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/schema/canonical.js';
import { GIT_VERIFIER_DECISION_TABLE, GIT_VERIFIER_POLICY_TABLE_DIGEST } from '../src/targets/git/verifier-policy.js';
import { verifyGitEvidence } from '../src/targets/git/verifier.js';
import { GIT_VERIFIER_VERSION } from '../src/targets/git/verifier-types.js';
import {
  authoredGitVerifierCases,
  controlledGitVerifierMutations,
  runVerifierMutationControls,
} from './support/git-verifier-evidence.js';

const authored = authoredGitVerifierCases();
const mutations = controlledGitVerifierMutations(authored);

test('Git Gate D decision table is explicit, versioned, and digest-bound', () => {
  assert.equal(GIT_VERIFIER_DECISION_TABLE.length, 26);
  assert.match(GIT_VERIFIER_POLICY_TABLE_DIGEST, /^[a-f0-9]{64}$/);
  assert.equal(GIT_VERIFIER_VERSION, 'git-verifier-v1');
});

for (const entry of authored) {
  test(`Git verifier authored ${entry.id}: ${entry.evidenceShape}`, () => {
    const result = verifyGitEvidence(entry.input);
    assert.equal(result.outcome, entry.expectedOutcome);
    assert.equal(result.failureSubtype, entry.expectedSubtype);
    assert.equal(result.verifierVersion, GIT_VERIFIER_VERSION);
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    for (const reference of result.evidenceReferences) {
      assert.ok(entry.input.evidenceReferences.some((item) => item.id === reference), `unresolved result reference ${reference}`);
    }
  });
}

for (const entry of mutations) {
  test(`Git verifier controlled mutation ${entry.id}: ${entry.mutation}`, () => {
    const result = verifyGitEvidence(entry.input);
    assert.equal(result.outcome, entry.expectedOutcome);
    assert.equal(result.failureSubtype, entry.expectedSubtype);
  });
}

test('Git verifier corpus covers every primary outcome and transient subtype', () => {
  const results = [...authored, ...mutations].map((entry) => verifyGitEvidence(entry.input));
  assert.deepEqual(
    [...new Set(results.map((entry) => entry.outcome))].sort(),
    ['invalid_acceptance', 'partial_success', 'unknown', 'valid_rejection', 'verified_failure', 'verified_success'],
  );
  assert.ok(results.some((entry) => entry.outcome === 'verified_failure' && entry.failureSubtype === 'transient_mutation'));
});

test('Git verifier is byte-deterministic across repeats and object insertion order', () => {
  for (const entry of [...authored, ...mutations]) {
    const serializations = Array.from({ length: 7 }, () => canonicalJson(verifyGitEvidence(structuredClone(entry.input)) as never));
    assert.equal(new Set(serializations).size, 1, `${entry.id} serialization drifted`);
    const digests = serializations.map((value) => JSON.parse(value).digest as string);
    assert.equal(new Set(digests).size, 1, `${entry.id} digest drifted`);

    const reordered = structuredClone(entry.input);
    reordered.policy = Object.fromEntries(Object.entries(reordered.policy).reverse()) as unknown as typeof reordered.policy;
    assert.equal(verifyGitEvidence(reordered).digest, verifyGitEvidence(entry.input).digest, `${entry.id} depended on key insertion order`);
  }
});

test('Git verifier evidence is tokenized and contains no absolute path or timestamp dependency', () => {
  for (const entry of [...authored, ...mutations]) {
    const serialized = canonicalJson(entry.input as never);
    assert.equal(serialized.includes('/Users/'), false);
    assert.equal(serialized.includes('/private/tmp/'), false);
    assert.equal(/20\d\d-\d\d-\d\dT/.test(serialized), false);
  }
});

test('Git verifier fails closed for malformed input, missing snapshots, duplicate evidence IDs, and unsupported versions', () => {
  assert.equal(verifyGitEvidence(null).outcome, 'unknown');
  assert.equal(verifyGitEvidence({ verifierVersion: GIT_VERIFIER_VERSION }).outcome, 'unknown');
  assert.equal(verifyGitEvidence({ ...authored[0]!.input, policy: {} }).outcome, 'unknown');
  assert.equal(verifyGitEvidence({ ...authored[0]!.input, calls: [{}] }).outcome, 'unknown');

  const missing = structuredClone(authored[0]!.input);
  missing.finalSnapshot = null;
  missing.evidenceComplete = false;
  missing.declaredMissingEvidence = ['final_snapshot'];
  assert.equal(verifyGitEvidence(missing).outcome, 'unknown');

  const duplicate = structuredClone(authored[0]!.input);
  duplicate.evidenceReferences = [...duplicate.evidenceReferences, structuredClone(duplicate.evidenceReferences[0]!)];
  assert.equal(verifyGitEvidence(duplicate).outcome, 'unknown');
  assert.deepEqual(verifyGitEvidence(duplicate).evidenceCompleteness.duplicateReferenceIds, ['snapshot:initial']);

  const unsupported = structuredClone(authored[0]!.input);
  unsupported.verifierVersion = 'git-verifier-v999';
  assert.equal(verifyGitEvidence(unsupported).outcome, 'unknown');
  assert.equal(verifyGitEvidence(unsupported).failureSubtype, 'evidence_incomplete');
});

test('Git verifier result references resolve and reason ordering is stable', () => {
  for (const entry of [...authored, ...mutations]) {
    const result = verifyGitEvidence(entry.input);
    assert.deepEqual(result.reasons, [...result.reasons].sort());
    assert.equal(result.evidenceCompleteness.unresolvedReferences.length, 0);
    assert.equal(result.evidenceCompleteness.duplicateReferenceIds.length, 0);
  }
});

test('Git verifier mutation-resistance controls are all detected by the corpus', () => {
  const results = runVerifierMutationControls([...authored, ...mutations]);
  assert.equal(results.length, 12);
  assert.equal(results.every((entry) => entry.detected), true, canonicalJson(results as never));
  assert.equal(results.every((entry) => entry.detectingCases.length > 0), true);
});
