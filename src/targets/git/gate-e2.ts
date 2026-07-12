import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, hashJson } from '../../schema/canonical.js';
import type { Json, JsonObject } from '../../schema/types.js';
import { changedIndexPaths, changedRefNames } from '../git-spike/snapshot.js';
import type { GitScriptedScenarioResult } from './scripted-driver.js';
import type { GitGateE1Scenario } from './catalogue.js';
import type { GitMinedCandidate } from './mining.js';

export const GIT_GATE_E2_COMPILER_VERSION = 'git-suite-compiler-v1' as const;
export const GIT_GATE_E2_SUITE_SCHEMA = 'git-external-suite-v1' as const;
export const GIT_GATE_E2_SUITE_ID = 'git-suite-v1' as const;
export const GIT_GATE_E2_REVIEW_ID = 'git-gate-e1-candidate-review-v1' as const;
export const GIT_GATE_E2_E1_RUN_ID = 'git-gate-e1-scripted-20260712T033640Z' as const;
export const GIT_GATE_E2_CANDIDATE_PACKAGE_SHA256 = 'ec1b4f9f870fb5fef68aa5994dc932d8e4157b52b739097cead1aca684854740' as const;

export const GIT_GATE_E2_APPROVED_IDS = Object.freeze([
  'git-cand-514fac8b126e',
  'git-cand-5f985ca6af7d',
  'git-cand-6d85a493c006',
  'git-cand-7795e229e945',
  'git-cand-970b53354b15',
  'git-cand-ad763acaa2e6',
  'git-cand-e1226b984f8c',
  'git-cand-f0b0aa748842',
] as const);

export const GIT_GATE_E2_REJECTED_IDS = Object.freeze([
  'git-cand-18ea17797c83',
  'git-cand-ee04c8e75603',
] as const);

export interface GitCandidateReviewV1 {
  schema: 'git-candidate-review-v1';
  reviewId: typeof GIT_GATE_E2_REVIEW_ID;
  reviewer: 'Dev';
  decisionSource: 'explicit human candidate-ID authorization in the Gate E2 task prompt';
  candidatePackageSha256: typeof GIT_GATE_E2_CANDIDATE_PACKAGE_SHA256;
  authoritativeGateE1RunId: typeof GIT_GATE_E2_E1_RUN_ID;
  catalogueDigest: string;
  minerVersion: 'git-miner-v1';
  reviewTimestamp: string;
  approvedIds: string[];
  rejectedIds: string[];
  rationale: { approved: string; rejected: string };
  scopeOfApproval: string;
  cryptographicSignatureClaim: false;
}

export interface GitCompiledContractV1 {
  schema: 'git-contract-v1';
  contractId: 'git-stage-contract-v1' | 'git-branch-create-contract-v1';
  family: 'git-stage' | 'git-branch-create';
  blocking: true;
  candidateIds: string[];
  assertions: Array<{
    candidateId: string;
    assertionType: string;
    generalizedPredicate: JsonObject;
    distinctScenarioSupport: number;
    trialSupport: number;
    provenanceTraceIds: string[];
    scenarioIds: string[];
    evidenceDigest: string;
  }>;
  permitsNonExhaustiveToolPaths: true;
  permittedExamples: string[][];
  digest: string;
}

export interface GitCompiledSuiteV1 {
  schema: typeof GIT_GATE_E2_SUITE_SCHEMA;
  suiteId: typeof GIT_GATE_E2_SUITE_ID;
  version: 1;
  suiteSha256: string;
  candidatePackageSha256: string;
  reviewArtifactDigest: string;
  reviewId: string;
  approvedCandidateIds: string[];
  rejectedCandidateIds: string[];
  authoritativeGateE1RunId: string;
  sourceTraceIds: string[];
  miningScenarioIds: string[];
  target: JsonObject;
  artifactHashes: JsonObject;
  toolInventoryDigest: string;
  rawDiscoveryDigest: string;
  toolSchemaDigests: Record<string, string>;
  adapterVersion: string;
  fixture: { version: string; digest: string };
  verifierVersion: string;
  catalogue: { version: string; digest: string };
  minerVersion: string;
  schemaVersion: string;
  normalizationRules: string[];
  replayPolicy: JsonObject;
  eligibleHoldoutFamilies: string[];
  eligibleHoldoutScenarioIds: string[];
  compilerVersion: typeof GIT_GATE_E2_COMPILER_VERSION;
  sourceCommit: string;
  contracts: Array<{ contractId: string; digest: string }>;
}

export interface GitSuiteCompilation {
  review: GitCandidateReviewV1;
  reviewArtifactDigest: string;
  stageContract: GitCompiledContractV1;
  branchContract: GitCompiledContractV1;
  suite: GitCompiledSuiteV1;
}

export interface GitSuiteAssertionResult {
  candidateId: string;
  passed: boolean;
  detail: string;
}

export interface GitSuiteEvaluation {
  suiteId: string;
  contractId: string;
  scenarioId: string;
  assertions: GitSuiteAssertionResult[];
  suitePassed: boolean;
  goldenOutcome: string;
  goldenPassed: boolean;
}

export class GitGateE2HoldoutGuard {
  private finalizedSuiteDigest: string | null = null;
  private opened = false;

  finalizeSuite(suiteDigest: string): void {
    if (!/^[a-f0-9]{64}$/.test(suiteDigest)) throw new Error('suite must have a finalized SHA-256 before holdout opening');
    if (this.opened) throw new Error('suite cannot be finalized after holdout opening');
    this.finalizedSuiteDigest = suiteDigest;
  }

  openHoldout(suiteDigest: string): void {
    if (this.finalizedSuiteDigest === null) throw new Error('holdout cannot open before suite finalization');
    if (suiteDigest !== this.finalizedSuiteDigest) throw new Error('holdout cannot alter or replace the finalized suite');
    this.opened = true;
  }

  state(): { finalizedSuiteDigest: string | null; holdoutOpened: boolean } {
    return { finalizedSuiteDigest: this.finalizedSuiteDigest, holdoutOpened: this.opened };
  }
}

export function compileGitGateE2Suite(options: {
  e1RunDirectory: string;
  reviewPath: string;
}): GitSuiteCompilation {
  const e1 = resolve(options.e1RunDirectory);
  const reviewPath = resolve(options.reviewPath);
  const candidatePath = join(e1, 'candidates.json');
  const manifestPath = join(e1, 'manifest.json');
  const discoveryPath = join(e1, 'sidecars/discovery/c3b3ea34b9fba34315ecca541d697551bb27bd3cb101f10cf4c9116b2d5f12ac.json');
  for (const path of [reviewPath, candidatePath, manifestPath, discoveryPath]) {
    if (!existsSync(path)) throw new Error(`suite evidence reference cannot be resolved: ${path}`);
  }
  const reviewBytes = readFileSync(reviewPath);
  const candidateBytes = readFileSync(candidatePath);
  const review = JSON.parse(reviewBytes.toString('utf8')) as GitCandidateReviewV1;
  validateGitCandidateReview(review);
  if (sha256(candidateBytes) !== review.candidatePackageSha256) throw new Error('candidate package hash differs from reviewed package');

  const candidatePackage = JSON.parse(candidateBytes.toString('utf8')) as {
    minerVersion: string;
    computedBeforeHoldoutEvaluation: boolean;
    miningTraceIds: string[];
    miningScenarioIds: string[];
    candidates: GitMinedCandidate[];
  };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as Record<string, any>;
  validateSourceBindings(review, candidatePackage, manifest, e1);

  const byId = new Map<string, GitMinedCandidate>();
  for (const candidate of candidatePackage.candidates) {
    if (byId.has(candidate.candidateId)) throw new Error(`candidate ID duplicated: ${candidate.candidateId}`);
    byId.set(candidate.candidateId, candidate);
  }
  const reviewedIds = new Set([...review.approvedIds, ...review.rejectedIds]);
  if (reviewedIds.size !== candidatePackage.candidates.length || candidatePackage.candidates.some((candidate) => !reviewedIds.has(candidate.candidateId))) {
    throw new Error('unreviewed candidate is present or reviewed candidate is missing');
  }
  for (const id of review.approvedIds) if (!byId.has(id)) throw new Error(`approved candidate missing: ${id}`);
  for (const id of review.rejectedIds) if (!byId.has(id)) throw new Error(`rejected candidate missing: ${id}`);

  const stageContract = contract(
    'git-stage-contract-v1',
    'git-stage',
    ['git-cand-e1226b984f8c', 'git-cand-514fac8b126e', 'git-cand-6d85a493c006', 'git-cand-5f985ca6af7d'],
    [['git_add'], ['git_status', 'git_add'], ['git_diff_unstaged', 'git_add', 'git_diff_staged']],
    byId,
  );
  const branchContract = contract(
    'git-branch-create-contract-v1',
    'git-branch-create',
    ['git-cand-f0b0aa748842', 'git-cand-7795e229e945', 'git-cand-970b53354b15', 'git-cand-ad763acaa2e6'],
    [['git_create_branch'], ['git_branch', 'git_create_branch']],
    byId,
  );
  const included = [...stageContract.candidateIds, ...branchContract.candidateIds].sort();
  if (!sameStrings(included, [...GIT_GATE_E2_APPROVED_IDS].sort())) throw new Error('compiled suite contains rejected, advisory, or unreviewed candidates');

  const toolSchemaDigests = Object.fromEntries((discovery.tools as Array<Record<string, string>>).map((tool) => [tool.name, tool.semanticDigest]));
  const withoutDigest: Omit<GitCompiledSuiteV1, 'suiteSha256'> & { suiteSha256: '<SELF>' } = {
    schema: GIT_GATE_E2_SUITE_SCHEMA,
    suiteId: GIT_GATE_E2_SUITE_ID,
    version: 1,
    suiteSha256: '<SELF>',
    candidatePackageSha256: review.candidatePackageSha256,
    reviewArtifactDigest: sha256(reviewBytes),
    reviewId: review.reviewId,
    approvedCandidateIds: [...review.approvedIds].sort(),
    rejectedCandidateIds: [...review.rejectedIds].sort(),
    authoritativeGateE1RunId: manifest.runId,
    sourceTraceIds: [...candidatePackage.miningTraceIds].sort(),
    miningScenarioIds: [...candidatePackage.miningScenarioIds].sort(),
    target: structuredClone(manifest.target),
    artifactHashes: {
      wheelSha256: manifest.target.wheelSha256,
      installedSourceSha256: manifest.target.installedSourceSha256,
      executableSha256: manifest.target.executableSha256,
      dependencyLockSha256: manifest.target.dependencyLockSha256,
    },
    toolInventoryDigest: discovery.canonical_discovery_digest,
    rawDiscoveryDigest: discovery.raw_discovery_digest,
    toolSchemaDigests,
    adapterVersion: manifest.adapterVersion,
    fixture: { version: manifest.fixtureRecipeVersion, digest: manifest.fixtureRecipeDigest },
    verifierVersion: manifest.verifierVersion,
    catalogue: { version: manifest.catalogueVersion, digest: manifest.catalogueDigest },
    minerVersion: manifest.minerVersion,
    schemaVersion: manifest.externalTraceSchema,
    normalizationRules: [...manifest.normalizationRules],
    replayPolicy: {
      freshProcess: true,
      freshFixture: true,
      freshTrialRoot: true,
      serial: true,
      retriesReplaceCanonicalTrials: false,
      trialsPerScenario: 3,
      suiteAndGoldenSeparated: true,
      cleanup: 'CP-1',
    },
    eligibleHoldoutFamilies: ['git-stage', 'git-branch-create'],
    eligibleHoldoutScenarioIds: ['git-stage-h1', 'git-branch-h1'],
    compilerVersion: GIT_GATE_E2_COMPILER_VERSION,
    sourceCommit: manifest.implementationCommit,
    contracts: [
      { contractId: stageContract.contractId, digest: stageContract.digest },
      { contractId: branchContract.contractId, digest: branchContract.digest },
    ],
  };
  const suite: GitCompiledSuiteV1 = { ...withoutDigest, suiteSha256: hashJson(withoutDigest as unknown as Json) };
  validateGitCompiledSuite(suite);
  return { review, reviewArtifactDigest: sha256(reviewBytes), stageContract, branchContract, suite };
}

export function validateGitCandidateReview(review: GitCandidateReviewV1): void {
  if (review.schema !== 'git-candidate-review-v1' || review.reviewId !== GIT_GATE_E2_REVIEW_ID) throw new Error('review artifact schema or ID differs');
  if (review.reviewer !== 'Dev') throw new Error('reviewer differs from explicit human decision');
  if (review.decisionSource !== 'explicit human candidate-ID authorization in the Gate E2 task prompt') throw new Error('review decision source differs');
  if (review.candidatePackageSha256 !== GIT_GATE_E2_CANDIDATE_PACKAGE_SHA256) throw new Error('review candidate package differs');
  if (review.authoritativeGateE1RunId !== GIT_GATE_E2_E1_RUN_ID) throw new Error('review references another Gate E1 run');
  if (review.minerVersion !== 'git-miner-v1') throw new Error('review references another miner');
  if (!sameStrings(review.approvedIds, [...GIT_GATE_E2_APPROVED_IDS])) throw new Error('exact approval list enforcement failed');
  if (!sameStrings(review.rejectedIds, [...GIT_GATE_E2_REJECTED_IDS])) throw new Error('exact rejection list enforcement failed');
  if (new Set([...review.approvedIds, ...review.rejectedIds]).size !== 10) throw new Error('review contains missing or duplicate candidate IDs');
  if (review.cryptographicSignatureClaim !== false) throw new Error('review must not claim a cryptographic signature');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(review.reviewTimestamp)) throw new Error('review timestamp is invalid');
}

export function validateGitCompiledSuite(suite: GitCompiledSuiteV1): void {
  if (suite.schema !== GIT_GATE_E2_SUITE_SCHEMA || suite.suiteId !== GIT_GATE_E2_SUITE_ID || suite.version !== 1) throw new Error('compiled suite identity differs');
  const observed = hashJson({ ...suite, suiteSha256: '<SELF>' } as unknown as Json);
  if (observed !== suite.suiteSha256) throw new Error('compiled suite hash differs');
  if (!sameStrings(suite.approvedCandidateIds, [...GIT_GATE_E2_APPROVED_IDS])) throw new Error('compiled suite approval set differs');
  if (!sameStrings(suite.rejectedCandidateIds, [...GIT_GATE_E2_REJECTED_IDS])) throw new Error('compiled suite rejection set differs');
  if (suite.contracts.some((entry) => GIT_GATE_E2_REJECTED_IDS.includes(entry.contractId as never))) throw new Error('rejected candidate entered suite');
}

export function evaluateGitCompiledSuite(
  suite: GitCompiledSuiteV1,
  scenario: GitGateE1Scenario,
  result: GitScriptedScenarioResult,
): GitSuiteEvaluation {
  validateGitCompiledSuite(suite);
  if (scenario.family !== 'git-stage' && scenario.family !== 'git-branch-create') throw new Error(`scenario is not covered by approved suite: ${scenario.id}`);
  const calls = result.execution.calls;
  const entities = scenario.intendedEntities;
  const assertions: GitSuiteAssertionResult[] = [];
  if (scenario.family === 'git-stage') {
    const addCalls = calls.filter((call) => call.tool === 'git_add');
    assertions.push(assertion('git-cand-e1226b984f8c', addCalls.length >= 1, `git_add calls=${addCalls.length}`));
    const path = entities.path;
    assertions.push(assertion('git-cand-514fac8b126e', typeof path === 'string' && addCalls.length > 0 && addCalls.every((call) => Array.isArray(call.arguments.files) && call.arguments.files[0] === path), 'git_add.files[0] equals @entity:path'));
    const changed = changedIndexPaths(result.initialSnapshot, result.finalSnapshot);
    const index = typeof path === 'string' ? result.finalSnapshot.index.find((entry) => entry.stage === 0 && entry.path === path) : undefined;
    const worktree = typeof path === 'string' ? result.finalSnapshot.worktree.find((entry) => entry.type === 'file' && entry.path === path) : undefined;
    assertions.push(assertion('git-cand-6d85a493c006', typeof path === 'string' && changed.length === 1 && changed[0] === path && index?.blobSha256 === worktree?.sha256, `changed index paths=${changed.join(',')}`));
    assertions.push(outcomeAssertion('git-cand-5f985ca6af7d', result));
  } else {
    const createCalls = calls.filter((call) => call.tool === 'git_create_branch');
    assertions.push(assertion('git-cand-f0b0aa748842', createCalls.length >= 1, `git_create_branch calls=${createCalls.length}`));
    const branch = entities.branch;
    assertions.push(assertion('git-cand-7795e229e945', typeof branch === 'string' && createCalls.length > 0 && createCalls.every((call) => call.arguments.branch_name === branch), 'git_create_branch.branch_name equals @entity:branch'));
    const refs = changedRefNames(result.initialSnapshot, result.finalSnapshot);
    const refName = typeof branch === 'string' ? `refs/heads/${branch}` : '';
    const ref = result.finalSnapshot.refs.find((entry) => entry.name === refName);
    assertions.push(assertion('git-cand-970b53354b15', typeof branch === 'string' && refs.length === 1 && refs[0] === refName && ref?.objectId === result.initialSnapshot.headObjectId && result.finalSnapshot.symbolicBranch === result.initialSnapshot.symbolicBranch && result.finalSnapshot.headObjectId === result.initialSnapshot.headObjectId, `changed refs=${refs.join(',')}`));
    assertions.push(outcomeAssertion('git-cand-ad763acaa2e6', result));
  }
  const goldenOutcome = result.verifierResult.outcome;
  return {
    suiteId: suite.suiteId,
    contractId: scenario.family === 'git-stage' ? 'git-stage-contract-v1' : 'git-branch-create-contract-v1',
    scenarioId: scenario.id,
    assertions,
    suitePassed: assertions.every((entry) => entry.passed),
    goldenOutcome,
    goldenPassed: goldenOutcome === scenario.goldenOutcome,
  };
}

function validateSourceBindings(
  review: GitCandidateReviewV1,
  candidatePackage: { minerVersion: string; computedBeforeHoldoutEvaluation: boolean; miningTraceIds: string[]; candidates: GitMinedCandidate[] },
  manifest: Record<string, any>,
  e1: string,
): void {
  if (manifest.runId !== review.authoritativeGateE1RunId || manifest.catalogueDigest !== review.catalogueDigest) throw new Error('review references another run or catalogue');
  if (manifest.minerVersion !== review.minerVersion || candidatePackage.minerVersion !== review.minerVersion) throw new Error('miner provenance differs');
  if (candidatePackage.computedBeforeHoldoutEvaluation !== true) throw new Error('candidate package was not fixed before holdout evaluation');
  for (const candidate of candidatePackage.candidates) {
    if (candidate.approvalStatus !== 'unapproved') throw new Error(`source candidate approval status differs: ${candidate.candidateId}`);
    for (const traceId of candidate.provenanceTraceIds) {
      if (!candidatePackage.miningTraceIds.includes(traceId) || !existsSync(join(e1, 'traces/mining', `${traceId}.json`))) {
        throw new Error(`candidate source came from holdout, smoke, adversarial, or unresolved evidence: ${candidate.candidateId}/${traceId}`);
      }
    }
  }
}

function contract(
  contractId: GitCompiledContractV1['contractId'],
  family: GitCompiledContractV1['family'],
  candidateIds: string[],
  permittedExamples: string[][],
  byId: Map<string, GitMinedCandidate>,
): GitCompiledContractV1 {
  const assertions = candidateIds.map((candidateId) => {
    const candidate = byId.get(candidateId);
    if (candidate === undefined) throw new Error(`approved candidate missing: ${candidateId}`);
    if (candidate.family !== family || candidate.assertionType === 'exhaustive_allowed_tool_path') throw new Error(`approved predicate differs or advisory path candidate included: ${candidateId}`);
    return {
      candidateId,
      assertionType: candidate.assertionType,
      generalizedPredicate: structuredClone(candidate.generalizedPredicate),
      distinctScenarioSupport: candidate.distinctScenarioSupport,
      trialSupport: candidate.trialSupport,
      provenanceTraceIds: [...candidate.provenanceTraceIds],
      scenarioIds: [...candidate.scenarioIds],
      evidenceDigest: candidate.evidenceDigest,
    };
  });
  const withoutDigest = {
    schema: 'git-contract-v1' as const,
    contractId,
    family,
    blocking: true as const,
    candidateIds: [...candidateIds],
    assertions,
    permitsNonExhaustiveToolPaths: true as const,
    permittedExamples,
  };
  return { ...withoutDigest, digest: hashJson(withoutDigest as unknown as Json) };
}

function outcomeAssertion(candidateId: string, result: GitScriptedScenarioResult): GitSuiteAssertionResult {
  const errors = result.execution.calls.filter((call) => call.outcomeClass !== 'tool_success' || call.isError !== false);
  const unexpected = result.verifierResult.state.unexpectedChangedLayers;
  return assertion(candidateId, errors.length === 0 && result.verifierResult.outcome === 'verified_success' && unexpected.length === 0, `errors=${errors.length}, outcome=${result.verifierResult.outcome}, unexpected=${unexpected.length}`);
}

function assertion(candidateId: string, passed: boolean, detail: string): GitSuiteAssertionResult {
  return { candidateId, passed, detail };
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && [...actual].sort().every((entry, index) => entry === [...expected].sort()[index]);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value as Json)).digest('hex');
}
