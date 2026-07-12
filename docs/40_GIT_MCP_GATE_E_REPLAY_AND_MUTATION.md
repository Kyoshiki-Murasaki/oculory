# 40 — Git MCP Gate E replay and mutation validation

_Gate E2 evidence record, 2026-07-12. This record covers the explicit human review, deterministic suite compilation, fresh clean replay, eligible holdout evaluation, preregistered layer-separated mutation campaign, benign controls, and evidence-integrity audit. It does not authorize or report Gate F or model traffic._

## Executive decision

**Gate E passed.** The authoritative run `git-gate-e2-replay-mutation-20260712T092246Z`, from clean commit `e1f015f15337bd8c27df15a07f791a0615ae18a6`, completed 24/24 fresh clean replay sessions, detected all 34 harmful mutations in all three canonical trials, and produced zero false positives across all five benign controls and their 15 trials. Suite, independent golden-verifier, transport, and fixture/cleanup detection are reported separately below.

The final gate chronology is: Gate A passed; formal Gate B attempt 1 failed and remains preserved; formal Gate B attempt 2 passed and is current; Gate C passed; Gate D passed; Gate E1 completed; Gate E passed. Gate F was not started, and no external-target model/provider traffic occurred.

The strongest eligible claim is:

> Oculory operated against one pinned external official-reference MCP implementation over stdio with deterministic disposable fixtures, independent per-step verification, a human-reviewed mined suite, clean eligible-holdout replay, and controlled layer-separated mutation evidence.

## Provenance and chronology

| Item | Value |
|---|---|
| Starting branch / commit | `master` / `0b32fbbdf255626cc175e271a4cd8c3e4d72db80` |
| Review artifact | `reviews/git-gate-e1-candidate-review-v1.json` |
| Review artifact SHA-256 | `1304d9828d116581fec1692ef75ae7a3f04ff02ef09153b484f68d006875947b` |
| Candidate package SHA-256 | `ec1b4f9f870fb5fef68aa5994dc932d8e4157b52b739097cead1aca684854740` |
| Initial implementation commit | `baefb356626a46a31728d1d5295eb1c933f51f68` (`Add approved Git MCP replay and mutation suite`) |
| Cleanup defect repair | `53589b5d70a181129d851fe2f771e6c381644e1a` (`Fix Gate E2 temporary-root cleanup`) |
| Transcript-evidence repair / authoritative-run commit | `e1f015f15337bd8c27df15a07f791a0615ae18a6` (`Normalize Gate E2 transport transcript evidence`) |
| Authoritative source-tree digest | `5a29cd2611471498865c6a1a3723688e03a8a2da9d5b52ab62f32b1b2cc3e345` |
| Authoritative source status | clean; `dirty: false` |
| Authoritative run | `git-gate-e2-replay-mutation-20260712T092246Z` |
| Gate E decision | `passed` |

The runner refused dirty source and existing run IDs. The registry was committed before any authoritative mutation execution and was re-hashed after the campaign. Failed attempts were retained under their original IDs; no canonical trial was replaced with a retry.

## Human review

The reviewer is `Dev`. The decision source is exactly `explicit human candidate-ID authorization in the Gate E2 task prompt`; `cryptographicSignatureClaim` is `false`.

Approved exactly:

- `git-cand-514fac8b126e`
- `git-cand-5f985ca6af7d`
- `git-cand-6d85a493c006`
- `git-cand-7795e229e945`
- `git-cand-970b53354b15`
- `git-cand-ad763acaa2e6`
- `git-cand-e1226b984f8c`
- `git-cand-f0b0aa748842`

Rejected from the blocking suite and retained as advisory evidence:

- `git-cand-18ea17797c83`
- `git-cand-ee04c8e75603`

The rejected candidates encode exact observed scripted path alternatives; leave-one-out analysis narrowed those paths; they may encode driver style rather than necessary semantics; approving them would risk rejecting valid alternate trajectories. No absent, unreviewed, rejected, holdout-derived, smoke-derived, or adversarial-derived candidate entered the suite.

## Compiled suite

The deterministic compiler `git-suite-compiler-v1` produced `git-suite-v1`, version 1, digest `39b1d5065b4c058d9762683cac5abb8f2a47c31ae97e4929ef64ec5a68498290`. Authoritative deterministic recompilation matched the tracked serialization byte-for-byte.

The blocking stage contract `git-stage-contract-v1`, digest `8d6767e0a14be530996c9f1cb2d65406f06f50048ac167219ee4771dd4e68865`, requires:

- `git_add`;
- `git_add.files[0] == @entity:path`;
- the intended index entity's blob equals the worktree blob, with changed-index cardinality one;
- zero tool errors, `verified_success`, and zero unexpected changed layers.

It deliberately permits non-exhaustive paths, including direct `git_add`, `git_status → git_add`, and `git_diff_unstaged → git_add → git_diff_staged`.

The blocking branch contract `git-branch-create-contract-v1`, digest `bdd4360f65c68a9e84500d1b65db29bd952207e3edbce2853700721eeaaa7cfa`, requires:

- `git_create_branch`;
- `git_create_branch.branch_name == @entity:branch`;
- exactly one intended ref at initial HEAD with symbolic HEAD unchanged;
- zero tool errors, `verified_success`, and zero unexpected changed layers.

It permits direct `git_create_branch` and `git_branch → git_create_branch`. Neither rejected exhaustive-path candidate is present.

The suite binds the exact E1 run and candidate package, review digest, 18 source trace IDs, six mining scenarios, `mcp-server-git==2026.7.10`, wheel/source/executable/lock hashes, 12-tool inventory and schemas, `git-scripted-adapter-v1`, `git-spike-seed-v1`, `git-verifier-v1`, `git-gate-e1-catalogue-v1`, `git-miner-v1`, `external-trace-v3`, normalization rules, serial three-trial replay policy, eligible holdout families, and E1 source commit `6270926be62286a15b540982cb74b4d34b65b020`.

## Runtime provenance

| Component | Authoritative value |
|---|---|
| Target | `mcp-server-git==2026.7.10` |
| Wheel SHA-256 | `6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5` |
| Installed source SHA-256 | `52325521ec8ec00297248fa03eaee6802b9cad3ec1e5bebee25971e1b897d56e` |
| Executable SHA-256 | `a0160dc245aad4c31850be92af9b37b32f00675ef2ab4644ab108ca9eed26bdc` |
| Dependency lock SHA-256 | `5f7f42f1f4b40051836ce7a308e8e4206a87032edf9bc4cc19e9e2ec75a02b63` |
| Python / distributions | 3.12.13 / 33 exact locked distributions |
| Node / Git | v26.4.0 / 2.55.0 |
| OS / architecture | Darwin 25.4.0 / arm64 |
| Adapter / verifier | `git-scripted-adapter-v1` / `git-verifier-v1` |
| Fixture | `git-spike-seed-v1`, digest `a70438e717458e60bbc7e060934cbfbead480d3ab8f2ebac0c013f13fcab4c6c` |

## Clean replay

Every row is three fresh cold sessions with a fresh process, fixture, and trial root. All sessions had complete schema-v3 evidence, clean process exit, CP-1 cleanup, unchanged sentinel, and no unexpected layer.

| Scenario | Partition / contract | Trials | Suite | Golden | Stable call path | Final state hash | Unexpected layers | Cleanup | Instability |
|---|---|---:|---|---|---|---|---|---|---|
| `git-stage-m1` | mining / stage | 3/3 | pass | `verified_success` 3/3 | `git_diff_unstaged → git_add → git_diff_staged` | `dcaa0fd22870400bd270bbc11ef7fffd728cdf5d6f390f11ce807c6932b8c878` | none | 3/3 | none |
| `git-stage-m2` | mining / stage | 3/3 | pass | `verified_success` 3/3 | `git_add` | `be2234e2f9cccb1d96ae71577f57e37c95991d56842633e2dbf1c04dcb658d9b` | none | 3/3 | none |
| `git-stage-m3` | mining / stage | 3/3 | pass | `verified_success` 3/3 | `git_status → git_add` | `18372364fd5903ce4e0d52cf7a0ad8601304901db54c0e5027b1755e3545b7c0` | none | 3/3 | none |
| `git-branch-m1` | mining / branch-create | 3/3 | pass | `verified_success` 3/3 | `git_create_branch` | `1ca779376038b69914a040eb28a9ccdf33868d58165e88b237508bf4230ac400` | none | 3/3 | none |
| `git-branch-m2` | mining / branch-create | 3/3 | pass | `verified_success` 3/3 | `git_create_branch` | `59592ea597c31460f6ec3fd046f8cfc1e15a5b0c83acb4c6fdf802e943e7b9e1` | none | 3/3 | none |
| `git-branch-m3` | mining / branch-create | 3/3 | pass | `verified_success` 3/3 | `git_branch → git_create_branch` | `29ed204e58f7327390ac85d7d430ec55758b3780c916f513d2c6e5b00c5aedec` | none | 3/3 | none |
| `git-stage-h1` | holdout / stage | 3/3 | pass | `verified_success` 3/3 | `git_status → git_add` | `4ada85381fff683c25f9fec6fefb6ef7c3168efd2f26077043672580798817c8` | none | 3/3 | none |
| `git-branch-h1` | holdout / branch-create | 3/3 | pass | `verified_success` 3/3 | `git_branch → git_create_branch` | `c5119305d6e06a27006f5d87fe646d0073388cf93e3c36506237ab9255a1757d` | none | 3/3 | none |

Aggregate clean metrics:

| Metric | Result |
|---|---:|
| Mining replay | 18/18, 100% |
| Eligible holdout replay | 6/6, 100% |
| Approved assertions | 100% |
| Independent golden verifier | 24/24, 100% |
| `verified_success` / unknown | 24 / 0 |
| Replay instability | 0/8 scenarios |
| Unexpected-layer sessions | 0/24 |
| Cleanup/sentinel/evidence/process failures | 0 |

## Holdout ordering and generalization

The suite digest was finalized at `2026-07-12T09:22:57.997Z`. Only afterward, at `2026-07-12T09:24:06.270Z`, the runner opened `git-stage-h1` and `git-branch-h1`; `orderingPassed` is true. The proof binds the same suite digest and records `suiteChangedAfterOpening: false`. Both eligible holdouts passed suite and independent golden checks in 3/3 trials with stable non-exhaustive paths. There was no generalization failure, and holdout evidence did not change the suite. `git-checkout-h1` and `git-reset-h1` were not incorrectly claimed as covered by these two contracts.

## Frozen mutation registry

The tracked registry contains exactly 39 entries: 34 harmful mutations and five benign controls. Harmful layer counts are exactly target 7, adapter 8, verifier 7, transport 6, fixture 6. Every entry has exactly three canonical trials. The tracked registry file SHA-256 bound before holdout and mutation execution is `5b80331562ce6e1c9b169d9324bfce2d273027c7a68764ee0be5301605252287`.

| ID | Layer / class | Mechanism digest | Designated scenario/evidence | Preregistered detector | Trials |
|---|---|---|---|---|---:|
| `target/add-silent-noop` | target / harmful | `ee13b1638a8882ae3e34adb6e2048a4b34c118135228678f61e06b5d81b29b32` | `git-stage-m1` | suite + golden | 3 |
| `target/add-wrong-file` | target / harmful | `15a14c45c7af705f2da14abe9b55d08e38e33aecc2f9800c90babbda99255442` | `git-stage-h1` | suite + golden | 3 |
| `target/reset-noop` | target / harmful | `7f0828a81aa2b14ed95d6766979d3ecfecf1dcd6d33ee7903cc290a2442c771b` | `git-reset-h1` | golden | 3 |
| `target/create-branch-wrong-base` | target / harmful | `cca812f7afdbe54ca3643fe83e0a1fa26e2b28eab65f09c23ee372a34ce540c0` | `git-branch-h1` | suite + golden | 3 |
| `target/checkout-wrong-branch` | target / harmful | `85bc7f52bbb6788fa5ccd75cca05c0f7408e1882ddafebffd4d1ad60cf75652b` | `git-checkout-h1` | golden | 3 |
| `target/repository-scope-bypass` | target / harmful | `015c29785e9ed4a1c9dbae9647e0929cc261d0e554a9027eb55117fab9f39781` | `git-outside-repository-a1` | golden + boundary | 3 |
| `target/error-as-success` | target / harmful | `c0c34f00206cb5f15cd40b3da5e0285616cddb9d608931c90854bedd286c9d49` | `git-missing-revision-a1` | golden | 3 |
| `adapter/files-array-stringified` | adapter / harmful | `668375a82d612e4f81153c3dfeddb4c781e709a459826ac167ec33f0a185d265` | `git-stage-h1` | suite + golden | 3 |
| `adapter/wrong-repo-path` | adapter / harmful | `52ade39d82407f4013f2e7b84d339989f39c5eb2933140e89c44d4cd21cf7b46` | `git-stage-m1` | suite + golden/boundary | 3 |
| `adapter/stale-tools-cache` | adapter / harmful | `4327ce620840d9876397191a8db4eb88dc98cb5482a2ad4c2c0e7e9769767774` | multi-page discovery fixture | discovery provenance | 3 |
| `adapter/drop-rpc-code` | adapter / harmful | `b6c6e6e7357bece691d723f5ae5c0a40331c6c58c87440c1849a10cd0516a1fd` | JSON-RPC error fixture | raw/normalized binding | 3 |
| `adapter/ignore-is-error` | adapter / harmful | `27645e745428e8bad6225e6914288d7933328580a397899865446c1c8fbf62af` | `git-missing-revision-a1` | golden | 3 |
| `adapter/duplicate-call` | adapter / harmful | `72ae1b72744e5d0617f288675f1aed9bf3ed3c597a52d7615ee0adec26a26802` | `git-stage-m2` | suite + golden | 3 |
| `adapter/swallow-transport-failure` | adapter / harmful | `22ea045570885d802c3b3edf509bdb6aa12b62e39b13980250a5fa4c4417d669` | malformed-JSON fixture | transport transcript | 3 |
| `adapter/wrong-result-normalization` | adapter / harmful | `cc72e16ebf9b405341692d61b1b1fbb5b3c347a30854dc0a51ac4c4c83edcb66` | `git-existing-branch-a1` | golden | 3 |
| `verifier/final-hash-only` | verifier / harmful | `0cb8a7885c1636e12f74c297c62ffa78231b59e1a8f0cd1ca1b3a45790147489` | verifier case A22 | independent meta-oracle | 3 |
| `verifier/ignore-index` | verifier / harmful | `9a7a868c334f791730e8bb5ff126d499956caeba954603348a77ec7c8d153138` | verifier case A34 | independent meta-oracle | 3 |
| `verifier/ignore-unexpected-ref` | verifier / harmful | `c90b9895403a66a90eb44e25d7c9c540a8a3d462c2c1873b26ba7adaec155ff5` | verifier case A12 | independent meta-oracle | 3 |
| `verifier/trust-success-text` | verifier / harmful | `f7fd74fadbcdc1a466fdef82ca7128c750363ce74796650c847f33bee05eb302` | verifier case A34 | independent meta-oracle | 3 |
| `verifier/global-no-tool-rejection` | verifier / harmful | `8df390c735e74cbcdd860509d1c169cc5a0804c2895321a0fbb6d5936952e444` | verifier case A10 | independent meta-oracle | 3 |
| `verifier/wrong-entity-selector` | verifier / harmful | `1b70fa041ac3fcc69d5c0199495a2dff6c08df314cbe8cb52b331a2f08161fd6` | verifier case A11 | independent meta-oracle | 3 |
| `verifier/ignore-cleanup` | verifier / harmful | `afdddcaf1f5920495d5eb218f2dd2da8ec608c44fde52665533c63d2b8e42217` | verifier case A19 | independent meta-oracle | 3 |
| `transport/wrong-response-id` | transport / harmful | `457cd62f496d9364bafa455400c561c164e50361dfcd7bc23893cfe2156f56f6` | mismatched-ID fixture | transport integrity | 3 |
| `transport/non-protocol-stdout` | transport / harmful | `4d139e555a7665876e4cf89210c59a9d7e5a459bcd9edfea7569729022637c99` | stdout-contamination fixture | transport integrity | 3 |
| `transport/malformed-json` | transport / harmful | `164dc65da484bcfd97269801cd7b82be7f89d8364ccaaf1ccc1347d2ef6ad056` | malformed-JSON fixture | transport integrity | 3 |
| `transport/process-crash-after-mutation` | transport / harmful | `877abba40150ed77248e352e11e37dea5d468bc093d179a11d6d6a296dae4f7c` | `git-stage-m1` | transport + state + suite/golden | 3 |
| `transport/timeout-and-late-response` | transport / harmful | `447206062c86c50f3cc774bf113585fce1ef162bb0cdc50dc4a3fe48b15a94b0` | late-response fixture | timeout/cancellation transcript | 3 |
| `transport/cancellation-ignored` | transport / harmful | `e255f609542cc415034614d977eefd80153fd17e68d8217ca394fdb92c669dac` | ignored-cancellation fixture | timeout/cancellation + cleanup | 3 |
| `fixture/reuse-trial-root` | fixture / harmful | `86de67a2113c8633a294adf520fdbbf3bd64113410231738ca7e94063f60bfe9` | root-uniqueness ledger | fixture integrity | 3 |
| `fixture/reuse-server-process` | fixture / harmful | `b269c9758dd0293d8e857182338a9be9c50d54a9adf60e26911482b6fd9569d9` | process-uniqueness ledger | fixture integrity | 3 |
| `fixture/seed-overlay-omitted` | fixture / harmful | `185fd28ab34fae6d701c6c6fdf4b6d03ed280d020e7f980110c7d3ace9cd0ed1` | `git-stage-m1` | registered state + suite/golden | 3 |
| `fixture/outside-sentinel-changed` | fixture / harmful | `003afff0661465842b1013a7229bff612bfae41908acab6c6250bef981f43e17` | verifier case A17 | sentinel proof | 3 |
| `fixture/cleanup-residue` | fixture / harmful | `c782b9259293adc80dc0d2f2300abcce48ff4814ef2deabe9e180f0add8e16e7` | verifier case A19 | cleanup proof | 3 |
| `fixture/stale-index-lock` | fixture / harmful | `d00a4941fb1a1a5df1ad0b4a9bf5925fae9e8f5e3f18c5ffef18ee2dc20e101b` | lockfile snapshot | lockfile inspection | 3 |
| `control/transparent-target-wrapper` | target / control | `ce1de1fe28c561fa031b54e8483f266ebd3dd5789b7cb152bfa2f6839b4f1e37` | `git-stage-m2` | no regression | 3 |
| `control/presentation-only-result-prose` | target / control | `f962750db2f472c2ffd06633810a7b2f5169f0bf00c3219db419dc56d6ad9a9c` | `git-stage-m2` | no regression | 3 |
| `control/transport-out-of-order-valid-ids` | transport / control | `9db2c78afde6bc23b54a61a306f1a5884896cf0d7fd2c6d380fab6f2644d4287` | valid out-of-order fixture | no regression | 3 |
| `control/transport-split-and-coalesced-frames` | transport / control | `2fdce145b652c47d18d2f9abf9f8f3af2a1d4a23f262d5d09479c833968a3d28` | split + coalesced fixtures | no regression | 3 |
| `control/transport-notification-interleaving` | transport / control | `5a7c44650dff0c6bfc4c0dd939fc39c2a63c45f467b12680a1cebde22012e812` | notification fixture | no regression | 3 |

## Harmful mutation results

The four detection columns are counts out of three canonical trials: S = approved suite, G = independent golden verifier or verifier meta-oracle, T = transport/discovery integrity, C = fixture/cleanup/sentinel integrity. A zero means that channel was not applicable or did not fire; it is not reassigned to another layer.

| Mutation | S | G | T | C | Stable observed outcome | Result |
|---|---:|---:|---:|---:|---|---|
| `target/add-silent-noop` | 3 | 3 | 0 | 0 | `verified_failure` | detected 3/3 |
| `target/add-wrong-file` | 3 | 3 | 0 | 0 | `verified_failure` | detected 3/3 |
| `target/reset-noop` | 0 | 3 | 0 | 0 | `verified_failure` | detected 3/3 |
| `target/create-branch-wrong-base` | 3 | 3 | 0 | 0 | `partial_success` | detected 3/3 |
| `target/checkout-wrong-branch` | 0 | 3 | 0 | 0 | `verified_failure` | detected 3/3 |
| `target/repository-scope-bypass` | 0 | 3 | 0 | 0 | `invalid_acceptance` | detected 3/3 |
| `target/error-as-success` | 0 | 3 | 0 | 0 | `invalid_acceptance` | detected 3/3 |
| `adapter/files-array-stringified` | 3 | 3 | 0 | 0 | `verified_failure` | detected 3/3 |
| `adapter/wrong-repo-path` | 3 | 3 | 0 | 0 | `verified_failure` | detected 3/3 |
| `adapter/stale-tools-cache` | 0 | 0 | 3 | 0 | `discovery_mismatch` | detected 3/3 |
| `adapter/drop-rpc-code` | 0 | 0 | 3 | 0 | `rpc_code_dropped` | detected 3/3 |
| `adapter/ignore-is-error` | 0 | 3 | 0 | 0 | `invalid_acceptance` | detected 3/3 |
| `adapter/duplicate-call` | 3 | 3 | 0 | 0 | `verified_failure` | detected 3/3 |
| `adapter/swallow-transport-failure` | 0 | 0 | 3 | 0 | `fabricated_success_after_transport_failure` | detected 3/3 |
| `adapter/wrong-result-normalization` | 0 | 3 | 0 | 0 | `invalid_acceptance` | detected 3/3 |
| `verifier/final-hash-only` | 0 | 3 | 0 | 0 | defective verifier returned `verified_success` | meta-oracle detected 3/3 |
| `verifier/ignore-index` | 0 | 3 | 0 | 0 | defective verifier returned `verified_success` | meta-oracle detected 3/3 |
| `verifier/ignore-unexpected-ref` | 0 | 3 | 0 | 0 | defective verifier returned `verified_success` | meta-oracle detected 3/3 |
| `verifier/trust-success-text` | 0 | 3 | 0 | 0 | defective verifier returned `verified_success` | meta-oracle detected 3/3 |
| `verifier/global-no-tool-rejection` | 0 | 3 | 0 | 0 | defective verifier returned `valid_rejection` | meta-oracle detected 3/3 |
| `verifier/wrong-entity-selector` | 0 | 3 | 0 | 0 | defective verifier returned `verified_success` | meta-oracle detected 3/3 |
| `verifier/ignore-cleanup` | 0 | 3 | 0 | 0 | defective verifier returned `verified_success` | meta-oracle detected 3/3 |
| `transport/wrong-response-id` | 0 | 0 | 3 | 0 | `unmatched_response` | detected 3/3 |
| `transport/non-protocol-stdout` | 0 | 0 | 3 | 0 | `stdout_contamination` | detected 3/3 |
| `transport/malformed-json` | 0 | 0 | 3 | 0 | `malformed_json` | detected 3/3 |
| `transport/process-crash-after-mutation` | 3 | 3 | 3 | 0 | `verified_failure` | detected 3/3 |
| `transport/timeout-and-late-response` | 0 | 0 | 3 | 0 | `request_timeout`, late response retained | detected 3/3 |
| `transport/cancellation-ignored` | 0 | 0 | 3 | 0 | `request_timeout`, cancellation unacknowledged | detected 3/3 |
| `fixture/reuse-trial-root` | 0 | 0 | 0 | 3 | `duplicate_identity_detected` | detected 3/3 |
| `fixture/reuse-server-process` | 0 | 0 | 0 | 3 | `duplicate_identity_detected` | detected 3/3 |
| `fixture/seed-overlay-omitted` | 3 | 0 | 0 | 0 | `verified_success` but blocking suite failed | detected 3/3 |
| `fixture/outside-sentinel-changed` | 0 | 0 | 0 | 3 | `verified_failure` | detected 3/3 |
| `fixture/cleanup-residue` | 0 | 0 | 0 | 3 | `verified_failure` / cleanup proof | detected 3/3 |
| `fixture/stale-index-lock` | 0 | 0 | 0 | 3 | `stale_lock_detected` | detected 3/3 |

All 102 harmful canonical trials had complete evidence, stable expected detection, and matched a preregistered detector. There were no unclassified outcomes and no mutation-induced `unknown` labels. Some preregistered verifier labels were deliberately coarse: wrong-base was stably `partial_success` rather than `verified_failure`; process-crash was conclusively `verified_failure` rather than `unknown`; omitted overlay remained a golden `verified_success` but failed its preregistered blocking suite check. These are stronger or more specific classified detections in the expected direction, not clean passes or post-hoc detectors.

## Benign controls

| Control | Trials | Suite | Golden/transport semantic result | Unexpected state | Cleanup | False positive |
|---|---:|---|---|---|---|---|
| `control/transparent-target-wrapper` | 3/3 | pass 3/3 | `verified_success` 3/3 | none | clean 3/3 | no |
| `control/presentation-only-result-prose` | 3/3 | pass 3/3 | `verified_success` 3/3 | none | clean 3/3 | no |
| `control/transport-out-of-order-valid-ids` | 3/3 | not applicable | correlated `verified_success` 3/3 | none | clean 3/3 | no |
| `control/transport-split-and-coalesced-frames` | 3/3 | not applicable | framing success 3/3 | none | clean 3/3 | no |
| `control/transport-notification-interleaving` | 3/3 | not applicable | interleaving success 3/3 | none | clean 3/3 | no |

All 15 control trials had all four detection channels false. Controls passing: 5/5; false-positive count: 0; false-positive rate: 0%; instability: 0; unexpected state: 0.

## Layer metrics

| Layer | Harmful registered | Detected | Detection rate | Trial stability | Unclassified |
|---|---:|---:|---:|---|---:|
| Target | 7 | 7 | 100% | all 21 trials detected | 0 |
| Adapter | 8 | 8 | 100% | all 24 trials detected | 0 |
| Verifier | 7 | 7 | 100% | all 21 trials meta-oracle-detected | 0 |
| Transport | 6 | 6 | 100% | all 18 trials detected | 0 |
| Fixture/cleanup | 6 | 6 | 100% | all 18 trials detected | 0 |
| **Overall** | **34** | **34** | **100%** | **102/102** | **0** |

The benign-control false-positive rate is 0/5 controls and 0/15 trials, both 0%.

## Authoritative command and validation

```sh
npm run test:external-git-gate-e2 -- \
  --python /private/tmp/oculory-git-gate-ab-runtime/bin/python \
  --executable /private/tmp/oculory-git-gate-ab-runtime/bin/mcp-server-git \
  --git /opt/homebrew/bin/git \
  --lock "$PWD/test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml" \
  --e1-run "$PWD/.oculory/runs-external/git-gate-e1-scripted-20260712T033640Z" \
  --review "$PWD/reviews/git-gate-e1-candidate-review-v1.json" \
  --suite "$PWD/suites/external/git/git-suite-v1.json" \
  --registry "$PWD/mutations/external/git/git-gate-e2-mutation-registry-v1.json" \
  --run-root "$PWD/.oculory/runs-external" \
  --run-id git-gate-e2-replay-mutation-20260712T092246Z \
  --replay-trials 3 \
  --mutation-trials 3
```

The command returned zero with `gate_e: passed` after 288,424.77825 ms. Before each authoritative attempt, ordinary `npm test`, `npm run build`, and `./bin/oculory doctor` passed from a clean committed tree. The ordinary suite contains 395 offline, model-free, credential-free tests. An additional local diagnostic exercised all 11 transport modes used by Gate E2 and verified canonical transcript evidence plus clean closure; it made no model or external provider call.

Two failed attempts remain preserved:

1. `git-gate-e2-replay-mutation-20260712T090822Z`, from the initial implementation commit, completed all 24 clean sessions and wrote 27 mutation records before an empty-directory `rm` defect masked the transport-transcript hashing error. It remains 147 files and 4,235,092 bytes with its own saved external checksum manifest.
2. `git-gate-e2-replay-mutation-20260712T091549Z`, from the cleanup-repair commit, again completed all 24 clean sessions and wrote 27 mutation records, then exposed the primary `undefined` optional-field transcript hashing error. It also remains 147 files and 4,235,092 bytes with its own saved external checksum manifest.

Neither failed run has a finalized Gate decision or checksum file, neither was overwritten, and neither supplied replacement trials to the authoritative run.

## Evidence integrity

The authoritative root contains 250 files and exactly 4,426,004 bytes. Its 249-entry `checksums.sha256` covers every other file and has SHA-256 `0c48c6d2543adf69837cdc7781547681893eac6e86ddcd72f39ce83a34deabba`. Independent `shasum -a 256 -c` verification passed 249/249; missing/corrupt evidence count is 0.

The three external roots that existed before Gate E2 remain byte-identical:

| Existing root | Files | Exact bytes | Saved-manifest digest | Result |
|---|---:|---:|---|---|
| `git-gate-e1-scripted-20260711T171641Z` | 252 | 9,870,846 | `c69b4d9de4ad6ebdebb852ba4fc8c54ff20b66ce8c902760334684fc20e6b4d3` | unchanged |
| `git-gate-e1-scripted-20260712T033132Z` | 252 | 9,865,520 | `16606e91ffe0e628d25ad91365f3094291b3b02be897b83c92cd71593b0b2428` | unchanged |
| `git-gate-e1-scripted-20260712T033640Z` | 252 | 9,865,522 | `80d3a61da3dbc92e12fab5beebff33fc491e0d73952be802be86eb4687a3387c` | unchanged |

Existing external roots unchanged: 3/3. Both failed Gate E2 attempts also matched their post-failure saved manifests after the authoritative run.

Historical `.oculory/runs-live` remained exactly 81 files. The before and after manifest digests are both `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e`; the manifest diff is empty.

## Decision rationale

Gate E passes because the exact human decisions were recorded, only the eight approved candidates were compiled, deterministic compilation and provenance binding passed, all 18 mining and six eligible holdout sessions passed both suite and independent golden verification, clean unknown/instability/cleanup/evidence rates were zero, every one of 34 registered harmful mutations was detected by a preregistered channel in all three trials, every result remained layer-separated, all five benign controls passed all three trials with zero false positives, and every historical evidence root remained byte-identical.

No criterion is waived and this is not a “pass with caveats.”

## Limitations and non-claims

- Evidence covers one pinned independently maintained official-reference Git MCP release on one macOS-arm64 host, one Python lock, one Git version, a narrow safe subset, scripted policies, and three trials per case.
- Mutation wrappers, protocol fixtures, and verifier meta-oracles simulate controlled regressions; they are not claims of upstream vulnerabilities.
- Several layer-specific outcomes are purpose-built classifications rather than external trace-v3 golden labels; channel separation prevents treating transport or cleanup detection as target-suite sensitivity.
- The target was not tested across operating systems, architectures, releases, alternate clients, or real developer repositories.
- No production readiness, MCP conformance, security certification, penetration testing, benchmark superiority, performance, adoption, market demand, or model reliability is established.
- Review was explicit but single-reviewer and local; multi-reviewer governance remains untested.
- Evidence roots are intentionally gitignored local artifacts. Losing them would reduce direct auditability even though this document retains identities and checksums.
- Gate F remains unstarted. No budget, model, provider, API key, or live-model execution was authorized by this work.

## Scope compliance and next action

No model/provider call, API key, credential, real repository, remote operation, installed-upstream in-place edit, unreviewed approval, Gate F execution, tag, push, or historical evidence modification occurred. Target mutations used run-local wrappers bound to the pinned source; fixtures were disposable and had no remotes.

The single next action is:

> Perform a final Phase 6 gate audit and freeze the external Git scripted milestone, then prepare a separately budgeted Gate F live-model proposal without executing model traffic.
