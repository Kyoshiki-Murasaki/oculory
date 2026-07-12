# 36 — Git MCP formal Gate B deterministic direct harness

_Evidence record for the 2026-07-11 formal Gate B milestone. This is not Gate D/E evidence, model evidence, security certification, broad external compatibility, production readiness, or MCP conformance evidence._

## Decision

**Formal Gate B: failed.**

The finalized evidence-preserving run completed all 60 registered recipe materializations and all 100 direct sessions. Every recipe passed 20/20, every direct plan passed 10/10, discovery/result/targeted-state/final-state behavior was stable, all ten included tools were directly exercised, the two excluded tools remained discovery-only, and all cleanup/sentinel checks inside the finalized run passed.

Formal Gate B nevertheless fails because an earlier canonical attempt encountered a cleanup timeout: the exact native Git command used by `cleanupGitSpikeFixture` exceeded its existing five-second bound. The legacy cleanup path threw before returning a failed trial record, so that attempt also failed raw-evidence finalization. The later complete run cannot erase that observed cleanup/evidence-retention failure. No threshold, oracle, timeout, or normalization rule was weakened to obtain a pass.

The eligible finding is therefore narrower than a formal pass:

> The finalized diagnostic run reproduced all registered fixture and direct-path semantics at the canonical counts, but formal Gate B failed because a prior canonical attempt had a cleanup timeout and did not finalize its per-trial evidence.

## Execution and source provenance

| Field | Value |
|---|---|
| Execution date | 2026-07-11 |
| Oculory branch | `master` |
| Oculory HEAD used | `1b09ea14f473b34c37506d09e431e94ffa32c1a8` |
| Working tree during finalized run | Dirty with the uncommitted formal Gate B implementation; recorded explicitly |
| Source-tree digest | `f43ae2b9cc7bc77e5416b1d88a61735138e653f4e6342923c8d550acb491b600` |
| Temporary report schema | `oculory-git-formal-gate-b-temporary-v1` |
| Temporary report | `/tmp/oculory-git-formal-gate-b-report.json`; not committed |
| Report file SHA-256 | `d9c2eded1ca30b6cd26786b005ff28bdd60f434bb89cf809ae62c5fcb2192553` |
| Report pre-self-field digest | `131cb59fdd7254c0ff49e53b825e4058b5b5b955d1d4beef3f53ed2d099b3b13` |
| Finalized-run elapsed time | 440,716.25 ms |
| Diagnostic reruns recorded | 3 |

The report is temporary machine-readable evidence, not external trace schema version 3. It contains complete recipe snapshots, per-call journals, raw response/frame digests, normalized semantic evidence, shutdown records, cleanup proofs, aggregation, and the blocking attempt failures. It was written only under `/tmp`.

## Exact target, runtime, and lock

| Component | Verified value |
|---|---|
| Target | `mcp-server-git==2026.7.10` |
| Wheel SHA-256 | `6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5`; exact selected wheel hash remains bound in the committed lock and prior Gate A artifact evidence |
| Target executable SHA-256 | `a0160dc245aad4c31850be92af9b37b32f00675ef2ab4644ab108ca9eed26bdc` |
| Installed server source SHA-256 | `52325521ec8ec00297248fa03eaee6802b9cad3ec1e5bebee25971e1b897d56e` |
| Python | CPython `3.12.13` |
| uv | `0.11.23` (`3cdf50e09`, arm64-apple-darwin) |
| Git | `2.55.0` |
| Node | `v26.4.0` |
| OS / kernel / architecture | macOS 26.4.1; Darwin 25.4.0; arm64 |
| Lock | `test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml` |
| Lock SHA-256 | `5f7f42f1f4b40051836ce7a308e8e4206a87032edf9bc4cc19e9e2ec75a02b63` |
| Resolved distributions | 33 exact distributions; installed set matched the lock after PEP 503 name normalization |
| Lock drift | None observed; every selected distribution had at least one SHA-256; no unpinned or extra installed distribution |
| Local path in lock | None |
| Environment isolation | Explicit child allowlist; user site and unsafe import path disabled; no credentials, proxies, SSH agent, signing state, user Git configuration, remote, or user repository inherited |

The original wheel file was not retained as a standalone download. Current verification therefore binds the expected wheel digest through the unchanged committed lock, installed package identity/source/executable digests, and checksum-verified prior Gate A report. This is narrower than rehashing a newly downloaded wheel, and no runtime network access or artifact substitution was used.

## Exact command

The finalized evidence command was:

```bash
RUNTIME=<exact-hash-locked-disposable-runtime>
npm run test:external-git-formal-gate-b -- \
  --python "$RUNTIME/bin/python" \
  --executable "$RUNTIME/bin/mcp-server-git" \
  --git /opt/homebrew/bin/git \
  --lock "$PWD/test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml" \
  --output /tmp/oculory-git-formal-gate-b-report.json \
  --materializations 20 \
  --trials 10 \
  --diagnostic-reruns 3 \
  --prior-wrapper-failures 1 \
  --prior-cleanup-failures 1
```

The nonzero exit was expected from the retained formal `failed` decision. Gate C was not rerun because no generic MCP-client implementation changed.

## Formal Gate B definition

The canonical gate requires all of the following, without waiver:

1. each unique registered initial recipe reproduces one expected semantic state across 20 fresh materializations;
2. each of ten direct plans completes at least ten fresh cold-start trials with stable discovery, result classes, targeted independent state, final state, shutdown, and cleanup;
3. all ten included tools are directly exercised while `git_diff` and `git_commit` remain discovery-only;
4. successful mutation, successful no-change, expected-error, and unchanged-state rejection objectives are represented;
5. every cleanup/isolation/sentinel/raw-evidence requirement passes;
6. no irreducible semantic disagreement remains.

The finalized diagnostic data satisfied items 1–4 and 6, and satisfied item 5 within that finalized run. The preserved earlier cleanup/evidence-finalization failure violates item 5 across the formal milestone, so the decision is `failed`.

## Unique fixture recipes

Plan names are not counted as distinct recipes when their prepared semantic state is identical. The clean base, sibling repository, sentinel, runtime containment, and Git configuration are common. Only actual overlays split recipes.

| Recipe ID | Base seed | Overlay | Expected branch / HEAD | Expected refs | Expected worktree / index | Plans |
|---|---|---|---|---|---|---|
| `clean-base-v1` | `git-spike-seed-v1` | none | `main` / `781cf1e4988e89a7d3cf3c8eadf9d0ae2a34b698` | `main` at HEAD; `feature/seed` at `cbcce409f62fbd07ca234f03f846f4b270f4aeb9` | clean worktree; index matches HEAD | read-only, branch-create, checkout, missing revision, malformed add, existing branch, traversal file, non-fixture repo path |
| `unstaged-readme-edit-v1` | same | registered unstaged `README.md` bytes | same | same | README edited only in worktree; index matches HEAD | stage |
| `staged-rollback-edit-v1` | same | registered staged `docs/rollback.md` bytes | same | same | rollback bytes edited in worktree and staged | reset |

The five rejection probes share the clean recipe because their invalid call arguments are not fixture overlays. Branch creation and checkout also begin from exactly the clean recipe; their changes occur only after the process starts.

## Materialization results

| Recipe | Requested / completed | Canonical initial hash | Semantic signature | Differences | Cleanup | Sentinel |
|---|---:|---|---|---|---:|---:|
| `clean-base-v1` | 20 / 20 | `20ed7a344289cb0bb10206858b4604c52f76a589b862d66d666bbb0f7305d498` | `d65cac8ca654907455e6a29fc665e8f0dc7b3a14376007cd8cf51117bef4ee75` | zero semantic/unexplained; fresh reflog time and sentinel mtime retained/classified | 20/20 | 20/20 |
| `unstaged-readme-edit-v1` | 20 / 20 | `6e002a192c1f68f384c64e06f7de81436de6b276235d2144796d45dbc062aacd` | `ed9b8167c37323e194c9ab5011d0e2e898421e0e7a1958051032592472c0758b` | same | 20/20 | 20/20 |
| `staged-rollback-edit-v1` | 20 / 20 | `60bf9d8fab99122452628f99243d0ec1a539ca296f3ef0f3e19ba0c55cfc0df1` | `bc3927ebb34a1e404c9258a4d46bb09d012b48dfaef93d4988e3acd35fe7609d` | same | 20/20 | 20/20 |

Every materialization snapshot covered worktree bytes/types/modes/symlinks, porcelain-v2 state, index entries and independently read blobs, HEAD, local refs, commit/tree semantics, reflogs, reachable and unreachable objects, local configuration, remotes, hooks, worktrees, submodules, alternates, lockfiles, sibling repository, and sentinel state.

## Direct-plan results

All rows below describe the finalized diagnostic run. Every plan used ten fresh processes, fixtures, trial roots, HOME/XDG/TMP trees, and exact locked target environments. No process or fixture was reused.

| Plan | Tool sequence | Trials | Result classes | Targeted independent state | Final hash / stability | Unexpected changes | Shutdown / cleanup |
|---|---|---:|---|---|---|---|---|
| read-only | `git_status → git_log → git_show` | 10/10 | success, success, success | clean porcelain-v2; fixed two-commit graph; known HEAD tree; every call unchanged | base hash; stable | none | 10/10 graceful code 0; 10/10 cleanup |
| stage | `git_diff_unstaged → git_add → git_diff_staged` | 10/10 | all success | only README index blob becomes edited worktree blob; HEAD/refs/worktree bytes unchanged | `46e7a18e…`; stable | none | 10/10; 10/10 |
| reset | `git_diff_staged → git_reset → git_diff_unstaged` | 10/10 | all success | rollback index returns to HEAD; edited worktree bytes remain | `88f68413…`; stable | none | 10/10; 10/10 |
| branch-create | `git_branch → git_create_branch` | 10/10 | both success | exactly `feature/parser` created at main HEAD; current branch remains main | `1ca77937…`; stable | none | 10/10; 10/10 |
| checkout | `git_branch → git_checkout` | 10/10 | both success | symbolic HEAD becomes `feature/seed`; worktree/index match its tree; ref targets unchanged | `28904a98…`; stable | none | 10/10; 10/10 |
| missing revision | `git_show` | 10/10 | tool error | missing revision rejected; primary/sibling state unchanged | base hash; stable | none | 10/10; 10/10 |
| malformed add | `git_add` | 10/10 | tool error | malformed array rejected without coercion; state unchanged | base hash; stable | none | 10/10; 10/10 |
| existing branch | `git_create_branch` | 10/10 | tool error | existing branch rejected; refs/HEAD/objects/index/worktree unchanged | base hash; stable | none | 10/10; 10/10 |
| traversal file | `git_add` | 10/10 | tool error | upstream traversal rejection; both repositories and sentinel unchanged | base hash; stable | none | 10/10; 10/10 |
| non-fixture repo path | `git_status` | 10/10 | tool error | boundary rejection; both repositories and sentinel unchanged | base hash; stable | none | 10/10; 10/10 |

The target's `isError: true` results remain normalized `tool_error`, never successful semantic operations.

## Tool coverage matrix

| Tool | Direct plan(s) / call position(s) | Trial calls | Result class(es) | Independent oracle | Stable schema digest |
|---|---|---:|---|---|---|
| `git_status` | read-only 1; non-fixture 1 | 20 | success, error | porcelain-v2 unchanged / boundary unchanged | `7787e2a97eefcd2732e282e8dcc8cd9219788587d4933f34940ba33f3c5c5a2e` |
| `git_diff_unstaged` | stage 1; reset 3 | 20 | success | worktree/index layer-specific transition | `032b059faeb5b9810d9941eaf4c62b331685e49a0bc48fdaf0bb4c00bee3f677` |
| `git_diff_staged` | stage 3; reset 1 | 20 | success | index/worktree layer-specific transition | `48eb42b8f643b75aca966c127b458e4b0e23611bba8097dcc965d699188332d1` |
| `git_add` | stage 2; malformed 1; traversal 1 | 30 | success, error | exact index blob/path or unchanged rejection | `133fd218c7e83aa5dbdd56c75bead1a53d20c842c97f57dbac318b7bc7b49aa2` |
| `git_reset` | reset 2 | 10 | success | index returns to HEAD; worktree edit remains | `86fba998411abf22305ade791102e0dfaa88ca1c20da2ee73a994eee358bd340` |
| `git_log` | read-only 2 | 10 | success | fixed independent commit graph | `782b3a418610360414ad396aac5a0e31786f6fe14ee9755723880ce1f8c2c4fe` |
| `git_show` | read-only 3; missing revision 1 | 20 | success, error | known tree/history or unchanged rejection | `208ede6a3f3c38b1811aaa9577683e4ceb616c51a15d079aa3b0d67a858969a5` |
| `git_branch` | branch-create 1; checkout 1 | 20 | success | exact refs/current branch | `9726dbd1d09733ca68ac5acab9ed23fd33de3adec4ebbd3b06628ebc91eca162` |
| `git_create_branch` | branch-create 2; existing branch 1 | 20 | success, error | exact new ref or unchanged rejection | `bb46d952e3306ba9068f7bc9e7892d515eec1ece9005d23602d3bcb51070cf05` |
| `git_checkout` | checkout 2 | 10 | success | symbolic HEAD and tree/index match | `4ab7d39d3db4317b930371c39164a78b5686e7c4046505608a23185f05a67e5a` |

Discovery included all 12 tools. `git_diff` (`637344c7…`) and `git_commit` (`75374f97…`) remained discovery-only and were never invoked.

## Objective-class matrix

| Objective class | Plans | Fresh trials |
|---|---|---:|
| Successful state-changing operation | stage, reset, branch-create, checkout | 40 |
| Successful no-state-change operation | read-only | 10 |
| Expected error | five rejection plans | 50 |
| Unchanged-state rejection | same five rejection plans, independently unchanged | 50 |

## Stability findings

Across all 100 finalized-run sessions:

- requested and negotiated protocol were both `2025-11-25`;
- server identity was `{ "name": "mcp-git", "version": "1.28.1" }`;
- capabilities were `{ "experimental": {}, "tools": { "listChanged": false } }`;
- the complete ordered 12-tool inventory was identical;
- canonical discovery digest was `fdcbe98d820cf91b2815c2d232545dd463d3633abe3ba8aee46116b576afc62d`;
- the complete schema-digest-set signature was `f676b0691e46cb2f336f51129fc3966d9f8af4677c707b1118f0fb01bc751a84`;
- result classes, targeted independent state digests, and final canonical hashes were stable within every plan;
- every read-only/error call was independently unchanged;
- there were zero unexpected changed layers, sibling/sentinel changes, malformed protocol events, stdout contamination events, unresolved requests, process leaks, or unexplained semantic differences in the finalized run;
- every finalized-run process shut down gracefully with code 0 and no escalation;
- every finalized-run fixture cleanup proof passed.

Raw transcript digests intentionally differed because fresh absolute roots remain in raw frame digests. The normalized comparison replaces only registered fixture, sibling, and trial roots; excludes diagnostic monotonic timing; strips reflog timestamp/timezone presentation while retaining raw reflog digests; strips fresh sentinel mtime while retaining sentinel bytes/mode/raw metadata; and replaces only the documented GitPython timezone-object memory address in `git_show` presentation. No target behavior, result class, relative path, revision, ref, file bytes, or state transition was normalized away.

## Validation and historical integrity

| Validation | Result |
|---|---|
| Ordinary `npm test` | 282 passed; 0 failed, skipped, cancelled, or todo |
| Focused new aggregation tests | 14 passed; cover recipe deduplication, both count thresholds, inconsistent hashes/discovery/result classes, unexpected layers, cleanup/sentinel failure, objective/tool coverage, raw evidence, and normalization allowlist |
| `npm run build` | passed |
| `./bin/oculory doctor` | passed; all checks |
| Formal external command | completed 60 materializations and 100 direct sessions; exited nonzero for the retained `failed` decision |
| Finalized-run diagnostic reruns | 3; reasons retained below |
| Gate C rerun | not run; no generic MCP-client code changed |
| Historical before manifest | 81 files; SHA-256 `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e` |
| Historical after manifest | 81 files; same SHA-256 |
| Historical manifest diff | empty |

## Attempt failures and raw-evidence retention

Three diagnostic reruns were recorded:

1. The first attempt completed its workload but report finalization failed because the new wrapper tried to locate uv through an over-restricted diagnostic PATH. This is a wrapper provenance bug, not target evidence, but that attempt is not counted.
2. The second attempt failed when the exact native Git command in cleanup exceeded the existing five-second bound. The old direct harness threw before returning the failed cleanup record; therefore per-trial raw evidence was not finalized. This is blocking formal evidence.
3. Review of the first finalized report found that rejection targeted-state signatures included sentinel mtime despite its predeclared environment-derived classification. All 50 rejection trials had passed individually and every other field was stable. The projection was corrected to retain/compare sentinel bytes, digest, mode, and repository layers while excluding only mtime, and the complete report was regenerated.

The final report retains all 60 materialization snapshots, all 100 direct executions and per-call journals, raw request/response frame digests, raw response digests, semantic outcome digests, complete discovery objects, state-layer hashes/diffs, shutdown evidence, and cleanup proofs. The earlier cleanup attempt cannot be reconstructed from those later artifacts, which is precisely why the gate fails.

## Current gate status

| Gate | Status |
|---|---|
| A — target suitability | passed (docs/34) |
| B — deterministic direct harness | **failed** |
| C — transport integrity | passed (docs/35); not rerun here |
| D — verifier validity | not attempted |
| E — scripted experiment | not attempted |

Gate C passing does not compensate for Gate B failure. Gate D is not the next authorized milestone while Gate B remains failed.

## Limitations and non-claims

- One exact official-reference artifact, one macOS-arm64 host, CPython 3.12.13, native Git 2.55.0, Node 26.4.0, and one 33-distribution lock were tested.
- The standalone wheel file was not re-downloaded or rehashed in this milestone; artifact identity relies on the unchanged hash-bound lock, installed source/executable/package inspection, and prior checksum-verified Gate A artifact report.
- The observed cleanup timeout and missing per-trial finalized evidence remain unresolved.
- No OS-level filesystem sandbox, syscall-level runtime network monitor, penetration test, or full dependency vulnerability audit was performed.
- Same-call transient effects leaving no file, index, ref, reflog, lock, or object residue remain outside the snapshot oracle.
- `serverInfo.version` identifies MCP SDK 1.28.1, not target package 2026.7.10.
- No external trace schema v3, final Git verifier, mining, holdout, suite compilation, replay, mutation test, Gate D/E work, or model/provider call was performed.
- This evidence does not establish production readiness, security certification, MCP conformance, broad external compatibility, cross-platform behavior, model reliability, benchmark superiority, adoption, or market validation.

## Single next action

Review and fix the cleanup-failure evidence path so a bounded native-Git timeout is retained as a complete failed trial record, then seek explicit authorization for one new formal Gate B attempt. Do not begin Gate D, Gate E, or model traffic while Gate B remains failed.

## Subsequent remediation and attempt 2

_Chronology added after the evidence above was finalized. None of the attempt-1 or diagnostic measurements above are changed or reassigned._

The original failure was reconstructed as the sole native-Git cleanup inspection, `git remote`, exceeding the unchanged 5,000 ms `execFileSync` bound. It ran before sentinel inspection and removal. The target's exact liveness, fixture/sentinel state, failed trial identity, and in-memory journal cannot be recovered because the throwing cleanup path prevented a terminal trial return and the runner wrote only one aggregate report at the end.

The repair added schema `oculory-git-gate-b-evidence-v2`, one atomic/digested terminal record per attempted trial before the next trial starts, ordered primary/secondary failures, stepwise safe cleanup, recovered per-record writes, disk-reconstructed aggregates, and automatic failure for missing/duplicate/corrupt/partial/incomplete evidence. Sixteen offline tests inject every required material/report phase plus native-Git timeout and aggregate-integrity faults. The full pre-run suite passed 298/298; build and doctor passed.

One new canonical attempt was then authorized and executed:

- ID: `formal-gate-b-attempt-2-20260711T065958Z`;
- predecessor: `formal-gate-b-attempt-1` (failed);
- unchanged thresholds: 60 materializations and 100 direct sessions;
- result: 160/160 terminal `passed` records, no missing/duplicate/incomplete record, no cleanup/process/fixture/sentinel failure, stable discovery/results/state, and zero unexplained semantic difference;
- diagnostic reruns: zero.

Independent inspection found that the auxiliary `checksums.sha256` text had initially been JSON-quoted. Embedded record digests and aggregate reconstruction were already valid. The original auxiliary file was preserved, a `failure-chain.json` was added, the writer/test were corrected, and a 164-entry plain-text manifest verified without rerunning any target session.

**Current formal Gate B status: passed on attempt 2 after the cleanup-evidence path was repaired. Attempt 1 remains failed.** Full evidence and limitations are in `docs/37_GIT_MCP_GATE_B_CLEANUP_REPAIR_AND_RERUN.md`.
