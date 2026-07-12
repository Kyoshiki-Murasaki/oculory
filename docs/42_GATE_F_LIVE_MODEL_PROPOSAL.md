# 42 — Gate F live-model proposal

> This document does not authorize any model or provider call.

Gate F is a future, provider-neutral experiment proposal. It remains separate from the completed Phase 6 scripted evidence and requires a later, explicit authorization artifact. Nothing in this document authorizes implementation of provider traffic, entry or use of a key, selection of a provider or model, or execution of a session.

## Objective

Gate F would evaluate whether language models can produce correct Git MCP tool behavior against the pinned target while retaining the existing fixture isolation, independent per-step Git state oracle, `git-verifier-v1`, eligible approved-suite checks, strict evidence finalization, and explicit budget controls.

Phase 6 scripted evidence establishes deterministic target/transport/adapter/verifier behavior for the documented scope. It does **not** establish model reliability.

## Evidence separation

Every Gate F record and report must distinguish:

- target behavior;
- MCP transport behavior;
- Oculory adapter behavior;
- verifier behavior;
- model behavior;
- provider behavior;
- prompt behavior;
- cleanup and process behavior.

A model failure must not automatically be attributed to the target. Provider errors, prompt defects, malformed tool-call serialization, transport failures, oracle uncertainty, and cleanup failures remain separate classifications.

## Proposed phases

### F0 — offline preparation

F0 permits no provider calls. It would add only provider-neutral and mock-tested preparation:

- a provider-neutral request/response schema and mock provider adapter;
- response parsing, structured tool-call validation, and unknown-tool rejection tests;
- prompt-manifest and scenario-manifest digests;
- run-root and evidence-root isolation;
- API-key redaction and no-secret-in-trace tests;
- token and cost accounting tests;
- hard session, turn, MCP-call, input-token, output-token, retry, and dollar-cap tests;
- stop-condition and retry-limit tests;
- mock authentication, timeout, rate-limit, malformed-response, and provider-error cases;
- dry-run report generation with no network capability.

F0 completion is not authorization for F1.

### F1 — minimal paid smoke

F1 requires separate later authorization naming one provider and one exact model identifier. Proposed scope is six sessions: one trial for each of six scenarios, with no automatic retry or expansion.

Selected scenarios:

1. `git-status-s1` — read-only infrastructure smoke;
2. `git-stage-h1` — eligible stage holdout;
3. `git-branch-h1` — eligible branch-create holdout;
4. `git-missing-revision-a1` — expected target rejection;
5. `git-ambiguous-branch-a1` — ambiguous read-and-stop/no-tool behavior;
6. `git-add-traversal-a1` — traversal/boundary rejection.

Proposed per-session limits: four model turns, six MCP calls, zero canonical retries, 4,000 provider-input tokens per turn, 2,000 output tokens per turn, and 8,000 tool/result context tokens per turn. The authorization must also set a hard dollar cap. Stop immediately on any evidence-finalization, cleanup, process, identity, provenance, real-repository, credential, remote-operation, or cap failure.

### F2 — main experiment

F2 requires separate authorization after human review of F1. Primary generalization claims may use only holdout and adversarial scenarios. Smoke scenarios remain infrastructure checks. Mining scenarios are in-distribution diagnostics and cannot support a generalization claim.

Proposed primary F2 set: all four holdout and all eight adversarial scenarios, three canonical trials per scenario. Candidate designs:

| Design | Models | Scenarios/model | Trials/scenario | Sessions | Purpose |
|---|---:|---:|---:|---:|---|
| One-model standard | 1 | 12 | 3 | 36 | estimate one exact model's holdout/adversarial behavior |
| Two-model comparative | 2 | 12 | 3 | 72 | compare two exact model versions under one fixed protocol |
| Three-model expanded | 3 | 12 | 3 | 108 | broader comparison after standard/comparative review |

No model is selected now. An expanded design is never an automatic continuation of a smaller design.

## Scenario accounting

`Suite eligibility` means an existing approved Gate E contract is applicable. Every scenario still requires the independent golden verifier.

| Scenario ID | Partition | Purpose | Suite eligibility | Expected golden outcome | F1 | F2 primary | Proposed trials |
|---|---|---|---|---|---|---|---:|
| `git-status-s1` | smoke | clean read-only status | no | `verified_success` | yes | no | F1: 1 |
| `git-history-s1` | smoke | read-only log/show | no | `verified_success` | no | no | 0 |
| `git-stage-m1` | mining | stage with diff checks | stage | `verified_success` | no | no; diagnostic only | 0 primary |
| `git-stage-m2` | mining | direct stage | stage | `verified_success` | no | no; diagnostic only | 0 primary |
| `git-stage-m3` | mining | status then stage | stage | `verified_success` | no | no; diagnostic only | 0 primary |
| `git-branch-m1` | mining | direct branch creation | branch-create | `verified_success` | no | no; diagnostic only | 0 primary |
| `git-branch-m2` | mining | alternate branch entity | branch-create | `verified_success` | no | no; diagnostic only | 0 primary |
| `git-branch-m3` | mining | list then create | branch-create | `verified_success` | no | no; diagnostic only | 0 primary |
| `git-stage-h1` | holdout | unseen stage entity | stage | `verified_success` | yes | yes | F1: 1; F2: 3/model |
| `git-branch-h1` | holdout | unseen branch entity | branch-create | `verified_success` | yes | yes | F1: 1; F2: 3/model |
| `git-checkout-h1` | holdout | checkout generalization | no | `verified_success` | no | yes | F2: 3/model |
| `git-reset-h1` | holdout | reset generalization | no | `verified_success` | no | yes | F2: 3/model |
| `git-missing-revision-a1` | adversarial | expected missing-revision error | no | `valid_rejection` | yes | yes | F1: 1; F2: 3/model |
| `git-malformed-add-a1` | adversarial | malformed structural input | no | `valid_rejection` | no | yes | F2: 3/model |
| `git-outside-repository-a1` | adversarial | repository-boundary refusal | no | `valid_rejection` | no | yes | F2: 3/model |
| `git-add-traversal-a1` | adversarial | upstream traversal rejection | no | `valid_rejection` | yes | yes | F1: 1; F2: 3/model |
| `git-existing-branch-a1` | adversarial | existing-ref rejection | no | `valid_rejection` | no | yes | F2: 3/model |
| `git-ambiguous-branch-a1` | adversarial | clarify or read-and-stop | no | `valid_rejection` | yes | yes | F1: 1; F2: 3/model |
| `git-status-readonly-a1` | adversarial | dirty-state read only | no | `verified_success` | no | yes | F2: 3/model |
| `git-mutate-restore-a1` | adversarial | prohibit transient mutation | no | `verified_success` for safe path | no | yes | F2: 3/model |

## Proposed execution envelopes

The token values below are hard maxima for planning, not usage forecasts. Prices and budget caps remain blank until authorization-time verification.

| Envelope | M | S | R | Sessions | Turns/session | MCP calls/session | Canonical retries | Max input tokens | Max output tokens | Price inputs | Hard cap B |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| Minimal F1 | 1 | 6 | 1 | 6 | 4 | 6 | 0 | 288,000 | 48,000 | `P_i=___`, `P_o=___` | `___` |
| Standard F2 | 1 | 12 | 3 | 36 | 6 | 10 | 0 | 3,888,000 | 648,000 | `P_i=___`, `P_o=___` | `___` |
| Comparative F2 | 2 | 12 | 3 | 72 | 6 | 10 | 0 | 7,776,000 | 1,296,000 | per-model verified prices | `___` |
| Expanded F2 | 3 | 12 | 3 | 108 | 6 | 10 | 0 | 11,664,000 | 1,944,000 | per-model verified prices | `___` |

F1 uses `I=4,000`, `C=8,000`, and `O=2,000` tokens per turn. F2 uses `I=6,000`, `C=12,000`, and `O=3,000`. Any smaller approved caps replace these maxima; no runner may silently increase them.

## Budget model

Define:

- `M` = number of models;
- `S` = scenarios per model;
- `R` = trials per scenario;
- `T` = maximum model turns per session;
- `I` = maximum billable input tokens per turn;
- `O` = maximum billable output tokens per turn;
- `C` = expected tool/result context tokens per turn;
- `P_i` = provider input price per million tokens;
- `P_o` = provider output price per million tokens;
- `K` = contingency multiplier;
- `B` = hard budget cap.

```text
sessions = M × S × R

maximum_input_tokens = sessions × T × (I + C)

maximum_output_tokens = sessions × T × O

estimated_cost =
K × [
  (maximum_input_tokens / 1,000,000) × P_i
  +
  (maximum_output_tokens / 1,000,000) × P_o
]

require estimated_cost ≤ B
```

Current prices must not be copied from memory. At authorization time, verify official provider pricing, price timestamp, cached-input/tool-token treatment, currency/tax handling, and the exact model identifier. Record both estimated and actual cost. The runner must stop before a request that could exceed `B`.

## Metrics

Report overall, per model, per scenario, and per partition:

- `verified_success`, `valid_rejection`, `verified_failure`, `partial_success`, `invalid_acceptance`, and `unknown` rates;
- approved-suite and eligible-holdout pass rates;
- adversarial valid-rejection rate;
- wrong-entity, prohibited-mutation, duplicate-call, transient-mutation, and incorrect no-tool-refusal rates;
- tool-selection, argument, and tool-order accuracy;
- average and distribution of tool calls;
- cleanup, process, and transport failure rates;
- latency;
- input/output tokens;
- estimated and actual cost;
- per-model and per-scenario stability.

Every denominator must be explicit. Infrastructure failures must not be silently counted as model failures or removed from the canonical attempt.

## Stopping rules

Stop immediately on:

- hard dollar, session, turn, MCP-call, retry, input-token, or output-token cap;
- provider authentication failure;
- provider or exact model identity mismatch;
- evidence-finalization failure or missing terminal record;
- cleanup failure or process leak;
- any access to a real repository;
- credential leakage;
- an unexpected remote or network operation outside the authorized provider endpoint;
- mutation of historical evidence;
- unexpected source-tree provenance;
- verifier-version, suite-digest, prompt-manifest, or scenario-manifest mismatch;
- repeated unknown outcomes above the preregistered threshold;
- any request outside the approved scenario manifest.

The authorization artifact must define the unknown threshold. No default may be invented at runtime.

## Retry policy

- No hidden retries by Oculory, the provider client, an SDK, or middleware.
- Failed canonical trials are never replaced.
- The canonical retry cap is zero unless a later authorization explicitly changes it.
- Every attempted session receives a distinct terminal record, including authentication, timeout, rate-limit, and transport failures.
- Diagnostic reruns use a separate run ID and cannot supply replacement canonical trials.
- Provider retry behavior must be disabled where possible and observable in request evidence where it cannot be disabled.

## Provider and model selection criteria

Before authorization, verify:

- provider and exact model identifier/snapshot;
- current availability and regional availability;
- tool-calling and structured-output behavior;
- temperature, seed, reasoning, and other reproducibility controls;
- token observability and usage reporting;
- request reproducibility and stable model-version reporting;
- retention, privacy, training-use, and data-processing terms;
- rate limits and retry semantics;
- current official input/output/cached/tool-token pricing;
- provider policy compatibility with synthetic Git scenarios.

The selection record must distinguish stable snapshot evidence from a provider alias that can change underneath the experiment.

## API-key handling

Future execution must accept a key only from an interactively entered shell environment variable, for example:

```sh
read -s PROVIDER_API_KEY
echo
export PROVIDER_API_KEY
```

The literal secret must never be stored in source, prompts, `.env`, test fixtures, traces, transcripts, reports, shell history, Git history, or the evidence archive. Secret-bearing environment values must be excluded or redacted from provenance; names may be retained only where needed to prove policy. The child Git MCP process must never receive the provider key.

## Authorization manifest

A future tracked authorization artifact, or equivalent explicit human approval, must contain:

- authorization ID and explicit authorization statement;
- provider and exact model ID/snapshot;
- official pricing source and verification timestamp;
- input and output prices and any cached/tool-token rules;
- approved scenario IDs and manifest digest;
- trials, sessions, turns, MCP calls, retries, input/output tokens, and dollar caps;
- retention/privacy acknowledgment and regional constraints;
- execution date window;
- prompt-manifest digest, source commit, verifier version, suite digest, and evidence-root policy;
- reviewer identity.

No Gate F execution may begin without this artifact or equivalent explicit human approval.

## Final authorization checklist

Later approval must explicitly name:

- provider;
- exact model and version/snapshot;
- verified pricing;
- privacy and retention terms;
- scenario list;
- trial and session counts;
- retry count;
- maximum turns and MCP calls;
- input-token and output-token caps;
- dollar cap;
- execution date/window;
- stop rules and unknown threshold.

> This proposal remains unexecuted. No model or provider call is authorized by this document.

## Subsequent status — Gate F0

Gate F0 later **passed** its offline-only scope as recorded in `docs/43_GATE_F0_OFFLINE_PREPARATION_AND_VALIDATION.md`. No real provider/model call occurred, no real key was requested or read, and actual provider cost was zero. The production F0 registry contains only the deterministic non-network mock.

Gate F1 remains unauthorized. A tracked draft authorization template now exists at `authorizations/gate-f1-authorization-template.json`; it explicitly says `NOT AUTHORIZED — TEMPLATE ONLY` and the runner refuses it as live authorization. Exact provider, exact model/snapshot, current official pricing, privacy/retention and region, execution window, endpoint allowlist, scenario/call/token/retry/unknown caps, and positive hard dollar cap still require explicit human approval. No F2 work started.
