# 35 — Git MCP Gate C transport integrity

_Evidence record for the 2026-07-11 Gate C run. It covers one exact pinned Git MCP artifact over stdio and the deterministic test-only protocol fixture. It is not formal Gate B completion, Gate D/E evidence, MCP conformance, production readiness, security certification, broad compatibility, or model evidence._

## Decision and status

- **Gate A: passed.** The artifact and locked runtime evidence from docs/34 remains unchanged.
- **Bounded three-trial direct-harness feasibility spike: passed.** The 30-session direct-path and rejection evidence remains valid.
- **Formal Gate B: partially satisfied and pending.** Its canonical 20-materialization and ten-cold-trials-per-direct-path thresholds have not been run.
- **Gate C: passed.** Twenty consecutive clean real-target sessions completed, and all required deterministic protocol-fault tests passed.
- **Gate D–E: not attempted.**

The eligible Gate C claim is only:

> Oculory's client completed 20 consecutive clean transport sessions against the exact pinned Git MCP target and correctly detected and classified the required deterministic transport faults.

## Execution identity and provenance

| Field | Recorded value |
|---|---|
| Execution date | 2026-07-11 |
| Oculory branch | `master` |
| Oculory HEAD used | `7055479b29b6e40f2a4ab99380bf473d7d3d157a` |
| Working tree during run | Dirty with the uncommitted Gate C runner and package-script addition; recorded explicitly |
| Source-tree digest | `15d832abea450e92833ce8e387101bbde3f95b1e4f2a5c969918536cdfde1ef5` |
| Temporary report schema | `oculory-git-gate-c-temporary-v1` |
| Temporary report | `/tmp/oculory-git-gate-c-report.json`; not committed |
| Report file SHA-256 | `aafb199b0d060354f480250cbcaa15e254de8d59ced197f2d7d17c25dbe32916` |
| Report pre-self-field digest | `dedee3b657157f440f2f2c2364b002327731dfdfbf78d01e3a7dfa259120bbf3` |
| Report size | 6,236,587 bytes |

The temporary report retains every session's initialization, discovery objects, call evidence, journal snapshots/diffs, tokenized ordered transcript, shutdown record, and cleanup proof. It is not an external trace schema and was not written under `.oculory`.

## Exact target and environment

| Component | Verified value |
|---|---|
| Target | `mcp-server-git==2026.7.10` |
| Wheel | `mcp_server_git-2026.7.10-py3-none-any.whl` |
| Wheel SHA-256 | `6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5`; matches docs/31–34 |
| Source distribution SHA-256 | `95107b8b2989814e8c230e8e489feef4bfa4d80ca4a7ac1612cea05283ff5ea5` |
| Installed server source SHA-256 | `52325521ec8ec00297248fa03eaee6802b9cad3ec1e5bebee25971e1b897d56e` |
| Console executable | `/private/tmp/oculory-git-gate-ab-runtime/bin/mcp-server-git` |
| Console executable SHA-256 | `a0160dc245aad4c31850be92af9b37b32f00675ef2ab4644ab108ca9eed26bdc` |
| Python | CPython `3.12.13` |
| uv | `0.11.23` (`3cdf50e09`, arm64-apple-darwin) |
| Git | `2.55.0` |
| Node | `v26.4.0` |
| Host | macOS 26.4.1 / Darwin 25.4.0, arm64 |
| Dependency lock | `test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml` |
| Lock SHA-256 | `5f7f42f1f4b40051836ce7a308e8e4206a87032edf9bc4cc19e9e2ec75a02b63` |
| Installed distributions | 33 exact versions; every selected wheel hash-bound |

Runtime inspection rechecked the exact package name/version, Python version, installed source digest, console entry point, complete distribution set, executable containment, lock digest, and native Git version. The child environment was reconstructed from the existing explicit allowlist; no credential or user configuration was inherited. The lock was not changed.

## Exact command

```bash
npm run test:external-git-gate-c -- \
  --python /tmp/oculory-git-gate-ab-runtime/bin/python \
  --executable /tmp/oculory-git-gate-ab-runtime/bin/mcp-server-git \
  --git /opt/homebrew/bin/git \
  --lock "$PWD/test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml" \
  --output /tmp/oculory-git-gate-c-report.json \
  --sessions 20
```

The package script builds Oculory, runs the deterministic stdio-client test file in an explicitly constructed local environment, and then runs exactly 20 serial real-target sessions. It rejects any `--sessions` value other than 20.

## Real-session design

Each session used a fresh process, trial root, deterministic primary repository, sibling sentinel repository, HOME/XDG/TMP configuration, and empty global Git configuration. No process or fixture was reused. The sequence was:

1. materialize and snapshot the fixture;
2. spawn the exact executable without a shell;
3. initialize with protocol `2025-11-25` and send `notifications/initialized`;
4. complete `tools/list` and require the exact 12-tool inventory;
5. call `git_status` and independently prove unchanged repository state;
6. call `git_show` with `oculory-gate-c-nonexistent-revision` and retain the MCP `isError: true` result;
7. independently prove unchanged state after the expected error;
8. finalize the ordered transcript, close stdin, and observe bounded shutdown;
9. prove child/process-group absence, sentinel preservation, and fixture removal.

The fixture recipe digest was `a70438e717458e60bbc7e060934cbfbead480d3ab8f2ebac0c013f13fcab4c6c`. All 20 initial semantic state digests were `20ed7a344289cb0bb10206858b4604c52f76a589b862d66d666bbb0f7305d498`.

## Protocol negotiation and discovery

All 20 sessions observed:

| Field | Value |
|---|---|
| Requested protocol | `2025-11-25` |
| Negotiated protocol | `2025-11-25` |
| `serverInfo` | `{ "name": "mcp-git", "version": "1.28.1" }` |
| Capabilities | `{ "experimental": {}, "tools": { "listChanged": false } }` |
| Discovery pages | One |
| Raw discovery digest | `30275c9e38df011399f17fce9b7e6f762e974b687d86a69020e217ad12330442` |
| Canonical discovery digest | `fdcbe98d820cf91b2815c2d232545dd463d3633abe3ba8aee46116b576afc62d` |

Complete ordered inventory and canonical raw discovery-object digests:

| Order | Tool | Digest |
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

Discovery order, schemas, annotations, raw objects, and digests were identical in all sessions. `serverInfo.version` remains the resolved MCP SDK version, not the target package version; artifact identity is anchored independently.

## Calls and independent state evidence

| Check | Result |
|---|---|
| `git_status` | 20/20 `tool_success`, `isError: false`, request ID 3 |
| Successful-call semantic digest | `6bd50ba6f44951ce5ac08e4a06247b740d430539aea30bb31c5c57679dae4edd` in all sessions |
| State after `git_status` | 20/20 unchanged; no changed layer; before/after state digest equals the registered base digest |
| Missing-revision `git_show` | 20/20 `tool_error`, `isError: true`, request ID 4 |
| Expected-error semantic digest | `98a2eab836b1d42b2c0f6efb6cf087c30d4f0969032c269c3127bbb8eb985e46` in all sessions |
| State after expected error | 20/20 unchanged; no changed layer; before/after state digest equals the registered base digest |

The valid MCP arrival of the `git_show` response was not treated as semantic success. Its `isError: true` outcome remained a distinct `tool_error`, with raw response and transcript-line digests retained.

## Stability, transcript, stdout, and stderr

- 20/20 session assessments passed.
- One semantic session signature was observed: `2fd9ec168fce6173257d0ce3eb08c3e27e5283b94313567ad0dc64894072f42e`.
- Tokenized semantic transcript digest was identical across all sessions.
- Raw transcript digests differed in all 20 sessions because fresh absolute fixture paths are retained in raw evidence; this is environment-derived.
- Elapsed times ranged from 3,952.988 ms to 5,274.386 ms; timing is diagnostic and classified environment-derived.
- No presentation-only difference occurred in this Gate C path. The GitPython timezone-object normalization documented in docs/34 was not exercised because the only `git_show` call was an expected missing-revision error.
- No semantic or unexplained difference occurred. No unexplained value was normalized away.
- Unmatched response IDs: 0.
- Duplicate response IDs: 0.
- Invalid protocol lines: 0.
- Unexpected/non-protocol stdout events: 0.
- Transcript cap/truncation events: 0.
- Client-failure transcript events: 0.
- Total stderr: 0 bytes; no stderr entered the protocol parser.
- Every transcript retained spawn, request/response, initialized notification, stdin close, stdout/stderr EOF, and process-exit evidence in order.

## Shutdown and cleanup

All 20 sessions recorded:

- graceful stdin-close shutdown;
- escalation mode `none`;
- exit code 0 and no signal;
- all requests settled;
- child absent and managed process group absent;
- no emergency cleanup;
- no remotes before cleanup;
- runtime paths contained inside the trial root;
- sibling sentinel unchanged before and after primary repository removal;
- repository, fixture path, and trial root absent after cleanup;
- no trial name remaining in the temporary parent.

The aggregate parent directory was empty and removed. Post-run process and temporary-directory checks found no Gate C server, runner, or fixture residue.

## Deterministic fault criterion map

The Gate C runner separately executed `dist/test/mcp-stdio-client.test.js`: 38 tests passed, 0 failed, 0 skipped. The test process exited 0 with no signal and empty stderr. Existing deterministic tests were reused rather than duplicated.

| Criterion | Exact test evidence |
|---|---|
| Notification interleaving | `stdio client: notification interleaving is retained before the matching response` — `test/mcp-stdio-client.test.ts:497` |
| Server-to-client request | `stdio client: unsupported server request receives an error and cannot deadlock the client` — line 515 |
| Timeout and cancellation notification | `stdio client: request timeout is explicit, sends cancellation, and settles the promise` — line 534 |
| Explicit cancellation | `stdio client: explicit cancellation is classified and recorded` — line 557 |
| Late response | `stdio client: deterministic late response after cancellation remains visible evidence` — line 576 |
| Process crash | `stdio client: nonzero process exit is classified distinctly as process_crash` — line 609 |
| EOF | `stdio client: EOF with an outstanding request is a transport_eof, not success or rejection` — line 599 |
| Malformed framing | `stdio client: malformed JSON is retained and classified` — line 408 |
| Invalid JSON-RPC | `stdio client: structurally invalid JSON-RPC is retained and classified` — line 419 |
| Mismatched ID | `stdio client: mismatched response ID fails the outstanding request` — line 479 |
| Duplicate ID | `stdio client: duplicate response ID is detected before a coalesced duplicate can be accepted` — line 488 |
| Stdout contamination | `stdio client: stdout contamination is never interpreted as stderr or a tool result` — line 453 |
| Stderr separation | `stdio client: bounded stderr stays separate from protocol parsing` — line 464 |
| Stderr cap | `stdio client: stderr cap fails closed without feeding stderr to the JSON parser` — line 662 |
| Transcript cap | `stdio client: transcript cap fails closed and retains a terminal limit event` — line 682 |
| Split frames | `stdio client: partial stdout chunks are reassembled without evidence loss` — line 721 |
| Coalesced frames | `stdio client: multiple protocol lines in one stdout chunk remain ordered` — line 738 |

The tests assert classified outcomes and bounded teardown; swallowed faults, deadlocks, ambiguous process failures, and orphaned children would fail the suite.

## Validation and historical integrity

| Validation | Result |
|---|---|
| Baseline `npm test` | 268 passed, 0 failed, 0 skipped |
| Gate C deterministic fault subset | 38 passed, 0 failed, 0 skipped |
| External Gate C command | Passed: 20/20 sessions and fault suite passed |
| `npm run build` | Passed before execution and in final validation |
| `./bin/oculory doctor` | Passed before execution and in final validation; all checks passed |
| Historical live-artifact before manifest | 81 files; SHA-256 `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e` |
| Historical after comparison | 81 files; manifest SHA-256 `be18990c7156a97b03a0037074cdb4f004763c96da05776814b82777d16f1c7e`; `diff -u` was empty |

## Gate C decision

**Gate C: passed.** Every formal criterion completed: 20 consecutive real-target sessions, the required success and expected-error calls, independent unchanged-state evidence, stable negotiation/discovery/call semantics, zero prohibited protocol findings, unambiguous shutdown and cleanup, and deterministic classification of every required fault family.

## Limitations and non-claims

- Evidence covers one exact official-reference artifact, macOS arm64, CPython 3.12.13, one 33-distribution lock, Node 26.4.0, and Git 2.55.0.
- Formal Gate B remains pending; Gate C does not waive its larger direct-path thresholds.
- No OS-level network syscall monitor or filesystem sandbox was used. Runtime had no remote, credential, proxy, or network-dependent operation, but absence of network syscalls was not independently monitored.
- The deterministic protocol fixture is fault infrastructure, not an MCP conformance oracle or fourth validation target.
- The frozen demo server remains only a compatibility smoke.
- No external trace schema v3, Git verifier, final adapter, scenario catalogue, mining, holdout, replay, mutation testing, Gate D/E evidence, or model traffic was implemented.
- This result does not establish MCP conformance, production readiness, security, arbitrary-server compatibility, cross-platform behavior, or model reliability.

## Single next action

Complete formal Gate B by running the canonical 20-materialization and ten-fresh-trials-per-direct-path thresholds with the committed direct harness; do not begin Gate D or model traffic as part of that action.
