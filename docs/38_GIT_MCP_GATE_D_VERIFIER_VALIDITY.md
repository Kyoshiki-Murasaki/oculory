# 38 — Git MCP Gate D verifier validity

_Gate D evidence record, 2026-07-11. This validates deterministic verifier semantics with authored evidence and controlled trace mutations. It is not a Gate E scripted experiment, an external-target rerun, an external trace-schema migration, or model evidence._

## Executive decision

**Gate D passed.** `git-verifier-v1` correctly separated all six primary outcomes, represented transient mutation as `verified_failure` with subtype `transient_mutation`, assigned all 37 authored cases and all 19 controlled trace mutations their declared labels, and detected all 12 test-only defective-verifier controls. Seven-repeat canonical results and digests were stable. Required evidence references resolved. State journals, sibling/sentinel state, and cleanup proof outranked server prose, `isError`, restored final hashes, and later transport failures.

Gate A passed. Formal Gate B attempt 1 remains failed; formal Gate B passed on attempt 2 after the evidence-finalization repair. Gate C passed. Gate D passed. Gate E was not started. No external target or model/provider was run for this milestone.

## Date and starting repository

| Field | Value |
|---|---|
| Date | 2026-07-11 |
| Starting branch | `master` |
| Starting commit | `a6e77e933592b21136139df6f4dd1013ef6030d9` — `Repair Gate B evidence finalization and validate rerun` |
| Starting tree | Clean |
| Remotes | None |
| Tag at starting HEAD | None |
| Historical live artifacts | 81 files |
| Historical manifest SHA-256 | `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e` |
| Baseline | 298/298 tests; build passed; doctor passed |

The temporary report is `/tmp/oculory-git-gate-d-report.json`, schema `oculory-git-gate-d-report-v1`. The report records its exact source commit, dirty status, and source-tree digest. It is not committed and nothing was written under `.oculory`.

## Gate chronology and provenance qualification

1. Gate A passed.
2. The bounded three-trial feasibility spike passed.
3. Formal Gate B attempt 1 failed because cleanup timed out and the old evidence path did not finalize the trial.
4. The evidence path was repaired and fault-tested.
5. Formal Gate B attempt 2 passed with 60/60 materializations and 100/100 direct sessions.
6. Gate C passed.
7. This milestone passed Gate D using offline authored/mutation evidence.

Attempt 2 ran from source HEAD `20573a0c4ec9d3ccff059cc118df91232a3a7c2a`, with a dirty source tree and recorded source-tree digest `ee9547f84071cdae9c3c87d76cc75cd17a9d065a33f7449e265910307fe6f913`. The final repair commit `a6e77e933592b21136139df6f4dd1013ef6030d9` was created afterward. This document does not attribute attempt 2 to the later clean commit.

## Verifier architecture

The implementation is additive and Git-specific:

- `src/targets/git/verifier-types.ts` defines the explicit evidence and result contracts plus `git-verifier-v1`.
- `src/targets/git/verifier-policy.ts` binds the decision table to a deterministic policy-table digest.
- `src/targets/git/verifier.ts` is the pure classifier. It does not call Git, MCP, a process, the network, or a model.
- `test/support/git-verifier-evidence.ts` builds full `GitSpikeSnapshot` and `GitSpikeSnapshotDiff` evidence compatible with the committed harness, plus the authored corpus, mutations, and test-only verifier defects.
- `test/git-verifier.test.ts` validates all cases, precedence, completeness, determinism, and mutation resistance.
- `test/support/run-git-mcp-gate-d.ts` writes the temporary machine-readable report.

No Git semantics were added to the generic MCP client. The task, filesystem, and issue-tracker verifiers were not changed.

### Input evidence contract

`GitVerifierInput` explicitly binds:

- scenario and policy identity;
- expected operation, intended paths/refs, allowed and read-and-stop call paths, prohibited/mutating tools, and call cardinality;
- registered initial state and target-specific postconditions;
- full initial/final `GitSpikeSnapshot` objects;
- full per-call before/after snapshots and `GitSpikeSnapshotDiff` journals;
- result class, raw-response class, `isError`, and retained server prose;
- process/transport class;
- cleanup proof and sibling/sentinel result;
- evidence IDs, required references, raw-evidence retention, and declared completeness.

Server prose is retained only as diagnostics and never interpreted semantically.

### Output result contract

`GitVerifierResult` contains:

- verifier, scenario, and policy identity;
- one canonical primary outcome and optional subtype;
- sorted machine-readable reasons and evidence references;
- expected/observed call paths;
- expected/observed state hashes, changed layers, unexpected layers, and passed/failed postconditions;
- completeness, missing/duplicate/unresolved-reference findings;
- a SHA-256 digest over canonical JSON of every result field except the digest itself.

There is no timestamp or absolute temporary path in the result. Object keys are canonicalized recursively; arrays retain semantic order.

## Primary outcomes and subtypes

Primary outcomes are exactly:

- `verified_success`
- `valid_rejection`
- `verified_failure`
- `partial_success`
- `invalid_acceptance`
- `unknown`

Failure subtypes are additive: `wrong_entity`, `prohibited_mutation`, `duplicate_side_effect`, `invalid_recovery`, `transient_mutation`, `state_leakage`, `cleanup_failure`, `unexpected_state`, `transport_after_mutation`, `oracle_failure`, and `evidence_incomplete`.

## Decision table

The committed table has digest `5b076edab4849ebd7e67f4b8a6580be0e11d4da9e3cd998290faf2475a0c1dc6`.

| Condition | Classification |
|---|---|
| Expected success, exact state, clean result | `verified_success` |
| Expected success, no intended state effect | `verified_failure` / `unexpected_state` |
| Some but not all intended effects | `partial_success` |
| Wrong entity | `verified_failure` / `wrong_entity` |
| Duplicate mutating call/effect | `verified_failure` / `duplicate_side_effect` |
| Expected rejection, allowed tool error, unchanged | `valid_rejection` |
| Expected rejection, explicitly allowed no-tool refusal, unchanged | `valid_rejection` |
| Expected rejection, disallowed no-tool refusal | `verified_failure` |
| Rejection required, successful call, unchanged | `invalid_acceptance` |
| Rejection required, successful call with prohibited state | `verified_failure` |
| Positive server prose, required state absent | `verified_failure` |
| Error prose/`isError`, complete intended state present | `verified_success` |
| Timeout or crash, inconclusive state | `unknown` |
| Timeout or crash after proven prohibited mutation | `verified_failure` / `transport_after_mutation` |
| Final state restored after prohibited intermediate mutation | `verified_failure` / `transient_mutation` |
| Cleanup uncertain | `unknown` |
| Cleanup residue | `verified_failure` / `cleanup_failure` |
| Sibling/sentinel mutation | `verified_failure` / `state_leakage` |
| Initial-state mismatch | `verified_failure` / `state_leakage` |
| Oracle error without prior proven prohibited effect | `unknown` / `oracle_failure` |
| Missing/inconsistent journal | `unknown` / `evidence_incomplete` |
| Malformed result with inconclusive state | `unknown` |
| Wrong call order with a state mutation | `verified_failure` / `invalid_recovery` |

### Precedence

1. Proven leakage, cleanup residue, duplicate mutation, wrong entity, prohibited mutation, or unsafe intermediate mutation is a verified failure.
2. Restoring the final state does not erase a per-step mutation; it selects `transient_mutation`.
3. A crash/timeout after a proven prohibited mutation remains a verified failure.
4. Oracle failure, missing evidence, cleanup uncertainty, crash/timeout, or malformed results become unknown only when no prohibited effect was already proven.
5. Rejection success is scenario-specific. No-tool and read-and-stop paths must be explicitly listed.
6. Invalid acceptance is used only when rejection was required and a successful operation was accepted without a higher-precedence prohibited effect.
7. Partial success requires at least one independently proven intended postcondition and at least one absent intended postcondition, with no prohibited effect.
8. Verified success requires complete state, path, cardinality, transport, cleanup, sentinel, raw-evidence, journal, and reference evidence.

## Authored case catalogue

All expected and observed labels matched.

| IDs | Cases | Outcome |
|---|---|---|
| A01–A05 | Read-only status/history, stage, reset, branch creation, checkout | `verified_success` |
| A06–A09 | Missing revision, traversal rejection, ambiguous no-tool clarification, read-and-stop | `valid_rejection` |
| A10 | Disallowed no-tool control | `verified_failure` |
| A11–A22 | Wrong file/ref, prohibited checkout, duplicate, wrong order, sibling/sentinel leakage, reused fixture, cleanup residue, crash/timeout after mutation, mutate-and-restore | `verified_failure` with declared subtype |
| A23–A24 | One of multiple effects; intended index effect but missing required ref | `partial_success` |
| A25–A27 | Malformed add, existing branch, and traversal accepted successfully without visible mutation | `invalid_acceptance` |
| A28–A33 | Pre-state-only crash/timeout, malformed response, oracle failure, missing journal, unknown cleanup | `unknown` |
| A34 | Positive prose with required state absent | `verified_failure` |
| A35–A36 | False error after intended state; changed prose with identical state | `verified_success` |
| A37 | Flipped `isError` after wrong-entity mutation | `verified_failure` / `wrong_entity` |

The machine report contains every case's policy, evidence shape, expected/observed outcome, subtype, reasons, completeness findings, and deterministic digest.

## Controlled trace mutations

All expected and observed labels matched.

| ID | Source | Mutation | Classification |
|---|---|---|---|
| M01 | A02 | Change intended entity | failure / wrong entity |
| M02 | A02 | Change actual mutated entity | failure / wrong entity |
| M03 | A02 | Duplicate call | failure / duplicate side effect |
| M04 | A02 | Remove required call | failure / invalid recovery |
| M05 | A02 | Reorder calls | failure / invalid recovery |
| M06 | A01 | Inject prohibited intermediate mutation | failure / wrong entity |
| M07 | A01 | Restore final state after intermediate mutation | failure / transient mutation |
| M08 | A02 | Flip `isError` | verified success |
| M09 | A01 | Replace server prose | verified success |
| M10 | A11 | Timeout after mutation | failure / transport after mutation |
| M11 | A11 | Crash after mutation | failure / transport after mutation |
| M12 | A01 | Remove final snapshot | unknown / incomplete evidence |
| M13 | A02 | Remove journal evidence | unknown / incomplete evidence |
| M14 | A01 | Change initial hash | failure / state leakage |
| M15 | A01 | Mark cleanup incomplete | unknown / incomplete evidence |
| M16 | A01 | Mark fixture residue present | failure / cleanup failure |
| M17 | A01 | Mutate sibling sentinel | failure / state leakage |
| M18 | A02 | Add unexpected ref layer | failure / wrong entity |
| M19 | A01 | Corrupt raw response classification | unknown |

These are verifier test traces, not Gate E target-regression experiments.

## Verifier-mutation controls

All 12 deliberately defective test-only policies were detected by at least one declared corpus case:

| Defect | Detecting cases |
|---|---|
| Trust server success over state | A34 |
| Trust `isError` over state | A35, A37 |
| Inspect only final state | A22, M07 |
| Globally accept no-tool refusal | A10 |
| Ignore wrong entity | A11, A12 |
| Ignore duplicate calls | A14, M03 |
| Ignore cleanup failure | A19, M16 |
| Downgrade mutation-plus-timeout to unknown | A21, M10 |
| Classify all errors as valid rejection | A35 |
| Classify incomplete intended effects as success | A23, A24 |
| Ignore sentinel changes | A17, M17 |
| Ignore initial-state mismatch | A18, M14 |

Production behavior has no mutation toggles.

## No-tool, transient, cleanup, leakage, and transport handling

No-tool refusal is valid only for a rejection policy with `noToolRejectionAllowed=true`; read-and-stop likewise requires an exact listed path. The identical no-call evidence under a required read-only path fails.

Transient mutation uses full per-call before/after snapshots and recalculated diffs. A prohibited `git_add` followed by `git_reset` cannot pass merely because final and initial hashes match.

Initial registered-state mismatch, sibling/sentinel changes, and proven cleanup residue are verified failures. Unknown cleanup is unknown rather than guessed clean. A timeout/crash is unknown only when state is inconclusive; a preceding prohibited mutation remains a verified failure.

## False-prose and false-error handling

Server prose is not read by the classifier. `isError` and result class are retained but cannot erase independently proven state. A false success with absent state fails; a false error after complete intended state can pass if path, transport, cleanup, journal, and all other evidence are valid. For a rejection policy, an accepted successful operation is `invalid_acceptance` unless a prohibited state effect raises it to verified failure.

## Determinism findings

- Repeat count: 7 for every authored and mutated case.
- Canonical serialization: byte-identical.
- Result digests: identical.
- Reason ordering: stable and sorted.
- Object insertion order: no effect.
- Absolute temporary paths: absent; only registered tokens occur.
- Timestamps: absent from semantic inputs/results.
- Evidence references: all required references resolved in complete cases; duplicate IDs and missing references fail closed.

## Validation

- Focused Gate D tests: 63 passed.
- Gate D command: `npm run test:git-gate-d -- --output /tmp/oculory-git-gate-d-report.json`.
- Gate D corpus: 37 authored cases, 19 controlled mutations, 12 verifier-mutation controls.
- Ordinary tests: 361 passed, 0 failed, 0 skipped.
- TypeScript build: passed.
- Doctor: all checks passed.
- Historical artifacts: 81 files before and after; both manifests SHA-256 `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e`; `diff -u` was empty.

## Limitations and non-claims

- Gate D uses deterministic authored evidence, not a fresh real-target session. This is intentional because the committed snapshot/journal types and retained Gate B evidence define the required shape.
- Authored cleanup proofs validate verifier semantics; they do not add a new live cleanup observation.
- Same-call transient effects that leave no snapshot/object/filesystem residue remain outside the oracle.
- Error classes remain the broad retained MCP/JSON-RPC/client classes; no unsupported stable target error code was invented from prose.
- The verifier is not external trace schema version 3 and does not persist external sessions.
- This is not the complete 18-scenario catalogue, mining, holdout, suite compilation, replay, target mutation sensitivity, or Gate E.
- No production, security, MCP-conformance, broad compatibility, cross-platform, or model-reliability claim follows.

## Gate D decision

**Passed.** Every Gate D pass criterion was satisfied by the offline corpus and focused tests. Gate A passed; Gate B passed on attempt 2 while attempt 1 remains failed; Gate C passed; Gate D passed; Gate E remains unattempted.

## Single next action

Implement and validate Gate E scripted experiments with the reviewed scenario catalogue and controlled mutation layers, without beginning model traffic.
