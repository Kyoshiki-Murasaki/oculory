import { hashJson } from '../../schema/canonical.js';
import type { Json, JsonObject } from '../../schema/types.js';
import type { ExternalRunStore } from '../../external/run-store.js';
import type { ExternalTraceV3 } from '../../external/schema-v3.js';

export const GIT_MINER_VERSION = 'git-miner-v1' as const;
export type GitCandidateRisk = 'low' | 'medium' | 'high';
export type GitCandidateRecommendation = 'recommend approval' | 'advisory only' | 'reject';

export interface GitLeaveOneOutResult {
  omittedScenarioId: string;
  distinctScenarioSupport: number;
  trialSupport: number;
  predicateSurvived: boolean;
  becameMoreSpecific: boolean;
}

export interface GitMinedCandidate {
  candidateId: string;
  assertionType: string;
  generalizedPredicate: JsonObject;
  family: string;
  distinctScenarioSupport: number;
  trialSupport: number;
  provenanceTraceIds: string[];
  scenarioIds: string[];
  risk: GitCandidateRisk;
  evidenceDigest: string;
  constantsRejected: string[];
  leaveOneOut: GitLeaveOneOutResult[];
  constantLeakagePassed: boolean;
  recommendation: GitCandidateRecommendation;
  rationale: string;
  approvalStatus: 'unapproved';
}

export interface GitMiningResult {
  minerVersion: typeof GIT_MINER_VERSION;
  computedBeforeHoldoutEvaluation: true;
  miningTraceIds: string[];
  miningScenarioIds: string[];
  excludedPartitions: string[];
  candidates: GitMinedCandidate[];
  digest: string;
}

export function compileGitApprovedSuite(
  candidates: readonly (Omit<GitMinedCandidate, 'approvalStatus'> & { approvalStatus: string })[],
): JsonObject {
  if (candidates.length === 0 || candidates.some((candidate) => candidate.approvalStatus !== 'approved')) {
    throw new Error('Git suite compilation requires explicit human approval for every candidate ID');
  }
  return {
    schema: 'git-approved-suite-v1',
    candidateIds: candidates.map((candidate) => candidate.candidateId).sort(),
  };
}

export class GitMiningLoader {
  constructor(private readonly store: ExternalRunStore) {}

  traceIds(): string[] {
    return this.store.listTraceIds('mining');
  }

  loadAll(): ExternalTraceV3[] {
    return this.traceIds().map((id) => this.store.loadTrace('mining', id)).map(requireEligibleMiningTrace);
  }

  open(traceId: string, declaredPartition: string): ExternalTraceV3 {
    if (declaredPartition !== 'mining') throw new Error(`mining loader rejects ${declaredPartition} trace ${traceId}`);
    if (!this.traceIds().includes(traceId)) throw new Error(`trace is not present in the isolated mining partition: ${traceId}`);
    return requireEligibleMiningTrace(this.store.loadTrace('mining', traceId));
  }
}

export function mineGitAssertions(traces: readonly ExternalTraceV3[]): GitMiningResult {
  const eligible = traces.map(requireEligibleMiningTrace);
  const families = new Map<string, ExternalTraceV3[]>();
  for (const trace of eligible) {
    const values = families.get(trace.scenarioFamilyId) ?? [];
    values.push(trace);
    families.set(trace.scenarioFamilyId, values);
  }
  const candidates = [
    ...mineStage(families.get('git-stage') ?? []),
    ...mineBranch(families.get('git-branch-create') ?? []),
  ].sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  const withoutDigest = {
    minerVersion: GIT_MINER_VERSION,
    computedBeforeHoldoutEvaluation: true as const,
    miningTraceIds: eligible.map((trace) => trace.traceId).sort(),
    miningScenarioIds: [...new Set(eligible.map((trace) => trace.scenarioId))].sort(),
    excludedPartitions: ['smoke', 'holdout', 'adversarial', 'failed', 'partial', 'unknown', 'unstable'],
    candidates,
  };
  return { ...withoutDigest, digest: hashJson(withoutDigest as unknown as Json) };
}

export function renderGitCandidateReview(result: GitMiningResult): string {
  const lines = [
    '# Git Gate E1 candidate review', '',
    `Miner: \`${result.minerVersion}\``,
    '',
    '**No candidate is approved. Human review is mandatory before Gate E2.**',
    '',
    '| Candidate | Type | Family | Predicate | Scenario support | Trial support | Risk | Leave-one-out | Leakage | Recommendation | Status |',
    '|---|---|---|---|---:|---:|---|---|---|---|---|',
  ];
  for (const candidate of result.candidates) {
    const loo = candidate.leaveOneOut.map((entry) => `${entry.omittedScenarioId}: ${entry.predicateSurvived ? 'survives' : 'missing'} (${entry.distinctScenarioSupport})`).join('<br>');
    lines.push(`| ${candidate.candidateId} | ${candidate.assertionType} | ${candidate.family} | \`${JSON.stringify(candidate.generalizedPredicate)}\` | ${candidate.distinctScenarioSupport} | ${candidate.trialSupport} | ${candidate.risk} | ${loo} | ${candidate.constantLeakagePassed ? 'passed' : 'FAILED'} | ${candidate.recommendation} | unapproved |`);
    lines.push(`|  |  |  | Rationale: ${candidate.rationale} |  |  |  |  |  |  |  |`);
  }
  lines.push('');
  return lines.join('\n');
}

function mineStage(traces: ExternalTraceV3[]): GitMinedCandidate[] {
  const facts = familyFacts(traces, 'git-stage');
  if (facts.scenarioIds.length < 3) return [];
  return materializeCandidates(facts, deriveStageDrafts);
}

function mineBranch(traces: ExternalTraceV3[]): GitMinedCandidate[] {
  const facts = familyFacts(traces, 'git-branch-create');
  if (facts.scenarioIds.length < 3) return [];
  return materializeCandidates(facts, deriveBranchDrafts);
}

interface CandidateDraft {
  assertionType: string;
  predicate: JsonObject;
  risk: GitCandidateRisk;
  recommendation: GitCandidateRecommendation;
  rationale: string;
}

function deriveStageDrafts(facts: FamilyFacts): CandidateDraft[] {
  if (facts.scenarioIds.length < 2) return [];
  assertFamilySemantics(facts, 'git_add', 'path', 'files');
  return [
    { assertionType: 'required_tool', predicate: { tool: 'git_add', requirement: 'required' }, risk: 'low', recommendation: 'recommend approval', rationale: 'Every distinct stage scenario required one git_add call.' },
    { assertionType: 'argument_entity_mapping', predicate: { tool: 'git_add', argument: 'files[0]', equals: '@entity:path' }, risk: 'medium', recommendation: 'recommend approval', rationale: 'Every add argument selected the scenario-declared path entity; literal filenames were rejected.' },
    { assertionType: 'selected_index_postcondition', predicate: { selector: '@entity:path', condition: 'index_blob_equals_worktree_blob', changed_index_path_cardinality: 1 }, risk: 'medium', recommendation: 'recommend approval', rationale: 'Independent journals show exactly the intended index entity changed.' },
    { assertionType: 'no_error_and_verified_outcome', predicate: { tool_error_count: 0, verifier_outcome: 'verified_success', unexpected_changed_layers: 0 }, risk: 'low', recommendation: 'recommend approval', rationale: 'All trials completed without errors and matched the independent Git verifier.' },
    { assertionType: 'exhaustive_allowed_tool_path', predicate: { allowed_paths: uniquePaths(facts.traces) as unknown as Json }, risk: 'high', recommendation: 'advisory only', rationale: 'The exact path set varies across the scenarios and may encode driver style rather than required semantics.' },
  ];
}

function deriveBranchDrafts(facts: FamilyFacts): CandidateDraft[] {
  if (facts.scenarioIds.length < 2) return [];
  assertFamilySemantics(facts, 'git_create_branch', 'branch', 'branch_name');
  return [
    { assertionType: 'required_tool', predicate: { tool: 'git_create_branch', requirement: 'required' }, risk: 'low', recommendation: 'recommend approval', rationale: 'Every distinct branch-create scenario required one git_create_branch call.' },
    { assertionType: 'argument_entity_mapping', predicate: { tool: 'git_create_branch', argument: 'branch_name', equals: '@entity:branch' }, risk: 'medium', recommendation: 'recommend approval', rationale: 'Every branch argument mapped to the scenario-declared branch entity; literal names were rejected.' },
    { assertionType: 'selected_ref_postcondition', predicate: { selector: 'refs/heads/@entity:branch', condition: 'created_at_initial_head', changed_ref_cardinality: 1, symbolic_head: 'unchanged' }, risk: 'medium', recommendation: 'recommend approval', rationale: 'Independent ref and HEAD evidence shows one intended ref creation without checkout.' },
    { assertionType: 'no_error_and_verified_outcome', predicate: { tool_error_count: 0, verifier_outcome: 'verified_success', unexpected_changed_layers: 0 }, risk: 'low', recommendation: 'recommend approval', rationale: 'All trials completed without errors and matched the independent Git verifier.' },
    { assertionType: 'exhaustive_allowed_tool_path', predicate: { allowed_paths: uniquePaths(facts.traces) as unknown as Json }, risk: 'high', recommendation: 'advisory only', rationale: 'Some scenarios list branches first and others create directly, so exact-path gating may overfit.' },
  ];
}

interface FamilyFacts {
  family: string;
  traces: ExternalTraceV3[];
  scenarioIds: string[];
  traceIds: string[];
}

function familyFacts(traces: ExternalTraceV3[], family: string): FamilyFacts {
  const sorted = [...traces].sort((a, b) => a.traceId.localeCompare(b.traceId));
  const scenarioIds = [...new Set(sorted.map((trace) => trace.scenarioId))].sort();
  for (const scenarioId of scenarioIds) {
    const trials = sorted.filter((trace) => trace.scenarioId === scenarioId);
    if (trials.length !== 3) throw new Error(`${family}/${scenarioId} must contribute exactly three trials`);
    if (new Set(trials.map((trace) => String((trace.verifierResult as JsonObject).outcome))).size !== 1) throw new Error(`${family}/${scenarioId} is unstable`);
  }
  return { family, traces: sorted, scenarioIds, traceIds: sorted.map((trace) => trace.traceId) };
}

function assertFamilySemantics(
  facts: FamilyFacts,
  requiredTool: string,
  entityKey: string,
  argumentKey: string,
): void {
  for (const trace of facts.traces) {
    const matchingCalls = trace.orderedCalls.filter((call) => call.tool === requiredTool);
    if (matchingCalls.length !== 1) throw new Error(`${trace.traceId} must contain exactly one ${requiredTool} call`);
    const entity = trace.intendedEntities[entityKey];
    const argument = matchingCalls[0]!.arguments[argumentKey];
    const selected = Array.isArray(argument) ? argument[0] : argument;
    if (typeof entity !== 'string' || selected !== entity) {
      throw new Error(`${trace.traceId} does not map ${requiredTool}.${argumentKey} to @entity:${entityKey}`);
    }
    const verifier = trace.verifierResult as JsonObject;
    const state = verifier.state;
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error(`${trace.traceId} has no verifier state evidence`);
    }
    const unexpected = (state as JsonObject).unexpectedChangedLayers;
    if (!Array.isArray(unexpected) || unexpected.length !== 0) {
      throw new Error(`${trace.traceId} has unexpected state changes`);
    }
    if (matchingCalls[0]!.classification !== 'tool_success' || matchingCalls[0]!.isError !== false) {
      throw new Error(`${trace.traceId} does not establish successful ${requiredTool} execution`);
    }
  }
}

function materializeCandidates(facts: FamilyFacts, derive: (facts: FamilyFacts) => CandidateDraft[]): GitMinedCandidate[] {
  return derive(facts).map((draft) => candidate(facts, draft, derive));
}

function candidate(facts: FamilyFacts, draft: CandidateDraft, derive: (facts: FamilyFacts) => CandidateDraft[]): GitMinedCandidate {
  const { assertionType, predicate, risk, recommendation, rationale } = draft;
  const candidateId = `git-cand-${hashJson({ family: facts.family, assertionType, predicate }).slice(0, 12)}`;
  const constantsRejected = [
    'absolute fixture and executable paths', 'temporary directory names', 'seed/ref/blob object IDs',
    'request IDs and process IDs', 'elapsed timings and reflog timestamps', 'incidental server prose and object addresses',
    'scenario-specific filenames and branch names in favor of intent entities',
  ];
  const serialized = JSON.stringify(predicate);
  const constantLeakagePassed = !/(\/private\/|\/Users\/|[0-9a-f]{40}|README\.md|notes\/plan|src\/app|feature\/parser|fix\/timeout|review\/cache-key)/.test(serialized);
  const leaveOneOut = facts.scenarioIds.map((omittedScenarioId) => {
    const subset = facts.traces.filter((trace) => trace.scenarioId !== omittedScenarioId);
    const subsetFacts = familyFacts(subset, facts.family);
    const reminted = derive(subsetFacts).find((entry) => entry.assertionType === assertionType);
    return {
      omittedScenarioId,
      distinctScenarioSupport: new Set(subset.map((trace) => trace.scenarioId)).size,
      trialSupport: subset.length,
      predicateSurvived: reminted !== undefined,
      becameMoreSpecific: reminted !== undefined && hashJson(reminted.predicate as unknown as Json) !== hashJson(predicate as unknown as Json),
    };
  });
  return {
    candidateId, assertionType, generalizedPredicate: predicate, family: facts.family,
    distinctScenarioSupport: facts.scenarioIds.length, trialSupport: facts.traces.length,
    provenanceTraceIds: facts.traceIds, scenarioIds: facts.scenarioIds, risk,
    evidenceDigest: hashJson({ traces: facts.traces, predicate } as unknown as Json),
    constantsRejected, leaveOneOut, constantLeakagePassed, recommendation,
    rationale, approvalStatus: 'unapproved',
  };
}

function uniquePaths(traces: ExternalTraceV3[]): string[][] {
  const values = traces.map((trace) => trace.orderedCalls.map((call) => call.tool));
  const byCanonicalPath = new Map(values.map((value) => [JSON.stringify(value), value]));
  return [...byCanonicalPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function requireEligibleMiningTrace(trace: ExternalTraceV3): ExternalTraceV3 {
  if (trace.partition !== 'mining') throw new Error(`Git miner refuses ${trace.partition} trace ${trace.traceId}`);
  const outcome = (trace.verifierResult as JsonObject).outcome;
  if (outcome !== 'verified_success') throw new Error(`Git miner refuses non-success trace ${trace.traceId}: ${String(outcome)}`);
  if (!trace.evidenceCompleteness.complete) throw new Error(`Git miner refuses incomplete trace ${trace.traceId}`);
  return trace;
}
