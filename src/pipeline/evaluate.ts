import type { Assertion, AssertionResult, Json, JsonObject, RawTrace, Scenario } from '../schema/types.js';
import { extractEntities } from './entities.js';
import { verifyOutcome } from './verify.js';

/**
 * Deterministic evaluator (docs/07 §Evaluation semantics).
 * Every assertion type has exact pass/fail semantics against a replayed
 * trace. No LLM. `tool_precedes` and `arg_*` are conditional (vacuously true
 * when the referenced tool was not called) — absence itself is judged by
 * `tool_required` / `one_of_tools` so a single behaviour change is reported
 * once, not five times.
 */
export function evaluateAssertion(a: Assertion, trace: RawTrace): AssertionResult {
  const mk = (passed: boolean, detail: string): AssertionResult => ({
    assertion_id: a.assertion_id,
    type: a.type,
    passed,
    detail,
  });
  const steps = trace.steps;
  const toolsUsed = steps.map((s) => s.tool);
  const p = a.params;
  const entities = extractEntities(trace.user_intent);

  const resolveExpected = (expected: Json): Json => {
    if (typeof expected === 'string' && expected.startsWith('@entity:')) {
      const key = expected.slice('@entity:'.length);
      return (entities[key] ?? null) as Json;
    }
    return expected;
  };

  switch (a.type) {
    case 'tool_required':
      return mk(toolsUsed.includes(String(p.tool)), `expected tool '${p.tool}' to be called; called: [${toolsUsed.join(', ')}]`);
    case 'tool_forbidden':
      return mk(!toolsUsed.includes(String(p.tool)), `tool '${p.tool}' must not be called`);
    case 'one_of_tools': {
      const set = (p.tools as string[]) ?? [];
      return mk(set.some((t) => toolsUsed.includes(t)), `expected one of [${set.join(', ')}]; called: [${toolsUsed.join(', ')}]`);
    }
    case 'tool_precedes': {
      const ia = toolsUsed.indexOf(String(p.before));
      const ib = toolsUsed.indexOf(String(p.after));
      if (ia === -1 || ib === -1) return mk(true, 'conditional ordering: one tool absent (vacuous pass)');
      return mk(ia < ib, `expected '${p.before}' before '${p.after}' (indices ${ia}, ${ib})`);
    }
    case 'arg_present': {
      const calls = steps.filter((s) => s.tool === p.tool);
      if (calls.length === 0) return mk(true, 'tool not called (vacuous pass; presence judged by tool_required)');
      const ok = calls.every((c) => String(p.arg) in c.args);
      return mk(ok, `argument '${p.arg}' must be present on every '${p.tool}' call; args seen: ${calls.map((c) => JSON.stringify(Object.keys(c.args))).join(' ')}`);
    }
    case 'arg_equals_entity': {
      const calls = steps.filter((s) => s.tool === p.tool);
      if (calls.length === 0) return mk(true, 'tool not called (vacuous pass)');
      const expected = resolveExpected(String(p.entity));
      if (expected === null) return mk(false, `entity ${p.entity} not extractable from replay intent`);
      const ok = calls.every((c) => c.args[String(p.arg)] === expected);
      return mk(ok, `argument '${p.arg}' on '${p.tool}' must equal ${JSON.stringify(expected)} (${p.entity})`);
    }
    case 'arg_enum': {
      const calls = steps.filter((s) => s.tool === p.tool && String(p.arg) in s.args);
      const allowed = (p.allowed as string[]) ?? [];
      const ok = calls.every((c) => allowed.includes(String(c.args[String(p.arg)])));
      return mk(ok, `argument '${p.arg}' on '${p.tool}' must be in [${allowed.join(', ')}]`);
    }
    case 'max_call_count': {
      const count = steps.filter((s) => s.tool === p.tool).length;
      return mk(count <= Number(p.max), `tool '${p.tool}' called ${count}×, mined ceiling ${p.max}`);
    }
    case 'error_expected': {
      const ok = steps.some((s) => s.result_status === 'error' && s.error_code === p.code);
      const observed = steps.filter((s) => s.result_status === 'error').map((s) => s.error_code);
      return mk(ok, `expected an error with code '${p.code}'; observed error codes: [${observed.join(', ')}]`);
    }
    case 'no_error': {
      const errs = steps.filter((s) => s.result_status === 'error');
      return mk(errs.length === 0, `expected no tool errors; got: [${errs.map((e) => e.error_code).join(', ')}]`);
    }
    case 'state_unchanged':
      return mk(trace.env_after.state_hash === trace.env_before.state_hash, 'environment state must be unchanged');
    case 'retrieval_consistent': {
      const ok = retrievalConsistentRaw(trace);
      return mk(ok, 'last listing/search must return exactly the rows matching its filters');
    }
    case 'state_postcondition': {
      const selKey = String(p.selector_entity);
      const entity = entities[selKey];
      if (entity === undefined) return mk(false, `intent entity '${selKey}' not extractable at replay`);
      const rows = (trace.env_after.rows as JsonObject[]).filter((r) =>
        selKey === 'id' ? r.id === entity : r.title === entity,
      );
      if (String(p.field) === 'exists') {
        return mk((rows.length === 1) === Boolean(p.expected), `row selected by ${selKey}=${JSON.stringify(entity)}: found ${rows.length}`);
      }
      if (rows.length !== 1) return mk(false, `selector ${selKey}=${JSON.stringify(entity)} matched ${rows.length} rows`);
      const expected = resolveExpected(p.expected as Json);
      const observed = rows[0]![String(p.field)] ?? null;
      return mk(observed === expected, `field '${p.field}' expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`);
    }
    case 'outcome_verified':
      return mk(false, 'outcome_verified must be evaluated via evaluateGoldenOutcome');
    default:
      return mk(false, `unknown assertion type '${a.type as string}'`);
  }
}

/** Golden (human-authored scenario ground truth) check — reported separately from mined assertions. */
export function evaluateGoldenOutcome(scenario: Scenario, trace: RawTrace): AssertionResult {
  const outcome = verifyOutcome(scenario, trace);
  const passed = outcome.label === 'verified_success' || outcome.label === 'valid_rejection';
  return {
    assertion_id: 'golden-outcome',
    type: 'outcome_verified',
    passed,
    detail: `deterministic outcome label: ${outcome.label}; ${outcome.evidence.filter((e) => !e.passed).map((e) => e.check).join('; ') || 'all checks passed'}`,
  };
}

function retrievalConsistentRaw(trace: RawTrace): boolean {
  const step = [...trace.steps].reverse().find((s) => s.result_status === 'ok' && Array.isArray(s.result_summary.ids));
  if (!step) return true;
  const returned = new Set(step.result_summary.ids as number[]);
  const rows = trace.env_after.rows as { id: number; title: string; status: string; project: string }[];
  const args = step.args;
  const expected = rows.filter((r) => {
    if (typeof args.query === 'string') return r.title.toLowerCase().includes(args.query.toLowerCase());
    if (typeof args.q === 'string') return r.title.toLowerCase().includes(args.q.toLowerCase());
    if (typeof args.status === 'string' && r.status !== args.status) return false;
    if (typeof args.project === 'string' && r.project !== args.project) return false;
    return true;
  });
  return expected.length === returned.size && expected.every((r) => returned.has(r.id));
}
