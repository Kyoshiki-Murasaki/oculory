/**
 * Minimal structural validator.
 *
 * DECISION (docs/03 §Dependencies): Zod is the intended validator, but this
 * environment has no network access, so a hand-rolled subset with the same
 * call-site shape is used. Swapping to Zod is a mechanical change confined
 * to this file: each `Shape` maps 1:1 onto a `z.object(...)`.
 */
import type { Json, JsonObject } from './types.js';

export class ValidationError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ValidationError';
  }
}

type Check = (v: Json, path: string) => void;

export const is = {
  string(): Check {
    return (v, p) => {
      if (typeof v !== 'string') throw new ValidationError(p, `expected string, got ${typeName(v)}`);
    };
  },
  number(): Check {
    return (v, p) => {
      if (typeof v !== 'number' || !Number.isFinite(v))
        throw new ValidationError(p, `expected finite number, got ${typeName(v)}`);
    };
  },
  integer(): Check {
    return (v, p) => {
      if (typeof v !== 'number' || !Number.isInteger(v))
        throw new ValidationError(p, `expected integer, got ${typeName(v)}`);
    };
  },
  boolean(): Check {
    return (v, p) => {
      if (typeof v !== 'boolean') throw new ValidationError(p, `expected boolean, got ${typeName(v)}`);
    };
  },
  literal(...allowed: (string | number | boolean | null)[]): Check {
    return (v, p) => {
      if (!allowed.includes(v as string)) {
        throw new ValidationError(p, `expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(v)}`);
      }
    };
  },
  nullable(inner: Check): Check {
    return (v, p) => {
      if (v === null) return;
      inner(v, p);
    };
  },
  array(inner: Check): Check {
    return (v, p) => {
      if (!Array.isArray(v)) throw new ValidationError(p, `expected array, got ${typeName(v)}`);
      v.forEach((item, i) => inner(item, `${p}[${i}]`));
    };
  },
  object(shape: Record<string, Check>, opts: { optional?: string[]; open?: boolean } = {}): Check {
    const optional = new Set(opts.optional ?? []);
    return (v, p) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v))
        throw new ValidationError(p, `expected object, got ${typeName(v)}`);
      const obj = v as JsonObject;
      for (const [key, check] of Object.entries(shape)) {
        if (!(key in obj)) {
          if (optional.has(key)) continue;
          throw new ValidationError(`${p}.${key}`, 'missing required field');
        }
        check(obj[key]!, `${p}.${key}`);
      }
      if (!opts.open) {
        for (const key of Object.keys(obj)) {
          if (!(key in shape)) throw new ValidationError(`${p}.${key}`, 'unexpected field');
        }
      }
    };
  },
  anyJson(): Check {
    return () => undefined;
  },
};

function typeName(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function validate(value: Json, check: Check, root = '$'): void {
  check(value, root);
}

/* --------------------- Artifact validators ------------------------------ */

const toolSpec = is.object(
  {
    name: is.string(),
    description: is.string(),
    params: is.array(
      is.object(
        {
          name: is.string(),
          type: is.literal('string', 'integer', 'boolean'),
          required: is.boolean(),
          description: is.string(),
          enum: is.array(is.string()),
        },
        { optional: ['enum'] },
      ),
    ),
  },
);

const envSnapshot = is.object({ state_hash: is.string(), rows: is.array(is.anyJson()) });

export const rawTraceCheck = is.object({
  schema_version: is.literal(2),
  trace_id: is.string(),
  session_id: is.string(),
  recorded_at: is.string(),
  scenario_id: is.string(),
  scenario_family: is.string(),
  partition: is.literal('smoke', 'mining', 'holdout', 'adversarial'),
  agent: is.object({
    kind: is.literal('model', 'scripted'),
    id: is.string(),
    temperature: is.nullable(is.number()),
    seed: is.nullable(is.integer()),
    // schema_version 2+ (Phase 2 model traffic): always null for kind:'scripted'.
    provider: is.nullable(is.string()),
    model: is.nullable(is.string()),
    tokens_in: is.nullable(is.number()),
    tokens_out: is.nullable(is.number()),
    cost_usd: is.nullable(is.number()),
    budget_usd: is.nullable(is.number()),
  }),
  client: is.string(),
  user_intent: is.string(),
  system_prompt_digest: is.nullable(is.string()),
  tool_schema_hash: is.string(),
  tools: is.array(toolSpec),
  fixture_id: is.string(),
  env_before: envSnapshot,
  steps: is.array(
    is.object({
      index: is.integer(),
      type: is.literal('tool_call'),
      tool: is.string(),
      args: is.anyJson(),
      result_status: is.literal('ok', 'error'),
      error_code: is.nullable(is.string()),
      result_digest: is.string(),
      result_summary: is.anyJson(),
      state_changed: is.boolean(),
      latency_ms: is.number(),
    }),
  ),
  final_response: is.nullable(is.string()),
  env_after: envSnapshot,
  server_version: is.string(),
  mutation_id: is.nullable(is.string()),
  // schema_version 2+: recording-time trial index (model --trials N), else null.
  trial: is.nullable(is.integer()),
});

export const scenarioCheck = is.object({
  schema_version: is.literal(2),
  scenario_id: is.string(),
  family: is.string(),
  partition: is.literal('smoke', 'mining', 'holdout', 'adversarial'),
  fixture_id: is.string(),
  intent_template: is.string(),
  wording_variants: is.array(is.string()),
  intent: is.anyJson(),
  expected_behaviour: is.string(),
  acceptable_tool_paths: is.array(is.array(is.string())),
  prohibited_tools: is.array(is.string()),
  expect_error: is.nullable(is.string()),
  preconditions: is.array(is.anyJson()),
  postconditions: is.array(is.anyJson()),
  ambiguity: is.literal('none', 'entity', 'tool', 'intent'),
  difficulty: is.literal('easy', 'medium', 'hard'),
  rationale: is.string(),
});

export const suiteCheck = is.object({
  schema_version: is.literal(2),
  suite_id: is.string(),
  created_at: is.string(),
  suite_hash: is.string(),
  tests: is.array(is.anyJson()),
});
