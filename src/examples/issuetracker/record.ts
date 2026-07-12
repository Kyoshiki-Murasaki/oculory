import { performance } from 'node:perf_hooks';
import type { JsonObject, RawTrace, Scenario, ToolCallStep, ToolSpec } from '../../schema/types.js';
import { SCHEMA_VERSION } from '../../schema/types.js';
import { hashJson, shortId } from '../../schema/canonical.js';
import { rawTraceCheck, validate } from '../../schema/validate.js';
import type { AgentPolicy, AgentRunMetadata } from '../../runner/policies.js';
import type { McpToolResult } from '../../mcp/mcp.js';
import { IssueTrackerServer, ISSUE_SERVER_VERSION, issueSnapshot, type IssueRecord, type IssueSeed } from './server.js';
import { issueFlagsFor } from './mutations.js';
import { issueSeed, ISSUE_FIXTURE_ID } from './fixtures.js';

/**
 * Record one issue-tracker session (Phase 5, docs/28). Parallels
 * src/runner/record.ts (task) and src/examples/filesystem/record.ts: a FRESH
 * in-memory tracker is created per session from the deterministic seed, the
 * policy runs through a step-capturing sink, per-step snapshots detect state
 * changes, and a validated RawTrace comes out. Nothing is shared between
 * sessions, so no scenario can leak mutable state into another.
 */
export async function recordIssueSession(opts: {
  scenario: Scenario;
  policy: AgentPolicy;
  mutationId: string | null;
  trial?: number | null;
  budgetUsd?: number | null;
  seed?: IssueSeed[];
}): Promise<RawTrace> {
  const { scenario, policy, mutationId } = opts;
  const seed = opts.seed ?? issueSeed();
  const server = new IssueTrackerServer(seed, issueFlagsFor(mutationId));
  const tools: ToolSpec[] = server.toolSpecs();
  const toolSchemaHash = hashJson(tools as unknown as JsonObject[]);
  const envBefore = server.snapshot();

  const steps: ToolCallStep[] = [];
  let lastHash = envBefore.state_hash;
  const sink = {
    call(tool: string, args: JsonObject): McpToolResult {
      const t0 = performance.now();
      const result = server.callTool(tool, args) as McpToolResult;
      const latency = performance.now() - t0;
      const snap = server.snapshot();
      const stateChanged = snap.state_hash !== lastHash;
      steps.push({
        index: steps.length,
        type: 'tool_call',
        tool,
        args,
        result_status: result.status,
        error_code: result.error_code,
        result_digest: hashJson(result.payload),
        result_summary: summarize(tool, result, stateChanged),
        state_changed: stateChanged,
        latency_ms: Math.round(latency * 1000) / 1000,
      });
      lastHash = snap.state_hash;
      return result;
    },
  };

  const intent = scenario.wording_variants[0] ?? scenario.intent_template;
  const finalResponse = await policy.run(scenario, tools, sink);
  const envAfter = server.snapshot();
  const meta: AgentRunMetadata | null = policy.lastRunMetadata?.() ?? null;

  const traceIdInput: JsonObject = { scenario: scenario.scenario_id, policy: policy.id, mutation: mutationId, intent };
  if (opts.trial !== undefined && opts.trial !== null) traceIdInput.trial = opts.trial;

  const trace: RawTrace = {
    schema_version: SCHEMA_VERSION,
    trace_id: shortId('trace', traceIdInput),
    session_id: shortId('sess', { scenario: scenario.scenario_id, policy: policy.id, mutation: mutationId }),
    recorded_at: new Date().toISOString(),
    scenario_id: scenario.scenario_id,
    scenario_family: scenario.family,
    partition: scenario.partition,
    agent: {
      kind: policy.kind,
      id: policy.id,
      temperature: meta?.temperature ?? null,
      seed: policy.kind === 'scripted' ? 0 : null,
      provider: meta?.provider ?? null,
      model: meta?.model ?? null,
      tokens_in: meta?.tokens_in ?? null,
      tokens_out: meta?.tokens_out ?? null,
      cost_usd: meta?.cost_usd ?? null,
      budget_usd: opts.budgetUsd ?? null,
    },
    client: 'oculory-issue-traffic-runner',
    user_intent: intent,
    system_prompt_digest: meta?.system_prompt_digest ?? null,
    tool_schema_hash: toolSchemaHash,
    tools,
    fixture_id: opts.seed ? 'issue-tracker-custom' : ISSUE_FIXTURE_ID,
    env_before: envBefore,
    steps,
    final_response: finalResponse,
    env_after: envAfter,
    server_version: ISSUE_SERVER_VERSION,
    mutation_id: mutationId,
    trial: opts.trial ?? null,
  };
  validate(trace as unknown as never, rawTraceCheck);
  return trace;
}

/** Extract the small, mining-relevant fields from an issue-tracker tool result. */
function summarize(tool: string, result: McpToolResult, stateChanged: boolean): JsonObject {
  const summary: JsonObject = { changed: stateChanged };
  if (result.status !== 'ok' || result.payload === null || typeof result.payload !== 'object' || Array.isArray(result.payload)) {
    return summary;
  }
  const p = result.payload as JsonObject;
  if ((tool === 'search_issues' || tool === 'list_issues') && Array.isArray(p.ids)) {
    summary.ids = (p.ids as unknown[]).map((x) => String(x));
  } else if (tool === 'read_issue' && p.issue && typeof p.issue === 'object') {
    summary.issue = issueView(p.issue as JsonObject);
  } else if (p.issue && typeof p.issue === 'object') {
    // create / assign / label / comment / close / reopen: keep the id we touched.
    const issue = p.issue as JsonObject;
    if (typeof issue.id === 'string') summary.id = issue.id;
  }
  return summary;
}

/** A stable subset of an issue used by read_consistent (kept small on purpose). */
function issueView(issue: JsonObject): JsonObject {
  const view: JsonObject = {};
  for (const k of ['id', 'title', 'status', 'assignee', 'priority'] as const) {
    if (issue[k] !== undefined) view[k] = issue[k]!;
  }
  if (Array.isArray(issue.labels)) view.labels = (issue.labels as unknown[]).map((x) => String(x));
  return view;
}

/** Re-export for tests that want to build a bespoke seed then snapshot it. */
export function snapshotIssues(issues: IssueRecord[]): { state_hash: string; rows: JsonObject[] } {
  return issueSnapshot(issues);
}
