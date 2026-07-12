# 26 — Filesystem validation target (Phase 4, second MCP-like server)

Companion to `docs/24` (run isolation / model workflow) and `docs/25` (task-server evidence). This document describes the **second** validation target added in Phase 4 — a local, sandboxed, filesystem MCP-like server — and the scripted + stubbed-model evidence it produced. The live-model plan (no `OPENAI_API_KEY` was present when this was written) is in `docs/27`.

## Why a second server was the next step

Every result before Phase 4 came from a single toy task server (`docs/25`). A pipeline that only works on one hand-built server proves very little. The point of Phase 4 is **external-server-style validation**: take the exact same trace → verify → mine → review → approve → suite → replay → compare machinery and point it at a *different* server, with different tools, different state, different failure modes, and see whether the approach still (a) mines stable deterministic assertions, (b) replays them, and (c) catches meaningful regressions a schema-level check misses.

A filesystem server is a good second target because it is:

- **Genuinely different** from the task server: tools take file paths and content, state is a directory tree (not SQL rows), and the interesting failures are data-loss / silent-corruption / security bugs.
- **Deterministic and cheap** to snapshot (small text tree), so state postconditions stay exact and reproducible.
- **Safety-relevant**: it forces the sandboxing / path-traversal question that a real MCP filesystem server must answer.

This is validation infrastructure, not product expansion. There is no UI, no service, no auth, no billing. The task server is untouched.

## What was implemented (additive only)

New module `src/examples/filesystem/` — nothing under `src/server`, `src/runner`, `src/pipeline`, or `src/schema` changed except `src/cli/main.ts`, which only **adds** `fs-*` commands. The generic pipeline primitives (`Store`/`RunStore`, `mineAll`, `normalize` redaction, `candidate-risk`, `approval`, `instability`, `compareRuns`, `compileSuite`, `evaluateAssertion`, run-context/manifest, `ModelPolicy`) are **reused unchanged** — the filesystem target only supplies what is genuinely server-specific.

| File | Role |
|---|---|
| `server.ts` | `FsServer` — 9 sandboxed tools + path-safety (`resolveInside`, `assertRealInside`) + `fsSnapshot` |
| `mutations.ts` | 8 meaningful + 1 benign induced regressions, all confined to the sandbox |
| `fixtures.ts` | deterministic base tree materialised into a **fresh temp sandbox per session** |
| `scenarios.ts` | 24 scenarios across 15 families (13 mined + 2 smoke-only) over the smoke/mining/holdout/adversarial partitions |
| `policy.ts` | 3 scripted stand-in policies + the model system prompt |
| `entities.ts` | deterministic path/content/from/to/query extraction |
| `verifier.ts` | filesystem state conditions + golden outcome + `evaluateFsAssertion` |
| `record.ts` | `recordFsSession` — same `RawTrace` format as the task server |
| `mine.ts` | `normalizeFsTrace` + `mineFsAll` (generic miner + filesystem state postconditions) |
| `run.ts` | verify+normalize, `replayFsSuite`, `mineFsIsolated`, `runFsSchemaSmokeBaseline` |
| `experiment.ts` | `runFsExperiment` — full scripted experiment + induced-regression comparison |
| `model-run.ts` | `runFsModelSmoke` / `runFsModelExperiment` / `runFsModelReplay` (stub in tests, real client on CLI) |

## The sandboxed server and its tools

`FsServer(root, mutations)` operates **only** inside `root`. Tools:

```
read_file(path)              write_file(path, content)     append_file(path, content)
list_dir(path)               stat_path(path)               delete_file(path)
move_file(from, to)          copy_file(from, to)           search_files(query)
```

All paths are **sandbox-relative**. Path safety is enforced in two layers before any filesystem call:

1. **`resolveInside(root, p)`** — lexical: rejects absolute paths and any `..` that climbs above the root with `PATH_TRAVERSAL`; rejects empty / null-byte paths with `INVALID_ARGUMENT`.
2. **`assertRealInside(root, abs)`** — resolves the realpath of the nearest existing ancestor and confirms it is still inside `realpath(root)`, catching a symlink placed inside the sandbox that points outside it.

A fresh sandbox is created (`mkdtemp`) and destroyed (`rmSync`, guarded to only ever remove a path under the OS temp dir) for **every** recording session, so no scenario shares mutable state and nothing is left on disk. State is captured with `fsSnapshot(root)` — a sorted list of file/dir entries with content (for small files) and a content digest — hashed into a `state_hash` identical in shape to the task server's `EnvSnapshot`, so the whole downstream pipeline works unmodified.

## Scenario families and partitions

24 scenarios across 15 families — the 13 mined families below plus 2 smoke-only families (`fs_smoke_list`, `fs_smoke_read`); `fs-scenarios` lists them all:

- **read-only**: `fs_read_file`, `fs_list_dir`, `fs_stat_path`, `fs_search_file` — expected: state unchanged + retrieval consistency.
- **write / mutate**: `fs_write_file`, `fs_append_file`, `fs_move_file`, `fs_copy_file`, `fs_delete_file`, `fs_overwrite_existing` — expected: explicit post-state verification (file exists/absent, content equals/contains, source preserved/removed).
- **adversarial**: `fs_missing_file` (expect `NOT_FOUND`), `fs_path_traversal` (expect `PATH_TRAVERSAL`, state unchanged, path stayed inside the sandbox), `fs_ambiguous_search` (multiple files match `plan`; the safe expectation is **no write** — a blind write to one arbitrary match is `verified_failure`).

Partitions follow the same leakage-resistant rule as the task server: the miner only ever sees `mining` + `adversarial`; `holdout` is materially re-worded (different paths/content) and is **never** mined.

## CLI (interface chosen: separate `fs-*` commands)

The generic `model-experiment` etc. are hard-wired to the task catalogue, recorder, and verifier. Threading a `--target` flag through them would have entangled the two servers and risked the existing 95 tests. Separate `fs-*` commands keep the task path byte-for-byte unchanged while reusing the server-agnostic pipeline. (The shared `review` / `approve` / `suite --run-dir` commands already work for filesystem runs, because candidates and suites are server-agnostic.)

```
oculory fs-inspect                 # list the 9 sandboxed tools
oculory fs-scenarios               # list the scenario catalogue
oculory fs-mutate                  # list the induced regressions
oculory fs-smoke [--mutation id]   # scripted smoke: record+verify smoke scenarios (writes to .oculory-fs)
oculory fs-experiment              # full scripted experiment + induced-regression comparison + report
oculory fs-report                  # print the latest fs experiment report
oculory fs-model-smoke --model <name> --trials 3 --budget-usd 1
oculory fs-model-experiment --model <name> --trials 3 --budget-usd 5 --partition mining
oculory fs-model-replay --suite <path> --model <name> --trials 3 --budget-usd 5
```

Scripted commands write to `.oculory-fs/` (gitignored via `.oculory-*/`), kept separate from the task store `.oculory/`. Isolated model runs write to `.oculory/runs-live/fs-<run-id>/` with a manifest recording `target=filesystem`.

## Induced regressions (`fs-mutate`)

Eight meaningful defects plus one benign false-positive probe, each a real code path inside `FsServer`, none able to escape the sandbox:

`write_silent_noop`, `append_overwrites_instead`, `delete_wrong_file`, `move_copies_instead`, `path_traversal_allowed` (removes the rejection but **clamps into the sandbox** — never touches a real external file), `read_returns_wrong_content`, `search_returns_partial_wrong_match`, `overwrite_policy_changed`, and benign `tool_order_changed`.

## Scripted validation evidence (real artifacts)

Produced by `./bin/oculory fs-experiment` (deterministic, offline, ~8 s, $0). Artifacts land in `.oculory-fs/` (gitignored, regenerable): `reports/fs-experiment-report.md`, `reports/fs-experiment-metrics.json`, `suite.json`, `candidates.json`, and one `reports/comparison-<mutation>.json` per regression.

- Traces recorded: **72** (verified_success **66**, valid_rejection **6**, other **0**)
- Families mined: **13** · candidates **13** · stable assertions **103** · approved **13**
- **Unmutated run pass rate: 100.0%** (required — anything lower is suite noise)

| Induced regression | Meaningful | Mined suite | Golden checks | Schema-smoke proxy | Failing assertion types |
|---|---|---|---|---|---|
| write_silent_noop | yes | DETECTED | DETECTED | missed | state_postcondition |
| append_overwrites_instead | yes | missed | DETECTED | missed | — |
| delete_wrong_file | yes | DETECTED | DETECTED | missed | state_postcondition |
| move_copies_instead | yes | DETECTED | DETECTED | missed | state_postcondition |
| path_traversal_allowed | yes | DETECTED | DETECTED | missed | error_expected |
| read_returns_wrong_content | yes | DETECTED | DETECTED | missed | state_postcondition |
| search_returns_partial_wrong_match | yes | DETECTED | DETECTED | missed | state_postcondition |
| overwrite_policy_changed | yes | DETECTED | DETECTED | missed | no_error, state_postcondition |
| tool_order_changed | no (benign) | missed | missed | DETECTED | — |

- **Mined suite: precision 1.0, recall 0.875** (TP 7, FP 0, FN 1)
- **Schema-smoke proxy: precision 0.0, recall 0.0** (TP 0, FP 1, FN 8)
- Unique meaningful detections beyond baseline: `write_silent_noop, delete_wrong_file, move_copies_instead, path_traversal_allowed, read_returns_wrong_content, search_returns_partial_wrong_match, overwrite_policy_changed`
- Decision (same pre-registered rule as `docs/05`): **meaningful_technical_success**

Reading the table honestly:

- The trace-derived **mined suite** catches 7 of 8 meaningful regressions with **zero** false positives. The one it does not catch on its own is `append_overwrites_instead` — detecting it requires knowing the *prior* file content, which is authored ground truth, not something the miner should freeze from traffic without overfitting. That regression is caught by the **golden** (scenario-postcondition) check, which is also evaluated during replay, so **Oculory as a whole detects all 8 meaningful regressions**.
- The naive **schema-smoke baseline** — an order-sensitive schema hash plus one known-good smoke call per tool — catches **none** of the behavioural regressions (the schema is unchanged and the smoke call still returns ok) and produces one **false positive** on the benign `tool_order_changed`. This is exactly the gap the trace-derived, state-postcondition approach fills.

## What this does and does not show

**Allowed claim (this ran, backed by the artifacts above):** *Oculory has now been validated on a second local MCP-like target with deterministic filesystem postconditions.*

It does **not** show production validation, market validation, superiority over existing eval platforms, broad MCP-ecosystem coverage, customer demand, or any security certification. The scripted table above remains deterministic pipeline evidence; a later controlled live-model mining/replay/adversarial chain is documented separately in `docs/27_FILESYSTEM_MODEL_VALIDATION_EVIDENCE.md`. The baseline is a deliberately naive internal proxy, not an external tool. Together these results demonstrate transfer to a second local, structurally different server—not general MCP reliability.

## Known limitations

- Live-model evidence is limited to one small `gpt-4.1-mini` probe per preserved stage; no cross-model or production evidence exists. See `docs/27_FILESYSTEM_MODEL_VALIDATION_EVIDENCE.md`.
- `append_overwrites_instead` is detected only by the golden check, not the mined suite (by design — see above).
- The sandbox is a small in-repo fixture tree; large-file / binary / concurrent-access behaviour is out of scope for the MVP.
- Symlinks are guarded (escape rejected), not exercised as a first-class feature.

## Next validation target

Phase 5 subsequently added the local issue-tracker target. The next credibility step is now a **real, third-party/open-source MCP server** over its actual transport, so the implementation and tool schema come from code Oculory did not write. Do not add another synthetic target first.
