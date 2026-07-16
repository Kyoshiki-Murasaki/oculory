# Privacy and data handling

## Default model

The pilot is local-first, opt-in, and provider-free. It has no telemetry, automatic upload, background service, participant account, or model-provider request. The runner's child environment is allowlisted for the disposable Git fixture and contains no provider credentials. Ordinary dependency installation is outside the runner and may contact package registries.

The participant chooses an output directory outside the repository. Detailed traces, journals, snapshots, and candidate-review material remain local there. The only shareable artifact is `pilot-report.json`, after the participant manually reviews it. Sharing is never automatic.

## Sanitized report collects

- schema version and identity-free random report token;
- Oculory version, commit, and clean/modified worktree state;
- OS family and Node/npm/Git versions;
- bounded stage timestamps, durations, status, and sanitized error category/message;
- target/session/tool counts, candidate counts by risk, review counts, compilation/replay/regression results;
- complete process/fixture cleanup proof;
- real provider/network/credential/cost counts fixed at zero and separate mock-turn count;
- optional participant ratings, binary answers, and manually reviewed comments when a future collection workflow explicitly adds them.

## Sanitized report does not collect

Username, email, IP address, home path, repository path, output path, raw environment variables, Git configuration, tool requests/responses, raw transcripts, source code, credentials, model-provider data, participant identity, or protected evidence are forbidden. The verifier rejects absolute private paths, credential-shaped values, raw environment forms, transcript/payload forms, unknown schema versions, missing cleanup, and non-zero provider accounting.

## Participant review

1. Open only `pilot-report.json` in a text editor.
2. Compare its fields with `REPORT_FIELD_GUIDE.md`.
3. Search for any unexpected identity, path, source text, credential, or raw payload.
4. Run `npm run pilot:verify-report -- --report <output>/pilot-report.json`.
5. Share nothing if inspection or verification fails.
6. If sharing is desired, share only the reviewed report—not `raw-local-artifacts`.

## Deletion

After review, delete the entire participant-chosen output directory using the operating system's ordinary file deletion. `pilot:smoke` deletes its own temporary output automatically. The disposable Python target environment is separate and may also be deleted after the session. The runner never deletes arbitrary paths and refuses repository/protected-root destinations.

## Privacy defect reporting

Report a privacy defect using only a short reproduction description, Oculory commit, report schema version, and bounded error category. Do not attach the affected report, raw evidence, screenshots containing paths, shell history, environment output, or private source. Coordinate a safe synthetic reproduction before sharing more.

This is engineering research, not a privacy audit, security certification, or assurance that every future custom server is safe to inspect.
