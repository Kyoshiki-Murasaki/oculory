import type {
  CandidateRiskProfile,
  CandidateTest,
  DatasetPartition,
  NormalizedTrace,
} from '../schema/types.js';
import type { RecordingInstabilityResult } from './instability.js';

/**
 * Candidate risk annotation for isolated model runs (Phase 3.4/3.5).
 *
 * The scripted miner (src/pipeline/mine.ts) is unchanged. This is a SEPARATE
 * post-mining pass that only the model-run / `--run-dir mine` path calls: it
 * walks each candidate's backing traces and records where they came from
 * (policy, partition, model vs scripted, stability) so `review` can explain
 * the provenance and `approve` can refuse to auto-approve anything unsafe.
 */

const RECOMMENDED_SUPPORT = 3;

function cleanOutcome(label: string): boolean {
  return label === 'verified_success' || label === 'valid_rejection';
}

export function annotateCandidate(
  candidate: CandidateTest,
  byTrace: Map<string, NormalizedTrace>,
  familyTraces: NormalizedTrace[],
  unstableScenarioIds: Set<string>,
): CandidateRiskProfile {
  const traceIds = new Set(candidate.assertions.flatMap((a) => a.provenance.trace_ids));
  const traces = [...traceIds].map((id) => byTrace.get(id)).filter((t): t is NormalizedTrace => t !== undefined);

  const sourcePolicies = [...new Set(traces.map((t) => t.agent.id))].sort();
  const modelCount = traces.filter((t) => t.agent.kind === 'model').length;
  const scriptedCount = traces.filter((t) => t.agent.kind === 'scripted').length;
  const mixed = modelCount > 0 && scriptedCount > 0;
  const partitions = [...new Set(traces.map((t) => t.partition))].sort() as DatasetPartition[];
  const smokeOnly = partitions.length > 0 && partitions.every((p) => p === 'smoke');
  const adversarialOnly = partitions.length > 0 && partitions.every((p) => p === 'adversarial');
  const fromUnstable = candidate.scenario_ids.some((s) => unstableScenarioIds.has(s));
  const support = traces.length;
  const minSupportMet = support >= RECOMMENDED_SUPPORT;
  const unknownNearby = familyTraces.some((t) => !cleanOutcome(t.outcome.label));
  const constantArgs = candidate.risk_notes.some((r) => /constant/i.test(r));
  const altPaths =
    candidate.risk_notes.some((r) => /alternative/i.test(r)) ||
    candidate.assertions.some((a) => a.type === 'one_of_tools');

  const flags: string[] = [];
  if (smokeOnly)
    flags.push('mined from SMOKE traffic only — smoke is a plumbing check, not behavioural ground truth; do not use as a regression gate');
  if (adversarialOnly)
    flags.push('mined from ADVERSARIAL traffic only — error/rejection expectations need careful human review');
  if (mixed)
    flags.push('mined from MIXED scripted + model traces — confirm the assertion holds for the real model, not just the scripted stand-in');
  if (fromUnstable)
    flags.push('one or more source scenarios were recording-time UNSTABLE across trials — traces are not reliable ground truth');
  if (!minSupportMet) flags.push(`backed by only ${support} trace(s) — below the recommended ≥${RECOMMENDED_SUPPORT} corroborating traces`);
  if (unknownNearby)
    flags.push('UNKNOWN / non-verified outcomes are present in this scenario family — outcome labelling may be unreliable here');
  for (const note of candidate.risk_notes) if (/constant/i.test(note)) flags.push(note);
  if (altPaths) flags.push('alternative tool paths observed — assertion is a one-of; confirm every path is genuinely acceptable');

  const risky = mixed || adversarialOnly || !minSupportMet || unknownNearby || constantArgs || altPaths;
  const advisoryOnly = smokeOnly || fromUnstable || risky;

  return {
    source_policies: sourcePolicies,
    model_trace_count: modelCount,
    scripted_trace_count: scriptedCount,
    mixed_sources: mixed,
    partitions,
    smoke_only: smokeOnly,
    adversarial_only: adversarialOnly,
    from_unstable_scenario: fromUnstable,
    min_support: support,
    min_support_met: minSupportMet,
    unknown_outcomes_nearby: unknownNearby,
    constant_args: constantArgs,
    alternative_tool_paths: altPaths,
    risky,
    safe_to_approve: !advisoryOnly,
    advisory_only: advisoryOnly,
    risk_flags: flags,
  };
}

/**
 * Attach a risk_profile to every candidate. `normalized` is the full set of
 * normalized traces in the run (used for provenance lookup and family-level
 * "unknown outcomes nearby" checks).
 */
export function annotateCandidates(
  candidates: CandidateTest[],
  normalized: NormalizedTrace[],
  instability: RecordingInstabilityResult[],
): CandidateTest[] {
  const byTrace = new Map(normalized.map((t) => [t.trace_id, t]));
  const unstable = new Set(instability.filter((g) => g.unstable).map((g) => g.scenario_id));
  return candidates.map((c) => {
    const familyTraces = normalized.filter((t) => t.scenario_family === c.scenario_family);
    return { ...c, risk_profile: annotateCandidate(c, byTrace, familyTraces, unstable) };
  });
}

export function renderReviewMarkdown(candidates: CandidateTest[], heading = 'Candidate review'): string {
  const lines: string[] = [`# ${heading}`, ''];
  if (candidates.length === 0) {
    lines.push('_No candidates were mined from this run._');
    lines.push('');
    return lines.join('\n');
  }
  lines.push(`${candidates.length} candidate(s). **None are auto-approved** — approval is always a human step (docs/08).`);
  lines.push('');
  for (const c of candidates) {
    const rp = c.risk_profile;
    const stable = c.assertions.filter((a) => a.stable);
    lines.push(`## ${c.candidate_id} — family \`${c.scenario_family}\``);
    lines.push('');
    lines.push(`- status: **${c.status}** · recommended gate: ${c.recommended_gate}`);
    lines.push(`- scenarios: ${c.scenario_ids.join(', ')}`);
    if (rp) {
      lines.push(`- source policies: ${rp.source_policies.join(', ') || '—'}`);
      lines.push(`- traces: ${rp.model_trace_count} model · ${rp.scripted_trace_count} scripted (support ${rp.min_support})`);
      lines.push(`- partitions: ${rp.partitions.join(', ') || '—'}`);
      lines.push(
        `- safe to approve as a gate: **${rp.safe_to_approve ? 'yes' : 'NO — advisory only'}**` +
          (rp.mixed_sources ? ' · MIXED sources' : ''),
      );
    }
    lines.push(`- stable assertions (${stable.length}):`);
    for (const a of stable) lines.push(`  - \`${a.type}\` ${JSON.stringify(a.params)} — support ${a.support}/${a.total}`);
    const warnings = rp?.risk_flags ?? c.risk_notes;
    if (warnings.length > 0) {
      lines.push('- ⚠️ warnings:');
      for (const w of warnings) lines.push(`  - ${w}`);
    }
    if (rp) {
      const needs: string[] = [];
      if (rp.smoke_only) needs.push('--allow-smoke');
      if (rp.from_unstable_scenario) needs.push('--allow-unstable');
      if (rp.risky) needs.push('--allow-risky');
      lines.push(
        needs.length > 0
          ? `- to bulk-approve this candidate you must pass: ${needs.join(' ')} (or approve it by id after review)`
          : '- eligible for `approve --all-stable` (still requires you to run it deliberately)',
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
