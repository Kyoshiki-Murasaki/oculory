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

[The second hosted cycle](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29232021394) passed both Ubuntu cells, macOS, deterministic experiments, and packed-consumer validation. Windows ran all 432 ordinary tests and passed 429. Its three remaining failures showed that Git can emit forward-slash paths while Node constructs backslash paths, leaving materialization-specific worktree paths in semantic hashes, and that Windows can prove a terminated child dead before Node delivers the optional exit-event record. The bounded repair normalized path evidence before fixture-root tokenization and kept forced-shutdown acceptance bound to escalation plus hard liveness proof when that exit-event record had not yet arrived.

[The third original hosted cycle](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29232244921) passed the other five required jobs and 431 of 432 Windows ordinary tests. Its sole remaining failure was `Git spike fixture: two materializations have identical semantic state and commit IDs`, with state hashes `d2741b051816328cbee749e5f65531290755d294dec8de24f31d7ce4d19b5937` and `1b7503347d18d89b8981b1c37890b71ace5b191f22b110b3d97822dfd33637de`. This blocker was not made optional or retried until green.

Local validation on macOS 26.4.1 arm64 with Node 26.4.0 is complete.

## Windows semantic-determinism follow-up

The remaining Windows job was inspected on Windows Server 2025 (`10.0.26100`, Datacenter), runner image `windows-2025-vs2026` version `20260628.158.1`, Node `v24.18.0`, npm `11.16.0`, and Git `2.54.0.windows.1`. It tested the pull-request merge checkout and ran the same build plus Node test command as the other core cells. No preceding warning or stderr explained the mismatch.

The one authorized unchanged-commit rerun is retained as [attempt 2 of run 29232244921](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29232244921/attempts/2). It failed the same assertion again, but with location-dependent state hashes `7c4075c33e7cea5ab4c889852494d8fc2945f83b0593a3a57b138fd6f4d723b5` and `0bcc6d9b77fd14eaf2ea1d4251691907ca9a7fda4651c47919df126703a958ad`. That established a stable defect rather than a lucky-pass flake.

The retained diagnostic implementation exposes the fixture recipe, each semantic layer in stable order, and a bounded public-safe comparator. A mismatch reports every differing layer and layer hash, at most a configured number of canonical JSON pointers, the value types and SHA-256 digests on each side, and narrowly classified indicators for fixture paths, timestamps, timezones, modes, ordering, line endings, Git metadata, or other presentation. It tokenizes known roots, never prints raw values or environment variables, defaults to 12 differences, and caps requests at 50. The normal ordinary-test assertion now compares commit IDs, recipe, every layer, and final state with this actionable explanation.

A dedicated Windows CI command materializes 10 sequential independent pairs using 20 unique trial IDs. For every pair it separately compares the feature-seed, main, and sibling commit IDs; `fixtureRecipeDigest`; all 10 individual layer hashes; and final `stateHash`. Cleanup is complete and fail-closed. The same diagnostic is locally runnable and does not create protected evidence or authoritative run IDs.

[The first pushed follow-up cycle](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29234354673) retained that diagnostic and passed the other five required jobs. Windows stopped in the new stress step with all three commit IDs equal (`cbcce409f62fbd07ca234f03f846f4b270f4aeb9`, `781cf1e4988e89a7d3cf3c8eadf9d0ae2a34b698`, and `6baf77b27f8111754f15889c03e1a92d6e26c7a0`) and equal recipe digest `a70438e717458e60bbc7e060934cbfbead480d3ab8f2ebac0c013f13fcab4c6c`. The final state hashes differed: `deb7fc0e48156bdf8fb819b3b1d31b4215abe1a8bd87d51ce99a39d667e599aa` versus `1fc89a02cf17dd96ab55e533f546046696734f2835c6c4cfdcf2d8c5c93d4035`.

Exactly one semantic layer differed: `isolation`, with layer hashes `b6a53ddfe2dd74a98389a79766743d870e523d533da57f1b1799ba700d168e9a` and `4347168173dfff5bb35ef4ffc23e943ee834f7514c32942aadcadac23682d540`. Exactly one bounded pointer differed, `/isolation/worktrees/0`; both values were strings with digests `7f9ebe42addad16fd4c702aeb5c2715987e3c007b48353f7619941318fbd1930` and `4f10f57dcc4092038f58b8a415634a34bff0be40f80614820736ec0bd7a52602`. The comparator classified the field as a fixture-specific path and Git-generated metadata, with timestamp, timezone, mode, ordering, and line-ending indicators all false. Every other semantic layer was identical.

The root cause was the absolute primary-worktree path emitted by `git worktree list --porcelain`. Windows path spelling and the independently chosen materialization root leaked through a semantic layer even though repository behavior, commit identity, recipe, and every other layer were equal. This is presentation-only: the complete raw worktree output remains independently retained by `rawEvidence.worktreesSha256`, while semantic topology uses a known-root token. The repair resolves and tokenizes only registered primary, sibling, and trial physical roots, recognizes slash and Windows case/drive spelling plus explicitly registered short/long aliases, applies the longest path first with path boundaries, and leaves unknown or meaningful relative paths untouched.

Focused regressions prove independent roots and trial IDs do not affect commit IDs, recipe, any individual layer, or final state; Windows slash/case/drive and registered short-path aliases normalize narrowly; a repository copy remains `<TRIAL_ROOT>/repository-copy`; and meaningful relative paths, content, supported modes, index, refs, reflog actions, configuration, sibling state, and sentinel state remain detectable. Diagnostic output is deterministic, bounded, and contains no unredacted fixture root.

[The second pushed follow-up cycle](https://github.com/Kyoshiki-Murasaki/oculory/actions/runs/29234850222) proved the Git repair: the 10-pair Windows stress step passed, as did the other five required jobs. The later Windows ordinary suite passed 434 of 435 tests and exposed one independent observation race in the original MCP timeout test. Teardown had already settled every request and proved the child and managed group dead, but Windows delivered Node's optional asynchronous child-exit event after the immutable close record was returned. The test now retains all liveness and settlement assertions, waits at most the existing bounded transcript-event deadline, and requires the eventual process-exit event and exit code `0`. Fifty focused local repetitions pass.

The third pushed follow-up revision combines that bounded test correction with this final record because the newly exposed result did not exist when the Git repair commit was made and a separate documentation push would exceed the three-cycle authorization. [The final PR checks](https://github.com/Kyoshiki-Murasaki/oculory/pull/1/checks) are authoritative for the same final revision: both Ubuntu cells, macOS, Windows, deterministic offline experiments, and packed-consumer install pass; Windows executes the 10-pair stress command, all 435 ordinary tests, all 18 Gate F0 tests, both validators, and the portable launcher checks. GitHub assigns the exact Actions run URL only after this revision is pushed, so that immutable run URL is retained in the draft PR body and the final Phase 7 report.

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
| ordinary tests | 435 passed, 0 failed |
| Gate F0 focused tests | 18 passed, 0 failed |
| Gate F authorization validator | `draft`; executable `false` |
| Phase 6 evidence-index validator | passed |
| launcher `--help`, `--version`, `version`, doctor | passed; version `0.1.0` |
| `npm pack --json` content policy | passed; 143 deliberate files |
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

The Windows follow-up repeated this protection with a fresh, sorted JSONL inventory format before any tracked change and after the final validation. The format includes relative path, exact byte count, and per-file SHA-256 for every file; its baseline and final summaries are:

| Root | Files | Exact bytes | Follow-up manifest SHA-256 | Added / removed / changed |
|---|---:|---:|---|---:|
| `.oculory/runs-live` | 81 | 3,420,840 | `877790b8eed10eba9823ae8def5b849fb29fcff9b61c28952011ff76c413b3c3` | 0 / 0 / 0 |
| `.oculory/runs-external` | 1,300 | 42,498,076 | `e953747914bd1ad169cef9721582a90e53e7b03a7cbef7597bcf18a754e03c76` | 0 / 0 / 0 |
| `.oculory/runs-model` | 288 | 2,238,787 | `675085be9abeb00ef699dc72e3532d9877864a148493c95ccfb2eba4b2fcc3d3` | 0 / 0 / 0 |

## Known limitations and exact non-claims

Local implementation validation used one macOS-arm64 host. The cross-platform core claim is limited to required GitHub-hosted CI cells; it does not broaden the historical external-target platform evidence. Windows cannot provide the POSIX parent-directory `fsync` durability step, so its atomic evidence write guarantee is limited to flushed file contents followed by atomic rename. Windows may also prove child-process death before Node dispatches the optional `exit` callback; acceptance therefore requires hard liveness proof immediately and the bounded eventual exit event where that event is semantically required.

Phase 7 does not establish production readiness, security certification, MCP conformance, broad MCP compatibility, real-model or provider reliability, live API compatibility, paid-run reproducibility, adoption, customer value, market validation, benchmark superiority, npm publication readiness, or a release commitment.

The CI/package workflow has zero runtime provider traffic and does not access credentials. Gate F1 and F2 remain unauthorized and unstarted.

## Exact next decision boundary

Completion of Phase 7 does not authorize Gate F1. The next decision is one of:

1. Separately design and authorize a minimal Gate F1 live-model smoke with exact provider, exact model snapshot, current pricing, privacy terms, region, execution window, scenario list, caps, endpoint allowlist, retry policy, unknown threshold, and hard dollar cap; or
2. Begin a small external-developer usability pilot using only the reproducible offline workflow.

Do not choose or execute Gate F1 automatically.
