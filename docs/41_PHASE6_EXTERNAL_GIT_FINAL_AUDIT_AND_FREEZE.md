# 41 — Phase 6 external Git final audit and freeze

_Audit date: 2026-07-12. This report binds the audit to pre-freeze source commit `5ef4fa176fc5ac2e042f473a43ca2d57097269e7` on `master`. It does not contain or predict the hash of the commit that contains this report._

> Fresh-public-history note (2026-07-13): every branch, commit, tag, and publication reference in this report records the legacy/private chronology. Those refs were deliberately not imported into the fresh public repository. The current public history begins at `616ca96548e763ab3bb401f4626dcac2857a647b` on `main`.

## Executive decision

The pre-freeze repository, chronology, tracked artifacts, temporary Gate A–D reports, retained Gate B attempt-2 directory, 81-file historical live root, and all six immediate external evidence roots were independently inspected. No substantive implementation or evidence defect was found. The documentation, evidence index, and Gate F proposal are suitable for the audit-preparation commit.

The required local evidence archive and sidecar were created outside Git and passed extraction verification. The local freeze decision is **passed**, subject only to recording this final report/status update in the freeze commit and pointing the annotated tag `phase6-external-git-scripted-validated` at that commit. Publication remains separately conditional on unambiguous remote identity, permission, fast-forward proof, and tag-collision checks.

No model/provider call occurred. Gate F remains proposal-only.

## Audited repository baseline

| Item | Result |
|---|---|
| Branch | `master` |
| Audited source commit | `5ef4fa176fc5ac2e042f473a43ca2d57097269e7` — `Document Git MCP Gate E validation` |
| Worktree / index | clean / clean |
| Remotes | none |
| Tag at audited HEAD | none |
| Git integrity | `git fsck --full` passed; two unreachable tree objects were reported as dangling, not corrupt |
| Ordinary tests | 395 passed before audit changes |
| Build | passed |
| Doctor | passed |

The three filenames abbreviated in the audit brief resolve to the tracked files `docs/07_ASSERTION_MINING_SPECIFICATION.md`, `docs/08_REVIEW_AND_APPROVAL_WORKFLOW.md`, and `docs/21_FINAL_TECHNICAL_AUDIT.md`. This was a filename discrepancy in the brief, not missing repository content.

## Phase 6 commit chronology

The named commits exist in one ancestry chain and have the expected messages and roles:

| Commit | Role |
|---|---|
| `b2bef39ef2d2c55c4ca8fc939d6943000ee01139` | generic asynchronous MCP stdio client foundation |
| `7055479b29b6e40f2a4ab99380bf473d7d3d157a` | pinned Git MCP direct-harness feasibility spike |
| `1b09ea14f473b34c37506d09e431e94ffa32c1a8` | Gate C transport integrity |
| `20573a0c4ec9d3ccff059cc118df91232a3a7c2a` | failed formal Gate B attempt documented |
| `a6e77e933592b21136139df6f4dd1013ef6030d9` | Gate B evidence finalization repaired and attempt 2 validated |
| `39454e3413cc7c56e8e6df97ea3e19e68184113c` | Gate D verifier semantics |
| `6270926be62286a15b540982cb74b4d34b65b020` | authoritative Gate E1 implementation source |
| `0b32fbbdf255626cc175e271a4cd8c3e4d72db80` | final Gate E1 evidence chronology |
| `baefb356626a46a31728d1d5295eb1c933f51f68` | approved replay and mutation suite implementation |
| `53589b5d70a181129d851fe2f771e6c381644e1a` | Gate E2 runner cleanup repair |
| `e1f015f15337bd8c27df15a07f791a0615ae18a6` | transport evidence repair and authoritative Gate E2 source |
| `5ef4fa176fc5ac2e042f473a43ca2d57097269e7` | final Gate E documentation |

Additional intermediate Phase 6 commits are preserved in the history and were inspected through the complete Phase 6 changed-file set. No history was rewritten or reassigned.

## Gate decisions and provenance

### Gate A — passed

The retained evidence supports `mcp-server-git==2026.7.10`, wheel SHA-256 `6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5`, sdist SHA-256 `95107b8b2989814e8c230e8e489feef4bfa4d80ca4a7ac1612cea05283ff5ea5`, installed source SHA-256 `52325521ec8ec00297248fa03eaee6802b9cad3ec1e5bebee25971e1b897d56e`, executable SHA-256 `a0160dc245aad4c31850be92af9b37b32f00675ef2ab4644ab108ca9eed26bdc`, MIT license, real stdio entry point, no credentials or remote service, and local disposable execution. The runtime is CPython 3.12.13, uv 0.11.23, Git 2.55.0, Node 26.4.0, Darwin arm64, with 33 exact hash-bound distributions and lock SHA-256 `5f7f42f1f4b40051836ce7a308e8e4206a87032edf9bc4cc19e9e2ec75a02b63`.

### Gate B — current result passed on attempt 2

> Attempt 1 failed and remains preserved. Attempt 2 passed after evidence-finalization repair and is the current formal Gate B result.

Attempt 1 reached cleanup, where the native `git remote` inspection exceeded its unchanged 5,000 ms bound. The legacy throwing path did not finalize the trial identity, journal, liveness, sentinel, or cleanup record. Later diagnostics do not replace this historical failure.

The repair added atomic terminal records, file and directory synchronization, atomic rename, recovered-record fallback, ordered primary and secondary failures, disk-reconstructed aggregation, and fail-closed rejection of missing, duplicate, corrupt, partial, or incomplete evidence.

Attempt 2, `formal-gate-b-attempt-2-20260711T065958Z`, completed 60 materializations and 100 direct sessions with 160/160 terminal passes. It ran from source HEAD `20573a0c4ec9d3ccff059cc118df91232a3a7c2a` on a dirty source tree bound to digest `ee9547f84071cdae9c3c87d76cc75cd17a9d065a33f7449e265910307fe6f913`. It is not attributed to the later clean repair commit.

### Gate C — passed

Twenty consecutive fresh target sessions requested and negotiated protocol `2025-11-25`, retained stable server identity/capabilities and the complete 12-tool inventory, completed 20 successful `git_status` calls and 20 expected missing-revision `git_show` errors with unchanged-state proof, and had zero malformed protocol lines, unmatched or duplicate IDs, unexpected stdout, stderr bytes, transcript truncations, cleanup failures, or process leaks. All 20 exited gracefully. Deterministic transport-fault coverage also passed. The run used source commit `7055479b29b6e40f2a4ab99380bf473d7d3d157a`, dirty tree digest `15d832abea450e92833ce8e387101bbde3f95b1e4f2a5c969918536cdfde1ef5`.

### Gate D — passed

`git-verifier-v1` separated all six primary outcomes and represented transient mutation as `verified_failure` / `transient_mutation`. All 37 authored cases, 19 controlled trace mutations, and 12 defective-verifier controls matched their declared results. State outranked prose and `isError`; restored final state did not erase intermediate mutation; no-tool refusal remained scenario-specific; serialization, result digests, reason order, path/timestamp independence, and evidence references were deterministic and complete as declared. The offline report used clean commit `39454e3413cc7c56e8e6df97ea3e19e68184113c`, source-tree digest `98d9dedbbc73eb9b98bc3ff51c090a8acff32d5ad734093774b8d565f5104d32`.

### Gate E1 — completed

The authoritative run used `external-trace-v3`, content-addressed sidecars, append-only external storage, catalogue `git-gate-e1-catalogue-v1`, and miner `git-miner-v1`. The catalogue contains 20 scenarios partitioned 2 smoke, 6 mining, 4 holdout, and 8 adversarial. Sixty cold sessions produced 42 `verified_success`, 18 `valid_rejection`, and no other outcome, instability, cleanup, sentinel, evidence, process, or protocol failure.

Only the 18 traces from six mining scenarios were opened by the miner. Distinct-scenario support, hostile constant-leakage tests, actual leave-one-scenario-out re-mining, holdout isolation, and trace-order-independent identity passed. Ten candidates remained unapproved at the E1 boundary. Candidate package SHA-256 is `ec1b4f9f870fb5fef68aa5994dc932d8e4157b52b739097cead1aca684854740`.

### Gate E review and compiled suite

Reviewer `Dev` approved exactly eight candidates and rejected the two exhaustive path candidates `git-cand-18ea17797c83` and `git-cand-ee04c8e75603`. Review artifact SHA-256 is `1304d9828d116581fec1692ef75ae7a3f04ff02ef09153b484f68d006875947b`; it makes no cryptographic-signature claim.

Compiler `git-suite-compiler-v1` produced `git-suite-v1`, semantic suite digest `39b1d5065b4c058d9762683cac5abb8f2a47c31ae97e4929ef64ec5a68498290`. Deterministic recompilation passed. The stage contract requires `git_add`, the intended path argument, exactly one intended index entity, verified success, no errors, and no unexpected layer. The branch contract requires `git_create_branch`, the intended branch argument, exactly one intended ref at initial HEAD, unchanged HEAD, verified success, no errors, and no unexpected layer. Neither contract includes an exhaustive driver-path assertion.

### Gate E — passed

The suite was finalized before `git-stage-h1` and `git-branch-h1` were opened. Eighteen mining and six eligible holdout sessions passed both suite and independent golden verification, for 24/24 clean sessions with zero unknowns, instability, unexpected layers, or cleanup/sentinel/process/evidence failures. Checkout and reset holdouts are not claimed as covered by the two compiled contracts.

The frozen mutation registry has 39 entries: 34 harmful and five benign controls, with harmful layer counts target 7, adapter 8, verifier 7, transport 6, and fixture/cleanup 6. All 34 harmful mutations were detected in 102/102 trials by their preregistered direction; no mutation-induced unknown or unclassified outcome occurred. All five benign controls and 15/15 trials passed with zero suite, golden, transport, or cleanup false positives. These mutations are controlled simulations, not upstream vulnerability findings.

## Authoritative and retained run inventory

The deterministic index contains 13 records: five authoritative Gate B–E run/corpus identities, the Gate A/B diagnostic spike, failed Gate B attempt 1, the canonical-count Gate B diagnostic, the Gate E1 zero-session preflight, two insufficient E1 roots, and two incomplete E2 attempts. Summary:

| Run | Status | Source / tree | Files / bytes | Checksums | Terminal evidence | Decision |
|---|---|---|---:|---:|---:|---|
| Gate A/B bounded spike | diagnostic | `b2bef39` / dirty, digest not recorded | 1 / 9,080,085 | report digest | 30/30 | bounded spike passed |
| `formal-gate-b-attempt-1` | failed | `1b09ea1` / dirty `f43ae2…` | 0 / 0 finalized trial files | none | one attempted record incomplete | failed |
| Gate B finalized diagnostic | diagnostic | `1b09ea1` / dirty `f43ae2…` | 1 / 31,851,518 | report digest | 160/160 | did not supersede failure |
| Gate B attempt 2 | authoritative | `20573a0` / dirty `ee9547…` | 165 / 34,729,923 | 164/164 | 160/160 | passed |
| Gate C transport | authoritative | `7055479` / dirty `15d832…` | 1 / 6,236,587 | report digest | 20/20 | passed |
| Gate D verifier corpus | authoritative | `39454e3` / clean `98d9de…` | 1 / 54,800 | report digest | 56/56 corpus cases | passed |
| E1 `171447Z` | preflight | `a7d7d2f` / clean, digest not retained | 0 / 0 | none | zero sessions | failed preflight |
| E1 `171641Z` | diagnostic | `ae05d10` / clean `59e635…` | 252 / 9,870,846 | 251/251 | 60/60 | insufficient pointers/LOO |
| E1 `033132Z` | diagnostic | `f2138f5` / clean `d9f463…` | 252 / 9,865,520 | 251/251 | 60/60 | trace-order dependent |
| E1 `033640Z` | authoritative | `6270926` / clean `33a577…` | 252 / 9,865,522 | 251/251 | 60/60 | completed |
| E2 `090822Z` | failed/incomplete | `baefb35` / clean `e8f9ff…` | 147 / 4,235,092 | no finalized run manifest | 24 clean + 27 mutation records | cleanup defect masked hash error |
| E2 `091549Z` | failed/incomplete | `53589b5` / clean `d19241…` | 147 / 4,235,092 | no finalized run manifest | 24 clean + 27 mutation records | optional-field hash defect |
| E2 `092246Z` | authoritative | `e1f015f` / clean `5a29cd…` | 250 / 4,426,004 | 249/249 | 24 clean + 117 mutation/control records | Gate E passed |

No retained root was overwritten. The full per-record purpose, version, digest, binding, counts, decision, documentation reference, and limitations are in the evidence index.

## Evidence integrity

### Historical live evidence

- Files: 81.
- Exact bytes: 3,420,840.
- Sorted SHA-256 manifest digest: `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e`.
- Every file was readable.
- The manifest is byte-identical to retained Gate E1 and Gate E2 before/final manifests.

### External roots

There are exactly six immediate child directories under the external run root. All three E1 checksum manifests verify 251/251. The authoritative E2 manifest verifies 249/249. The two failed E2 roots have no finalized in-root checksum manifest, which is correctly classified as historical incompleteness; each root nevertheless matches its retained 147-entry post-failure external manifest byte-for-byte.

| Root | Files | Bytes | In-root manifest SHA-256 | Current verification |
|---|---:|---:|---|---|
| E1 `171641Z` | 252 | 9,870,846 | `5fbadcb729678168e3975b92b3e9c968700e550576c00de6421710cda68134b7` | 251/251 passed; saved full-root manifest unchanged |
| E1 `033132Z` | 252 | 9,865,520 | `02a3cd89bc0ac10f094e3800e9cde986e7b32112da06896371e4471f373cb0bc` | 251/251 passed; saved full-root manifest unchanged |
| E1 `033640Z` | 252 | 9,865,522 | `e4315aa8c1fae1d037601a7306e4b6900457d2ca02a57a91eefaa376676700a0` | 251/251 passed; saved full-root manifest unchanged |
| E2 `090822Z` | 147 | 4,235,092 | none | saved 147-entry post-failure manifest unchanged |
| E2 `091549Z` | 147 | 4,235,092 | none | saved 147-entry post-failure manifest unchanged |
| E2 `092246Z` | 250 | 4,426,004 | `0c48c6d2543adf69837cdc7781547681893eac6e86ddcd72f39ce83a34deabba` | 249/249 passed |

Missing evidence count and corrupt evidence count are zero for every finalized authoritative root. The failed E2 roots remain incomplete rather than retroactively finalized.

## Evidence index

- Path: `docs/evidence/phase6-external-git-evidence-index-v1.json`.
- Schema: `oculory-phase6-external-git-evidence-index-v1`.
- Audited source: `5ef4fa176fc5ac2e042f473a43ca2d57097269e7`, clean `master`.
- Run records: 13.
- Gate records: 6.
- SHA-256: `ee4a0c00878bd0ea7d17268882c9801201d490a336dd6248608568992eca487e`.
- Serialization: recursive key-sorted canonical JSON plus one LF.
- Validator: rejects duplicate run IDs/authoritative identities, missing required or malformed digests, impossible status/decision/count combinations, missing documentation, inconsistent candidate/review/suite/registry bindings, absolute paths, and noncanonical serialization.

The index deliberately binds the audited pre-freeze source commit, not a future commit containing the index.

## Claim audit

The README, current-status documents, Gate reports, review, suites, registry, source comments, and tests were searched for production, security, vulnerability, conformance, certification, compatibility, ecosystem, reliability, robustness, benchmark, superiority, model, adoption, customer, market, and upstream-defect language.

Historical reports were left intact where they accurately describe point-in-time plans, evidence, and explicit non-claims. Current repository-facing wording was tightened because the old README still described Phase 6 as planning and the external target as an unclosed gap. It now states the completed scripted chronology, the strongest evidence-supported claim, raw-evidence location, Gate F status, and explicit limits.

Strongest supportable claim:

> Oculory operated against one pinned external official-reference MCP implementation over stdio with deterministic disposable fixtures, independent per-step verification, a human-reviewed mined suite, clean eligible-holdout replay, and controlled layer-separated mutation evidence.

Explicit non-claims preserved:

- not production readiness;
- not MCP conformance;
- not security certification;
- not evidence of an upstream vulnerability;
- not broad external-server compatibility;
- not cross-platform validation;
- not external-target model reliability;
- not developer adoption, customer validation, or market validation;
- not benchmark superiority.

## Publication-safety audit

Tracked content, ignored state, and the proposed publication set were inspected for API keys, GitHub tokens, cloud credentials, private keys, `.env` files, machine-local paths, raw evidence, caches, environments, downloaded artifacts, and transcripts. No credential or credible secret exposure was found. Credential-shaped strings in tracked files are documented environment-variable names or explicit fake/test placeholders. Historical documents legitimately retain the paths that identify old temporary evidence; no new tracked artifact contains a machine-local absolute path.

Raw `.oculory` evidence, local archives, `node_modules`, build output, virtual environments, caches, downloaded wheels/sdists, and `.env*` remain ignored or outside the repository.

## Gate F

Gate F is specified only in `docs/42_GATE_F_LIVE_MODEL_PROPOSAL.md`. The proposal is provider-neutral, separately budgeted, and unexecuted. It does not authorize a key, provider, model, request, retry, scenario expansion, or paid call.

## Archive and freeze completion record

| Item | Verified result |
|---|---|
| Audit-preparation commit | `3e719a8057397e3788f8b9dd2a6daff178d1a47f` — `Prepare Phase 6 audit and Gate F proposal` |
| Local archive filename | `oculory-phase6-external-git-20260712T144630Z.tar.gz` |
| Archive exact bytes | 1,503,751 |
| Archive SHA-256 | `1a453ace4947c5723773ff9967c3ecb31f09fa679063dd311a4f7b4753de9841` |
| Sidecar | `oculory-phase6-external-git-20260712T144630Z.tar.gz.sha256`; standard check passed |
| Temporary extraction path | `<TEMP_ROOT>/oculory-phase6-archive-verify-20260712T144630Z`; removed after verification |
| Extraction layout | passed; required evidence, tracked artifacts, docs 34–42, index, lock, README, and metadata were present |
| Archived historical manifest | 81 files, 3,420,840 bytes, digest `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e`; exact source comparison passed |
| Archived external checksums | all six roots verified; four finalized in-root manifests passed and two failed E2 roots matched their retained post-failure manifests |
| Tracked-file comparison | review, three suite files, mutation registry, dependency lock, evidence index, and README matched source bytes |
| Credential/forbidden-file scan | passed; no credential-like file, `.git`, dependency/build tree, virtual environment, downloaded wheel/archive, or credible secret entered the archive |
| Evidence-index SHA-256 | `ee4a0c00878bd0ea7d17268882c9801201d490a336dd6248608568992eca487e` |
| Final local freeze decision | passed |

The raw evidence archive is local and was not committed or uploaded to GitHub. It will not be attached to a GitHub release. The annotated tag identifies the freeze commit; this report is not amended merely to insert its own containing commit hash.

## Freeze criteria

The archive-side criteria passed. Final validation requires tests, build, doctor, evidence-index validation, historical manifest, all finalized external checksum manifests, retained failed-run comparisons, archive sidecar, clean worktree/index after the freeze commit, unchanged evidence roots, and `git fsck --full`.

A failure in evidence integrity, implementation validity, archive extraction, or publication safety blocks the tag and push. A remote ambiguity or permission failure does not invalidate a completed local freeze, but blocks publication.

## Limitations

- one pinned external Git MCP release;
- one macOS-arm64 host, one exact Python lock, and one Git version;
- three trials per E1/E2 case;
- narrow reviewed stage and branch-create suite families;
- controlled mutation simulations rather than observed upstream defects;
- no syscall-level sandbox or runtime network monitor;
- raw evidence is local and gitignored;
- single-reviewer candidate approval;
- no cross-platform or alternate-external-target evidence;
- no external-target model reliability evidence;
- no production, security, adoption, customer, market, or benchmark evidence.
