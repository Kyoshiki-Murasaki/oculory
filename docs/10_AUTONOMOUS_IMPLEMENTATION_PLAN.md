# 10 — Implementation plan (as executed) and remaining phases

The 27 planned phases were executed in this order; consolidated where one module satisfied several phases. Each row: what exists, its tests, and its acceptance state. Remaining phases include the exact prompt to hand Claude Code.

| # | Phase | Delivered in | Acceptance | State |
|---|---|---|---|---|
| 1 | Repo foundation | package.json, tsconfig (strict+noUncheckedIndexedAccess), bin/, .gitignore | `npm run build` clean | done |
| 2 | Shared schemas | src/schema/* | validator + canonical tests | done |
| 3 | SQLite domain | src/server/domain.ts | domain tests (idempotency, transitions, reset determinism) | done |
| 4 | MCP tool layer | src/server/tools.ts | JSON-Schema round-trip test | done |
| 5 | Fixture manager | fixtures/seed.json + reset() | reset determinism test | done |
| 6 | Trace recorder | src/runner/record.ts | trace validated on exit; per-step state diffs | done |
| 7–8 | Traffic runner + scenario loader | src/runner/{policies,catalogue}.ts | typed catalogue; 3 policies | done |
| 9 | Outcome verifier | src/pipeline/verify.ts | 6-label tests incl. invalid_acceptance | done |
| 10–11 | Smoke + full traffic | `record --smoke/--all` | CLI test chains | done |
| 12 | Normaliser | src/pipeline/normalize.ts | redaction + entity tests | done |
| 13 | Clustering | family grouping (docs/07 scope note) | reproducibility test | done |
| 14 | Miner | src/pipeline/mine.ts | 4 miner tests incl. anti-overfit | done |
| 15–16 | Review output + suite | store + compileSuite | CLI review/approve tests | done |
| 17–18 | Replay + evaluator | src/pipeline/{run,evaluate}.ts | holdout generalisation test | done |
| 19 | Mutation harness | src/server/mutations.ts (real code paths) | silent-write test | done |
| 20 | Baseline adapter | runSchemaSmokeBaseline (proxy, labelled) | e2e unique-detection asserts | done |
| 21 | Comparison report | compareRuns + renderers | e2e report asserts | done |
| 22 | CLI integration | src/cli/main.ts | CLI exit-code tests | done |
| 23 | CI integration | .github/workflows/ci.yml | runs build+test+run (needs a networked runner) | done (unverified in-container: no network) |
| 24–25 | Security/repro audits | docs/13, tests ×2 reproducibility | audits in docs/21 | done |
| 26 | Packaging | docs/17, LICENSE, CHANGELOG, examples/ | fresh-copy validation (docs/18) | done |
| 27 | Final validation | docs/21 + docs/22 | this repo state | done |

## Remaining phases (blocked on external inputs)
**P28 — model-provider agent** (needs API key + network). Prompt for Claude Code:
> Read docs/03 §Key interfaces and src/runner/policies.ts. Implement `src/runner/model-policy.ts`: an `AgentPolicy` that drives an Anthropic tool-use loop over the live `ToolSpec`s (convert via `toolSpecToJsonSchema`), temperature 0 and 0.7 variants, seed recorded, max 12 tool calls, API key from `OCULORY_ANTHROPIC_KEY` env only, per-run cost cap `--budget-usd` aborting cleanly. Record failures as traces, never throw them away. Add N=3 trials per scenario in replay for model agents and wire same-agent disagreement to `TrialResult`→`unstable`. Do not touch miner semantics. Add tests with a stubbed transport. Update docs/22.

**P29 — external baseline comparison** (needs network): install the chosen OSS MCP evaluator, configure it faithfully per its docs against `dist/src/server/main.js` (stdio), run the same 10 mutations, add its column to the experiment report, and replace 'schema-smoke-proxy' claims in docs/05 with measured results.

**P30 — external trace import**: implement `oculory import <file.jsonl>` mapping foreign session logs into RawTrace, gated on docs/13 §Before importing external traces.
