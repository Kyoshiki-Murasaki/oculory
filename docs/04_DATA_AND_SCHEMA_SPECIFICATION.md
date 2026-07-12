# 04 — Data and schema specification

All schemas are TypeScript interfaces in `src/schema/types.ts`, runtime-checked by `src/schema/validate.ts`. Every persisted artifact carries `schema_version` (currently **2** — see "Schema migrations" below). Migration strategy: version bump + a pure `migrateVtoV+1(json)` function per artifact + validators that accept only the current version (loaders migrate then validate). Backwards compatibility promise: readers must reject unknown versions loudly, never guess.

## Schema migrations

**v1 → v2 (Phase 2, model-driven traffic).** `RawTrace.agent` gained six fields: `provider`, `model`, `tokens_in`, `tokens_out`, `cost_usd`, `budget_usd` (all nullable; always `null` for `kind:'scripted'`). `RawTrace` gained a top-level nullable `trial` (recording-time trial index). `rawTraceCheck`/`scenarioCheck`/`suiteCheck` now require `schema_version: 2` and reject `1` loudly (locked in by a test in `test/unit-core.test.ts`).

No `migrateV1toV2()` function was written, despite the migration-strategy paragraph above describing one as the general policy. Reason: `.oculory/` is ephemeral, gitignored, regenerated-on-demand local state (`oculory clean` deletes it; `oculory experiment` calls `store.clean()` before every run) — it is never long-lived persisted data anyone depends on across a version bump. There is no realistic v1 data to migrate. If that ever changes (e.g. a store directory becomes something people archive or ship), write the migration function before the next bump rather than repeating this shortcut.

## Serialisation & hashing
- **Canonical JSON** (`canonicalJson`): keys sorted at every depth, no whitespace, `-0`→`0`, non-finite rejected. All ids/hashes derive from it via sha-256 (`hashJson`, `shortId`).
- **JSONL** (append-only): raw traces, normalised traces, outcomes — `.oculory/traces/*.jsonl`, `.oculory/outcomes.jsonl`.
- **Pretty JSON** (human-reviewable): candidates, suite, runs, reports. DECISION: JSON, not YAML — zero-dependency constraint; YAML output is a trivial later addition and changes nothing structural.

## Secret & payload handling
Tool result payloads are stored as `result_digest` (sha-256) plus a minimal typed `result_summary` (returned ids, changed flag) — full payloads never persist. Free text (intent, final response) passes `redactText` (emails, long digit runs) at normalisation; docs/13 defines the stronger pass required before external trace import.

## Artifact schemas (fields marked ° are optional)
| Schema | Key fields | Notes |
|---|---|---|
| RawTrace | trace_id, session_id, scenario_id/family, partition, agent{kind,id,temperature°,seed°,provider°,model°,tokens_in°,tokens_out°,cost_usd°,budget_usd°}, client, user_intent, system_prompt_digest°, tool_schema_hash, tools[], fixture_id, env_before, steps[], final_response°, env_after, server_version, mutation_id°, trial° | validated by `rawTraceCheck` on record; the six new `agent` fields and `trial` are schema_version 2+ |
| ToolCallStep | index, tool, args, result_status, error_code°, result_digest, result_summary, state_changed, latency_ms | `state_changed` from per-step snapshot diff |
| EnvSnapshot | state_hash, rows[] | full rows for demo-scale DBs; digest-only mode is the documented path for large DBs (docs/21 U-3) |
| OutcomeRecord | trace_id, label, evidence[{check,expected,observed,passed}], verifier | verifier id `deterministic-state-v1` |
| NormalizedTrace | RawTrace + normalized:true + outcome + intent_entities | redaction applied |
| Scenario | scenario_id, family, partition, fixture_id, intent(+template/variants), acceptable_tool_paths, prohibited_tools, expect_error°, pre/postconditions, ambiguity, difficulty, rationale | typed catalogue, `scenarioCheck` |
| StateCondition | kind, selector, expected | kinds: task_status/priority/assignee/exists/absent, state_unchanged, listing_complete, search_found |
| Assertion | assertion_id, type, params, confidence, support, total, stable, provenance{trace_ids, miner} | 13 types (docs/07) |
| CandidateTest | candidate_id, scenario_family, scenario_ids, fixture_id, intents, assertions, status, recommended_gate, risk_notes, review° | review records action+reason+timestamp |
| ApprovedSuite | suite_id, created_at, suite_hash, tests[] | suite_hash = hash of compiled tests; runs embed it |
| TrialResult / TestRunResult | trial, trace_id, assertion_results[], passed / candidate_id, scenario_id, trials[], passed, unstable | unstable = same-agent trial variance only (replay-time; see "Two kinds of instability") |
| SuiteRunResult | run_id, suite_id+hash, agent_id, server_version, mutation_id°, tool_schema_hash, results[], totals | reproducible run identity |
| ComparisonReport | baseline/current run ids, regressions[], new_passes[], unstable[], summary | regression requires baseline-pass |
| MutationDef | mutation_id, category, meaningful, description | `meaningful` is the detection ground truth |

## Stable identity
`trace_id` = hash(scenario, policy, mutation, intent[, trial]) → deterministic replays share ids by design; `trial` is folded into the hash ONLY when explicitly passed (recording-time `--trials N>1`), so every pre-Phase-2 call site keeps its exact original `trace_id` (locked in by a test in `test/model-policy.test.ts`) while repeated model trials of the same scenario get distinct ids instead of colliding. `candidate_id` = hash(family, assertion ids); `suite_id` from suite_hash. Wall-clock fields (`recorded_at` etc.) are excluded from all hashes.

## Two kinds of instability — do not conflate them

**Recording-time instability** (`src/pipeline/instability.ts`, `RecordingInstabilityResult`, new in Phase 2): does the SAME scenario+policy produce a different tool sequence or a different verified outcome across repeated *recordings*? Only meaningful for a model policy run with `--trials N>1` (scripted policies are deterministic and always agree with themselves). Detected by diffing N raw traces of the same scenario+policy before mining ever sees them; `oculory record --trials N` writes `.oculory/reports/recording-instability.json` and prints a warning per unstable scenario. A recording-time-unstable scenario's traces are not reliable mining ground truth.

**Replay-time instability** (`TestRunResult.unstable` / `SuiteRunResult.totals.unstable`, pre-existing, see `src/pipeline/run.ts`'s `replaySuite`): whether an *already-approved* suite's assertions disagree across trials during regression *replay* against a live (possibly mutated) server. As the code comment in `replaySuite` notes, this has been a hardcoded `false` since before Phase 2 — genuinely unimplemented, not merely undocumented — and remains out of scope for Phase 2, which only addresses recording-time instability. Do not read `unstable: false` on any run as "instability was checked and none was found"; read it as "not yet measured."
