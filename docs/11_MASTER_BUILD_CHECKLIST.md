# 11 — Master build checklist

Tags: [CLAUDE] automatable by Claude Code · [AUTOMATED] runs in scripts/CI · [DEV CREDENTIAL] needs your secret · [DEV REVIEW] needs your inspection · [DEV FINAL JUDGMENT] your call. Product-development work only.

| ✓ | Task | Tag | Evidence / artifact | Depends on | Next action |
|---|---|---|---|---|---|
| x | Repo foundation, strict TS, zero-dep build | [CLAUDE] | `npm run build` clean | — | — |
| x | Schemas + canonical hashing + validators | [CLAUDE] | unit-core tests | 1 | — |
| x | Demo server (domain, tools, mutations, stdio MCP) | [CLAUDE] | server-mcp tests incl. spawned stdio client | 2 | — |
| x | Scenario catalogue (21) + fixture | [CLAUDE] | `oculory scenarios` | 2 | — |
| x | Recorder + policies + verifier + normaliser | [CLAUDE] | pipeline tests | 3,4 | — |
| x | Miner with anti-overfit rules | [CLAUDE] | miner tests; docs/07 | 5 | — |
| x | Review/approve/suite/replay/evaluate/compare | [CLAUDE] | CLI + e2e tests | 6 | — |
| x | Mutation harness (10) + baseline proxy | [CLAUDE] | e2e detection asserts | 3 | — |
| x | Experiment + metrics + report | [AUTOMATED] | `.oculory/reports/experiment-*.{json,md}` | 7,8 | rerun anytime: `oculory experiment` |
| x | Test suite green | [AUTOMATED] | 26/26 pass | all | `npm test` |
| x | Docs 00–22 | [CLAUDE] | this directory | all | — |
| x | Packaging (LICENSE, CHANGELOG, example, CI yml) | [CLAUDE] | docs/17, docs/18 | 10 | — |
|   | Provide model API key + budget | [DEV CREDENTIAL] | docs/12, docs/19 M-1 | — | .env: ANTHROPIC_API_KEY=… |
|   | Model-provider agent (P28) | [CLAUDE] | new tests + rerun experiment | key | prompt in docs/10 |
|   | Review mined candidates yourself | [DEV REVIEW] | your approve/reject decisions with reasons | 9 | `oculory review` |
|   | Confirm scenario ground truth matches your intent | [DEV REVIEW] | docs/06 postconditions | — | read catalogue |
|   | External baseline comparison (P29) | [CLAUDE]+[DEV CREDENTIAL] | updated docs/05 | network | prompt in docs/10 |
|   | Go/no-go on model-traffic evidence | [DEV FINAL JUDGMENT] | experiment report with model agents | P28 | decide per docs/05 rule |

Blockers: network + model credentials only. Everything else is green.
