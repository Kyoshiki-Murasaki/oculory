import type {
  Assertion,
  AssertionType,
  CandidateTest,
  GateLevel,
  Json,
  JsonObject,
  NormalizedTrace,
} from '../schema/types.js';
import { SCHEMA_VERSION } from '../schema/types.js';
import { shortId } from '../schema/canonical.js';

/**
 * Assertion miner v1 (docs/07).
 *
 * Principles enforced in code:
 *  - Mines ONLY from traces whose outcome is verified_success or
 *    valid_rejection — observed behaviour never becomes ground truth unless
 *    the intended outcome was deterministically verified, and even then the
 *    output is a CANDIDATE requiring human review (docs/08).
 *  - Deterministic rules only; no LLM anywhere in this module.
 *  - Every assertion carries support/total counts and trace-id provenance.
 *  - Assertions below MIN_SUPPORT traces or below full agreement on
 *    behavioural facts are either dropped or emitted `stable: false`
 *    (advisory), never gate-eligible.
 *  - Values that match an intent entity generalise to `@entity:<key>`
 *    instead of being frozen to the literal observed value (anti-overfit).
 */

export const MINER_ID = 'miner-v1';
const MIN_SUPPORT = 2;

interface FamilyGroup {
  family: string;
  traces: NormalizedTrace[];
}

export function groupByFamily(traces: NormalizedTrace[]): FamilyGroup[] {
  const map = new Map<string, NormalizedTrace[]>();
  for (const t of traces) {
    const arr = map.get(t.scenario_family) ?? [];
    arr.push(t);
    map.set(t.scenario_family, arr);
  }
  return [...map.entries()]
    .map(([family, ts]) => ({ family, traces: ts }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

function mkAssertion(
  type: AssertionType,
  params: JsonObject,
  support: number,
  total: number,
  traceIds: string[],
): Assertion {
  return {
    assertion_id: shortId('as', { type, params }),
    type,
    params,
    confidence: total === 0 ? 0 : Math.round((support / total) * 1000) / 1000,
    support,
    total,
    stable: support >= MIN_SUPPORT && support === total,
    provenance: { trace_ids: traceIds, miner: MINER_ID },
  };
}

/** Resolve a literal value to `@entity:<key>` when it matches the trace's intent entities. */
function generalizeValue(value: Json, entities: JsonObject): string | null {
  for (const [key, ev] of Object.entries(entities)) {
    if (ev === value) return `@entity:${key}`;
  }
  return null;
}

export function mineFamily(group: FamilyGroup): CandidateTest | null {
  // Only deterministically-verified traces may inform assertions.
  const usable = group.traces.filter(
    (t) => t.outcome.label === 'verified_success' || t.outcome.label === 'valid_rejection',
  );
  if (usable.length < MIN_SUPPORT) return null;
  const total = usable.length;
  const ids = usable.map((t) => t.trace_id);
  const assertions: Assertion[] = [];
  const risks: string[] = [];

  /* ---- tool usage sets --------------------------------------------------- */
  const toolSets = usable.map((t) => new Set(t.steps.map((s) => s.tool)));
  const allTools = new Set(toolSets.flatMap((s) => [...s]));
  const inAll = [...allTools].filter((tool) => toolSets.every((s) => s.has(tool))).sort();
  for (const tool of inAll) {
    assertions.push(mkAssertion('tool_required', { tool }, total, total, ids));
  }

  /* ---- one-of over mutating tools ---------------------------------------- */
  const mutatingSets = usable.map((t) => new Set(t.steps.filter((s) => s.state_changed).map((s) => s.tool)));
  const anyMutation = mutatingSets.some((s) => s.size > 0);
  const mutatingInAll = [...allTools].filter((tool) => mutatingSets.every((s) => s.has(tool)));
  if (anyMutation && mutatingInAll.length === 0 && mutatingSets.every((s) => s.size > 0)) {
    const union = [...new Set(mutatingSets.flatMap((s) => [...s]))].sort();
    if (union.length >= 2) {
      assertions.push(mkAssertion('one_of_tools', { tools: union }, total, total, ids));
      risks.push(`alternative valid paths observed: ${union.join(' | ')}`);
    }
  }

  /* ---- forbidden mutating tools for read-only families ------------------- */
  const readOnly = usable.every((t) => t.env_after.state_hash === t.env_before.state_hash);
  if (readOnly) {
    assertions.push(mkAssertion('state_unchanged', {}, total, total, ids));
  }

  /* ---- ordering: a precedes b when both occur ----------------------------- */
  const toolList = [...allTools].sort();
  for (const a of toolList) {
    for (const b of toolList) {
      if (a === b) continue;
      const both = usable.filter((t) => {
        const tools = t.steps.map((s) => s.tool);
        return tools.includes(a) && tools.includes(b);
      });
      if (both.length < MIN_SUPPORT) continue;
      const ordered = both.every((t) => {
        const tools = t.steps.map((s) => s.tool);
        return tools.indexOf(a) < tools.indexOf(b);
      });
      if (ordered) {
        assertions.push(
          mkAssertion('tool_precedes', { before: a, after: b }, both.length, total, both.map((t) => t.trace_id)),
        );
      }
    }
  }

  /* ---- argument constraints ----------------------------------------------- */
  for (const tool of toolList) {
    // Collect every call of `tool` across usable traces, paired with entities.
    const calls = usable.flatMap((t) =>
      t.steps.filter((s) => s.tool === tool).map((s) => ({ args: s.args, entities: t.intent_entities, trace: t.trace_id })),
    );
    if (calls.length === 0) continue;
    const tracesWithTool = new Set(calls.map((c) => c.trace)).size;
    if (tracesWithTool < MIN_SUPPORT) continue;
    const argNames = new Set(calls.flatMap((c) => Object.keys(c.args)));
    for (const arg of [...argNames].sort()) {
      const present = calls.filter((c) => arg in c.args);
      if (present.length !== calls.length) continue; // not always present → skip
      assertions.push(
        mkAssertion('arg_present', { tool, arg }, tracesWithTool, tracesWithTool, [...new Set(present.map((c) => c.trace))]),
      );
      // Value analysis: entity generalisation first, constant second.
      const generalised = present.map((c) => generalizeValue(c.args[arg]!, c.entities));
      const firstGen = generalised[0];
      if (firstGen && generalised.every((g) => g === firstGen)) {
        assertions.push(
          mkAssertion('arg_equals_entity', { tool, arg, entity: firstGen }, tracesWithTool, tracesWithTool, [
            ...new Set(present.map((c) => c.trace)),
          ]),
        );
      } else {
        const values = new Set(present.map((c) => JSON.stringify(c.args[arg])));
        if (values.size === 1 && present.length >= MIN_SUPPORT) {
          // Constant across traces with DIFFERENT intents is meaningful;
          // constant because all intents shared the value is overfitting risk.
          risks.push(`arg ${tool}.${arg} constant '${[...values][0]}' — review for incidental constants`);
        }
      }
    }
    // Enum constraint from the schema active at mining time.
    const specs = usable[0]!.tools.find((t) => t.name === tool);
    if (specs) {
      for (const p of specs.params) {
        if (p.enum && calls.some((c) => p.name in c.args)) {
          assertions.push(
            mkAssertion('arg_enum', { tool, arg: p.name, allowed: [...p.enum] }, tracesWithTool, tracesWithTool, ids),
          );
        }
      }
    }
    // Call-count ceiling (advisory-grade: guards loops, never blocking).
    const maxCalls = Math.max(
      ...usable.map((t) => t.steps.filter((s) => s.tool === tool).length),
    );
    assertions.push(mkAssertion('max_call_count', { tool, max: maxCalls }, tracesWithTool, total, ids));
  }

  /* ---- error expectations -------------------------------------------------- */
  const rejections = usable.filter((t) => t.outcome.label === 'valid_rejection');
  if (rejections.length === total && total >= MIN_SUPPORT) {
    const codes = new Set(
      rejections.flatMap((t) => t.steps.filter((s) => s.result_status === 'error').map((s) => s.error_code ?? '')),
    );
    if (codes.size === 1) {
      assertions.push(mkAssertion('error_expected', { code: [...codes][0]! }, total, total, ids));
    }
  } else if (usable.every((t) => t.steps.every((s) => s.result_status === 'ok'))) {
    assertions.push(mkAssertion('no_error', {}, total, total, ids));
  }

  /* ---- state postconditions (entity-generalised) ---------------------------- */
  mineStateAssertions(usable, assertions, ids);

  /* ---- retrieval consistency ------------------------------------------------ */
  if (readOnly && usable.every((t) => retrievalConsistent(t))) {
    assertions.push(mkAssertion('retrieval_consistent', {}, total, total, ids));
  }

  const stable = assertions.filter((a) => a.stable);
  if (stable.length === 0) return null;

  const anyAdversarial = usable.some((t) => t.partition === 'adversarial');
  const gate: GateLevel = anyAdversarial ? 'gate_eligible' : 'gate_eligible';
  if (anyAdversarial) risks.push('mined from adversarial-partition traffic — review error expectations carefully');

  return {
    schema_version: SCHEMA_VERSION,
    candidate_id: shortId('cand', { family: group.family, assertions: assertions.map((a) => a.assertion_id) }),
    scenario_family: group.family,
    scenario_ids: [...new Set(usable.map((t) => t.scenario_id))].sort(),
    fixture_id: usable[0]!.fixture_id,
    intents: [...new Set(usable.map((t) => t.user_intent))],
    assertions,
    status: 'candidate',
    recommended_gate: gate,
    risk_notes: risks,
    review: null,
  };
}

/**
 * Mine entity-generalised state postconditions from before/after row diffs.
 *
 * Anti-overfitting rules (docs/07 §State assertions):
 *  1. CHANGE ELIGIBILITY — a field is only minable if the operation changed
 *     it in at least one trace (or the row was created). Incidental fixture
 *     values that merely happened to be constant are never frozen.
 *  2. CORROBORATION — a constant expected value requires ≥2 distinct
 *     scenarios agreeing; a single-scenario constant is emitted only when it
 *     generalises to an intent entity, otherwise it is dropped.
 */
function mineStateAssertions(usable: NormalizedTrace[], out: Assertion[], ids: string[]): void {
  const total = usable.length;
  const fields = ['status', 'assignee', 'priority'] as const;
  for (const selectorKey of ['id', 'title'] as const) {
    const rowsPer = usable.map((t) => {
      const entity = t.intent_entities[selectorKey];
      if (entity === undefined) return null;
      const match = (rows: { [k: string]: Json }[]) =>
        rows.filter((r) => (selectorKey === 'id' ? r.id === entity : r.title === entity));
      const after = match(t.env_after.rows as { [k: string]: Json }[]);
      const before = match(t.env_before.rows as { [k: string]: Json }[]);
      if (after.length !== 1) return null;
      return {
        row: after[0]!,
        before: before.length === 1 ? before[0]! : null,
        created: before.length === 0,
        entities: t.intent_entities,
        scenario: t.scenario_id,
      };
    });
    if (rowsPer.some((r) => r === null)) continue;
    const resolved = rowsPer as {
      row: { [k: string]: Json };
      before: { [k: string]: Json } | null;
      created: boolean;
      entities: JsonObject;
      scenario: string;
    }[];
    out.push(
      mkAssertion('state_postcondition', { selector_entity: selectorKey, field: 'exists', expected: true }, total, total, ids),
    );
    const distinctScenarios = new Set(resolved.map((r) => r.scenario)).size;
    for (const field of fields) {
      const eligible = resolved.some((r) => r.created || (r.before !== null && r.before[field] !== r.row[field]));
      if (!eligible) continue; // rule 1: never freeze untouched fields
      const values = resolved.map((r) => r.row[field] ?? null);
      const first = values[0];
      const constant = values.every((v) => v === first) && first !== null && first !== undefined;
      const gen = resolved.map((r) => generalizeValue(r.row[field] ?? null, r.entities));
      const firstGen = gen[0];
      const entityConsistent = Boolean(firstGen) && gen.every((g) => g === firstGen);
      if (constant && distinctScenarios >= 2) {
        out.push(
          mkAssertion('state_postcondition', { selector_entity: selectorKey, field, expected: first }, total, total, ids),
        );
      } else if (entityConsistent) {
        out.push(
          mkAssertion('state_postcondition', { selector_entity: selectorKey, field, expected: firstGen! }, total, total, ids),
        );
      }
      // rule 2: single-scenario constant with no entity backing → dropped.
    }
  }
}

/** Deterministic invariant: last listing/search step returned exactly the matching rows. */
export function retrievalConsistent(trace: NormalizedTrace): boolean {
  const step = [...trace.steps]
    .reverse()
    .find((s) => s.result_status === 'ok' && Array.isArray(s.result_summary.ids));
  if (!step) return true; // nothing to check
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

export function mineAll(traces: NormalizedTrace[]): CandidateTest[] {
  return groupByFamily(traces)
    .map(mineFamily)
    .filter((c): c is CandidateTest => c !== null);
}
