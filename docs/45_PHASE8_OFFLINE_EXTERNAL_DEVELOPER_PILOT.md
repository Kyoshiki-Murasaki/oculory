# 45 — Phase 8 offline external-developer pilot

_Implementation record for `phase8-offline-developer-pilot`, begun 2026-07-15. This phase prepares and validates a provider-free pilot kit. It does not recruit participants, run a human pilot, authorize Gate F1/F2, or create usage/adoption evidence._

## Rationale and decision

Phase 7 merged normally at `4ae893b2dfc1403da3647a32e8f59c9a2108e359`; exact post-merge CI run `29403228559` passed all six jobs. The remote Phase 7 branch was deleted and the local branch retained. Phase 8 selected the offline external-developer pilot-preparation path instead of Gate F1. No real provider adapter, endpoint, secret, call, retry, or cost is needed.

The objective is to test whether external developers can understand the existing workflow and compiled behavioral suite, not to establish production readiness, market demand, willingness to pay, or broad server compatibility.

## Exact scope

- repository-only `pilot:doctor`, `pilot:run`, `pilot:verify-report`, and `pilot:smoke` scripts;
- one existing pinned external target, deterministic fixture, mock-provider path, verifier, miner, reviewed candidate set, compiler, holdout replay, and registered regression;
- a versioned sanitized report plus strict semantic/privacy verifier;
- Track A reproducible workflow and Track B readiness assessment;
- protocol, privacy, feedback, success-criteria, counting, and field-guide documents;
- adversarial tests and provider-free cross-platform CI smoke;
- no participant contact, private-server ingestion, Gate F1/F2, package publication, release, tag, or merge.

## Architecture

The pilot source lives under `pilot/src` and compiles to `dist/pilot`; npm package policy includes only `dist/src`, so the command surface remains repository-only. A shared production module now owns the deterministic mock-provider Git turn loop used by both Gate F0 and the pilot. Gate F0 keeps its authorization/evidence/finalization responsibilities; the pilot owns its local raw store and sanitized report.

Track A runs:

```text
doctor → pinned schema preflight → 18 fresh mock mining sessions →
evidence inspection → existing Phase 6 8/2 reference review → compile →
2 fresh mock holdout replays → registered adapter regression → cleanup → report
```

The regression uses the existing `adapter/files-array-stringified` Gate E2 mechanism. Suite and independent-verifier channels remain separate. The external Git fixture/process harness was made Windows-portable by using the native PATH delimiter, accepting the Windows console executable, and creating a Windows askpass stub.

## Pinned prerequisite and command surface

Doctor accepts Node 22.13.x or Node 24 and rejects other major lines. It checks npm, Git, compiled files, CLI availability, temp/space paths, output containment/writability, provider configuration absence, and the pinned CPython 3.12.13 Git MCP environment. The 33 common behavior distributions match the reviewed Phase 7 versions exactly; the two Windows-only runtime distributions are separately exact-pinned, and only packaging bootstrap extras are allowed. Target version, source digest, and entry point are independently inspected.

Provider configuration presence fails closed based on environment variable names. Values are neither printed nor retained. Output is rejected inside the repository, `.git`, `.oculory/runs-live`, `.oculory/runs-external`, or `.oculory/runs-model`, including physical/symlink resolution.

## Privacy model

No telemetry or upload exists. Raw local artifacts remain only beneath the participant-chosen output. `pilot-report.json` contains counts, bounded stage results, digests, cleanup proof, and zero-provider accounting; it excludes identity, private paths, raw environment, source, transcripts, and payloads. The report verifier checks structural schema and semantic consistency, then scans for sensitive key/value forms. Manual review remains mandatory before optional sharing.

## Measures and pre-registered criteria

The protocol records setup/doctor/run/review time, task completion, assistance, error/recovery clarity, verdict comprehension, independent-state reasoning, candidate-review burden, suite usefulness, regression comprehension, workflow fit, and likely team/CI use. Criteria and missing/abandoned/invalid/assisted-session rules are fixed in `pilot/PILOT_PROTOCOL.md` before any participant.

## Validation implemented

Focused pilot tests cover unsupported Node, missing Git/target, provider configuration, spaces, unwritable/protected/Git paths, bounded child interruption, cancellation cleanup, unknown/malformed reports, missing stages, time inconsistency, impossible success, non-zero provider accounting, incomplete cleanup, absolute paths, raw environment/transcript forms, credentials, and failed regression detection.

Local validation under Node 24.14.0 passed clean install, build, typecheck, 455/455 ordinary tests, 18/18 focused Gate F0 tests, both evidence/authorization validators, all three deterministic experiments, CLI checks, Git integrity checks, and both normal and path-with-spaces pilot smokes. Each smoke completed 23 pinned-target sessions, 20 mock-provider sessions, 40 mock turns, 38 MCP calls, 10 candidates, the existing 8/2 reference decision, 2/2 holdout replays, controlled-regression detection, complete non-emergency cleanup, and zero real provider/network/credential activity.

Package verification passed for `oculory-0.1.0.tgz` with 146 files; pilot implementation, protected evidence, compiled tests, and raw artifacts were excluded. The finalized byte count and digest are recorded in the draft PR and completion report rather than embedded in this included package document, which would change the measured tarball. The publication-safety scan passed. Deterministic before/after inventories of all three protected roots were byte-identical: 81 files/3,420,840 bytes for `runs-live`, 1,300 files/42,498,076 bytes for `runs-external`, and 288 files/2,238,787 bytes for `runs-model`, with zero added, removed, changed, or aggregate-digest changes. Hosted exact-head results belong to the draft PR record and must not be inferred from this local implementation record before that run completes. None of these automated results is human-usage evidence.

## Independent audit interruption, privacy blocker, and repair

The first independent final-audit attempt was interrupted once by the platform safety layer. The resumed audit did not declare Phase 8 complete: it completed enough independent validation to prove a real blocking privacy defect at starting head `12890661c10ec333168269194f75a5d23acf5421`. PR 2 remained open, draft, and unmerged throughout.

The starting report verifier rejected the existing POSIX roots and canonical Windows backslash form, but accepted these exact synthetic spelling classes:

- a drive letter and colon followed by forward separators around the `Users`, synthetic account, and repository components;
- a drive letter and colon with a backslash before `Users`, then forward separators;
- a drive letter and colon with a forward separator before `Users`, then a backslash before the synthetic account;
- ordinary or multiline text containing any of those forms;
- the same drive-rooted form using fullwidth colon, Latin letters, and solidus characters that NFKC exposes;
- the same drive-rooted form using fullwidth solidus characters only;
- two leading forward separators followed by server/share components;
- two leading forward separators with a backslash between later server/share/path components.

Canonical JSON-escaped backslashes were still rejected after JSON decoding, and the existing recursive value traversal reached nested allowed fields. The defect was narrower: Windows recognition required backslashes in specific positions, UNC recognition was incomplete, no Unicode compatibility comparison existed, and participant-defined rating/binary-answer keys were not inspected as free text. That allowed a structurally valid report to state `privatePathsIncluded: false` while retaining a recognizable private absolute path.

Commit `aab14de074a0b634a524ce0d17f6b2a5445ec7fa` added a comparison-only detector. It derives an NFKC inspection string, explicitly maps U+2044 FRACTION SLASH and U+2215 DIVISION SLASH to `/`, then maps backslash to `/` for separator-independent recognition. NFKC also exposes the relevant fullwidth colon, Latin, solidus, and reverse-solidus forms. The original report object and every original string remain unchanged.

The detector retains the existing POSIX private roots and recognizes drive-rooted `Users`, `Documents and Settings`, and `home` roots case-insensitively across ordinary separator spellings. It rejects UNC and mixed UNC forms with a server and share. `file:` URLs are rejected only when they encode one of those recognized private POSIX, Windows, or UNC paths; ordinary protocol URLs, custom schemes, and a non-private file URL for `docs/README.md` remain allowed. This is an explicit bounded policy, not a claim of universal filesystem-path or Unicode-confusable detection.

Sensitive-content traversal still runs only after structural validation. It now inspects participant-defined object keys through the same checks and reports only the containing JSON field path, never the detected string. Existing credential, raw-environment, transcript, payload, and forbidden-field checks remain fail-closed.

The repair regression matrix exercises 29 prohibited path spellings, 11 structurally valid recursive placements or participant-defined keys, and 16 legitimate slash/backslash/colon/URL/Unicode strings through the public report verifier. The focused report suite passes 12/12. A generated passing pilot report also passed the CLI verifier; a separate CLI matrix rejected all 40 prohibited spelling/placement cases and accepted all 16 legitimate cases, then removed its temporary files.

Fresh local validation used Node 24.18.0 and npm 11.17.0. Clean install, build, typecheck, and all 460/460 ordinary tests passed; Gate F0 passed 18/18; Gate F1 authorization remained `draft` and `executable=false`; the Phase 6 evidence index passed; all three deterministic experiments retained `meaningful_technical_success`; launcher and Git integrity checks passed. The first doctor and smoke attempt exited 1 because the disposable pinned target was absent. After provisioning the exact CPython 3.12.13 and `mcp-server-git==2026.7.10` target outside the repository, doctor and both normal/path-with-spaces smokes passed with 23 target sessions, 20 mock sessions, 40 mock turns, 38 MCP calls, 2/2 replay, controlled-regression detection, temporary-output removal, and zero provider calls, provider network calls, or credential reads.

Package verification and installed-consumer checks passed with 146 files and zero provider calls. The archive excluded pilot implementation/compiled pilot code/tests/reports, Git/GitHub metadata, all `.oculory` roots and protected evidence, `node_modules`, environment/credential material, raw transcripts/payloads, temporary output, archives, and bundles. It was not published.

Fresh deterministic protected-root inventories remained byte-identical after the repair:

| Root | Files | Bytes | Aggregate SHA-256 | Added | Removed | Changed |
|---|---:|---:|---|---:|---:|---:|
| `runs-live` | 81 | 3,420,840 | `e816dbd1a4df6f11f481787d243919d194a931b9b5afb0859164ef332504f20b` | 0 | 0 | 0 |
| `runs-external` | 1,300 | 42,498,076 | `cfee4da7835eb61f8afd84a2ffe110d7d3ac37bcf5832846ab1425fc24f812c6` | 0 | 0 | 0 |
| `runs-model` | 288 | 2,238,787 | `bf71ae55e50bff81a62b9054755766a8856b05c7b49feb6c6d6afd2e3ea88624` | 0 | 0 | 0 |

Fresh PR CI run [`29486221638`](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29486221638) passed on exact repair head `aab14de074a0b634a524ce0d17f6b2a5445ec7fa`:

| Job | Result |
|---|---|
| [Ubuntu Node 22.13.0](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29486221638/job/87581239103) | passed |
| [Ubuntu Node 24](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29486221638/job/87581239085) | passed |
| [macOS Node 24](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29486221638/job/87581239111) | passed |
| [Windows Node 24](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29486221638/job/87581239158) | passed |
| [Deterministic offline experiments](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29486221638/job/87581239048) | passed |
| [Packed consumer install](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29486221638/job/87581239119) | passed |

The core matrix runs the ordinary tests and Unix/Windows path-with-spaces smoke; Windows also runs the determinism stress. Required checks were not weakened, and the workflow has no `continue-on-error`, report-artifact upload, provider secret, or persisted checkout credential. This repair validation does not replace the required repeated independent final audit.

## Limitations

- No human participant has run either track.
- Automated stage durations do not substitute for observed human task times.
- Track A covers one pinned Git MCP implementation, fixture recipe, two compiled families, and one controlled regression.
- Track B is an assessment and generates no integration.
- Cross-platform CI proves this bounded pilot path, not arbitrary external-server compatibility.
- Exact dependency versions are cross-platform constrained, but the Phase 7 macOS-arm64 wheel hashes are not misrepresented as cross-platform hashes.
- Raw local artifacts still require careful handling; only the validated report is shareable after manual review.

## What remains before any recruitment decision

1. Repeat the independent final audit against the repaired exact head. Do not treat the repair implementation or its green CI as that audit.
2. If and only if the repeated audit passes, make a separate explicit audit-and-merge decision while preserving the existing authorization boundaries.
3. Make a later, separate explicit recruitment decision. Do not contact participants during this repair task.

Gate F1 and Gate F2 remain unauthorized. The next decision after a clean independent audit is whether to recruit the pre-registered three-to-five-developer offline pilot; it is not permission to run a real provider.
