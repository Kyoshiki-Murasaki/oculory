# Contributing to Oculory

Oculory accepts focused, reproducible changes that preserve its offline-first validation and evidence boundaries.

## Prerequisites and setup

- Node.js 22.13 or later. CI tests Node 22.13 and Node 24 LTS.
- npm with the committed `package-lock.json`; the repository records the npm version used to maintain package metadata.
- Git configured with your own accurate contributor identity.

Start from the public `main` branch and use the lockfile:

```sh
npm ci
npm run build
npm run typecheck
npm test
node bin/oculory doctor
```

Do not use `npm install` to rewrite dependency resolution in an unrelated change. Runtime dependencies are currently zero; discuss any proposed runtime dependency before adding it.

## Standard validation

Run checks proportionate to the change. The complete offline public-readiness set is:

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
npm run verify:package
git diff --check
```

The three experiments must retain `meaningful_technical_success`. Do not run external Git evidence gates or any model-backed command as routine contribution validation.

## Branches and pull requests

- Branch from current public `main`; do not use `master` or import any older private Git history.
- Keep commits coherent and the pull request scoped. Do not rewrite the public root, force-push shared history, or add release tags for ordinary changes.
- Describe behavior changes, validation results, limitations, and preserved failures honestly. A required CI job must not be made optional to hide a portability defect.
- Add focused tests for fixes and avoid unstable timestamps, temporary paths, platform-specific noise, or network dependence.
- Persisted format changes require a `schema_version` decision and a migration note in `docs/04_DATA_AND_SCHEMA_SPECIFICATION.md`.

## Evidence and generated-output protection

The local roots `.oculory/runs-live`, `.oculory/runs-external`, and `.oculory/runs-model` are protected evidence. Never modify, delete, move, normalize, reconstruct, or clean them while working on an unrelated change. Commands that create authoritative runs require a separately scoped and authorized task.

Never commit:

- `.oculory`, `.oculory-*`, or any live/external/model run root;
- `.env` files, credentials, tokens, private keys, or provider request/response material;
- `node_modules`, `dist`, coverage, logs, temporary files, downloaded archives, Git bundles, or private handoff files;
- raw transcripts, raw evidence, sidecars, or local absolute paths.

Do not attach private evidence to GitHub issues or pull requests. To report a reproducibility failure, provide the public commit, command, exit status, Node/npm/OS versions, a sanitized error summary, and non-sensitive file counts or manifest digests. Omit raw traces, local paths, repository copies, credentials, and archive contents.

## Candidate approval discipline

Observed behavior never becomes ground truth automatically. Review candidate provenance and assertions before approval. Do not approve adversarial-only, smoke-only, unstable, constant-bound, or otherwise risky candidates merely to enlarge a suite or make a test pass. Record the reviewer, reason, and every deliberate risk override.

New assertion types need mining rules, evaluator semantics, anti-overfit analysis, provenance, and a holdout-generalization test.

## Provider-call authorization boundary

Public CI and normal contribution tests must make zero model-provider calls and use no model-provider credentials. The Gate F1 template is `draft` and non-executable. Do not populate it, request a key, add a live provider adapter, or run Gate F1/F2 without a separate explicit authorization that fixes provider, model snapshot, pricing, privacy/region, execution window, scenarios, endpoint allowlist, retry/unknown thresholds, caps, and a hard dollar limit.

## Package validation

`npm run verify:package` is the canonical consumer check. It builds and packs version `0.1.0` in a temporary directory, enforces required and prohibited contents, installs the tarball into an empty npm project, runs `npx --no-install oculory --version`, `--help`, and `doctor --json`, performs a deterministic runtime smoke, and removes the temporary directory. It does not publish the package.
