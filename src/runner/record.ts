import { performance } from 'node:perf_hooks';
import type { JsonObject, RawTrace, Scenario, ToolCallStep, ToolSpec } from '../schema/types.js';
import { SCHEMA_VERSION } from '../schema/types.js';
import { hashJson, shortId } from '../schema/canonical.js';
import { rawTraceCheck, validate } from '../schema/validate.js';
import { DemoServer } from '../server/tools.js';
import { flagsFor } from '../server/mutations.js';
import type { AgentPolicy, AgentRunMetadata } from './policies.js';
import { InProcessEndpoint } from '../mcp/mcp.js';

export interface FixtureFile {
  fixture_id: string;
  rows: JsonObject[];
}

/**
 * Records one session: fresh server + fixture reset, policy execution through
 * a step-capturing sink, per-step state snapshots, validated RawTrace out.
 * Environment reset per session is what makes replay deterministic (docs/05).
 */
export async function recordSession(opts: {
  scenario: Scenario;
  policy: AgentPolicy;
  fixture: FixtureFile;
  mutationId: string | null;
  intentOverride?: string;
  /** Recording-time trial index (model `--trials N>1` only). Folded into
   *  trace_id ONLY when provided, so every pre-existing (non-trial) call
   *  site keeps its exact original trace_id derivation. */
  trial?: number | null;
  /** The hard per-run USD cap in force, stamped onto the trace for audit. */
  budgetUsd?: number | null;
}): Promise<RawTrace> {
  const { scenario, policy, fixture, mutationId } = opts;
  const server = new DemoServer(flagsFor(mutationId));
  server.domain.reset(fixture.rows as never);
  const endpoint = new InProcessEndpoint(server);

  const tools: ToolSpec[] = endpoint.listTools();
  const toolSchemaHash = hashJson(tools as unknown as JsonObject[]);
  const envBefore = server.domain.snapshot();

  const steps: ToolCallStep[] = [];
  let lastHash = envBefore.state_hash;
  const sink = {
    call(tool: string, args: JsonObject) {
      const t0 = performance.now();
      const result = endpoint.callTool(tool, args);
      const latency = performance.now() - t0;
      const snap = server.domain.snapshot();
      const summary: JsonObject = {};
      if (result.payload !== null && typeof result.payload === 'object' && !Array.isArray(result.payload)) {
        const p = result.payload as JsonObject;
        if (Array.isArray(p.tasks)) {
          summary.ids = p.tasks.map((t) => (t && typeof t === 'object' ? ((t as JsonObject).id as number) : -1));
        }
        if (p.task && typeof p.task === 'object') summary.id = (p.task as JsonObject).id ?? null;
        if (typeof p.changed === 'boolean') summary.changed = p.changed;
      }
      steps.push({
        index: steps.length,
        type: 'tool_call',
        tool,
        args,
        result_status: result.status,
        error_code: result.error_code,
        result_digest: hashJson(result.payload),
        result_summary: summary,
        state_changed: snap.state_hash !== lastHash,
        latency_ms: Math.round(latency * 1000) / 1000,
      });
      lastHash = snap.state_hash;
      return result;
    },
  };

  const intent = opts.intentOverride ?? scenario.wording_variants[0] ?? scenario.intent_template;
  const finalResponse = await policy.run(scenario, tools, sink);
  const envAfter = server.domain.snapshot();
  server.domain.close();

  // Real (non-scripted) policies may expose usage/cost for this run; scripted
  // policies implement no such method, so this is null and every new agent
  // field below stays null — identical to pre-Phase-2 traces in substance.
  const meta: AgentRunMetadata | null = policy.lastRunMetadata?.() ?? null;

  const traceIdInput: JsonObject = {
    scenario: scenario.scenario_id,
    policy: policy.id,
    mutation: mutationId,
    intent,
  };
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
    client: 'oculory-traffic-runner',
    user_intent: intent,
    system_prompt_digest: meta?.system_prompt_digest ?? null,
    tool_schema_hash: toolSchemaHash,
    tools,
    fixture_id: fixture.fixture_id,
    env_before: envBefore,
    steps,
    final_response: finalResponse,
    env_after: envAfter,
    server_version: '0.1.0',
    mutation_id: mutationId,
    trial: opts.trial ?? null,
  };
  validate(trace as unknown as never, rawTraceCheck);
  return trace;
}
