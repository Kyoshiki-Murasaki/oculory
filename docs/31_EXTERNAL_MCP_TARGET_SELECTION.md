# 31 — External MCP target selection

_Research and design review document. Sources were retrieved on 2026-07-10. No candidate was installed or executed, and this document is not evidence that Oculory supports or has validated an external MCP server._

## Decision

Recommend exactly one Phase 6 target:

**Primary:** the Git component in modelcontextprotocol/servers, pinned as mcp-server-git==2026.7.10.

**Fallback:** the Memory component in modelcontextprotocol/servers, pinned as @modelcontextprotocol/server-memory@2026.7.4.

The primary is independently authored outside Oculory, open source, actively maintained, locally runnable without credentials, uses actual MCP over stdio, accepts a disposable repository boundary, and has a strong out-of-band oracle across the worktree, index, HEAD, refs, objects, and reflogs. Selection is provisional until the documentary and direct-harness gates in docs/32 pass.

## Current evidence gap

Oculory's strongest honest current claim remains:

> Oculory is a credible technical prototype with controlled live-model evidence on three locally authored MCP-like targets.

The largest technical-evidence gap is whether Oculory can operate against independently authored behavior over a real MCP client/server transport while retaining deterministic fixtures and independent outcome verification. This phase is intended to answer that narrow question. It is not production MCP validation, security certification, broad ecosystem validation, benchmark superiority, market validation, or adoption evidence.

Phase 5 remains frozen. The historical artifact limitations in docs/30 are not defects to rewrite during this phase.

## Frozen baseline inspected before research

| Check | Observed on 2026-07-10 |
|---|---|
| Working directory | `<REPO_ROOT>` |
| Branch | master |
| HEAD | a56d68aec800dbd22eea7fa0e4ad55643f8fa5a5 |
| Tag at HEAD | phase5-issue-tracker-live-validated |
| Working tree | clean |
| npm test | 220 passed, 0 failed |
| npm run build | clean |
| ./bin/oculory doctor | all checks passed |

No scripted experiment and no live-model command was run.

## Research method and evidence labels

Research used only public primary sources: canonical repositories, source at exact tags, component documentation, package-registry metadata, release metadata, licence files, commit history, security advisories, and the current MCP specification. Package metadata was queried without installing packages. Repository history was inspected without cloning or adding a Git remote.

The following labels separate evidence types:

- **V — verified fact:** directly supported by a cited primary source or by inspected Oculory code.
- **I — engineering inference:** a reasoned design conclusion that has not been executed.
- **S — spike required:** an assumption that must be resolved by a small direct harness before implementation proceeds.
- **U — unresolved:** not safely answerable from metadata alone.

Sources were retrieved on 2026-07-10 unless a different date is stated.

## What Oculory currently supports

The source audit proves that Oculory does **not** currently validate through a real external MCP client transport.

| Area | Verified current state |
|---|---|
| MCP endpoint abstraction | src/mcp/mcp.ts declares synchronous listTools, callTool, and serverVersion methods. Its only implementation is InProcessEndpoint, constructed around Oculory's DemoServer. |
| Server-side wire code | src/mcp/mcp.ts implements a small server-side subset over newline-delimited stdio: initialize, notifications/initialized, ping, tools/list, and tools/call. It is typed directly to DemoServer and hardcodes protocol version 2025-06-18. |
| Client-side wire code | None. There is no reusable MCP client, request correlation, capability negotiation, pagination, notification handling, cancellation, or transcript capture. |
| Pipe test | test/server-mcp.test.ts spawns Oculory's own task server and sends hand-written JSON-RPC lines. This proves a local pipe round trip only, not external-server integration or full lifecycle conformance. |
| Recording | src/runner/record.ts constructs DemoServer and InProcessEndpoint directly. Filesystem and issue recorders call their local server objects directly and bypass McpEndpoint. |
| Common target interface | None. There is no Target, FixtureController, SnapshotProvider, ResultNormalizer, or VerifierPlugin contract. Similar method names are convention, not a shared interface. |
| Tool schemas | ToolSpec supports only flat string, integer, and boolean parameters plus string enums. It cannot faithfully preserve arbitrary JSON Schema, arrays, nested objects, unions, annotations, or output schemas. |
| Results and errors | Internal results use Oculory's status/error_code/payload shape. JSON-RPC errors, MCP tool errors, crashes, malformed responses, and timeouts are not distinct trace classes. |
| State | RawTrace stores full before/after snapshots. Each step stores a digest, summary, and state_changed Boolean, but not the intermediate snapshot or exact diff. |
| Verification | Outcome verifiers inspect fixture state and expected errors independently of model prose or an ok response. This is a genuine strength. Semantic verifiers and replay runners remain target-specific. |
| Mining | Tool/argument/order/support logic is reusable. Task-shaped state and retrieval assumptions remain in the nominally generic miner and evaluator; filesystem and issue code add target-specific wrappers. |
| Run isolation | RunStore and run-context keep generated live artifacts inside guarded run directories, but manifests do not yet bind target ID, upstream artifact hash, transport, adapter, fixture digest, or verifier version. |
| Other transports | No Streamable HTTP, legacy SSE, or external custom transport client exists. |

Relevant inspected code:

- [src/mcp/mcp.ts](../src/mcp/mcp.ts)
- [src/runner/record.ts](../src/runner/record.ts)
- [src/runner/policies.ts](../src/runner/policies.ts)
- [src/schema/types.ts](../src/schema/types.ts)
- [src/pipeline/verify.ts](../src/pipeline/verify.ts)
- [src/pipeline/mine.ts](../src/pipeline/mine.ts)
- [src/pipeline/evaluate.ts](../src/pipeline/evaluate.ts)
- [src/examples/filesystem/record.ts](../src/examples/filesystem/record.ts)
- [src/examples/issuetracker/record.ts](../src/examples/issuetracker/record.ts)
- [src/pipeline/run-context.ts](../src/pipeline/run-context.ts)
- [src/schema/run-manifest.ts](../src/schema/run-manifest.ts)

Engineering conclusion: adding only another McpEndpoint implementation would not be sufficient. The existing endpoint and step sink are synchronous, recorders construct target state directly, and lifecycle/snapshot ownership is outside the endpoint.

## Protocol baseline

The current MCP protocol version is 2025-11-25. The specification requires initialization and version/capability negotiation before normal operation, an initialized notification after a successful initialize response, paginated tools/list support, and distinction between tool results and protocol errors. Standard transports are stdio and Streamable HTTP. For stdio, stdout is protocol-only and stderr is the logging channel.

Primary protocol sources:

- [MCP versioning](https://modelcontextprotocol.io/docs/learn/versioning)
- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP schema reference](https://modelcontextprotocol.io/specification/2025-11-25/schema)

## Serious candidates

Four candidates passed the initial screen strongly enough to merit comparison. All are independently authored outside Oculory and open source.

### 1. MCP reference Git server

**V:** The canonical component is [modelcontextprotocol/servers/src/git at 2026.7.10](https://github.com/modelcontextprotocol/servers/tree/2026.7.10/src/git). It is published on [PyPI](https://pypi.org/project/mcp-server-git/), licensed MIT, requires Python 3.10 or later, and uses the official Python MCP SDK's stdio server. Its 12 tools cover status, three diff modes, add, reset, log, show, branch listing, branch creation, checkout, and commit.

**V:** The command accepts --repository. Current source resolves the requested repo_path and requires it to be the configured repository or a descendant. git_add separately rejects paths outside the worktree. The tool surface has no clone, fetch, pull, push, or remote-management operation.

**V:** Upstream labels this reference server early-development/beta, and the repository says reference servers are educational examples rather than production-ready solutions. That limits the eventual claim but does not negate independent implementation evidence.

**I:** A fresh repository per trial can provide bounded, meaningful, layered state. Direct filesystem hashing plus native Git inspection can verify more than the server's response text.

**S:** Hooks, filters, signing, credential helpers, global/system configuration, reflog timestamps, native-Git version differences, and same-call transient changes require a containment and determinism spike.

Primary sources:

- [Git README](https://github.com/modelcontextprotocol/servers/blob/2026.7.10/src/git/README.md)
- [Git server source](https://github.com/modelcontextprotocol/servers/blob/2026.7.10/src/git/src/mcp_server_git/server.py)
- [Git CLI entry point](https://github.com/modelcontextprotocol/servers/blob/2026.7.10/src/git/src/mcp_server_git/__init__.py)
- [Git package metadata](https://github.com/modelcontextprotocol/servers/blob/2026.7.10/src/git/pyproject.toml)
- [Git component licence](https://github.com/modelcontextprotocol/servers/blob/2026.7.10/src/git/LICENSE)
- [2026.7.10 release](https://github.com/modelcontextprotocol/servers/releases/tag/2026.7.10)
- [2026.7.10 Git ref API](https://api.github.com/repos/modelcontextprotocol/servers/git/ref/tags/2026.7.10)
- [annotated tag object API](https://api.github.com/repos/modelcontextprotocol/servers/git/tags/78193e98024b35dbc67deeddafe5dd31d23b382b)
- [peeled release commit](https://github.com/modelcontextprotocol/servers/commit/9a96ea6e5913736f92b88345bf51caeaaa8e719f)
- [PyPI trusted-publishing source commit](https://github.com/modelcontextprotocol/servers/commit/d31124c982401739917fd817c2a59db344529c16)
- [Git component history](https://github.com/modelcontextprotocol/servers/commits/main/src/git)
- [PyPI 2026.7.10 JSON](https://pypi.org/pypi/mcp-server-git/2026.7.10/json)
- [PyPI wheel provenance](https://pypi.org/integrity/mcp-server-git/2026.7.10/mcp_server_git-2026.7.10-py3-none-any.whl/provenance)
- [PyPI source-distribution provenance](https://pypi.org/integrity/mcp-server-git/2026.7.10/mcp_server_git-2026.7.10.tar.gz/provenance)
- [git_add traversal advisory](https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-vjqx-cfc4-9h6v)
- [repository-scope advisory](https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-j22h-9j4x-23w5)

### 2. MCP reference Memory server

**V:** The canonical component is [modelcontextprotocol/servers/src/memory at 2026.7.4](https://github.com/modelcontextprotocol/servers/tree/2026.7.4/src/memory). It is published as [@modelcontextprotocol/server-memory](https://www.npmjs.com/package/@modelcontextprotocol/server-memory), uses the TypeScript MCP SDK over stdio, and persists a knowledge graph in a configured JSONL file.

**V:** Nine tools create/delete entities and relations, add/delete observations, read the graph, search nodes, and open named nodes. The tagged version also exposes memory://knowledge-graph as an MCP resource with subscription and update notifications.

**V:** No credentials or remote service are required. An absolute MEMORY_FILE_PATH can point at a run-local fixture. The package handshake still reports an internal server version of 0.6.3, so the package artifact—not serverInfo alone—must anchor provenance.

**I:** Direct JSONL parsing is a clean independent state oracle, and single-file containment makes this the lowest-risk fallback.

**S:** Older published versions had reported custom-path problems. Tagged source and tests support the environment variable, but the exact 2026.7.4 artifact has not been spawned here. Serialized execution is required because the source uses load/modify/rewrite and no visible cross-call lock.

Primary sources:

- [Memory README](https://github.com/modelcontextprotocol/servers/blob/2026.7.4/src/memory/README.md)
- [Memory source](https://github.com/modelcontextprotocol/servers/blob/2026.7.4/src/memory/index.ts)
- [Memory package metadata](https://github.com/modelcontextprotocol/servers/blob/2026.7.4/src/memory/package.json)
- [Memory tests](https://github.com/modelcontextprotocol/servers/tree/2026.7.4/src/memory/__tests__)
- [2026.7.4 release](https://github.com/modelcontextprotocol/servers/releases/tag/2026.7.4)
- [2026.7.4 Git ref API](https://api.github.com/repos/modelcontextprotocol/servers/git/ref/tags/2026.7.4)
- [Memory component history](https://github.com/modelcontextprotocol/servers/commits/main/src/memory)
- [Registry metadata](https://registry.npmjs.org/@modelcontextprotocol%2Fserver-memory/2026.7.4)
- [Historic custom-path report 1018](https://github.com/modelcontextprotocol/servers/issues/1018)
- [Historic custom-path report 692](https://github.com/modelcontextprotocol/servers/issues/692)

### 3. MCP reference Filesystem server

**V:** The canonical component is [modelcontextprotocol/servers/src/filesystem at 2026.7.10](https://github.com/modelcontextprotocol/servers/tree/2026.7.10/src/filesystem). It is published as [@modelcontextprotocol/server-filesystem](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem), uses the TypeScript MCP SDK over stdio, supports command-line directory allowlists and MCP Roots, and exposes bounded read/write/list/search/move/metadata tools.

**V:** It is current, credential-free, and locally isolatable. Direct recursive file manifests provide a strong oracle.

**I:** Real transport, Roots negotiation, external error semantics, and upstream independence would add evidence.

**I:** It is not the best primary because Oculory already completed a synthetic filesystem phase. The protocol evidence is new, but much of the domain and oracle evidence would be repetitive. Metadata, atime, and legitimate atomic-write temporary files also complicate transient-state interpretation.

Primary sources:

- [Filesystem README](https://github.com/modelcontextprotocol/servers/blob/2026.7.10/src/filesystem/README.md)
- [Filesystem source](https://github.com/modelcontextprotocol/servers/blob/2026.7.10/src/filesystem/index.ts)
- [Filesystem library](https://github.com/modelcontextprotocol/servers/blob/2026.7.10/src/filesystem/lib.ts)
- [Roots utilities](https://github.com/modelcontextprotocol/servers/blob/2026.7.10/src/filesystem/roots-utils.ts)
- [Filesystem package metadata](https://github.com/modelcontextprotocol/servers/blob/2026.7.10/src/filesystem/package.json)
- [Filesystem component history](https://github.com/modelcontextprotocol/servers/commits/main/src/filesystem)
- [Registry metadata](https://registry.npmjs.org/@modelcontextprotocol%2Fserver-filesystem/2026.7.10)

### 4. Google MCP Toolbox SQLite

**V:** [googleapis/mcp-toolbox](https://github.com/googleapis/mcp-toolbox) is a maintained Apache-2.0 MCP server. Release [v1.6.0](https://github.com/googleapis/mcp-toolbox/releases/tag/v1.6.0) is pinned to commit 35c13adbbeae34089ce2a6f33232f51c1b512ceb and publishes a macOS arm64 binary with a release SHA-256.

**V:** The official SQLite launch is toolbox --prebuilt sqlite --stdio with SQLITE_DATABASE set to a local database path. The prebuilt toolset exposes execute_sql and list_tables. The server also supports Streamable HTTP, but stdio is the relevant pilot transport.

**V:** A local SQLite fixture needs no credential or remote service and can be independently queried through a different SQLite binding.

**I:** execute_sql accepts arbitrary SQL. Selecting the main database file is not a filesystem sandbox; SQLite features such as ATTACH DATABASE or VACUUM INTO may reach other paths. Model-controlled use would therefore require proven OS-level filesystem confinement, making this materially riskier than Git for the first pilot.

**I:** A two-tool arbitrary-SQL surface is broad operationally but less semantically explicit for assertion mining than Git's named state transitions.

Primary sources:

- [v1.6.0 licence](https://github.com/googleapis/mcp-toolbox/blob/v1.6.0/LICENSE)
- [SQLite MCP guide](https://github.com/googleapis/mcp-toolbox/blob/v1.6.0/docs/en/documentation/connect-to/ides/sqlite_mcp.md)
- [MCP client and stdio guide](https://github.com/googleapis/mcp-toolbox/blob/v1.6.0/docs/en/documentation/connect-to/mcp-client/_index.md)
- [SQLite prebuilt configuration](https://github.com/googleapis/mcp-toolbox/blob/v1.6.0/internal/prebuiltconfigs/tools/sqlite.yaml)
- [SQLite execute implementation](https://github.com/googleapis/mcp-toolbox/blob/v1.6.0/internal/tools/sqlite/sqliteexecutesql/sqliteexecutesql.go)
- [SQLite source implementation](https://github.com/googleapis/mcp-toolbox/blob/v1.6.0/internal/sources/sqlite/sqlite.go)
- [v1.6.0 release commit](https://github.com/googleapis/mcp-toolbox/commit/35c13adbbeae34089ce2a6f33232f51c1b512ceb)

## Initial screen-outs and rejection reasons

These were not promoted into the serious-candidate matrix:

- The original official SQLite reference server is explicitly archived in [modelcontextprotocol/servers-archived](https://github.com/modelcontextprotocol/servers-archived). A downloadable package does not overcome the maintenance failure.
- GitHub's current server requires credentials and an uncontrolled remote service for its core behavior; it violates this phase's fixture and credential constraints.
- Fetch depends on uncontrolled network content and is unsuitable for a deterministic core experiment.
- Time is genuine MCP but intentionally time-dependent, stateless, and weak for semantic state verification and regression mutations.
- Everything is a protocol test/reference fixture, not an independently meaningful domain target.
- cyanheads/git-mcp-server is current and genuine, but its 28-tool surface includes clone, fetch, pull, push, remotes, hard reset, clean, rebase, worktrees, session state, and signing. It is too broad for the first safe pilot.
- bytebase/dbhub supports local SQLite and genuine transports, but retrieved metadata did not provide a clean exact release/tag provenance chain. It cannot pass the provenance gate without a separate spike.

## Decision policy

No aggregate score is used. The following are non-compensable gates:

1. genuine MCP through a documented transport;
2. authorship and maintenance outside Oculory;
3. suitable open-source licence and unambiguous canonical source;
4. no credential or production-service dependency;
5. disposable local fixture and bounded side effects;
6. independent semantic oracle;
7. exact artifact or source pin.

Among gate-passing candidates, priority is:

1. state isolation and oracle quality;
2. determinism;
3. novel evidentiary value and mutation potential;
4. maintenance and provenance clarity;
5. implementation complexity and operational risk.

Rating scale: 5 is strongest/favorable. For implementation complexity and operational risk, 5 means lowest complexity or risk. Ratings express current evidence, not measured performance.

## Comparison matrix

| Criterion | Git 2026.7.10 | Memory 2026.7.4 | Filesystem 2026.7.10 | Toolbox SQLite v1.6.0 |
|---|---:|---:|---:|---:|
| Maintenance | 5 | 5 | 5 | 5 |
| Licence suitability | 5 | 4 | 4 | 5 |
| Real MCP transport | 5 | 5 | 5 | 5 |
| Local reproducibility | 4 | 5 | 5 | 4 |
| Credential requirements | 5 | 5 | 5 | 5 |
| State isolation | 4 | 5 | 5 | 2 |
| Oracle quality | 5 | 4 | 5 | 5 |
| Determinism | 4 | 4 | 4 | 4 |
| Mutation potential | 5 | 4 | 5 | 5 |
| Novel evidentiary value | 5 | 4 | 2 | 4 |
| Implementation complexity | 3 | 4 | 4 | 3 |
| Expected operational risk | 4 | 5 | 4 | 2 |

### Evidence behind the ratings

- **Maintenance — V:** all four have substantive 2026 changes and current releases. Git and Filesystem released 2026.7.10; Memory released 2026.7.4; Toolbox released v1.6.0 on 2026-07-01.
- **Licence — V:** Git has a component MIT licence; Toolbox is Apache-2.0. Memory and Filesystem documentation says MIT while their repository is in an MIT-to-Apache-2.0 transition and package metadata says to inspect the repository licence. Both outcomes are permissive, but notices and file-level attribution must be retained.
- **Transport — V:** each candidate has actual stdio MCP source and documented startup. This has not yet been exercised by Oculory.
- **Reproducibility — I/S:** Memory and Filesystem are straightforward Node processes once locked. Git needs an exact Python dependency lock and native-Git recording. Toolbox offers a checksummed binary but also needs a configuration and confinement layer.
- **Credentials — V:** none is needed for the proposed local mode. Runtime environments must still strip inherited credentials.
- **Isolation — V/I/S:** Git has two upstream repo-boundary checks but requires neutralized Git configuration and hooks. Memory has a single configured JSONL file. Filesystem has explicit allowed directories. Toolbox's arbitrary SQL is not a filesystem boundary.
- **Oracle — I:** Git exposes several independently inspectable state layers. Filesystem and SQLite can be checked directly. Memory's JSONL oracle is strong but closer to its own persistence representation.
- **Determinism — I/S:** all candidates need direct repeated trials. Git commit timestamps/hashes are the largest known issue, so commit is excluded initially. Memory needs ordering/concurrency checks. Filesystem and Toolbox need platform and metadata normalization.
- **Novelty — I:** Git adds a Python MCP SDK and layered version-control semantics; Memory adds graph/resource semantics; Toolbox adds a Go stack and database surface. Filesystem's semantic overlap is the largest.
- **Complexity/risk — I:** these are implementation estimates, not measurements.

### Serious-candidate disposition

- **Git:** selected because its local containment is plausible and its independently inspectable worktree/index/ref/object layers provide the strongest novel oracle and mutation surface.
- **Memory:** retained as the single fallback, not selected first because its JSONL oracle is closer to the server's persistence representation and its evidence is less layered than Git's version-control semantics.
- **Filesystem:** rejected as primary because it would add real transport evidence but too much of its semantic surface overlaps the completed synthetic filesystem target; path metadata and atomic-write temporaries also complicate transient-state interpretation.
- **Toolbox SQLite:** rejected for the first pilot because selecting a database file does not confine arbitrary SQL to that file. Proving OS-level containment for ATTACH DATABASE, VACUUM INTO, and similar behavior adds operational risk before the transport question is answered.

## Selected target: exact proposal

### Identity and pin

| Field | Proposal |
|---|---|
| Repository | https://github.com/modelcontextprotocol/servers |
| Exact component | src/git |
| Package | mcp-server-git==2026.7.10 |
| Licence | MIT |
| Release tag | 2026.7.10 |
| Annotated tag object | [78193e98024b35dbc67deeddafe5dd31d23b382b](https://api.github.com/repos/modelcontextprotocol/servers/git/tags/78193e98024b35dbc67deeddafe5dd31d23b382b) |
| Peeled release commit | [9a96ea6e5913736f92b88345bf51caeaaa8e719f](https://github.com/modelcontextprotocol/servers/commit/9a96ea6e5913736f92b88345bf51caeaaa8e719f) |
| PyPI attested workflow source commit | [d31124c982401739917fd817c2a59db344529c16](https://github.com/modelcontextprotocol/servers/commit/d31124c982401739917fd817c2a59db344529c16) |
| Wheel SHA-256 | [6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5](https://pypi.org/integrity/mcp-server-git/2026.7.10/mcp_server_git-2026.7.10-py3-none-any.whl/provenance) |
| Sdist SHA-256 | [95107b8b2989814e8c230e8e489feef4bfa4d80ca4a7ac1612cea05283ff5ea5](https://pypi.org/integrity/mcp-server-git/2026.7.10/mcp_server_git-2026.7.10.tar.gz/provenance) |
| Transport | MCP over newline-delimited stdio through the Python MCP SDK |
| Runtime | Python 3.10 or later; Click; GitPython; Python MCP SDK; Pydantic; native Git |

The release automation's tag commit and PyPI's trusted-publishing source commit are not identical. The artifact version and SHA-256 are therefore the primary executable pin; both source commits must be recorded. Gate A must compare artifact contents and generate a fully hashed transitive dependency lock before execution. The dependency declarations are lower bounds, not a hermetic lock.

### Why Git is selected

1. **Real boundary:** it exercises a genuine external process and Python MCP SDK over stdio, not another local method call.
2. **Independent behavior:** all domain behavior is authored upstream and outside Oculory.
3. **Bounded state:** --repository and git_add containment checks support a single disposable repo; there are no remote/network tools.
4. **Strong oracle:** server prose can be ignored. The verifier can inspect file bytes, index blobs, HEAD, refs, graph structure, reflogs, and object inventory.
5. **Layered semantics:** staging, resetting, branch creation, checkout, read-only inspection, missing refs, existing refs, and wrong-layer operations add evidence not covered by the three synthetic targets.
6. **Mutation value:** plausible faults include wrong repo/ref/file, omitted index changes, reset failure, stale schemas, swallowed errors, duplicate operations, and transport/adapter failures.
7. **Mac feasibility:** the inspected host is macOS 26.4.1 arm64 with Python 3.14.6, Git 2.55.0, uv 0.11.23, Node 26.4.0, and npm 11.17.0. Compatibility with this exact Python/Git combination is not yet validated.
8. **Reasonable first scope:** deterministic reads plus add/reset/create-branch/checkout can answer the research question without using commit or any remote operation.

### Qualification of the evidence value

The target is an official reference implementation maintained by the MCP project, not a production business service. It is independently authored relative to Oculory, but a successful pilot would justify only:

> Oculory operated against one pinned external official-reference MCP implementation over stdio with a deterministic local fixture and independent verification.

It would not justify broad ecosystem or production claims. If the design reviewer requires independence from the protocol project's own reference implementations, this selection is invalid and a new selection review is required; the fallback below is not a workaround for that interpretation.

## Fallback target

The single fallback is @modelcontextprotocol/server-memory@2026.7.4:

| Field | Proposal |
|---|---|
| Component | https://github.com/modelcontextprotocol/servers/tree/2026.7.4/src/memory |
| Package | @modelcontextprotocol/server-memory@2026.7.4 |
| npm gitHead / peeled tag commit | [6dd0a683e198783e30feabf7abaf42f925bd18b1](https://github.com/modelcontextprotocol/servers/commit/6dd0a683e198783e30feabf7abaf42f925bd18b1) |
| Annotated tag object | [5482a98612144854f8966bf31215f2c42c89e959](https://api.github.com/repos/modelcontextprotocol/servers/git/tags/5482a98612144854f8966bf31215f2c42c89e959) |
| npm SHA-1 | [a46611d9d1d5e6c8bb8a8fe73c4e383279a4a9aa](https://registry.npmjs.org/@modelcontextprotocol%2Fserver-memory/2026.7.4) |
| npm SRI | [sha512-D+NNzChsOHN72y58ngDmO+TzjJijGi/sSY/gBydhB3TJCcm1XQEozVWwEpruHeXt/HSkMV3Z/BpHDhdt1MLD5w==](https://registry.npmjs.org/@modelcontextprotocol%2Fserver-memory/2026.7.4) |
| Transport | MCP stdio through the TypeScript SDK |
| Fixture | one absolute run-local MEMORY_FILE_PATH JSONL file |
| Oracle | parse and canonicalize JSONL independently |

Use this fallback only if Git fails a Git-specific containment, reset, determinism, dependency, or platform gate. Do not design or implement both integrations in parallel.

## Verified facts, assumptions, and unresolved questions

### Verified

- The Git server is independently maintained outside Oculory, open source under MIT, current, published, and canonical in modelcontextprotocol/servers.
- It uses an actual MCP stdio server from the Python SDK.
- The proposed package and artifact digests exist.
- It can be configured with a repository boundary and current source validates requested paths.
- Its published tool set requires no credentials or remote service for the proposed subset.
- Oculory does not currently contain the required external MCP client path.

### Engineering assumptions

- A fixed Git seed can be recreated byte-for-byte and semantically normalized on this Mac.
- A sanitized environment can neutralize hooks, filters, signing, credential helpers, prompts, and inherited config.
- Per-step Git/file snapshots can be collected fast enough for a small pilot.
- Normalizing fixture-root paths and presentation-only Git prose will not erase meaningful behavior.
- Tool and transport errors can be classified while preserving their raw wire evidence.

### Required spikes

1. Compare the wheel contents and PyPI attestation with the tag and attested source commits.
2. Resolve and hash-lock every transitive Python dependency against one exact interpreter.
3. Confirm initialization version, capabilities, serverInfo, tool list, schemas, and error encoding from the pinned artifact.
4. Confirm --repository and git_add containment against sibling paths, symlinks, hooks, and hostile Git config.
5. Create the seed 20 times and prove identical normalized snapshots and cleanup.
6. Repeat direct calls and prove stable normalized results on macOS arm64.
7. Determine whether stderr is bounded and stdout remains protocol-only.
8. Determine whether errors arrive as isError results or JSON-RPC errors, and define stable codes without trusting message prose.
9. Decide whether external trace evidence fits an explicit sidecar or requires a deliberate schema-version bump. Silent overloading is forbidden.
10. Establish the exact supported Python patch and native-Git baseline. The installed Python 3.14.6 merely exceeds the declared minimum; it is not proof of compatibility.

## Selection invalidation conditions

Kill or return to selection review if any of the following is true:

- the package artifact cannot be tied cleanly to documented source and a hash-locked environment;
- the component is abandoned, yanked, newly affected by an applicable unresolved advisory, or becomes legally unsuitable;
- it is not a genuine MCP stdio implementation when directly inspected;
- hooks, global/system Git configuration, filters, signing, prompts, credential helpers, or network cannot be reliably neutralized;
- the process or a tool can escape the run-local repository boundary;
- fixture reset is nondeterministic or cleanup cannot prove absence of residue;
- normalized results differ irreducibly across repeated cold-start trials;
- errors cannot be separated from crashes, malformed responses, and transport failures;
- the independent oracle depends on trusting the server's own result;
- meaningful coverage requires git_commit before timestamp/hash determinism is solved;
- integration requires weakening Oculory's verifier semantics;
- there are no meaningful controlled regressions;
- the evidence value proves little beyond the completed filesystem target;
- supporting the target requires an unrelated Phase 1–5 refactor;
- the reviewer decides an official reference server is insufficiently independent for the research question.

## Final recommendation

Approve mcp-server-git==2026.7.10 for a **scripted-first, stdio-only, disposable-fixture design spike**, subject to docs/32. Do not install or integrate it until this selection and validation plan are reviewed. Do not run model traffic unless Gates A–E later pass and the user separately authorizes a budgeted live phase.
