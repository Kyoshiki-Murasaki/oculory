# Oculory

Oculory records what your agent actually did to the real world, turns that into an editable contract, and replays it in CI so a model, prompt, or server update cannot silently change the agent's behavior.

## The contradiction Oculory catches

A failed replay keeps the agent claim, tool result, and independently observed state separate:

```text
✗ CONTRACT VIOLATED: create-feature-branch

  Agent said:      "Created branch and committed changes ✓"
  Tool returned:   success
  Actual state:    branch created from wrong base (main, expected develop)
                   2 files staged, never committed

  Replay results:
    claude-previous   PASS  (12/12 runs)
    claude-latest     FAIL  (3/12 runs passed; threshold 10)

  → Diff: oculory show run_0142 --diff
```

Fluent prose is not evidence. A successful tool response is not evidence. Independently observed target state is authoritative. Missing or ambiguous witnesses are reported as unavailable rather than inferred.

## Installation candidate

This repository is not published to npm. Install the local release-candidate tarball:

```sh
npm ci
npm run build
npm pack
npm install -g ./oculory-0.1.0.tgz
oculory --version
oculory doctor
```

Node.js 22.13 or later and Git are required. The distribution namespace remains blocked on the owner decision in [docs/47_DISTRIBUTION_NAMESPACE_DECISION.md](docs/47_DISTRIBUTION_NAMESPACE_DECISION.md).

## Run the provider-free demo

```sh
oculory demo
```

The demo uses a bundled scripted agent, toy MCP server, and disposable Git fixture. It requires no API key, account, configuration, or network access. Package acceptance runs it from a global installation in a path containing spaces and requires complete cleanup.

The demo ends with:

```text
Try it on your own task:
  oculory record ./task.yaml
```

## The three-command loop

```sh
oculory record ./task.yaml
oculory approve run_0001
oculory replay --model baseline
```

`record` captures the agent claim, MCP request and response evidence, and independently observed before/after state. `approve` drafts a Git-trackable YAML contract from one run without invoking the statistical miner. `replay` resets the target for every attempt and applies the contract threshold.

## Task YAML

Public agent profiles launch user-selected executables through literal argv arrays. Oculory does not call a model SDK on this path.

```yaml
version: oculory-task-v1
task_id: create-feature-branch
prompt: Create feature/demo from develop and commit the requested files.

agent_profiles:
  baseline:
    argv:
      - my-agent
      - --prompt-file
      - "{prompt_file}"
      - --mcp-config
      - "{mcp_config}"
      - --workspace
      - "{workspace}"
    env_allowlist: [PATH]
    model: scripted-baseline

mcp_server:
  command: task-mcp-server
  arguments: [--workspace, "{workspace}"]
  env_allowlist: [PATH]

workspace:
  strategy: git-worktree
  repository: .
  base_ref: develop

targets:
  - id: repository
    adapter: git-filesystem
    configuration:
      mode: git
      baseRefs: [develop]
    watch:
      branches: [develop, feature/demo]
      paths: [src, test]

claim_extraction:
  type: line-prefix
  prefix: "CLAIM: "
```

See [examples/v0.1/task.yaml](examples/v0.1/task.yaml) and [the architecture reference](docs/46_V0_1_MLP_ARCHITECTURE.md).

## Contract YAML

Contracts assert outcomes rather than a required tool path:

```yaml
version: oculory-contract-v1
task: create-feature-branch
tolerance:
  runs: 12
  min_pass: 10
assertions:
  - id: feature-branch-created
    target: repository
    selector: { kind: branch, branch: feature/demo }
    operator: exists
    expected: true
    evaluation: exact

  - id: branch-starts-at-develop
    target: repository
    selector: { kind: branch_base, branch: feature/demo }
    operator: equals
    expected: develop
    evaluation: exact

  - id: no-staged-files
    target: repository
    selector: { kind: staged_files }
    operator: none
    expected: null
    evaluation: exact
```

See [docs/49_V0_1_CONTRACT_REFERENCE.md](docs/49_V0_1_CONTRACT_REFERENCE.md).

## Nondeterminism is explicit

The default contract requests 12 attempts and requires 10 behavioral passes. Every replay reports requested, completed, behaviorally passed, behaviorally failed, infrastructure-failed, indeterminate, and required threshold counts. Infrastructure failures and indeterminate attempts never count as passes.

## GitHub Action

Phase 9 v0.1 release-candidate pin (awaiting independent audit):

```yaml
- uses: Kyoshiki-Murasaki/oculory@5e4362ced3432be524a3dbd4bbec6eb5e4e8d2bb
  with:
    task: fixtures/demo/task.yaml
    contract: fixtures/demo/contract.yaml
    model: baseline
```

Repository CI continues to use `./` so it tests the pull request source. No tag or independent-audit result is claimed. The Action builds its pinned source in an isolated npm environment, then uses the production task, contract, adapter, and assertion preflights before allocating reports. Replay inherits task-declared environment values plus a fixed non-secret runtime set, while home, configuration, and temporary paths are replaced with Action-owned directories. It captures at most 4 MiB from each terminal stream, forwards the captured stdout and stderr unchanged, preserves behavioral exit status `2` as a failed step, and exposes `report-path` without uploading anything automatically. See [examples/v0.1/github-action.yml](examples/v0.1/github-action.yml).

## Privacy and local-first behavior

Run evidence stays local by default. The Action uploads nothing, Oculory sends no telemetry, and public commands do not contact a model provider directly. Task files name executables and explicit environment-variable allowlists; credential values are neither printed nor persisted in run artifacts.

Raw evidence roots under `.oculory/runs-live`, `.oculory/runs-external`, and `.oculory/runs-model` are protected and excluded from the npm package. Do not attach private evidence to issues or pull requests.

## Limitations and pre-release status

This is a v0.1 release candidate awaiting independent audit. It is not an npm publication, production-readiness claim, security certification, MCP conformance claim, or validation of real-model reliability. Public MLP execution currently supports macOS and Linux; native Windows execution fails closed before starting any workspace, agent, or MCP child because descendant-process cleanup cannot yet be proven with a Job Object or equivalent mechanism. Postgres is exercised only against a disposable local or CI service. GitHub API behavior is exercised only against a local mock server. Third-party adapter authoring is versioned but not yet polished.

No adoption, usability, retention, demand, or willingness-to-pay result is claimed.

## First 30 minutes

Follow [docs/48_FIRST_30_MINUTES.md](docs/48_FIRST_30_MINUTES.md) for the provider-free walkthrough. The contract and adapter references are [docs/49_V0_1_CONTRACT_REFERENCE.md](docs/49_V0_1_CONTRACT_REFERENCE.md) and [docs/50_V0_1_ADAPTER_REFERENCE.md](docs/50_V0_1_ADAPTER_REFERENCE.md).

## Contributor validation

[![CI](https://github.com/Kyoshiki-Murasaki/oculory/actions/workflows/ci.yml/badge.svg)](https://github.com/Kyoshiki-Murasaki/oculory/actions/workflows/ci.yml)

Use the lockfile and run the complete local checks:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run test:gate-f0
npm run validate:gate-f-authorization
npm run validate:phase6-evidence-index
npm run experiment
npm run experiment:filesystem
npm run experiment:issue-tracker
npm run verify:action
npm run verify:package
```

`npm run verify:package` creates a temporary tarball, enforces the package allowlist and denylist, scans for private paths and credential-shaped content, installs globally under a temporary prefix containing spaces, runs version, doctor, and demo, and removes the temporary root. It never publishes.

## Prior deterministic evidence

Oculory retains the prior research and mining engine as an internal/advanced surface. It includes deterministic local task, filesystem, and issue-tracker targets plus audited evidence against one pinned external Git MCP implementation. That history does not authorize real provider traffic or broaden v0.1 claims.

See:

- [current project status](docs/30_PROJECT_STATUS_AND_NEXT_STEPS.md)
- [Phase 6 evidence index](docs/evidence/phase6-external-git-evidence-index-v1.json)
- [Gate F0 offline record](docs/43_GATE_F0_OFFLINE_PREPARATION_AND_VALIDATION.md)
- [Phase 7 public engineering readiness](docs/44_PHASE7_PUBLIC_ENGINEERING_READINESS.md)
- [Phase 8 provider-free external-developer pilot](docs/45_PHASE8_OFFLINE_EXTERNAL_DEVELOPER_PILOT.md)

For contribution and evidence-protection rules, see [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
