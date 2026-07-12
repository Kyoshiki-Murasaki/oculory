# 06 — Scenario catalogue

Source of truth: `src/runner/catalogue.ts` (typed, compile-checked); browse with `oculory scenarios [--json]`. Every scenario defines: id, family, partition, fixture, intent template + wording variants, structured intent, expected behaviour, acceptable tool paths, prohibited tools, expected error, pre/postconditions, ambiguity, difficulty, rationale.

## Partitions
- **smoke** (2): `smoke-list-1`, `smoke-complete-1` — first-debugging-run subset, seconds to execute.
- **mining** (10): the miner's only behavioural input (plus adversarial, flagged for careful review).
- **holdout** (7): materially re-worded variants of mined families + two entire withheld families; never visible to the miner (enforced in `Store.loadMiningTraces`, unit-tested).
- **adversarial** (3): ambiguity and invalid-input probes; double as the mutation-evaluation set for error-path defects.

## Families
| Family | Partitions | Exercises | Mutation probes |
|---|---|---|---|
| complete_by_id (m1,m2,h1) | mining+holdout | direct mutation, one-of paths (complete vs update), corroborated constants | silent_write_failure |
| complete_by_title (m1,m2,h1) | mining+holdout | search-before-mutation ordering, entity-linked args | description_weakened, silent_write_failure |
| create_task (m1,m2,h1) | mining+holdout | creation, enum arg, entity-equals-title | arg_renamed, enum_changed |
| assign_task (m1,h1) | mining+holdout | two-arg mutation, entity generalisation (`@entity:assignee`) | — (overfit guard family) |
| reopen_done (m1) | mining | state-dependent transition | — |
| reopen_invalid (a1) | adversarial | valid rejection: INVALID_TRANSITION, state unchanged | error handling FP guard |
| complete_nonexistent (a1) | adversarial | NOT_FOUND expected; agent must not fabricate success | wrong_success, error_changed |
| ambiguous_title (a1) | adversarial | two matches for 'login' → search and stop, never mutate | description_weakened |
| idempotent_complete (m1) | mining | already-done complete must not regress | FP guard |
| list_open (m1,h1) | mining+holdout | read-only completeness | default_changed |
| search_readonly (m1) | mining | substring retrieval invariant | partial_match_changed |
| compound_create_assign (m1) | mining | compound intent, two acceptable paths | — |
| update_priority (h1) | **holdout only** | generalisation measurement: family never mined | — |
| count_project (h1) | **holdout only** | same, read-only | — |

## Adding scenarios
Add to the typed array (the compiler enforces the schema), keep the partition rule: no near-identical phrasings across mining/holdout; entirely-new families should land in holdout first, migrate to mining only deliberately. Held-out ground truth (postconditions of holdout scenarios) is consumed only by the verifier/golden check at replay time — never by the miner.
