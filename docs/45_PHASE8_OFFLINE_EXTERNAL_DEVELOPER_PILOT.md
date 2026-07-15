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

## Limitations

- No human participant has run either track.
- Automated stage durations do not substitute for observed human task times.
- Track A covers one pinned Git MCP implementation, fixture recipe, two compiled families, and one controlled regression.
- Track B is an assessment and generates no integration.
- Cross-platform CI proves this bounded pilot path, not arbitrary external-server compatibility.
- Exact dependency versions are cross-platform constrained, but the Phase 7 macOS-arm64 wheel hashes are not misrepresented as cross-platform hashes.
- Raw local artifacts still require careful handling; only the validated report is shareable after manual review.

## What remains before recruitment

1. Obtain a fresh complete six-job CI run on the exact draft-PR head, including Windows and Unix pilot smoke.
2. Perform an independent audit of the kit, protocol, privacy rules, report schema, and observed cleanup.
3. Make a separate explicit recruitment decision. Do not contact participants during Phase 8 implementation.

Gate F1 and Gate F2 remain unauthorized. The next decision after a clean independent audit is whether to recruit the pre-registered three-to-five-developer offline pilot; it is not permission to run a real provider.
