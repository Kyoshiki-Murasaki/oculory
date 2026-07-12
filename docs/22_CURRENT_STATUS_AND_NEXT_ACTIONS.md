# 22 — Historical Phase 3 status and next actions
_Last updated: 2026-07-05 (Phase 3: run isolation + safe model-validation workflow)._

> **Superseded:** this is a point-in-time Phase 3 snapshot. Its statements that no live
> model run exists, its 89-test count, and its request to run the first smoke probe are no
> longer current after Phases 4–5. Use `docs/30_PROJECT_STATUS_AND_NEXT_STEPS.md` for the
> audited current state and next phase. The historical text below is retained to explain the
> decisions made at that time.

## Current phase
Phases 1–27 of docs/10 complete (foundation → CLI → audits → packaging → validation), as before. **Phase 2 (model-driven traffic, docs/23) added:** async `AgentPolicy`/`recordSession`/`replaySuite`/`runExperiment`, a real `ModelPolicy` + `OpenAiClient` behind an injectable `ModelClient` seam, `agent` trace metadata, recording-time instability detection, and `--policy model`/`--model`/`--trials`/`--budget-usd` CLI flags.

**Phase 3 (run isolation + model validation, docs/24) added:** a run-management layer (`run-manifest`, `run-context`, `run-store`) that gives every live model run its own isolated `.oculory/runs-live/<run-id>/` directory with a manifest; first-class `model-smoke`, `model-experiment`, and `model-replay` commands (each a safer wrapper around record/verify/mine/review that never auto-approves and fails closed on budget); `--run-dir` on verify/mine/review; candidate `risk_profile` annotation; approval safety (`--allow-smoke`/`--allow-unstable`/`--allow-risky`, recorded overrides); and an expanded `doctor`. The scripted pipeline is unchanged in behaviour throughout — `oculory experiment` still reproduces the exact same result.

**Important distinction:** Phase 2/3 *code* is done, tested (via a stubbed `ModelClient` — no test calls a real API), and merged. The *evidence* — an actual run against a live OpenAI endpoint — has **not** happened in this repository. Gate G2 (below) stays OPEN until someone with an `OPENAI_API_KEY` runs it. Do not read this document as "model traffic has been validated."

## Test status
`npm test` → **89 passed, 0 failed, 0 skipped**, ~3s (includes build). Still deterministic by construction; the new tests (`run-store`, `model-run`, `approval-safety`, `doctor-and-cli`) exercise the model-traffic and run-isolation code paths entirely through the stub `ModelClient` or arg-validation paths that fail before any network call.

## Experiment status (`oculory experiment`, ~1s, $0) — unchanged
72 traces · 66 verified_success · 6 valid_rejection · 12 candidates · 92 stable assertions · unmutated pass rate **100%** · mined precision **1.0** / recall **0.889** · proxy baseline 0.833 / 0.556 · 4 unique behaviour-level detections (`default_changed, wrong_success, partial_match_changed, error_changed`) · decision per pre-registered rule: **meaningful_technical_success** — *scoped to scripted traffic and the internal proxy baseline* (docs/21 U1/U8). Re-verified byte-for-byte identical after the Phase 2 refactor — the async change and the new `agent`/`trial` fields altered nothing about scripted-policy behaviour.

## Current commands
```
npm install && npm test          # historical Phase 3 snapshot: 89 tests (current audit: 220)
./bin/oculory doctor              # environment check
./bin/oculory experiment           # full scripted pipeline + report (unchanged)
./bin/oculory record --all && ./bin/oculory verify && ./bin/oculory mine \
  && ./bin/oculory review && ./bin/oculory approve --all-stable \
  && ./bin/oculory suite && ./bin/oculory run
./bin/oculory run --mutation silent_write_failure   # exit code 2 = regression

# Phase 3 isolated model runs, requires OPENAI_API_KEY (docs/24):
export OPENAI_API_KEY=sk-...
./bin/oculory model-smoke --model gpt-4.1-mini --trials 3 --budget-usd 1
./bin/oculory model-experiment --model gpt-4.1-mini --trials 3 --budget-usd 5 --partition mining
```

## Generated artifacts
Scripted store (`.oculory/`): `traces/*.jsonl`, `outcomes.jsonl`, `candidates.json`, `suite.json`, `runs/*.json`, `reports/experiment-report.md`, `reports/experiment-metrics.json`, `reports/comparison-*.json`, and `reports/recording-instability.json` when `--trials N>1`.
Isolated model runs (`.oculory/runs-live/<run-id>/`): `manifest.json`, `traces/*.jsonl`, `outcomes.jsonl`, `candidates.json` (with `risk_profile`), `reports/model-{smoke,experiment,replay}-summary.{json,md}`, `reports/recording-instability.json`, `reports/review.md`, `logs/`. All gitignored (`.oculory/`).

## Failures / known limitations
Everything in the previous list still applies to the *scripted* experiment: one domain (U2) · `overlapping_tool_added` FN (U3) · loader-level holdout isolation (U4) · minimal redaction, `import` intentionally absent (U5) · CI unexecuted (U6) · single benign FP probe (U8). Full list with severities: docs/21.

U1 ("all traffic is scripted") is now **partially addressed at the code level, not yet at the evidence level**: a real model policy exists and is wired end to end, but no one has run it against a live model yet, so there is still zero model-behaviour evidence in this repository. See docs/23 for exactly what would and would not change once that run happens.

Phase-2/3 limitations, stated plainly: `OpenAiClient`'s wire format has not been exercised against a live endpoint in this build environment (no network egress, no key) — it follows OpenAI's documented Chat Completions tool-calling contract but could be stale; the cost-estimation pricing table is approximate and will drift; the scripted `replaySuite`'s `TestRunResult.unstable` flag is still hardcoded `false` (scripted agents are deterministic). `model-replay` DOES measure replay-time instability (pass/fail flipping across model trials), reported separately from recording-time instability — but it has, like everything model-driven, not been run against a live endpoint. `model-replay` does not run mutation comparison; use scripted `run`/`compare` for mutation-based regression detection.

## Credentials needed
`OPENAI_API_KEY` — for the model policy (docs/23). Set a hard budget cap in the OpenAI console too; the CLI's own `--budget-usd` guard is a second, independent line of defense, not a replacement for one.

## Reviews needed
docs/19 §2 (candidate review, ~10 min) and §4 (ship decision) — unchanged. Additionally, once a real model run exists: review its `experiment-metrics.json` / recording-instability report against the scripted baseline before trusting any mined assertion derived from model traffic (same non-negotiable human-review step as scripted traces, docs/08).

## Decision-gate status
Gate G1 "pipeline detects mutations a schema baseline misses, deterministically, with zero suite noise": **PASSED** (scripted scope, re-confirmed after Phase 2's refactor). Gate G2 "same holds under model traffic": **still OPEN** — the code to attempt it now exists and is tested against a stub, but the gate itself is only satisfied by an actual run against a real model, which has not happened.

## Exact next automated action
With `OPENAI_API_KEY` set: `./bin/oculory model-smoke --model gpt-4.1-mini --trials 3 --budget-usd 1`. Inspect `reports/model-smoke-summary.md`; if the recommendation is `run_larger_model_experiment`, follow with `./bin/oculory model-experiment --model gpt-4.1-mini --trials 3 --budget-usd 5 --partition mining`, then `review --run-dir` the resulting candidates. See docs/24 for the full walkthrough and what conclusions that first run can and cannot support.

## Exact next action required from the developer
Export `OPENAI_API_KEY` and run the `model-smoke` command above. That single input unblocks Gate G2. Each run is isolated, so it cannot contaminate the scripted store or a previous run. (Anthropic support, `--policy model` routing to a second provider, was in scope for a later phase per the original request and is not implemented — only OpenAI exists right now.)
