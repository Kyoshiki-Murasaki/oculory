# 44 — Phase 7 public engineering readiness

_Implementation record for `phase7-public-engineering-readiness`, 2026-07-13. This is a bounded public engineering-readiness milestone, not a production-readiness declaration and not authorization for model-provider traffic._

## Scope

Phase 7 adds a reproducible public engineering surface without rerunning provider-backed or authoritative external evidence:

- least-privilege GitHub Actions CI for the core offline workflow;
- a portable packaged CLI launcher for Linux, macOS, and Windows;
- `--help`, `--version`, and `version`, with the version read from package metadata;
- explicit npm package-content policy and clean installed-consumer smoke;
- contributor setup and evidence-protection guidance;
- reconciliation of the fresh one-root public Git history with legacy/private evidence chronology.

It does not run or authorize Gate F1/F2, the authoritative Gate F0 external runner, external Git Gates B–E, npm publication, a GitHub release, or a version tag.

## Canonical baseline

Preflight verified the canonical working tree through the repository identity rather than recording a private local path: `Kyoshiki-Murasaki/oculory`, public branch `main`, clean root commit `616ca96548e763ab3bb401f4626dcac2857a647b`, matching `origin/main`, and Git identity `Kyoshiki-Murasaki <286077043+Kyoshiki-Murasaki@users.noreply.github.com>`. `git fsck --full` passed and no merge, rebase, cherry-pick, or revert was in progress.

The public repository deliberately has a one-root fresh history. All older hashes, `master`, milestone tags, and pull-request chronology in historical reports are legacy/private evidence identifiers only. No old history was imported, grafted, merged, copied, or rewritten. Gate F0 is already in the fresh public tree and has no current PR awaiting review.

The untouched offline baseline passed:

| Validation | Baseline result |
|---|---|
| `npm ci` | passed; 3 development packages installed, 0 audit findings |
| build / typecheck | passed / passed |
| ordinary tests | 422 passed, 0 failed |
| Gate F0 focused tests | 18 passed, 0 failed |
| Gate F authorization validator | `draft`; executable `false` |
| Phase 6 evidence-index validator | passed |
| doctor | all checks passed |
| task / filesystem / issue experiments | each `meaningful_technical_success` |

No real provider call, credential access, or provider-network traffic occurred.

## Implementation

`bin/oculory` is now a Node launcher rather than a POSIX shell script. It resolves the compiled CLI relative to its own module URL, launches it with the required `--experimental-sqlite` and `--no-warnings` flags, inherits standard input/output/error, forwards every argument without shell interpolation, propagates the child exit status or signal, and reports spawn errors. This preserves the public `oculory` command and handles install paths and arguments containing spaces.

The CLI reads version `0.1.0` from the canonical installed `package.json`; it does not duplicate the version in source. POSIX-only `NODE_OPTIONS=...` assignments and the Bash-only npm experiment entry were replaced with cross-platform Node/npm commands. Focused tests cover argument and exit propagation, paths with spaces, help, both version spellings, package/lock consistency, package policy, and the draft authorization boundary.

Package metadata now accurately identifies the repository, homepage, issue tracker, and package-manager version. The package version remains `0.1.0`; nothing is published.

## CI workflow and matrix

`.github/workflows/ci.yml` runs on pushes to `main`, pull requests targeting `main`, and manual dispatch. Permissions are limited to `contents: read`; concurrency cancels superseded runs. Checkout does not persist Git credentials. No provider secrets are declared or consumed.

Only official GitHub actions are used, pinned to immutable full commit SHAs verified from their official releases:

- `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` (`v7.0.0`);
- `actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` (`v6.4.0`).

The required core matrix is:

| Runner | Node | Coverage |
|---|---:|---|
| Ubuntu latest | 22.13.0 | minimum supported runtime |
| Ubuntu latest | 24 | newer LTS runtime |
| macOS latest | 24 | primary LTS macOS |
| Windows latest | 24 | primary LTS Windows |

Every core cell runs clean install, build, typecheck, ordinary tests, Gate F0 focused tests, both validators, and launcher help/version/doctor. A dedicated Ubuntu Node 24 job runs all three deterministic experiments. A separate Ubuntu Node 24 consumer job runs the complete package verifier and installed-tarball smoke. No job uses `continue-on-error`.

The first hosted cycle is preserved at [GitHub Actions run 29231491544](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29231491544). Ubuntu Node 22.13.0, Ubuntu Node 24, macOS Node 24, deterministic experiments, and packed-consumer validation passed. Windows Node 24 failed its ordinary-test step: checkout CRLF changed byte-canonical fixtures; quoted npm globs omitted the two source `.mjs` tests; Windows rejected POSIX directory-handle `fsync`; and several test fixtures assumed POSIX executable, symlink-target, EOF, or signal behavior. The required Windows job was not made optional.

The first bounded repair enforces LF checkout, names the source `.mjs` tests explicitly, resolves executable suffixes through `PATHEXT`, uses real temporary symlink targets, and makes timeout/EOF/forced-shutdown fixtures platform-aware. Evidence files still receive a file `fsync` followed by atomic rename on every platform; the parent-directory entry is additionally flushed on POSIX, while Windows explicitly skips its unsupported directory-handle operation. A regression test binds that distinction.

[The second hosted cycle](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29232021394) passed both Ubuntu cells, macOS, deterministic experiments, and packed-consumer validation. Windows ran all 432 ordinary tests and passed 429. Its three remaining failures showed that Git can emit forward-slash paths while Node constructs backslash paths, leaving materialization-specific worktree paths in semantic hashes, and that Windows can prove a terminated child dead before Node delivers the optional exit-event record. The final bounded repair normalizes path evidence before fixture-root tokenization and keeps forced-shutdown acceptance bound to escalation plus hard liveness proof when that exit-event record has not yet arrived. The third and final pull-request run is authoritative for the repaired cross-platform result and is preserved in the PR checks and Phase 7 final report.

Local validation on macOS 26.4.1 arm64 with Node 26.4.0 is complete.

## Package contents and consumer smoke

`scripts/package-policy.mjs` requires package metadata, README, license, contributing guide, the launcher, compiled CLI/server/store runtime, and the seed fixture. It allows only deliberate public top-level documentation and the `bin`, `dist`, `docs`, and `fixtures` trees.

It rejects Git/GitHub metadata, dependencies, compiled tests, test-only support code, `.oculory` and all protected run roots, environment/credential material, archives, Git bundles, coverage, temporary output, private handoffs, raw transcripts/evidence sidecars, user-home absolute paths, and credential-like content. Public historical documentation is allowed when it contains evidence identifiers but no private material.

`npm run verify:package` uses `npm pack --json` in a temporary directory outside the repository, validates the returned content manifest and text inputs, computes SHA-256, initializes an empty npm project in a path containing spaces, installs the tarball offline with install scripts disabled, and runs:

```text
npx --no-install oculory --version
npx --no-install oculory --help
npx --no-install oculory doctor --json
npx --no-install oculory inspect --json
```

The smoke requires exact version output, usable help, functional `node:sqlite`, the packaged fixture, and non-empty deterministic tool definitions. It strips provider-key variables, records zero provider calls, and removes the temporary directory. Generated `.tgz` files never remain in the repository.

## Final local validation result

| Validation | Result |
|---|---|
| clean install / build / typecheck | passed / passed / passed |
| ordinary tests | 432 passed, 0 failed (422 baseline + 9 initial Phase 7 tests + 1 durability regression) |
| Gate F0 focused tests | 18 passed, 0 failed |
| Gate F authorization validator | `draft`; executable `false` |
| Phase 6 evidence-index validator | passed |
| launcher `--help`, `--version`, `version`, doctor | passed; version `0.1.0` |
| `npm pack --json` content policy | passed; 142 deliberate files |
| installed consumer smoke | passed; temporary directory removed |
| task / filesystem / issue experiments | each `meaningful_technical_success` |
| provider calls / credentials accessed | 0 / 0 |

## Protected evidence

The protected roots were inventoried before implementation with sorted relative paths, every file's byte count and SHA-256, and a SHA-256 of each complete sorted manifest:

| Root | Files | Exact bytes | Manifest SHA-256 |
|---|---:|---:|---|
| `.oculory/runs-live` | 81 | 3,420,840 | `c1fd904b772e813eba3e032f0843eeac7f2b9906dc49597e8b5e152b3a799c13` |
| `.oculory/runs-external` | 1,300 | 42,498,076 | `6f5783ae0d20966b06d3472fdfc1b657669dd7cfffc0744010a0535314b94c48` |
| `.oculory/runs-model` | 288 | 2,238,787 | `f277e0f5243cc1ba1e575c83751b6cf15acfd543cd4c9455e00740e8c77f5600` |

The final comparison passed with zero added, removed, or changed files and zero manifest-digest changes for every protected root. No authoritative run command is part of Phase 7.

## Known limitations and exact non-claims

Local implementation validation used one macOS-arm64 host. The cross-platform core claim is limited to required GitHub-hosted CI cells; it does not broaden the historical external-target platform evidence. Windows cannot provide the POSIX parent-directory `fsync` durability step, so its atomic evidence write guarantee is limited to flushed file contents followed by atomic rename.

Phase 7 does not establish production readiness, security certification, MCP conformance, broad MCP compatibility, real-model or provider reliability, live API compatibility, paid-run reproducibility, adoption, customer value, market validation, benchmark superiority, npm publication readiness, or a release commitment.

The CI/package workflow has zero runtime provider traffic and does not access credentials. Gate F1 and F2 remain unauthorized and unstarted.

## Exact next decision boundary

Completion of Phase 7 does not authorize Gate F1. The next decision is one of:

1. Separately design and authorize a minimal Gate F1 live-model smoke with exact provider, exact model snapshot, current pricing, privacy terms, region, execution window, scenario list, caps, endpoint allowlist, retry policy, unknown threshold, and hard dollar cap; or
2. Begin a small external-developer usability pilot using only the reproducible offline workflow.

Do not choose or execute Gate F1 automatically.
