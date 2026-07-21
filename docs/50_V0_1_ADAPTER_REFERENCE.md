# Oculory v0.1 adapter reference

Adapters independently observe state before and after the agent runs. A task names an adapter in each target, supplies a bounded configuration, and declares a non-empty `watch` scope. Contract assertions select values only from that observed state.

The built-in registry exports three adapter IDs: `git-filesystem`, `postgres`, and `github-api`. Applications embedding Oculory can import the public registry from `oculory/adapters` after installing a package built from this release candidate.

## Shared assertion behavior

All adapters use the six operators and three evaluation modes documented in [the contract reference](49_V0_1_CONTRACT_REFERENCE.md). A selector chooses a JSON-compatible value. The operator compares that value uniformly; adapters do not redefine operator semantics.

Unknown adapter configuration fields are rejected. Secret-shaped values are redacted from persisted adapter evidence. Limits are enforced before an unbounded snapshot can be accepted.

## Git and filesystem

Adapter ID: `git-filesystem`

This adapter can observe either a Git repository or a bounded filesystem tree. The task runner always binds it to the resolved disposable task workspace, observes that workspace in place, and derives its effective paths and branches from `watch.paths` and `watch.branches`. Task YAML cannot override those runtime-owned values.

An embedding application that invokes the adapter lifecycle directly must provide the same resolved directory as both the adapter source and `AdapterPrepareContext.workspaceRoot`; in-place preparation fails closed when they differ. That embedding-only authority is not accepted from task YAML.

```yaml
targets:
  - id: repository
    adapter: git-filesystem
    configuration:
      mode: git
      baseRefs:
        - develop
      maxFiles: 4096
      maxFileBytes: 8388608
      maxTotalBytes: 67108864
      maxCommits: 4096
      commandTimeoutMs: 10000
    watch:
      branches:
        - develop
        - feature/demo
      paths:
        - src
        - test
```

Configuration fields:

| Field | Meaning |
| --- | --- |
| `mode` | `git` (default) or `filesystem` |
| `baseRefs` | Git refs whose ancestry may be compared; Git mode only |
| `maxFiles` | File count cap, default 4096, maximum 20000 |
| `maxFileBytes` | Per-file byte cap, default 8 MiB, maximum 64 MiB |
| `maxTotalBytes` | Total snapshot byte cap, default 64 MiB, maximum 512 MiB |
| `maxCommits` | Commit graph cap, default 4096, maximum 20000 |
| `commandTimeoutMs` | Git command timeout, default 10000, range 100-60000 |

Selectors:

| `selector.kind` | Additional fields | Observed value |
| --- | --- | --- |
| `branch` | `branch` | Object ID for the branch, or `null` |
| `branch_base` | `branch` | Closest configured base ref reachable from the branch |
| `current_branch` | none | Current branch name, or `null` |
| `commit_count` | optional `ref` | Reachable commit count; `ref` defaults to `HEAD` |
| `commit_ancestry` | `ancestor`, `descendant` | Whether the first ref is reachable from the second |
| `staged_files` | none | Sorted staged path list |
| `unstaged_files` | none | Sorted unstaged path list |
| `untracked_files` | none | Sorted untracked path list |
| `file` | `path` | File metadata object, or `null` |
| `file_digest` | `path` | SHA-256 digest, or `null` |
| `directory_tree` | optional `path` | Sorted paths at and below the relative path |
| `path_count` | optional `path` | Count of paths at and below the relative path |
| `clean_tree` | none | Whether Git reports no staged, unstaged, or untracked files |

Every `baseRefs` entry must also appear in `watch.branches`. Public snapshots contain only declared branch refs, their bounded reachable commit graph, and Git status entries below `watch.paths`; reset keeps a separate private baseline of every local branch so out-of-scope mutations are still removed without entering evidence. Paths are relative and cannot traverse outside the configured source. A symbolic-link target that is absolute, contains parent traversal, or has a secret-shaped name is replaced with a fixed sentinel before its byte length and digest are recorded; Oculory never follows the link while taking a snapshot. Git refs are validated before they are passed as arguments to Git.

## Postgres

Adapter ID: `postgres`

The Postgres adapter reads only an allowlisted source schema, copies its allowlisted columns into a fresh `oculory_<random>` schema, and observes the disposable copy. Oculory routes the upstream MCP server to that schema through a parent-owned runtime `search_path`; the connection environment name must be allowlisted for that server and is rejected from every agent profile. Reset drops and recreates that schema. Cleanup drops it and verifies that it is absent.

```yaml
targets:
  - id: database
    adapter: postgres
    configuration:
      connectionEnv: OCULORY_TEST_POSTGRES_URL
      sourceSchema: public
      tables:
        - name: tasks
          columns: [id, status, title]
          orderBy: [id]
      rowLimit: 500
      queryTimeoutMs: 5000
    watch:
      tables: [tasks]
```

`connectionEnv` names an environment variable; the connection string is never stored in the task. At runtime Oculory narrows `configuration.tables` to `watch.tables` and rejects a watched table that has no configured column allowlist. `sourceSchema`, table names, column names, and ordering columns use bounded SQL identifiers. Every `orderBy` column must also appear in that table's column allowlist. `rowLimit` defaults to 500 and is capped at 5000. Before selected rows reach the Node.js process, Postgres computes their server-side JSON byte size and rejects a source or snapshot whose combined selected rows exceed 16 MiB. Snapshot reads use a repeatable-read transaction, and normalized rows receive a canonical bytewise order so ties in `orderBy` cannot change exact or unchanged results. `queryTimeoutMs` defaults to 5000 and is bounded from 100 to 30000.

Selectors:

| `selector.kind` | Additional fields | Observed value |
| --- | --- | --- |
| `table` | `table` | `{ name }` when the table exists, otherwise `null` |
| `row_count` | `table`, optional `where` | Count of matching rows |
| `rows` | `table`, optional `where`, optional `columns` | Matching rows limited to selected allowlisted columns |
| `unexpected_rows` | Same as `rows` | Matching rows, useful with `none` |
| `cell` | `table`, `column`, optional `where` | Cell value when exactly one row matches; zero or multiple matches make evaluation indeterminate |
| `columns` | `table`, optional `columns` | Observed column metadata |

An optional selector `schema` may name the logical configured source schema. It cannot select another schema. `where` performs exact equality only against already-snapshotted allowlisted columns; it is not a SQL expression.

## GitHub API

Adapter ID: `github-api`

The GitHub adapter is scoped to explicitly listed issues, pull requests, and branches. It supports GitHub Enterprise-compatible base URLs and a local mock server. Read-only mode is the default. Restore mode is an explicit opt-in and, for a non-loopback server, requires a named token environment variable.

```yaml
targets:
  - id: github
    adapter: github-api
    configuration:
      owner: octo-org
      repository: demo-repository
      apiBaseUrl: http://127.0.0.1:8080
      tokenEnv: null
      issueNumbers: [17]
      pullRequestNumbers: [23]
      branchNames: [main]
      issueFields: [title, state, labels]
      pullRequestFields: [title, state, draft, labels]
      branchProtectionFields: [required_status_checks]
      commentMode: digest
      resetMode: read-only
      pageSize: 50
      maxPages: 10
      maxItems: 500
      requestTimeoutMs: 5000
      maxResponseBytes: 2097152
    watch:
      issues: [17]
      pullRequests: [23]
      branches: [main]
```

At least one issue, pull request, or branch must be listed. The runtime replaces the configured resource arrays with the corresponding `watch` arrays and rejects any watched resource outside the configuration allowlist. `commentMode` is `none`, `body`, or `digest`; digest mode records comment hashes rather than bodies. In `none` mode, the adapter retains only comment IDs for deterministic counting and neither retains nor hashes bodies. `resetMode` is `read-only` or `restore`. Restore mode cannot reconstruct issue or pull-request comments from digests, so digest mode is rejected for a restore scope containing either resource type. `none` can verify an unchanged comment count but cannot restore a changed count; use `body` when comment restoration is required. Read-only observation supports all listed fields. Restore mode rejects issue `locked` and pull-request `draft`, `merged`, and `head` because the implemented REST reset cannot safely reconstruct them. Network requests have bounded pages, items, response bytes, and timeouts.

Allowed resource fields are intentionally fixed:

- Issues: `title`, `state`, `body`, `locked`, `labels`
- Pull requests: `title`, `state`, `body`, `draft`, `merged`, `base`, `head`, `labels`
- Branch protection: `required_status_checks`, `enforce_admins`, `required_pull_request_reviews`, `restrictions`, `required_linear_history`, `allow_force_pushes`, `allow_deletions`, `required_conversation_resolution`, `block_creations`, `lock_branch`, `allow_fork_syncing`

Selectors:

| `selector.kind` | Additional fields | Observed value |
| --- | --- | --- |
| `issue` | `number` | Selected issue object, or `null` |
| `issue_field` | `number`, `field` | One selected issue field |
| `issue_labels` | `number` | Sorted label list |
| `issue_comment_count` | `number` | Comment count |
| `issue_comments` | `number` | Comment bodies or digests according to `commentMode` |
| `pull_request` | `number` | Selected pull request object, or `null` |
| `pull_request_field` | `number`, `field` | One selected pull request field |
| `pull_request_labels` | `number` | Sorted label list |
| `pull_request_comment_count` | `number` | Comment count |
| `pull_request_comments` | `number` | Comment bodies or digests according to `commentMode` |
| `branch` | `branch` | Branch name and SHA, or `null` |
| `branch_field` | `branch`, `field` | `sha` or `protected` |
| `branch_protection` | `branch` | Selected branch-protection object |
| `branch_protection_field` | `branch`, `field` | One configured protection field |

Only configured resources and fields are captured. A token value is read from the explicitly named environment variable at request time and is rejected from both agent and MCP-server environment allowlists. The outbound request boundary removes an exact token value echoed by a response before parsed data can leave that boundary; restore mode rejects such a response. The token is never written into configuration or reports. HTTP 403 primary limits and HTTP 429 secondary limits are classified as rate limits. Rate limits, timeouts, HTTP failures, and malformed or oversized responses are infrastructure failures, not behavioral violations.

## Isolation and cleanup

- Git/filesystem is bound to the resolved disposable task workspace. Public task configuration cannot redirect its source or widen its effective branch or path scope.
- Postgres operates only on a newly generated disposable schema and refuses reset or cleanup operations on any schema outside the `oculory_<24 hex characters>` namespace.
- GitHub defaults to read-only verification. Mutation and restoration require `resetMode: restore` and the exact configured resource scope.

Adapter cleanup failure makes the run infrastructurally invalid. It is never converted into a behavioral pass.
