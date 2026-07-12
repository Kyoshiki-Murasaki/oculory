import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GIT_GATE_E2_APPROVED_IDS, GIT_GATE_E2_CANDIDATE_PACKAGE_SHA256, GIT_GATE_E2_REJECTED_IDS,
  GitGateE2HoldoutGuard, evaluateGitCompiledSuite, validateGitCandidateReview, validateGitCompiledSuite,
  type GitCandidateReviewV1, type GitCompiledSuiteV1,
} from '../src/targets/git/gate-e2.js';
import {
  buildGitGateE2MutationRegistry, validateGitGateE2MutationRegistry, type GitGateE2MutationRegistry,
} from '../src/targets/git/gate-e2-registry.js';
import { gitGateE2TargetWrapperBundle } from '../src/targets/git/gate-e2-wrappers.js';
import { gitGateE1Scenario } from '../src/targets/git/catalogue.js';
import { authoredGitVerifierCases } from './support/git-verifier-evidence.js';
import { verifyGitEvidence } from '../src/targets/git/verifier.js';
import type { GitScriptedScenarioResult } from '../src/targets/git/scripted-driver.js';

const ROOT = process.cwd();
const REVIEW_PATH = resolve(ROOT, 'reviews/git-gate-e1-candidate-review-v1.json');
const SUITE_PATH = resolve(ROOT, 'suites/external/git/git-suite-v1.json');
const STAGE_PATH = resolve(ROOT, 'suites/external/git/git-stage-contract-v1.json');
const BRANCH_PATH = resolve(ROOT, 'suites/external/git/git-branch-create-contract-v1.json');
const REGISTRY_PATH = resolve(ROOT, 'mutations/external/git/git-gate-e2-mutation-registry-v1.json');

function review(): GitCandidateReviewV1 { return JSON.parse(readFileSync(REVIEW_PATH, 'utf8')) as GitCandidateReviewV1; }
function suite(): GitCompiledSuiteV1 { return JSON.parse(readFileSync(SUITE_PATH, 'utf8')) as GitCompiledSuiteV1; }
function registry(): GitGateE2MutationRegistry { return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as GitGateE2MutationRegistry; }

test('Gate E2 review enforces the exact approval list', () => {
  assert.doesNotThrow(() => validateGitCandidateReview(review()));
  const changed = review(); changed.approvedIds = changed.approvedIds.slice(1);
  assert.throws(() => validateGitCandidateReview(changed), /approval list/);
});

test('Gate E2 review enforces the exact rejection list', () => {
  const changed = review(); changed.rejectedIds = ['git-cand-ee04c8e75603'];
  assert.throws(() => validateGitCandidateReview(changed), /rejection list/);
});

test('Gate E2 review binds the exact candidate-package hash', () => {
  assert.equal(review().candidatePackageSha256, GIT_GATE_E2_CANDIDATE_PACKAGE_SHA256);
  const changed = review(); changed.candidatePackageSha256 = '0'.repeat(64) as never;
  assert.throws(() => validateGitCandidateReview(changed), /candidate package/);
});

test('Gate E2 review artifact has explicit human provenance and no signature claim', () => {
  const value = review();
  assert.equal(value.reviewer, 'Dev');
  assert.equal(value.cryptographicSignatureClaim, false);
  assert.equal(value.decisionSource, 'explicit human candidate-ID authorization in the Gate E2 task prompt');
});

test('compiled suite serialization and self-hash are deterministic', () => {
  const value = suite();
  assert.doesNotThrow(() => validateGitCompiledSuite(value));
  assert.equal(JSON.stringify(value), JSON.stringify(JSON.parse(JSON.stringify(value))));
  assert.match(value.suiteSha256, /^[a-f0-9]{64}$/);
});

test('compiled suite includes only approved candidates and excludes rejected path candidates', () => {
  const value = suite();
  assert.deepEqual(value.approvedCandidateIds, [...GIT_GATE_E2_APPROVED_IDS].sort());
  assert.deepEqual(value.rejectedCandidateIds, [...GIT_GATE_E2_REJECTED_IDS].sort());
  const contracts = `${readFileSync(STAGE_PATH, 'utf8')}\n${readFileSync(BRANCH_PATH, 'utf8')}`;
  for (const id of GIT_GATE_E2_REJECTED_IDS) assert.equal(contracts.includes(id), false);
});

test('compiled suite is bound to target, schema, adapter, fixture, verifier, catalogue, and miner', () => {
  const value = suite();
  assert.equal(value.target.version, '2026.7.10');
  assert.equal(value.schemaVersion, 'external-trace-v3');
  assert.equal(value.adapterVersion, 'git-scripted-adapter-v1');
  assert.equal(value.fixture.version, 'git-spike-seed-v1');
  assert.equal(value.verifierVersion, 'git-verifier-v1');
  assert.equal(value.catalogue.version, 'git-gate-e1-catalogue-v1');
  assert.equal(value.minerVersion, 'git-miner-v1');
  assert.equal(Object.keys(value.toolSchemaDigests).length, 12);
});

test('holdout guard refuses opening before suite finalization', () => {
  const guard = new GitGateE2HoldoutGuard();
  assert.throws(() => guard.openHoldout('a'.repeat(64)), /before suite finalization/);
});

test('holdout guard binds opening to the finalized suite hash', () => {
  const guard = new GitGateE2HoldoutGuard();
  guard.finalizeSuite('a'.repeat(64));
  assert.throws(() => guard.openHoldout('b'.repeat(64)), /alter or replace/);
  guard.openHoldout('a'.repeat(64));
  assert.equal(guard.state().holdoutOpened, true);
});

test('stage and branch contracts are non-exhaustive path contracts', () => {
  const stage = JSON.parse(readFileSync(STAGE_PATH, 'utf8'));
  const branch = JSON.parse(readFileSync(BRANCH_PATH, 'utf8'));
  assert.equal(stage.permitsNonExhaustiveToolPaths, true);
  assert.equal(branch.permitsNonExhaustiveToolPaths, true);
  assert.equal(stage.assertions.some((entry: any) => entry.assertionType === 'exhaustive_allowed_tool_path'), false);
  assert.equal(branch.assertions.some((entry: any) => entry.assertionType === 'exhaustive_allowed_tool_path'), false);
});

test('suite evaluator reports suite and independent golden results separately', () => {
  const authored = authoredGitVerifierCases().find((entry) => entry.id === 'A02')!;
  const scenario = gitGateE1Scenario('git-stage-m1');
  const input = authored.input;
  const result = {
    initialSnapshot: input.initialSnapshot,
    finalSnapshot: input.finalSnapshot,
    execution: { calls: input.calls.map((call, index) => ({ ...call, index, arguments: index === 1 ? { files: ['README.md'] } : {}, outcomeClass: call.outcomeClass, isError: call.isError })), cleanup: { passed: true } },
    verifierResult: verifyGitEvidence(input), verifierInput: input,
  } as unknown as GitScriptedScenarioResult;
  const evaluated = evaluateGitCompiledSuite(suite(), scenario, result);
  assert.equal(typeof evaluated.suitePassed, 'boolean');
  assert.equal(evaluated.goldenPassed, true);
  assert.notEqual(evaluated.assertions.length, 0);
});

test('mutation registry is complete, immutable, and exactly 39 entries', () => {
  const value = registry();
  assert.doesNotThrow(() => validateGitGateE2MutationRegistry(value));
  assert.equal(value.entries.length, 39);
  assert.equal(value.entries.filter((entry) => entry.classification === 'harmful').length, 34);
  assert.equal(value.entries.filter((entry) => entry.classification === 'benign_control').length, 5);
});

test('mutation registry harmful layers are classified 7/8/7/6/6', () => {
  assert.deepEqual(registry().harmfulCountsByLayer, { target: 7, adapter: 8, verifier: 7, transport: 6, fixture: 6 });
});

test('every mutation and control has three trials and designated scenarios', () => {
  assert.equal(registry().entries.every((entry) => entry.trialCount === 3 && entry.designatedScenarios.length > 0), true);
});

test('post-hoc registry editing is refused', () => {
  const changed = registry(); changed.entries[0]!.trialCount = 2 as never;
  assert.throws(() => validateGitGateE2MutationRegistry(changed), /differs|trial/);
});

test('target patched-copy provenance binds exact wrapper templates', () => {
  for (const id of ['target/add-silent-noop', 'target/add-wrong-file', 'target/reset-noop', 'target/create-branch-wrong-base', 'target/checkout-wrong-branch', 'target/repository-scope-bypass', 'target/error-as-success']) {
    const entry = registry().entries.find((value) => value.id === id)!;
    assert.equal(entry.mechanismDigest, gitGateE2TargetWrapperBundle(id).digest);
    assert.match(entry.baseArtifactOrSourceDigest, /^[a-f0-9]{64}$/);
  }
});

test('adapter mutations are isolated from production switches', () => {
  const adapter = registry().entries.filter((entry) => entry.layer === 'adapter');
  assert.equal(adapter.length, 8);
  assert.equal(adapter.every((entry) => /test-only/.test(entry.mechanism)), true);
});

test('verifier mutations name an independent meta-oracle', () => {
  const verifier = registry().entries.filter((entry) => entry.layer === 'verifier');
  assert.equal(verifier.length, 7);
  assert.equal(verifier.every((entry) => entry.expectedLayerSpecificDetection.includes('meta-oracle')), true);
});

test('transport registry binds protocol proxy evidence and benign framing controls', () => {
  const source = readFileSync(resolve(ROOT, 'test/support/mcp-protocol-fixture.ts'), 'utf8');
  for (const mode of ['mismatched-response-id', 'stdout-contamination', 'malformed-json', 'late-response-after-cancellation', 'cancellation-ignored', 'out-of-order-valid-ids']) assert.equal(source.includes(`'${mode}'`), true);
});

test('fixture mutation evidence names uniqueness, overlay, sentinel, cleanup, and lock detectors', () => {
  const ids = registry().entries.filter((entry) => entry.layer === 'fixture').map((entry) => entry.id);
  assert.deepEqual(ids.sort(), ['fixture/cleanup-residue', 'fixture/outside-sentinel-changed', 'fixture/reuse-server-process', 'fixture/reuse-trial-root', 'fixture/seed-overlay-omitted', 'fixture/stale-index-lock']);
});

test('registry digest and tracked file bytes are stable inputs to reporting', () => {
  const value = registry();
  assert.equal(value.registryDigest, buildGitGateE2MutationRegistry().registryDigest);
  assert.match(createHash('sha256').update(readFileSync(REGISTRY_PATH)).digest('hex'), /^[a-f0-9]{64}$/);
});

test('per-layer recall and benign false-positive denominators are preregistered', () => {
  const value = registry();
  assert.equal(Object.values(value.harmfulCountsByLayer).reduce((sum, count) => sum + count, 0), 34);
  assert.equal(value.benignControlCount, 5);
});
