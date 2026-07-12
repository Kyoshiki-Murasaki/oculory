import type {
  ApprovedSuite,
  CandidateTest,
  ComparisonReport,
  JsonObject,
  RegressionFinding,
  Scenario,
  SuiteRunResult,
  TestRunResult,
  TrialResult,
} from '../schema/types.js';
import { SCHEMA_VERSION } from '../schema/types.js';
import { hashJson, shortId } from '../schema/canonical.js';
import { SCENARIOS } from '../runner/catalogue.js';
import { DEFAULT_POLICIES } from '../runner/policies.js';
import { recordSession, type FixtureFile } from '../runner/record.js';
import { evaluateAssertion, evaluateGoldenOutcome } from './evaluate.js';
import { DemoServer } from '../server/tools.js';
import { flagsFor } from '../server/mutations.js';
import { InProcessEndpoint } from '../mcp/mcp.js';

/* ------------------------------ Suite ----------------------------------- */

export function compileSuite(candidates: CandidateTest[]): ApprovedSuite {
  const approved = candidates.filter((c) => c.status === 'approved');
  if (approved.length === 0) throw new Error('no approved candidates: run `oculory review` / `oculory approve` first');
  const tests = approved.map((c) => ({ ...c, assertions: c.assertions.filter((a) => a.stable) }));
  const suite: Omit<ApprovedSuite, 'suite_hash' | 'suite_id'> = {
    schema_version: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    tests,
  } as never;
  const suite_hash = hashJson(tests as unknown as JsonObject[]);
  return { ...suite, suite_id: `suite-${suite_hash.slice(0, 10)}`, suite_hash } as ApprovedSuite;
}

/* ------------------------------ Replay ---------------------------------- */

export interface ReplayOptions {
  mutationId: string | null;
  fixture: FixtureFile;
  partitions: Scenario['partition'][];
}

/**
 * Replay: for each approved test, re-execute every catalogue scenario of the
 * same family (within the selected partitions) with each agent policy as one
 * trial, evaluating mined assertions plus the golden outcome check.
 * With scripted deterministic agents, cross-policy disagreement is a
 * per-agent regression, not instability; `unstable` is reserved for
 * same-agent trial variance (relevant once model agents are wired in).
 */
export async function replaySuite(suite: ApprovedSuite, opts: ReplayOptions): Promise<SuiteRunResult> {
  const results: TestRunResult[] = [];
  for (const test of suite.tests) {
    const scenarios = SCENARIOS.filter(
      (s) => s.family === test.scenario_family && opts.partitions.includes(s.partition),
    );
    for (const scenario of scenarios) {
      const trials: TrialResult[] = await Promise.all(DEFAULT_POLICIES.map(async (policy, i) => {
        const trace = await recordSession({ scenario, policy, fixture: opts.fixture, mutationId: opts.mutationId });
        const assertionResults = test.assertions.map((a) => evaluateAssertion(a, trace));
        assertionResults.push(evaluateGoldenOutcome(scenario, trace));
        return {
          trial: i,
          trace_id: trace.trace_id,
          assertion_results: assertionResults,
          passed: assertionResults.every((r) => r.passed),
        };
      }));
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
  const run_id = `run-${opts.mutationId ?? 'baseline'}-${shortId('', { suite: suite.suite_hash, mutation: opts.mutationId }).slice(1, 9)}`;
  const server = new DemoServer(flagsFor(opts.mutationId));
  const schemaHash = hashJson(new InProcessEndpoint(server).listTools() as unknown as JsonObject[]);
  server.domain.close();
  return {
    schema_version: SCHEMA_VERSION,
    run_id,
    suite_id: suite.suite_id,
    suite_hash: suite.suite_hash,
    run_at: new Date().toISOString(),
    agent_id: DEFAULT_POLICIES.map((p) => p.id).join(','),
    server_version: '0.1.0',
    mutation_id: opts.mutationId,
    tool_schema_hash: schemaHash,
    results,
    totals,
  };
}

/* --------------------------- Schema-smoke baseline ------------------------ */

/**
 * Internal PROXY for the schema-generated evaluation class (docs/05
 * §Baseline): (a) order-insensitive tool-schema diff against the unmutated
 * server, (b) one smoke call per tool with schema-synthesised valid
 * arguments, asserting a non-error result. This stands in for external OSS
 * baselines (e.g. mcp-eval), which cannot be installed offline; the external
 * comparison is a network-gated manual step (docs/19). Results are labelled
 * `schema-smoke-proxy` everywhere to prevent overclaiming.
 */
export interface BaselineResult {
  baseline: 'schema-smoke-proxy';
  mutation_id: string | null;
  schema_changed: boolean;
  smoke_failures: { tool: string; error_code: string | null }[];
  detected: boolean;
}

export function runSchemaSmokeBaseline(mutationId: string | null, fixture: FixtureFile): BaselineResult {
  const reference = new DemoServer(flagsFor(null));
  const referenceHash = orderInsensitiveSchemaHash(reference);
  reference.domain.close();

  const server = new DemoServer(flagsFor(mutationId));
  server.domain.reset(fixture.rows as never);
  const currentHash = orderInsensitiveSchemaHash(server);
  const smoke_failures: { tool: string; error_code: string | null }[] = [];
  for (const tool of server.toolSpecs()) {
    const args: JsonObject = {};
    for (const p of tool.params) {
      if (!p.required) continue;
      if (p.type === 'integer') args[p.name] = 1;
      else if (p.type === 'boolean') args[p.name] = true;
      else args[p.name] = p.enum ? p.enum[0]! : p.name.toLowerCase().includes('title') ? 'smoke task' : 'smoke';
    }
    const result = server.callTool(tool.name, args);
    if (result.status === 'error') smoke_failures.push({ tool: tool.name, error_code: result.error_code });
  }
  server.domain.close();
  const schema_changed = currentHash !== referenceHash;
  return {
    baseline: 'schema-smoke-proxy',
    mutation_id: mutationId,
    schema_changed,
    smoke_failures,
    detected: schema_changed || smoke_failures.length > 0,
  };
}

function orderInsensitiveSchemaHash(server: DemoServer): string {
  const tools = [...server.toolSpecs()].sort((a, b) => a.name.localeCompare(b.name));
  return hashJson(tools as unknown as JsonObject[]);
}

/* ------------------------------ Comparison -------------------------------- */

export function compareRuns(baseline: SuiteRunResult, current: SuiteRunResult): ComparisonReport {
  const key = (r: TestRunResult) => `${r.candidate_id}::${r.scenario_id}`;
  const base = new Map(baseline.results.map((r) => [key(r), r]));
  const regressions: RegressionFinding[] = [];
  const newPasses: RegressionFinding[] = [];
  const unstable: RegressionFinding[] = [];
  let unchanged = 0;
  for (const r of current.results) {
    const b = base.get(key(r));
    const failedAssertions = r.trials
      .flatMap((t) => t.assertion_results)
      .filter((a) => !a.passed)
      .filter((a, i, arr) => arr.findIndex((x) => x.assertion_id === a.assertion_id) === i);
    const finding: RegressionFinding = {
      candidate_id: r.candidate_id,
      scenario_id: r.scenario_id,
      failed_assertions: failedAssertions,
      classification: r.unstable ? 'unstable' : r.passed ? 'new_pass' : 'regression',
    };
    if (r.unstable) unstable.push(finding);
    else if (b && b.passed && !r.passed) regressions.push(finding);
    else if (b && !b.passed && r.passed) newPasses.push(finding);
    else unchanged += 1;
  }
  return {
    schema_version: SCHEMA_VERSION,
    baseline_run_id: baseline.run_id,
    current_run_id: current.run_id,
    mutation_id: current.mutation_id,
    regressions,
    new_passes: newPasses,
    unstable,
    summary: {
      regressed: regressions.length,
      improved: newPasses.length,
      unchanged,
      unstable: unstable.length,
    },
  };
}
