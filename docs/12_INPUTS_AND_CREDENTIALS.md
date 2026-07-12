# 12 — Inputs and credentials (product development only)

| Input | Class | Recommended default / format | Needed when | Handling | Consequence of postponing |
|---|---|---|---|---|---|
| Node.js | required now | ≥22.13 (tested on 22.22); Node 23+ drops the `--experimental-sqlite` flag need | build/run | — | nothing runs |
| Package manager | required now | npm (lockfile committed); pnpm fine too — zero runtime deps | install | — | — |
| Git repo / GitHub | required for CI | any; default branch `main` | pushing CI | — | CI unverified (as now) |
| OS | required now | Linux/macOS; Windows untested (docs/21 U-5) | — | — | Windows users blocked |
| SQLite tooling | not required | bundled `node:sqlite` | — | — | — |
| Model provider credential | required for model traffic | `OCULORY_ANTHROPIC_KEY` env var (never a file, never an argument); Anthropic chosen as default provider — first-party tool-use loop, stable SDK | phase P28 | env only; `.env` is gitignored; never logged; traces store no key material | experiment remains scripted-agents-only; hypothesis about model behaviour untested |
| Model selection | required for model traffic | `claude-sonnet-4-6` default; one cheap + one strong model for variance | P28 | recorded in trace `agent.id` | — |
| API budget limit | required for model traffic | `--budget-usd 5` per experiment run; abort cleanly at cap | P28 | recorded in metrics | uncontrolled spend risk |
| CI secrets | required for CI model jobs | GitHub Actions secret `OCULORY_ANTHROPIC_KEY` | P28+CI | repo settings, not YAML | model jobs skipped |
| External example traces | optional | JSONL, one session per line; will be mapped by `oculory import` | P30 | must pass docs/13 gates first | import path stays unproven |

Nothing else is needed. No business, marketing, grant, or sales information is requested anywhere in this repository.
