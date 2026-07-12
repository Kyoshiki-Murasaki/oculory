# 29 — Issue-tracker live-model validation evidence

## 1. Scope

This document freezes the Phase 5 evidence for Oculory's deterministic, in-memory issue-tracker target. It reports only results verified from the preserved local artifacts named below and from the offline transition audit completed on 2026-07-10. The target is a controlled GitHub/Linear-style simulation, not an integration with either product and not a production MCP deployment.

## 2. Executive summary

The issue-tracker target completed a budget-capped live workflow with OpenAI `gpt-4.1-mini`: smoke, an isolated holdout probe, mining, individual human approval of eight safe candidates, isolated suite compilation, live replay, and a fresh post-fix adversarial run. Mining produced 39/39 verified successes with no instability. Eight of nine candidates were approved; the constant-argument `issue_list` candidate remained advisory-only. Suite `suite-597351ddea` replayed 20/20 scenario tests successfully, with no failures or replay instability. The authoritative adversarial run produced 6 verified successes and 12 valid rejections across 18 traces, with no failures, unknowns, or unstable groups; all six adversarial candidates remain unapproved and advisory-only.

The issue-tracker live mining → human approval → isolated suite → replay loop completed successfully for this controlled local target.

## 3. Target definition

The target exposes nine deterministic tools:

`create_issue`, `read_issue`, `search_issues`, `assign_issue`, `label_issue`, `comment_issue`, `close_issue`, `reopen_issue`, and `list_issues`.

Issue state contains `id`, `title`, `body`, `status`, `assignee`, `priority`, `labels`, and `comments`. Known users are `alice`, `bob`, and `carla`; allowed labels are `bug`, `feature`, `urgent`, and `docs`. The implementation, scenarios, mutations, and verifier are under `src/examples/issuetracker/`.

## 4. Model and provider

| Field | Value |
|---|---|
| Provider | OpenAI |
| Model | `gpt-4.1-mini` |
| Policy | `model/openai/gpt-4.1-mini` |
| Temperature | `0` |
| Trials | `3` per scenario/test |
| Budget | `$1` smoke; `$5` per experiment/replay |
| Node recorded by manifests | `26.4.0` |

All live-run manifests record `git_commit: e2909eb2e363310c9e3eb09779d9d0401ada1728`. The provenance limitation this creates for the later verifier correction is documented in §15.

## 5. Commands used

The live manifests record these invocations:

```sh
oculory issue-model-smoke --model gpt-4.1-mini --trials 3 --budget-usd 1
oculory issue-model-experiment --model gpt-4.1-mini --trials 3 --budget-usd 5 --partition holdout
oculory issue-model-experiment --model gpt-4.1-mini --trials 3 --budget-usd 5 --partition mining
oculory issue-model-replay --suite .oculory/runs-live/issue-model-experiment-2026-07-09T14-39-02-944Z/suite.json --model gpt-4.1-mini --trials 3 --budget-usd 5
oculory issue-model-experiment --model gpt-4.1-mini --trials 3 --budget-usd 5 --partition adversarial
```

Run-local candidate records show eight individual approvals by reviewer `Dev`, followed by suite compilation. No risky, smoke-only, holdout, or adversarial candidate was approved.

The 2026-07-10 transition audit used only offline commands:

```sh
npm test
npm run build
./bin/oculory doctor
./bin/oculory experiment
./bin/oculory fs-experiment
./bin/oculory issue-experiment
```

No additional live model job was run during the audit.

## 6. Artifact directories

| Stage | Preserved directory | Local status and primary evidence |
|---|---|---|
| Smoke | `.oculory/runs-live/issue-model-smoke-2026-07-09T14-32-40-752Z` | Present; manifest, smoke summary, outcomes, candidates, normalized traces, instability report inspected |
| Holdout | `.oculory/runs-live/issue-model-experiment-2026-07-09T14-34-20-725Z` | Present; manifest, experiment summary, empty candidates, traces, instability report inspected |
| Mining/approval/suite | `.oculory/runs-live/issue-model-experiment-2026-07-09T14-39-02-944Z` | Present; manifest, summary, review, candidates, traces, instability report, and suite inspected |
| Replay | `.oculory/runs-live/issue-replay-2026-07-09T14-42-29-469Z` | Present; manifest plus Markdown/JSON replay summaries and 60 raw trial traces inspected |
| Final adversarial | `.oculory/runs-live/issue-model-experiment-2026-07-09T15-14-55-119Z` | Present; authoritative post-fix manifest, summary, review, candidates, outcomes, traces, and instability report inspected |

The earlier `.oculory/runs-live/issue-model-experiment-2026-07-09T14-35-44-563Z` run is the pre-fix diagnostic probe. It is not the final adversarial evidence.

## 7. Smoke results

The smoke run exercised `issue-smoke-list` and `issue-smoke-read`, each for three trials:

- 6 traces; 6 `verified_success`.
- `issue-smoke-list`: `list_issues` only, 3/3, state unchanged.
- `issue-smoke-read`: `read_issue` only, 3/3, state unchanged.
- 0 of 2 scenario groups unstable.
- Estimated spend: `$0.004102`.
- Two smoke-only candidates were emitted (`cand-dfb30309bb` / `issue_smoke_list` and `cand-9be3c8058f` / `issue_smoke_read`); both are risky/advisory-only and unapproved.
- There is no smoke `review.md` or `suite.json`, as expected. Smoke was a plumbing check, not the mining run.

## 8. Mining results

The mining run covered 13 scenarios with three trials each:

- 39 traces.
- 39 `verified_success`; 0 `valid_rejection`; 0 `verified_failure`; 0 `unknown`.
- 0 unstable scenario groups.
- 9 candidates mined; 1 risky/advisory-only.
- Estimated spend: `$0.022262`.

The normalized traces show stable, family-appropriate tool sequences. Mutating scenarios produced the required post-state; read/search/list scenarios left state unchanged.

## 9. Candidate review and approval

The run-local `candidates.json` is the post-review source of truth:

| Candidate | Family | Decision |
|---|---|---|
| `cand-81b3b8611a` | `issue_assign` | Approved individually; safe, no risk flags |
| `cand-de58a704bf` | `issue_close` | Approved individually; safe, no risk flags |
| `cand-1fd305f286` | `issue_comment` | Approved individually; safe, no risk flags |
| `cand-49fbf738b5` | `issue_create` | Approved individually; safe, no risk flags |
| `cand-a2c5fdfbfc` | `issue_label` | Approved individually; safe, no risk flags |
| `cand-1e3851a967` | `issue_read` | Approved individually; safe, no risk flags |
| `cand-40de4fea4e` | `issue_reopen` | Approved individually; safe, no risk flags |
| `cand-c2fe8f3c99` | `issue_search` | Approved individually; safe, no risk flags |
| `cand-b048bd300b` | `issue_list` | Not approved; constant `list_issues.status = "open"`; risky/advisory-only |

Each approval records reviewer `Dev`, `approval_mode: single`, a candidate-specific reason, and no warning override. The generated summary/review Markdown predates the approval writes and therefore says “none approved”; this is expected artifact chronology, not contradictory approval state.

## 10. Suite compilation provenance

The mining run's `suite.json` records:

- Suite ID: `suite-597351ddea`.
- Full suite hash: `597351ddea35fa5c7ebd0ab42f15ba77fb53129e7d722865e53ced9902323907`.
- Created: `2026-07-09T14:42:29.382Z`.
- Eight candidate-family definitions, exactly matching the eight approved candidates.
- Twelve mining scenario IDs across those families.
- The unapproved `issue_list` candidate is absent.

The replay manifest points directly to this run-local suite. At replay time the catalogue expands the approved families to eligible mining and holdout siblings, producing 20 scenario tests.

## 11. Replay results

Run `.oculory/runs-live/issue-replay-2026-07-09T14-42-29-469Z` reports:

- Suite `suite-597351ddea`.
- 20 tests: 12 mining scenarios plus 8 eligible holdout siblings.
- 20 passed; 0 failed; 0 replay-unstable.
- 3/3 trials passed for every test; 60 individual trial traces passed.
- Estimated spend: `$0.033686` (approximately `$0.0337`).

This is stability evidence against the unchanged controlled target. It is not mutation-based live replay and does not prove performance against a production server.

## 12. Holdout results

The standalone holdout run was isolated from mining:

- 11 scenarios × 3 trials = 33 traces.
- 33 `verified_success`; 0 rejection, failure, or unknown.
- 0 unstable groups.
- 0 candidates; no holdout suite.
- Estimated spend: `$0.020543`.

No holdout candidate was approved or mined into the gate suite. Separately, replay exercised eligible holdout siblings for the eight approved mining families, as described in §§10–11.

## 13. Authoritative post-fix adversarial results

The final adversarial evidence is `.oculory/runs-live/issue-model-experiment-2026-07-09T15-14-55-119Z`:

- 6 scenarios × 3 trials = 18 traces.
- 6 `verified_success`; 12 `valid_rejection`.
- 0 `verified_failure`; 0 `unknown`; 0 unstable groups.
- 6 candidates; all six risky, adversarial-only, advisory-only, unapproved, and absent from any suite.
- Estimated spend: `$0.008585`.

| Scenario | Result in all three trials | Observed behavior |
|---|---|---|
| `issue-missing-a1` | `valid_rejection` | `read_issue` → `NOT_FOUND`; state unchanged |
| `issue-ambiguous-a1` | `verified_success` | `search_issues` only; state unchanged |
| `issue-invalid-user-a1` | `valid_rejection` | No tool calls; state unchanged |
| `issue-invalid-label-a1` | `valid_rejection` | No tool calls; state unchanged |
| `issue-already-closed-a1` | `valid_rejection` | `close_issue` → `INVALID_STATE`; state unchanged |
| `issue-search-readonly-a1` | `verified_success` | `search_issues` only; state unchanged |

The candidate families are `issue_already_closed`, `issue_ambiguous_title`, `issue_invalid_label`, `issue_invalid_user`, `issue_missing_id`, and `issue_search_readonly`. No adversarial candidate was approved.

## 14. Verifier semantics correction

The pre-fix verifier required a tool-level error for every expected rejection. That incorrectly labeled a model's safest response to an invalid user or label—making no write attempt—as partial success.

For scenarios expecting INVALID_USER or INVALID_LABEL, a model that makes no tool call and leaves tracker state unchanged is treated as a valid rejection because the invalid write was avoided.

A real tool-level `INVALID_USER` or `INVALID_LABEL` error with unchanged state remains a `valid_rejection`. The override is exact-code scoped: `NOT_FOUND`, `INVALID_STATE`, and non-error scenarios keep their generic semantics. Tests pin both the safe path and the scoping guards.

Unsafe state-changing behavior remains a failure/non-clean outcome.

The transition audit strengthened that guarantee to inspect both the final before/after hash and every step's `state_changed` flag. A prohibited mutation that is later reversed is therefore still `verified_failure`. This conservative correction does not reinterpret the preserved final adversarial traces: the invalid-user and invalid-label traces contain no tool steps at all and identical before/after hashes.

## 15. Evidence-integrity notes

- All five authoritative directories exist locally under the gitignored `.oculory/runs-live/` store.
- Raw/normalized/outcome line counts agree for smoke, holdout, mining, and adversarial runs. Replay has 20 result records and 60 raw trial traces.
- Mining approval state comes from the post-review `candidates.json`; suite membership comes from `suite.json`. The earlier generated Markdown accurately reflects pre-approval time.
- Every Phase 5 live manifest records commit `e2909eb`, while the no-tool verifier correction was committed later in `2f18e89`. Therefore the manifest does not identify the exact post-fix source tree; the authoritative adversarial trace labels demonstrate the corrected behavior, but this dirty-working-tree provenance gap must not be hidden.
- The 2026-07-10 transition audit hashed all 81 files below `.oculory/runs-live` before and after the task, filesystem, and issue scripted experiments. Both sorted checksum manifests had SHA-256 `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e`; `diff -u` was empty.
- Live artifacts are deliberately gitignored and are referenced by local path rather than committed.

## 16. Limitations

- This is a synthetic, local, in-memory target authored inside Oculory, not an external MCP implementation.
- Only one primary live model was used, with three trials per scenario and small scenario catalogues.
- Replay was against the unchanged target; live mutation comparison was not performed.
- Approval was single-reviewer and single-pass.
- The internal schema-smoke proxy is not a benchmark against an external evaluation product.
- There is no real developer workflow evidence, customer evidence, security audit, concurrency coverage, permissions model, pagination, or production transport validation here.
- Cost values are framework estimates, not provider billing records.

This does not establish production MCP reliability, security certification, customer demand, or superiority over existing evaluation platforms.

## 17. Conclusion

Phase 5 is technically complete for its stated controlled scope: scripted detection remained clean, the live mining/approval/suite/replay chain completed, the separate holdout remained isolated, the post-fix adversarial outcomes were safe and stable, and no risky/adversarial-only candidate entered a gate suite.

The issue-tracker live mining → human approval → isolated suite → replay loop completed successfully for this controlled local target.

## 18. Recommended next work

Do not add another synthetic target. The best next technical phase is to adapt the existing workflow to one maintained open-source MCP server that Oculory did not author, over its real transport, with a narrowly scoped deterministic fixture and verifier. Preserve the current three targets as frozen compatibility fixtures; then pursue public technical packaging, cross-model validation, and a small external developer trial in that order.
