import type {
  ApprovedSuite,
  CandidateTest,
  JsonObject,
  Scenario,
  SuiteRunResult,
  TestRunResult,
  TrialResult,
} from '../../schema/types.js';
import { SCHEMA_VERSION } from '../../schema/types.js';
import { hashJson, shortId } from '../../schema/canonical.js';
import { annotateCandidates } from '../../pipeline/candidate-risk.js';
import type { RecordingInstabilityResult } from '../../pipeline/instability.js';
import type { Store } from '../../pipeline/store.js';
import { ISSUE_SCENARIOS, issueScenarioById } from './scenarios.js';
import { ISSUE_DEFAULT_POLICIES } from './policy.js';
import { recordIssueSession } from './record.js';
import { verifyIssueOutcome, evaluateIssueAssertion, evaluateIssueGoldenOutcome } from './verifier.js';
import { normalizeIssueTrace, mineIssueAll } from './mine.js';
import { IssueTrackerServer } from './server.js';
import { issueSeed } from './fixtures.js';
import { issueFlagsFor } from './mutations.js';

/**
 * Issue-tracker replay + baseline (Phase 5, docs/28). Parallels
 * src/pipeline/run.ts (task) and the fs run.ts; `compileSuite` and `compareRuns`
 * are reused from the shared pipeline unchanged (they are server-agnostic).
 */

/* --------------------------- verify + normalize --------------------------- */

export function verifyAndNormalizeAllIssues(store: Store): { verified: number; labels: Record<string, number> } {
  const labels: Record<string, number> = {};
  const raws = store.loadRawTraces();
  for (const raw of raws) {
    const outcome = verifyIssueOutcome(issueScenarioById(raw.scenario_id), raw);
    store.appendOutcome(outcome);
    store.appendNormalizedTrace(normalizeIssueTrace(raw, outcome));
    labels[outcome.label] = (labels[outcome.label] ?? 0) + 1;
  }
  return { verified: raws.length, labels };
}

/** Mine non-holdout normalized traces, annotate with provenance/risk (never auto-approved). */
export function mineIssueIsolated(store: Store, instability: RecordingInstabilityResult[]): CandidateTest[] {
  const eligible = store.loadNormalizedTraces().filter((t) => t.partition !== 'holdout');
  return annotateCandidates(mineIssueAll(eligible), eligible, instability);
}

/* ------------------------------- Replay ---------------------------------- */

export interface IssueReplayOptions {
  mutationId: string | null;
  partitions: Scenario['partition'][];
}

export async function replayIssueSuite(suite: ApprovedSuite, opts: IssueReplayOptions): Promise<SuiteRunResult> {
  const results: TestRunResult[] = [];
  for (const test of suite.tests) {
    const scenarios = ISSUE_SCENARIOS.filter((sc) => sc.family === test.scenario_family && opts.partitions.includes(sc.partition));
    for (const scenario of scenarios) {
      const trials: TrialResult[] = await Promise.all(
        ISSUE_DEFAULT_POLICIES.map(async (policy, i) => {
          const trace = await recordIssueSession({ scenario, policy, mutationId: opts.mutationId });
          const assertionResults = test.assertions.filter((a) => a.stable).map((a) => evaluateIssueAssertion(a, trace));
          assertionResults.push(evaluateIssueGoldenOutcome(scenario, trace));
          return { trial: i, trace_id: trace.trace_id, assertion_results: assertionResults, passed: assertionResults.every((r) => r.passed) };
        }),
      );
      results.push({
        candidate_id: test.candidate_id,
        scenario_id: scenario.scenario_id,
        trials,
        passed: trials.every((t) => t.passed),
        unstable: false,
      });
    }
  }
  const totals = {
    tests: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    unstable: results.filter((r) => r.unstable).length,
  };
  const schemaHash = hashJson(new IssueTrackerServer([], issueFlagsFor(opts.mutationId)).toolSpecs() as unknown as JsonObject[]);
  return {
    schema_version: SCHEMA_VERSION,
    run_id: `issue-run-${opts.mutationId ?? 'baseline'}-${shortId('', { suite: suite.suite_hash, mutation: opts.mutationId }).slice(1, 9)}`,
    suite_id: suite.suite_id,
    suite_hash: suite.suite_hash,
    run_at: new Date().toISOString(),
    agent_id: ISSUE_DEFAULT_POLICIES.map((p) => p.id).join(','),
    server_version: '0.1.0',
    mutation_id: opts.mutationId,
    tool_schema_hash: schemaHash,
    results,
    totals,
  };
}

/* --------------------------- Schema-smoke baseline ------------------------ */

/**
 * A deliberately NAIVE schema baseline for the issue tracker: an
 * order-insensitive hash of the tool schema plus one smoke call per tool with
 * known-good arguments, asserting a non-error result. It stands in for a naive
 * "snapshot the tool schema + does each tool run" check. It CANNOT see
 * behavioural regressions where the schema is unchanged and the smoke call still
 * returns ok — exactly the gap the mined + golden suite fills. Labelled
 * `issue-schema-smoke-proxy` everywhere to prevent overclaiming.
 */
export interface IssueBaselineResult {
  baseline: 'issue-schema-smoke-proxy';
  mutation_id: string | null;
  schema_changed: boolean;
  smoke_failures: { tool: string; error_code: string | null }[];
  detected: boolean;
}

const SMOKE_ARGS: Record<string, JsonObject> = {
  create_issue: { title: 'smoke issue', body: 'smoke' },
  read_issue: { id: 'ISSUE-1' },
  search_issues: { query: 'Login' },
  assign_issue: { id: 'ISSUE-1', assignee: 'alice' },
  label_issue: { id: 'ISSUE-1', label: 'bug' },
  comment_issue: { id: 'ISSUE-1', body: 'smoke' },
  close_issue: { id: 'ISSUE-1' },
  reopen_issue: { id: 'ISSUE-4' },
  list_issues: { status: 'open' },
};

function orderInsensitiveSchemaHash(mutationId: string | null): string {
  const tools = [...new IssueTrackerServer([], issueFlagsFor(mutationId)).toolSpecs()].sort((a, b) => a.name.localeCompare(b.name));
  return hashJson(tools as unknown as JsonObject[]);
}

export function runIssueSchemaSmokeBaseline(mutationId: string | null): IssueBaselineResult {
  const referenceHash = orderInsensitiveSchemaHash(null);
  const currentHash = orderInsensitiveSchemaHash(mutationId);
  const smoke_failures: { tool: string; error_code: string | null }[] = [];
  for (const tool of new IssueTrackerServer([], issueFlagsFor(mutationId)).toolSpecs()) {
    // Fresh server per smoke call so the calls do not interfere with one another.
    const server = new IssueTrackerServer(issueSeed(), issueFlagsFor(mutationId));
    const result = server.callTool(tool.name, SMOKE_ARGS[tool.name] ?? {});
    if (result.status === 'error') smoke_failures.push({ tool: tool.name, error_code: result.error_code });
  }
  const schema_changed = currentHash !== referenceHash;
  return {
    baseline: 'issue-schema-smoke-proxy',
    mutation_id: mutationId,
    schema_changed,
    smoke_failures,
    detected: schema_changed || smoke_failures.length > 0,
  };
}
