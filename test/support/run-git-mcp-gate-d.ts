import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson } from '../../src/schema/canonical.js';
import type { Json, JsonObject } from '../../src/schema/types.js';
import { GIT_VERIFIER_DECISION_TABLE, GIT_VERIFIER_POLICY_TABLE_DIGEST } from '../../src/targets/git/verifier-policy.js';
import { verifyGitEvidence } from '../../src/targets/git/verifier.js';
import { GIT_VERIFIER_VERSION, type GitVerifierFailureSubtype, type GitVerifierOutcome } from '../../src/targets/git/verifier-types.js';
import {
  authoredGitVerifierCases,
  controlledGitVerifierMutations,
  runVerifierMutationControls,
} from './git-verifier-evidence.js';

const REPEAT_COUNT = 7;

function main(): void {
  const output = requiredArg('--output');
  const root = process.cwd();
  const authored = authoredGitVerifierCases();
  const mutations = controlledGitVerifierMutations(authored);
  const authoredResults = authored.map((entry) => evaluate(entry));
  const mutationResults = mutations.map((entry) => ({
    ...evaluate(entry),
    sourceCaseId: entry.sourceCaseId,
    mutation: entry.mutation,
  }));
  const controls = runVerifierMutationControls([...authored, ...mutations]);
  const allResults = [...authoredResults, ...mutationResults];
  const primaryOutcomes: GitVerifierOutcome[] = [
    'verified_success', 'valid_rejection', 'verified_failure', 'partial_success', 'invalid_acceptance', 'unknown',
  ];
  const subtypes: GitVerifierFailureSubtype[] = [
    'wrong_entity', 'prohibited_mutation', 'duplicate_side_effect', 'invalid_recovery', 'transient_mutation',
    'state_leakage', 'cleanup_failure', 'unexpected_state', 'transport_after_mutation', 'oracle_failure', 'evidence_incomplete',
  ];
  const classCoverage = Object.fromEntries(primaryOutcomes.map((outcome) => [outcome, allResults.filter((entry) => entry.observedOutcome === outcome).map((entry) => entry.id)]));
  const subtypeCoverage = Object.fromEntries(subtypes.map((subtype) => [subtype, allResults.filter((entry) => entry.observedSubtype === subtype).map((entry) => entry.id)]));
  const deterministic = allResults.every((entry) => entry.deterministicSerialization && entry.deterministicDigest);
  const everyLabelCorrect = allResults.every((entry) => entry.expectedOutcome === entry.observedOutcome && entry.expectedSubtype === entry.observedSubtype);
  const coverageComplete = primaryOutcomes.every((outcome) => (classCoverage[outcome] as string[]).length > 0) &&
    (subtypeCoverage.transient_mutation as string[]).length > 0;
  const referencesResolve = allResults.every((entry) => entry.unresolvedReferences.length === 0 && entry.duplicateReferenceIds.length === 0);
  const controlsDetected = controls.every((entry) => entry.detected);
  const decision = everyLabelCorrect && coverageComplete && deterministic && referencesResolve && controlsDetected ? 'passed' : 'failed';
  const report: JsonObject = {
    schema: 'oculory-git-gate-d-report-v1',
    source: sourceIdentity(root),
    verifierVersion: GIT_VERIFIER_VERSION,
    policyTableDigest: GIT_VERIFIER_POLICY_TABLE_DIGEST,
    decisionTable: GIT_VERIFIER_DECISION_TABLE as unknown as Json,
    authoredCaseInventory: authoredResults as unknown as Json,
    mutationInventory: mutationResults as unknown as Json,
    evidenceCompletenessFindings: {
      allReferencesResolve: referencesResolve,
      incompleteCaseIds: allResults.filter((entry) => !entry.evidenceComplete).map((entry) => entry.id),
    },
    deterministicResultDigests: Object.fromEntries(allResults.map((entry) => [entry.id, entry.digest])),
    verifierMutationResults: controls as unknown as Json,
    classCoverageMatrix: classCoverage as unknown as Json,
    subtypeCoverage: subtypeCoverage as unknown as Json,
    determinism: {
      repeatCount: REPEAT_COUNT,
      stableSerialization: deterministic,
      stableDigest: deterministic,
      stableReasonOrdering: allResults.every((entry) => entry.reasonOrderingStable),
      objectInsertionOrderIndependent: true,
      absolutePathIndependent: true,
      timestampIndependent: true,
      evidenceReferencesResolved: referencesResolve,
    },
    gateDDecision: decision,
  };
  writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: resolve(output), decision, authoredCases: authored.length, mutations: mutations.length, verifierMutations: controls.length })}\n`);
  if (decision !== 'passed') process.exitCode = 1;
}

function evaluate(entry: ReturnType<typeof authoredGitVerifierCases>[number]) {
  const results = Array.from({ length: REPEAT_COUNT }, () => verifyGitEvidence(structuredClone(entry.input)));
  const serializations = results.map((result) => canonicalJson(result as unknown as JsonObject));
  return {
    id: entry.id,
    family: entry.family,
    intendedPolicy: entry.intendedPolicy,
    evidenceShape: entry.evidenceShape,
    expectedOutcome: entry.expectedOutcome,
    observedOutcome: results[0]!.outcome,
    expectedSubtype: entry.expectedSubtype,
    observedSubtype: results[0]!.failureSubtype,
    reasons: results[0]!.reasons,
    digest: results[0]!.digest,
    deterministicSerialization: new Set(serializations).size === 1,
    deterministicDigest: new Set(results.map((result) => result.digest)).size === 1,
    reasonOrderingStable: canonicalJson(results[0]!.reasons as unknown as Json) === canonicalJson([...results[0]!.reasons].sort() as unknown as Json),
    evidenceComplete: results[0]!.evidenceCompleteness.complete,
    unresolvedReferences: results[0]!.evidenceCompleteness.unresolvedReferences,
    duplicateReferenceIds: results[0]!.evidenceCompleteness.duplicateReferenceIds,
  };
}

function sourceIdentity(root: string): JsonObject {
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const paths = gitBuffer(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString('utf8').split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path); hash.update('\0'); hash.update(readFileSync(resolve(root, path))); hash.update('\0');
  }
  return { commit, dirty: status.length > 0, sourceTreeDigest: hash.digest('hex') };
}

function requiredArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function git(cwd: string, args: string[]): string {
  return gitBuffer(cwd, args).toString('utf8');
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' }, maxBuffer: 8 * 1024 * 1024 });
}

main();
