# Phase 9 Oculory v0.1 MLP release candidate

This document marks the implemented v0.1 minimum lovable product surface for independent audit. It is a pre-release candidate built from source. It is not an npm publication, GitHub release, tag, production-readiness claim, or security certification.

## Public product loop

The primary workflow is:

```sh
oculory record ./task.yaml
oculory approve <run-id>
oculory replay --model <profile>
```

`record` captures an agent claim, an attributable MCP tool result when available, and independently observed state. `approve` drafts readable YAML from one reviewed run without invoking the statistical miner or inferring stability. `replay` resets the disposable target before every attempt, reports the exact pass ratio, and keeps behavioral violations, indeterminate evaluations, and infrastructure failures distinct.

The supporting public commands are `oculory demo`, `oculory show <run-id> --diff`, `oculory doctor`, `oculory --version`, and `oculory --help`. Earlier research and mining commands remain available in the advanced help group for compatibility.

## Implemented boundaries

- Task and contract files use strict versioned YAML schemas and literal argv arrays.
- Agent and MCP environments use separate explicit variable-name allowlists.
- Git and filesystem observation is bound to the disposable task workspace and declared watch scope.
- Postgres observation and replay use a generated disposable schema copied from an allowlisted source.
- GitHub observation is limited to configured resources, fields, pagination, bytes, and timeouts.
- Public run evidence is append-only after finalization and covered by a complete checksum manifest.
- Missing or ambiguous witnesses remain unavailable rather than being rendered as certainty.
- Reset, snapshot, process, adapter, or cleanup failure invalidates the run as infrastructure failure.

## Provider-free acceptance path

The bundled demo runs the real public loop with a scripted agent, toy MCP server, and disposable Git fixture. It requires no API key or network connection. The clean profile passes 12/12. The deliberately changed profile passes 3/12 and exits with behavioral-violation code 2 while the renderer contrasts the agent claim, tool result, and independently observed state.

The local package acceptance harness builds a tarball, installs it globally in a temporary path containing spaces, runs version, doctor, adapter-export, shim, and demo checks, scans the tarball allowlist and denylist, and verifies zero project residue. The composite Action builds before invoking the production configuration and adapter preflights. After preflight, replay receives task-declared environment values plus a fixed non-secret runtime set, while home, configuration, and temporary paths are replaced with Action-owned directories. The Action bounds stdout and stderr to 4 MiB each, persists a machine-readable report, uploads nothing, and propagates behavioral violations as failed steps.

## Audit entry points

- [First 30 minutes](48_FIRST_30_MINUTES.md)
- [Contract reference](49_V0_1_CONTRACT_REFERENCE.md)
- [Adapter reference](50_V0_1_ADAPTER_REFERENCE.md)
- [Distribution namespace decision](47_DISTRIBUTION_NAMESPACE_DECISION.md)
- [Task example](../examples/v0.1/task.yaml)
- [Contract example](../examples/v0.1/contract.yaml)
- [GitHub Action example](../examples/v0.1/github-action.yml)

An independent audit should rerun the complete local and hosted validation matrix at the exact draft PR head, compare the protected-evidence manifest with the Phase 9 baseline, inspect the package contents, and verify both Action exit paths. The draft must remain unmerged and unreleased until that audit is complete.

## Current limitations

The unscoped npm name `oculory` is already owned by another registry account, so publication requires the explicit distribution decision recorded in docs/47. Local-tarball installation is the only distribution claim for this candidate. Real-model reliability, production Postgres behavior, production GitHub behavior, usability, adoption, retention, demand, willingness to pay, and production readiness have not been established.

Public MLP execution currently supports macOS and Linux. Native Windows execution fails closed before disposable workspace setup or any agent, MCP, or workspace child process is spawned because Node child-process liveness and `taskkill /T` do not prove that every descendant is absent after a clean parent exit. A Job Object or equivalent bounded tree-lifecycle mechanism is required before Windows can be claimed.
