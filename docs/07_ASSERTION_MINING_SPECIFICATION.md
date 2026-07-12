# 07 — Assertion mining specification (the differentiated core)

Implementation: `src/pipeline/mine.ts` (`miner-v1`). Deterministic rules only — **no LLM anywhere**; if an LLM proposer is ever added, its proposals must pass the same deterministic verification against traces and carry `provenance.miner` identifying it.

## Inputs and gates
- Grouping: by `scenario_family` (clustering for un-labelled external traces is future work — docs/20 A-06; today traces carry scenario ids by construction).
- Only traces labelled `verified_success` or `valid_rejection` inform assertions. Verified failures are excluded so historical bugs are never frozen (unit-tested).
- `MIN_SUPPORT = 2` traces; below it a family yields nothing.
- `stable = (support == total && support ≥ MIN_SUPPORT)`; only stable assertions compile into suites; the rest surface as advisory rows with risk notes.

## Assertion types and mining rules
| Type | Mined when | Evaluated as |
|---|---|---|
| tool_required | tool in every trace | tool called |
| one_of_tools | per-trace *state-changing* toolsets have empty intersection but every trace mutates via ≥1 of the union (detects alternative valid paths from per-step `state_changed`) | ≥1 of set called |
| tool_forbidden | (review-added; miner emits state_unchanged instead of guessing) | tool absent |
| tool_precedes | in every trace containing both, a's first call precedes b's; support = traces containing both, ≥ MIN_SUPPORT | conditional; vacuous if either absent |
| arg_present | arg on every call of tool, tool in ≥2 traces | every call has arg |
| arg_equals_entity | arg value equals the same intent entity key in every call → `@entity:key` | value equals entity extracted from the *replay* intent (this is what generalises across wording) |
| arg_enum | schema-declared enum on an exercised arg (frozen at mining time) | values ⊆ frozen enum |
| max_call_count | observed per-tool maximum | count ≤ max (advisory-grade loop guard) |
| error_expected | family is all valid_rejection with one error code | some step errors with that code |
| no_error | all steps ok in all traces | no error steps |
| state_unchanged | env hash unchanged in all traces | hashes equal |
| retrieval_consistent | read-only family where last listing/search returned exactly the rows matching its filters | recomputed against env_after |
| state_postcondition | see anti-overfit rules below | row selected by intent entity satisfies field expectation (literal or `@entity:key`) |

## Anti-overfitting rules (the part that makes this defensible)
1. **Change eligibility.** A field is minable only if the operation changed it in ≥1 trace (before/after row diff) or the row was created. Untouched fixture values that happen to be constant are never frozen. (Caught a real bug: `priority: medium` frozen from fixture coincidence.)
2. **Corroboration.** Constant expected values require ≥2 distinct scenarios agreeing. A single-scenario constant is emitted only when it generalises to an intent entity (`assignee: dana` → `@entity:assignee`), otherwise dropped. (Caught: `dana` frozen from a one-scenario family.)
3. **Entity generalisation before literals** for argument values; incidental cross-trace constants raise a risk note instead of an assertion.
4. **Conditional semantics.** `arg_*`/`tool_precedes` pass vacuously when the tool wasn't called, so one behaviour change fails once (tool_required) instead of five times — report readability and honest failure counting.
5. **Digest-only payloads** make brittle exact-payload comparisons structurally impossible.

## Confidence & provenance
`confidence = support/total`; every assertion lists the exact trace ids that support it and the miner id. Unstable assertions keep their evidence and appear in review output for human judgment.
