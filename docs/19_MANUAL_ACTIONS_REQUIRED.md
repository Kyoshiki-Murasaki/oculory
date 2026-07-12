# 19 — Manual actions required

Only tasks that genuinely require the developer. Everything else in this repository is automated or already done.

## [DEV CREDENTIAL] 1. Wire a real model provider
- **Why not automatable:** requires your API key and paid account; the build environment has no network.
- **Exact minimum action:** create `.env` (already gitignored) with `ANTHROPIC_API_KEY=sk-ant-…` (recommended default: Anthropic; format `sk-ant-` prefix) or `OPENAI_API_KEY=sk-…`. Set a hard budget cap in the provider console first (recommended: **$20** — the full catalogue is ~72 sessions × ~4 short calls; expect <$5 on a mid-tier model).
- **Where it plugs in:** implement `AgentPolicy` (`src/runner/policies.ts`) over the provider API — the interface is 1 method; `recordSession` and everything downstream is unchanged. Set `agent.kind: 'model'`, `temperature`, and run N≥3 trials per scenario (`docs/05 §Trials`).
- **Acceptance:** `oculory record --all` produces model traces; `oculory verify` labels ≥70% of non-adversarial traces `verified_success`; instability quarantine (trial disagreement) engages rather than crashing.
- **Consequence of postponing:** the core hypothesis (model-behaviour regression detection) remains unvalidated; everything you have is pipeline feasibility.

## [DEV REVIEW] 2. Review mined candidates against your own judgment
- **Why not automatable:** observed behaviour must never auto-become ground truth (docs/08). The experiment's `--all-stable` auto-approval is explicitly an unattended-mode shortcut.
- **Exact minimum action:** run `oculory experiment`, then `oculory review`, and for each candidate confirm or reject the stable assertions. The prepared table shows type, params, confidence, support, and risk notes. Expected effort: ~10 minutes for 12 candidates / ~92 assertions.
- **What to return:** a list of candidate ids with approve/reject/edit and one-line reasons; apply via `oculory approve <id>` / `oculory reject <id> --reason "…"`.
- **Acceptance:** every gate-eligible assertion in `suite.json` carries a human review record.

## [DEV CREDENTIAL] 3. External baseline comparison (network-gated)
- **Why not automatable here:** installing an external OSS MCP-eval baseline requires the npm registry.
- **Exact minimum action:** on a networked machine: `npx mcp-eval` (or current equivalent) pointed at `node --experimental-sqlite dist/src/server/main.js`, once per mutation (`OCULORY_MUTATION=<id>`), record detected/missed per mutation into `.oculory/reports/external-baseline.json` using the same shape as `BaselineResult`.
- **Recommended default until then:** treat the internal `schema-smoke-proxy` numbers as a *lower bound on what naive tooling catches*, never as a claim about any named product.
- **Consequence of postponing:** the phrase "detects what existing tools miss" may not be used anywhere public.

## [DEV FINAL JUDGMENT] 4. Ship / no-ship decision
- **Why not automatable:** judgment call on whether the evidence (docs/05 results, docs/21 audit, unresolved issues) meets your bar.
- **Prepared evidence:** `.oculory/reports/experiment-report.md`, `docs/21_FINAL_TECHNICAL_AUDIT.md`, `docs/22_CURRENT_STATUS_AND_NEXT_ACTIONS.md`.
- **Acceptance:** an explicit written decision recorded in docs/22, choosing one of the three shipping states in docs/18.
