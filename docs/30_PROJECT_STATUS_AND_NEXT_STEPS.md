# 30 — Project status and next steps

_Canonical handoff updated for Phase 8 provider-free external-developer pilot preparation on 2026-07-15. Earlier “current status” documents are point-in-time records; use this file for present state._

## Canonical public repository and history boundary

The public repository is `https://github.com/Kyoshiki-Murasaki/oculory` and its default branch is `main`. The public history deliberately starts at one fresh root, `616ca96548e763ab3bb401f4626dcac2857a647b` (`Initial public release of Oculory`). Local `main` and `origin/main` matched that root at the start of Phase 7.

This is a one-root publication discontinuity, not a history migration. Older commit hashes, `master` branch references, milestone tags, and PR chronology retained in docs 31–43 are legacy/private-history evidence identifiers only. They are not reachable current public commits or refs and must not be restored, grafted, merged, or presented as current public history.

Gate F0 implementation and its tracked documentation are already present in the fresh public root. There is no current Gate F0 pull request awaiting review. Phase 7 merged normally at `4ae893b2dfc1403da3647a32e8f59c9a2108e359`; exact post-merge CI run `29403228559` passed all six required jobs. Its remote feature branch was deleted and its local feature branch retained. Active work is Phase 8 on `phase8-offline-developer-pilot`, preparing a provider-free pilot kit against `main`.

## Executive status

Gate F0 has now **passed** its offline-only scope. From clean commit `8ebf12feb5affedcee1dad041e4b95218f809b30`, authoritative run `git-gate-f0-offline-20260712T210744Z` passed six/six deterministic mock sessions through fresh pinned Git MCP fixtures/processes, both applicable approved-suite checks, 57/57 registered fault cases, seven determinism repeats, complete checksum/evidence reconstruction, and clean process/fixture/sentinel cleanup. It made zero real provider calls, read/requested zero real credentials, performed zero provider network calls/retries, and incurred exactly zero provider cost. The prior run `git-gate-f0-offline-20260712T210649Z` failed on scenario tool exposure, remains preserved, and was not used for replacement sessions. See `docs/43_GATE_F0_OFFLINE_PREPARATION_AND_VALIDATION.md`.

The provider registry still contains only the deterministic non-network mock. The F1 authorization template is `draft`, explicitly says `NOT AUTHORIZED — TEMPLATE ONLY`, and is non-executable. No real provider adapter was added. **F1 and F2 remain unauthorized and unstarted.**

Phase 8 selected the offline external-developer usability-pilot path instead of Gate F1. It adds repository-only doctor/run/report-verification/smoke commands, a local-first privacy model, Track A guided workflow, Track B readiness assessment, pre-registered success/counting rules, and cross-platform provider-free CI validation. It prepares infrastructure only: no participant has been recruited or contacted, no human pilot has run, and no usage, adoption, demand, willingness-to-pay, or product-market evidence exists. See `docs/45_PHASE8_OFFLINE_EXTERNAL_DEVELOPER_PILOT.md` and `pilot/`.

Phase 6 selected and pinned `mcp-server-git==2026.7.10`. Gate A passed, the bounded three-trial direct feasibility spike passed, and Gate C transport integrity passed. Formal Gate B attempt 1 remains **failed**: its cleanup `git remote` inspection exceeded the existing five-second bound and the legacy throwing path did not finalize that trial's evidence. The later diagnostic run completed but did not supersede that failure. See `docs/36_GIT_MCP_FORMAL_GATE_B_DETERMINISM.md`.

The cleanup-evidence path was then repaired with atomic per-trial records, ordered primary/secondary failures, stepwise safe cleanup, disk-reconstructed aggregates, and deterministic fault injection. Phase I passed 298/298 ordinary tests, build, and doctor. The one authorized new canonical attempt, `formal-gate-b-attempt-2-20260711T065958Z`, passed 60/60 materializations and 100/100 direct sessions with 160/160 complete terminal `passed` records, zero leaks, and zero unexplained semantic differences. A post-run auxiliary checksum-text encoding defect was transparently preserved and corrected without rerunning target sessions; embedded per-record checksum and aggregate verification had already passed. See `docs/37_GIT_MCP_GATE_B_CLEANUP_REPAIR_AND_RERUN.md`.

Gate D then passed with target-specific `git-verifier-v1`, 37 authored truth-table cases, 19 controlled trace mutations, and 12 test-only defective-verifier controls. State journals, cleanup, sibling/sentinel evidence, and wrong-entity checks outrank server prose, `isError`, restored final hashes, and timeout ambiguity. See `docs/38_GIT_MCP_GATE_D_VERIFIER_VALIDITY.md`.

Gate E1 initially appeared complete from clean commit `ae05d10`, but a later adversarial audit found unresolved journal pointers and simulated rather than re-mined leave-one-out results. A corrected 60-session run from `f2138f5` then exposed trace-order-dependent candidate identity. Both finalized runs remain preserved as insufficient attempts. After the evidence/mining and candidate-order repairs, Gate E1 completed from clean commit `6270926be62286a15b540982cb74b4d34b65b020`. The authoritative run `git-gate-e1-scripted-20260712T033640Z` executed 20 scripted scenarios for three cold trials each: 60/60 terminal passes, 42 verified successes, 18 valid rejections, zero unknowns, zero instability, and zero cleanup, sentinel, evidence, process, or protocol failures. Independent audit resolved every sidecar pointer and reproduced candidate identity under permuted trace IDs. The isolated miner read only 18 successful mining traces from six distinct scenarios and produced ten unapproved candidates. See `docs/39_GIT_MCP_GATE_E1_SCRIPTED_RECORDING_AND_MINING.md`.

Gate E then recorded the exact human decision to approve eight semantic candidates and reject two exact-path candidates, compiled the two non-exhaustive blocking contracts, and ran from clean implementation commit `e1f015f15337bd8c27df15a07f791a0615ae18a6`. The authoritative run `git-gate-e2-replay-mutation-20260712T092246Z` passed 18/18 mining and 6/6 eligible holdout replays, detected all 34 harmful mutations in all three trials, and produced zero false positives across five benign controls. Detection was separately reported for suite, independent golden/meta-oracle, transport, and fixture/cleanup channels. Two earlier Gate E2 attempts remain preserved under their own IDs after narrow runner defects; neither supplied replacement trials. See `docs/40_GIT_MCP_GATE_E_REPLAY_AND_MUTATION.md`.

Current status is: Gate A passed; formal Gate B passed on attempt 2 while attempt 1 remains failed; Gate C passed; Gate D passed; Gate E1 completed; Gate E passed; **Gate F0 passed**. F1/F2 have not started. Final F0 validation passed 422/422 ordinary offline tests, 18/18 focused F0 tests, build, doctor, authorization validation, and Phase 6 evidence-index validation. Historical live artifacts remain 81 files with manifest digest `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e`; all six existing external roots were byte-identical before/after F0.

The final audit in `docs/41_PHASE6_EXTERNAL_GIT_FINAL_AUDIT_AND_FREEZE.md` independently revalidated the pre-freeze repository, six external evidence roots, retained Gate B evidence, historical 81-file manifest, exact human review, suite, registry, and public claims. The deterministic tracked index is `docs/evidence/phase6-external-git-evidence-index-v1.json`. A separately stored local archive and sidecar passed extraction, evidence-manifest, tracked-file, and credential checks and were not added to Git. The freeze commit and annotated tag named in that report belong to the legacy/private chronology; the Phase 6 tree content was republished in the fresh public root without importing those refs. `docs/42_GATE_F_LIVE_MODEL_PROPOSAL.md` is proposal-only and explicitly authorizes no model/provider call.

Phases 3–5 have three completed local compatibility targets: the task server, sandboxed filesystem server, and issue-tracker server. All three deterministic scripted experiments currently pass their pre-registered `meaningful_technical_success` rule. Preserved filesystem and issue-tracker live artifacts support mining/approval/replay and adversarial claims at controlled local scale. The task target's live workflow is documented historically, but most of its cited isolated run directories are no longer present and therefore were not re-verified during this transition.

Phase 5 was frozen for its stated local scope in the legacy/private chronology. Its old transition commit and `phase5-issue-tracker-live-validated` tag are historical evidence identifiers, not current public refs. This remains a technical checkpoint, not a production or product-readiness claim.

## Completed targets and evidence level

| Target | Scripted deterministic validation | Live mining | Human approval | Live replay | Holdout | Adversarial validation | Documentation |
|---|---|---|---|---|---|---|---|
| Task server | Present and re-run: 72 traces, 66 success, 6 rejection; `meaningful_technical_success` | Historical result in docs/25; cited mining directory absent locally | Historical 8/9 approval record in docs/25; run-local record absent | Historical 16/16 result in docs/25; run-local record absent | Historical 21/21 standalone result; run-local record absent | Historical two-run result: 6 rejection + 3 failure per run; run-local records absent | `docs/25_MODEL_VALIDATION_EVIDENCE.md`, with artifact-availability caveat |
| Filesystem server | Present and re-run: 72 traces, 66 success, 6 rejection; `meaningful_technical_success` | Preserved: 33/33 success, 0 unstable, 10 candidates | Preserved: 8 safe approved; 2 advisory unapproved | Preserved: suite `suite-a7ab85c183`, 15/15 pass | No standalone holdout run preserved; eligible holdout siblings covered by replay | Preserved post-fix: 9 traces, 3 success, 6 rejection, 0 failure/unknown/unstable; 3 advisory candidates unapproved | `docs/27_FILESYSTEM_MODEL_VALIDATION_EVIDENCE.md` and reconciled plan |
| Issue-tracker server | Present and re-run: 96 traces, 84 success, 12 rejection; `meaningful_technical_success` | Preserved: 39/39 success, 0 unstable, 9 candidates | Preserved: 8 safe approved; `issue_list` advisory unapproved | Preserved: suite `suite-597351ddea`, 20/20 pass | Preserved standalone: 33/33 success, 0 unstable, 0 candidates; eligible siblings also covered by replay | Preserved authoritative post-fix: 18 traces, 6 success, 12 rejection, 0 failure/unknown/unstable; 6 advisory candidates unapproved | `docs/29_ISSUE_TRACKER_MODEL_VALIDATION_EVIDENCE.md` and reconciled plan |

A historical task smoke backup remains outside tracked Git. The task mining/replay/holdout/adversarial directories cited in docs/25 do not remain locally available.

## Transition validation baseline

The 2026-07-10 audit produced this offline baseline:

- `npm test`: 220 passed, 0 failed, 0 skipped.
- `npm run build`: clean TypeScript build.
- `./bin/oculory doctor`: all checks passed.
- `./bin/oculory experiment`: `meaningful_technical_success`; mined precision 1.0, recall 0.889.
- `./bin/oculory fs-experiment`: `meaningful_technical_success`; mined precision 1.0, recall 0.875.
- `./bin/oculory issue-experiment`: `meaningful_technical_success`; mined precision 1.0, recall 1.0.
- `.oculory/runs-live` integrity: all 81 files had identical before/after SHA-256 checksum manifests; empty diff.

No live model job was run during the audit.

## Confirmed technical capabilities

The current repository directly demonstrates, within its local/synthetic scope:

- isolated run directories with manifests and provenance fields;
- normalized raw traces with per-step tool results and state-change evidence;
- deterministic outcome verification based on intended postconditions;
- recording-time and replay-time instability detection;
- stable assertion mining with entity generalization and anti-overfit handling;
- candidate risk classification, including smoke-only, unstable, constant-argument, and adversarial-only risks;
- explicit human approval records and warning overrides;
- isolated suite compilation from approved candidates only;
- live replay against fresh model traffic;
- mining/holdout separation and eligible holdout replay coverage;
- safe adversarial rejection handling without approving adversarial-only candidates;
- live-artifact preservation through scripted store cleanup;
- fail-closed model budget guards;
- backwards-compatible task, filesystem, and issue-tracker scripted targets.

The filesystem and issue-tracker safe-refusal overrides inspect final state and per-step `state_changed`, so a mutate-then-restore path cannot be mislabeled clean. Their exact-code scoping guards preserve unrelated rejection semantics.

## Operational invariants for future Codex work

- Do not run live model jobs unless a future task explicitly requires them.
- Never expose or commit model credentials. Keys belong in the process environment only.
- Keep `.oculory/`, `.oculory-*/`, `dist/`, `node_modules/`, and `.env*` untracked.
- `Store.clean()` must preserve `.oculory/runs-live`, `.oculory/runs-external`, and `.oculory/runs-model` by default; each root requires its distinct destructive override.
- Never approve adversarial-only, smoke-only, unstable, or otherwise risky candidates merely to make a suite larger.
- Preserve behavior and CLI compatibility for all three frozen targets.
- Treat reports generated before approval as pre-review snapshots; use run-local `candidates.json` and `suite.json` for post-review truth.
- Do not infer production, security, market, or benchmark claims from local experiment outcomes.

## Evidence-integrity caveats

1. Task live evidence is historical documentation, not currently reproducible from the cited run-local files; most of those files are absent.
2. Phase 5 live manifests record `e2909eb`, although the initial no-tool verifier fix was committed later in `2f18e89`. The post-fix adversarial labels prove the corrected working-tree behavior was active, but the manifest commit does not capture that exact tree.
3. Live artifacts are intentionally gitignored local evidence, not repository content; losing the local directories would reduce future direct verifiability.
4. Filesystem holdout coverage is through live replay of eligible `-h1` siblings, not a preserved standalone holdout experiment.

## Known limitations

- All three targets are synthetic/local and authored inside this repository.
- Live evidence uses one primary model (`gpt-4.1-mini`) with small catalogues and three trials per scenario.
- One exact independently maintained official-reference Git MCP implementation has completed Gates A–E on one macOS-arm64 host; broad or cross-platform compatibility remains untested.
- There is no real developer workflow, team adoption, or customer usage evidence.
- There is no market validation or evidence of willingness to pay.
- There is no security certification, penetration test, or production threat assessment.
- There is no direct benchmark against an external MCP evaluation product.
- Model replay validates stability against unchanged targets; it does not yet run the induced-regression comparison under live traffic.
- Review was single-reviewer and local; no multi-reviewer governance has been tested.
- Cost figures are internal estimates rather than provider billing records.
- Phase 7 tests the core CLI/package workflow across Ubuntu, macOS, and Windows; it does not reproduce the macOS-arm64-only external Git MCP evidence on those platforms.

## Historical transition recommendations

1. **Test one actual open-source/external MCP server.** Choose a maintained server Oculory did not author, exercise its real transport, create deterministic fixtures and outcome verification around a narrow safe subset, and run the existing scripted-first workflow before considering any live traffic. This closes the largest technical-evidence gap without adding another toy target.
2. **Package the repository for public technical review.** Refresh top-level documentation, add CI, define supported Node versions, publish reproducible offline commands, and make the evidence caveats prominent.
3. **Add cross-model validation.** Re-run only after the external target and protocol are frozen, using the same partitions and approval rules so differences are interpretable.
4. **Recruit a small number of developers to test the workflow.** Observe setup time, review burden, failure comprehension, and whether the generated suites help on real changes.

Item 1 was subsequently executed through target selection and Gates A–E. Its current outcome is governed by docs/31–41, especially the preserved failed first formal Gate B attempt in docs/36 and the passing repaired attempt in docs/37; this historical ranking is retained rather than rewritten as if the later work had not occurred.

Item 2 is implemented by Phase 7 through offline CI, the portable launcher, package verification, contributor documentation, and fresh-history reconciliation. This is bounded public engineering readiness, not production readiness.

## Exact next development decision

Phase 8 chose and is preparing the provider-free external-developer pilot; it did not choose Gate F1. After the kit has green exact-head CI and an independent audit, the next decision is whether to authorize recruitment of three to five developers under the pre-registered local-first protocol. Until that separate decision, do not contact participants or run a human session. Gate F1/F2 remain unauthorized and must not be inferred from pilot readiness.

## Handoff map

- Product and architecture: `docs/01_PRODUCT_DEFINITION.md`, `docs/03_TECHNICAL_ARCHITECTURE.md`.
- Run isolation/model workflow: `docs/24_RUN_ISOLATION_AND_MODEL_VALIDATION.md`.
- Task evidence: `docs/25_MODEL_VALIDATION_EVIDENCE.md`.
- Filesystem target/evidence: `docs/26_FILESYSTEM_VALIDATION_TARGET.md`, `docs/27_FILESYSTEM_MODEL_VALIDATION_EVIDENCE.md`.
- Issue target/evidence: `docs/28_ISSUE_TRACKER_VALIDATION_TARGET.md`, `docs/29_ISSUE_TRACKER_VALIDATION_PLAN.md`, `docs/29_ISSUE_TRACKER_MODEL_VALIDATION_EVIDENCE.md`.
- Current canonical status: this document.
- External target and gate evidence: `docs/31_EXTERNAL_MCP_TARGET_SELECTION.md` through `docs/40_GIT_MCP_GATE_E_REPLAY_AND_MUTATION.md`.
- Final Phase 6 audit/freeze: `docs/41_PHASE6_EXTERNAL_GIT_FINAL_AUDIT_AND_FREEZE.md` and the tracked index under `docs/evidence/`.
- Unexecuted Gate F proposal: `docs/42_GATE_F_LIVE_MODEL_PROPOSAL.md`.
- Gate F0 offline implementation and evidence: `docs/43_GATE_F0_OFFLINE_PREPARATION_AND_VALIDATION.md`.
- Phase 7 CI, CLI, package, and public-history record: `docs/44_PHASE7_PUBLIC_ENGINEERING_READINESS.md`.
- Phase 8 provider-free external-developer pilot kit: `docs/45_PHASE8_OFFLINE_EXTERNAL_DEVELOPER_PILOT.md` and `pilot/`.

Before future implementation work, run the offline baseline above and inspect `git status --short`. Do not create a fourth synthetic target as the next phase.
