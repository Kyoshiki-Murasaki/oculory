# Oculory provider-free external-developer pilot

This directory contains the local-first Phase 8 pilot kit. It prepares a controlled engineering-usability exercise for three to five external developers; it does not recruit anyone, run a human session, authorize Gate F1/F2, or contact a model provider.

## Participant profile

The intended participant understands Git and command-line workflows, has basic familiarity with MCP servers, did not implement Oculory, can run Node.js 22.13 or Node.js 24, can start a local stdio MCP server, and can spend about 60–90 minutes. The exercise measures Oculory's workflow, not programming skill.

## Repository-only command surface

The pilot is deliberately repository-only. It is not added to the installed `oculory` CLI and is excluded from the npm tarball.

```text
npm run pilot:doctor
npm run pilot:run
npm run pilot:verify-report -- --report <outside-repository-output>/pilot-report.json
npm run pilot:smoke
```

Use `--json` with `pilot:doctor` for machine-readable output. `pilot:run` and `pilot:smoke` accept `--python`, `--target`, and `--git` when the pinned runtime is not on `PATH`. `pilot:run` accepts `--output`; it refuses output anywhere inside the current repository, `.git`, or the three protected evidence roots.

## Pinned target prerequisite

The pilot uses CPython 3.12.13 and `mcp-server-git==2026.7.10`. All 33 behavior dependencies must match `constraints.git-mcp-2026.7.10-py312.txt`; a standard virtual environment may additionally contain only `pip`, `setuptools`, or `wheel`. Doctor independently verifies the target distribution, installed server-source digest, console entry point, Python patch version, Git executable, and dependency versions.

On a Unix-like host, create a disposable environment outside the repository:

```sh
python3.12 -m venv "<temporary-directory>/oculory pilot target"
"<temporary-directory>/oculory pilot target/bin/python" -m pip install \
  --disable-pip-version-check --no-input --only-binary=:all: \
  --constraint pilot/constraints.git-mcp-2026.7.10-py312.txt \
  "mcp-server-git==2026.7.10"
export PATH="<temporary-directory>/oculory pilot target/bin:$PATH"
```

On Windows PowerShell:

```powershell
py -3.12 -m venv "$env:TEMP\oculory pilot target"
& "$env:TEMP\oculory pilot target\Scripts\python.exe" -m pip install `
  --disable-pip-version-check --no-input --only-binary=:all: `
  --constraint pilot/constraints.git-mcp-2026.7.10-py312.txt `
  "mcp-server-git==2026.7.10"
$env:Path = "$env:TEMP\oculory pilot target\Scripts;$env:Path"
```

Confirm the interpreter reports exactly 3.12.13. Dependency installation is the only network use in this setup. The pilot runner itself makes no network request.

## Track A — guided reproducible workflow

Track A runs the existing pinned Git MCP scenarios through fresh disposable fixtures. It reuses the deterministic mock-provider turn loop, independent Git verifier, external trace recorder, miner, reviewed 8/2 candidate decision, suite compiler, holdout evaluator, and registered `adapter/files-array-stringified` regression.

The participant experiences:

```text
install/check → run deterministic session → inspect evidence → review candidates →
compile suite → replay suite → observe controlled regression → interpret result →
inspect sanitized report
```

The runner retains detailed raw artifacts locally beneath the chosen output directory. Only `pilot-report.json` is designed for optional sharing, and it still requires manual review. The report never embeds the output path.

## Track B — bring-your-own-server readiness assessment

Track B is the structured form in `TRACK_B_READINESS_ASSESSMENT.md`. It does not execute, ingest, or generate an integration for a participant's server. It collects transport, catalogue size, reset/fixture capability, deterministic observability, cleanup, sensitive-data concerns, blockers, and likely verifier needs. It promises no arbitrary-server support.

## Stop boundaries

Do not place output in the repository, attach raw artifacts to an issue or pull request, add provider credentials, recruit participants before independent audit, or infer adoption, demand, willingness to pay, production readiness, security certification, or broad MCP compatibility from this kit.

Read `PILOT_PROTOCOL.md`, `PRIVACY_AND_DATA_HANDLING.md`, and `REPORT_FIELD_GUIDE.md` before any human session.
