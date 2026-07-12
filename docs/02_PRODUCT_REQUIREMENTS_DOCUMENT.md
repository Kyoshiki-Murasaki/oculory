# 02 — Product requirements document

Phases: **P0** = required for the first debugging run · **P1** = required for the validated MVP · **P2** = optional after the MVP works. Status reflects the current repository. Acceptance tests name real commands/tests.

## Functional requirements
| ID | Pri | Requirement | Rationale | Acceptance test | Phase | Status |
|---|---|---|---|---|---|---|
| FR-01 | must | Record complete sessions (tools, args, result digests, env before/after, per-step state change, tool schemas, agent id, fixture id) | mining and replay both need full provenance | `oculory record --smoke` then validate against `rawTraceCheck` (test: rawTraceCheck rejects…) | P0 | done |
| FR-02 | must | Deterministic fixture reset per session | replay reproducibility | test "fixture reset is deterministic" | P0 | done |
| FR-03 | must | Verify intended outcome against environment state, not tool status | lying servers are a core detection target | test "success requires the intended state…" | P0 | done |
| FR-04 | must | Normalise traces (outcome + entities + redaction) into versioned schema | stable mining input | `oculory verify` output; schema_version on every artifact | P0 | done |
| FR-05 | must | Group traces by scenario family | family = mining + leakage unit | `groupByFamily` used by `mineAll` | P1 | done |
| FR-06 | must | Mine candidate assertions (13 types) with support, confidence, stability, provenance | the differentiated core | miner tests; docs/07 | P1 | done |
| FR-07 | must | Human review with approve/reject/edit + reasons; observed behaviour never auto-ground-truth | docs/08 | CLI `review/approve/reject`; auto-approval only behind explicit unattended flag with recorded reason | P1 | done |
| FR-08 | must | Compile approved candidates into a hash-versioned suite | tamper-evident replay target | `oculory suite`; suite_hash in every run | P1 | done |
| FR-09 | must | Replay suite against mutated/changed servers; deterministic evaluation per trial | detection machinery | e2e test; `oculory run --mutation …` exits 2 | P1 | done |
| FR-10 | must | Compare runs; classify regression / improved / unstable; JSON+MD reports | CI + human consumption | `oculory compare`; comparison-*.json | P1 | done |
| FR-11 | must | Mutation harness with categorised, real-code-path defects incl. one benign FP probe | ground truth for detection metrics | `oculory mutate`; MUTATIONS registry | P1 | done |
| FR-12 | must | Baseline comparison (schema-diff + smoke proxy, clearly labelled) | "beyond baseline" claim needs a baseline | e2e assertions on unique detections | P1 | done |
| FR-13 | must | Holdout isolation enforced in code | leakage-resistant evaluation | test "holdout isolation…" | P1 | done |
| FR-14 | should | MCP stdio server usable by external clients | interoperability proof | stdio integration test | P1 | done |
| FR-15 | should | Model-provider agent implementing `AgentPolicy` | real traffic | blocked: needs API key + network (docs/19 M-1) | P2 | open |
| FR-16 | should | External trace import (`oculory import`) | production traces | blocked on FR-15-class input + docs/13 gates | P2 | open |

## Non-functional requirements
| ID | Pri | Requirement | Acceptance | Status |
|---|---|---|---|---|
| NFR-01 | must | Local-first; no network calls at runtime | code inspection; offline test run | done |
| NFR-02 | must | Reproducible: identical inputs → identical candidates, suite hash, decisions | reproducibility tests (×2) | done |
| NFR-03 | must | Deterministic-first: no LLM in verify/mine/evaluate paths | code inspection (docs/21) | done |
| NFR-04 | must | Full experiment ≤ 60 s, ≤ $1 inference on scripted traffic | measured: <1 s, $0 | done |
| NFR-05 | must | Structured errors + exit codes (0/1/2/3) in CLI | CLI tests | done |
| NFR-06 | must | Secrets never persisted in traces; result payloads stored as digests + minimal summaries | schema inspection; docs/13 | done |
| NFR-07 | must | Every persisted artifact versioned (`schema_version`) | validators reject other versions | done |
| NFR-08 | should | Strict TypeScript, no `any`, no unchecked indexing | `tsc --noEmit` clean with strict+noUncheckedIndexedAccess | done |

## Cost control
Scripted traffic: zero inference cost. When model traffic lands (FR-15): per-run budget cap flag, trial counts configurable, cost recorded per run (docs/16).

## Explicit non-goals
As docs/01. Additionally out of scope for this PRD: multi-server orchestration, streaming/HTTP MCP transports (stdio only), non-SQLite demo domains.
