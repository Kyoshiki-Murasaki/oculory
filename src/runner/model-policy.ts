import { createHash } from 'node:crypto';
import type { JsonObject, Scenario, ToolSpec } from '../schema/types.js';
import type { McpToolResult } from '../mcp/mcp.js';
import { toolSpecToJsonSchema } from '../mcp/mcp.js';
import type { AgentPolicy, AgentRunMetadata, StepSink } from './policies.js';

/**
 * Real model-driven traffic (Phase 2, docs/19 §1 / docs/22 Gate G2).
 *
 * Everything here is ADDITIVE: the scripted pipeline (policies.ts's
 * PlannerBase, and every non-model call site of recordSession) is untouched.
 * A ModelPolicy is just another `AgentPolicy` implementation, executed
 * through the exact same `sink.call()` / `InProcessEndpoint` path scripted
 * policies use — it never talks to the demo server directly.
 *
 * HONESTY NOTE: this has not been exercised against a live OpenAI endpoint
 * in this environment (no network egress, no API key here). The wire format
 * below follows OpenAI's Chat Completions tool-calling contract as
 * documented; if it has drifted, that will surface as a clear HTTP or parse
 * error from OpenAiClient.complete(), not a silent misbehaviour. Every test
 * in test/model-policy.test.ts exercises this file through the stubbed
 * ModelClient below — none of them call a real API.
 */

/* ------------------------------ ModelClient ------------------------------- */

export interface ModelToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: JsonObject };
}

export interface ModelToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON text exactly as the provider sent it — may be malformed; ModelPolicy validates it before use. */
  argumentsJson: string;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Required on 'tool' messages: which tool_call this is answering. */
  tool_call_id?: string;
  /** Present on 'assistant' messages that requested tool calls. */
  tool_calls?: ModelToolCallRequest[];
}

export interface ModelCompletionRequest {
  model: string;
  temperature: number;
  messages: ModelMessage[];
  tools: ModelToolDef[];
}

export interface ModelUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface ModelCompletionResult {
  content: string | null;
  tool_calls: ModelToolCallRequest[] | null;
  usage: ModelUsage | null;
}

/**
 * The injectable seam. Production code uses OpenAiClient; tests inject a
 * hand-written stub. No test anywhere may construct an OpenAiClient.
 */
export interface ModelClient {
  readonly provider: string;
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResult>;
}

/* -------------------------------- Errors ----------------------------------- */

export class ModelPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelPolicyError';
  }
}

export class BudgetExceededError extends ModelPolicyError {
  constructor(spentUsd: number, budgetUsd: number) {
    super(
      `budget exceeded: $${spentUsd.toFixed(4)} spent of a $${budgetUsd.toFixed(2)} cap — refusing further model calls (fail closed, not a silent truncation)`,
    );
    this.name = 'BudgetExceededError';
  }
}

/* ------------------------------- OpenAI client ------------------------------ */

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

interface OpenAiChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiClient implements ModelClient {
  readonly provider = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = OPENAI_CHAT_COMPLETIONS_URL,
  ) {
    if (!apiKey) throw new Error('OpenAiClient: apiKey is required (read it from OPENAI_API_KEY yourself — never hardcode it)');
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResult> {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: request.model,
        temperature: request.temperature,
        messages: request.messages.map(toOpenAiWireMessage),
        tools: request.tools,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable response body>');
      throw new Error(`OpenAiClient: HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as OpenAiChatCompletionResponse;
    const message = json.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      argumentsJson: tc.function.arguments,
    }));
    return {
      content: message?.content ?? null,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      usage: json.usage
        ? { input_tokens: json.usage.prompt_tokens ?? null, output_tokens: json.usage.completion_tokens ?? null }
        : null,
    };
  }
}

function toOpenAiWireMessage(m: ModelMessage): JsonObject {
  const out: JsonObject = { role: m.role, content: m.content };
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.tool_calls && m.tool_calls.length > 0) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.argumentsJson },
    }));
  }
  return out;
}

/* ------------------------------ Cost estimation ----------------------------- */

/**
 * Approximate USD per 1M tokens. NOT authoritative pricing — verify at
 * platform.openai.com/pricing. This exists so the budget guard and trace
 * metadata have a number rather than nothing; treat cost_usd on any trace
 * as an estimate, never a billing record.
 */
export const APPROX_PRICING_USD_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
};
const FALLBACK_PRICING_USD_PER_1M_TOKENS = { input: 1.0, output: 3.0 };

export function estimateCostUsd(model: string, usage: ModelUsage | null): number | null {
  if (!usage || usage.input_tokens === null || usage.output_tokens === null) return null;
  const price = APPROX_PRICING_USD_PER_1M_TOKENS[model] ?? FALLBACK_PRICING_USD_PER_1M_TOKENS;
  return (usage.input_tokens / 1_000_000) * price.input + (usage.output_tokens / 1_000_000) * price.output;
}

/* -------------------------------- ModelPolicy -------------------------------- */

export const DEFAULT_MAX_TOOL_CALLS = 6;
export const DEFAULT_BUDGET_USD = 5;
/** Default model when none is passed. Small, cheap, tool-calling capable. */
export const DEFAULT_MODEL = 'gpt-4.1-mini';

const DEFAULT_SYSTEM_PROMPT =
  'You are an assistant that manages tasks in a task tracker using only the tools provided. ' +
  'Call tools as needed to satisfy the request, then reply with a short plain-text final answer.';

export interface ModelPolicyOptions {
  client: ModelClient;
  model: string;
  /** Default 0 for reproducibility-leaning behaviour. Not every model honours this. */
  temperature?: number;
  maxToolCalls?: number;
  /** Hard per-policy-instance USD cap, cumulative across every run() call this instance makes. null = no cap (not recommended). Default $5. */
  budgetUsd?: number | null;
  systemPrompt?: string;
}

/**
 * Real-model AgentPolicy. One instance accumulates cost across every
 * scenario it records in a single CLI invocation (the CLI constructs one
 * instance per `record` command and reuses it in the scenario loop), so the
 * budget guard is a genuine per-run cap, not per-scenario.
 */
export class ModelPolicy implements AgentPolicy {
  readonly kind = 'model';
  readonly id: string;

  private readonly temperature: number;
  private readonly maxToolCalls: number;
  private readonly budgetUsd: number | null;
  private readonly systemPrompt: string;
  /** Lifetime spend across every run() call this instance has made — what the budget guard checks. */
  private lifetimeCostUsd = 0;
  private lastMeta: AgentRunMetadata | null = null;

  constructor(private readonly opts: ModelPolicyOptions) {
    this.temperature = opts.temperature ?? 0;
    this.maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.budgetUsd = opts.budgetUsd === undefined ? DEFAULT_BUDGET_USD : opts.budgetUsd;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.id = `model/${opts.client.provider}/${opts.model}`;
  }

  lastRunMetadata(): AgentRunMetadata | null {
    return this.lastMeta;
  }

  /** Lifetime spend across every run() call this instance has made so far (what the budget guard checks against). */
  spentSoFarUsd(): number {
    return this.lifetimeCostUsd;
  }

  async run(scenario: Scenario, tools: ToolSpec[], sink: StepSink): Promise<string> {
    const modelTools = toOpenAiTools(tools);
    const systemPromptDigest = sha256Hex(this.systemPrompt);
    const messages: ModelMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: scenario.wording_variants[0] ?? scenario.intent_template },
    ];

    let toolCallCount = 0;
    // Local to THIS run() call (one scenario/trace), unlike lifetimeCostUsd —
    // a trace's own metadata should show what that session cost, not the
    // instance's running total across every scenario recorded so far.
    let sessionCostUsd = 0;
    let sessionTokensIn: number | null = null;
    let sessionTokensOut: number | null = null;

    for (;;) {
      if (this.budgetUsd !== null && this.lifetimeCostUsd >= this.budgetUsd) {
        throw new BudgetExceededError(this.lifetimeCostUsd, this.budgetUsd);
      }

      const result = await this.opts.client.complete({
        model: this.opts.model,
        temperature: this.temperature,
        messages,
        tools: modelTools,
      });

      const stepCost = estimateCostUsd(this.opts.model, result.usage);
      if (stepCost !== null) {
        sessionCostUsd += stepCost;
        this.lifetimeCostUsd += stepCost;
      }
      if (result.usage?.input_tokens !== null && result.usage?.input_tokens !== undefined) {
        sessionTokensIn = (sessionTokensIn ?? 0) + result.usage.input_tokens;
      }
      if (result.usage?.output_tokens !== null && result.usage?.output_tokens !== undefined) {
        sessionTokensOut = (sessionTokensOut ?? 0) + result.usage.output_tokens;
      }
      this.lastMeta = {
        provider: this.opts.client.provider,
        model: this.opts.model,
        temperature: this.temperature,
        tokens_in: sessionTokensIn,
        tokens_out: sessionTokensOut,
        cost_usd: sessionCostUsd === 0 && stepCost === null ? null : Math.round(sessionCostUsd * 1e6) / 1e6,
        system_prompt_digest: systemPromptDigest,
      };

      if (!result.tool_calls || result.tool_calls.length === 0) {
        return result.content ?? '';
      }

      messages.push({ role: 'assistant', content: result.content ?? '', tool_calls: result.tool_calls });

      for (const call of result.tool_calls) {
        if (toolCallCount >= this.maxToolCalls) {
          return `Stopped after reaching the maximum of ${this.maxToolCalls} tool calls.`;
        }
        toolCallCount += 1;

        if (!tools.some((t) => t.name === call.name)) {
          throw new ModelPolicyError(
            `model requested unknown tool '${call.name}' — not one of the ${tools.length} tools it was given (${tools.map((t) => t.name).join(', ')})`,
          );
        }

        let args: JsonObject;
        try {
          const parsed: unknown = JSON.parse(call.argumentsJson || '{}');
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('parsed arguments are not a JSON object');
          }
          args = parsed as JsonObject;
        } catch (err) {
          throw new ModelPolicyError(
            `model emitted invalid JSON arguments for tool '${call.name}': ${JSON.stringify(call.argumentsJson).slice(0, 300)} (${err instanceof Error ? err.message : String(err)})`,
          );
        }

        const toolResult: McpToolResult = sink.call(call.name, args);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ status: toolResult.status, error_code: toolResult.error_code, payload: toolResult.payload }),
        });
      }
    }
  }
}

export function toOpenAiTools(tools: ToolSpec[]): ModelToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: toolSpecToJsonSchema(t) },
  }));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
