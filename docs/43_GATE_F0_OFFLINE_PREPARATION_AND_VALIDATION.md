# 43 — Gate F0 offline preparation and validation

_Authoritative offline evidence record, 2026-07-13 (Asia/Kolkata). Gate F0 only. This record authorizes no model-provider traffic and does not authorize Gate F1 or F2._

> Fresh-public-history note: the `master` branch, old commits, milestone tag, and pull-request chronology below are legacy/private evidence references only. They are not reachable current public refs. Gate F0 is already present in fresh public root `616ca96548e763ab3bb401f4626dcac2857a647b` on `main`; no current Gate F0 pull request is awaiting review.

## Decision

**Gate F0: passed.** The authoritative run `git-gate-f0-offline-20260712T210744Z`, from clean implementation commit `8ebf12feb5affedcee1dad041e4b95218f809b30`, passed six deterministic mock sessions through the pinned local Git MCP target, 57/57 preregistered fault cases, seven canonical determinism repeats, complete cleanup and evidence reconstruction, and all ordinary/focused validation. Network call count, real provider calls, real credentials read, retries, and actual provider cost were all zero.

F0 passing does not establish model reliability and does not authorize F1. The tracked F1 template remains `draft` and non-executable.

## Baseline and branch

| Field | Value |
|---|---|
| Canonical repository | `Kyoshiki-Murasaki/oculory` |
| Starting branch / HEAD | clean `master` / `7f06e207c6086e7dafd2ec24f44246d31aa052ac` |
| Base tree | `b7ac1aced8aa14c9938182529675584a668c96b2` |
| Feature branch | `gate-f0-offline-preparation` |
| Branch created | `2026-07-12T20:47:42Z` |
| Remote base at creation | `origin/master` = `7f06e207c6086e7dafd2ec24f44246d31aa052ac` |
| Initial implementation commit | `a6ec555d681f780b8967fbda5071fbe22e25661d` |
| Repair commit used by passing run | `8ebf12feb5affedcee1dad041e4b95218f809b30` |
| Phase 6 tag | `phase6-external-git-scripted-validated` still peels to `7f06e207c6086e7dafd2ec24f44246d31aa052ac` |

Starting validation passed 401/401 ordinary tests, build, doctor, `git fsck --full` (two pre-existing dangling trees only), and Phase 6 evidence-index validation. The remote and annotated tag matched the frozen canonical history.

## Architecture and version identities

The additive generic layer is under `src/model/`: provider-neutral types, stable errors, authorization validation, deterministic caps/accounting, redaction/environment isolation, prompt/scenario manifests, state machine, mock provider, fault registry, and atomic evidence store. Git-specific adaptation is under `src/targets/git/model/`: the boundary-validating tool bridge and F0 orchestrator. The bridge reuses the generic MCP stdio client, exact discovered schemas, disposable Git fixture, per-call snapshots/diffs, process-group shutdown evidence, sibling sentinel, `git-verifier-v1`, and the approved Gate E suite evaluator without changing those frozen components.

| Artifact | Version |
|---|---|
| Model protocol | `oculory-model-protocol-v1` |
| Provider interface | `provider-adapter-v1` |
| Mock provider | `deterministic-mock-provider-v1` |
| Run / session | `model-run-v1` / `model-session-v1` |
| Authorization | `gate-f-authorization-v1` |
| Cap policy | `gate-f-cap-policy-v1` |
| Prompt / scenario manifest | `git-gate-f-prompt-manifest-v1` / `git-gate-f-scenario-manifest-v1` |
| Evidence / report | `gate-f-evidence-v1` / `git-gate-f0-report-v1` |

Unknown versions fail closed.

## Provider-neutral contract

Requests bind request/session/turn identity, adapter/provider/model/snapshot identity, prompt/scenario/offline-authorization digests, system/scenario instructions, ordered messages, available tools, exact MCP schemas, allowed names, output limit, sampling/reasoning controls, metadata, timeout, zero-retry policy, and tracing/redaction policy. Responses bind request correlation, provider request ID, reported provider/model/snapshot, messages, ordered calls and IDs, exact object arguments, separate prose, finish reason, synthetic usage, warnings/refusal class, raw sidecar reference, attempt count, latency metadata, and semantic digest.

Validation rejects unknown tools, duplicate IDs, malformed/non-object arguments, unauthorized calls, identity/correlation/version mismatch, ambiguous finish/call ordering, hidden retries, refusal defects, and continuation after terminal completion. Provider prose never overrides tool or independently observed state semantics.

## Authorization boundary

`authorizations/gate-f1-authorization-template.json` is structurally valid but has status `draft`, statement `NOT AUTHORIZED — TEMPLATE ONLY`, and null provider, model, pricing, window, reviewer, key name, and cap fields. The production validator refuses draft/revoked/expired/out-of-window authorization; blank mandatory fields; provider/model/scenario/digest/source/verifier/suite/target/lock mismatch; absent/negative caps; non-positive dollar cap; empty endpoint allowlist; invalid environment name; or literal secret.

F0 used a separate evidence-bound internal object: phase F0, mock provider, cost zero, network false, six fixed sessions, zero retries. Its digest was `096985adfdf5a6df9b1cfe6e268ec442aaeecaa54534afe62107a52022f620a2`. The draft template digest was `df6ff956e71985b6267cf26384a13df60a999645819017c2f8de7556822a6010`; it did not authorize execution.

## Prompt and scenario manifests

The prompt manifest binds the narrow operational system prompt, scenario and tool-result wrappers, stop rules, exact discovered tool-schema digest, scenario digest, model protocol, allowed/forbidden behavior, repository/remote prohibitions, scenario-scoped clarification/no-tool policy, turn/call policy, and bounded canonicalization rules. Digest: `de4da024830145e4a7b9091ee9325ffe202dbe6a72dee33db1f161028ab29edd`.

The scenario manifest binds the six proposed F1 cases to the frozen catalogue, partition/family/objective/instruction, fixture overlay and digest, intended entity, allowed/prohibited tools and paths, call maximum, golden outcome, applicable suite contract, no-tool/clarification policy, terminal/cleanup/sentinel rules, risk, F1/F2 eligibility, and declared mock trajectory. Digest: `c38ec6957a2959bee39a08ca35e97d0479e4a8a30294f4d6d95d851384a3a233`.

Neither generic prompt exposes holdout answers or verifier internals. `git-verifier-v1` remains authoritative.

## Cap, accounting, retry, secret, and network policy

`gate-f-cap-policy-v1` uses non-negative safe integers, tokens as whole units, cost as integer USD micros, per-million price inputs, cached-input subtraction, and ceiling division. It checks the worst-case next request before attempting it. Session/turn/per-session call/total call/input/output/tool-result context/retry/dollar bounds are enforced; exact bounds pass and one-unit-over fails. Missing, invalid, inconsistent, duplicate, negative, and overflow usage fail closed.

The F0 envelope was six sessions, four turns/session, six MCP calls/session, 36 total calls, 288,000 input tokens, 48,000 output tokens, 48,000 context tokens, zero retries, zero prices, and zero-dollar provider cost. Observed mock ledger: six sessions, 12 turns, eight MCP calls, 1,880 input tokens, 296 output tokens, 288 context tokens, zero retries, zero cost. Failed provider calls do not invent usage; observed usage is charged once by response digest. Canonical retry count is zero, and attempt count other than one is rejected as a hidden retry.

No real key was requested or read. Synthetic sentinel tests covered prompt, response, tool arguments, provider error, child environment, transcripts, terminal/report/error/log/checksum/Git-diff surfaces. Common key formats and the unmistakably synthetic sentinel are redacted; child environments are allowlisted and the pinned Git MCP environment receives no provider key/endpoint/proxy. The F0 registry contains only the non-network mock; provider aliases/endpoints, arbitrary URLs, and localhost fail before socket capability. Redirects are not implemented. Absolute real-repository paths, remote URLs, and clone/fetch/pull/push/remote tools fail closed.

## Runner state machine and tool bridge

Every session records the ordered phases `preflight` through `terminal`, including authorization/source/scenario/fixture/startup/initialize/discovery/prompt/provider validation/tool validation/execution/snapshots/verifier/continuation/final verification/shutdown/cleanup/evidence finalization. The only loop is the declared continuation back to a provider request. Illegal transitions fail closed.

The bridge validates scenario policy, tool name, object arguments, call ID, intended entity, cardinality/order, duplicate mutation, repository boundary, remote prohibition, and secrets before adapting ordered calls to the existing target harness. MCP `isError`, JSON-RPC error, client/transport/cancellation/timeout/crash, raw results, request IDs, schemas, snapshots, diffs, and journals remain distinct. Approved-suite results and the golden verifier are stored separately.

## Six golden mock sessions

| Scenario | Trajectory | Turns | Calls | Provider | Suite | Golden | Terminal / cleanup / evidence | Digest |
|---|---|---:|---:|---|---|---|---|---|
| `git-status-s1` | `git_status` → stop | 2 | 1 | stop | n/a | `verified_success` | passed / clean / complete | `8a3114bacc1a1004f004ba752e618fe64e53958a9abe46a228d25705d44abf31` |
| `git-stage-h1` | `git_status`, `git_add` → stop | 2 | 2 | stop | passed | `verified_success` | passed / clean / complete | `fb9a60435145d608e652b8b40789679d0e0551151f8a97ad27da626374ae14b7` |
| `git-branch-h1` | `git_branch`, `git_create_branch` → stop | 2 | 2 | stop | passed | `verified_success` | passed / clean / complete | `6768bc38a71fa91954364f6b3f9cffdec53a6f3284300a936473d8ca29d20eb9` |
| `git-missing-revision-a1` | `git_show` rejection → stop | 2 | 1 | stop | n/a | `valid_rejection` | passed / clean / complete | `2b16c3b4bf79fb6674ea64a7d87ff98843c02d213f50c2eba4d4e77b4e97954f` |
| `git-ambiguous-branch-a1` | `git_branch` read-and-stop | 2 | 1 | stop | n/a | `valid_rejection` | passed / clean / complete | `e4c9e3c928f166237883faf5e485a6286ee45dc23d6dc12d866834a438d600a8` |
| `git-add-traversal-a1` | `git_add` rejection → stop | 2 | 1 | stop | n/a | `valid_rejection` | passed / clean / complete | `de984c25dc4dd4ba5cda1dbf6f89a8c1a824481e3b431a9abe434aa4cb0e0f97` |

Each used a fresh fixture and fresh pinned MCP process. An additional clean read-only schema-binding preflight proved that actual discovery digest `fdcbe98d820cf91b2815c2d232545dd463d3633abe3ba8aee46116b576afc62d` matched the prompt binding; it was not counted as a model session.

## Fault campaign

All 57 registered cases passed with the exact preregistered classification, expected failed/inconclusive terminal outcome, and retained focused evidence: provider 12, tool-call 13, cap/runner 8, evidence 9, security 8, cleanup/process 7. The durable report names every ID and records expected/observed class, terminal outcome, evidence retention, and pass/fail. Categories include all required authentication/permission/rate/timeout/malformed/usage/identity/refusal faults; tool name/argument/entity/ID/order/cardinality/duplicate/error/prose faults; every cap; sidecar/terminal/reconstruction/write/finalization faults; secret/endpoint/repository/remote faults; and shutdown/escalation/process/fixture/sentinel/lock/uncertainty faults.

## Evidence durability and determinism

Evidence root: `.oculory/runs-model/git-gate-f0-offline-20260712T210744Z` (gitignored, untracked, append-only after `manifest.json`). It contains 218 files and 2,159,822 exact bytes. The checksum manifest has 217 entries, all independently verified; its SHA-256 is `b90862d93a0466560b39a20bc28c231a1d51bb3984fa9448b3137438a5947017`. Six terminal records, 57 fault records, 12 provider-request artifacts, 12 provider-response artifacts, and 24 content-addressed provider sidecars are present. Missing/corrupt evidence: zero. Aggregate reconstruction found exactly six terminals.

Each session retains its manifest, offline authorization, scenario, prompt, exact schemas, provider requests/responses, transcript, model/target state journals, per-call before/after/diff, verifier result, suite result, cap ledger, redaction report, cleanup/process proof, and terminal record. Atomic exclusive write, file `fsync`, rename, directory `fsync`, content digests, and run-wide checksums are used. Ordinary cleanup preserves `runs-model`; removal requires `--include-model` (or `--all`).

Seven repeats produced identical prompt, scenario, template, trajectory, and classification digests. Canonical JSON also passed recursive key-order, path-token, timestamp-independent semantic, array-order, and bounded presentation rules. No timestamp or absolute fixture path enters the semantic session digest.

## Failed attempt retained

The first authoritative attempt, `git-gate-f0-offline-20260712T210649Z`, from clean commit `a6ec555d681f780b8967fbda5071fbe22e25661d`, failed on the first session because the request exposed all discovered tools while authorizing only the scenario subset. The terminal classification was `unsupported_tool_call`. It remains preserved with 70 files, 78,965 bytes, one failed terminal, 57 focused fault records, zero network calls, zero cost, and checksum-manifest digest `876acfca593f1b11ee467e1cbc8018151329a8a3df17304fbeec6be6c81ba392`. The repair restricted available tools to the scenario subset while retaining the full exact schema snapshot, was committed separately, and used a new run ID. No failed session was replaced.

## Validation and evidence integrity

| Validation | Result |
|---|---|
| Ordinary `npm test` | 422 passed, 0 failed |
| Focused `npm run test:gate-f0` | 18 passed, 0 failed |
| Build / doctor | passed / all checks passed |
| Phase 6 evidence index | valid |
| Authorization-template validation | valid draft, executable false |
| Task / filesystem / issue scripted regressions | all `meaningful_technical_success`; `runs-model` preserved |
| Authoritative elapsed time | 28,336.546 ms |

Historical `.oculory/runs-live` remained exactly 81 files, 3,420,840 bytes, manifest digest `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e`. Every one of the six pre-existing `.oculory/runs-external` roots was byte-identical to its before-manifest. The local Phase 6 archive and sidecar were not modified; the standard sidecar check still passed. The target lock, approved suite, candidate review, mutation registry, Phase 6 index/evidence roots, and tag were unchanged.

## Authoritative command

```sh
npm run test:external-git-gate-f0 -- \
  --python /private/tmp/oculory-git-gate-ab-runtime/bin/python \
  --executable /private/tmp/oculory-git-gate-ab-runtime/bin/mcp-server-git \
  --git /opt/homebrew/bin/git \
  --lock "$PWD/test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml" \
  --provider mock \
  --scenario-manifest "$PWD/manifests/git-gate-f-scenario-manifest-v1.json" \
  --prompt-manifest "$PWD/manifests/git-gate-f-prompt-manifest-v1.json" \
  --authorization "$PWD/authorizations/gate-f1-authorization-template.json" \
  --run-root "$PWD/.oculory/runs-model" \
  --run-id git-gate-f0-offline-20260712T210744Z
```

## Strongest claim, limitations, and non-claims

Strongest supportable claim:

> Oculory's offline provider-neutral execution and evidence substrate behaved as tested under deterministic mocks and the pinned local Git MCP target, including six golden sessions, fail-closed caps/security/boundaries, durable evidence, and the registered offline fault campaign.

Limitations: one pinned Git MCP release, one macOS-arm64 host/runtime/Git version, deterministic reviewed mocks rather than a real model, synthetic usage, no live provider adapter or API-compatibility evidence, no syscall-level sandbox/network monitor, and a focused fault harness supplemented by ordinary MCP/verifier/evidence tests.

F0 does not establish model reliability, provider reliability, real-model tool-use accuracy, cross-model performance, paid-run reproducibility, live API compatibility, production readiness, security certification, MCP conformance, customer/developer adoption, market validation, or benchmark superiority.

## Exact F1 boundary and next action

F1 remains unauthorized. Before any future provider execution, a human must separately approve the exact provider, exact model identifier/snapshot, current official pricing and cached/tool-token treatment, privacy/retention and region, execution window, six scenario IDs, source/prompt/scenario/verifier/suite/target/lock bindings, session/turn/call/input/output/context/retry/unknown thresholds, endpoint allowlist, key environment name, tax/currency handling, and positive hard dollar cap. A real provider adapter would still need separate implementation and review.

Historical next action at the time of this private-history record: review the Gate F0 pull request and separately decide whether to authorize a six-session Gate F1 paid smoke. That PR is no longer current; Gate F0 is already in the fresh public root. The current post-Phase-7 decision boundary is in `docs/30_PROJECT_STATUS_AND_NEXT_STEPS.md` and still requires a separate exact provider/model/pricing/privacy/window/scenario/cap/endpoint/retry/unknown-threshold/dollar-cap authorization before any F1 traffic.
