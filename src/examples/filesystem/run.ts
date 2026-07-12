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
import { FS_SCENARIOS, fsScenarioById } from './scenarios.js';
import { FS_DEFAULT_POLICIES } from './policy.js';
import { recordFsSession } from './record.js';
import { verifyFsOutcome, evaluateFsAssertion, evaluateFsGoldenOutcome } from './verifier.js';
import { normalizeFsTrace, mineFsAll } from './mine.js';
import { FsServer } from './server.js';
import { createSandbox, destroySandbox } from './fixtures.js';
import { fsFlagsFor } from './mutations.js';

/**
 * Filesystem replay + baseline (Phase 4, docs/26). Parallels src/pipeline/run.ts
 * for the task server; `compileSuite` and `compareRuns` are reused from there
 * unchanged (they are server-agnostic) — see src/cli/main.ts and experiment.ts.
 */

/* --------------------------- verify + normalize --------------------------- */

export function verifyAndNormalizeAllFs(store: Store): { verified: number; labels: Record<string, number> } {
  const labels: Record<string, number> = {};
  const raws = store.loadRawTraces();
  for (const raw of raws) {
    const outcome = verifyFsOutcome(fsScenarioById(raw.scenario_id), raw);
    store.appendOutcome(outcome);
    store.appendNormalizedTrace(normalizeFsTrace(raw, outcome));
    labels[outcome.label] = (labels[outcome.label] ?? 0) + 1;
  }
  return { verified: raws.length, labels };
}

/** Mine non-holdout normalized traces, annotate with provenance/risk (never auto-approved). */
export function mineFsIsolated(store: Store, instability: RecordingInstabilityResult[]): CandidateTest[] {
  const eligible = store.loadNormalizedTraces().filter((t) => t.partition !== 'holdout');
  return annotateCandidates(mineFsAll(eligible), eligible, instability);
}

/* ------------------------------- Replay ---------------------------------- */

export interface FsReplayOptions {
  mutationId: string | null;
  partitions: Scenario['partition'][];
}

export async function replayFsSuite(suite: ApprovedSuite, opts: FsReplayOptions): Promise<SuiteRunResult> {
  const results: TestRunResult[] = [];
  for (const test of suite.tests) {
    const scenarios = FS_SCENARIOS.filter((sc) => sc.family === test.scenario_family && opts.partitions.includes(sc.partition));
    for (const scenario of scenarios) {
      const trials: TrialResult[] = await Promise.all(
        FS_DEFAULT_POLICIES.map(async (policy, i) => {
          const trace = await recordFsSession({ scenario, policy, mutationId: opts.mutationId });
          const assertionResults = test.assertions.filter((a) => a.stable).map((a) => evaluateFsAssertion(a, trace));
          assertionResults.push(evaluateFsGoldenOutcome(scenario, trace));
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
  const schemaHash = hashJson(new FsServer('.', fsFlagsFor(opts.mutationId)).toolSpecs() as unknown as JsonObject[]);
  return {
    schema_version: SCHEMA_VERSION,
    run_id: `fs-run-${opts.mutationId ?? 'baseline'}-${shortId('', { suite: suite.suite_hash, mutation: opts.mutationId }).slice(1, 9)}`,
    suite_id: suite.suite_id,
    suite_hash: suite.suite_hash,
    run_at: new Date().toISOString(),
    agent_id: FS_DEFAULT_POLICIES.map((p) => p.id).join(','),
    server_version: '0.1.0',
    mutation_id: opts.mutationId,
    tool_schema_hash: schemaHash,
    results,
    totals,
  };
}

/* --------------------------- Schema-smoke baseline ------------------------ */

/**
 * A deliberately NAIVE schema baseline for the filesystem server: an
 * order-sensitive hash of the tool schema plus one smoke call per tool with
 * known-good arguments, asserting a non-error result. It stands in for a naive
 * "snapshot the tool schema + does each tool run" check. It CANNOT see
 * behavioural regressions where the schema is unchanged and the smoke call
 * still returns ok — which is exactly the gap the mined + golden suite fills.
 * Labelled `fs-schema-smoke-proxy` everywhere to prevent overclaiming.
 */
export interface FsBaselineResult {
  baseline: 'fs-schema-smoke-proxy';
  mutation_id: string | null;
  schema_changed: boolean;
  smoke_failures: { tool: string; error_code: string | null }[];
  detected: boolean;
}

const SMOKE_ARGS: Record<string, JsonObject> = {
  read_file: { path: 'notes/todo.txt' },
  write_file: { path: 'reports/smoke-out.txt', content: 'smoke' },
  append_file: { path: 'notes/todo.txt', content: 'smoke' },
  list_dir: { path: 'notes' },
  stat_path: { path: 'notes/todo.txt' },
  delete_file: { path: 'tmp/old.txt' },
  move_file: { from: 'tmp/keep.txt', to: 'archive/keep.txt' },
  copy_file: { from: 'notes/ideas.txt', to: 'archive/ideas.txt' },
  search_files: { query: 'plan' },
};

export function runFsSchemaSmokeBaseline(mutationId: string | null): FsBaselineResult {
  const referenceHash = hashJson(new FsServer('.', fsFlagsFor(null)).toolSpecs() as unknown as JsonObject[]);
  const currentHash = hashJson(new FsServer('.', fsFlagsFor(mutationId)).toolSpecs() as unknown as JsonObject[]);
  const smoke_failures: { tool: string; error_code: string | null }[] = [];
  for (const tool of new FsServer('.', fsFlagsFor(mutationId)).toolSpecs()) {
    const root = createSandbox();
    try {
      const server = new FsServer(root, fsFlagsFor(mutationId));
      const result = server.callTool(tool.name, SMOKE_ARGS[tool.name] ?? {});
      if (result.status === 'error') smoke_failures.push({ tool: tool.name, error_code: result.error_code });
    } finally {
      destroySandbox(root);
    }
  }
  const schema_changed = currentHash !== referenceHash;
  return {
    baseline: 'fs-schema-smoke-proxy',
    mutation_id: mutationId,
    schema_changed,
    smoke_failures,
    detected: schema_changed || smoke_failures.length > 0,
  };
}
