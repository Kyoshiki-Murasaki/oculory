# 13 — Security and privacy

## Architecture
Local-first: no runtime network calls exist in the codebase (grep-verifiable; no fetch/http imports outside docs). All artifacts live under `.oculory/` in the working directory; deleting the directory (`oculory clean`) is complete deletion — no hidden caches. Zero runtime dependencies means the supply-chain surface is Node itself plus two devDependencies (typescript, @types/node).

## What is stored, and what never is
- Tool result payloads → sha-256 digest + minimal typed summary (ids, changed flag). Full payloads are never persisted.
- System prompts → digest field only (`system_prompt_digest`).
- Free text (user intent, final response) → passes `redactText` (emails, ≥7-digit runs) at normalisation.
- Secrets: keys are read from environment variables only, never written to traces, logs, fixtures, or reports; `.env` and `.oculory/` are gitignored, preventing accidental commits of local traces.
- Environment snapshots contain full demo-DB rows (10 synthetic tasks). For real databases the documented mode is digest-only snapshots + row diffs of selected entities (docs/21 U-3) — do not point the recorder at sensitive data before that lands.

## Requirement tiers (do not skip ahead)
1. **Local development (met now):** everything above; fixtures are synthetic; file permissions inherit the user's umask (acceptable for single-user local dirs).
2. **Before importing external traces (NOT met — import is intentionally absent):** stronger PII pass (names, addresses, tokens, high-entropy strings), per-field allowlist of what may leave the raw trace, provenance of consent for the data, retention policy with default expiry, and a dry-run report showing exactly what would be stored.
3. **Before CI:** secrets via CI secret store only; trace artifacts uploaded from CI must be the redacted normalised form, never raw.
4. **Before any hosted product:** out of MVP scope; nothing in this repo claims to meet it.

## Integrity & isolation
Suites are content-hashed; runs embed suite hash + tool schema hash, so tampering or drift is visible. Holdout ground truth is isolated in code and tested. No compliance claims (GDPR/SOC2/etc.) are made or implied anywhere — none have been established.

## Dependency security
`npm audit` applies to the two devDependencies only; rerun after any dependency addition. Adding runtime dependencies requires updating this document first.
