# Oculory

Oculory is a local-first behavioral regression-testing toolkit for MCP tool servers. It records tool sessions and environment state, normalizes and independently verifies outcomes, mines stable candidate assertions, requires human review, compiles approved assertions into a versioned suite, and replays that suite against fresh fixtures.

```text
record → normalize/verify → mine → review → compile → replay
```

The verifier treats independently observed state as authoritative. A tool response that says `ok` does not pass when the intended state is absent, the wrong entity changed, an intermediate prohibited mutation occurred, cleanup failed, or transport evidence is incomplete.

## Quick start

Node.js 22.13 or later is required. Runtime dependencies are intentionally zero.

```sh
npm install
npm test
npm run build
./bin/oculory doctor
```

The default tests and scripted experiments do not call a model provider.

## Validation targets

Oculory includes three locally authored deterministic targets:

- a SQLite-backed task server;
- a sandboxed filesystem server;
- an in-memory issue tracker.

Their scripted experiments are reproducible local pipeline evidence. Preserved live-model artifacts exist for parts of the earlier local-target work, with the provenance and artifact-availability qualifications in [the current project status](docs/30_PROJECT_STATUS_AND_NEXT_STEPS.md).

Phase 6 adds scripted evidence against one independently maintained external target: the pinned official-reference `mcp-server-git==2026.7.10` implementation over stdio. The audited chronology is:

- Gate A passed.
- Formal Gate B attempt 1 failed and remains preserved. Attempt 2 passed after evidence-finalization repair and is the current Gate B result.
- Gates C and D passed.
- Gate E1 completed.
- Gate E passed after explicit human review, 24/24 clean mining/eligible-holdout replay sessions, detection of 34/34 controlled harmful mutations in 102/102 trials, and zero false positives across five benign controls and 15/15 trials.

The strongest supported Phase 6 claim is:

> Oculory operated against one pinned external official-reference MCP implementation over stdio with deterministic disposable fixtures, independent per-step verification, a human-reviewed mined suite, clean eligible-holdout replay, and controlled layer-separated mutation evidence.

See the detailed evidence records:

- [Gate D verifier validity](docs/38_GIT_MCP_GATE_D_VERIFIER_VALIDITY.md)
- [Gate E1 scripted recording and mining](docs/39_GIT_MCP_GATE_E1_SCRIPTED_RECORDING_AND_MINING.md)
- [Gate E replay and mutation validation](docs/40_GIT_MCP_GATE_E_REPLAY_AND_MUTATION.md)
- [Phase 6 final audit and freeze](docs/41_PHASE6_EXTERNAL_GIT_FINAL_AUDIT_AND_FREEZE.md)
- [Gate F live-model proposal](docs/42_GATE_F_LIVE_MODEL_PROPOSAL.md)
- [Gate F0 offline preparation and validation](docs/43_GATE_F0_OFFLINE_PREPARATION_AND_VALIDATION.md)

Gate F0 subsequently passed from a clean feature-branch commit using only the deterministic mock provider and the pinned local Git MCP target: six/six golden sessions, 57/57 registered offline faults, seven determinism repeats, complete evidence/cleanup, zero real provider calls, zero provider-network calls, zero real credentials, and zero provider cost. The evidence is local and gitignored under `.oculory/runs-model`; the tracked F1 authorization artifact is a non-executable draft. Gate F1 and F2 remain unauthorized and unstarted.

## Evidence

The tracked deterministic index is [docs/evidence/phase6-external-git-evidence-index-v1.json](docs/evidence/phase6-external-git-evidence-index-v1.json). Validate it offline with:

```sh
npm run validate:phase6-evidence-index
```

Raw external traces, transcripts, journals, and prior live evidence are intentionally gitignored local evidence under `.oculory/`; they are not stored in GitHub. The final audit records their counts and digests, and a separately verified local archive preserves them outside the repository. The archive is not committed, pushed, or attached to a release.

## Scope and non-claims

Phase 6 covers one pinned external Git MCP release, one macOS-arm64 environment, one exact Python lock, one Git version, a narrow reviewed tool surface, scripted policies, and controlled mutation simulations. It does not establish:

- production readiness;
- MCP conformance;
- security certification or an upstream vulnerability;
- broad external-server compatibility or cross-platform validation;
- model reliability for the external Git target;
- developer adoption, customer validation, or market validation;
- benchmark superiority.

The original Gate F proposal authorized no traffic. Gate F0 later implemented and validated only the offline mock substrate; it made no real model/provider call. Gate F1/F2 remain unauthorized.

## Documentation

Start with [docs/00_READ_ME_FIRST.md](docs/00_READ_ME_FIRST.md). The canonical handoff is [docs/30_PROJECT_STATUS_AND_NEXT_STEPS.md](docs/30_PROJECT_STATUS_AND_NEXT_STEPS.md). The experiment protocol, schema rules, review boundary, and testing strategy are under `docs/05`, `docs/04`, `docs/08`, and `docs/14` respectively.

MIT licensed.
