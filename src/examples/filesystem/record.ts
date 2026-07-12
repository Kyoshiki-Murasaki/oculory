import { performance } from 'node:perf_hooks';
import type { JsonObject, RawTrace, Scenario, ToolCallStep, ToolSpec } from '../../schema/types.js';
import { SCHEMA_VERSION } from '../../schema/types.js';
import { hashJson, shortId } from '../../schema/canonical.js';
import { rawTraceCheck, validate } from '../../schema/validate.js';
import type { AgentPolicy, AgentRunMetadata } from '../../runner/policies.js';
import type { McpToolResult } from '../../mcp/mcp.js';
import { FsServer, FS_SERVER_VERSION, fsSnapshot } from './server.js';
import { fsFlagsFor } from './mutations.js';
import { createSandbox, destroySandbox, FS_BASE_TREE, FS_FIXTURE_ID } from './fixtures.js';

/**
 * Record one filesystem session (Phase 4, docs/26). Parallels
 * src/runner/record.ts for the task server: a FRESH sandbox is created per
 * session, the policy runs through a step-capturing sink, per-step snapshots
 * detect state changes, and a validated RawTrace comes out. The sandbox is
 * always destroyed afterwards (finally) so no scenario shares mutable state and
 * nothing is left on disk.
 */
export async function recordFsSession(opts: {
  scenario: Scenario;
  policy: AgentPolicy;
  mutationId: string | null;
  trial?: number | null;
  budgetUsd?: number | null;
  tree?: Record<string, string>;
}): Promise<RawTrace> {
  const { scenario, policy, mutationId } = opts;
  const root = createSandbox(opts.tree ?? FS_BASE_TREE);
  try {
    const server = new FsServer(root, fsFlagsFor(mutationId));
    const tools: ToolSpec[] = server.toolSpecs();
    const toolSchemaHash = hashJson(tools as unknown as JsonObject[]);
    const envBefore = fsSnapshot(root);

    const steps: ToolCallStep[] = [];
    let lastHash = envBefore.state_hash;
    const sink = {
      call(tool: string, args: JsonObject): McpToolResult {
        const t0 = performance.now();
        const result = server.callTool(tool, args) as McpToolResult;
        const latency = performance.now() - t0;
        const snap = fsSnapshot(root);
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
    const envAfter = fsSnapshot(root);
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
      client: 'oculory-fs-traffic-runner',
      user_intent: intent,
      system_prompt_digest: meta?.system_prompt_digest ?? null,
      tool_schema_hash: toolSchemaHash,
      tools,
      fixture_id: opts.tree ? 'fs-sandbox-custom' : FS_FIXTURE_ID,
      env_before: envBefore,
      steps,
      final_response: finalResponse,
      env_after: envAfter,
      server_version: FS_SERVER_VERSION,
      mutation_id: mutationId,
      trial: opts.trial ?? null,
    };
    validate(trace as unknown as never, rawTraceCheck);
    return trace;
  } finally {
    destroySandbox(root);
  }
}

/** Extract the small, mining-relevant fields from a filesystem tool result. */
function summarize(tool: string, result: McpToolResult, stateChanged: boolean): JsonObject {
  const summary: JsonObject = { changed: stateChanged };
  if (result.status !== 'ok' || result.payload === null || typeof result.payload !== 'object' || Array.isArray(result.payload)) {
    return summary;
  }
  const p = result.payload as JsonObject;
  if (tool === 'read_file' && typeof p.content === 'string') summary.content = p.content;
  else if (tool === 'list_dir' && Array.isArray(p.entries)) {
    summary.paths = (p.entries as JsonObject[]).map((e) => String((e as JsonObject).name));
  } else if (tool === 'search_files' && Array.isArray(p.matches)) {
    summary.paths = (p.matches as unknown[]).map((m) => String(m));
  } else if (tool === 'stat_path') {
    if (typeof p.exists === 'boolean') summary.exists = p.exists;
    if (p.type !== undefined) summary.type = p.type;
  }
  return summary;
}
