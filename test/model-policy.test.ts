import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scenarioById } from '../src/runner/catalogue.js';
import { plannerV1, type StepSink } from '../src/runner/policies.js';
import { recordSession, type FixtureFile } from '../src/runner/record.js';
import { verifyOutcome } from '../src/pipeline/verify.js';
import { assessRecordingInstability } from '../src/pipeline/instability.js';
import { DemoServer } from '../src/server/tools.js';
import { flagsFor } from '../src/server/mutations.js';
import { InProcessEndpoint } from '../src/mcp/mcp.js';
import {
  ModelPolicy,
  ModelPolicyError,
  BudgetExceededError,
  toOpenAiTools,
  DEFAULT_MAX_TOOL_CALLS,
  type ModelClient,
  type ModelCompletionRequest,
  type ModelCompletionResult,
} from '../src/runner/model-policy.js';
import type { JsonObject, ToolSpec, RawTrace, OutcomeLabel } from '../src/schema/types.js';

/**
 * No test in this file calls a real model API. StubModelClient replays a
 * fixed script (or a small deterministic function) instead of hitting the
 * network — the only ModelClient any test ever constructs.
 */
class StubModelClient implements ModelClient {
  readonly provider = 'stub';
  readonly requestsSeen: ModelCompletionRequest[] = [];
  private callIndex = 0;

  constructor(private readonly script: ModelCompletionResult[] | ((callIndex: number) => ModelCompletionResult)) {}

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResult> {
    this.requestsSeen.push(request);
    const i = this.callIndex++;
    if (typeof this.script === 'function') return this.script(i);
    const result = this.script[Math.min(i, this.script.length - 1)];
    if (!result) throw new Error('StubModelClient: script exhausted');
    return result;
  }
}

const fixture = JSON.parse(readFileSync('fixtures/seed.json', 'utf8')) as FixtureFile;

/** In-process demo server + a StepSink identical in shape to the one recordSession builds. */
function freshServerAndSink(): {
  tools: ToolSpec[];
  sink: StepSink;
  calls: { tool: string; args: JsonObject }[];
  close: () => void;
} {
  const server = new DemoServer(flagsFor(null));
  server.domain.reset(fixture.rows as never);
  const endpoint = new InProcessEndpoint(server);
  const calls: { tool: string; args: JsonObject }[] = [];
  const sink: StepSink = {
    call(tool, args) {
      calls.push({ tool, args });
      return endpoint.callTool(tool, args);
    },
  };
  return { tools: endpoint.listTools(), sink, calls, close: () => server.domain.close() };
}

/* ============================== 1. scripted policy still works, async ============================== */

test('scripted policy: async run() is behaviourally identical to before (no I/O, resolves immediately)', async () => {
  const scenario = scenarioById('list_open-m1');
  assert.equal(plannerV1.kind, 'scripted');
  const raw = await recordSession({ scenario, policy: plannerV1, fixture, mutationId: null });
  assert.equal(raw.agent.kind, 'scripted');
  assert.equal(raw.agent.provider, null);
  assert.equal(raw.agent.cost_usd, null);
  assert.equal(raw.agent.budget_usd, null);
  assert.equal(raw.trial, null);
});

/* ============================== 2. OpenAI tool-schema conversion ============================== */

test('toOpenAiTools: reuses toolSpecToJsonSchema and wraps it in OpenAI function-calling shape', () => {
  const tools: ToolSpec[] = [
    { name: 'get_task', description: 'Fetch a task by id.', params: [{ name: 'id', type: 'integer', required: true, description: 'task id' }] },
    {
      name: 'search_tasks',
      description: 'Search by title.',
      params: [
        { name: 'query', type: 'string', required: true, description: 'text' },
        { name: 'limit', type: 'integer', required: false, description: 'max results' },
      ],
    },
  ];
  const defs = toOpenAiTools(tools);
  assert.equal(defs.length, 2);
  assert.deepEqual(defs[0], {
    type: 'function',
    function: {
      name: 'get_task',
      description: 'Fetch a task by id.',
      parameters: { type: 'object', properties: { id: { type: 'integer', description: 'task id' } }, required: ['id'], additionalProperties: false },
    },
  });
  assert.deepEqual((defs[1]!.function.parameters as JsonObject).required, ['query']); // 'limit' is optional, correctly excluded
});

/* ============================== 3. controlled model tool-call loop ============================== */

test('ModelPolicy: executes tool calls through the same sink as scripted policies, then returns the final answer', async () => {
  const scenario = scenarioById('complete_by_id-m1');
  const { tools, sink, calls, close } = freshServerAndSink();
  const client = new StubModelClient([
    { content: null, tool_calls: [{ id: 'call_1', name: 'complete_task', argumentsJson: JSON.stringify({ id: 1 }) }], usage: { input_tokens: 100, output_tokens: 20 } },
    { content: 'Task 1 marked done.', tool_calls: null, usage: { input_tokens: 130, output_tokens: 8 } },
  ]);
  const policy = new ModelPolicy({ client, model: 'gpt-4.1-mini' });
  const finalText = await policy.run(scenario, tools, sink);
  close();

  assert.equal(finalText, 'Task 1 marked done.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool, 'complete_task');
  assert.deepEqual(calls[0]!.args, { id: 1 });

  const meta = policy.lastRunMetadata()!;
  assert.equal(meta.provider, 'stub');
  assert.equal(meta.model, 'gpt-4.1-mini');
  assert.equal(meta.tokens_in, 230); // summed across both completions in this one session
  assert.equal(meta.tokens_out, 28);
  assert.equal(typeof meta.cost_usd, 'number');
  assert.equal(meta.system_prompt_digest?.length, 64); // sha256 hex
});

test('ModelPolicy: tool results (status/error_code/payload) are fed back to the model as a tool message', async () => {
  const scenario = scenarioById('complete_nonexistent-a1');
  const { tools, sink, close } = freshServerAndSink();
  const client = new StubModelClient((i) =>
    i === 0
      ? { content: null, tool_calls: [{ id: 'c1', name: 'get_task', argumentsJson: JSON.stringify({ id: 99999 }) }], usage: null }
      : { content: 'That task does not exist.', tool_calls: null, usage: null },
  );
  const policy = new ModelPolicy({ client, model: 'gpt-4.1-mini' });
  const text = await policy.run(scenario, tools, sink);
  close();

  assert.equal(text, 'That task does not exist.');
  const toolMessage = client.requestsSeen[1]!.messages.find((m) => m.role === 'tool')!;
  const parsed = JSON.parse(toolMessage.content) as { status: string; error_code: string | null };
  assert.equal(parsed.status, 'error');
  assert.equal(parsed.error_code, 'NOT_FOUND');
});

/* ============================== 4. invalid model tool call handling ============================== */

test('ModelPolicy: rejects clearly when the model requests a tool that is not in its own schema', async () => {
  const scenario = scenarioById('list_open-m1');
  const { tools, sink, close } = freshServerAndSink();
  const client = new StubModelClient([{ content: null, tool_calls: [{ id: 'c1', name: 'delete_everything', argumentsJson: '{}' }], usage: null }]);
  const policy = new ModelPolicy({ client, model: 'gpt-4.1-mini' });
  await assert.rejects(
    () => policy.run(scenario, tools, sink),
    (err: unknown) => err instanceof ModelPolicyError && /unknown tool 'delete_everything'/.test(err.message),
  );
  close();
});

test('ModelPolicy: rejects clearly when the model emits malformed JSON arguments', async () => {
  const scenario = scenarioById('list_open-m1');
  const { tools, sink, close } = freshServerAndSink();
  const client = new StubModelClient([{ content: null, tool_calls: [{ id: 'c1', name: 'list_tasks', argumentsJson: '{not valid json' }], usage: null }]);
  const policy = new ModelPolicy({ client, model: 'gpt-4.1-mini' });
  await assert.rejects(
    () => policy.run(scenario, tools, sink),
    (err: unknown) => err instanceof ModelPolicyError && /invalid JSON arguments/.test(err.message),
  );
  close();
});

/* ============================== 5. max-tool-call limit ============================== */

test('ModelPolicy: stops at maxToolCalls instead of looping forever on a model that never stops requesting tools', async () => {
  const scenario = scenarioById('list_open-m1');
  const { tools, sink, calls, close } = freshServerAndSink();
  const client = new StubModelClient(() => ({
    content: null,
    tool_calls: [{ id: 'x', name: 'list_tasks', argumentsJson: '{}' }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
  const policy = new ModelPolicy({ client, model: 'gpt-4.1-mini', maxToolCalls: 3, budgetUsd: null });
  const text = await policy.run(scenario, tools, sink);
  close();
  assert.equal(calls.length, 3);
  assert.match(text, /Stopped after reaching the maximum of 3 tool calls/);
});

test('DEFAULT_MAX_TOOL_CALLS is a small, conservative default', () => {
  assert.ok(DEFAULT_MAX_TOOL_CALLS > 0 && DEFAULT_MAX_TOOL_CALLS <= 10);
});

/* ============================== 6. budget guard ============================== */

test('ModelPolicy: budget guard fails closed once cumulative cost meets the cap — never a silent truncation', async () => {
  const scenario = scenarioById('list_open-m1');
  const { tools, sink, close } = freshServerAndSink();
  // Deliberately unrealistic usage so the cap trips predictably regardless of
  // the approximate pricing table's exact numbers.
  const client = new StubModelClient(() => ({
    content: null,
    tool_calls: [{ id: 'x', name: 'list_tasks', argumentsJson: '{}' }],
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  }));
  const policy = new ModelPolicy({ client, model: 'gpt-4.1-mini', maxToolCalls: 50, budgetUsd: 0.01 });
  await assert.rejects(() => policy.run(scenario, tools, sink), (err: unknown) => err instanceof BudgetExceededError);
  close();
  assert.ok(policy.spentSoFarUsd() > 0, 'at least one call must have been charged before the guard tripped');
});

test('ModelPolicy: budgetUsd defaults to $5 and is stamped onto the trace, not just held in memory', async () => {
  const scenario = scenarioById('list_open-m1');
  const { tools, sink, close } = freshServerAndSink();
  const client = new StubModelClient([{ content: 'ok', tool_calls: null, usage: null }]);
  const policy = new ModelPolicy({ client, model: 'gpt-4.1-mini' }); // budgetUsd omitted -> default
  const raw: RawTrace = await recordSession({ scenario, policy, fixture: fixture, mutationId: null, budgetUsd: 5 });
  close();
  assert.equal(raw.agent.budget_usd, 5);
});

/* ============================== 7. trials & recording-time instability ============================== */

test('assessRecordingInstability: agreeing trials are not flagged unstable', () => {
  const traces = [{ steps: [{ tool: 'list_tasks' }] }, { steps: [{ tool: 'list_tasks' }] }, { steps: [{ tool: 'list_tasks' }] }];
  const outcomes: { label: OutcomeLabel }[] = [{ label: 'verified_success' }, { label: 'verified_success' }, { label: 'verified_success' }];
  const result = assessRecordingInstability('list_open-m1', 'model/stub/x', traces, outcomes);
  assert.equal(result.unstable, false);
  assert.equal(result.trial_count, 3);
});

test('assessRecordingInstability: differing tool sequences across trials are flagged unstable', () => {
  const traces = [{ steps: [{ tool: 'search_tasks' }] }, { steps: [{ tool: 'list_tasks' }] }];
  const outcomes: { label: OutcomeLabel }[] = [{ label: 'verified_success' }, { label: 'verified_success' }];
  const result = assessRecordingInstability('search_readonly-m1', 'model/stub/x', traces, outcomes);
  assert.equal(result.unstable, true);
  assert.match(result.detail, /tool sequences.*DIFFER/);
});

test('assessRecordingInstability: differing outcome labels are flagged unstable even with identical tool sequences', () => {
  const traces = [{ steps: [{ tool: 'complete_task' }] }, { steps: [{ tool: 'complete_task' }] }];
  const outcomes: { label: OutcomeLabel }[] = [{ label: 'verified_success' }, { label: 'verified_failure' }];
  const result = assessRecordingInstability('complete_by_id-m1', 'model/stub/x', traces, outcomes);
  assert.equal(result.unstable, true);
  assert.match(result.detail, /outcome labels.*DIFFER/);
});

test('recording-time instability end-to-end: a model policy that behaves differently across trials is caught', async () => {
  const scenario = scenarioById('complete_by_id-m1');
  const trialTraces: RawTrace[] = [];
  for (let trial = 0; trial < 3; trial++) {
    // Trial 1 (0-indexed) "misbehaves": completes via update_task instead of complete_task.
    const client = new StubModelClient([
      trial === 1
        ? { content: null, tool_calls: [{ id: 'c', name: 'update_task', argumentsJson: JSON.stringify({ id: 1, status: 'done' }) }], usage: null }
        : { content: null, tool_calls: [{ id: 'c', name: 'complete_task', argumentsJson: JSON.stringify({ id: 1 }) }], usage: null },
      { content: 'Done.', tool_calls: null, usage: null },
    ]);
    const policy = new ModelPolicy({ client, model: 'gpt-4.1-mini' });
    trialTraces.push(await recordSession({ scenario, policy, fixture, mutationId: null, trial }));
  }
  assert.deepEqual(trialTraces.map((t) => t.trial), [0, 1, 2]);
  assert.equal(new Set(trialTraces.map((t) => t.trace_id)).size, 3, 'each trial must get a distinct trace_id, not collide');

  const outcomes = trialTraces.map((t) => verifyOutcome(scenario, t));
  const result = assessRecordingInstability(scenario.scenario_id, trialTraces[0]!.agent.id, trialTraces, outcomes);
  assert.equal(result.unstable, true);
});

test('recordSession: trial omitted vs. trial:null produce the identical (pre-Phase-2) trace_id', async () => {
  const scenario = scenarioById('list_open-m1');
  const a = await recordSession({ scenario, policy: plannerV1, fixture, mutationId: null });
  const b = await recordSession({ scenario, policy: plannerV1, fixture, mutationId: null, trial: null });
  assert.equal(a.trace_id, b.trace_id);
});

/* ============================== 8. CLI flag parsing (argument-validation paths only; no network) ============================== */

function cli(args: string[], storeDir: string, env: Record<string, string | undefined> = {}): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', 'dist/src/cli/main.js', ...args, '--store', storeDir], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

test('cli: --policy scripted is an explicit alias for the (unchanged) default scripted policies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oculory-modelcli-'));
  const r = cli(['advanced', 'record', '--smoke', '--policy', 'scripted'], dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /Recorded \d+ traces/);
});

test('cli: --policy model without OPENAI_API_KEY fails clearly and never reaches a network call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oculory-modelcli-'));
  const r = cli(['advanced', 'record', '--smoke', '--policy', 'model'], dir, { OPENAI_API_KEY: '' });
  assert.equal(r.code, 1);
  assert.match(r.err, /OPENAI_API_KEY/);
});

test('cli: --trials 0 is rejected as a usage error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oculory-modelcli-'));
  const r = cli(['advanced', 'record', '--smoke', '--trials', '0'], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /--trials must be a positive integer/);
});

test('cli: --budget-usd 0 is rejected as a usage error before any client is constructed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oculory-modelcli-'));
  const r = cli(['advanced', 'record', '--smoke', '--policy', 'model', '--budget-usd', '0'], dir, { OPENAI_API_KEY: 'sk-test-not-real' });
  assert.equal(r.code, 1);
  assert.match(r.err, /--budget-usd must be a positive number/);
});
