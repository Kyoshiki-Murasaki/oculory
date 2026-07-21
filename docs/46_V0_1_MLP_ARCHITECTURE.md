# Oculory v0.1 MLP Architecture

This document defines the public configuration and runtime boundary for the v0.1 minimum lovable product. The implemented surface includes the task and contract loaders, `record`, deterministic `approve`, thresholded `replay`, the three built-in adapters, saved-run rendering, and the provider-free demo.

## Product boundary

Oculory records an agent executable chosen by the user. Public configuration never names a model SDK or provider credential. An agent profile is a literal argv array, an explicit environment-variable allowlist, and an optional model label. The supported substitutions are limited to:

```text
{prompt}
{prompt_file}
{mcp_config}
{workspace}
{model}
{run_id}
```

Each substitution occupies part or all of one argv entry. It is never interpolated into a shell string. The MCP server uses the same process boundary: one executable in `command`, literal entries in `arguments`, and an explicit environment allowlist.

## Task configuration

`schemas/task.schema.json` defines `oculory-task-v1`:

- `task_id` is the stable public identifier.
- `prompt` is the instruction supplied to the selected profile.
- `agent_profiles` maps user-selected labels to provider-neutral argv configurations.
- `mcp_server` describes the upstream MCP executable.
- `workspace` selects either an isolated Git worktree or explicit setup, reset, and cleanup argv arrays.
- `targets` names versioned adapters, their configuration, and an explicit watch scope.
- `claim_extraction` selects one bounded built-in extractor. Its default is the final non-empty stdout segment.

The safe extractors are `stdout-final`, `json-field`, `line-prefix`, `regex`, and `output-file`. Regex input and pattern sizes are bounded. Output files must resolve inside the disposable workspace. No extractor executes user code.

The `configuration` and `watch` objects are deliberately adapter-specific. The outer target object is strict, while each adapter validates its own inner vocabulary before preparation. A non-empty watch scope is required because later approval and replay must only describe independently observed facts inside a declared boundary.

## Contract configuration

`schemas/contract.schema.json` defines `oculory-contract-v1`. A contract refers to one task and contains assertions with unique IDs. Each assertion names a target, an adapter-specific selector, an operator, an expected JSON value, and an evaluation mode.

The complete public operator vocabulary is:

```text
exists
equals
count
unchanged
none
subset
```

Every assertion supports the evaluation modes `exact`, `subset`, and `ignore`. Adapters may reject combinations they cannot evaluate, but they do not redefine an operator's meaning. Ignored assertions remain visible and do not count toward behavioral passage.

The operator semantics are uniform across built-in adapters:

| Operator | Exact evaluation |
| --- | --- |
| `exists` | Pass when the selector resolves to an observation. An expected value of `false` inverts the check. |
| `equals` | Pass when the observed JSON value equals `expected`. |
| `count` | Pass when an observed array's length, or an observed numeric count, equals the numeric `expected` value. |
| `unchanged` | Pass when the selected before and after observations are equal. |
| `none` | Pass when the observation is absent, false, or an empty array. |
| `subset` | Pass when every expected object field or array member is present in the observation, recursively. |

`subset` evaluation widens `equals` to structural containment and `count` to at least the expected count. It does not change the other operators. `ignore` records the assertion but skips its behavioral evaluation.

Tolerance defaults to 12 requested runs with 10 required behavioral passes. A configured threshold is invalid when either number is not positive or `min_pass` exceeds `runs`.

## Loading and preservation

`src/mlp/config.ts` uses the maintained `yaml` package and `parseDocument`. It returns both a validated value and the parsed YAML document:

```ts
const loaded = loadContractConfig(path);
loaded.value;
loaded.document;
```

Keeping the document retains comments and source formatting for an explicit editing workflow. Defaults are added only to `value`; the retained document is not mutated. Loaders only read files. In particular, replay consumers must never rewrite a contract as a side effect of loading or validation.

Validation rejects unknown versions and fields, duplicate target or assertion IDs, invalid thresholds, YAML aliases, non-JSON values, excessive nesting or collection sizes, unsafe path traversal, shell syntax, malformed placeholders, unknown placeholders, credential-bearing argv flags, credential-shaped YAML content, and secret values mistakenly placed where an environment variable name is required. Errors include bounded field paths and messages; config values are not dumped.

## Witness and adapter boundaries

The runtime preserves three independent witnesses:

1. `agent_claim`: bounded prose extracted from agent output.
2. `tool_result`: the attributable MCP response, when attribution is unique.
3. `observed_state`: before and after snapshots read independently through target adapters.

Only observed state authoritatively proves an external outcome. Missing claims or ambiguous tool attribution remain explicitly unavailable. A successful tool result is not collapsed into proof of state.

Adapters receive the target `configuration` and `watch` values after schema validation. Their versioned interface owns preparation, snapshots, normalization, diffing, assertion evaluation, reset, cleanup, violation descriptions, and redaction. Existing MCP stdio, trace, snapshot, and verifier code should be adapted behind these public boundaries rather than duplicated.

## Security limits

Task and contract files are data, never programs. Processes launch with argv arrays and allowlisted environments. Oculory owns an in-process broker that launches the upstream MCP server with only its allowlisted environment. The agent receives a temporary MCP configuration for a credential-free local relay, while request, response, process, and cleanup evidence remains in parent memory until it is redacted and persisted. Configuration files, arguments, extraction buffers, regular expressions, object depth, and collection sizes have explicit caps. Absolute paths and `..` traversal are rejected for workspace-confined values.

Every configured subprocess has bounded output, timeouts, process-group termination, and liveness proof. A `git-worktree` task creates its worktree from a private bare clone so branch and tag writes cannot alter the configured source repository. Command workspaces run setup, reset, and cleanup through the same bounded process runner. Adapters enforce pagination, row, file, response, and command limits appropriate to their target. Unverified reset, snapshot, or cleanup is classified as infrastructure failure and never as a behavioral pass.
