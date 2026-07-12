# 03 — Technical architecture

## Stack decision (and the deviation from the brief)
The brief specified a pnpm monorepo with Zod, Vitest, and the official MCP SDK. This repository was built **offline** (npm registry unreachable), and independently of that, a 13-package monorepo is premature for ~3k lines with one consumer. Decision: **single npm package, zero runtime dependencies, modular `src/` directories that mirror the intended package boundaries.** Split into packages when (a) an external consumer needs `trace-schema` alone, or (b) two modules need conflicting dependencies. Each stand-in below is confined behind the interface its replacement would implement:

| Intended | Stand-in | Swap plan |
|---|---|---|
| Zod | `src/schema/validate.ts` (same call-site shape) | replace `Shape`s with `z.object`s; one file |
| Vitest | `node:test` + `node:assert/strict` | mechanical; test bodies unchanged |
| @modelcontextprotocol/sdk | `src/mcp/mcp.ts` (JSON-RPC 2.0/stdio, `initialize`, `tools/list`, `tools/call`, spec-shaped wire formats) | implement `McpEndpoint` over the SDK client; server: register the same `ToolSpec`s |
| pnpm workspaces | `src/{schema,server,mcp,runner,pipeline,cli}` | directories already match the intended package map below |
| model providers | scripted `AgentPolicy` implementations | implement `AgentPolicy.run()` over a provider API |

## Module map (intended package → current directory)
| Intended package | Now | Purpose | Must not |
|---|---|---|---|
| trace-schema / suite-schema / scenario-schema | `src/schema/` | types, canonical JSON, sha-256 hashing, runtime validation | contain I/O or domain logic |
| demo-server | `src/server/` | SQLite task domain, tool layer, mutation flags, stdio entrypoint | know about traces or mining |
| (mcp client/server adapter) | `src/mcp/` | `McpEndpoint` abstraction, JSON-RPC handling, stdio transport | contain business logic |
| traffic-runner + trace recorder | `src/runner/` | scenario catalogue, agent policies, session recorder | read holdout ground truth beyond the scenario being executed |
| outcome-verifier, normalizer, miner, regression-runner, mutation-harness, baseline-adapter, reporter | `src/pipeline/` | verify, normalize, mine, suite, replay, evaluate, compare, baseline, experiment, store | call any network or LLM |
| cli | `src/cli/` | argument parsing, command dispatch, exit codes | contain pipeline logic beyond wiring |

## Data flow (implemented end to end)
scenario → policy (model request stand-in) → tool selection → MCP invocation → tool result → environment effect → final response → **outcome verification (state-based)** → raw trace (JSONL) → normalised trace → family grouping → candidate mining → review/approval → versioned suite → replay (fixture reset per trial) → deterministic evaluation → run comparison → regression report (JSON + Markdown).

## Key interfaces (see source for full definitions)
```ts
interface McpEndpoint { listTools(): ToolSpec[]; callTool(name, args): McpToolResult; serverVersion(): string }
interface AgentPolicy { id: string; run(scenario, tools, sink): string }        // sink.call() records steps
recordSession({scenario, policy, fixture, mutationId}): RawTrace                 // validated on exit
verifyOutcome(scenario, trace): OutcomeRecord                                    // deterministic-state-v1
mineAll(traces: NormalizedTrace[]): CandidateTest[]                              // provenance-linked
compileSuite(candidates): ApprovedSuite                                          // suite_hash over tests
replaySuite(suite, {mutationId, fixture, partitions}): SuiteRunResult
compareRuns(baseline, current): ComparisonReport
```
Environment reset: fresh in-memory SQLite + fixture rows per session; logical clock (not wall time) so state hashes are bit-stable. Fixture manager = `fixtures/seed.json` + `TaskDomain.reset()`. Provider abstraction = `AgentPolicy`. Baseline adapter = `runSchemaSmokeBaseline` (proxy; external adapters plug in beside it).

## Boundaries that are enforced, not aspirational
- Miner receives traces only via `Store.loadMiningTraces()` (excludes holdout/smoke) — unit-tested.
- Miner consumes only `verified_success` / `valid_rejection` traces — unit-tested.
- Evaluator and verifier are pure functions of (assertion|scenario, trace) — no store access.
