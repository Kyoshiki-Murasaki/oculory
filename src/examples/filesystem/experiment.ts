import type { ComparisonReport, JsonObject, SuiteRunResult } from '../../schema/types.js';
import type { Store } from '../../pipeline/store.js';
import type { ExperimentMetrics, MutationOutcome } from '../../pipeline/experiment.js';
import { autoApproveStable } from '../../pipeline/experiment.js';
import { compileSuite, compareRuns } from '../../pipeline/run.js';
import { FS_SCENARIOS } from './scenarios.js';
import { FS_DEFAULT_POLICIES } from './policy.js';
import { recordFsSession } from './record.js';
import { mineFsAll } from './mine.js';
import { verifyAndNormalizeAllFs, replayFsSuite, runFsSchemaSmokeBaseline, type FsBaselineResult } from './run.js';
import { FS_MUTATIONS } from './mutations.js';

/**
 * Full scripted filesystem experiment (Phase 4, docs/26). Same structure as
 * src/pipeline/experiment.ts for the task server: record → verify → mine →
 * (auto-approve, deterministic offline experiment only) → suite → replay
 * against each induced regression → compare vs the naive schema-smoke baseline.
 * Deterministic, offline, no model API, no network.
 */
const REPLAY_PARTITIONS: ('mining' | 'holdout' | 'adversarial')[] = ['mining', 'holdout', 'adversarial'];

async function recordAllFsTraffic(store: Store): Promise<number> {
  let count = 0;
  for (const scenario of FS_SCENARIOS) {
    for (const policy of FS_DEFAULT_POLICIES) {
      store.appendRawTrace(await recordFsSession({ scenario, policy, mutationId: null }));
      count += 1;
    }
  }
  return count;
}

function detectionFromComparison(cmp: ComparisonReport): { mined: boolean; golden: boolean; types: string[] } {
  const failed = cmp.regressions.flatMap((r) => r.failed_assertions);
  const minedFailed = failed.filter((a) => a.assertion_id !== 'golden-outcome');
  const goldenFailed = failed.filter((a) => a.assertion_id === 'golden-outcome');
  return { mined: minedFailed.length > 0, golden: goldenFailed.length > 0, types: [...new Set(minedFailed.map((a) => a.type))].sort() };
}

function confusion(rows: MutationOutcome[], detected: (m: MutationOutcome) => boolean) {
  const tp = rows.filter((m) => m.meaningful && detected(m)).length;
  const fp = rows.filter((m) => !m.meaningful && detected(m)).length;
  const fn = rows.filter((m) => m.meaningful && !detected(m)).length;
  const precision = tp + fp === 0 ? 1 : Math.round((tp / (tp + fp)) * 1000) / 1000;
  const recall = tp + fn === 0 ? 1 : Math.round((tp / (tp + fn)) * 1000) / 1000;
  return { tp, fp, fn, precision, recall };
}

export async function runFsExperiment(store: Store): Promise<ExperimentMetrics> {
  const t0 = Date.now();
  store.clean();
  store.init();

  const traces = await recordAllFsTraffic(store);
  const { labels } = verifyAndNormalizeAllFs(store);

  const candidates = mineFsAll(store.loadMiningTraces());
  const approved = autoApproveStable(
    candidates,
    'auto-approved: stable deterministic filesystem assertions, unattended experiment mode (production/live-model use requires human review — docs/08, docs/26)',
  );
  store.saveCandidates(approved);
  const suite = compileSuite(approved);
  store.saveSuite(suite);

  const baselineRun = await replayFsSuite(suite, { mutationId: null, partitions: REPLAY_PARTITIONS });
  store.saveRun(baselineRun);

  const mutationOutcomes: MutationOutcome[] = [];
  const baselineResults: FsBaselineResult[] = [];
  for (const m of FS_MUTATIONS) {
    const run: SuiteRunResult = await replayFsSuite(suite, { mutationId: m.mutation_id, partitions: REPLAY_PARTITIONS });
    store.saveRun(run);
    const cmp = compareRuns(baselineRun, run);
    store.saveJsonReport(`comparison-${m.mutation_id}.json`, cmp as unknown as JsonObject);
    const smoke = runFsSchemaSmokeBaseline(m.mutation_id);
    baselineResults.push(smoke);
    const det = detectionFromComparison(cmp);
    mutationOutcomes.push({
      mutation_id: m.mutation_id,
      meaningful: m.meaningful,
      mined_detected: det.mined,
      golden_detected: det.golden,
      baseline_detected: smoke.detected,
      regressed_tests: cmp.summary.regressed,
      failed_assertion_types: det.types,
    });
  }

  const mined = confusion(mutationOutcomes, (m) => m.mined_detected);
  const baseline = confusion(mutationOutcomes, (m) => m.baseline_detected);
  const unique = mutationOutcomes.filter((m) => m.meaningful && m.mined_detected && !m.baseline_detected).map((m) => m.mutation_id);

  let decision: ExperimentMetrics['decision'];
  if (mined.tp === 0) decision = 'technical_failure';
  else if (unique.length >= 3 && mined.fp === 0) decision = 'meaningful_technical_success';
  else decision = 'weak_technical_success';

  const metrics: ExperimentMetrics = {
    traces_recorded: traces,
    verified_success: labels.verified_success ?? 0,
    valid_rejection: labels.valid_rejection ?? 0,
    other_outcomes: traces - (labels.verified_success ?? 0) - (labels.valid_rejection ?? 0),
    families_mined: new Set(candidates.map((c) => c.scenario_family)).size,
    candidates: candidates.length,
    stable_assertions: candidates.flatMap((c) => c.assertions).filter((a) => a.stable).length,
    approved: approved.filter((c) => c.status === 'approved').length,
    baseline_run_pass_rate:
      baselineRun.totals.tests === 0 ? 0 : Math.round((baselineRun.totals.passed / baselineRun.totals.tests) * 1000) / 1000,
    mutations: mutationOutcomes,
    mined,
    baseline,
    unique_detections_beyond_baseline: unique,
    runtime_ms: Date.now() - t0,
    decision,
  };
  store.saveJsonReport('fs-experiment-metrics.json', metrics as unknown as JsonObject);
  store.saveReport('fs-experiment-report.md', renderFsExperimentReport(metrics));
  return metrics;
}

export function renderFsExperimentReport(m: ExperimentMetrics): string {
  const lines: string[] = [];
  lines.push('# Oculory filesystem-target experiment report');
  lines.push('');
  lines.push('Question: does the trace-derived, deterministic-postcondition approach transfer to a SECOND, different');
  lines.push('MCP-like server (a sandboxed filesystem) and detect meaningful behavioural regressions a naive schema-level');
  lines.push('baseline misses?');
  lines.push('');
  lines.push('IMPORTANT SCOPE: traffic here is generated by deterministic scripted agent policies (no model API access in');
  lines.push('this environment) and the baseline is a naive order-sensitive schema hash + smoke-call proxy, not an external');
  lines.push('tool. This demonstrates that the pipeline generalises to a second server and the detection mechanics hold — it');
  lines.push('does NOT prove model behaviour, production value, or a defensible head-to-head against existing tools (docs/26).');
  lines.push('');
  lines.push(`- Traces recorded: ${m.traces_recorded} (verified_success ${m.verified_success}, valid_rejection ${m.valid_rejection}, other ${m.other_outcomes})`);
  lines.push(`- Families mined: ${m.families_mined} · candidates ${m.candidates} · stable assertions ${m.stable_assertions} · approved ${m.approved}`);
  lines.push(`- Unmutated run pass rate: ${(m.baseline_run_pass_rate * 100).toFixed(1)}% (must be 100% — anything lower is suite noise)`);
  lines.push(`- Runtime: ${(m.runtime_ms / 1000).toFixed(1)}s, inference cost: $0 (scripted agents)`);
  lines.push('');
  lines.push('| Induced regression | Meaningful | Mined suite | Golden checks | Schema-smoke proxy | Failing assertion types |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of m.mutations) {
    lines.push(
      `| ${row.mutation_id} | ${row.meaningful ? 'yes' : 'no (benign)'} | ${flag(row.mined_detected)} | ${flag(row.golden_detected)} | ${flag(row.baseline_detected)} | ${row.failed_assertion_types.join(', ') || '—'} |`,
    );
  }
  lines.push('');
  lines.push(`Mined suite: precision ${m.mined.precision}, recall ${m.mined.recall} (TP ${m.mined.tp}, FP ${m.mined.fp}, FN ${m.mined.fn})`);
  lines.push(`Schema-smoke proxy: precision ${m.baseline.precision}, recall ${m.baseline.recall} (TP ${m.baseline.tp}, FP ${m.baseline.fp}, FN ${m.baseline.fn})`);
  lines.push(`Unique meaningful detections beyond baseline: ${m.unique_detections_beyond_baseline.join(', ') || 'none'}`);
  lines.push('');
  lines.push(`## Decision (same pre-registered rule as docs/05): **${m.decision}**`);
  lines.push('');
  return lines.join('\n');
}

function flag(v: boolean): string {
  return v ? 'DETECTED' : 'missed';
}
