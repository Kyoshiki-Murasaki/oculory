# 15 — Product quality standard

What makes this MVP *good* rather than merely functional, with measurable thresholds. "Test" names an executable check; "failure response" is what must happen when the threshold is missed.

| Q | Dimension | Metric | Threshold | Test | Failure response |
|---|---|---|---|---|---|
| Q-01 | Suite noise | unmutated pass rate | 100% | e2e assert | treat as Oculory bug; block everything else |
| Q-02 | False positives | benign-mutation detections | 0 | e2e assert on tool_order_changed | demote offending assertion type to advisory |
| Q-03 | Detection value | unique meaningful detections beyond baseline | ≥3 | e2e assert | decision rule downgrade (docs/05) |
| Q-04 | Determinism | LLM calls in verify/mine/evaluate | 0 | code inspection (audited docs/21) | reject the change |
| Q-05 | Stability | unstable assertions reaching suites | 0 | compileSuite filters non-stable | fix compiler |
| Q-06 | Provenance | assertions without trace ids | 0 | miner test | fix miner |
| Q-07 | Reproducibility | repeated-run divergence | 0 | two repro tests | find nondeterminism before anything else |
| Q-08 | Report clarity | every failure carries expected-vs-observed detail | 100% | evaluator detail strings; compare output | improve detail strings |
| Q-09 | Setup | fresh-copy commands to first green experiment | ≤4 commands | docs/18 validation | simplify |
| Q-10 | Failure UX | CLI misuse yields actionable stderr + exit 1 | all commands | CLI tests | add guard |
| Q-11 | Cost | scripted experiment inference cost | $0; model experiment ≤ configured budget | metrics.json | cap enforcement (P28) |
| Q-12 | Review burden | human review time per 12-family catalogue | ≤10 min | measured informally (docs/08) | shrink table, better bulk classes |
| Q-13 | Modularity | cross-module imports against docs/03 boundaries | 0 violations | review | refactor |
| Q-14 | Privacy | payloads/secrets persisted | 0 | schema + grep | stop-ship |
| Q-15 | Docs | commands in docs that don't work verbatim | 0 | docs/18 link+command pass | fix docs |

## Anti-features (explicitly deprioritised, per the brief and on merit)
Decorative dashboards; LLM judging where a deterministic rule exists; generic synthetic scenario generation (untethered from verified outcomes it just manufactures noise); scores without stated ground truth; vague "observability"; premature server certification; abstraction layers with a single implementation (the two we kept — `McpEndpoint`, `AgentPolicy` — each have a concrete second implementation scheduled with an external dependency attached).
