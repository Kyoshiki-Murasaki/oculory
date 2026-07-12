# 34 — Git MCP Gate A / Gate B direct spike

_Evidence record for the bounded external-target spike executed on 2026-07-10 and documented on 2026-07-11. This is not Gate C–E evidence, a scripted experiment, model evidence, security certification, broad external validation, or MCP conformance evidence._

## Executive decision

- **Gate A: passed.** The exact selected artifact, source/provenance chain, MIT licence, entry point, interpreter, and 33-distribution hash-bound runtime were verified. The target required no credential or remote service, and the installed package was not shadowed by the source tree or user site packages.
- **Bounded three-trial direct-harness feasibility spike: passed.** Thirty serial cold sessions—three for each of five successful direct paths and five rejection probes—used fresh processes and fixtures. All required semantic outcomes, independent state transitions, shutdowns, sentinel checks, and cleanup proofs for that bounded spike passed.
- **Formal Gate B: partially satisfied and pending.** The canonical criteria in `docs/32_EXTERNAL_MCP_INTEGRATION_AND_VALIDATION_PLAN.md` require 20 fresh materializations and at least ten fresh cold-start trials for each direct path; those thresholds were not run here.
- The result supports only this claim:

> The exact selected external Git MCP artifact could be pinned and repeatedly exercised through Oculory's stdio client against disposable deterministic fixtures with independently verified direct outcomes.

The higher future repetition thresholds in `docs/32_EXTERNAL_MCP_INTEGRATION_AND_VALIDATION_PLAN.md`—20 materializations and ten direct trials per included path—were not run. This bounded result therefore does not claim completion of the broader long-run plan or any later Phase 6 gate.

## Evidence labels and identity

- **V — verified:** observed directly from the artifact, installed environment, protocol transcript, native Git/filesystem oracle, tests, or process cleanup.
- **I — inference:** engineering conclusion supported by verified evidence but not directly proven.
- **U — unresolved:** limitation that remains outside this spike.

| Field | Recorded value |
|---|---|
| Execution date | 2026-07-10 |
| Documentation date | 2026-07-11 |
| Oculory branch | `master` |
| Oculory HEAD used by the run | `b2bef39ef2d2c55c4ca8fc939d6943000ee01139` |
| Working tree during the run | Dirty with the uncommitted Gate A/B implementation; the report records this explicitly |
| Temporary aggregate report | `/tmp/oculory-git-gate-ab-report.json`; not committed |
| Report file SHA-256 | `a0620f25ad9577287bb410b54616a929598905f51389f42467c0d4dbef7a8b64` |
| Report's pre-self-field digest | `b1fba93e299c7e2c0a1aaf02595e6f7b3960d90e1393db8a904ac0802ed4d1dd` |
| Report size | 9,080,085 bytes |

The report uses a temporary, spike-only structure and is not schema version 3. It is not persisted under `.oculory` and does not alter schema version 2.

## Gate A evidence

### Artifact, metadata, provenance, and licence

| Check | Verified evidence |
|---|---|
| Package identity | `mcp-server-git==2026.7.10`; PyPI metadata and installed distribution agree |
| Wheel | `mcp_server_git-2026.7.10-py3-none-any.whl`, 10,936 bytes |
| Expected wheel SHA-256 | `6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5` |
| Observed wheel SHA-256 | `6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5`; exact match |
| Source distribution | `mcp_server_git-2026.7.10.tar.gz`, 64,821 bytes |
| Expected sdist SHA-256 | `95107b8b2989814e8c230e8e489feef4bfa4d80ca4a7ac1612cea05283ff5ea5` |
| Observed sdist SHA-256 | `95107b8b2989814e8c230e8e489feef4bfa4d80ca4a7ac1612cea05283ff5ea5`; exact match |
| Package status | Non-yanked, Beta, Python `>=3.10` |
| Console entry point | Exactly `mcp-server-git = mcp_server_git:main`; `python -m mcp_server_git` reaches the same main function |
| Installed server source SHA-256 | `52325521ec8ec00297248fa03eaee6802b9cad3ec1e5bebee25971e1b897d56e`; matches wheel, sdist, tag, and installed file |
| Licence | MIT; tag, sdist, and wheel licence bytes have SHA-256 `8cc7c6e33b24ed4ee8fcccc33eccf102549d04fa4cb9737cecc9770dad1080ff` |
| Annotated tag object | `78193e98024b35dbc67deeddafe5dd31d23b382b` |
| Peeled release commit | `9a96ea6e5913736f92b88345bf51caeaaa8e719f` |
| PyPI-attested workflow source commit | `d31124c982401739917fd817c2a59db344529c16` |

**V:** The release workflow started from `d31124c...`, created child commit `9a96ea6...` by changing the Git package/lock version from `0.6.2` to `2026.7.10`, tagged that child, and built the artifacts from the tag. The sdist component files match the tagged source tree, except generated package metadata; wheel modules and licence match the sdist/tag bytes. The workflow-source commit must not be described as the artifact-source commit.

**V:** The Git tag and release commit are unsigned. PyPI's Sigstore trusted-publisher attestations bind the exact artifact names and digests to the upstream GitHub release workflow. This is provenance evidence, not a security guarantee.

**V:** The exact-version GitHub advisory query returned none affecting `2026.7.10`. Four reviewed package advisories were found, all fixed before the selected version: GHSA-5cgr-j3jf-jw3v, GHSA-9xwc-hfwc-8w59, GHSA-j22h-9j4x-23w5, and GHSA-vjqx-cfc4-9h6v.

### Exact environment and dependency lock

| Component | Recorded value |
|---|---|
| Host | macOS 26.4.1 (build 25E253), Darwin 25.4.0, arm64 |
| Node | `v26.4.0` |
| Python used | CPython `3.12.13` |
| Disposable Python entry | `/private/tmp/oculory-git-gate-ab-runtime/bin/python` |
| Underlying Python | Homebrew Python 3.12.13 |
| Target executable | `/private/tmp/oculory-git-gate-ab-runtime/bin/mcp-server-git` |
| Native Git | `/opt/homebrew/Cellar/git/2.55.0/bin/git`; `git version 2.55.0` |
| Resolver/installer | `uv 0.11.23` (`3cdf50e09`, arm64-apple-darwin) |
| Lock | `test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml` |
| Lock SHA-256 | `5f7f42f1f4b40051836ce7a308e8e4206a87032edf9bc4cc19e9e2ec75a02b63` |
| Installed distributions | 33; all versions matched the pylock |
| Key resolved versions | Click 8.4.2, GitPython 3.1.50, MCP SDK 1.28.1, Pydantic 2.13.4 |

**V:** The pylock was produced for CPython 3.12.13 on macOS arm64 with binary distributions only. It contains 33 exact package versions and selected wheel URLs, sizes, upload times, and SHA-256 hashes. Every package is version-pinned and every selected wheel is hash-bound. It contains no local `file:` URL, machine-local absolute path, credential, or secret. The target wheel entry uses the verified wheel digest above.

**V:** A fresh virtual environment was synchronized from that committed pylock with `--require-hashes --only-binary :all:`. `uv pip check` reported all 33 installed packages compatible. Runtime inspection through the venv Python verified the installed distribution name/version, source hash, console entry point, module location inside the disposable environment, and full distribution set. `PYTHONNOUSERSITE=1` and `PYTHONSAFEPATH=1` prevent a user-site/local shadow from satisfying the check.

**U:** uv 0.11.23 labels its pylock consumption support experimental. Reproduction is therefore scoped to the recorded uv version, CPython patch, OS, and architecture; the lock is not a cross-platform claim.

### Runtime isolation policy

The target child receives an environment built from scratch. No `process.env` spread is used. The passed names are:

`GIT_ASKPASS`, `GIT_AUTHOR_DATE`, `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_NAME`, `GIT_CEILING_DIRECTORIES`, `GIT_COMMITTER_DATE`, `GIT_COMMITTER_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, `GIT_OPTIONAL_LOCKS`, `GIT_TERMINAL_PROMPT`, `HOME`, `LANG`, `LC_ALL`, `PATH`, `PYTHONDONTWRITEBYTECODE`, `PYTHONHASHSEED`, `PYTHONNOUSERSITE`, `PYTHONSAFEPATH`, `TMPDIR`, `TZ`, `VIRTUAL_ENV`, `XDG_CACHE_HOME`, and `XDG_CONFIG_HOME`.

HOME, XDG directories, TMPDIR, the empty global Git config, and the noninteractive askpass executable are inside the trial root. `LC_ALL=C`, `LANG=C`, `TZ=UTC`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, and `GIT_OPTIONAL_LOCKS=0` are fixed. PATH is limited to the disposable environment, recorded native Git, `/usr/bin`, and `/bin`.

Explicit guards reject model/provider keys, GitHub tokens, SSH agent state, cloud credentials, proxies, credential-shaped variable names, signing variables, and Git SSH overrides. Package download used the network before runtime; the target runtime had no remote and required no network or credential.

### Gate A criteria

| Criterion | Result | Evidence |
|---|---|---|
| Exact package identity/version | Pass | Registry, artifacts, installed metadata, and runtime inspection agree |
| Artifact hash and provenance | Pass | Both artifact digests match; tag/release/attestation chain recorded |
| Permissive licence | Pass | Matching MIT licence bytes |
| Real stdio startup path | Pass | Exact console entry point launched the upstream Python SDK stdio server |
| No credential or remote service | Pass | Explicit child allowlist, no fixture remote, local-only covered tools |
| Safe disposable execution feasible | Pass | 30 fresh trial roots and one witness were created and removed successfully |
| Exact interpreter/dependency environment | Pass | CPython 3.12.13 plus 33-package hash-bound pylock and runtime reinspection |
| No user-data access | Pass within spike boundary | Target received only generated temporary repository paths; no user repository was passed |
| No weakened client semantics | Pass | No file under `src/mcp/client` changed; protocol faults remain fail-closed |

**Gate A decision: passed.**

## Fixture and independent oracle

### Deterministic fixture recipe

Every trial creates a new repository and sibling repository beneath a dedicated operating-system temporary directory. No clone or user repository is used.

- branch `main`;
- six LF-terminated mode-`100644` files: `README.md`, `src/app.txt`, `docs/guide.md`, `docs/rollback.md`, `notes/plan.txt`, and `docs/release.md`;
- two commits using fixed `Oculory Fixture <fixture@oculory.invalid>` author/committer identity, UTC dates, messages, parents, file bytes, SHA-1 object format, and no signing/hooks;
- `feature/seed` at the first commit;
- clean main worktree/index at the second commit;
- sibling Git repository containing a committed `sentinel.txt`;
- no remotes, tags, submodules, alternate object stores, extra worktrees, filters, active hooks, signing, or credential configuration.

Recorded deterministic identifiers:

| Item | Value |
|---|---|
| Fixture recipe digest | `a70438e717458e60bbc7e060934cbfbead480d3ab8f2ebac0c013f13fcab4c6c` |
| First commit / `feature/seed` | `cbcce409f62fbd07ca234f03f846f4b270f4aeb9` |
| Main HEAD | `781cf1e4988e89a7d3cf3c8eadf9d0ae2a34b698` |
| Sibling HEAD | `6baf77b27f8111754f15889c03e1a92d6e26c7a0` |
| Base semantic state hash | `20ed7a344289cb0bb10206858b4604c52f76a589b862d66d666bbb0f7305d498` |

Local config fixes `commit.gpgSign=false`, `tag.gpgSign=false`, `core.autocrlf=false`, `core.fsmonitor=false`, `core.fileMode=false`, `core.logAllRefUpdates=true`, `gc.auto=0`, and `maintenance.auto=false`. `core.fileMode=false` is the reviewed policy for this macOS-arm64 spike; direct filesystem modes remain captured by the oracle.

### Snapshot layers

The snapshot does not call MCP. It uses the exact native Git executable and direct filesystem reads:

1. recursive worktree entries excluding `.git`: path, type, mode, byte length, SHA-256, and symlink target;
2. NUL-framed porcelain-v2 status with branch headers and cleanliness;
3. `git ls-files --stage` entries plus independently read/hash-checked index blobs;
4. symbolic branch, HEAD commit, and sorted refs/targets;
5. reachable commit/tree semantics, identities, dates, messages, paths, modes, object IDs, and independent blob hashes;
6. parsed reflog transitions, retaining raw reflog digests while excluding only timestamp/timezone presentation from the semantic state hash;
7. sorted reachable and unreachable Git object inventory;
8. complete local config, remotes, hooks path/content, worktree list, submodules, and alternate-object-store state;
9. `.git` lockfiles;
10. sibling repository worktree, status, index, HEAD, refs, objects, plus sentinel content hash/mode/size and raw metadata digest.

Layer hashes and a canonical aggregate hash are both retained. Targeted checks—not the aggregate alone—determine success.

### Per-call journal

Each trial retains temporary snapshots at:

- fixture creation;
- before server startup;
- after server startup and initialize;
- after tool discovery;
- immediately before and after every `tools/call`;
- after the final response;
- after shutdown;
- before cleanup.

Each call record binds tool, exact tokenized arguments, request ID, input-schema digest, outcome class, raw response digest, raw request/response line digests, semantic outcome digest, snapshot indexes, and exact changed layers. Raw response/transcript evidence remains in the temporary report; registered fixture paths are tokenized only for semantic comparison.

### Cleanup proof

All 30 server sessions:

- observed graceful code-0 process exit;
- had no signal or shutdown escalation;
- settled every request;
- proved child and managed process group absent;
- required no emergency cleanup;
- preserved an empty remote list;
- preserved sibling sentinel bytes and metadata before and after primary repository removal;
- kept every configured HOME/XDG/TMP/Git path inside the trial root;
- removed the repository and trial root;
- proved the parent no longer contained the trial name.

A final read-only witness reproduced the registered base state hash and was then removed. The temporary trial parent was empty before its own removal.

## Real MCP stdio evidence

The recorded command boundary was the exact disposable executable with `--repository <FIXTURE_ROOT>`, working directory `<FIXTURE_ROOT>`, `shell: false`, separate stdout/stderr, and a managed POSIX process group.

| Protocol field | Observed in all 30 sessions |
|---|---|
| Requested protocol | `2025-11-25` |
| Negotiated protocol | `2025-11-25` |
| `serverInfo` | `{ "name": "mcp-git", "version": "1.28.1" }` |
| Capabilities | `{ "experimental": {}, "tools": { "listChanged": false } }` |
| Discovery pages | One |
| Raw discovery-frame digest | `30275c9e38df011399f17fce9b7e6f762e974b687d86a69020e217ad12330442` |
| Canonical discovery digest | `fdcbe98d820cf91b2815c2d232545dd463d3633abe3ba8aee46116b576afc62d` |

The server constructs `Server("mcp-git")` without a target version, so `serverInfo.version` is the resolved MCP SDK version, not package version `2026.7.10`. Artifact provenance therefore remains anchored to the package name/version/hash and installed source hash.

### Complete discovered inventory

| Order | Tool | Canonical raw discovery-object digest |
|---:|---|---|
| 1 | `git_status` | `7787e2a97eefcd2732e282e8dcc8cd9219788587d4933f34940ba33f3c5c5a2e` |
| 2 | `git_diff_unstaged` | `032b059faeb5b9810d9941eaf4c62b331685e49a0bc48fdaf0bb4c00bee3f677` |
| 3 | `git_diff_staged` | `48eb42b8f643b75aca966c127b458e4b0e23611bba8097dcc965d699188332d1` |
| 4 | `git_diff` | `637344c71d370a96cfe77ad81bbb7672637a649524f25d5445316db996e927b0` |
| 5 | `git_commit` | `75374f9754dc66a3496b158e7d20aa5dae700fa631e00673c7fba63c1ca5aed6` |
| 6 | `git_add` | `133fd218c7e83aa5dbdd56c75bead1a53d20c842c97f57dbac318b7bc7b49aa2` |
| 7 | `git_reset` | `86fba998411abf22305ade791102e0dfaa88ca1c20da2ee73a994eee358bd340` |
| 8 | `git_log` | `782b3a418610360414ad396aac5a0e31786f6fe14ee9755723880ce1f8c2c4fe` |
| 9 | `git_create_branch` | `bb46d952e3306ba9068f7bc9e7892d515eec1ece9005d23602d3bcb51070cf05` |
| 10 | `git_checkout` | `4ab7d39d3db4317b930371c39164a78b5686e7c4046505608a23185f05a67e5a` |
| 11 | `git_show` | `208ede6a3f3c38b1811aaa9577683e4ceb616c51a15d079aa3b0d67a858969a5` |
| 12 | `git_branch` | `9726dbd1d09733ca68ac5acab9ed23fd33de3adec4ebbd3b06628ebc91eca162` |

All 12 raw discovery objects, schemas, annotations, order, and page provenance were retained. `git_commit` and arbitrary-target `git_diff` were discovered but never invoked.

**V:** stdout contained only valid protocol frames; no malformed JSON, structurally invalid JSON-RPC, contamination, unmatched ID, or transcript-cap event occurred. Total stderr over all 30 sessions was zero bytes. Discovery raw and canonical digests were identical across all sessions.

## Gate B direct paths

| Path | Direct sequence | Trials | MCP outcomes | Independent state result | Stability / cleanup |
|---|---|---:|---|---|---|
| Read-only | `git_status` → `git_log` → `git_show` | 3 | 9/9 `tool_success` | No layer changed at any call; final state equals initial | Semantic and tokenized transcript stable; cleanup 3/3 |
| Stage | `git_diff_unstaged` → `git_add` → `git_diff_staged` | 3 | 9/9 `tool_success` | Only `README.md` index entry changed; `status`, `index`, and object inventory changed at add; worktree bytes/HEAD/refs unchanged | Stable; cleanup 3/3 |
| Reset | `git_diff_staged` → `git_reset` → `git_diff_unstaged` | 3 | 9/9 `tool_success` | Only `docs/rollback.md` index entry returned to HEAD; `status` and `index` changed; edited worktree bytes and object inventory remained | Stable; cleanup 3/3 |
| Branch create | `git_branch` → `git_create_branch` | 3 | 6/6 `tool_success` | Exactly `refs/heads/feature/parser` was added at main HEAD; symbolic HEAD remained `main`; worktree/index unchanged | Stable; cleanup 3/3 |
| Checkout | `git_branch` → `git_checkout` | 3 | 6/6 `tool_success` | Symbolic HEAD/HEAD changed to `feature/seed`; ref targets unchanged; worktree/index matched the feature tree; expected status/reflog/worktree-list layers changed; config/remotes/hooks/submodules/alternates unchanged | Stable; cleanup 3/3 |

These paths directly exercised all ten approved first-pilot tools. No unexpected semantic layer change was observed.

## Rejection probes

| Probe | Direct call | Trials | Observed result | Independent proof |
|---|---|---:|---|---|
| Nonexistent revision | `git_show` with `ghost-revision` | 3 | 3/3 MCP `tool_error` | Every primary/sibling layer unchanged; raw MCP result and wire digest retained |
| Malformed add shape | `git_add` with string `files` instead of array | 3 | 3/3 MCP `tool_error` | Every layer unchanged; schema-validation error evidence retained |
| Existing branch | `git_create_branch` for `feature/seed` | 3 | 3/3 MCP `tool_error` | Existing ref target, HEAD, objects, index, and worktree unchanged |
| Traversal file | `git_add` with `../sibling/sentinel.txt` | 3 | 3/3 MCP `tool_error` | Fixture, sibling repo, and sentinel unchanged; raw traversal argument retained |
| Non-fixture repository | `git_status` with the registered sibling repo path | 3 | 3/3 MCP `tool_error` | Configured target boundary rejected it; both repositories and sentinel unchanged |

The upstream SDK expresses these domain/input failures as MCP `isError: true` tool results with prose, not stable structured target codes. This spike retains the raw evidence and does not invent narrower error codes.

## Repetition and stability findings

- **V:** Every plan had three fresh processes, fixtures, HOME/XDG/TMP trees, and no in-place reset or process reuse.
- **V:** All ten plan groups had one semantic trial signature across their three repetitions.
- **V:** All ten plan groups had one tokenized transcript digest across repetitions.
- **V:** Raw transcript digests differed because every request intentionally retained its unique absolute fixture root. This difference is classified environment-derived; raw digests remain available.
- **V:** `git_show` rendered a GitPython timezone object with a per-process memory address. Only the address is replaced in the semantic comparison by `<GITPYTHON_TZOFFSET_OBJECT>`; exact raw lines and digests remain retained. Commit ID, author, timestamp, message, diff paths, and diff bytes were identical. This is classified presentation-only.
- **V:** No semantic, unexpected, or unexplained difference remained.

## Validation and artifact integrity

The external command was isolated from ordinary `npm test`:

```bash
npm run test:external-git-spike -- \
  --python /tmp/oculory-git-gate-ab-runtime/bin/python \
  --executable /tmp/oculory-git-gate-ab-runtime/bin/mcp-server-git \
  --git /opt/homebrew/bin/git \
  --lock "$PWD/test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml" \
  --output /tmp/oculory-git-gate-ab-report.json \
  --trials 3
```

| Validation | Result |
|---|---|
| External Git spike | Passed: 30 sessions, ten plans, three trials per plan |
| Focused offline Git-spike tests | Passed: 10/10 |
| Full `npm test` | Passed: 268 tests, 0 failed, 0 skipped, 0 cancelled, 0 todo |
| `npm run build` | Passed: TypeScript compilation completed cleanly |
| `./bin/oculory doctor` | Passed: all checks passed |
| `.oculory/runs-live` checksum comparison | Passed: original before manifest and final after manifest each contain 81 files, both manifest digests are `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e`, and `diff -u` was empty |

No ordinary test downloads or launches the external package. The external command requires the separately created disposable Python environment and committed platform-specific pylock.

## Formal Gate B status

The bounded direct-harness feasibility spike passed its recorded scope:

- all ten approved tools were directly exercised;
- all 12 tools were discovered losslessly;
- five successful paths and five rejection probes ran three cold trials each;
- required targeted transitions and unchanged-state rejections were independently proven;
- protocol/discovery/outcome/state behavior was semantically stable;
- stdout/stderr limits and separation held;
- every process and process group exited;
- every cleanup and sentinel proof passed;
- no target state escaped a trial root.

**Formal Gate B status: partially satisfied and pending.** The successful bounded spike is valid feasibility evidence, but it does not meet the canonical 20-materialization and ten-trials-per-direct-path thresholds.

## Limitations and non-claims

- This is one official-reference Git server artifact on one macOS-arm64 host, one exact Python dependency resolution, and native Git 2.55.0.
- The broader docs/32 repetition target of ten cold trials per path and 20 materializations per overlay was not run.
- No full transitive-dependency vulnerability audit, penetration test, runtime network syscall monitor, or OS-level filesystem sandbox was performed. Static source, empty remotes, explicit paths, and environment isolation are narrower evidence.
- The target's dependency ranges are broad; schema/protocol evidence applies only to the committed 33-package pylock. The upstream sdist's different `uv.lock` is informative but was not the executed dependency resolution.
- `serverInfo.version` identifies MCP SDK 1.28.1, not target package 2026.7.10.
- Raw result prose remains Git/GitPython-version-dependent. Only the observed memory-address presentation field was normalized semantically.
- Same-call transient filesystem mutations that leave no file, index, ref, reflog, lock, or object residue are not observable by this snapshot design.
- No external trace schema v3, persisted external session, final target adapter, verifier, scenario catalogue, mining, replay, mutation testing, Gate C–E experiment, or model traffic was implemented.
- The result does not establish production readiness, security, broad external MCP compatibility, complete MCP correctness, or MCP conformance.

## Single next action

Review and authorize a narrowly scoped Gate C transport-integrity milestone for this exact lock and harness; do not begin model traffic or Gates D–E as part of that action.

## Subsequent status

Gate C later passed in docs/35. Formal Gate B was then run at the canonical thresholds and is recorded as **failed** in `docs/36_GIT_MCP_FORMAL_GATE_B_DETERMINISM.md` because a canonical cleanup attempt timed out and did not finalize per-trial evidence. The bounded three-trial measurements above remain unchanged historical feasibility evidence.
