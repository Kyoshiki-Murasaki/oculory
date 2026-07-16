# Pilot report field guide

Schema version: `oculory-pilot-report-v1`.

| Field | Meaning | Privacy boundary |
|---|---|---|
| `schemaVersion` | Version understood by the verifier | Unknown versions are rejected |
| `reportToken` | Random identity-free 96-bit correlation token | Not derived from participant or machine identity |
| `overallResult` | Passed, failed, or participant-cancelled | Pass requires every required stage and cleanup invariant |
| `oculory` | Version, Git commit, clean/modified state | No branch, remote, repository path, author, or Git config |
| `system` | OS family and Node/npm/Git versions | No hostname, username, IP, locale, or environment dump |
| `tracks.guidedTrackA` | Automated guided workflow state | No claim that a human pilot ran |
| `tracks.readinessTrackB` | Always `not_run` in automated output | No private server is executed or integrated |
| `stages` | Ordered start/end/duration/status for nine stages | Errors use bounded category and sanitized message |
| `metrics.targetSessions` | Fresh pinned-target sessions, including schema preflights and regression | Count only; no transcripts or fixture paths |
| `metrics.mockProviderSessions/Turns` | Deterministic non-network mock activity | Separate from real provider accounting |
| `metrics.mcpToolCalls` | Total calls made to disposable fixtures | No tool arguments/results |
| `metrics.candidates` | Total/risk/8-approved/2-rejected counts | No candidate payload or source trace |
| `metrics.suite` | Compilation state, version, count, digest | Digest only; suite content stays tracked/local |
| `metrics.replay` | Holdout session and pass counts | No raw replay evidence |
| `metrics.controlledRegression` | Registered ID and detection channels | No mutation payload or target-vulnerability claim |
| `cleanup` | Child, fixture, working-root, emergency-cleanup proof | A report with incomplete cleanup is invalid |
| `providerAccounting` | Real calls/network/credentials/cost fixed at zero; mock turns separate | Any positive real-provider field is rejected |
| `privacy` | Explicit exclusion flags and manual-review requirement | Every inclusion flag must remain false |
| `participantFeedback` | Null by default; future reviewed ratings/comments only | Comments require explicit manual review |
| `limitations` | Bounded non-claims | Must not contain private paths or raw content |

The verifier also rejects missing stages, overlapping or impossible timestamps, incorrect durations, impossible success combinations, absolute home paths, environment assignments, credential-shaped strings, raw protocol/transcript forms, and sensitive field names.
