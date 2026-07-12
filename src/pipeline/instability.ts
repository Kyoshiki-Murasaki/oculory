import type { OutcomeLabel } from '../schema/types.js';

/**
 * Recording-time instability (Phase 2).
 *
 * Question: does the SAME scenario+policy produce different tool sequences
 * or different verified outcomes across repeated recordings (`--trials N`,
 * meaningful only for a model policy — scripted policies are deterministic
 * and will always agree with themselves)?
 *
 * This is a DIFFERENT concept from replay-time instability
 * (`TestRunResult.unstable` / `SuiteRunResult.totals.unstable` in
 * src/schema/types.ts, produced by `replaySuite` in src/pipeline/run.ts):
 *
 *   - Recording-time instability (this file): the agent itself behaves
 *     differently while traffic is being GENERATED, before mining or an
 *     approved suite are even involved. Detected by recording the same
 *     scenario+policy N times and diffing the raw traces.
 *   - Replay-time instability (existing, currently a hardcoded `false` in
 *     replaySuite — see the comment there): an ALREADY-APPROVED suite
 *     disagreeing across trials during regression REPLAY, i.e. whether a
 *     mined assertion's pass/fail flips from run to run against a live
 *     server. Not implemented yet; still future work, not addressed here.
 *
 * Do not conflate the two: a recording-time-unstable scenario should not be
 * mined from at all (its traces are not reliable ground truth), whereas
 * replay-time instability is about an already-trusted suite's evaluation
 * variance. See docs/04 "Two kinds of instability".
 */
export interface RecordingInstabilityResult {
  scenario_id: string;
  policy_id: string;
  trial_count: number;
  tool_sequences: string[][];
  outcome_labels: OutcomeLabel[];
  unstable: boolean;
  detail: string;
}

/**
 * Structural (not RawTrace-typed) on purpose: callers only need `.steps[].tool`
 * and outcome `.label`, so tests can pass minimal fixtures without
 * constructing a fully-valid RawTrace/OutcomeRecord.
 */
export function assessRecordingInstability(
  scenarioId: string,
  policyId: string,
  traces: { steps: { tool: string }[] }[],
  outcomes: { label: OutcomeLabel }[],
): RecordingInstabilityResult {
  if (traces.length !== outcomes.length) {
    throw new Error('assessRecordingInstability: traces and outcomes must be the same length (one outcome per trial)');
  }
  const tool_sequences = traces.map((t) => t.steps.map((s) => s.tool));
  const outcome_labels = outcomes.map((o) => o.label);

  const firstSeqKey = JSON.stringify(tool_sequences[0] ?? []);
  const sequencesAgree = tool_sequences.every((seq) => JSON.stringify(seq) === firstSeqKey);

  const firstLabel = outcome_labels[0] ?? null;
  const labelsAgree = outcome_labels.every((l) => l === firstLabel);

  const unstable = !sequencesAgree || !labelsAgree;
  const detail = unstable
    ? `disagreement across ${traces.length} trials — tool sequences ${sequencesAgree ? 'agree' : 'DIFFER'}, outcome labels ${
        labelsAgree ? 'agree' : `DIFFER (${[...new Set(outcome_labels)].join(', ')})`
      }`
    : `${traces.length} trials agree: identical tool sequence, outcome always '${String(firstLabel)}'`;

  return { scenario_id: scenarioId, policy_id: policyId, trial_count: traces.length, tool_sequences, outcome_labels, unstable, detail };
}
