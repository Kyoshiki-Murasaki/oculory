# 00 — Read me first

## What Oculory is (plain English)
Oculory turns recorded agent↔tool sessions on MCP servers into deterministic regression tests. It records what an agent actually did (which tools, which arguments, what the database looked like before and after), verifies whether the *intended outcome* really happened in the environment, mines the stable patterns into candidate assertions, has a human approve them, and then replays them after any change to the server, schema, prompt, or model — failing loudly when behaviour drifts.

## The five-year-old version
A robot helper does chores using buttons on a machine. Oculory watches which buttons the robot presses when the chore goes right, writes that down, and later — after someone changes the machine — checks the robot can still do the chores. If the machine says "done!" but the chore didn't actually happen, Oculory notices, because it looks at the chore, not the "done!" light.

## Exactly what was built (MVP status: working)
A single zero-runtime-dependency TypeScript package containing:
- three deterministic validation targets: a SQLite-backed task MCP server, a sandboxed filesystem server, and an in-memory issue tracker, all with injectable defects;
- a trace recorder with per-step environment snapshots; a deterministic outcome verifier; a normaliser with redaction hooks;
- an assertion miner (13 assertion types, provenance-linked, with explicit anti-overfitting rules);
- a review/approve workflow; a versioned suite compiler; a replay runner; a deterministic evaluator;
- a schema-diff + smoke-call baseline proxy; comparison and Markdown/JSON reporting;
- a full CLI (`oculory record → verify → mine → review → approve → suite → run → compare`);
- a 395-test offline baseline at the start of the 2026-07-12 final Phase 6 audit, three pre-registered local scripted experiments, isolated live-run support, risk-classified approval gates, external Git evidence validation, and budget guards.

## What it deliberately does not do
No web UI, accounts, billing, cloud, hosted anything, benchmark leaderboard, certification, browser automation, or destructive production execution. See docs/01 §Non-goals.

## Environment-driven deviations (read before judging the stack)
The initial repository was built in an offline environment. Later controlled live probes were run and preserved locally; tests and routine validation remain offline. Consequences and swap plans are documented in docs/03:
1. **npm + zero runtime deps** instead of pnpm monorepo (13 packages would be pure overhead at this size; split criteria documented).
2. **node:test** instead of Vitest; **hand-rolled validator** (`src/schema/validate.ts`) instead of Zod; **minimal faithful MCP layer** (`src/mcp/mcp.ts`) instead of the official SDK.
3. **Scripted deterministic agent policies remain the reproducible baseline.** Small live `gpt-4.1-mini` probes add controlled model evidence but do not establish general model reliability (docs/25, docs/27, docs/29).
4. **Internal schema-smoke baseline proxy** instead of an external OSS baseline (network-gated; docs/19).

## Immediate objective
Phase 6 has passed its final local audit, archive, and freeze criteria. Preserve the resulting freeze commit and annotated tag `phase6-external-git-scripted-validated`. Formal Gate B attempt 1 remains failed; repaired attempt 2 passed; Gates C and D passed; Gate E1 completed; and Gate E passed. Gate F0 subsequently passed its offline-only scope under deterministic mocks and the pinned local Git MCP target; no real provider/model call occurred. The first F0 authoritative attempt failed and remains preserved; the repaired new-ID attempt passed six/six sessions and 57/57 registered faults. Gate F1/F2 remain unauthorized. Read `docs/30_PROJECT_STATUS_AND_NEXT_STEPS.md` and `docs/43_GATE_F0_OFFLINE_PREPARATION_AND_VALIDATION.md` first.

The Phase 6 record selects the target in docs/31, defines the gates in docs/32, records the generic stdio client in docs/33, preserves the bounded spike in docs/34, records Gate C in docs/35, preserves the failed first formal Gate B attempt in docs/36, records its repair and passing attempt 2 in docs/37, validates Gate D in docs/38, records completed Gate E1 in docs/39, records passing Gate E in docs/40, audits the complete freeze in docs/41, proposes but does not authorize live Gate F in docs/42, and records the later offline-only Gate F0 in docs/43. Gates A, current B, C, D, E, and F0 passed their declared criteria; Gate B attempt 1 and the first F0 authoritative attempt remain failed. F1/F2 have not started.

## Exact next commands
    npm install          # fetches typescript + @types/node (devDeps only)
    npm run build
    npm test
    ./bin/oculory doctor
    ./bin/oculory experiment

## Reading order
00 (this) → 30 current status/handoff → 43 Gate F0 offline evidence → 41 final Phase 6 audit/freeze → 42 original Gate F proposal → 31 external-target selection → 32 integration/validation plan → 33 stdio-client architecture → 34 Git MCP Gate A/B spike → 35 Git MCP Gate C transport integrity → 36 failed formal Git MCP Gate B attempt → 37 cleanup repair and passing attempt 2 → 38 Gate D verifier validity → 39 Gate E1 scripted recording/mining → 40 Gate E replay/mutation validation → 01 product definition → 09 CLI → 05 experiment protocol → 21 historical audit. Before any future provider traffic: 43 and 42, then 23 and 24.

## File guide
| Doc | Contains | Use when |
|---|---|---|
| 01 | Product definition, lifecycles, term glossary | deciding what Oculory is/isn't |
| 02 | Requirements with IDs, priorities, acceptance tests | scoping or verifying features |
| 03 | Architecture, module map, interfaces, deviations | changing code structure |
| 04 | Every schema, versioning, hashing, serialisation | changing any persisted format |
| 05 | Experiment protocol + pre-registered decision rule | judging the evidence |
| 06 | Scenario catalogue + partitioning | adding scenarios |
| 07 | Miner specification (the differentiated core) | changing mining rules |
| 08 | Review & approval workflow | reviewing candidates |
| 09 | CLI reference + workflows | using the tool |
| 10 | Phase-by-phase implementation plan (as executed) | resuming/extending work |
| 11 | Master build checklist with ownership tags | tracking progress |
| 12 | Inputs & credentials needed | providing keys/config |
| 13 | Security & privacy architecture | before importing external traces |
| 14 | Testing strategy | adding tests |
| 15 | Quality standard with thresholds | judging "good enough" |
| 16 | Metrics & local telemetry spec | measuring the product |
| 17 | Open-source packaging | preparing a release |
| 18 | Shipping checklist | before tagging a release |
| 19 | Manual actions that genuinely need a human | your to-do list |
| 20 | Assumption & evidence register | epistemics of every claim |
| 21 | Final adversarial technical audit | before trusting anything above |
| 22 | Historical Phase 3 status snapshot | understanding Phase 3 chronology |
| 23 | Model traffic validation (Phase 2: what it added, what it can/cannot prove) | before running or interpreting `--policy model` |
| 24 | Run isolation and model-validation workflow | operating isolated model runs |
| 25 | Task-server live evidence (historical artifact caveat) | interpreting Phase 3 evidence |
| 26–27 | Filesystem target, plan, and evidence | interpreting Phase 4 evidence |
| 28–29 | Issue-tracker target, plan, and evidence | interpreting Phase 5 evidence |
| 30 | Canonical current status and next steps | always |
| 31 | External MCP target research, comparison, selection, and fallback | reviewing the proposed Phase 6 target |
| 32 | External MCP architecture, fixture, verifier, experiments, mutations, gates, and budgets | reviewing or implementing Phase 6 |
| 33 | Generic asynchronous MCP stdio-client boundary and evidence-preservation decision | implementing or reviewing the additive external-client foundation |
| 34 | Pinned Git MCP Gate A/B artifact, direct-path, rejection, stability, and cleanup evidence | reviewing the bounded external-target spike |
| 35 | Twenty-session Git MCP transport-integrity and deterministic fault evidence | reviewing Gate C transport findings |
| 36 | Formal Git MCP recipe/direct determinism evidence and the blocking cleanup/evidence-retention failure | reviewing attempt-1 history |
| 37 | Cleanup-evidence repair, fault injection, and the passing second formal Gate B attempt | reviewing current Gate B chronology and evidence integrity |
| 38 | Git verifier evidence contract, decision table, authored/mutation corpus, and Gate D decision | reviewing Gate D semantics before Gate E |
| 39 | Git Gate E1 external schema, 20-scenario scripted recording, isolation, mining, and unapproved candidate review | reviewing candidates before an explicitly authorized Gate E2 task |
| 40 | Human-reviewed Git suite, clean/holdout replay, layer-separated mutation results, benign controls, and Gate E decision | reviewing the completed scripted external Git milestone |
| 41 | Final Phase 6 chronology, evidence inventory, integrity audit, archive, freeze, and publication record | reviewing the scripted milestone freeze |
| 42 | Provider-neutral, separately budgeted, unexecuted Gate F proposal | reviewing whether any later model experiment should be authorized |
| 43 | Gate F0 provider-neutral offline implementation, mock validation, faults, evidence, and F1 boundary | reviewing the offline substrate and deciding whether to authorize F1 |
