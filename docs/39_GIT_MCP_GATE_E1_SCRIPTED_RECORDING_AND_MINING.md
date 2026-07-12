# 39 — Git MCP Gate E1 scripted recording and mining

_Gate E1 evidence record, updated 2026-07-12 after an adversarial evidence audit. This record covers the external trace schema, reviewed scripted catalogue, clean three-trial recording, holdout isolation, assertion mining, and the unapproved candidate-review package. It preserves two insufficient attempts discovered during the audit. It does not approve candidates or claim that Gate E passed._

## Executive decision

**Gate E1 completed. Gate E remains pending.** The clean authoritative run executed all 20 scenarios for three fresh cold trials: 60/60 terminal records passed, all labels matched their goldens, all scenarios were stable, all evidence and cleanup checks passed, and the sibling sentinel was unchanged. The result contained 42 `verified_success`, 18 `valid_rejection`, and zero `verified_failure`, `partial_success`, `invalid_acceptance`, or `unknown` outcomes.

The isolated miner read only 18 successful, complete mining traces from six distinct scenarios. It produced ten candidate assertions. Every candidate remains **unapproved**. Human review is mandatory before a separately authorized Gate E2 task may name any approved candidate IDs. No suite compilation, replay, external mutation experiment, model/provider call, or Gate F work occurred.

## Repository and run identity

| Field | Value |
|---|---|
| Date | 2026-07-12 |
| Starting branch | `master` |
| Starting commit | `39454e3413cc7c56e8e6df97ea3e19e68184113c` |
| Starting tree | Clean |
| Primary implementation commit | `a7d7d2f690a3324b7d5ad94715f6b149cfa4be8e` — `Add Git MCP scripted catalogue and mining pipeline` |
| Preflight-fix commit | `ae05d10adba86b2790d9e04d3b3db7ceab938a39` — `Fix Git MCP runtime distribution normalization` |
| Evidence/mining hardening commit | `f2138f5abcf4b3112fb7c05412f0fab30c7419d5` — `Harden Git MCP mining and evidence validation` |
| Candidate-identity repair commit | `6270926be62286a15b540982cb74b4d34b65b020` — `Stabilize Git candidate identity across runs` |
| Authoritative source commit | `6270926be62286a15b540982cb74b4d34b65b020` |
| Authoritative source tree | Clean; manifest `dirty: false` |
| Source-tree digest | `33a577286b751f6d2682fcc93eaf64ee1082e0520208424f127c5eb5a0fd8495` |
| Run ID | `git-gate-e1-scripted-20260712T033640Z` |
| Ignored run root | `.oculory/runs-external/git-gate-e1-scripted-20260712T033640Z` |
| External schema | `external-trace-v3` |
| Run manifest schema | `external-run-manifest-v1` |
| Adapter | `git-scripted-adapter-v1` |
| Verifier | Unchanged `git-verifier-v1` |
| Fixture recipe | `git-spike-seed-v1`; digest `a70438e717458e60bbc7e060934cbfbead480d3ab8f2ebac0c013f13fcab4c6c` |

The external run is gitignored local evidence. No generated trace, transcript, journal, runtime, wheel, sdist, cache, or machine-local absolute path is committed.

## Schema and storage

`external-trace-v3` is additive; the existing schema-v2 validator and compatibility tests were not changed. Each trace binds scenario, partition, target, runtime, source commit/tree digest, adapter/verifier/fixture/catalogue versions, negotiated protocol, complete discovery, intended entities, ordered calls, independent state evidence, verifier result, cleanup, sentinel proof, normalization rules, completeness, and terminal-record digest.

Large evidence is content-addressed under sidecar classes for discovery, transcripts, state journals/final snapshots/per-call diffs, and cleanup. Every reference carries relative path, byte count, media type, and SHA-256; validated JSON Pointers address journal subdocuments. Trial envelopes bind a canonical trace terminal digest and a full-record SHA-256. Independent post-run validation reopened all 60 traces, validated all 60 terminal envelopes, verified every referenced sidecar, and resolved every pointer.

The external run store is append-only and uses exclusive durable writes, file and directory `fsync`, finalized manifests, and a run-wide checksum manifest. It refuses unsafe IDs and paths, existing run IDs, writes after finalization, missing sidecars, size drift, and digest drift. `.oculory/runs-external` is distinct from `.oculory/runs-live`; normal cleanup preserves both. Destructive removal requires the separately named `--include-live` and `--include-external` flags. Preservation tests and a temporary external sentinel proved that each of the three legacy scripted experiment cleanups left both evidence roots unchanged; the probe was removed afterward.

## Runtime provenance

| Field | Value |
|---|---|
| Target | `mcp-server-git==2026.7.10` |
| Wheel SHA-256 | `6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5` |
| Sdist SHA-256 | `95107b8b2989814e8c230e8e489feef4bfa4d80ca4a7ac1612cea05283ff5ea5` |
| Installed server source SHA-256 | `52325521ec8ec00297248fa03eaee6802b9cad3ec1e5bebee25971e1b897d56e` |
| Executable SHA-256 | `a0160dc245aad4c31850be92af9b37b32f00675ef2ab4644ab108ca9eed26bdc` |
| Dependency lock SHA-256 | `5f7f42f1f4b40051836ce7a308e8e4206a87032edf9bc4cc19e9e2ec75a02b63` |
| Locked/installed distributions | 33/33 exact versions |
| Python | 3.12.13 |
| uv | 0.11.23 |
| Git | 2.55.0 |
| Node | v26.4.0 |
| OS / architecture | Darwin 25.4.0 / arm64 |
| MCP protocol | `2025-11-25` |
| Server identity | `mcp-git` 1.28.1 |
| Authoritative commit | `6270926be62286a15b540982cb74b4d34b65b020` |
| Source cleanliness | `dirty: false` |

The disposable runtime's absolute paths remain only in ignored run-local provenance. No credential or API key was used.

## Catalogue

The reviewed catalogue is `git-gate-e1-catalogue-v1`, digest `ad6904504451951e40f5cee9e31a3d7ca968e1e9f2d7470d49d6e5b66d9dd8a1`. The plan originally proposed 18 scenarios. Gate E1 reviewed and narrowly expanded it to 20 so each mined family has three genuinely distinct scenarios. The added scenarios are `git-stage-m3` and `git-branch-m3`.

| Partition | Scenarios | Trials |
|---|---:|---:|
| Smoke | 2 | 6 |
| Mining | 6 | 18 |
| Holdout | 4 | 12 |
| Adversarial | 8 | 24 |
| **Total** | **20** | **60** |

Scenario inventory:

- Smoke: `git-status-s1`, `git-history-s1`.
- Mining: `git-stage-m1`, `git-stage-m2`, `git-stage-m3`, `git-branch-m1`, `git-branch-m2`, `git-branch-m3`.
- Holdout: `git-stage-h1`, `git-branch-h1`, `git-checkout-h1`, `git-reset-h1`.
- Adversarial: `git-missing-revision-a1`, `git-malformed-add-a1`, `git-outside-repository-a1`, `git-add-traversal-a1`, `git-existing-branch-a1`, `git-ambiguous-branch-a1`, `git-status-readonly-a1`, `git-mutate-restore-a1`.

`git_commit` and the ambiguous upstream `git_diff` tool are prohibited throughout this Gate E1 catalogue. `git-mutate-restore-a1` uses only the safe read path; add-then-reset remains Gate E2 mutation work. Mining occurs immediately after the mining partition and before any holdout scenario executes. The mining loader can open only paths physically under `traces/mining`, and additionally rejects non-success, incomplete, failed, partial, unknown, or unstable inputs.

## Scripted three-trial results

Every row below represents three fresh MCP processes, fixtures, trial directories, discovery passes, full per-call journals, verifier results, CP-1 cleanups, and sentinel proofs. `Labels` lists trials 1/2/3. Every row had no unexpected changed layer, 3/3 cleanup passes, 3/3 sentinel passes, complete evidence, stable discovery, stable subtype, stable call path, and zero instability.

| Scenario | Partition | Family | Golden | Labels | Call path | Targeted state proof |
|---|---|---|---|---|---|---|
| `git-status-s1` | smoke | git-status | `verified_success` | success/success/success | `git_status` | complete state unchanged |
| `git-history-s1` | smoke | git-history | `verified_success` | success/success/success | `git_log → git_show` | complete state unchanged |
| `git-stage-m1` | mining | git-stage | `verified_success` | success/success/success | `git_diff_unstaged → git_add → git_diff_staged` | selected index entry |
| `git-stage-m2` | mining | git-stage | `verified_success` | success/success/success | `git_add` | selected index entry |
| `git-stage-m3` | mining | git-stage | `verified_success` | success/success/success | `git_status → git_add` | selected index entry |
| `git-branch-m1` | mining | git-branch-create | `verified_success` | success/success/success | `git_create_branch` | selected ref; HEAD stays main |
| `git-branch-m2` | mining | git-branch-create | `verified_success` | success/success/success | `git_create_branch` | selected ref; HEAD stays main |
| `git-branch-m3` | mining | git-branch-create | `verified_success` | success/success/success | `git_branch → git_create_branch` | selected ref; HEAD stays main |
| `git-stage-h1` | holdout | git-stage | `verified_success` | success/success/success | `git_status → git_add` | selected index entry |
| `git-branch-h1` | holdout | git-branch-create | `verified_success` | success/success/success | `git_branch → git_create_branch` | selected ref; HEAD stays main |
| `git-checkout-h1` | holdout | git-checkout | `verified_success` | success/success/success | `git_branch → git_checkout` | selected symbolic HEAD and OID |
| `git-reset-h1` | holdout | git-reset | `verified_success` | success/success/success | `git_diff_staged → git_reset → git_diff_unstaged` | selected index reset |
| `git-missing-revision-a1` | adversarial | git-missing-revision | `valid_rejection` | rejection/rejection/rejection | `git_show` | complete state unchanged |
| `git-malformed-add-a1` | adversarial | git-malformed-add | `valid_rejection` | rejection/rejection/rejection | `git_add` | complete state unchanged |
| `git-outside-repository-a1` | adversarial | git-outside-repository | `valid_rejection` | rejection/rejection/rejection | no tool | complete state unchanged |
| `git-add-traversal-a1` | adversarial | git-add-traversal | `valid_rejection` | rejection/rejection/rejection | `git_add` | complete fixture/sibling state unchanged |
| `git-existing-branch-a1` | adversarial | git-existing-branch | `valid_rejection` | rejection/rejection/rejection | `git_create_branch` | complete state unchanged |
| `git-ambiguous-branch-a1` | adversarial | git-ambiguous-branch | `valid_rejection` | rejection/rejection/rejection | `git_branch` then stop | complete state unchanged |
| `git-status-readonly-a1` | adversarial | git-status-readonly | `verified_success` | success/success/success | `git_status` | complete state unchanged |
| `git-mutate-restore-a1` | adversarial | git-mutate-restore | `verified_success` | success/success/success | `git_status → git_diff_unstaged` | complete state unchanged |

Here `success` abbreviates `verified_success` and `rejection` abbreviates `valid_rejection`; the full labels are retained in every terminal record and `golden-outcomes.json`.

## Aggregate result

| Measure | Result |
|---|---:|
| Sessions requested/completed | 60/60 |
| `verified_success` | 42 |
| `valid_rejection` | 18 |
| `verified_failure` | 0 |
| `partial_success` | 0 |
| `invalid_acceptance` | 0 |
| `unknown` | 0 (0.00%) |
| Unstable scenarios | 0/20 (0.00%) |
| Cleanup failures | 0 |
| Sentinel failures | 0 |
| Unexpected-layer trials | 0 |
| Missing/corrupt evidence references | 0/0 |
| Process/transport failures | 0 |
| Protocol/invalid-response failures | 0 |
| MCP tool results | 78 success, 12 expected tool errors |
| Terminal status | 60 passed, 0 failed, 0 inconclusive |
| Elapsed target campaign | 215,083.779916 ms |

### Normalization rules

- Registered fixture root → `<FIXTURE_ROOT>`.
- Registered sibling root → `<SIBLING_ROOT>`.
- Registered trial root → `<TRIAL_ROOT>`.
- Monotonic timing is excluded from semantic equality.
- Reflog timestamp/timezone presentation is excluded while its raw digest is retained.
- Sentinel mtime is excluded while bytes, mode, and raw metadata are retained.
- GitPython tzoffset object addresses → `<GITPYTHON_TZOFFSET_OBJECT>`.

## Holdout isolation

The committed tests prove all of the following:

1. `GitMiningLoader` lists and opens only `traces/mining` and rejects a declared smoke, holdout, or adversarial partition.
2. Only `verified_success`, evidence-complete mining traces are eligible.
3. Deleting all holdout traces does not change the mined candidate package.
4. Changing held-out values does not change candidate IDs, predicates, evidence digests, support, or review results.
5. Failed, partial, unknown, unstable, incomplete, and non-mining traces are rejected rather than counted.
6. The authoritative candidate package declares `computedBeforeHoldoutEvaluation: true`; it was written after the 18th mining trace and before the first holdout trial.

The mining input manifest file digest is `7f1711d1cde0857d1304498f9258c9cebda8a230ea750db3de7b1f5690bdc989`. It identifies these six scenario IDs: `git-stage-m1`, `git-stage-m2`, `git-stage-m3`, `git-branch-m1`, `git-branch-m2`, and `git-branch-m3`.

The exact 18 mining trace IDs are:

`ext-0699b227088bb9270e7e`, `ext-09725573d521f82dbe9b`, `ext-180d88fe75d91a6bbf02`, `ext-2c28fd39dda40290f7f0`, `ext-3480185c7a2ea2e9b7fb`, `ext-3816960868f956c7437b`, `ext-53805a5a1ae12ad09c57`, `ext-6e2808ac91f5906f8628`, `ext-76869cab0217c24f2ce0`, `ext-78cb9b945cae14c0c8fb`, `ext-7d7572ca916447f3bde9`, `ext-8f1eee726808fb5cb200`, `ext-9614009cfb1463b16b7a`, `ext-a46679ba8ea16aca821d`, `ext-c9f27dcb870b319e68f9`, `ext-cf94b91644a7751696aa`, `ext-e2e837b2798dd5538b60`, and `ext-e9cb58f4d94bff722c98`.

## Mining method

The plug-in is `git-miner-v1`. It groups eligible traces by semantic family, requires exactly three trials from at least three distinct scenario IDs per family, and counts support by `scenarioId`; repeated trials add confidence but cannot manufacture distinct-scenario support. Before emitting a family candidate, it verifies exactly one required mutating tool, a successful MCP call, the intended-entity argument mapping, verifier-success state evidence, and no unexpected changed layer.

The miner produced required-tool, argument/entity-mapping, selected-state-postcondition, no-error/verified-outcome, and exhaustive-call-path candidates. It generalized filenames and branch names to `@entity:path` and `@entity:branch`. It rejected absolute fixture/executable paths, temporary names, object IDs, request/process IDs, elapsed/reflog time values, server prose, object addresses, and scenario-specific filenames/branches. A hostile literal scan passed for all ten candidates.

Leave-one-scenario-out analysis actually re-mined each two-scenario/six-trial subset and compared the resulting predicates. Every predicate type survived. The stage exhaustive-call-path candidate became more specific in all three folds. The branch exhaustive-call-path candidate became more specific only when `git-branch-m3` (the sole list-then-create path) was omitted; omitting either direct-create scenario retained both path alternatives. Both remain high-risk, advisory-only suggestions. The other eight predicates did not become more specific. A separate permutation check changed every trace ID and evidence order and reproduced all candidate IDs and predicates exactly.

### Candidate provenance sets

- `stage-set` (nine traces): `ext-09725573d521f82dbe9b`, `ext-180d88fe75d91a6bbf02`, `ext-2c28fd39dda40290f7f0`, `ext-6e2808ac91f5906f8628`, `ext-78cb9b945cae14c0c8fb`, `ext-9614009cfb1463b16b7a`, `ext-c9f27dcb870b319e68f9`, `ext-cf94b91644a7751696aa`, `ext-e2e837b2798dd5538b60`.
- `branch-set` (nine traces): `ext-0699b227088bb9270e7e`, `ext-3480185c7a2ea2e9b7fb`, `ext-3816960868f956c7437b`, `ext-53805a5a1ae12ad09c57`, `ext-76869cab0217c24f2ce0`, `ext-7d7572ca916447f3bde9`, `ext-8f1eee726808fb5cb200`, `ext-a46679ba8ea16aca821d`, `ext-e9cb58f4d94bff722c98`.

## Candidate review table

All candidates have distinct-scenario support 3, trial support 9, a passed constant-leakage check, and `unapproved` status. “LOO 3×2/6” means that all three leave-one-out folds survived with two distinct scenarios and six trials. No recommendation is an approval.

| Candidate | Type / generalized predicate | Family / provenance | Risk | LOO | Recommendation and rationale | Status |
|---|---|---|---|---|---|---|
| `git-cand-514fac8b126e` | argument mapping: `git_add.files[0] == @entity:path` | git-stage / `stage-set` | medium | 3×2/6, stable specificity | Recommend approval: every add selected the declared path entity, not a literal. | unapproved |
| `git-cand-5f985ca6af7d` | outcome: zero tool errors, `verified_success`, zero unexpected layers | git-stage / `stage-set` | low | 3×2/6, stable specificity | Recommend approval: all nine trials matched independent verification without errors. | unapproved |
| `git-cand-18ea17797c83` | allowed paths: `git_branch → git_create_branch` or `git_create_branch` | git-branch-create / `branch-set` | high | 3×2/6; only omit-m3 became more specific | Advisory only: exact paths may encode driver style and overfit. | unapproved |
| `git-cand-6d85a493c006` | selected index: entity path blob equals worktree blob; changed-path cardinality 1 | git-stage / `stage-set` | medium | 3×2/6, stable specificity | Recommend approval: independent journals show only the intended index entity changed. | unapproved |
| `git-cand-7795e229e945` | argument mapping: `git_create_branch.branch_name == @entity:branch` | git-branch-create / `branch-set` | medium | 3×2/6, stable specificity | Recommend approval: every create call selected the declared branch entity. | unapproved |
| `git-cand-970b53354b15` | selected ref: `refs/heads/@entity:branch` at initial HEAD; one ref; symbolic HEAD unchanged | git-branch-create / `branch-set` | medium | 3×2/6, stable specificity | Recommend approval: independent ref/HEAD evidence proves one intended creation without checkout. | unapproved |
| `git-cand-ad763acaa2e6` | outcome: zero tool errors, `verified_success`, zero unexpected layers | git-branch-create / `branch-set` | low | 3×2/6, stable specificity | Recommend approval: all nine trials matched independent verification without errors. | unapproved |
| `git-cand-e1226b984f8c` | required tool: `git_add` | git-stage / `stage-set` | low | 3×2/6, stable specificity | Recommend approval: every distinct stage scenario required one add call. | unapproved |
| `git-cand-ee04c8e75603` | allowed paths: `git_add`; `git_diff_unstaged → git_add → git_diff_staged`; or `git_status → git_add` | git-stage / `stage-set` | high | 3×2/6, became more specific | Advisory only: exact paths vary and may encode driver style. | unapproved |
| `git-cand-f0b0aa748842` | required tool: `git_create_branch` | git-branch-create / `branch-set` | low | 3×2/6, stable specificity | Recommend approval: every distinct branch scenario required one create call. | unapproved |

The candidate package file digest is `ec1b4f9f870fb5fef68aa5994dc932d8e4157b52b739097cead1aca684854740`. Compilation rejects this package because none of the candidate IDs has explicit human approval.

## Command chronology and validation

### Failed preflight attempt

The first clean command used run ID `git-gate-e1-scripted-20260711T171447Z`. It stopped before store creation or any target session because the new runner compared canonical lock name `pydantic-core` against raw installed metadata key `pydantic_core`. No run directory exists for that ID; zero evidence was overwritten or discarded. The defect was fixed by PEP 503-style normalization and committed separately as `ae05d10adba86b2790d9e04d3b3db7ceab938a39`. Ordinary tests, build, and doctor passed before the new attempt.

### Preserved insufficient attempts found by audit

The finalized run `git-gate-e1-scripted-20260711T171641Z` completed 60 target sessions but is not authoritative after the 2026-07-12 audit. Its journal references used `/journal/<index>/...` even though each sidecar root is the journal array; digest validation checked the file but did not resolve the pointer. Its leave-one-out fields were also inferred from subset size rather than produced by re-mining each subset. The run remains byte-preserved under its original ID.

After commit `f2138f5`, `git-gate-e1-scripted-20260712T033132Z` completed 60/60 and all corrected pointers resolved. Post-run comparison then found that one call-path candidate ID depended on trace-ID ordering. That run is also preserved but insufficient for the final candidate package. Commit `6270926` canonicalized semantic path-set ordering and added a trace-order permutation regression test. Neither insufficient attempt was overwritten or presented as the final authority.

### Authoritative command

The successful command used the same exact pinned executables after the fix and a new run ID. Machine-local absolute roots are intentionally represented by the shell variables below; their resolved values and hashes remain in ignored `runtime-provenance.json`.

```sh
npm run test:external-git-gate-e1 -- \
  --python "$GATE_RUNTIME/bin/python" \
  --executable "$GATE_RUNTIME/bin/mcp-server-git" \
  --git "$PINNED_GIT" \
  --lock "$PWD/test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml" \
  --run-root "$PWD/.oculory/runs-external" \
  --run-id git-gate-e1-scripted-20260712T033640Z \
  --trials 3
```

It returned zero with `gate_e1: completed`, 60 sessions, the exact label counts above, zero unstable scenarios, ten unapproved candidates, and elapsed time 215,083.779916 ms.

Validation performed around the implementation and evidence work:

- Baseline before implementation: 361/361 ordinary tests, build passed, doctor passed.
- Implementation, evidence hardening, and candidate-identity repair validation: 371/371 ordinary tests, build passed, doctor passed.
- Existing deterministic scripted regressions: task, filesystem, and issue-tracker experiments each returned `meaningful_technical_success`; these were preservation regressions, not external Gate E mutation experiments.
- Post-run independent audit: 251/251 checksum-manifest entries passed; 60/60 envelopes, traces, referenced sidecars, and JSON Pointers validated; candidate IDs/predicates survived trace-ID permutation.
- Post-documentation validation: 371/371 ordinary tests, build passed, doctor passed.
- Diagnostic/insufficient attempts: one failed preflight with zero sessions and no run directory; two preserved 60-session runs rejected during adversarial audit; one separately identified authoritative 60-session attempt from the final clean repair commit.

## Evidence integrity

| Measure | Result |
|---|---|
| Historical `.oculory/runs-live` before/after files | 81 / 81 |
| Before manifest digest | `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e` |
| After manifest digest | `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e` |
| Manifest diff | Empty; diff-file SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| External run files | 252 total; 251 checksum entries cover every file except `checksums.sha256` itself |
| External run exact file bytes | 9,865,522 |
| Checksum-manifest SHA-256 | `e4315aa8c1fae1d037601a7306e4b6900457d2ca02a57a91eefaa376676700a0` |
| Run-manifest SHA-256 | `43de1d0be709445710f8a039b92b506462202e24a4dc0282662ef477a3d54f15` |
| Missing/corrupt evidence | 0 / 0 |
| Evidence-complete terminal records | 60/60 |

Historical evidence was not modified. The authoritative evidence is finalized and append-only.

## Decision rationale

Gate E1 is **completed** because all 20 scenarios ran for exactly three cold trials, all 60 trials matched goldens, no instability or unknown outcome remained, every cleanup and sentinel check passed, all evidence validated, mining accessed only eligible mining traces, support was measured by distinct scenarios, hostile constant-leakage and holdout-isolation tests passed, leave-one-out analysis completed, a candidate-review package was produced, and no candidate was auto-approved.

Gate E remains **pending** because no human has approved candidate IDs, no suite has been compiled, no replay has run, and no target/adapter/verifier/transport/fixture mutation campaign has been performed. The exact next action is human review of the ten named candidate IDs. A later explicit Gate E2 prompt must provide the approved IDs before any approval, suite, replay, or mutation work begins.

## Scope, limitations, and non-claims

- No model/provider call, API key, credential, remote, real repository, push, or tag was used.
- No candidate was approved; no suite was compiled; no replay or external mutation experiment occurred.
- No Gate F work occurred, and Gate E is not claimed passed.
- The result covers one pinned independently maintained Git MCP release, one macOS-arm64 host, one Python/runtime lock, one Git version, a narrow safe tool subset, scripted policies, 20 scenarios, and three trials each.
- It does not establish cross-platform compatibility, broader release compatibility, model behavior, production safety, security certification, performance, benchmark leadership, or developer adoption.
- The ten candidates are review inputs, not truth. Exact-call-path candidates are particularly likely to encode driver style.
- Local run evidence is gitignored. Losing `.oculory/runs-external` would reduce direct auditability even though this document retains hashes and aggregate findings.

## Subsequent status

Gate E2 was later explicitly authorized and passed. See `docs/40_GIT_MCP_GATE_E_REPLAY_AND_MUTATION.md`; this link does not alter the Gate E1 measurements or decision recorded above.
