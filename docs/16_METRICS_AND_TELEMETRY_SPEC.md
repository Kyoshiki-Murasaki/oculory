# 16 — Metrics and local telemetry

No dashboards, no network telemetry. Everything is structured files under `.oculory/reports/`, produced per run.

## Files
- `experiment-metrics.json` — the full `ExperimentMetrics` object (schema below).
- `experiment-report.md` — human rendering with the scope caveat embedded.
- `comparison-<mutation|run>.json` — per-comparison `ComparisonReport`.
- `runs/<run_id>.json` — every replay with totals.

## ExperimentMetrics schema (implemented)
traces_recorded · verified_success · valid_rejection · other_outcomes (must be 0; anything else means scenario ground truth and traffic disagree) · families_mined · candidates · stable_assertions · approved · baseline_run_pass_rate (must be 1.0) · mutations[] {mutation_id, meaningful, mined_detected, golden_detected, baseline_detected, regressed_tests, failed_assertion_types} · mined{tp,fp,fn,precision,recall} · baseline{…} · unique_detections_beyond_baseline · runtime_ms · decision.

Formulas: precision = tp/(tp+fp) (1 when denominator 0); recall = tp/(tp+fn); detection ground truth = `MutationDef.meaningful`. Regression counting: baseline-pass → current-fail only.

## Counters not yet emitted (planned with P28)
review_time_seconds (start/stop around `review`), inference_cost_usd per run, per-model trial variance, CLI error counts (wrap `fail()`), reproducibility-failure counter (currently enforced by tests instead). Event-log format when added: JSONL `events.jsonl` with {ts, event, fields}, reported per experiment run. Decision thresholds consuming these metrics live in docs/15 and docs/05 — this file defines measurement only.
