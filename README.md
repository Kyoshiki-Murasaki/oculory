# Oculory

[![CI](https://github.com/Kyoshiki-Murasaki/oculory/actions/workflows/ci.yml/badge.svg)](https://github.com/Kyoshiki-Murasaki/oculory/actions/workflows/ci.yml)

Oculory is a local-first behavioral regression-testing toolkit for MCP tool servers. It records tool sessions and environment state, independently verifies outcomes, mines stable candidate assertions, requires human review, compiles approved assertions into a versioned suite, and replays that suite against fresh fixtures.

```text
record → normalize/verify → mine → review → compile → replay
```

The verifier treats independently observed state as authoritative. A tool response that says `ok` does not pass when the intended state is absent, the wrong entity changed, a prohibited intermediate mutation occurred, cleanup failed, or transport evidence is incomplete.

## Requirements and tested support

Node.js 22.13 or later is required. The package has no runtime dependencies.

The CI workflow tests the minimum supported Node 22.13 release on Ubuntu and the newer Node 24 LTS line on Ubuntu, macOS, and Windows. This is tested core CLI/package support, not a claim that the historical external Git MCP evidence was reproduced on every platform.

## Source-checkout setup

Use the lockfile for deterministic contributor setup:

```sh
npm ci
npm run build
npm run typecheck
npm test
node bin/oculory doctor
```

Use `node bin/oculory ...` as the cross-platform local launcher. On Unix-like systems, `./bin/oculory ...` remains available.

## Installed-package usage

The repository is not published to npm by this milestone. To test the package as a consumer, install a locally generated tarball into another project:

```sh
npm pack --json --pack-destination <temporary-directory>
npm install <temporary-directory>/oculory-0.1.0.tgz
npx --no-install oculory --version
npx --no-install oculory --help
npx --no-install oculory doctor --json
```

The public command remains `oculory`. It supports `--help`, `--version`, and `version`; the reported version comes from the installed package metadata.

## Offline validation

The normal public validation path is deterministic and does not contact a model provider:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run test:gate-f0
npm run validate:gate-f-authorization
npm run validate:phase6-evidence-index
npm run experiment
npm run experiment:filesystem
npm run experiment:issue-tracker
npm run verify:package
```

`npm run verify:package` creates a tarball only in a temporary directory, checks an explicit package allowlist/denylist, installs it into a clean temporary npm project, exercises it through `npx --no-install`, and removes the temporary directory. It does not publish anything.

GitHub Actions uses no model-provider credentials and performs no model-provider traffic. It does not run Gate F1/F2, the authoritative external Gate F0 runner, or external Git Gates B–E.

## Validation targets and evidence

Oculory includes three locally authored deterministic targets: a SQLite-backed task server, a sandboxed filesystem server, and an in-memory issue tracker. Their scripted experiments are reproducible local pipeline evidence.

Phase 6 adds scripted evidence against one independently maintained target, the pinned official-reference `mcp-server-git==2026.7.10` implementation over stdio. Gate A passed; formal Gate B passed on its repaired second attempt while the first attempt remains preserved as failed; Gates C and D passed; Gate E1 completed; and Gate E passed after exact human review, clean replay, and controlled mutation checks.

The strongest supported Phase 6 claim is:

> Oculory operated against one pinned external official-reference MCP implementation over stdio with deterministic disposable fixtures, independent per-step verification, a human-reviewed mined suite, clean eligible-holdout replay, and controlled layer-separated mutation evidence.

Gate F0 later passed only its offline deterministic-mock scope: six golden sessions, 57 registered offline faults, complete evidence/cleanup, zero real provider calls, zero provider-network calls, zero real credentials, and zero provider cost. The tracked Gate F1 authorization artifact remains a non-executable draft. Gate F1 and F2 remain unauthorized and unstarted.

The public repository deliberately begins with a fresh one-commit history on `main`. Older commit hashes, `master` branch references, tags, and PR chronology in historical evidence reports are legacy/private-history identifiers only; they are not reachable current public refs. Gate F0 is already present in the fresh public root and has no current PR awaiting review.

See:

- [current project status](docs/30_PROJECT_STATUS_AND_NEXT_STEPS.md)
- [Phase 6 evidence index](docs/evidence/phase6-external-git-evidence-index-v1.json)
- [Phase 6 final audit](docs/41_PHASE6_EXTERNAL_GIT_FINAL_AUDIT_AND_FREEZE.md)
- [Gate F0 offline record](docs/43_GATE_F0_OFFLINE_PREPARATION_AND_VALIDATION.md)
- [Phase 7 public engineering readiness](docs/44_PHASE7_PUBLIC_ENGINEERING_READINESS.md)
- [Phase 8 provider-free external-developer pilot](docs/45_PHASE8_OFFLINE_EXTERNAL_DEVELOPER_PILOT.md)

Raw external traces, transcripts, journals, and prior live evidence are intentionally gitignored under `.oculory/`; they are not stored in GitHub or the npm package. Contributors must not attach private evidence to issues or pull requests.

## Scope and non-claims

The evidence does not establish:

- production readiness or a release commitment;
- MCP conformance, security certification, or an upstream vulnerability;
- broad external-server, provider, model, or cross-platform target compatibility;
- real-model reliability for the external Git target;
- developer adoption, customer validation, market validation, or benchmark superiority.

The original Gate F proposal authorized no traffic. F0 implemented and validated only the offline mock substrate. Completing public engineering readiness does not authorize Gate F1 or F2.

For contribution and evidence-protection rules, see [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
