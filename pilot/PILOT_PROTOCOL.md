# Phase 8 pilot protocol

_Pre-registered before any human participant. Phase 8 builds and validates this protocol; it does not run it._

## Purpose and sample

Run a controlled local-first engineering-usability pilot with three to five external developers matching the profile in `README.md`. Measure onboarding difficulty, workflow comprehension, review burden, error clarity, and whether a compiled behavioral suite is understandable during a realistic controlled change. Do not measure programming skill, commercial demand, or willingness to pay.

## Facilitator boundary

The facilitator may explain the research protocol and observe. They must not type commands, repair the environment, interpret verdicts, select answers, access a private repository, or supply provider credentials during an unassisted attempt. Any operational help after a blockage is recorded as facilitator assistance.

No participant is contacted until an independent task audits this kit and separately authorizes recruitment.

## Track A — guided reproducible workflow

1. Start the total timer when the participant begins setup instructions.
2. Install dependencies and the pinned disposable Git MCP prerequisite.
3. Run `npm run pilot:doctor`; record time to first valid result and every prerequisite error/recovery attempt.
4. Run `npm run pilot:run -- --output <new-directory-outside-the-repository>`; record time to completion.
5. Ask the participant to explain the report's overall result, provider accounting, cleanup proof, and why tool prose cannot outrank independently observed state.
6. Open the run-local relative file `raw-local-artifacts/pilot-track-a/reports/candidate-review.md`. Start the candidate-review timer. Ask which assertions look safe, burdensome, or overfit, then stop the timer.
7. Ask the participant to identify the approved/rejected counts and explain what suite compilation means. The command uses the already-reviewed Phase 6 8/2 decision; it does not claim the participant approved production assertions.
8. Ask the participant to interpret the 2/2 holdout replay.
9. Ask the participant to identify `adapter/files-array-stringified`, the suite and independent-verifier detection channels, and the expected response to the regression.
10. Run `npm run pilot:verify-report -- --report <output>/pilot-report.json`.
11. Have the participant manually inspect `pilot-report.json`, complete `FEEDBACK_FORM.md`, and decide whether to share only the sanitized report. Never request raw artifacts.

Record task completion, elapsed time, error category, assistance, and comprehension answers. Do not copy command history, shell environment, Git configuration, source content, transcripts, or absolute paths into the research record.

## Track B — readiness assessment only

Complete `TRACK_B_READINESS_ASSESSMENT.md` without executing or ingesting the participant's server or repository. Record what would block a future integration and whether a custom independent verifier is required. Do not promise an automatic integration generator or arbitrary-server support.

## Pre-registered hypotheses and success criteria

The pilot kit is considered promising for a later decision—not proven successful—only if:

- at least 80% complete Track A without developer intervention;
- median time to first valid doctor result is at most 10 minutes;
- median total Track A time is at most 75 minutes;
- at least 80% correctly identify the controlled regression;
- at least 80% correctly explain that server prose does not outrank independently observed state;
- median instruction-clarity rating is at least 4/5;
- median verdict-trust rating is at least 4/5;
- real provider calls, provider-network calls, and provider credentials collected/read are all zero;
- protected-evidence mutations and unapproved private-data collection are both zero.

These are hypotheses for a sample of three to five and are not adoption, market, or production evidence.

## Counting rules fixed in advance

- **Started:** consented participant begins setup. All started sessions enter the completion denominator.
- **Completed:** every Track A task reaches a recorded terminal answer and sanitized report verification succeeds.
- **Missing answer:** counts incorrect for the corresponding comprehension/binary metric. Missing ratings are not silently imputed; report rating denominator and missing count.
- **Abandoned:** counts as incomplete and incorrect for unattempted comprehension tasks. For total-time median, use the observed time or 90 minutes, whichever is larger, so abandonment cannot improve the threshold.
- **Facilitator-assisted:** remains in all denominators, is not counted as “without intervention,” and retains actual time.
- **Invalid participant session:** only a pre-declared eligibility mismatch discovered after start; report separately and exclude from the primary denominator.
- **Infrastructure-invalid session:** a verified pilot-kit defect unrelated to participant action. Preserve only sanitized defect notes, exclude from primary usability rates, report the count, repair separately, and do not replace it silently.
- **Cancellation:** participant cancellation is an abandonment unless caused by a verified privacy or safety defect; the runner must still clean bounded processes and fixtures.
- **Median:** compute on the fixed primary denominator under the rules above; show every raw numeric observation without identity.

## Stop conditions during a human session

Stop immediately for suspected credential exposure, private-path/report leakage, unexpected network activity, cleanup residue, protected-root access, target/source mismatch, or any request to use a real provider. Do not attach raw evidence when reporting the defect.
