# 09 — CLI and developer experience

Binary: `./bin/oculory` (wraps `node --experimental-sqlite dist/src/cli/main.js`). Global flags: `--store <dir>` (default `.oculory`), `--fixture <path>` (default `fixtures/seed.json`), `--json` (machine-readable). Exit codes: **0** ok · **1** usage/validation error (message on stderr) · **2** regression detected (`run`, `compare`) · **3** internal error. Non-interactive by design — every command is CI-safe; `review` prints a table rather than opening a prompt, so the same command serves interactive and scripted use.

| Command | Purpose | Notes |
|---|---|---|
| init | create the store | idempotent |
| doctor [--model <name>] | env checks: node ≥22.13, sqlite, fixture, node_modules, `.env`, gitignore, git-tracked, key | exit 1 only on hard failures; best-effort checks warn; `--model` reports `OPENAI_API_KEY` presence without printing it |
| inspect [--mutation id] | list demo-server tools | see what agents see |
| scenarios | list catalogue | `--json` for the full objects |
| record --all\|--smoke\|<id…> [--policy scripted\|model\|<id>] [--mutation id] [--model <name>] [--trials N] [--budget-usd <cap>] | generate traffic → raw.jsonl | errors if nothing selected; `--policy model` requires `OPENAI_API_KEY` in the environment |
| verify (alias normalize) [--run-dir <dir>] | outcomes + normalised traces | exit 1 if no raw traces; `--run-dir` reads/writes only inside that run |
| mine [--run-dir <dir>] | candidates.json from mining traces only | holdout excluded in code; `--run-dir` annotates candidates with provenance/risk |
| review [--run-dir <dir>] | candidate table + risks | in a run dir, prints provenance + safe-to-approve and writes `reports/review.md` |
| approve <id>\|--all-stable [--reason] [--reviewed-by] [--allow-smoke\|--allow-unstable\|--allow-risky] · reject <id> --reason | review actions | model-safety gating; overrides recorded in artifact |
| suite | compile approved → suite.json (hashed) | exit 1 if nothing approved |
| run [--mutation id] | replay suite | exit 2 on failures; `--json` emits the full run |
| compare <base> <current> | diff runs → report | exit 2 on regressions; lists run ids on misuse |
| mutate / baseline [--mutation id] | list defects / run schema-smoke proxy | |
| experiment | full pre-registered scripted experiment + report | <1 s, unchanged |
| model-smoke --model <name> [--trials N] [--budget-usd <cap>] [--mine] | isolated smoke run + summary (docs/24) | requires `OPENAI_API_KEY`; never auto-approves |
| model-experiment --model <name> [--trials N] [--budget-usd <cap>] [--partition …] [--max-scenarios N] [--mine] [--review] | isolated larger controlled run + summary | requires `OPENAI_API_KEY`; holdout never mined |
| model-replay --suite <path> --model <name> --trials N --budget-usd <cap> | replay an approved suite under a model policy | reports replay-time vs recording-time instability separately |
| report | print latest experiment report | |
| clean | delete the store | |

Run-isolation flags (all `model-*` commands): `--out-dir <path>`, `--run-id <id>`, `--clean`, `--append`, `--force`. A non-empty run directory is a hard error unless one of `--clean`/`--append`/`--force` is passed. Isolated runs live under `.oculory/runs-live/<run-id>/`.

## Quick start (fresh clone)
    npm install && npm run build && npm test
    ./bin/oculory doctor
    ./bin/oculory experiment          # everything, with report

## Model traffic (Phase 2, docs/23)
    export OPENAI_API_KEY=sk-...                  # never pass a key as a flag; never commit one
    ./bin/oculory record --smoke --policy model --model gpt-4.1-mini --trials 3 --budget-usd 5
Scripted policies remain the default (`--policy` omitted, or explicit `--policy scripted`) and the only policy CI runs. `--policy model` requires `OPENAI_API_KEY`; without it the command fails with exit 1 before any network call. `--trials N>1` records the same scenario N times and writes `.oculory/reports/recording-instability.json` if the model disagreed with itself (docs/04 "Two kinds of instability"). `--budget-usd` (default $5, or `OCULORY_BUDGET_USD`) is a hard per-invocation cap — the run fails closed with a clear error when it would be exceeded, it never silently truncates.

## Isolated model runs (Phase 3, docs/24)
Prefer these over raw `record --policy model` for anything beyond a one-off: they write only into `.oculory/runs-live/<run-id>/`, so live model traces are never mixed with scripted traces or a previous run.

    export OPENAI_API_KEY=sk-...
    ./bin/oculory model-smoke --model gpt-4.1-mini --trials 3 --budget-usd 1        # plumbing check first
    ./bin/oculory model-experiment --model gpt-4.1-mini --trials 3 --budget-usd 5 --partition mining
    ./bin/oculory review  --run-dir .oculory/runs-live/<run-id>
    ./bin/oculory approve --run-dir .oculory/runs-live/<run-id> --all-stable --reviewed-by <you> --reason "..."

Neither `model-smoke` nor `model-experiment` auto-approves. `approve --all-stable` blocks model-derived candidates that are smoke-only / from an unstable scenario / risky unless `--allow-smoke` / `--allow-unstable` / `--allow-risky` is passed; overrides are recorded in the approval record. See docs/24 for the full workflow, what a good vs bad smoke result looks like, and the `--clean`/`--append`/`--force` semantics.

## Debugging flow
    ./bin/oculory record --smoke && ./bin/oculory verify && ./bin/oculory review

## Regression flow (what a server developer actually does)
    ./bin/oculory record --all && ./bin/oculory verify && ./bin/oculory mine
    ./bin/oculory review              # human step
    ./bin/oculory approve --all-stable && ./bin/oculory suite
    ./bin/oculory run                 # green baseline
    # ...change the server... (simulate: --mutation silent_write_failure)
    ./bin/oculory run --mutation silent_write_failure   # exit 2, failing assertions printed

## CI flow (GitHub Actions sketch, see .github/workflows/ci.yml)
build → test → `oculory run --json` → job fails on exit 2; the JSON run artifact is uploaded for inspection. A suite is CI-trustworthy only after `oculory run` is 100% green on an unchanged server (docs/15 Q-01).
