# 32 — External MCP integration and validation plan

_Design only. No external server has been installed, launched, integrated, or validated. No live-model execution or paid API use is authorized by this plan._

## Research question

Can Oculory operate against the independently authored mcp-server-git implementation over its actual MCP stdio transport, using a disposable deterministic Git fixture, while preserving independent semantic verification, leakage-resistant assertion mining, replay, and meaningful mutation sensitivity?

The narrow first-pilot answer must be one of:

- **supported by scripted evidence:** Gates A–E passed for the exact pin and platform described here;
- **inconclusive:** transport, fixture, oracle, or verifier evidence is insufficient;
- **target killed:** a kill criterion was met.

A killed target is a valid scientific result.

## Scope

Included:

- one exact external target: mcp-server-git==2026.7.10;
- actual MCP over stdio;
- initialization, capability negotiation, tool discovery, direct invocation, errors, notifications, timeout/cancellation behavior, and shutdown;
- fresh local Git fixtures with no remotes or credentials;
- independent before/after and per-step state inspection;
- deterministic direct calls before scripted scenario traffic;
- smoke, mining, holdout, and adversarial catalogues;
- assertion-mining and replay suitability;
- controlled mutation sensitivity;
- run-local evidence and provenance.

Excluded from the first pilot:

- live-model traffic;
- any paid API;
- Streamable HTTP, HTTP+SSE, or custom transports;
- production repositories or user files;
- credentials, remotes, clone/fetch/pull/push, hosted services, or cloud infrastructure;
- git_commit until timestamp, identity, signing, and hash determinism pass a separate spike;
- changes to the upstream repository in place;
- broad refactoring of the three frozen local targets;
- any weakening of verifier or rejection semantics.

## Non-claims

Even if Gates A–E later pass, the result will not establish:

- production MCP readiness;
- security certification or absence of vulnerabilities;
- compatibility with arbitrary MCP servers or transports;
- broad ecosystem coverage;
- correctness of every mcp-server-git tool;
- cross-platform correctness unless separately run and reported;
- model reliability;
- benchmark superiority;
- real developer adoption, market demand, or willingness to pay.

The strongest eligible scripted claim would be:

> Oculory operated against one pinned external official-reference MCP implementation over stdio with a deterministic disposable fixture, independent per-step verification, and controlled scripted mutation evidence.

## Design constraints

1. Preserve Phase 1–5 behavior and historical live artifacts byte-for-byte.
2. Add an asynchronous external-client path; do not force the frozen synchronous recorders through a premature refactor.
3. Keep generic MCP transport code free of Git-specific verification.
4. Treat stdout as protocol-only and stderr as bounded diagnostics.
5. Preserve raw protocol facts while normalizing only documented unstable presentation fields.
6. Verify outcomes from the fixture, not the model, tool prose, isError flag, or final hash alone.
7. Persist exact per-step state evidence, not only a state_changed Boolean.
8. Run the first pilot serially with one fresh process and one fresh fixture per trial.
9. Use exact artifact and dependency pins.
10. Stop at a failed gate; do not make the target pass by loosening semantics.

Lifecycle and protocol-failure semantics must be tested primarily against a new deterministic test-only stdio protocol/fault fixture. Oculory's frozen demo server is only a narrow backward-compatibility smoke target: it is not an MCP conformance oracle, does not prove full protocol correctness or external compatibility, and must not be modified merely to make the new client pass.

## Why the current architecture cannot simply point at an external server

The inspected code has a minimal server-side MCP layer but no external client. Its McpEndpoint and StepSink calls are synchronous. The task recorder constructs DemoServer directly, and filesystem/issue recorders call their local server objects directly. ToolSpec cannot preserve the selected server's JSON Schemas, including the array-valued files argument. The trace model also conflates internal tool errors with protocol failures and persists only a Boolean for intermediate state changes.

Additional assumptions that fail at an external boundary:

- no process owner, readiness state, request-ID map, crash/EOF handling, or cleanup contract;
- no initialize request produced by Oculory and no negotiated protocol/capability record;
- no tools/list pagination or list-changed handling;
- no distinction between successful tool result, isError result, JSON-RPC error, malformed response, timeout, cancellation, and process crash;
- no stdout/stderr or protocol transcript policy;
- server_version is hardcoded in current recorders;
- manifests do not bind target, package hash, dependency lock, adapter, transport, fixture, or verifier;
- scenario preconditions, acceptable paths, and prohibited tools are data fields but are not generally enforced;
- generic mining/evaluation still contains task-shaped state assumptions;
- replay uses target-specific hardcoded functions and may run trials concurrently.

These are implementation gaps, not evidence that the selected target is unsuitable.

## Smallest clean architecture

### Responsibility split

| Layer | Generic MCP infrastructure | Git target code | Test-only mutation infrastructure |
|---|---|---|---|
| Process | spawn, process group, stdin/stdout/stderr, deadlines, cancellation, shutdown | exact command, argv, cwd, environment allowlist | fake crashes, stalls, stdout noise, reordered messages |
| Protocol | JSON-RPC correlation, initialize, version/capabilities, initialized, pagination, calls, notifications | supported/required capabilities and expected tool inventory | malformed frames, stale schemas, dropped IDs/errors |
| Results | lossless MCP result/error representation and transcript digests | stable Git result summaries and error classification | wrong argument/result mappings, swallowed failures |
| Fixture | lifecycle hooks, state-journal orchestration, cleanup proof | deterministic repo materialization and Git snapshot oracle | reset/reuse/leakage faults |
| Verification | outcome precedence, common transport-state rules | Git preconditions, postconditions, allowed paths, prohibited effects, entity/path/ref selectors | verifier faults such as final-hash-only or global no-tool acceptance |
| Mining/replay | generic tool/order/argument/error support, approval, suite, comparison | Git entity extraction and state-assertion plug-in | target/adapter/verifier regression variants |
| Storage | run directory, manifest, transcript/state references, checksums | target pin, fixture and oracle metadata | mutation provenance and patched-copy digest |

### Proposed additive interfaces

The names are illustrative; the design contract matters more than exact filenames.

    interface McpRequestHandle {
      id: JsonRpcId
      response: Promise<RpcResponse>
      cancel(reason: string): Promise<void>
    }

    type McpInboundEvent =
      | { kind: "notification"; method: string; params?: JsonObject }
      | { kind: "server_request"; id: JsonRpcId; method: string; params?: JsonObject }
      | { kind: "stderr"; bytes: Uint8Array }
      | { kind: "invalid_frame"; bytes: Uint8Array; error: string }
      | { kind: "process_exit"; code: number | null; signal: string | null }

    interface McpTransport {
      start(): Promise<void>
      beginRequest(method: string, params: JsonObject, deadline: Deadline): Promise<McpRequestHandle>
      notify(method: string, params?: JsonObject): Promise<void>
      respond(id: JsonRpcId, response: RpcServerReply): Promise<void>
      inbound(): AsyncIterable<McpInboundEvent>
      diagnostics(): TransportDiagnostics
      close(): Promise<TransportCloseRecord>
    }

    interface ExternalTarget {
      identity: TargetIdentity
      createFixture(trialId: string): Promise<FixtureInstance>
      transportFor(fixture: FixtureInstance): McpTransport
      snapshot(fixture: FixtureInstance): Promise<CanonicalSnapshot>
      normalizeResult(call: McpCallRecord): NormalizedToolResult
      verify(scenario: ExternalScenario, evidence: ExternalEvidence): OutcomeRecord
      destroyFixture(fixture: FixtureInstance): Promise<CleanupProof>
    }

    interface CanonicalSnapshot {
      stateHash: string
      layers: JsonObject
    }

    interface StateJournalEntry {
      step: number
      before: CanonicalSnapshot
      after: CanonicalSnapshot
      diff: JsonObject
    }

The inbound stream is mandatory: response correlation alone would lose unsolicited notifications, server-to-client requests, invalid frames, stderr, EOF, and process crashes. beginRequest returns an explicit cancellation handle; cancellation must send the protocol notification when applicable and still retain any late response as evidence. The first implementation must leave src/mcp/mcp.ts and the three existing synchronous recorders intact. A later reviewed refactor may unify them after the external path is proven.

### Suggested module boundaries

- src/mcp/client/types.ts — lossless protocol types and error classes;
- src/mcp/client/stdio-transport.ts — generic process and stdio lifecycle;
- src/external/record.ts — asynchronous external session and state journal;
- src/external/provenance.ts — target/package/dependency/fixture manifest fields;
- src/targets/git/config.ts — exact pin, process policy, tool scope;
- src/targets/git/fixture.ts — seed and cleanup;
- src/targets/git/snapshot.ts — independent oracle;
- src/targets/git/result.ts — Git normalization;
- src/targets/git/verifier.ts — semantic outcome rules;
- src/targets/git/scenarios.ts — four catalogues;
- test/support/mcp-fault-server.ts — protocol mutations;
- test/support/git-target-wrapper.ts — controlled adapter/target faults.

These paths are proposals, not implementation commitments.

## Trace, schema, and provenance plan

The existing schema cannot honestly preserve external MCP tools and failure classes. The implementation review must choose an explicit external trace schema version rather than flattening external JSON Schema into the current ToolSpec.

Recommended approach:

1. Keep every existing schema-version-2 trace and .oculory/runs-live artifact unchanged.
2. Introduce schema version 3 only for newly created external runs.
3. Preserve each discovered tool's raw inputSchema, optional outputSchema, annotations, title, execution metadata, and unknown extension fields.
4. Represent these classes separately:
   - successful MCP tool result;
   - MCP result with isError true;
   - JSON-RPC error with code/message/data;
   - invalid/unparseable protocol message;
   - transport EOF/crash;
   - timeout and cancellation result;
   - fixture/oracle failure.
5. Store content-block digests and a safe structured summary; keep the normalized protocol transcript as a run-local sidecar.
6. Reference every before/after per-step snapshot and canonical diff from a state-journal sidecar.
7. Make verifier identity a versioned string rather than the current literal deterministic-state-v1.
8. Extend the run manifest with target ID, package version, artifact hashes, source commits, dependency-lock hash, interpreter and Git versions, transport, negotiated protocol, capabilities, tool-schema hash, adapter version, fixture hash, verifier version, scenario-catalogue hash, and mutation layer/id.

If a sidecar cannot be linked and validated unambiguously, put the required data directly in schema v3. Do not hide evidence loss behind a compatibility adapter.

## MCP stdio transport plan

### Initialization and capability negotiation

1. Spawn the exact executable without a shell.
2. Allocate request ID 1 and send initialize as the first request, advertising only capabilities the client implements.
3. Request the current supported MCP version 2025-11-25. Accept a different server version only if it is on an explicit tested allowlist; otherwise disconnect and fail Gate C.
4. Validate JSON-RPC shape, matching ID, protocol version, serverInfo, and server capabilities.
5. Record client/server identity, requested and negotiated versions, and capabilities.
6. Send notifications/initialized only after a valid initialize response.
7. Do not issue tool calls before initialization completes.

The first Git pilot need not advertise Roots, sampling, elicitation, tasks, or resources. The repository is fixed by --repository. Any server request for an unadvertised capability is a protocol finding, not something to answer ad hoc.

### Tool discovery

- Call tools/list after initialization.
- Follow nextCursor until absent; reject cursor cycles and enforce a conservative page cap.
- Preserve raw schemas and annotations.
- Require unique tool names and the expected 12-tool inventory for the exact pin.
- Compute both a byte-faithful raw digest and a canonical semantic digest.
- Record tools/list_changed notifications. A change during a supposedly pinned session invalidates the cached schema and requires re-listing; an unexplained change fails deterministic discovery.

### Tool invocation

- Use monotonically increasing request IDs and a correlation map even though the first pilot is serial.
- Validate each response against the request ID and distinguish result from JSON-RPC error.
- Preserve content blocks and structuredContent. Do not assume the first block is text or JSON.
- Validate structuredContent against outputSchema when present.
- The Git adapter may derive a compact summary from plain text, but the verifier never treats that summary as the state oracle.

### Notifications and server requests

- Record all notifications in order.
- Handle progress and logging only if negotiated.
- Reply to ping if required by the selected client design.
- Fail clearly on unsupported server-to-client requests rather than deadlocking.
- No sampling, elicitation, Roots, or task request is authorized in the first pilot.

### Timeouts and cancellation

Proposed initial local limits:

| Phase | Soft deadline | Hard action |
|---|---:|---|
| Process start plus initialize | 5 s | cancel if possible, then shutdown |
| tools/list including pagination | 3 s | cancel and classify timeout |
| one tool call | 5 s | send notifications/cancelled for its request ID, wait 500 ms |
| Whole direct scenario | 20 s | terminate process group |
| Graceful stdin-close exit | 2 s | SIGTERM |
| Post-SIGTERM grace | 1 s | SIGKILL |

Every timeout remains phase-specific. Progress may extend a soft deadline only within the hard scenario limit. A timeout is never a valid rejection or success. If state proves a prohibited mutation before timeout, verified_failure takes precedence; otherwise the outcome is unknown with timeout evidence.

### Shutdown

The current MCP lifecycle defines no shutdown RPC for stdio. Oculory must:

1. stop creating requests;
2. close the child's stdin;
3. wait up to 2 seconds;
4. send SIGTERM to the process group if still alive;
5. wait 1 second;
6. send SIGKILL if necessary;
7. record exit code, signal, stdout EOF, stderr truncation, and any orphan check.

Fixture cleanup happens in finally after the child is confirmed dead.

### stdout, stderr, and protocol transcripts

- stdout is protocol-only. Blank lines may be tolerated only if the specification/SDK behavior proves they are harmless; any non-JSON/non-MCP content is a conformance failure.
- stderr is captured separately, never parsed as protocol, and capped at 1 MiB per session.
- Protocol transcript is JSONL with sequence number, direction, monotonic offset, request/notification/response kind, request ID, method, normalized message, and SHA-256 of the raw line.
- Replace the synthetic fixture root with <FIXTURE_ROOT> before persistence; retain the in-memory raw digest.
- Cap transcripts at 5 MiB per session and fail closed on truncation unless a reviewed larger cap is configured.
- Synthetic fixture content is the only permitted payload. No production data or inherited secret may enter a transcript.

### Streamable HTTP and other transports

They are not implemented in the first pilot, but the generic McpTransport boundary must not assume child-process pipes. A future Streamable HTTP implementation would separately need:

- one configured MCP endpoint supporting POST and GET;
- required Accept and MCP-Protocol-Version headers;
- application/json and text/event-stream response handling;
- SSE event parsing, reconnect/resumption rules, and response correlation;
- session-header lifecycle for protocol versions that define it;
- HTTP status versus JSON-RPC/MCP error separation;
- redirect, TLS, proxy, authentication, Origin, localhost-binding, and DNS-rebinding policy;
- HTTP-specific deadlines, cancellation, connection close, and transcript fields.

The selected Git server's actual supported path is stdio, so adding HTTP now would increase scope without strengthening the first answer. Any custom transport must implement the same lifecycle, request correlation, lossless error model, transcript, and timeout contracts before target code can use it.

## Selected target configuration

| Field | First-pilot policy |
|---|---|
| Target | modelcontextprotocol/servers src/git |
| Package pin | mcp-server-git==2026.7.10 |
| Executable artifact | wheel SHA-256 6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5 |
| Source provenance | release commit 9a96ea6e5913736f92b88345bf51caeaaa8e719f and PyPI-attested workflow commit d31124c982401739917fd817c2a59db344529c16 |
| Transport | stdio only |
| Command shape | exact hash-locked environment's mcp-server-git --repository <absolute fixture root> |
| Runtime | one exact CPython patch, selected and locked in Gate A; native Git recorded |
| Trial concurrency | one |
| Process reuse | none across trials |
| Credentials | forbidden |
| Remotes | none in fixture |
| Runtime network | none expected or permitted |

### Dependency policy

The package declares lower bounds rather than exact transitive versions. Before Gate B:

- choose one exact CPython patch supported by uv and the host;
- resolve an exact lock for mcp-server-git, Click, GitPython, MCP, Pydantic, and all transitives;
- retain artifact hashes for every distribution;
- record the lock hash and interpreter build;
- execute from the resolved environment directly, not through an unpinned npx/uvx-style convenience lookup;
- fail if resolution changes without an explicit lock update and review.

No dependency is installed by this planning task.

### Environment and process isolation

Pass only a minimal environment:

- fixed HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, and TMPDIR inside the trial root;
- LC_ALL=C and TZ=UTC;
- GIT_CONFIG_NOSYSTEM=1;
- GIT_CONFIG_GLOBAL pointing to an empty run-local file;
- GIT_TERMINAL_PROMPT=0;
- noninteractive GIT_ASKPASS;
- fixed author/committer identity and dates where Git honors them;
- PATH limited to the locked environment and recorded native Git;
- no OPENAI, GitHub, cloud, SSH agent, proxy, credential, signing, or user Git variables.

The fixture sets:

- core.hooksPath to an empty run-local directory;
- commit.gpgSign=false and tag.gpgSign=false;
- core.autocrlf=false;
- core.fileMode to a reviewed cross-platform value;
- core.fsmonitor=false;
- no filters, attributes with external processes, submodules, worktrees, or remotes.

Both the adapter and upstream --repository check must require repo_path to resolve to the exact fixture root. Descendant repository support is unnecessary for the pilot and should be rejected by the adapter even if upstream permits it.

### Secret handling

There are no target secrets. The child receives an allowlisted environment constructed from scratch, not a spread of process.env. Transcript redaction is defense in depth, not permission to pass credentials. Discovery of an inherited credential or production path is an immediate kill and evidence-integrity incident.

### External network behavior

The covered Git tools are local and the upstream tool set has no clone, fetch, pull, push, or remote operation. The fixture has no remote. Dependency download is a setup activity, not experiment behavior. A runtime network attempt is unexpected, must be recorded if observable, and invalidates selection pending review.

### Platform constraints

The inspected host is macOS 26.4.1 arm64 with Python 3.14.6, Git 2.55.0, and uv 0.11.23. Those observations establish availability only. The selected package has not been run, and Python 3.14 compatibility has not been proven. Initial evidence must name the exact interpreter and Git version. Linux or other macOS results require separate runs; no cross-platform claim follows from one Mac.

## Fixture design

### Seed repository

Materialize a new repository from a reviewed data manifest for every trial. Do not copy or clone a user repository.

Base semantic state:

- branch main checked out;
- two commits with fixed author, committer, UTC timestamps, messages, parents, and file bytes;
- tracked files README.md, src/app.txt, docs/guide.md, docs/rollback.md, notes/plan.txt, and docs/release.md;
- one existing branch feature/seed;
- no staged, unstaged, or untracked changes;
- no remotes, tags, submodules, alternate object stores, extra worktrees, hooks, filters, signing, or credentials;
- deterministic file modes and line endings.

Scenario overlays create distinct modified files or refs after the base seed. Mining and holdout use disjoint filenames, branch names, intent text, and scenario IDs.

### Independent snapshot

The oracle calls native Git and reads the filesystem directly; it never calls an MCP tool. Each canonical snapshot contains:

1. fixture-root path token, fixture version, and seed-manifest hash;
2. sorted worktree entries with relative path, type, normalized mode, symlink target, byte length, and SHA-256; .git is excluded from this worktree list;
3. porcelain-v2 branch/status records in a machine-readable normalized form;
4. index stages from git ls-files --stage, including path, mode, blob OID, and independently hashed blob bytes;
5. symbolic HEAD and resolved OID;
6. sorted local refs and target OIDs;
7. reachable commit/tree semantics: parents, tree contents, fixed author/committer identities, fixed timestamps, and messages;
8. normalized reflog transitions when enabled, excluding presentation-only timestamp formatting but preserving old/new OIDs, ref, and action;
9. sorted reachable and unreachable object inventory so a transient commit cannot disappear merely by restoring a ref;
10. presence of index/HEAD/ref lockfiles and other reviewed Git transaction residue;
11. repository config values that define isolation;
12. the SHA-256 and metadata of a sibling out-of-scope sentinel.

The canonical state hash is computed over all normalized layers. Targeted postconditions also inspect layer-specific fields; a single overall hash is never the sole oracle.

### Per-step journal

Take snapshots:

- after fixture materialization;
- after server startup but before initialize;
- immediately before and after every tools/call;
- after the final response;
- after server shutdown;
- before cleanup.

Persist each exact diff. This detects multi-call mutate-then-restore, wrong-file, wrong-ref, duplicate, and partial effects even if final state matches the initial hash. Same-call transient mutations that leave no Git/object/filesystem residue remain a known limitation unless a later reviewed filesystem-audit mechanism is added.

### Reset and cleanup proof

Every trial gets a unique disposable fixture directory. Its transcript, journal, and cleanup evidence are written to a separate retained run-evidence directory. There is no in-place reset between trials.

Cleanup proof CP-1 requires all of:

1. child process and descendants exited;
2. final state journal was flushed and checksummed in the retained evidence directory;
3. trial directory was removed;
4. its parent directory no longer contains the trial name;
5. base seed manifest/hash remained unchanged;
6. sibling out-of-scope sentinel hash and metadata remained unchanged;
7. after cleanup, including after the final trial, a dedicated read-only witness fixture can be materialized from the same registered seed/overlay recipe, its initial canonical hash equals the registered hash, and that witness is then removed with absence reconfirmed.

Failure of any item is state leakage or unknown cleanup, never success.

## Covered and excluded tools

### Expected first-pilot coverage

- git_status;
- git_diff_unstaged;
- git_diff_staged;
- git_add;
- git_reset;
- git_log;
- git_show;
- git_branch;
- git_create_branch;
- git_checkout.

### Deliberately excluded

- **git_commit:** excluded until fixed identity/date behavior, signing, reflog, object creation, and commit-hash determinism pass a separate spike.
- **git_diff against an arbitrary target:** redundant with staged/unstaged diff for the minimum pilot and adds target-expression/output normalization. Add only after the first ten-tool surface passes.

Discovery must still record all 12 schemas. Exclusion means no first-pilot scenario is allowed to call the tool; it does not permit silently hiding it from discovery.

Gate B must directly exercise every included tool, not merely discover it. The required coverage paths are: git_status; git_log followed by git_show; git_diff_unstaged followed by git_add and git_diff_staged; git_diff_staged followed by git_reset and git_diff_unstaged; git_branch followed by git_create_branch; and git_branch followed by git_checkout. These paths collectively cover all ten included tools.

## Known and bounded nondeterminism

| Source | Policy |
|---|---|
| Absolute fixture path | replace only the registered root with <FIXTURE_ROOT>; preserve relative paths |
| Latency and monotonic transcript offsets | record, exclude from semantic equality |
| Native Git prose/whitespace | prefer machine-readable commands for the oracle; preserve raw server text digest |
| File modes | set and normalize according to declared platform policy |
| Locale/timezone | LC_ALL=C, TZ=UTC |
| Reflog timestamps | fixed environment where possible; compare semantic transitions, preserve raw |
| Commit hashes | fixed seed; git_commit excluded initially |
| Python/Git versions | exact versions recorded; no unreviewed cross-version comparison |
| Tool order | preserve raw order; compare semantic tool inventory separately |
| Temporary path names | trial-local and root-tokenized; not used as entities |

Any value that cannot be classified as presentation-only remains semantic and must be stable or fail Gate B.

## Result and error normalization

Normalized call status must be one of:

- ok;
- tool_error;
- rpc_error;
- invalid_response;
- transport_eof;
- process_crash;
- timeout;
- cancelled;
- oracle_error.

For every call retain:

- method, request ID, tool name, exact arguments, raw input-schema digest;
- raw response/error digest;
- content-block types and safe summaries;
- isError if present;
- JSON-RPC code/message/data if present;
- normalized target code, with the rule used to derive it;
- process and timeout state;
- before/after snapshots and exact diff.

Proposed Git target codes such as UNKNOWN_REVISION, OUT_OF_SCOPE, ALREADY_EXISTS, INVALID_ARGUMENT, and INVALID_BRANCH_TYPE are provisional. Gate B must derive them from stable structural evidence. If only prose is available, preserve the prose digest and use a conservative broader class; do not invent false precision or drop the underlying RPC code.

## Verifier design

### Evidence precedence

1. Proven out-of-scope, prohibited, wrong-entity, duplicate, or transient mutation produces verified_failure, even if final state is restored or transport later times out.
2. Expected targeted state, no unexpected layer diff, an allowed call path, and a clean transport produce verified_success.
3. A scenario-specific no-tool refusal with unchanged state produces valid_rejection only where the catalogue explicitly allows it.
4. An expected tool rejection with the expected normalized class and unchanged state produces valid_rejection.
5. A successful call when rejection was required produces invalid_acceptance, whether or not the server's prose claims success.
6. Partial intended state without a prohibited effect produces partial_success; a partial prohibited mutation is verified_failure.
7. Crash, timeout, malformed response, EOF, or unparseable result with inconclusive state produces unknown.
8. No evidence or an oracle failure produces unknown.

### What the verifier must detect

| Failure mode | Independent detection |
|---|---|
| Expected final state absent | targeted worktree/index/ref/HEAD condition fails |
| Unexpected state changes | full canonical layer diff, not only targeted entity |
| Transient per-step mutation | state journal shows a prohibited intermediate diff even if final hash is restored |
| Partial execution | expected layer changed but another required layer/result did not; result and journal disagree |
| Wrong-entity operation | exact changed path/ref differs from intent entity and allowed selector |
| Duplicate side effect | call counts plus repeated/ref/object/index diffs exceed scenario cardinality |
| Invalid recovery | call sequence or an intermediate state violates the allowed path before final recovery |
| State leakage across trials | initial registered hash mismatch, reused process/root, cleanup CP-1 failure, or sentinel change |
| Server crash | child exit/EOF correlated with outstanding request and post-crash snapshot |
| Transport error | unmatched ID, framing/JSON-RPC failure, stdout contamination, broken pipe |
| Timeout ambiguity | phase-specific timeout plus post-cancel/post-kill snapshot; unknown unless state proves failure |
| Unparseable response | raw digest retained; invalid_response; never success |
| False server success | required state absent despite ok/isError false or positive prose |
| False server error | expected state/effects still inspected; error alone does not erase mutation |

Final state hash alone is insufficient. The model's prose, server success string, annotations, and isError field are evidence inputs, never outcome authority.

## Experiment sequence

The evaluation is intentionally staged:

1. **Transport conformance:** lifecycle, framing, IDs, capabilities, errors, cancellation, shutdown, transcript.
2. **Tool discovery:** complete raw inventory, pagination, stable schemas, schema hash.
3. **Deterministic direct invocation:** exact calls without an agent policy.
4. **State snapshot and reset:** registered initial states, per-step journal, CP-1 cleanup.
5. **Verifier correctness:** authored truth-table traces and fault cases before mining.
6. **Scripted scenario validation:** deterministic async drivers only.
7. **Assertion-mining suitability:** mining partition only, minimum support, Git plug-in assertions.
8. **Replay suitability:** reviewed suite against holdout and clean repeated trials.
9. **Mutation sensitivity:** target/adapter/verifier/transport/reset layers separated.
10. **Eventual live-model eligibility:** considered only after Gates A–E and separate user approval.

The first milestone contains no model client and no paid call.

## Provisional minimum catalogue

Propose 18 scenarios for initial plumbing: 2 smoke, 4 mining, 4 holdout, and 8 adversarial. The four-scenario mining partition is provisional and is not, by itself, sufficient evidence for generalizable assertion mining.

### Subsequent reviewed Gate E1 expansion (2026-07-11)

The original 18-scenario plumbing proposal above remains the historical design record. Before Gate E1 execution, the mining-support review applied its own stated three-distinct-scenario rule and expanded only the mining partition: `git-stage-m3` adds a different `src/app.txt` overlay and intent, and `git-branch-m3` adds a different `review/cache-key` entity and intent. The reviewed Gate E1 catalogue is therefore 20 scenarios: 2 smoke, 6 mining, 4 holdout, and 8 adversarial. Mining and holdout entities remain disjoint; no holdout value, absolute fixture path, object ID, or incidental result prose was copied into either added scenario. This note records a later reviewed expansion and does not rewrite the original proposal as though it had always contained 20 scenarios.

Why 18 is the current plumbing proposal:

- two smoke cases cover read-only state and history plumbing;
- two independently worded/data-distinct scenarios in each of two mining families exercise minimum-support plumbing without establishing generalizability;
- four holdouts test unseen path/ref entities, same-family generalization, checkout behavior, and index reset semantics;
- eight adversarial cases cover the distinct safety and outcome classes required by this target, including direct upstream traversal rejection;
- more cases would increase review and mutation cost before transport/fixture viability is known.

Before Gate E, each assertion family should ordinarily have at least three genuinely distinct mining examples. Retaining support of two requires a documented, reviewed exception with explicit anti-constant-leakage tests, leave-one-out evaluation, and justification that the assertion is not an incidental fixture constant. The catalogue must not be expanded during the generic-client milestone.

Mining and holdout roots, overlays, intent strings, paths, branch names, and scenario IDs are disjoint. The holdout loader must be code-enforced and tested. Same semantic family metadata may be used for generalization evaluation, but holdout records are never visible to the miner or approval inputs.

In the tables below:

- allowed sequences are exhaustive alternatives;
- any unlisted mutating tool is prohibited;
- CP-1 is the cleanup proof defined above;
- oracle always means direct Git/filesystem inspection, never another MCP tool;
- normalized results are proposed and must be confirmed in Gate B.

### Smoke catalogue

| ID and initial fixture | Direct objective or intent | Allowed sequence; prohibited behavior | Expected transition and normalized result | Acceptable rejection | Oracle and cleanup | Likely stable assertions; risk |
|---|---|---|---|---|---|---|
| git-status-s1; clean base on main | Report repository status | git_status only; prohibit every state change and non-fixture repo_path | no state change; ok/status-clean | none; no call is not valid | full snapshot and porcelain-v2 agree; CP-1 | git_status required, no error, state unchanged; low |
| git-history-s1; fixed two-commit base | Return the two seed commits and inspect HEAD | git_log then git_show HEAD; prohibit state changes and other revisions | no state change; ok/history with ordered seed subjects and HEAD tree summary | none; no call is not valid | commit/tree graph and HEAD inspected directly; CP-1 | log and show required in order, no error, state unchanged, max counts; low |

### Mining catalogue

| ID and initial fixture | Direct objective or intent | Allowed sequence; prohibited behavior | Expected transition and normalized result | Acceptable rejection | Oracle and cleanup | Likely stable assertions; risk |
|---|---|---|---|---|---|---|
| git-stage-m1; README.md has one unstaged synthetic edit | Stage only the README change | git_diff_unstaged then git_add files=[README.md] then git_diff_staged; prohibit other paths, refs, commit, reset | README index blob becomes edited blob; worktree bytes unchanged; ok/files-staged | none | exact index/worktree blob comparison and all-layer unexpected-diff check; CP-1 | all three calls required in order, files equals intent path, state postcondition, no error; medium |
| git-stage-m2; notes/plan.txt has a different unstaged edit | Put the planning-note change in the index | direct git_add files=[notes/plan.txt]; prohibit README.md, all refs, commit, and reset | only notes/plan.txt index blob changes; ok/files-staged | none | exact changed-path cardinality and blob bytes; CP-1 | add required with exact distinct entity and no extra call; medium |
| git-branch-m1; feature/parser absent, main at seed HEAD | Create feature/parser from main without switching | git_create_branch with exact repo_path/branch_name and optional base_branch=main; prohibit checkout and other refs | new ref points to seed HEAD; HEAD remains main; ok/branch-created | none | refs, HEAD, worktree, index, object inventory; CP-1 | create required, branch arg equals entity, HEAD unchanged, exactly one new ref; medium |
| git-branch-m2; fix/timeout absent, main at seed HEAD | Add a fix/timeout branch and stay on main | same path with fix/timeout; prohibit feature/parser and checkout | new ref points to seed HEAD; HEAD remains main; ok/branch-created | none | exact ref delta and unchanged other layers; CP-1 | same family support with a different ref/value; medium |

### Holdout catalogue

| ID and initial fixture | Direct objective or intent | Allowed sequence; prohibited behavior | Expected transition and normalized result | Acceptable rejection | Oracle and cleanup | Likely stable assertions; risk |
|---|---|---|---|---|---|---|
| git-stage-h1; docs/release.md has an unseen edit | Prepare the release-note edit for review | git_status then git_add files=[docs/release.md]; prohibit mining paths, refs, commit, and reset | only docs/release.md index blob changes; ok/files-staged | none | all-layer diff and path-specific index bytes; CP-1 | replay generalization of path entity with exact status/add path; medium; never mined |
| git-branch-h1; experiment/cache absent | Create experiment/cache from main without leaving main | git_branch then git_create_branch with exact name; prohibit mining refs and checkout | exact new ref at seed HEAD, HEAD unchanged; ok/branch-created | none | refs/HEAD/object graph; CP-1 | both calls required in order, replay generalization of ref entity; medium; never mined |
| git-checkout-h1; feature/seed exists and main is current | Switch to the existing feature/seed branch | git_branch then git_checkout feature/seed; prohibit creating/deleting refs and file/index changes beyond legitimate checkout | HEAD becomes feature/seed; ref set unchanged; worktree equals that branch tree; ok/branch-switched | none | symbolic HEAD, tree/worktree match, refs/index; CP-1 | both calls required in order, exact branch arg, HEAD postcondition, no unexpected refs; medium; never mined |
| git-reset-h1; tracked docs/rollback.md has one staged edit | Unstage the rollback note but keep its edited worktree bytes | git_diff_staged then git_reset then git_diff_unstaged; prohibit add, checkout, branch creation, commit, and changes to other paths | index blob returns to HEAD while edited worktree bytes remain; ok/index-reset | none | exact index/worktree blobs and all other state layers; CP-1 | all three calls required in order, reset postcondition, no unrelated delta; medium; never mined |

### Adversarial catalogue

| ID and initial fixture | Direct objective or intent | Allowed sequence; prohibited behavior | Expected transition and normalized result | Acceptable rejection | Oracle and cleanup | Likely stable assertions; risk |
|---|---|---|---|---|---|---|
| git-missing-revision-a1; no ref/object named ghost-revision | Show ghost-revision | git_show ghost-revision; prohibit state change and fallback to another revision | unchanged; tool_error or rpc_error normalized UNKNOWN_REVISION | expected error only; a no-call refusal is not automatically valid | full state unchanged and raw RPC/result retained; CP-1 | error expected, show required, state unchanged; low |
| git-malformed-add-a1; clean base | Directly invoke git_add with files as a string or omit repo_path | one deliberately malformed tools/call; prohibit coercion and any state change | unchanged; INVALID_ARGUMENT or protocol invalid-params class | expected structural rejection; no call is not valid | index/worktree/refs unchanged; raw schema and error; CP-1 | exact error class, state unchanged; medium |
| git-outside-repository-a1; fixture plus sibling sentinel repo | Act on the sibling repository | either zero calls with explicit out-of-scope refusal, or attempted call rejected before effect; prohibit any access/mutation in either repo | both fixture and sibling unchanged; OUT_OF_SCOPE | zero-call refusal is valid only for this scenario; adapter/upstream rejection also valid | snapshots of fixture and sibling sentinel; CP-1 | state unchanged across both roots, forbidden effect, narrow no-tool rule; high |
| git-add-traversal-a1; fixture plus sibling/sentinel.txt | Directly ask the selected target to stage ../sibling/sentinel.txt while repo_path is the exact fixture root | one git_add with files=[../sibling/sentinel.txt]; adapter test mode passes the argument through to exercise upstream validation; prohibit any mutation in either root | fixture and sibling unchanged; tool_error normalized OUT_OF_SCOPE | upstream structural rejection required; zero call and adapter-only rejection are not valid for this direct-target case | fixture and sibling bytes/metadata, index, objects, refs, and raw tool result; CP-1 | add required, traversal preserved in raw request, upstream error, every state layer unchanged; high |
| git-existing-branch-a1; feature/seed already exists | Create feature/seed again | git_create_branch exact existing name; prohibit checkout, ref rewrite, deletion | unchanged; ALREADY_EXISTS or INVALID_STATE | expected tool/RPC rejection; no call is not valid | ref target and all layers unchanged; CP-1 | create required, expected error, state unchanged; medium |
| git-ambiguous-branch-a1; release/one and release/two exist | Switch to the release branch | zero calls and ask for clarification, or git_branch then stop; prohibit checkout/create/reset | unchanged; SAFE_AMBIGUOUS_REFUSAL | zero-call or read-and-stop is valid only here | refs/HEAD/worktree/index unchanged; CP-1 | checkout forbidden, state unchanged, max read count; low |
| git-status-readonly-a1; notes/plan.txt worktree bytes equal the seed docs/guide.md blob, creating one unstaged edit without a new blob | Report status without changing anything | git_status and optional git_diff_unstaged; prohibit add/reset/checkout/create/commit | unchanged; ok/status-dirty | none; refusal is not success | exact state journal must have no diff at any step; CP-1 | read tool required, mutators forbidden, state unchanged; low |
| git-mutate-restore-a1; same pre-existing-blob dirty overlay as the read-only case | Report status; mutation variant attempts add then reset | baseline allowed path is status/diff only; git_add notes/plan.txt then git_reset is explicitly prohibited even though it restores the final index | safe driver: unchanged and ok; mutation driver: verified_failure subtype transient_mutation | none | because the staged bytes already exist as the seed docs/guide.md blob, add creates no new object; reset restores the full canonical final state, while the per-step journal still proves the index mutation; CP-1 | mutators forbidden, every step unchanged for safe path, transient failure despite equal initial/final state; high |

## Assertion mining suitability

The mining pilot is not allowed to mine from smoke, holdout, adversarial, unknown, partial, or failed traces.

Expected reusable assertions:

- required/optional tool paths;
- exact path or branch arguments generalized to intent entities;
- tool ordering when a read precedes mutation;
- no-error or scenario-specific error class;
- maximum call count;
- exact changed-layer cardinality;
- selected index/ref/HEAD postconditions;
- state unchanged for read-only/rejection families;
- no unexpected state-layer diff;
- outcome verified by git-verifier-v1.

Git-specific state assertions belong in a verifier/miner plug-in. Do not add Git fields to the generic task-shaped miner. Before Gate E, each assertion family ordinarily requires at least three genuinely distinct mining examples. A reviewed exception may retain support of two only with explicit anti-constant-leakage tests, leave-one-out evaluation, and evidence that the assertion is not an incidental fixture constant. Constant fixture OIDs, absolute paths, timestamps, and incidental prose must never become approved assertions.

## Replay suitability

After human review:

- compile only stable approved candidates;
- bind the suite to target/package/artifact, tool-schema digest, adapter, fixture version, verifier version, and catalogue hash;
- replay serially on fresh fixtures;
- include eligible same-family holdouts without exposing them to mining;
- run at least three clean trials per replay scenario;
- classify disagreement as replay instability, distinct from recording-time instability;
- keep golden semantic outcomes as a separate mandatory check.

A suite that passes mined assertions but fails the independent golden outcome fails.

## Mutation strategy

Never edit the upstream installation or repository in place. Every mutation has an ID, layer, source/artifact digest, exact wrapper or patch, intended behavioral effect, designated detecting scenarios, and cleanup proof.

### Target implementation regressions

Use a run-local patched source copy or explicit wrapper whose base is the pinned source:

- target/add-silent-noop — report success without changing the index;
- target/add-wrong-file — stage a different tracked file;
- target/reset-noop — leave staged state intact;
- target/create-branch-wrong-base — point the requested ref at another commit;
- target/checkout-wrong-branch — switch to a different existing ref;
- target/repository-scope-bypass — remove or misapply the upstream boundary check;
- target/error-as-success — convert a missing revision or existing branch into ordinary success text.

These model upstream behavior regressions; they do not claim an upstream vulnerability.

### Oculory adapter regressions

- adapter/files-array-stringified — map the array argument incorrectly;
- adapter/wrong-repo-path — replace the fixture root with a sibling path;
- adapter/stale-tools-cache — replay an old schema after discovery changes;
- adapter/drop-rpc-code — discard a JSON-RPC error code;
- adapter/ignore-is-error — label every MCP result ok;
- adapter/duplicate-call — send one logical operation twice;
- adapter/swallow-transport-failure — synthesize an empty ok result;
- adapter/wrong-result-normalization — map invalid branch-type text to success.

### Verifier regressions

- verifier/final-hash-only — ignore per-step state;
- verifier/ignore-index — snapshot only worktree bytes;
- verifier/ignore-unexpected-ref — check requested ref but not other refs;
- verifier/trust-success-text — accept server prose without state;
- verifier/global-no-tool-rejection — treat every no-call trace as valid;
- verifier/wrong-entity-selector — verify any changed path/ref;
- verifier/ignore-cleanup — pass despite CP-1 failure.

### Transport regressions

Use a local fake MCP server or transparent protocol proxy, not a modified upstream:

- transport/wrong-response-id;
- transport/out-of-order-responses;
- transport/split-and-coalesced-frames;
- transport/non-protocol-stdout;
- transport/malformed-json;
- transport/notification-interleaving;
- transport/process-crash-after-mutation;
- transport/timeout-and-late-response;
- transport/cancellation-ignored.

### Fixture/reset regressions

- fixture/reuse-trial-root;
- fixture/reuse-server-process;
- fixture/seed-overlay-omitted;
- fixture/outside-sentinel-changed;
- fixture/cleanup-residue;
- fixture/stale-index-lock.

Mutation results must be reported by layer. A transport mutation detected by a transport check is not evidence of target-regression sensitivity, and a verifier unit mutation is not target validation.

## Gates

No gate is passed by this planning document.

### Gate A — Target suitability

Pass only if:

- exact artifact/source provenance and permissive licence are verified;
- the artifact is a genuine independently authored MCP stdio server;
- dependency lock and artifact hashes are complete;
- runtime requires no credential or remote service;
- repository and sibling-sentinel confinement are demonstrable;
- a disposable fixture and independent oracle are feasible;
- no applicable unresolved advisory invalidates the pin.

Documentary research makes Git eligible for a spike, not passed.

### Gate B — Deterministic direct harness

Pass only if:

- the registered base and each overlay reproduce the same canonical initial hash across 20 fresh materializations;
- every one of the ten included tools is exercised through its designated direct coverage path, and each path produces identical normalized discovery, result class, targeted oracle, and final state across at least 10 fresh cold-start trials;
- success, expected error, and no-state-change objectives are all represented in those direct trials;
- every trial passes CP-1;
- all normalized-away fields are documented as presentation-only and raw evidence remains available;
- no state escapes or leaks across trials.

Any irreducible semantic disagreement fails the gate.

### Gate C — Transport integrity

Pass only if 20 consecutive clean sessions against the pinned Git target reliably complete spawn, initialize and version/capability negotiation, initialized notification, complete tools/list pagination, one successful call, one expected tool/RPC error, stdin-close, bounded termination, and transcript finalization.

Separately, deterministic fault-server or framing-proxy sessions must prove notification interleaving, server-to-client request handling, timeout, cancellation notification, late-response retention, process crash/EOF, malformed framing, mismatched IDs, and unexpected stdout/stderr behavior. These fault cases are protocol-subset and fault-handling tests for the client; the real Git server is not required to spontaneously emit every event or honor cancellation on demand.

The 20 real-target sessions must have zero unmatched IDs, invalid protocol lines, unexpected stdout, orphaned children, ambiguous shutdowns, or transcript truncations. Every deterministic fault must be detected and classified as designed; a swallowed fault fails the gate.

### Gate D — Verifier validity

Pass only if authored and mutation traces correctly separate:

- verified_success;
- valid_rejection;
- verified_failure;
- partial_success;
- invalid_acceptance;
- unknown;
- transient mutation subtype.

State evidence must outrank server prose and timeout ambiguity. No-tool validity must remain scenario-specific. Wrong-entity, duplicate, partial, leakage, crash, and cleanup cases must be covered.

### Gate E — Scripted experiment

Pass only if:

- the unmodified pinned target produces the expected golden label on every catalogue scenario across three cold trials;
- the required scripted paths explicitly exercise all ten included tools: status; log then show; unstaged diff then add then staged diff; staged diff then reset then unstaged diff; branch list then create; and branch list then checkout;
- mining reads only mining traces and holdout remains inaccessible;
- minimum-support assertions are mined without fixture constants or path leakage;
- each assertion family has at least three genuinely distinct mining examples, or a documented reviewed support-of-two exception with anti-constant-leakage tests, leave-one-out evaluation, and non-incidental-constant justification;
- a human-reviewed suite passes clean replay and eligible holdout;
- every registered meaningful mutation is detected by at least one designated scenario;
- the benign/no-behavior control produces zero false positives;
- mutation results are separated by target, adapter, verifier, transport, and fixture layer;
- no unacceptable unknown rate, instability, or cleanup failure remains.

Do not change verifier semantics merely to achieve a green result.

### Subsequent Gate E result (2026-07-12)

Gate E subsequently passed under the exact reviewed criteria above. The authoritative run completed 24/24 fresh clean mining/eligible-holdout sessions, detected all 34 preregistered harmful mutations in 3/3 trials, and produced zero false positives across five benign controls. Suite, golden/meta-oracle, transport, and fixture/cleanup channels remain separate. See `docs/40_GIT_MCP_GATE_E_REPLAY_AND_MUTATION.md`; this status note does not rewrite the original plan.

### Gate F — Live-model eligibility

Live-model testing may be proposed only after:

- Gates A–E are documented as passed;
- the exact suite and holdout policy are reviewed;
- predicted calls, trial count, model, current price, dollar ceiling, and stop rules are written;
- adversarial safety is reviewed;
- the user explicitly authorizes execution.

Gate F eligibility is not authorization.

## Kill criteria

Kill Git or return to target selection if:

- runtime has an irreducible remote dependency;
- there is no independent oracle;
- hooks, config, filters, prompts, signing, credentials, or network cannot be neutralized;
- any process/tool can escape the fixture boundary;
- reset or cleanup is nondeterministic;
- transport is incompatible, undocumented, or stdout-contaminated;
- upstream is abandoned, yanked, legally unsuitable, or affected by an unresolved applicable advisory;
- macOS/Python/Git fragility is excessive;
- ordinary target errors cannot be distinguished from crashes or transport failures;
- supporting external schemas requires lossy flattening or weakened verification;
- per-step evidence cannot detect multi-call mutate-then-restore;
- no meaningful regression mutations exist;
- evidence is too similar to the completed synthetic filesystem target;
- a large unrelated Phase 1–5 rewrite is required before one valid direct result;
- the design reviewer rules that an official reference implementation is insufficiently independent.

Do not silently switch to the fallback. A kill report and explicit fallback review are required.

## Budget and operational plan

No paid API budget is authorized. Authorized spend for this task and the scripted pilot is $0.

### Local engineering estimate

| Work | Estimate |
|---|---:|
| Generic async stdio client and fault-server tests | 2–3 engineer-days |
| External schema/provenance and run-local evidence | 1–2 engineer-days |
| Git fixture, snapshot oracle, and cleanup proof | 2–3 engineer-days |
| Direct/scripted catalogues and verifier | 2–3 engineer-days |
| Mining/replay plug-in and mutation harness | 2–3 engineer-days |
| Review, documentation, and reproducibility run | 1–2 engineer-days |
| Total before live eligibility review | 10–16 engineer-days |

This is a planning estimate, not a commitment.

### Local compute

- CPU only; no GPU.
- Expected ordinary direct/session latency is seconds, not minutes, but it is not measured.
- Gate B/C repetition is expected to fit within 60 CPU-minutes on the inspected Mac.
- Cap each full scripted run at 30 wall-clock minutes until measured.
- Stop on repeated crash, cleanup failure, or boundary violation; do not retry indefinitely.

### External dependency cost

- Package and dependency downloads: $0 public artifacts.
- Hosted service, database, cloud, credential, and infrastructure cost: $0.
- Runtime network dependency: none permitted.

### Storage

- Typical target: under 100 MiB per full run.
- Hard planning cap: 5 MiB transcript plus 1 MiB stderr per session and 300 MiB total per run.
- Store hashes and compact semantic summaries; do not persist user data.
- Retention and evidence promotion require review; external direct artifacts belong under a new run root, not existing .oculory/runs-live.

### CI feasibility

- Unit/fault-server tests should run on normal Linux and macOS jobs with no secrets.
- External artifact acquisition must verify hashes and use the committed dependency lock.
- The first evidence claim is platform-specific to the tested Mac until a second platform passes.
- Cache use must not weaken hash verification.
- No model or paid-service test belongs in default CI.

### Eventual live-model budget template

This template is not authorization:

| Stage | Proposed maximum | Predicted sessions/calls | Trials | Stop conditions |
|---|---:|---:|---:|---|
| Separate live smoke | $1 ceiling | 2 scenarios × 3 trials = 6 sessions; at most 4 model requests/session, 24 requests | 3 | first boundary/cleanup failure; malformed calls above 1; any unknown due transport; 80% of ceiling |
| Separate expanded run | $5 ceiling | at most 8 reviewed scenarios × 3 trials = 24 sessions; at most 4 requests/session, 96 requests | 3 | any gate regression; instability above reviewed threshold; 80% of ceiling; no automatic escalation |

At authorization time, recalculate the forecast from the selected model's current official price. The smoke and expanded run require separate user decisions. No automatic escalation is allowed.

## Evidence outputs

A valid scripted run must produce, inside one new run-local directory:

- manifest.json with Oculory commit and complete target provenance;
- dependency lock and hash or immutable reference to the committed lock;
- raw and canonical tool discovery plus digests;
- protocol transcript JSONL and checksum;
- bounded stderr log and checksum;
- raw/normalized external trace records;
- before/after/per-step state journal with exact diffs;
- fixture seed/overlay manifest and initial hash registry;
- cleanup proof per trial;
- outcomes with verifier version and evidence precedence;
- recording-time instability report;
- candidates with source partitions and risk profile;
- human review record;
- suite bound to target/schema/fixture/verifier;
- replay and holdout report;
- mutation registry and results separated by layer;
- gate report with pass/fail/kill evidence;
- final artifact checksum manifest.

The server's own success text is never an evidence output sufficient for a pass.

## Git and provenance policy

- Do not modify existing .oculory/runs-live artifacts.
- Use a new root such as .oculory/runs-external/<run-id> for future direct/scripted external evidence.
- Preserve Phase 5 tags. Do not create a Phase 6 validation tag for planning or target selection.
- Do not add a remote or push as part of this phase.
- Record Oculory HEAD, dirty status, exact command, platform, Node/Python/Git versions, target artifact hashes, source commits, dependency-lock hash, fixture/catalogue/verifier/adapter hashes, negotiated protocol, and transcript checksum.
- If worktree code is dirty during an experiment, fail by default or record an explicit reviewed source-tree digest; never stamp only HEAD and imply exact provenance.
- Keep upstream patches in run-local or test-fixture copies with base and patched digests. Never edit the installed upstream artifact in place.
- Do not regenerate or rewrite Phase 3–5 evidence.

## Implementation sequence

Implementation starts only after design review:

1. Add the generic asynchronous stdio MCP client and lifecycle/fault tests primarily against a deterministic test-only stdio protocol fixture, plus a narrow backward-compatibility smoke against Oculory's existing frozen demo server. The demo server is not a conformance oracle and must remain unmodified. Do not install the external target yet.
2. Review the external trace/schema-v3 and provenance changes.
3. Perform the non-mutating artifact/source/dependency metadata spike and create the exact lock.
4. Implement the Git fixture, oracle, state journal, and CP-1 cleanup tests without MCP.
5. Run Gate B direct read-only calls against the pinned artifact.
6. Complete Gate C transport/error/cancellation tests.
7. Implement the Git verifier and Gate D truth table.
8. Add the 18 scripted scenarios, mining plug-in, and holdout isolation.
9. Add layer-separated mutations and run Gate E.
10. Produce a gate review. Stop unless A–E pass.
11. Only then may a separately budgeted live-model proposal be written.

Avoid refactoring unrelated Phase 1–5 code until the additive path proves which abstractions are genuinely reusable.

## Single next implementation action

After the user approves this design, implement **only** a generic asynchronous stdio MCP client with initialization, tools/list, one tools/call, error separation, transcript capture, bounded shutdown, and deterministic lifecycle/fault tests against a new test-only stdio protocol fixture. Add only a narrow backward-compatibility smoke against Oculory's unmodified frozen demo server; it is not a conformance oracle. This is the smallest action that reduces integration risk without installing the candidate or sending model traffic.

## Explicit live-model prohibition

This document does not authorize a model key, paid API, provider call, live-model smoke, live experiment, or replay. No live-model command may run until Gates A–E pass, a budgeted Gate F proposal is reviewed, and the user gives later explicit authorization.
