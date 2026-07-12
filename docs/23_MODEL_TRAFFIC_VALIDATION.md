# 23 — Model traffic validation

Companion to docs/05 (experiment protocol) and docs/21 (audit). Read this before running `--policy model` or interpreting its results.

> **Phase 3 update:** for anything beyond a one-off, prefer the isolated `model-smoke` / `model-experiment` / `model-replay` commands over raw `record --policy model`. They give each run its own directory, never auto-approve, and gate approval by provenance/risk. This document still explains what model traffic *proves*; the safe **workflow** (run isolation, contamination avoidance, approval safety, cleaning runs) is in **docs/24**.

## What Phase 2 added

The scripted pipeline (record → verify → normalize → mine → review → approve → suite → run → compare) is unchanged in behaviour. What's new sits entirely inside the traffic-generation step:

- `AgentPolicy.run()` and `recordSession()`/`replaySuite()`/`runExperiment()` are now `async` (network I/O is inherent to a real model call; scripted policies just resolve immediately, unchanged in substance).
- `src/runner/model-policy.ts`: a `ModelPolicy` (implements `AgentPolicy`) that runs a controlled tool-call loop against an injectable `ModelClient`, plus an `OpenAiClient` implementation of that interface. Tool schemas are converted via the existing `toolSpecToJsonSchema` (src/mcp/mcp.ts) — no second schema-conversion path.
- `RawTrace.agent` gained `provider`, `model`, `tokens_in`, `tokens_out`, `cost_usd`, `budget_usd` (schema_version 2 — docs/04). All null for scripted traces.
- A hard per-invocation budget guard (default $5, `--budget-usd` / `OCULORY_BUDGET_USD`), fails closed.
- `src/pipeline/instability.ts`: recording-time instability detection for `--trials N>1` (distinct from the still-unimplemented replay-time `unstable` flag — docs/04 "Two kinds of instability").
- `./bin/oculory record --policy model --model <name> --trials N --budget-usd <cap>`.

## What has NOT happened

No test in this repository, and no run performed while building Phase 2, has called a real model API. Every test exercises `ModelPolicy` through a hand-written stub `ModelClient`. `OpenAiClient`'s HTTP wire format follows OpenAI's documented Chat Completions tool-calling contract but has not been confirmed against a live endpoint in this build environment (no network egress, no key here). The first real run is a genuinely new event, not something this document can pre-announce the result of.

## Scripted traffic vs. model traffic — what actually differs

| | Scripted (`plannerV1`/`plannerLite`/`plannerAlt`) | Model (`ModelPolicy`) |
|---|---|---|
| Tool selection | Keyword-scored against live tool name+description | The model reads the same schema and decides |
| Argument construction | Filled from a hand-coded intent→param map | The model constructs JSON arguments itself |
| Failure modes it can produce | Only the ones the policy author anticipated | Wrong tool, malformed args, wrong argument values, giving up early, hallucinating a nonexistent tool, ignoring an error and repeating a bad call — a strictly larger space |
| Determinism | Fully deterministic, same input → same trace every time | Not guaranteed — this is exactly what `--trials N` and recording-time instability exist to measure |
| Cost | $0 | Real, metered, budget-capped |
| What a "detection" proves | The mining/replay/comparison *mechanics* work | The above, **plus** something about how this specific model behaves on this specific server on this specific day |

The scripted policies are schema-sensitive on purpose (docs/05), so they already prove the pipeline reacts to real interface changes. What they cannot do — by construction, not by bug — is exhibit the failure modes only a model produces: misreading an ambiguous description, inventing an argument, giving up after a rejected call instead of retrying correctly. That gap is exactly what Gate G2 (docs/22) is waiting on.

## Running a cheap smoke test

```sh
export OPENAI_API_KEY=sk-...          # environment variable only; never a flag, never committed
./bin/oculory record --smoke --policy model --model gpt-4.1-mini --trials 3 --budget-usd 1
./bin/oculory verify
./bin/oculory review
```

`--smoke` limits this to the catalogue's 2 smoke-partition scenarios (see `oculory scenarios`), so `--trials 3` means at most 6 real completions plus one per tool call the model makes — cheap enough to sanity-check the wiring before spending anything on the full 24-scenario catalogue. `--budget-usd 1` caps it hard; the command exits with a clear `BudgetExceededError` rather than a silent partial run if that's not enough. Set a second cap in the OpenAI console regardless — the CLI's guard is a second line of defense, not a replacement for one.

To run the full catalogue once the smoke test looks sane: drop `--smoke` for `--all`, raise `--budget-usd` accordingly, and compare the resulting `oculory mine` / `oculory review` output against the scripted run's `.oculory/reports/experiment-report.md`.

## What model traffic CAN provide, once run

- Direct evidence of whether real tool-selection/argument-construction failures occur on this server, and whether the miner's assertions (in particular the anti-overfitting rules — docs/07) hold up against genuinely variable, non-scripted phrasing and tool-call sequences.
- A read on recording-time instability: does the same model, same scenario, produce a different tool sequence or outcome across `--trials N`? (`.oculory/reports/recording-instability.json`.)
- A real cost and latency figure for running this kind of traffic, replacing the "$0, scripted" caveat in the existing experiment report with an actual number.

## What model traffic CANNOT provide, even after a clean run

- **A production-value claim.** One model, one server, one day's traffic against 24 hand-written scenarios is still not real production usage. It moves the needle from "zero model evidence" to "some model evidence on a toy server," not to "validated in production."
- **A head-to-head against a real competing tool.** The baseline is still the internal schema-smoke proxy (docs/19 §3 — external comparison remains network-gated and undone).
- **Generality.** Still one domain (docs/21 U2). A clean model result on the task-tracker server says nothing about a retrieval-shaped or destructive-tool-shaped server.
- **A permanent result.** Model behaviour on a given model version can and will change; this is precisely the recurring-workload argument in the original thesis (`strategy/company-thesis.md` §10), not a one-time checkbox.

## Interpreting instability

If `recording-instability.json` shows `unstable: true` for a scenario: do not mine from that scenario's traces as-is. Either (a) increase `--trials` and require a supermajority rather than unanimous agreement before treating a scenario as mining-eligible (not implemented — a candidate follow-up, not assumed here), or (b) treat the scenario as evidence of a genuine ambiguity in the server's tool surface (an `overlapping_tool_added`-style problem) rather than a pipeline defect. Either way, instability is *information about the server or the model*, not noise to average away.

If every trial agrees: that is consistent with, but does not prove, deterministic-enough behaviour — three trials is a smoke-test sample size, not a statistical guarantee. Treat higher `--trials` counts as buying more confidence, not certainty.

## Why the scripted baseline experiment is still not production validation

Everything docs/05 and docs/21 already say remains true and is not superseded by Phase 2's existence: the experiment demonstrates pipeline feasibility and detection mechanics under deterministic, schema-sensitive scripted traffic against an internal proxy baseline. Phase 2 adds the *capability* to gather model evidence; it does not retroactively supply that evidence. The distinction that matters going forward is simple and should be preserved in every future report this project produces: **scripted-pipeline numbers** (mechanical, reproducible, $0) versus **model-traffic numbers** (behavioural, variable, costed) are two different kinds of evidence, and neither should be quoted as if it were the other.
