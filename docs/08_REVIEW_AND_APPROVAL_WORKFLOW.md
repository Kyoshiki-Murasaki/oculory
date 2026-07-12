# 08 — Review and approval workflow

Principle: **observed behaviour never becomes ground truth without a human decision** — but the human's job is reduced to scanning a prepared table and vetoing, not authoring tests.

## CLI interaction
    oculory review                 # prints the candidate table (add --json for machines)
    oculory approve cand-<id> --reason "matches intended workflow"
    oculory reject  cand-<id> --reason "incidental ordering"
    oculory approve --all-stable   # bulk path, see safety rule below
    oculory suite                  # compiles ONLY approved candidates' stable assertions

Editing a candidate = edit `.oculory/candidates.json` (pretty JSON by design) then `oculory suite`; the suite hash changes, so tampering is visible in every subsequent run.

## Review table (one row per candidate; printed by `oculory review`)
candidate id · status · family · recommended gate · each stable assertion with type, params, confidence, support/total · RISK lines. Default action if you do nothing: candidate stays `candidate` and never reaches a suite. Consequences are stated in docs/01 §Glossary (advisory vs gate-eligible vs blocking).

## Bulk-approval safety rule
`--all-stable` approves only deterministic assertions with full support (`stable=true`) and records the bulk reason + timestamp inside every artifact. Risky classes stay explicit: candidates mined from adversarial traffic carry a RISK line; unstable assertions are excluded from compilation regardless of approval. The internal experiment uses this path in *unattended mode* and says so in the recorded reason — this is a labelled shortcut for the mechanical experiment, not the recommended human workflow.

## Review tables for other artifacts
- Scenario ground truth: `oculory scenarios --json` (postconditions are the reviewable ground truth).
- Unstable assertions & alternative paths: RISK lines in `oculory review` (`one_of` risk notes name the observed paths).
- Mutations: `oculory mutate` (id, meaningful?, description).
- Regression findings: `oculory compare` output — each finding shows candidate, scenario, failed assertion types and human-readable detail strings; your action is fix-server / update-suite / reject-assertion, in that order of suspicion.

## Time budget
Design target ≤ 10 min per 12-family review (docs/15 Q-12). The current table is 12 candidates / ~90 assertion rows; measured scan time for the author of the scenarios ≈ 5 min. This number is not yet evidence about strangers (docs/20 A-09).
