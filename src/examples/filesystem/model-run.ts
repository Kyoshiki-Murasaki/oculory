import type {
  ApprovedSuite,
  CandidateTest,
  DatasetPartition,
  OutcomeLabel,
  OutcomeRecord,
  RawTrace,
  Scenario,
} from '../../schema/types.js';
import {
  BudgetExceededError,
  ModelPolicy,
  ModelPolicyError,
  type ModelClient,
} from '../../runner/model-policy.js';
import { assessRecordingInstability, type RecordingInstabilityResult } from '../../pipeline/instability.js';
import { renderReviewMarkdown } from '../../pipeline/candidate-risk.js';
import {
  recommendExperiment,
  recommendSmoke,
  renderExperimentMarkdown,
  renderReplayMarkdown,
  renderSmokeMarkdown,
  type ModelExperimentSummary,
  type ModelReplayResult,
  type ModelReplaySummary,
  type ModelReplayTrial,
  type ModelSmokeSummary,
  type PartitionSelector,
  type RecordingError,
} from '../../pipeline/model-run.js';
import type { RunStore } from '../../pipeline/run-store.js';
import { FS_SCENARIOS, fsScenariosByPartition } from './scenarios.js';
import { FS_SYSTEM_PROMPT } from './policy.js';
import { recordFsSession } from './record.js';
import { verifyAndNormalizeAllFs, mineFsIsolated } from './run.js';
import { evaluateFsAssertion, evaluateFsGoldenOutcome } from './verifier.js';

/**
 * Isolated filesystem model runs (Phase 4, docs/26). The task-server model-run
 * (src/pipeline/model-run.ts) is reused for all PURE reporting logic
 * (recommendSmoke / recommendExperiment / render*Markdown and the summary
 * types); only the server-specific recording, verification, and mining are
 * filesystem versions here. Like the task path: a stub `ModelClient` in tests,
 * a real `OpenAiClient` on the CLI — NEVER an `OpenAiClient` constructed here,
 * so no test hits the network. Nothing auto-approves candidates.
 */
export interface FsModelRunDeps {
  client: ModelClient;
}

const MODEL_UNAVAILABLE = /model[_ ]?not[_ ]?found|does not exist|no such model|invalid model|unknown model|HTTP 404|HTTP 400/i;

interface RecordingOutcome {
  traces: RawTrace[];
  errors: RecordingError[];
  stopped: boolean;
}

async function recordFsScenarios(
  store: RunStore,
  policy: ModelPolicy,
  opts: { scenarios: Scenario[]; trials: number; budgetUsd: number; mutationId: string | null; model: string },
): Promise<RecordingOutcome> {
  const traces: RawTrace[] = [];
  const errors: RecordingError[] = [];
  let stopped = false;
  outer: for (const scenario of opts.scenarios) {
    for (let trial = 0; trial < opts.trials; trial++) {
      try {
        const raw = await recordFsSession({
          scenario,
          policy,
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
          errors.push({ scenario_id: scenario.scenario_id, trial, kind: 'malformed_tool_call', message: err.message });
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (traces.length === 0 && MODEL_UNAVAILABLE.test(message)) {
          throw new Error(
            `provider call failed for model '${opts.model}': ${message}. If the model name is wrong or unavailable to your key, pass a valid --model.`,
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
    if (group.length < 2) continue;
    const outcomes = group.map((t) => outcomeByTrace.get(t.trace_id) ?? ({ label: 'unknown' as OutcomeLabel } as OutcomeRecord));
    results.push(assessRecordingInstability(scenario.scenario_id, policyId, group, outcomes));
  }
  return results;
}

function riskyCount(candidates: CandidateTest[]): number {
  return candidates.filter((c) => c.risk_profile && !c.risk_profile.safe_to_approve).length;
}
function outcomeCounts(store: RunStore): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of store.loadOutcomes()) counts[o.label] = (counts[o.label] ?? 0) + 1;
  return counts;
}

export function selectFsScenarios(partition: PartitionSelector, maxScenarios: number | null): Scenario[] {
  const selected = partition === 'all' ? FS_SCENARIOS : fsScenariosByPartition(partition);
  return maxScenarios !== null ? selected.slice(0, maxScenarios) : selected;
}

/* ============================== model-smoke ============================== */

export interface FsModelSmokeOptions {
  runId: string;
  model: string;
  trials: number;
  budgetUsd: number;
  mine: boolean;
  mutationId?: string | null;
}

export async function runFsModelSmoke(store: RunStore, opts: FsModelSmokeOptions, deps: FsModelRunDeps): Promise<ModelSmokeSummary> {
  const scenarios = fsScenariosByPartition('smoke');
  const policy = new ModelPolicy({ client: deps.client, model: opts.model, budgetUsd: opts.budgetUsd, systemPrompt: FS_SYSTEM_PROMPT });

  const recording = await recordFsScenarios(store, policy, {
    scenarios,
    trials: opts.trials,
    budgetUsd: opts.budgetUsd,
    mutationId: opts.mutationId ?? null,
    model: opts.model,
  });

  verifyAndNormalizeAllFs(store);
  const instability = assessGroups(store, scenarios, policy.id);
  store.saveInstability(instability);

  const candidates = opts.mine ? mineFsIsolated(store, instability) : [];
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
    instability: { groups: instability.length, unstable_groups: unstable.length, unstable_scenario_ids: unstable.map((g) => g.scenario_id) },
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

/* ============================ model-experiment =========================== */

export interface FsModelExperimentOptions {
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

export async function runFsModelExperiment(store: RunStore, opts: FsModelExperimentOptions, deps: FsModelRunDeps): Promise<ModelExperimentSummary> {
  const scenarios = selectFsScenarios(opts.partition, opts.maxScenarios);
  const policy = new ModelPolicy({ client: deps.client, model: opts.model, budgetUsd: opts.budgetUsd, systemPrompt: FS_SYSTEM_PROMPT });

  const recording = await recordFsScenarios(store, policy, {
    scenarios,
    trials: opts.trials,
    budgetUsd: opts.budgetUsd,
    mutationId: opts.mutationId ?? null,
    model: opts.model,
  });

  verifyAndNormalizeAllFs(store);
  const instability = assessGroups(store, scenarios, policy.id);
  store.saveInstability(instability);

  const candidates = opts.mine ? mineFsIsolated(store, instability) : [];
  if (opts.mine) store.saveCandidates(candidates);
  if (opts.review) store.saveReport('review.md', renderReviewMarkdown(candidates, `Filesystem model experiment review — ${opts.runId}`));

  const counts = outcomeCounts(store);
  const unstable = instability.filter((g) => g.unstable);
  const traceCount = recording.traces.length;
  const unknown = counts.unknown ?? 0;
  const verifiedSuccess = counts.verified_success ?? 0;
  const verifiedFailure = counts.verified_failure ?? 0;
  const validRejection = counts.valid_rejection ?? 0;
  const nonClean = unknown + (counts.partial_success ?? 0) + (counts.invalid_acceptance ?? 0);
  const providerBroken = recording.errors.some((e) => e.kind === 'provider_error' || e.kind === 'malformed_tool_call');

  const failureReasons = new Map<string, number>();
  for (const o of store.loadOutcomes()) {
    if (o.label === 'verified_success' || o.label === 'valid_rejection') continue;
    for (const e of o.evidence) if (!e.passed) failureReasons.set(e.check, (failureReasons.get(e.check) ?? 0) + 1);
  }
  const topFailureReasons = [...failureReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count }));

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

/* ============================== model-replay ============================= */

export interface FsModelReplayOptions {
  runId: string;
  model: string;
  trials: number;
  budgetUsd: number;
  suite: ApprovedSuite;
  mutationId?: string | null;
}

export async function runFsModelReplay(store: RunStore, opts: FsModelReplayOptions, deps: FsModelRunDeps): Promise<ModelReplaySummary> {
  const policy = new ModelPolicy({ client: deps.client, model: opts.model, budgetUsd: opts.budgetUsd, systemPrompt: FS_SYSTEM_PROMPT });
  const partitions: DatasetPartition[] = ['mining', 'holdout', 'adversarial'];
  const results: ModelReplayResult[] = [];
  const errors: RecordingError[] = [];
  let stopped = false;

  outer: for (const test of opts.suite.tests) {
    const scenarios = FS_SCENARIOS.filter((sc) => sc.family === test.scenario_family && partitions.includes(sc.partition));
    for (const scenario of scenarios) {
      const trials: ModelReplayTrial[] = [];
      for (let i = 0; i < opts.trials; i++) {
        try {
          const trace = await recordFsSession({
            scenario,
            policy,
            mutationId: opts.mutationId ?? null,
            trial: opts.trials > 1 ? i : null,
            budgetUsd: opts.budgetUsd,
          });
          store.appendRawTrace(trace);
          const ars = test.assertions.filter((a) => a.stable).map((a) => evaluateFsAssertion(a, trace));
          ars.push(evaluateFsGoldenOutcome(scenario, trace));
          trials.push({ trial: i, trace_id: trace.trace_id, passed: ars.every((r) => r.passed) });
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            errors.push({ scenario_id: scenario.scenario_id, trial: i, kind: 'budget_exceeded', message: err.message });
            stopped = true;
            break;
          }
          const kind = err instanceof ModelPolicyError ? 'malformed_tool_call' : 'provider_error';
          errors.push({ scenario_id: scenario.scenario_id, trial: i, kind, message: err instanceof Error ? err.message : String(err) });
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
