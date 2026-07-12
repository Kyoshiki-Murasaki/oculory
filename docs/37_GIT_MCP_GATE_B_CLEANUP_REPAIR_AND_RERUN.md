# 37 — Git MCP Gate B cleanup-evidence repair and canonical rerun

_Evidence and chronology for the 2026-07-11 cleanup-evidence repair and the one authorized subsequent canonical Gate B attempt. This does not rewrite attempt 1, authorize Gate D/E implementation, create external trace schema v3, or provide model evidence._

## Executive decision

- **Phase I cleanup-evidence repair: passed.** The offline suite deterministically forced every required material and report phase, retained exactly one terminal record per attempted trial, preserved primary and secondary failures, continued safe cleanup, rejected incomplete aggregates, and left no process or fixture leak. The ordinary suite increased from 282 to 298 passing tests; build and doctor passed.
- **Historical formal Gate B attempt 1: failed.** Its cleanup `git remote` inspection exceeded the five-second native-Git bound and the legacy path lost the finalized trial record. The later 60/100 diagnostic run did not supersede it.
- **Formal Gate B attempt 2: passed.** Attempt `formal-gate-b-attempt-2-20260711T065958Z` completed 60/60 materializations and 100/100 direct sessions with 160/160 terminal `passed` records, complete checksums, no missing/duplicate indices, no leaks, and no unexplained semantic differences.
- **Current formal Gate B status: passed on attempt 2 after the evidence path was repaired. Attempt 1 remains failed.**
- Gate A passed; Gate B now passed on attempt 2; Gate C passed; Gates D–E remain unattempted.

## Date and starting repository

| Field | Value |
|---|---|
| Date | 2026-07-11 |
| Starting branch | `master` |
| Starting commit | `20573a0c4ec9d3ccff059cc118df91232a3a7c2a` — `Document formal Git MCP deterministic findings` |
| Starting tree | Clean |
| Remotes | None |
| Historical live artifacts | 81 files |
| Before-manifest SHA-256 | `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e` |

The baseline passed 282/282 tests, TypeScript build, and doctor before any source change.

## Original failure summary and causal diagnosis

### Verified facts

1. Attempt 1 reached `cleanupGitSpikeFixture` after the direct harness's `finally` had attempted client close, emergency liveness handling if needed, the post-shutdown snapshot, and the pre-cleanup snapshot.
2. The historical cleanup implementation's only native-Git operation was `/opt/homebrew/bin/git remote`, executed in the fixture repository through `execFileSync` with a 5,000 ms hard timeout. Retained docs identify the timed-out operation as the exact native-Git command in cleanup; the historical source identifies that sole command as `git remote`.
3. `git remote` ran before sentinel inspection, primary-repository removal, post-removal sentinel inspection, trial-root removal, and parent absence verification.
4. The timeout threw out of `cleanupGitSpikeFixture`; no `GitSpikeCleanupProof` was returned.
5. `runGitSpikeTrial` had already constructed transcript, journal, process/shutdown values, and other in-memory evidence, but it could not return its execution object after cleanup threw.
6. The formal runner caught only the thrown direct-trial exception, appended a small in-memory failure digest, force-removed the trial path, and did not add a direct-trial record. All earlier evidence remained only in memory until one aggregate JSON write at the end.
7. The later finalized diagnostic report records only the cleanup-timeout class and evidence-retention failure. It does not contain the failed attempt's trial index, liveness values, journal, fixture proof, sentinel proof, or cleanup result.
8. The same evidence-loss defect existed in both paths. Direct-session exceptions were caught but the trial record was discarded; a materialization cleanup exception escaped its loop and could prevent the sole final report write altogether.

### Facts that cannot be reconstructed

- The failed trial index and plan are unknown.
- The exact process exit code, signal, child-liveness result, and process-group result are unknown. Reaching cleanup proves the shutdown orchestration ran, not that every shutdown assertion passed.
- The final primary-repository state and sentinel state are unknown. Earlier in-memory snapshots may have captured them, but they were not retained.
- Whether the runner's force-removal catch actually completed is not retained.
- No retained evidence distinguishes a genuinely stuck Git inspection from a transient operation that merely exceeded the five-second hard bound.

### Root cause

There were two distinct defects:

1. **Observed cleanup failure:** the cleanup `git remote` inspection did not finish within its unchanged 5,000 ms hard bound.
2. **Evidence-finalization defect:** cleanup was a throwing all-or-nothing function, trial state was not represented independently of a successful return, and the report was held in memory until one final write.

The timeout was real as a bounded cleanup failure. Whether it represented persistent Git/fixture corruption is unknowable. The loss of the terminal record was unambiguously a runner design defect.

## Affected code paths

- `src/targets/git-spike/fixture.ts`: native-Git execution and monolithic cleanup.
- `src/targets/git-spike/direct-harness.ts`: cleanup occurred after lifecycle `finally`, before returning trial evidence.
- `test/support/run-git-mcp-formal-gate-b.ts`: in-memory materialization/direct arrays and one final report write.
- Materialization and direct-session orchestration were both affected; the generic MCP client was not changed.

## Evidence-finalization design

`src/targets/git-spike/gate-b-evidence.ts` defines schema `oculory-git-gate-b-evidence-v2` and runner `gate-b-runner-v2`.

Every attempted materialization/direct trial now owns a recorder before setup. Its terminal record contains:

- attempt, predecessor, trial, recipe/plan, index, timestamps, and last completed phase;
- target/runtime provenance and fixture path token;
- process and process-group state where applicable;
- completed calls, journals, latest successful snapshot, and semantic summary;
- one primary failure plus ordered secondary failures, message digests, timeout phase/deadline;
- every cleanup step and result;
- fixture-presence and sibling/sentinel result;
- evidence-completeness Boolean and explicit missing-field list;
- terminal outcome and report-finalization status.

Terminal outcomes are `passed`, `failed_execution`, `failed_oracle`, `failed_shutdown`, `failed_cleanup`, `failed_evidence_finalization`, and `inconclusive`. A later cleanup exception cannot overwrite the primary causal failure.

### Durable writes

- `attempt.json` is atomically written before trials.
- Each trial is written to `trials/*.json` with `open(wx) → write → fsync(file) → close → rename → fsync(directory)` before the next trial starts.
- Each envelope contains SHA-256 over the canonical terminal record.
- A primary per-record write failure becomes `failed_evidence_finalization` and uses one explicit `.recovered.json` fallback.
- Duplicate logical IDs are rejected. Aggregate reconstruction detects missing, unexpected, duplicate, corrupt, and temporary/partial records.
- `aggregate.json` is reconstructed from disk, not from successful summary alone. An incomplete or non-passed record makes the attempt non-passing.
- Aggregate failure uses `aggregate.failed.json`; per-trial evidence remains intact.
- `checksums.sha256` binds attempt, aggregate, and trial files. The initial auxiliary manifest was found JSON-quoted during independent inspection; its SHA-256 `f56508f4…` was preserved as `checksums.initial-malformed.json-string`, `failure-chain.json` records the packaging correction, and a valid manifest was generated without rerunning any target session. Embedded record digests and aggregate reconstruction had already passed. The writer and test were corrected.

Cleanup in `fixture.ts` is now stepwise and non-throwing for valid fixture objects. It records root safety, native-Git remote inspection, sentinel checks, containment, repository removal, fixture absence, trial-root removal, and parent absence independently, continuing wherever safe.

## Fault-injection coverage

All tests are offline and launch no external target.

| Injected phase | Primary class / terminal outcome | Retained evidence and cleanup result | Aggregate |
|---|---|---|---|
| Fixture creation | `fixture_creation` / `failed_execution` | one record; missing facts explicit; process/fixture cleanup attempted | failed |
| Initial native-Git snapshot | `native_git_snapshot` / `failed_oracle` | last prior phase, snapshot timeout deadline, cleanup retained | failed |
| Target startup | `target_startup` / `failed_execution` | process absence and fixture cleanup retained | failed |
| Initialize | `initialize` / `failed_execution` | started-process evidence retained; process and fixture cleanup pass | failed |
| `tools/list` | `tools_list` / `failed_execution` | initialization evidence retained; cleanup pass | failed |
| `tools/call` | `tools_call` / `failed_execution` | completed calls/journal retained; deadline retained; cleanup pass | failed |
| Post-call snapshot | `post_call_snapshot` / `failed_oracle` | latest prior snapshot and calls retained; cleanup pass | failed |
| Target shutdown | `target_shutdown` / `failed_shutdown` | primary shutdown failure retained; later cleanup finding secondary | failed |
| Process-group verification | `process_group_verification` / `failed_cleanup` | liveness uncertainty explicit; fixture cleanup still attempted | failed |
| Sentinel verification | `sentinel_verification` / `failed_cleanup` | sentinel failure primary; removal still attempted safely | failed |
| Fixture removal | `fixture_removal` / `failed_cleanup` | first removal failure retained; deterministic retry proves no leak | failed |
| Post-removal absence | `post_removal_absence_check` / `failed_cleanup` | failed check retained; final absence rechecked | failed |
| Per-trial record write | `record_write` / `failed_evidence_finalization` | exactly one recovered record; no successful overwrite | failed |
| Aggregate finalization | `aggregate_finalization` / attempt failed | terminal records parse and verify; `aggregate.failed.json` retained | failed |

Every phase test also retains a separately ordered secondary cleanup finding, asserts the correct primary failure, checks the last completed phase and known evidence, proves cleanup attempts, verifies no fixture/process leak, reconstructs a non-passing aggregate, and rejects a duplicate overwrite. Additional tests reject missing indices, duplicate IDs, corrupt JSON, partial temporary files, and a deterministic native-Git timeout produced by a local sleeping Git fixture.

## Timeout-policy review

No timeout was increased to obtain the result.

| Operation | Limit | Type | Classification and evidence behavior |
|---|---:|---|---|
| Runtime Python/package inspection | 5,000 ms | hard subprocess | setup/provenance failure; no canonical trial starts |
| Native Git version inspection | 5,000 ms | hard subprocess | setup/provenance failure |
| Every fixture/snapshot/native-Git command, including cleanup `git remote` | 5,000 ms | hard `execFileSync` | phase-specific execution/oracle/cleanup failure; terminal record and timeout deadline retained; cleanup continues where safe |
| MCP process spawn | 5,000 ms | hard startup | `target_startup`; shutdown/cleanup attempted |
| Initialize | 5,000 ms | request deadline | `initialize`; cancellation/shutdown evidence retained |
| Complete `tools/list` pagination | 5,000 ms overall | request deadline | `tools_list`; completed pages retained |
| Each `tools/call` | 5,000 ms | request deadline | `tools_call`; cancellation notification and late response remain available |
| Post-cancellation observation | 500 ms | bounded soft observation | late response retained; shutdown continues |
| Graceful stdin-close | 2,000 ms | hard lifecycle stage | escalates to SIGTERM; shutdown record retained |
| SIGTERM grace | 1,000 ms | hard lifecycle stage | escalates to SIGKILL |
| SIGKILL/liveness proof | 1,000 ms | hard lifecycle stage | `failed_shutdown`/`failed_cleanup` if absence unproved |
| Harness emergency kill proof | 1,000 ms | hard fallback | secondary cleanup failure retained if absence unproved |
| uv provenance lookup | 5,000 ms | hard subprocess | attempt setup/report provenance failure |
| Oculory Git HEAD/status/source digest commands | 5,000 ms each | hard subprocess | attempt setup/report provenance failure |
| Sentinel reads and filesystem removal | no separate timer; synchronous local I/O | hard exception | step result retained; subsequent safe steps continue |
| Atomic record/aggregate writes | no timer; synchronous local I/O plus fsync | hard exception | recovered terminal record or failed aggregate; partial `.tmp-*` detectable |

The five-second native-Git bound was not shown to be unrealistically small. The later successful diagnostic and attempt-2 operations do not reconstruct why attempt 1 exceeded it.

## Phase I decision

**Passed.** The 16 new focused tests passed; the complete ordinary suite passed 298/298; build and doctor passed. Every required injected fault produced one terminal record, primary and secondary failures stayed ordered, aggregate-finalization failure preserved records, incomplete evidence could not pass, and cleanup left no leak. The auxiliary checksum-text regression found after the canonical execution was corrected in both writer and test; no target trial was rerun.

## New canonical attempt identity

| Field | Value |
|---|---|
| Attempt ID | `formal-gate-b-attempt-2-20260711T065958Z` |
| Predecessor | `formal-gate-b-attempt-1` (failed) |
| Output | `/tmp/oculory-git-formal-gate-b-attempt-2-20260711T065958Z` |
| Source HEAD | `20573a0c4ec9d3ccff059cc118df91232a3a7c2a` |
| Working tree during run | Dirty with reviewed repair; recorded explicitly |
| Source-tree digest | `ee9547f84071cdae9c3c87d76cc75cd17a9d065a33f7449e265910307fe6f913` |
| Declared counts | 3 recipes × 20 = 60; 10 plans × 10 = 100 |
| Runner/schema | `gate-b-runner-v2` / `oculory-git-gate-b-evidence-v2` |
| Elapsed | 429,885.080625 ms |
| Diagnostic reruns | 0 |

## Exact runtime and lock

| Component | Verified value |
|---|---|
| Target | `mcp-server-git==2026.7.10` |
| Wheel SHA-256 bound in lock | `6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5` |
| Installed server source SHA-256 | `52325521ec8ec00297248fa03eaee6802b9cad3ec1e5bebee25971e1b897d56e` |
| Executable SHA-256 | `a0160dc245aad4c31850be92af9b37b32f00675ef2ab4644ab108ca9eed26bdc` |
| Python | 3.12.13 |
| uv | 0.11.23 (`3cdf50e09`, arm64-apple-darwin) |
| Git | 2.55.0 |
| Node | v26.4.0 |
| OS / architecture | Darwin 25.4.0 / arm64 |
| Lock | `test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml` |
| Lock SHA-256 | `5f7f42f1f4b40051836ce7a308e8e4206a87032edf9bc4cc19e9e2ec75a02b63` |
| Distributions | 33 locked / 33 installed; no drift, extra, unpinned, or unhashed distribution |
| Isolation | no inherited credential, proxy, SSH agent, user Git configuration, or remote |

The existing exact runtime was reused. No package acquisition or runtime network operation occurred.

## Exact command

```bash
npm run test:external-git-formal-gate-b-attempt -- \
  --python /tmp/oculory-git-gate-ab-runtime/bin/python \
  --executable /tmp/oculory-git-gate-ab-runtime/bin/mcp-server-git \
  --git /opt/homebrew/bin/git \
  --lock "$PWD/test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml" \
  --output-dir /tmp/oculory-git-formal-gate-b-attempt-2-20260711T065958Z \
  --materializations 20 \
  --trials 10 \
  --attempt-id formal-gate-b-attempt-2-20260711T065958Z \
  --predecessor-attempt-id formal-gate-b-attempt-1
```

## Materialization result

| Recipe | Requested / attempted / passed | Canonical hash | Cleanup / sentinel / complete evidence |
|---|---:|---|---:|
| `clean-base-v1` | 20 / 20 / 20 | `20ed7a344289cb0bb10206858b4604c52f76a589b862d66d666bbb0f7305d498` | 20/20 / 20/20 / 20/20 |
| `unstaged-readme-edit-v1` | 20 / 20 / 20 | `6e002a192c1f68f384c64e06f7de81436de6b276235d2144796d45dbc062aacd` | 20/20 / 20/20 / 20/20 |
| `staged-rollback-edit-v1` | 20 / 20 / 20 | `60bf9d8fab99122452628f99243d0ec1a539ca296f3ef0f3e19ba0c55cfc0df1` | 20/20 / 20/20 / 20/20 |

Failed and inconclusive materializations: zero.

## Direct-session result

| Plan | Requested / attempted / passed | Result classes | Targeted/final state | Unexpected / process / fixture / evidence failures |
|---|---:|---|---|---:|
| read-only | 10 / 10 / 10 | success ×3 | unchanged base hash | 0 / 0 / 0 / 0 |
| stage | 10 / 10 / 10 | success ×3 | exact README index transition; `46e7a18e…` | 0 / 0 / 0 / 0 |
| reset | 10 / 10 / 10 | success ×3 | index reset/worktree retained; `88f68413…` | 0 / 0 / 0 / 0 |
| branch-create | 10 / 10 / 10 | success ×2 | exact new ref; `1ca77937…` | 0 / 0 / 0 / 0 |
| checkout | 10 / 10 / 10 | success ×2 | exact branch/tree/index; `28904a98…` | 0 / 0 / 0 / 0 |
| missing-revision | 10 / 10 / 10 | tool error | unchanged base hash | 0 / 0 / 0 / 0 |
| malformed-add | 10 / 10 / 10 | tool error | unchanged base hash | 0 / 0 / 0 / 0 |
| existing-branch | 10 / 10 / 10 | tool error | unchanged base hash | 0 / 0 / 0 / 0 |
| traversal-file | 10 / 10 / 10 | tool error | both repositories/sentinel unchanged | 0 / 0 / 0 / 0 |
| non-fixture-path | 10 / 10 / 10 | tool error | both repositories/sentinel unchanged | 0 / 0 / 0 / 0 |

Failed and inconclusive direct sessions: zero. Total calls: 180. All ten included tools and all four objective classes met coverage; `git_commit` and arbitrary-target `git_diff` remained uninvoked.

## Evidence integrity and stability

- Expected/actual terminal records: 160/160.
- Outcomes: 160 passed; zero failed or inconclusive.
- Missing, unexpected, duplicate, corrupt, or partial records: zero.
- Evidence-incomplete records: zero.
- Embedded per-record checksum verification: passed.
- Aggregate reconstruction: passed.
- Final valid `checksums.sha256`: 164 entries; SHA-256 `30e175c015042f1ca9ce081c2d63a16e62015c866386241375a863a9837f7fee`; all entries verified.
- Attempt/aggregate SHA-256: `3ae0a60c…` / `8d789893…`.
- Protocol: `2025-11-25` throughout; no corruption, unexpected stdout, unresolved request, or transcript loss.
- ServerInfo, capabilities, 12-tool inventory, discovery digest `fdcbe98d…`, and schema-set digest `f676b069…` were stable.
- Result classes, targeted-state digests, final hashes, shutdown, and cleanup were stable within every plan.
- Zero unexpected changed layers, sibling/sentinel changes, process leaks, fixture leaks, and unexplained semantic differences.
- Normalization remained limited to registered roots, timing, reflog time presentation, sentinel mtime, and the documented GitPython timezone-object address. Raw evidence remained retained.

## Attempt-2 decision and chronology

1. Attempt 1 failed due to the cleanup timeout and missing finalized trial evidence.
2. The later historical diagnostic run completed but did not supersede attempt 1.
3. Phase I repaired and fault-tested the evidence path.
4. Attempt 2 ran once at unchanged canonical thresholds and passed.
5. Independent inspection found and transparently corrected the auxiliary checksum text encoding without changing or rerunning any trial; embedded record checksum and aggregate verification were already passing.

Accurate current statement:

> Formal Gate B passed on attempt 2 after the cleanup-evidence path was repaired. Attempt 1 remains documented as failed.

## Historical live-artifact integrity

| Check | Result |
|---|---|
| Before file count | 81 |
| After file count | 81 |
| Before manifest SHA-256 | `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e` |
| After manifest SHA-256 | `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e` |
| `diff -u` | Empty |

No historical `.oculory/runs-live` file changed.

## Limitations and non-claims

- Attempt 1's exact liveness, fixture, sentinel, trial index, and retained-in-memory journal cannot be recovered.
- One exact target/lock on one macOS-arm64 host was tested; no cross-platform conclusion follows.
- The five-second native-Git timeout was retained and is not proven ideal.
- The auxiliary checksum text encoding needed a transparent post-run packaging correction; no target session was rerun and the original malformed file remains preserved.
- No syscall-level network monitor, OS filesystem sandbox, penetration test, or full dependency vulnerability audit was performed.
- Same-call transient effects leaving no observed residue remain outside the snapshot oracle.
- No external trace schema v3, verifier semantics, authored/mutation traces, mining, holdout, suites, replay, Gate D/E work, model/provider call, API key, or paid traffic occurred.
- This does not establish production readiness, security certification, MCP conformance, broad compatibility, cross-platform behavior, or model reliability.

## Single next action

Implement and validate Gate D verifier semantics using authored and mutation traces, without beginning Gate E or model traffic.
