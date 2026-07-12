# 24 — Run isolation and the model-validation workflow

Companion to `docs/22` (status) and `docs/23` (model traffic). Read this before running any `model-*` command. Phase 3 added run isolation and three first-class isolated commands so larger model-driven experiments are safe from trace contamination, accidental approvals, and uncontrolled spend.

> This remains the workflow reference, but its embedded test counts and “next run” language
> are Phase 3 snapshots. Current evidence and next steps are in
> `docs/30_PROJECT_STATUS_AND_NEXT_STEPS.md`.

## Why run isolation was added

Before Phase 3 every command wrote into a single shared `.oculory/` directory. That is fine for the deterministic scripted experiment, which cleans and regenerates the whole store on each run. It is **not** fine for model traffic:

- One `record --policy model` recorded 6 live model traces, but a following `verify` processed 84 traces — because 78 old **scripted** traces were still sitting in `.oculory/traces/raw.jsonl` from a previous run. The outcome counts, mined candidates, and any "summary" were therefore a blend of two completely different traffic sources.
- Mixing model and scripted traces silently corrupts everything downstream: instability, mining support counts, and — worst of all — approval. A stable-looking assertion could be "stable" only because 78 deterministic scripted traces drowned out 6 noisy model ones.

**Contamination matters because Oculory's whole value is that an approved assertion means something.** If the traces behind it are a mystery blend, the assertion is worthless. Run isolation makes provenance unambiguous: one run directory, one manifest, one source of traffic.

## The run directory

Each isolated run lives in its own directory (default root: `.oculory/runs-live/<run-id>/`) and contains only that run's artifacts:

```
.oculory/runs-live/model-smoke-2026-07-04T08-15-00-000Z/
  manifest.json                       # what produced this run (reproducibility anchor)
  traces/raw.jsonl                    # only this run's traces
  traces/normalized.jsonl
  outcomes.jsonl
  candidates.json                     # mined candidates, annotated with risk_profile
  suite.json                          # (only if you compile a suite here)
  reports/recording-instability.json
  reports/model-smoke-summary.json    # + .md
  reports/model-experiment-summary.json / model-replay-summary.json
  reports/review.md
  logs/
```

`manifest.json` records the reproducibility metadata (`docs/16`): run id, kind, model, provider, policy id, temperature, trials, budget, partition/scenario filter, git commit (best-effort), node version, and the exact command. A directory is only treated as an oculory run if it has a valid `manifest.json`; `--run-dir` refuses anything else.

The legacy scripted store (`.oculory/`) is untouched and still used by `oculory experiment` exactly as before.

## How to run a smoke check

Always start here. Smoke scenarios are a trivial, cheap plumbing check — "does the provider adapter work at all against this server?"

```sh
export OPENAI_API_KEY=sk-...
./bin/oculory model-smoke --model gpt-4.1-mini --trials 3 --budget-usd 1
```

This creates an isolated run, records **smoke scenarios only** with the model policy, verifies + normalizes, assesses recording-time instability across trials, mines advisory candidates, writes a summary, and prints the next steps. It never auto-approves anything.

### What a **good** smoke result looks like
- All traces verify as `verified_success` (or `valid_rejection` where an error was the intended outcome).
- `Unstable scenario groups: 0/N` — the model behaved the same way across trials.
- No recording errors (no malformed tool calls, no provider errors).
- Recommendation: `run_larger_model_experiment`.

### What a **bad** smoke result looks like
- Recording errors present → recommendation `fix_provider_adapter`. The model emitted malformed tool-call arguments or the provider errored. Fix the adapter/wire format before scaling.
- Unstable scenario groups > 0, or outcomes that did not verify cleanly → recommendation `inspect_traces`. Do not trust anything mined from unstable traffic.
- Zero traces recorded → recommendation `stop_model_validation`. The model or key is unusable for this run (e.g. wrong `--model`).

**Smoke success is not production validation.** It proves plumbing, not model quality. `docs/23` explains what a detection does and does not prove.

## How to run a model experiment

Only after a clean smoke run:

```sh
./bin/oculory model-experiment --model gpt-4.1-mini --trials 3 --budget-usd 5 --partition mining
```

Flags: `--partition <smoke|mining|holdout|adversarial|all>` (default `mining`), `--max-scenarios <n>`, `--trials <n>` (default 3), `--budget-usd <n>` (default 5), `--mine`/`--no-mine`, `--review`/`--no-review`, plus the run-isolation flags below. Holdout traffic is recorded when selected but **never mined** (leakage isolation, `docs/05`).

The summary (`reports/model-experiment-summary.{json,md}`) gives outcome counts, unknown/failure/rejection counts, unstable scenario count, candidate + risky-candidate counts, top failure reasons, top unstable scenarios, and a conservative recommendation:

- `fix_provider_adapter` — malformed tool calls / provider errors.
- `improve_outcome_verifier` — many outcomes did not verify cleanly (unknown/partial/invalid > 20%).
- `inspect_instability_before_mining` — scenarios disagreed across trials.
- `inspect_candidates_then_try_replay` — low instability, mostly-verified: the good case.
- `rerun_with_more_trials` / `stop_model_validation` — inconclusive / unusable.

No single run recommends full-scale validation — one run is a controlled probe, not evidence.

## Inspecting artifacts

```sh
cat .oculory/runs-live/<run-id>/reports/model-smoke-summary.md
cat .oculory/runs-live/<run-id>/manifest.json
./bin/oculory review --run-dir .oculory/runs-live/<run-id>
```

`verify`, `mine`, `review`, and `approve` all accept `--run-dir <path>` and then read/write **only** inside that run directory (never the root `.oculory/`).

## Why candidates are not auto-approved, and how approval safety works

Approval turns an observation into a gate. Doing that automatically from model traffic is dangerous, so `approve --all-stable` refuses model-derived candidates that are:

- **smoke-only** — mined from smoke traffic (a plumbing check, not behavioural ground truth). Needs `--allow-smoke`.
- **from an unstable scenario** — a source scenario disagreed across trials. Needs `--allow-unstable`.
- **risky** — mixed scripted+model provenance, adversarial-only, below recommended support, constant arguments, alternative tool paths, or unknown outcomes nearby. Needs `--allow-risky`.

Each candidate carries a `risk_profile` (source policies, model/scripted trace counts, partitions, the flags above) that `review` prints and `approve` enforces. Overriding a warning is recorded in the approval record (`approved_by`, `approval_mode`, `overridden_warnings`, `reason`). Approving a single candidate by id (`oculory approve <id> --run-dir ...`) always proceeds but prints and records the warnings. Legacy scripted candidates have no `risk_profile` and behave exactly as before.

```sh
# blocked by default (smoke-only), with the exact override shown:
./bin/oculory approve --run-dir <dir> --all-stable
# deliberate override, attributed and reasoned:
./bin/oculory approve --run-dir <dir> --all-stable --allow-smoke --allow-risky \
  --reviewed-by nidhi --reason "smoke plumbing check, accepted knowingly"
```

## Cleaning runs and re-running

A run directory that already exists and is non-empty is a hard error unless you say what to do:

- `--clean` — delete the target run directory and start fresh.
- `--append` — add to the existing run and update the manifest (`append_count`, `updated_at`).
- `--force` — overwrite this run's generated outputs (truncates its trace/outcome files) without deleting unrelated files.
- `--out-dir <path>` / `--run-id <id>` — choose a different location or id instead.

You never have to move `.oculory/` folders by hand anymore. To discard everything, delete the run directory (or `.oculory/runs-live/`).

## Keeping generated artifacts out of Git

`.gitignore` excludes `node_modules/`, `dist/`, `.oculory/`, `.oculory-*/`, `.env`, `*.log`, `*.zip`, `*.tar.gz`, and `.DS_Store`. `.oculory/runs-live/` is covered by `.oculory/`. **API keys come from the environment only — never a file.** `oculory doctor` warns if a stray `.env` exists, if the generated dirs are not gitignored, or (best-effort, when in a git repo) if generated files are tracked.

## Exact commands for the next operator

```sh
npm test                                 # 220 tests in the 2026-07-10 audit, green, no network
./bin/oculory doctor                     # environment check (add --model to check the key)
./bin/oculory experiment                 # scripted experiment, unchanged result

export OPENAI_API_KEY=sk-...
./bin/oculory model-smoke --model gpt-4.1-mini --trials 3 --budget-usd 1
# inspect reports/model-smoke-summary.md; if recommendation is run_larger_model_experiment:
./bin/oculory model-experiment --model gpt-4.1-mini --trials 3 --budget-usd 5 --partition mining
./bin/oculory review --run-dir .oculory/runs-live/<run-id>
# approvals are deliberate and attributed; overrides are recorded:
./bin/oculory approve --run-dir .oculory/runs-live/<run-id> --all-stable --reviewed-by <you> --reason "..."
```
