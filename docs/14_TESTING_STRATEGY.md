# 14 — Testing strategy

Runner: `node:test` (Vitest swap documented in docs/03). Command: `npm test` (build + all suites). Current: **26 tests, 26 passing, 0 skipped, ~4 s**, no known flaky tests (flaky policy: quarantine by name in a `KNOWN_FLAKY` list, fail CI if a quarantined test passes 20× — list is empty).

| Layer | File | Covers |
|---|---|---|
| Schema/unit | test/unit-core.test.ts | canonical JSON, hashing, validators with path errors, entity extraction incl. word-boundary regressions |
| Domain | test/server-mcp.test.ts | CRUD, transitions, idempotency, structured errors, deterministic reset, enum validation, mutation flags (incl. silent-write truth check) |
| MCP integration | test/server-mcp.test.ts | JSON-RPC round trip, JSON-Schema shapes, unknown method, notification silence, **spawned stdio server driven by a real pipe client** |
| Verifier | test/pipeline.test.ts | success≠ok-calls, valid_rejection, invalid_acceptance |
| Miner | test/pipeline.test.ts | failure-trace refusal, MIN_SUPPORT, both anti-overfit rules, one_of from state-changing sets, provenance non-empty |
| Evaluator | test/pipeline.test.ts | holdout generalisation of entity assertions, vacuous conditionals, loud tool_required |
| Isolation | test/pipeline.test.ts | miner-facing loader excludes holdout+smoke |
| Reproducibility | pipeline + e2e | mine×2 identical; full experiment ×2 identical decisions/mutations/assertion counts |
| E2E | test/e2e.test.ts | full experiment: 100% clean baseline, named behaviour-level detections, benign-FP zero, artifacts written |
| CLI | test/e2e.test.ts | exit codes 0/1/2, error messages, full command chain on a temp store |

Isolation: every store-touching test uses `mkdtemp` temp dirs; every domain test uses fresh in-memory SQLite; fixtures are deterministic by logical clock. Golden-file testing is covered by hash equality (canonical serialisation makes byte-golden redundant). Property-based tests: worthwhile next for `canonicalJson` (random JSON → parse(canonical) == normalised input) — noted, not blocking. Coverage expectation: every assertion type, every outcome label, every mutation flag, and every CLI exit code has at least one test — currently satisfied; c8-style line coverage is unavailable offline and is a P2 nicety, not a gate. Performance: e2e asserts nothing slower than the test timeout; experiment runtime is recorded in metrics (<1 s). Failure injection: mutations ARE the failure-injection framework; the wrong_success/silent_write tests are injected-failure tests by construction. CI matrix: Node 22/24 in `.github/workflows/ci.yml` (unverified in-container — no network).
