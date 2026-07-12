import { readFileSync } from 'node:fs';
import type { CandidateTest, ComparisonReport, JsonObject, SuiteRunResult } from '../schema/types.js';
import { SCENARIOS } from '../runner/catalogue.js';
import { DEFAULT_POLICIES } from '../runner/policies.js';
import { recordSession, type FixtureFile } from '../runner/record.js';
import { scenarioById } from '../runner/catalogue.js';
import { MUTATIONS } from '../server/mutations.js';
import { Store } from './store.js';
import { verifyOutcome } from './verify.js';
import { normalizeTrace } from './normalize.js';
import { mineAll } from './mine.js';
import { compileSuite, compareRuns, replaySuite, runSchemaSmokeBaseline, type BaselineResult } from './run.js';

export interface MutationOutcome {
  mutation_id: string;
  meaningful: boolean;
  mined_detected: boolean;
  golden_detected: boolean;
  baseline_detected: boolean;
  regressed_tests: number;
  failed_assertion_types: string[];
}

export interface ExperimentMetrics {
  traces_recorded: number;
  verified_success: number;
  valid_rejection: number;
  other_outcomes: number;
  families_mined: number;
  candidates: number;
  stable_assertions: number;
  approved: number;
  baseline_run_pass_rate: number;
  mutations: MutationOutcome[];
  mined: { tp: number; fp: number; fn: number; precision: number; recall: number };
  baseline: { tp: number; fp: number; fn: number; precision: number; recall: number };
  unique_detections_beyond_baseline: string[];
  runtime_ms: number;
  decision: 'technical_failure' | 'weak_technical_success' | 'meaningful_technical_success';
}

export function loadFixture(path: string): FixtureFile {
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureFile;
}

export async function recordAllTraffic(store: Store, fixture: FixtureFile): Promise<number> {
  let count = 0;
  for (const scenario of SCENARIOS) {
    for (const policy of DEFAULT_POLICIES) {
      const raw = await recordSession({ scenario, policy, fixture, mutationId: null });
      store.appendRawTrace(raw);
      count += 1;
    }
  }
  return count;
}

export function verifyAndNormalizeAll(store: Store): { verified: number; labels: Record<string, number> } {
  const labels: Record<string, number> = {};
  const raws = store.loadRawTraces();
  for (const raw of raws) {
    const scenario = scenarioById(raw.scenario_id);
    const outcome = verifyOutcome(scenario, raw);
    store.appendOutcome(outcome);
    store.appendNormalizedTrace(normalizeTrace(raw, outcome));
    labels[outcome.label] = (labels[outcome.label] ?? 0) + 1;
  }
  return { verified: raws.length, labels };
}

export function autoApproveStable(candidates: CandidateTest[], reason: string): CandidateTest[] {
  return candidates.map((c) => ({
    ...c,
    status: c.assertions.some((a) => a.stable) ? ('approved' as const) : ('rejected' as const),
    review: { action: c.assertions.some((a) => a.stable) ? ('approve' as const) : ('reject' as const), reason, at: new Date().toISOString() },
  }));
}

function detectionFromComparison(cmp: ComparisonReport): { mined: boolean; golden: boolean; types: string[] } {
  const failed = cmp.regressions.flatMap((r) => r.failed_assertions);
  const minedFailed = failed.filter((a) => a.assertion_id !== 'golden-outcome');
  const goldenFailed = failed.filter((a) => a.assertion_id === 'golden-outcome');
  return {
    mined: minedFailed.length > 0,
    golden: goldenFailed.length > 0,
    types: [...new Set(minedFailed.map((a) => a.type))].sort(),
  };
}

export async function runExperiment(store: Store, fixture: FixtureFile): Promise<ExperimentMetrics> {
  const t0 = Date.now();
  store.clean();
  store.init();

  const traces = await recordAllTraffic(store, fixture);
  const { labels } = verifyAndNormalizeAll(store);

  const candidates = mineAll(store.loadMiningTraces());
  const approved = autoApproveStable(
    candidates,
    'auto-approved: stable deterministic assertions, unattended experiment mode (production use requires human review — docs/08)',
  );
  store.saveCandidates(approved);
  const suite = compileSuite(approved);
  store.saveSuite(suite);

  const partitions: ('mining' | 'holdout' | 'adversarial' | 'smoke')[] = ['mining', 'holdout', 'adversarial'];
  const baselineRun = await replaySuite(suite, { mutationId: null, fixture, partitions });
  store.saveRun(baselineRun);

  const mutationOutcomes: MutationOutcome[] = [];
  const baselineResults: BaselineResult[] = [];
  for (const m of MUTATIONS) {
    const run: SuiteRunResult = await replaySuite(suite, { mutationId: m.mutation_id, fixture, partitions });
    store.saveRun(run);
    const cmp = compareRuns(baselineRun, run);
    store.saveJsonReport(`comparison-${m.mutation_id}.json`, cmp as unknown as JsonObject);
    const smoke = runSchemaSmokeBaseline(m.mutation_id, fixture);
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

  // Decision rule (docs/05 §Decision rule), pre-registered:
  //   technical_failure           mined detects 0 meaningful mutations
  //   weak_technical_success      detects some, but ≤1 unique beyond baseline or any false positive
  //   meaningful_technical_success ≥3 unique detections beyond baseline AND 0 false positives
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
  store.saveJsonReport('experiment-metrics.json', metrics as unknown as JsonObject);
  store.saveReport('experiment-report.md', renderExperimentReport(metrics));
  return metrics;
}

function confusion(rows: MutationOutcome[], detected: (m: MutationOutcome) => boolean) {
  const tp = rows.filter((m) => m.meaningful && detected(m)).length;
  const fp = rows.filter((m) => !m.meaningful && detected(m)).length;
  const fn = rows.filter((m) => m.meaningful && !detected(m)).length;
  const precision = tp + fp === 0 ? 1 : Math.round((tp / (tp + fp)) * 1000) / 1000;
  const recall = tp + fn === 0 ? 1 : Math.round((tp / (tp + fn)) * 1000) / 1000;
  return { tp, fp, fn, precision, recall };
}

export function renderExperimentReport(m: ExperimentMetrics): string {
  const lines: string[] = [];
  lines.push('# Oculory internal experiment report');
  lines.push('');
  lines.push('Question: can trace-derived regression cases detect meaningful failures that a schema-level baseline misses?');
  lines.push('');
  lines.push('IMPORTANT SCOPE: traffic here is generated by deterministic scripted agent policies (no model API access in the');
  lines.push('build environment) and the baseline is an internal schema-diff + smoke-call proxy, not an external OSS tool.');
  lines.push('This demonstrates pipeline feasibility and detection mechanics — not model behaviour, production value, or a');
  lines.push('defensible head-to-head against existing tools (see docs/19 and docs/20).');
  lines.push('');
  lines.push(`- Traces recorded: ${m.traces_recorded} (verified_success ${m.verified_success}, valid_rejection ${m.valid_rejection}, other ${m.other_outcomes})`);
  lines.push(`- Families mined: ${m.families_mined} · candidates ${m.candidates} · stable assertions ${m.stable_assertions} · approved ${m.approved}`);
  lines.push(`- Unmutated run pass rate: ${(m.baseline_run_pass_rate * 100).toFixed(1)}% (must be 100% — anything lower is suite noise)`);
  lines.push(`- Runtime: ${(m.runtime_ms / 1000).toFixed(1)}s, inference cost: $0 (scripted agents)`);
  lines.push('');
  lines.push('| Mutation | Meaningful | Mined suite | Golden checks | Schema-smoke proxy | Failing assertion types |');
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
  lines.push(`## Decision (pre-registered rule, docs/05): **${m.decision}**`);
  lines.push('');
  return lines.join('\n');
}

function flag(v: boolean): string {
  return v ? 'DETECTED' : 'missed';
}
