import { SCENARIOS, scenariosByPartition } from '../runner/catalogue.js';
import {
  BudgetExceededError,
  ModelPolicy,
  ModelPolicyError,
  type ModelClient,
} from '../runner/model-policy.js';
import { recordSession, type FixtureFile } from '../runner/record.js';
import type {
  CandidateTest,
  DatasetPartition,
  OutcomeLabel,
  OutcomeRecord,
  RawTrace,
  Scenario,
} from '../schema/types.js';
import type { ApprovedSuite } from '../schema/types.js';
import { assessRecordingInstability, type RecordingInstabilityResult } from './instability.js';
import { mineAll } from './mine.js';
import { annotateCandidates, renderReviewMarkdown } from './candidate-risk.js';
import { evaluateAssertion, evaluateGoldenOutcome } from './evaluate.js';
import { verifyAndNormalizeAll } from './experiment.js';
import type { RunStore } from './run-store.js';

/**
 * The core of the isolated model commands (Phase 3.2/3.3/3.6).
 *
 * These functions take a `ModelClient` as an injected dependency and NEVER
 * construct an `OpenAiClient` themselves — tests inject a stub, so no test
 * touches the network (constraint 3). The CLI passes a real `OpenAiClient`.
 * Nothing here auto-approves candidates.
 */

export type PartitionSelector = DatasetPartition | 'all';

export interface ModelRunDeps {
  client: ModelClient;
  fixture: FixtureFile;
}

/** A recording that failed — kept so the summary can recommend a fix instead of hiding it. */
export interface RecordingError {
  scenario_id: string;
  trial: number;
  kind: 'malformed_tool_call' | 'budget_exceeded' | 'provider_error';
  message: string;
}

interface RecordingOutcome {
  traces: RawTrace[];
  errors: RecordingError[];
  /** True when recording stopped early (budget or provider failure). */
  stopped: boolean;
}

const MODEL_UNAVAILABLE = /model[_ ]?not[_ ]?found|does not exist|no such model|invalid model|unknown model|HTTP 404|HTTP 400/i;

async function recordScenarios(
  store: RunStore,
  policy: ModelPolicy,
  opts: {
    scenarios: Scenario[];
    fixture: FixtureFile;
    trials: number;
    budgetUsd: number;
    mutationId: string | null;
    model: string;
  },
): Promise<RecordingOutcome> {
  const traces: RawTrace[] = [];
  const errors: RecordingError[] = [];
  let stopped = false;

  outer: for (const scenario of opts.scenarios) {
    for (let trial = 0; trial < opts.trials; trial++) {
      try {
        const raw = await recordSession({
          scenario,
          policy,
          fixture: opts.fixture,
          mutationId: opts.mutationId,
          trial: opts.trials > 1 ? trial : null,
          budgetUsd: opts.budgetUsd,
        });
        store.appendRawTrace(raw);
        traces.push(raw);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          errors.push({ scenario_id: scenario.scenario_id, trial, kind: 'budget_exceeded', message: err.message });
          stopped = true;
          break outer;
        }
        if (err instanceof ModelPolicyError) {
          // Malformed tool call / unknown tool: the model misbehaved on ONE
          // scenario. Record it and keep going to gather more evidence.
          errors.push({ scenario_id: scenario.scenario_id, trial, kind: 'malformed_tool_call', message: err.message });
          continue;
        }
        // Provider / HTTP error. If it happens before ANY trace is recorded and
        // looks like an unavailable model, fail fast with actionable guidance.
        const message = err instanceof Error ? err.message : String(err);
        if (traces.length === 0 && MODEL_UNAVAILABLE.test(message)) {
          throw new Error(
            `provider call failed for model '${opts.model}': ${message}. ` +
              `If the model name is wrong or unavailable to your key, pass a valid --model.`,
          );
        }
        errors.push({ scenario_id: scenario.scenario_id, trial, kind: 'provider_error', message });
        stopped = true;
        break outer;
      }
    }
  }
  return { traces, errors, stopped };
}

function assessGroups(store: RunStore, scenarios: Scenario[], policyId: string): RecordingInstabilityResult[] {
  const raws = store.loadRawTraces();
  const outcomeByTrace = new Map(store.loadOutcomes().map((o) => [o.trace_id, o]));
  const results: RecordingInstabilityResult[] = [];
  for (const scenario of scenarios) {
    const group = raws.filter((t) => t.scenario_id === scenario.scenario_id);
    if (group.length < 2) continue; // instability is only meaningful across ≥2 trials
    const outcomes = group.map(
      (t) => outcomeByTrace.get(t.trace_id) ?? ({ label: 'unknown' as OutcomeLabel } as OutcomeRecord),
    );
    results.push(assessRecordingInstability(scenario.scenario_id, policyId, group, outcomes));
  }
  return results;
}

function mineIsolated(store: RunStore, instability: RecordingInstabilityResult[]): CandidateTest[] {
  // Never mine holdout (leakage isolation). Smoke IS allowed here but is
  // flagged smoke_only by the risk annotator so it can never be auto-approved.
  const eligible = store.loadNormalizedTraces().filter((t) => t.partition !== 'holdout');
  const raw = mineAll(eligible);
  return annotateCandidates(raw, eligible, instability);
}

function riskyCount(candidates: CandidateTest[]): number {
  return candidates.filter((c) => c.risk_profile && !c.risk_profile.safe_to_approve).length;
}

function outcomeCounts(store: RunStore): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of store.loadOutcomes()) counts[o.label] = (counts[o.label] ?? 0) + 1;
  return counts;
}

/* ============================== model-smoke ============================== */

export interface SmokeSignals {
  traceCount: number;
  verified: number;
  /** unknown + partial_success + invalid_acceptance (the verifier struggled). */
  nonClean: number;
  unstableGroups: number;
  providerBroken: boolean;
  budgetHit: boolean;
}

/** Pure, conservative recommendation for a smoke run (unit-tested in isolation). */
export function recommendSmoke(s: SmokeSignals): {
  step: ModelSmokeSummary['recommended_next_step'];
  reasons: string[];
} {
  const reasons: string[] = [];
  let step: ModelSmokeSummary['recommended_next_step'];
  if (s.traceCount === 0) {
    step = 'stop_model_validation';
    reasons.push('no traces were recorded — the provider or model is unusable for this run');
  } else if (s.providerBroken) {
    step = 'fix_provider_adapter';
    reasons.push('the model produced malformed tool calls or the provider errored — fix the adapter before scaling');
  } else if (s.unstableGroups > 0) {
    step = 'inspect_traces';
    reasons.push(`${s.unstableGroups} smoke scenario group(s) were unstable across trials — inspect before trusting outcomes`);
  } else if (s.nonClean > 0) {
    step = 'inspect_traces';
    reasons.push(`${s.nonClean} trace(s) did not verify cleanly (unknown/partial/invalid) — inspect the outcome verifier`);
  } else if (s.verified === s.traceCount) {
    step = 'run_larger_model_experiment';
    reasons.push('all smoke traces verified cleanly and stably — safe to try a larger model-experiment');
  } else {
    step = 'inspect_traces';
    reasons.push('smoke completed but not every trace verified as success — inspect before scaling');
  }
  if (s.budgetHit) {
    reasons.push('budget cap was hit mid-run (fail-closed) — raise --budget-usd or reduce --trials for full coverage');
  }
  return { step, reasons };
}

export interface ModelSmokeOptions {
  runId: string;
  model: string;
  trials: number;
  budgetUsd: number;
  mine: boolean;
  mutationId?: string | null;
}

export interface ModelSmokeSummary {
  run_id: string;
  provider: string;
  model: string;
  trials: number;
  budget_usd: number;
  spent_usd: number;
  trace_count: number;
  outcome_counts: Record<string, number>;
  instability: {
    groups: number;
    unstable_groups: number;
    unstable_scenario_ids: string[];
  };
  candidate_count: number;
  risky_candidate_count: number;
  recording_errors: RecordingError[];
  recommended_next_step:
    | 'inspect_traces'
    | 'fix_provider_adapter'
    | 'run_larger_model_experiment'
    | 'stop_model_validation';
  reasons: string[];
}

export async function runModelSmoke(
  store: RunStore,
  opts: ModelSmokeOptions,
  deps: ModelRunDeps,
): Promise<ModelSmokeSummary> {
  const scenarios = scenariosByPartition('smoke');
  const policy = new ModelPolicy({ client: deps.client, model: opts.model, budgetUsd: opts.budgetUsd });

  const recording = await recordScenarios(store, policy, {
    scenarios,
    fixture: deps.fixture,
    trials: opts.trials,
    budgetUsd: opts.budgetUsd,
    mutationId: opts.mutationId ?? null,
    model: opts.model,
  });

  verifyAndNormalizeAll(store);
  const instability = assessGroups(store, scenarios, policy.id);
  store.saveInstability(instability);

  const candidates = opts.mine ? mineIsolated(store, instability) : [];
  if (opts.mine) store.saveCandidates(candidates);

  const counts = outcomeCounts(store);
  const unstable = instability.filter((g) => g.unstable);
  const traceCount = recording.traces.length;
  const { step, reasons } = recommendSmoke({
    traceCount,
    verified: counts.verified_success ?? 0,
    nonClean: (counts.unknown ?? 0) + (counts.partial_success ?? 0) + (counts.invalid_acceptance ?? 0),
    unstableGroups: unstable.length,
    providerBroken: recording.errors.some((e) => e.kind === 'provider_error' || e.kind === 'malformed_tool_call'),
    budgetHit: recording.errors.some((e) => e.kind === 'budget_exceeded'),
  });

  const summary: ModelSmokeSummary = {
    run_id: opts.runId,
    provider: deps.client.provider,
    model: opts.model,
    trials: opts.trials,
    budget_usd: opts.budgetUsd,
    spent_usd: Math.round(policy.spentSoFarUsd() * 1e6) / 1e6,
    trace_count: traceCount,
    outcome_counts: counts,
    instability: {
      groups: instability.length,
      unstable_groups: unstable.length,
      unstable_scenario_ids: unstable.map((g) => g.scenario_id),
    },
    candidate_count: candidates.length,
    risky_candidate_count: riskyCount(candidates),
    recording_errors: recording.errors,
    recommended_next_step: step,
    reasons,
  };
  store.saveJsonReport('model-smoke-summary.json', summary as never);
  store.saveReport('model-smoke-summary.md', renderSmokeMarkdown(summary));
  return summary;
}

export function renderSmokeMarkdown(s: ModelSmokeSummary): string {
  const lines: string[] = [];
  lines.push('# Model smoke summary');
  lines.push('');
  lines.push(`- run: \`${s.run_id}\``);
  lines.push(`- provider/model: ${s.provider} / ${s.model}`);
  lines.push(`- trials: ${s.trials} · budget: $${s.budget_usd} · spent: ~$${s.spent_usd.toFixed(4)}`);
  lines.push(`- traces: ${s.trace_count}`);
  lines.push('');
  lines.push('## Outcomes');
  for (const [label, n] of Object.entries(s.outcome_counts)) lines.push(`- ${label}: ${n}`);
  if (Object.keys(s.outcome_counts).length === 0) lines.push('- (none)');
  lines.push('');
  lines.push(`## Recording-time instability: ${s.instability.unstable_groups}/${s.instability.groups} groups unstable`);
  if (s.instability.unstable_scenario_ids.length > 0)
    lines.push(`- unstable scenarios: ${s.instability.unstable_scenario_ids.join(', ')}`);
  lines.push('');
  lines.push(`## Candidates: ${s.candidate_count} mined (${s.risky_candidate_count} risky / advisory-only)`);
  lines.push('**None are approved.** Smoke candidates are never a regression gate — review manually (docs/24).');
  lines.push('');
  if (s.recording_errors.length > 0) {
    lines.push('## Recording errors');
    for (const e of s.recording_errors) lines.push(`- [${e.kind}] ${e.scenario_id} trial ${e.trial}: ${e.message}`);
    lines.push('');
  }
  lines.push(`## Recommendation: \`${s.recommended_next_step}\``);
  for (const r of s.reasons) lines.push(`- ${r}`);
  lines.push('');
  return lines.join('\n');
}

/* ============================ model-experiment =========================== */

export interface ModelExperimentOptions {
  runId: string;
  model: string;
  trials: number;
  budgetUsd: number;
  partition: PartitionSelector;
  maxScenarios: number | null;
  mine: boolean;
  review: boolean;
  mutationId?: string | null;
}

export type ModelExperimentRecommendation =
  | 'fix_provider_adapter'
  | 'improve_outcome_verifier'
  | 'inspect_instability_before_mining'
  | 'inspect_candidates_then_try_replay'
  | 'rerun_with_more_trials'
  | 'stop_model_validation';

export interface ExperimentSignals {
  traceCount: number;
  verifiedClean: number;
  nonClean: number;
  unstableGroups: number;
  candidateCount: number;
  providerBroken: boolean;
  budgetHit: boolean;
}

/** Pure, conservative recommendation for an experiment run (unit-tested in isolation). */
export function recommendExperiment(s: ExperimentSignals): {
  recommendation: ModelExperimentRecommendation;
  reasons: string[];
} {
  const reasons: string[] = [];
  let recommendation: ModelExperimentRecommendation;
  if (s.traceCount === 0) {
    recommendation = 'stop_model_validation';
    reasons.push('no traces recorded — provider/model unusable for this run');
  } else if (s.providerBroken) {
    recommendation = 'fix_provider_adapter';
    reasons.push('malformed tool calls or provider errors occurred — fix the adapter before drawing conclusions');
  } else if (s.nonClean / s.traceCount > 0.2) {
    recommendation = 'improve_outcome_verifier';
    reasons.push(`${s.nonClean}/${s.traceCount} traces did not verify cleanly (>20%) — the outcome verifier or scenarios need work`);
  } else if (s.unstableGroups > 0) {
    recommendation = 'inspect_instability_before_mining';
    reasons.push(`${s.unstableGroups} scenario group(s) were unstable across trials — do not trust mined candidates yet`);
  } else if (s.candidateCount > 0 && s.verifiedClean >= s.traceCount * 0.8) {
    recommendation = 'inspect_candidates_then_try_replay';
    reasons.push('low instability and mostly-verified outcomes — inspect candidates, then try a model-replay of an approved suite');
  } else {
    recommendation = 'rerun_with_more_trials';
    reasons.push('inconclusive — rerun with more trials or a different partition before deciding');
  }
  if (s.budgetHit) {
    reasons.push('budget cap hit mid-run (fail-closed) — coverage is partial; raise --budget-usd or reduce scope');
  }
  reasons.push('one run is never enough to validate model traffic — this is a single controlled probe, not production evidence');
  return { recommendation, reasons };
}

export interface ModelExperimentSummary {
  run_id: string;
  provider: string;
  model: string;
  partition: PartitionSelector;
  scenario_count: number;
  trials: number;
  trace_count: number;
  spent_usd: number;
  budget_usd: number;
  outcome_counts: Record<string, number>;
  unknown_count: number;
  verified_success_count: number;
  verified_failure_count: number;
  valid_rejection_count: number;
  unstable_scenario_count: number;
  candidate_count: number;
  risky_candidate_count: number;
  top_failure_reasons: { reason: string; count: number }[];
  top_unstable_scenarios: string[];
  recording_errors: RecordingError[];
  recommendation: ModelExperimentRecommendation;
  reasons: string[];
}

export function selectScenarios(partition: PartitionSelector, maxScenarios: number | null): Scenario[] {
  const selected = partition === 'all' ? SCENARIOS : scenariosByPartition(partition);
  return maxScenarios !== null ? selected.slice(0, maxScenarios) : selected;
}

export async function runModelExperiment(
  store: RunStore,
  opts: ModelExperimentOptions,
  deps: ModelRunDeps,
): Promise<ModelExperimentSummary> {
  const scenarios = selectScenarios(opts.partition, opts.maxScenarios);
  const policy = new ModelPolicy({ client: deps.client, model: opts.model, budgetUsd: opts.budgetUsd });

  const recording = await recordScenarios(store, policy, {
    scenarios,
    fixture: deps.fixture,
    trials: opts.trials,
    budgetUsd: opts.budgetUsd,
    mutationId: opts.mutationId ?? null,
    model: opts.model,
  });

  verifyAndNormalizeAll(store);
  const instability = assessGroups(store, scenarios, policy.id);
  store.saveInstability(instability);

  const candidates = opts.mine ? mineIsolated(store, instability) : [];
  if (opts.mine) store.saveCandidates(candidates);
  if (opts.review) {
    store.saveReport('review.md', renderReviewMarkdown(candidates, `Model experiment review — ${opts.runId}`));
  }

  const counts = outcomeCounts(store);
  const unstable = instability.filter((g) => g.unstable);
  const traceCount = recording.traces.length;
  const unknown = counts.unknown ?? 0;
  const verifiedSuccess = counts.verified_success ?? 0;
  const verifiedFailure = counts.verified_failure ?? 0;
  const validRejection = counts.valid_rejection ?? 0;
  const nonClean = unknown + (counts.partial_success ?? 0) + (counts.invalid_acceptance ?? 0);
  const providerBroken = recording.errors.some((e) => e.kind === 'provider_error' || e.kind === 'malformed_tool_call');

  // Top failure reasons: failing golden checks across verified_failure / non-clean traces.
  const failureReasons = new Map<string, number>();
  for (const o of store.loadOutcomes()) {
    if (o.label === 'verified_success' || o.label === 'valid_rejection') continue;
    for (const e of o.evidence) if (!e.passed) failureReasons.set(e.check, (failureReasons.get(e.check) ?? 0) + 1);
  }
  const topFailureReasons = [...failureReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  const { recommendation, reasons } = recommendExperiment({
    traceCount,
    verifiedClean: verifiedSuccess + validRejection,
    nonClean,
    unstableGroups: unstable.length,
    candidateCount: candidates.length,
    providerBroken,
    budgetHit: recording.errors.some((e) => e.kind === 'budget_exceeded'),
  });

  const summary: ModelExperimentSummary = {
    run_id: opts.runId,
    provider: deps.client.provider,
    model: opts.model,
    partition: opts.partition,
    scenario_count: scenarios.length,
    trials: opts.trials,
    trace_count: traceCount,
    spent_usd: Math.round(policy.spentSoFarUsd() * 1e6) / 1e6,
    budget_usd: opts.budgetUsd,
    outcome_counts: counts,
    unknown_count: unknown,
    verified_success_count: verifiedSuccess,
    verified_failure_count: verifiedFailure,
    valid_rejection_count: validRejection,
    unstable_scenario_count: unstable.length,
    candidate_count: candidates.length,
    risky_candidate_count: riskyCount(candidates),
    top_failure_reasons: topFailureReasons,
    top_unstable_scenarios: unstable.map((g) => g.scenario_id),
    recording_errors: recording.errors,
    recommendation,
    reasons,
  };
  store.saveJsonReport('model-experiment-summary.json', summary as never);
  store.saveReport('model-experiment-summary.md', renderExperimentMarkdown(summary));
  return summary;
}

export function renderExperimentMarkdown(s: ModelExperimentSummary): string {
  const lines: string[] = [];
  lines.push('# Model experiment summary');
  lines.push('');
  lines.push(`- run: \`${s.run_id}\``);
  lines.push(`- provider/model: ${s.provider} / ${s.model}`);
  lines.push(`- partition: ${s.partition} · scenarios: ${s.scenario_count} · trials: ${s.trials}`);
  lines.push(`- traces: ${s.trace_count} · spent: ~$${s.spent_usd.toFixed(4)} of $${s.budget_usd}`);
  lines.push('');
  lines.push('## Outcomes');
  lines.push(
    `- verified_success ${s.verified_success_count} · valid_rejection ${s.valid_rejection_count} · ` +
      `verified_failure ${s.verified_failure_count} · unknown ${s.unknown_count}`,
  );
  lines.push('');
  lines.push(`## Instability: ${s.unstable_scenario_count} unstable scenario group(s)`);
  if (s.top_unstable_scenarios.length > 0) lines.push(`- ${s.top_unstable_scenarios.join(', ')}`);
  lines.push('');
  lines.push(`## Candidates: ${s.candidate_count} mined (${s.risky_candidate_count} risky / advisory-only) — none approved`);
  if (s.top_failure_reasons.length > 0) {
    lines.push('');
    lines.push('## Top failure reasons');
    for (const f of s.top_failure_reasons) lines.push(`- ${f.reason} ×${f.count}`);
  }
  if (s.recording_errors.length > 0) {
    lines.push('');
    lines.push('## Recording errors');
    for (const e of s.recording_errors) lines.push(`- [${e.kind}] ${e.scenario_id} trial ${e.trial}: ${e.message}`);
  }
  lines.push('');
  lines.push(`## Recommendation: \`${s.recommendation}\``);
  for (const r of s.reasons) lines.push(`- ${r}`);
  lines.push('');
  return lines.join('\n');
}

/* ============================== model-replay ============================= */

export interface ModelReplayOptions {
  runId: string;
  model: string;
  trials: number;
  budgetUsd: number;
  suite: ApprovedSuite;
  mutationId?: string | null;
}

export interface ModelReplayTrial {
  trial: number;
  trace_id: string;
  passed: boolean;
}

export interface ModelReplayResult {
  candidate_id: string;
  scenario_id: string;
  passed: boolean;
  /** Replay-time instability: pass/fail disagreed across trials (distinct from recording-time instability). */
  replay_unstable: boolean;
  trials: ModelReplayTrial[];
}

export interface ModelReplaySummary {
  run_id: string;
  provider: string;
  model: string;
  suite_id: string;
  trials: number;
  budget_usd: number;
  spent_usd: number;
  totals: { tests: number; passed: number; failed: number; replay_unstable: number };
  results: ModelReplayResult[];
  recording_errors: RecordingError[];
  stopped_on_budget: boolean;
}

export async function runModelReplay(
  store: RunStore,
  opts: ModelReplayOptions,
  deps: ModelRunDeps,
): Promise<ModelReplaySummary> {
  const policy = new ModelPolicy({ client: deps.client, model: opts.model, budgetUsd: opts.budgetUsd });
  const partitions: DatasetPartition[] = ['mining', 'holdout', 'adversarial'];
  const results: ModelReplayResult[] = [];
  const errors: RecordingError[] = [];
  let stopped = false;

  outer: for (const test of opts.suite.tests) {
    const scenarios = SCENARIOS.filter((sc) => sc.family === test.scenario_family && partitions.includes(sc.partition));
    for (const scenario of scenarios) {
      const trials: ModelReplayTrial[] = [];
      for (let i = 0; i < opts.trials; i++) {
        try {
          const trace = await recordSession({
            scenario,
            policy,
            fixture: deps.fixture,
            mutationId: opts.mutationId ?? null,
            trial: opts.trials > 1 ? i : null,
            budgetUsd: opts.budgetUsd,
          });
          store.appendRawTrace(trace);
          const ars = test.assertions.filter((a) => a.stable).map((a) => evaluateAssertion(a, trace));
          ars.push(evaluateGoldenOutcome(scenario, trace));
          trials.push({ trial: i, trace_id: trace.trace_id, passed: ars.every((r) => r.passed) });
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            errors.push({ scenario_id: scenario.scenario_id, trial: i, kind: 'budget_exceeded', message: err.message });
            stopped = true;
            break;
          }
          const kind = err instanceof ModelPolicyError ? 'malformed_tool_call' : 'provider_error';
          errors.push({
            scenario_id: scenario.scenario_id,
            trial: i,
            kind,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (trials.length > 0) {
        const passedAll = trials.every((t) => t.passed);
        const replayUnstable = new Set(trials.map((t) => t.passed)).size > 1;
        results.push({
          candidate_id: test.candidate_id,
          scenario_id: scenario.scenario_id,
          passed: passedAll && !replayUnstable,
          replay_unstable: replayUnstable,
          trials,
        });
      }
      if (stopped) break outer;
    }
  }

  const totals = {
    tests: results.length,
    passed: results.filter((r) => r.passed && !r.replay_unstable).length,
    failed: results.filter((r) => !r.passed && !r.replay_unstable).length,
    replay_unstable: results.filter((r) => r.replay_unstable).length,
  };
  const summary: ModelReplaySummary = {
    run_id: opts.runId,
    provider: deps.client.provider,
    model: opts.model,
    suite_id: opts.suite.suite_id,
    trials: opts.trials,
    budget_usd: opts.budgetUsd,
    spent_usd: Math.round(policy.spentSoFarUsd() * 1e6) / 1e6,
    totals,
    results,
    recording_errors: errors,
    stopped_on_budget: stopped,
  };
  store.saveJsonReport('model-replay-summary.json', summary as never);
  store.saveReport('model-replay-summary.md', renderReplayMarkdown(summary));
  return summary;
}

export function renderReplayMarkdown(s: ModelReplaySummary): string {
  const lines: string[] = [];
  lines.push('# Model replay summary');
  lines.push('');
  lines.push(`- run: \`${s.run_id}\` · suite: \`${s.suite_id}\``);
  lines.push(`- provider/model: ${s.provider} / ${s.model} · trials: ${s.trials}`);
  lines.push(`- spent: ~$${s.spent_usd.toFixed(4)} of $${s.budget_usd}${s.stopped_on_budget ? ' (STOPPED on budget)' : ''}`);
  lines.push('');
  lines.push(
    `## Totals: ${s.totals.passed}/${s.totals.tests} passed · ${s.totals.failed} failed · ` +
      `${s.totals.replay_unstable} replay-unstable`,
  );
  lines.push('');
  lines.push('_Replay-time instability (pass/fail flipping across trials) is reported separately from recording-time instability._');
  lines.push('');
  for (const r of s.results) {
    const tag = r.replay_unstable ? 'UNSTABLE' : r.passed ? 'pass' : 'FAIL';
    lines.push(`- [${tag}] ${r.candidate_id} @ ${r.scenario_id} (${r.trials.filter((t) => t.passed).length}/${r.trials.length} trials passed)`);
  }
  lines.push('');
  return lines.join('\n');
}
