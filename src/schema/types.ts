/**
 * Oculory core schema (schema_version: 1).
 *
 * Every persisted artifact carries `schema_version` and, where derived,
 * `provenance`. Canonical serialisation + hashing live in canonical.ts.
 * Runtime validation lives in validate.ts (minimal validator standing in
 * for Zod until network access allows installing it; see docs/04).
 */

/**
 * v1 -> v2 (Phase 2, model-driven traffic): `RawTrace.agent` gained
 * provider/model/tokens_in/tokens_out/cost_usd/budget_usd (all nullable;
 * null for kind:'scripted'); `RawTrace` gained a top-level nullable `trial`
 * index. No migrateV1toV2() was written: `.oculory/` is ephemeral, regenerated
 * local state (gitignored), never long-lived persisted data, so old-version
 * raw traces are not expected to exist anywhere worth migrating — run
 * `oculory clean && oculory record` after upgrading instead. See docs/04.
 */
export const SCHEMA_VERSION = 2;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/* ------------------------------- Tools ---------------------------------- */

export interface ToolParamSpec {
  name: string;
  type: 'string' | 'integer' | 'boolean';
  required: boolean;
  description: string;
  enum?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  params: ToolParamSpec[];
}

/* ------------------------------- Traces --------------------------------- */

export type ResultStatus = 'ok' | 'error';

export interface ToolCallStep {
  index: number;
  type: 'tool_call';
  tool: string;
  args: JsonObject;
  result_status: ResultStatus;
  /** Structured error code when result_status === 'error'. */
  error_code: string | null;
  /** sha256 of canonical result payload — never the raw payload. */
  result_digest: string;
  /** Small structured result fields kept for mining (returned ids, changed flag). */
  result_summary: JsonObject;
  /** Whether this call changed the environment state (per-step snapshot diff). */
  state_changed: boolean;
  latency_ms: number;
}

export interface EnvSnapshot {
  /** sha256 over canonical ordered row dump. */
  state_hash: string;
  /** Ordered row dump (small demo DBs only; digest-only mode for big DBs). */
  rows: JsonObject[];
}

export interface RawTrace {
  schema_version: number;
  trace_id: string;
  session_id: string;
  recorded_at: string; // ISO 8601
  scenario_id: string;
  scenario_family: string;
  partition: DatasetPartition;
  /** Provider/model, or scripted policy id in offline mode. */
  agent: {
    kind: 'model' | 'scripted';
    id: string;
    temperature: number | null;
    seed: number | null;
    /** schema_version 2+. Always null for kind:'scripted'. */
    provider: string | null;
    model: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_usd: number | null;
    /** the hard per-run USD cap in force when this trace was recorded, if any (docs/19 budget guard) */
    budget_usd: number | null;
  };
  client: string;
  user_intent: string;
  system_prompt_digest: string | null;
  tool_schema_hash: string;
  tools: ToolSpec[];
  fixture_id: string;
  env_before: EnvSnapshot;
  steps: ToolCallStep[];
  final_response: string | null;
  env_after: EnvSnapshot;
  server_version: string;
  mutation_id: string | null;
  /**
   * schema_version 2+. Index of this recording-time trial when the same
   * scenario+policy is deliberately recorded N times (`--trials N`, model
   * policy only) to probe non-determinism; null otherwise. This is DISTINCT
   * from replay-time instability (`TestRunResult.unstable` below), which is
   * about an already-approved suite disagreeing across policies/trials
   * during regression replay. See docs/04 "Two kinds of instability".
   */
  trial: number | null;
}

export type DatasetPartition = 'smoke' | 'mining' | 'holdout' | 'adversarial';

/* --------------------------- Outcome labels ----------------------------- */

export type OutcomeLabel =
  | 'verified_success'
  | 'verified_failure'
  | 'partial_success'
  | 'valid_rejection'
  | 'invalid_acceptance'
  | 'unknown';

export interface OutcomeEvidence {
  check: string;
  expected: Json;
  observed: Json;
  passed: boolean;
}

export interface OutcomeRecord {
  schema_version: number;
  trace_id: string;
  label: OutcomeLabel;
  evidence: OutcomeEvidence[];
  verified_at: string;
  verifier: 'deterministic-state-v1';
}

/* ------------------------ Normalised traces ----------------------------- */

export interface NormalizedTrace extends RawTrace {
  normalized: true;
  outcome: OutcomeRecord;
  /** Entities extracted deterministically from the user intent. */
  intent_entities: JsonObject;
}

/* ------------------------------ Scenarios ------------------------------- */

export interface StateCondition {
  /** e.g. "task_status", "task_exists", "task_count", "task_assignee", "task_priority" */
  kind: string;
  selector: JsonObject; // e.g. { title: "Fix login bug" }
  expected: Json;
}

export interface Scenario {
  schema_version: number;
  scenario_id: string;
  family: string;
  partition: DatasetPartition;
  fixture_id: string;
  intent_template: string;
  wording_variants: string[];
  /** Structured intent the scripted policies and verifier consume. */
  intent: JsonObject;
  expected_behaviour: string;
  acceptable_tool_paths: string[][];
  prohibited_tools: string[];
  expect_error: string | null;
  preconditions: StateCondition[];
  postconditions: StateCondition[];
  ambiguity: 'none' | 'entity' | 'tool' | 'intent';
  difficulty: 'easy' | 'medium' | 'hard';
  rationale: string;
}

/* ------------------------------ Assertions ------------------------------ */

export type AssertionType =
  | 'tool_required'
  | 'tool_forbidden'
  | 'one_of_tools'
  | 'tool_precedes'
  | 'arg_present'
  | 'arg_equals_entity'
  | 'arg_enum'
  | 'max_call_count'
  | 'error_expected'
  | 'no_error'
  | 'retrieval_consistent'
  | 'state_postcondition'
  | 'state_unchanged'
  | 'outcome_verified';

export interface Assertion {
  assertion_id: string;
  type: AssertionType;
  /** Type-specific parameters (tool, arg, entity key, condition, …). */
  params: JsonObject;
  confidence: number; // support ratio in mining set, 0..1
  support: number; // traces supporting
  total: number; // traces examined
  stable: boolean;
  provenance: { trace_ids: string[]; miner: string };
}

export type CandidateStatus = 'candidate' | 'approved' | 'rejected' | 'advisory';
export type GateLevel = 'advisory' | 'gate_eligible' | 'blocking';

/**
 * Provenance + safety metadata attached to candidates mined inside an
 * ISOLATED model run (Phase 3.4/3.5). ALWAYS ABSENT on scripted-experiment
 * candidates, so the scripted pipeline is byte-for-byte unchanged; only the
 * model-run/`--run-dir` mining path sets it. Consumed by `review` (display)
 * and `approve` (which refuses to auto-approve smoke-only / unstable / risky
 * candidates unless the corresponding --allow-* flag is passed).
 */
export interface CandidateRiskProfile {
  /** Distinct agent ids that produced the backing traces (e.g. model/openai/gpt-4.1-mini). */
  source_policies: string[];
  model_trace_count: number;
  scripted_trace_count: number;
  /** Backed by BOTH model and scripted traces — provenance is mixed. */
  mixed_sources: boolean;
  partitions: DatasetPartition[];
  smoke_only: boolean;
  adversarial_only: boolean;
  /** A source scenario was recording-time unstable across trials. */
  from_unstable_scenario: boolean;
  /** Number of distinct traces backing the candidate. */
  min_support: number;
  min_support_met: boolean;
  unknown_outcomes_nearby: boolean;
  constant_args: boolean;
  alternative_tool_paths: boolean;
  /** Any non-smoke, non-unstable risk flag is present (gated by --allow-risky). */
  risky: boolean;
  /** Conservative: false whenever any risk flag is present. */
  safe_to_approve: boolean;
  /** Should stay advisory (not a blocking regression gate) without explicit human override. */
  advisory_only: boolean;
  risk_flags: string[];
}

export interface CandidateReview {
  action: 'approve' | 'reject' | 'edit';
  reason: string;
  at: string;
  /** Phase 3.5 approval metadata (optional; absent on legacy scripted approvals). */
  approved_by?: string | null;
  approval_mode?: 'all-stable' | 'single' | 'auto-experiment' | null;
  overridden_warnings?: string[];
}

export interface CandidateTest {
  schema_version: number;
  candidate_id: string;
  scenario_family: string;
  scenario_ids: string[];
  fixture_id: string;
  intents: string[];
  assertions: Assertion[];
  status: CandidateStatus;
  recommended_gate: GateLevel;
  risk_notes: string[];
  review: CandidateReview | null;
  /** Present only for candidates mined inside an isolated model run (Phase 3.4). */
  risk_profile?: CandidateRiskProfile | null;
}

export interface ApprovedSuite {
  schema_version: number;
  suite_id: string;
  created_at: string;
  suite_hash: string;
  tests: CandidateTest[];
}

/* -------------------------------- Replay -------------------------------- */

export interface AssertionResult {
  assertion_id: string;
  type: AssertionType;
  passed: boolean;
  detail: string;
}

export interface TrialResult {
  trial: number;
  trace_id: string;
  assertion_results: AssertionResult[];
  passed: boolean;
}

export interface TestRunResult {
  candidate_id: string;
  scenario_id: string;
  trials: TrialResult[];
  passed: boolean;
  unstable: boolean; // trials disagree
}

export interface SuiteRunResult {
  schema_version: number;
  run_id: string;
  suite_id: string;
  suite_hash: string;
  run_at: string;
  agent_id: string;
  server_version: string;
  mutation_id: string | null;
  tool_schema_hash: string;
  results: TestRunResult[];
  totals: { tests: number; passed: number; failed: number; unstable: number };
}

/* ------------------------------ Comparison ------------------------------ */

export interface RegressionFinding {
  candidate_id: string;
  scenario_id: string;
  failed_assertions: AssertionResult[];
  classification: 'regression' | 'unstable' | 'new_pass';
}

export interface ComparisonReport {
  schema_version: number;
  baseline_run_id: string;
  current_run_id: string;
  mutation_id: string | null;
  regressions: RegressionFinding[];
  new_passes: RegressionFinding[];
  unstable: RegressionFinding[];
  summary: { regressed: number; improved: number; unchanged: number; unstable: number };
}

/* ------------------------------- Mutations ------------------------------ */

export interface MutationDef {
  mutation_id: string;
  description: string;
  category:
    | 'description_weakened'
    | 'arg_renamed'
    | 'enum_changed'
    | 'default_changed'
    | 'silent_write_failure'
    | 'wrong_success'
    | 'partial_match_changed'
    | 'error_changed'
    | 'tool_order_changed'
    | 'overlapping_tool_added';
  /** Whether a real user-facing behaviour change occurs (ground truth). */
  meaningful: boolean;
}
