# Oculory v0.1 contract reference

Oculory v0.1 contracts are readable YAML files validated as `oculory-contract-v1`. They describe observable outcomes, not a required sequence of tool calls.

## Complete shape

```yaml
version: oculory-contract-v1
task: create-feature-branch
tolerance:
  runs: 12
  min_pass: 10
assertions:
  - id: feature-branch-exists
    target: repository
    selector:
      kind: branch
      branch: feature/checkout
    operator: exists
    expected: true
    evaluation: exact

  - id: feature-branch-base
    target: repository
    selector:
      kind: branch_base
      branch: feature/checkout
    operator: equals
    expected: develop
    evaluation: exact

  - id: no-staged-files
    target: repository
    selector:
      kind: staged_files
    operator: none
    expected: null
    evaluation: exact
```

`version`, `task`, and `assertions` are required. `tolerance` is optional and receives the default below. Unknown top-level fields and unknown versions are rejected.

## Tolerance

`runs` is the number of replay attempts requested. `min_pass` is the minimum number of behaviorally passing attempts required for the contract to pass.

The default is:

```yaml
tolerance:
  runs: 12
  min_pass: 10
```

`min_pass` must be positive and cannot exceed `runs`. Infrastructure-failed and indeterminate attempts never count as behavioral passes. Replay fails closed when the requested threshold cannot still be established.

## Assertions

Every assertion contains:

| Field | Meaning |
| --- | --- |
| `id` | Unique stable identifier within the contract |
| `target` | Target ID declared in the task |
| `selector` | Adapter-specific description of the observed value |
| `operator` | One of the six public operators below |
| `expected` | Expected JSON-compatible value; the field is required even when the value is `null` |
| `evaluation` | `exact`, `subset`, or `ignore` |

Duplicate assertion IDs are rejected.

## Operators

The public operator vocabulary is fixed for v0.1:

| Operator | Uniform meaning |
| --- | --- |
| `exists` | Pass when the selected after-state value exists. Set `expected: false` to require absence. |
| `equals` | Compare the selected after-state value with `expected`. In subset evaluation, require only the expected members or fields. |
| `count` | Compare an observed number or array length with `expected`. In subset evaluation, the observed count may be greater. |
| `unchanged` | Require the selected before-state and after-state values to be equal. |
| `none` | Require `null`, `false`, or an empty array after execution. |
| `subset` | Require every expected scalar, object field, or array member to appear in the observed value. |

Adapters choose what a selector observes, but they do not redefine these operator semantics.

## Evaluation modes

- `exact` uses exact deterministic equality where the operator compares values.
- `subset` allows additional observed object fields, array members, or counts where supported.
- `ignore` records the assertion in the report but excludes it from pass/fail evaluation.

An ignored assertion should explain a known volatile or ambiguous observation in a nearby YAML comment. Deterministic approval omits those observations; if a reviewer adds one back as ignored, replay never treats it as evidence of success.

## Selector ownership

Selectors belong to adapters. The Git/filesystem adapter, for example, supports `branch`, `branch_base`, `current_branch`, `commit_count`, `commit_ancestry`, `staged_files`, `unstaged_files`, `untracked_files`, `file`, `file_digest`, `directory_tree`, `path_count`, and `clean_tree`.

See [the adapter reference](50_V0_1_ADAPTER_REFERENCE.md) for built-in selector fields and configuration boundaries.

## Drafting and replay

`oculory approve <run-id>` drafts one contract from one recorded before/after state diff. It does not invoke the statistical miner and does not infer stability from one run. Review and edit the YAML before replay.

Replay reads the contract without rewriting it:

```sh
oculory replay --task ./task.yaml --contract ./oculory.contracts/create-feature-branch.yaml --model baseline
```

When replay displays results from previously tested profiles, it reuses a saved result only if the contract, non-profile task boundary, adapter versions, and that profile's exact definition fingerprint still match. Adding another profile does not invalidate results for unchanged profiles. Changing a profile's argv, model, or environment allowlist invalidates the saved result for that profile.

Exit status `0` means the threshold passed. Status `2` means a behavioral contract violation. Status `1` means usage or configuration error. Status `3` means infrastructure or internal failure.

## Validation and safety

Contracts reject unsafe path traversal, shell command strings where argv arrays are required, unknown fields, duplicate IDs, invalid thresholds, unsupported operators, and unsupported evaluation modes. Errors are bounded and identify the configuration field without dumping payloads, credentials, or private paths.
