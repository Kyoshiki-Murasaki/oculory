# 17 — Open-source readiness and packaging

Goal: another developer can install, understand, run, test, and inspect — nothing about promotion.

- **Package**: single npm package `oculory` v0.1.0, `bin.oculory`, zero runtime deps, devDeps typescript + @types/node. Publishing later under a scope (`@oculory/cli`) is a rename, not a restructure; the docs/03 module map is the future package split.
- **Licence**: MIT (LICENSE present) — maximally adoptable for a dev tool seeking inspection and contribution; no copyleft surprises for commercial MCP teams.
- **Versioning**: semver; schemas carry independent `schema_version` (docs/04). CHANGELOG.md follows Keep-a-Changelog.
- **Install / run**: `npm install && npm run build && npm test && ./bin/oculory experiment` (4 commands, Q-09).
- **Example project**: `examples/quickstart.sh` runs the full record→compare loop against the bundled demo server with commentary; sample redacted traces are regenerable (`oculory record --smoke`) rather than committed, keeping the repo free of stale artifacts.
- **Repository hygiene**: README (top-level orientation + honest status), SECURITY.md (report privately; no bounty), CONTRIBUTING.md (build, test, boundaries to respect), issue template (bug report with `oculory doctor` output). CI workflow builds, tests, and runs the unmutated suite.
- **Reproducibility package**: `oculory experiment` regenerates every number in docs/05 from a clean store; two-run identity is itself a test.
- **Release artifacts**: git tag `v0.1.0` + `npm pack` tarball; release checklist is docs/18.
