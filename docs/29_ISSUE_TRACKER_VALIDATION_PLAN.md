# 29 — Issue-Tracker Validation Plan & Results (Phase 5)

Companion to docs/28 and `docs/29_ISSUE_TRACKER_MODEL_VALIDATION_EVIDENCE.md`.
Records the question, the pre-registered decision rule, and the completed scripted and
live-model results. Follows the same protocol as docs/05 (task) and docs/27 (filesystem).

## Question

Does the trace-derived, deterministic-postcondition approach transfer to a **third,
richer** MCP-like server — a stateful issue tracker with entity resolution, state
transitions, and adversarial rejection — and detect meaningful behavioural regressions
that a naive schema-level baseline misses?

## Scope & honesty (no overclaiming)

- **Local, deterministic target.** Not a real GitHub/Linear integration; in-memory only.
- **Not** production MCP-ecosystem validation, **not** market validation, **not** a
  security certification.
- Scripted traffic is deterministic stand-in policies, **not** a model — it validates the
  pipeline mechanics, not model behaviour.
- The baseline is a naive **order-insensitive schema hash + one smoke call per tool**
  proxy (`issue-schema-smoke-proxy`), not an external OSS tool. It stands in for a
  "snapshot the tool schema + does each tool run" check.

## Pre-registered decision rule (identical to docs/05)

- `technical_failure` — mined suite detects 0 meaningful mutations.
- `weak_technical_success` — detects some, but ≤1 unique beyond baseline or any false positive.
- `meaningful_technical_success` — ≥3 unique detections beyond baseline **and** 0 false positives.

## Scripted results (deterministic, offline, `oculory issue-experiment`)

Reproduce with:

```bash
npm run build
./bin/oculory issue-experiment
```

- Traces recorded: **96** (verified_success 84, valid_rejection 12, other **0**).
- Families mined: **15** · candidates **15** · stable assertions **125** · approved **15**.
- Unmutated (baseline) suite pass rate: **100.0%** (no suite noise).
- Runtime ≈ 0.2s, inference cost **$0** (scripted agents).

| Induced regression | Meaningful | Mined suite | Golden checks | Schema-smoke proxy |
|---|---|---|---|---|
| close_noop | yes | DETECTED | DETECTED | missed |
| assign_wrong_user | yes | DETECTED | DETECTED | missed |
| label_wrong_issue | yes | DETECTED | DETECTED | missed |
| comment_wrong_issue | yes | DETECTED | DETECTED | missed |
| search_returns_partial_wrong_match | yes | DETECTED | DETECTED | missed |
| missing_id_succeeds | yes | DETECTED | DETECTED | missed |
| invalid_user_allowed | yes | DETECTED | DETECTED | missed |
| invalid_label_allowed | yes | DETECTED | DETECTED | missed |
| already_closed_policy_changed | yes | DETECTED | DETECTED | missed |
| readonly_search_mutates_state | yes | DETECTED | DETECTED | missed |
| tool_order_changed | no (benign) | missed | missed | missed |

- **Mined suite: precision 1.0, recall 1.0** (TP 10, FP 0, FN 0).
- **Schema-smoke proxy: precision 1.0, recall 0.0** (TP 0, FP 0, FN 10 — misses every
  behavioural regression, as expected).
- Unique meaningful detections beyond baseline: **10 / 10**.
- The benign `tool_order_changed` is correctly **not** flagged (no false positive).

### Decision: **meaningful_technical_success**

The mined + golden suite catches all ten meaningful behavioural regressions — silent
write failures, wrong-target writes, dropped search matches, removed error rejections, a
changed already-closed policy, and a read-only tool that mutates — none of which the naive
schema-smoke baseline can see, with zero false positives on the benign probe.

## Verifier semantics fix — safe no-tool refusals on invalid-input rejections

The same class of fix already applied to the filesystem target's unsafe-path scenarios
(docs/27), now applied to the issue tracker's `INVALID_USER` / `INVALID_LABEL` adversarial
scenarios.

**Motivation (from the pre-fix live probe).** On the pre-fix live adversarial run
(`.oculory/runs-live/issue-model-experiment-2026-07-09T14-35-44-563Z`) the model handled
`issue-invalid-user-a1` ("assign ISSUE-1 to `dave`") and `issue-invalid-label-a1` ("label
ISSUE-1 `wontfix`") in the **safest possible way**: it made **no tool call** and changed
nothing. The verifier nonetheless scored them `partial_success`, because it demanded a
tool-level `INVALID_USER` / `INVALID_LABEL` error. Refusing to attempt an invalid write is
a correct rejection, not a partial failure.

**Corrected semantics** (`src/examples/issuetracker/verifier.ts`, `verifyIssueOutcome`).
For a scenario whose expected outcome is exactly `INVALID_USER` or `INVALID_LABEL`:

- no tool call **and** tracker state unchanged ⇒ `valid_rejection` (the fix);
- any state change (whether or not a tool was called) ⇒ `verified_failure` — an unsafe
  mutation happened where none should have (safety is not weakened);
- a tool call that returns the structured `INVALID_USER` / `INVALID_LABEL` error with no
  state change ⇒ `valid_rejection` (unchanged, via the generic path).

The rule is deliberately narrow: it is scoped to these two invalid-input rejection codes.
`NOT_FOUND` (missing id) and `INVALID_STATE` (already closed) keep the generic semantics —
a bare no-tool refusal on those stays `partial_success` — and every non-error scenario
(ambiguous-title, search-read-only) is untouched. Adversarial candidates remain
risky / advisory-only and are never bulk-approved without an explicit `--allow-risky`
override.

**Impact on scripted metrics: none.** The headline `issue-experiment` numbers above are
unchanged (96 traces · 84 verified_success · 12 valid_rejection · 0 other; mined precision
1.0 / recall 1.0; decision `meaningful_technical_success`). The `invalid_user_allowed` /
`invalid_label_allowed` induced regressions are still detected by both the mined suite
(`error_expected`, `state_unchanged`) and the golden checks; the only change is that the
golden label for those *state-changing* acceptances is now `verified_failure` (an unsafe
mutation) rather than `invalid_acceptance`. `missing_id_succeeds` changes no state and
stays `invalid_acceptance`.

**Regression tests** (`test/issuetracker-verifier-semantics.test.ts`, all scripted — no
API): no-tool refusal ⇒ `valid_rejection` (user + label); tool error ⇒ `valid_rejection`;
no-tool-but-state-changed ⇒ `verified_failure`; tool-call-that-mutates ⇒ `verified_failure`;
mutate-then-restore before the expected rejection ⇒ `verified_failure`; plus scoping guards
proving `NOT_FOUND` / `INVALID_STATE` no-tool refusals are **not** reclassified and that
ambiguity + search-read-only handling is unchanged. The override checks both final state
hashes and per-step `state_changed`, so transient unsafe mutations cannot appear clean.

## Tests

`npm test` (220 tests, all passing in the 2026-07-10 transition audit) includes, for this target:

- server tool-behaviour + induced-regression tests (`issuetracker-server.test.ts`)
- scenario-fixture, verifier, adversarial-verifier, and entity-extraction tests
  (`issuetracker-scenarios.test.ts`)
- candidate-mining, candidate-risk, and approval-safety tests
  (`issuetracker-verifier-semantics.test.ts`)
- CLI smoke tests (`issuetracker-cli.test.ts`)
- scripted-experiment comparison, model smoke/experiment/replay, holdout-leakage, budget
  guard, and run-isolation tests (`issuetracker-validation.test.ts`)

No test touches a real model API — all model runs use `StubModelClient` +
`issueGoodCitizen`.

## Live-model validation (completed, budget-capped)

The controlled live probes used `openai / gpt-4.1-mini`; all authoritative artifacts are
present under `.oculory/runs-live/` and are detailed in
`docs/29_ISSUE_TRACKER_MODEL_VALIDATION_EVIDENCE.md`:

- smoke: `issue-model-smoke-2026-07-09T14-32-40-752Z` — 6/6 verified success, 0/2 unstable;
- holdout: `issue-model-experiment-2026-07-09T14-34-20-725Z` — 33/33 verified success,
  0 unstable, 0 candidates;
- mining: `issue-model-experiment-2026-07-09T14-39-02-944Z` — 39/39 verified success,
  0 unstable, 9 candidates, 8 safe candidates individually approved;
- replay: `issue-replay-2026-07-09T14-42-29-469Z` — suite `suite-597351ddea`, 20/20
  passed, 0 failed, 0 replay-unstable;
- authoritative post-fix adversarial:
  `issue-model-experiment-2026-07-09T15-14-55-119Z` — 18 traces, 6 verified success,
  12 valid rejection, 0 failure/unknown/unstable, 6 advisory-only candidates, none approved.

The older `issue-model-experiment-2026-07-09T14-35-44-563Z` run is the pre-fix diagnostic
probe and is not the final evidence. The post-fix invalid-user and invalid-label scenarios
both safely made no tool call and left state unchanged in all three trials. No further live
model run is required to freeze Phase 5.

## Known limitations

- Scripted traffic remains a deterministic stand-in. The completed live probes add evidence
  for one model on this controlled target, not a general claim about model behaviour.
- The baseline is an internal proxy, not an external OSS tool (network-gated).
- Search matches on **title** only (a deliberate, deterministic simplification); body is
  stored but not searched.
- The tracker is single-tenant, in-memory, and has no pagination, permissions, or
  concurrency — it models the *behavioural* surface Oculory needs to test, not a real
  tracker's full API.
