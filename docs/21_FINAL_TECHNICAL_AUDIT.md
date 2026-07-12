# 21 — Final technical audit

Adversarial review from six perspectives. Findings below are real (several were caught and fixed during this build, with regression tests); severity: **S1** blocks any release, **S2** blocks public release, **S3** must be documented.

## Issues found and FIXED (evidence in git-visible code + tests)

| # | Perspective | Issue | Severity | Fix + evidence |
|---|---|---|---|---|
| F1 | evaluation researcher | **Miner froze incidental constants** — `assignee="dana"` (single-scenario family) and untouched `priority` fields were mined as postconditions and failed on holdout re-wordings (unmutated pass rate was 90%) | S1 | Change-eligibility + corroboration rules in `mineStateAssertions` (docs/07 §State assertions); unmutated pass rate now 100%; anti-overfit unit tests lock it in |
| F2 | evaluation researcher | **Suite noise masked detection** — the 10% baseline noise from F1 hid the `description_weakened` regression (mutated failure ≠ regression when baseline already failed) | S1 | Same fix; the pre-registered rule now demands 100% unmutated pass before any detection is counted |
| F3 | sceptical MCP engineer | Original `description_weakened` mutation was undetectable by ANY agent that reads tool names — tool names carry selection signal | S2 | Redesigned as realistic *description drift* (keywords migrate between overlapping tools); detected via `tool_required` |
| F4 | test-infrastructure engineer | `node --test <dir>` silently failed to run any test (module-resolution quirk); a green-looking CI would have run 0 tests | S1 | Glob pattern + `NODE_OPTIONS` flag propagation in the `test` script; run reports 26/26 |
| F5 | security reviewer | Raw result payloads in traces would leak data when traces are shared | S2 | Traces store `result_digest` (sha256) + minimal `result_summary` (ids/flags), never full payloads; env snapshots keep full rows ONLY because the demo fixture is synthetic — digest-only mode is specified (docs/13) and required before external import |
| F6 | open-source maintainer | Auto-approval in the experiment could be mistaken for the product's review model | S2 | Auto-approval is labelled "unattended experiment mode" in the persisted review record itself; docs/08 and docs/19 §2 make human review non-optional for real use |

## Issues found and NOT resolved (documented, with exact required correction)

| # | Perspective | Issue | Severity | Required correction |
|---|---|---|---|---|
| U1 | evaluation researcher | **All traffic is scripted.** Every detection number describes pipeline mechanics under deterministic schema-sensitive proxies, not model behaviour. Circularity risk: policies and mutations were designed by the same author | S2 (for any external claim) | Wire a model provider (docs/19 §1); re-run; report scripted vs model numbers side by side |
| U2 | evaluation researcher | **One domain, one fixture.** 8/9 recall on a task tracker is not generality | S2 | Second structurally different server (read-heavy retrieval domain) before any generality claim |
| U3 | sceptical MCP engineer | `overlapping_tool_added` is a known FN: deterministic tie-breaking hides additive ambiguity | S3 | Documented in docs/05; expected to resolve with stochastic model traffic (or add agent-population variance) |
| U4 | test-infrastructure engineer | Holdout isolation is enforced by loader convention + a unit test, not by filesystem/process separation | S3 | Acceptable for local MVP; move holdout traces to a separate store root before multi-contributor work |
| U5 | security reviewer | Redaction is a minimal email/digit pass; PII detection is not implemented | S2 (before external traces) | Implement the docs/13 pre-import gate; refuse `oculory import` until then (command intentionally not implemented) |
| U6 | open-source maintainer | No CI has actually executed (offline build); `.github/workflows/ci.yml` is written but unverified | S2 | Push to GitHub, confirm green before tagging v0.1.0 |
| U7 | first-time CLI user | Interactive review is list-based (`review` + `approve <id>`), not a TUI; fine but unpolished; `import` and true `cluster` commands are absent by design | S3 | Documented in docs/09 as post-MVP |
| U8 | evaluation researcher | Only ONE benign mutation probes false positives | S3 | Add ≥3 benign probes (docs/20 A-09) before recommending blocking gates |

## Checks performed
Unsupported claims — every quantitative claim in docs traces to `experiment-metrics.json` or test output; scripted-agent caveat appears in the report itself. Circular validation — mining excludes failure-labelled traces; detection is measured against *pre-registered* `meaningful` flags set in the mutation registry before results existed. Leakage — holdout loader test; holdout phrasings share no template with mining. Hidden manual work — docs/19 lists all four human tasks; nothing else requires a human. LLM dependence — zero LLM calls anywhere in the pipeline. Error handling — CLI exit codes tested; structured `DomainError`/`ValidationError` types; no silent catches (`grep 'catch {}'` clean except the intentional wrong_success defect). Reproducibility — dual-run suite-hash equality is a test.

## Final technical recommendation
**Ready for private technical use; NOT ready for an initial open-source release.** Do not ship publicly until: (1) U1 model traffic has run at least once, (2) U6 CI is green on a fresh clone, (3) U5's import gate stays closed, and (4) an outside developer completes the quick start unaided (A-12). Condition under which the MVP should not be shipped at all: if model-driven traffic (U1) yields <50% stable assertions or a nonzero benign-probe FP rate that review cannot eliminate — that would falsify the core stability hypothesis rather than a fixable defect.
