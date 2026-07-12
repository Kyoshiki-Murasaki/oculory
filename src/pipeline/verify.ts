import type {
  EnvSnapshot,
  Json,
  JsonObject,
  OutcomeEvidence,
  OutcomeLabel,
  OutcomeRecord,
  RawTrace,
  Scenario,
  StateCondition,
} from '../schema/types.js';
import { SCHEMA_VERSION } from '../schema/types.js';

/**
 * Deterministic outcome verifier (docs/05 §Outcome labels).
 * "Success" means the intended environment outcome occurred — never merely
 * that tool calls returned ok. Purely rule-based; no LLM anywhere.
 */

interface RowLike extends JsonObject {
  id: number;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  project: string;
}

function selectRows(rows: JsonObject[], selector: JsonObject): RowLike[] {
  return (rows as RowLike[]).filter((r) => {
    if (typeof selector.id === 'number' && r.id !== selector.id) return false;
    if (typeof selector.title === 'string' && r.title !== selector.title) return false;
    return true;
  });
}

export function evalStateCondition(cond: StateCondition, trace: RawTrace): OutcomeEvidence {
  const after = trace.env_after;
  const mk = (observed: Json, passed: boolean): OutcomeEvidence => ({
    check: `${cond.kind}(${JSON.stringify(cond.selector)})`,
    expected: cond.expected,
    observed,
    passed,
  });
  switch (cond.kind) {
    case 'task_status':
    case 'task_priority':
    case 'task_assignee': {
      const field = cond.kind.replace('task_', '') as 'status' | 'priority' | 'assignee';
      const rows = selectRows(after.rows, cond.selector);
      if (rows.length !== 1) return mk(`matched ${rows.length} rows`, false);
      return mk(rows[0]![field], rows[0]![field] === cond.expected);
    }
    case 'task_exists': {
      const rows = selectRows(after.rows, cond.selector);
      return mk(rows.length > 0, (rows.length > 0) === cond.expected);
    }
    case 'task_absent': {
      const rows = selectRows(after.rows, cond.selector);
      return mk(rows.length === 0, (rows.length === 0) === cond.expected);
    }
    case 'state_unchanged':
      return mk(
        trace.env_after.state_hash === trace.env_before.state_hash,
        (trace.env_after.state_hash === trace.env_before.state_hash) === cond.expected,
      );
    case 'listing_complete': {
      const passed = listingComplete(trace, cond.selector);
      return mk(passed, passed === cond.expected);
    }
    case 'search_found': {
      const q = String(cond.selector.query ?? '');
      const min = Number(cond.selector.min_count ?? 1);
      const step = [...trace.steps].reverse().find((s) => s.result_status === 'ok' && Array.isArray(s.result_summary.ids));
      const returned = step ? (step.result_summary.ids as number[]) : [];
      const expectedIds = (after.rows as RowLike[])
        .filter((r) => r.title.toLowerCase().includes(q.toLowerCase()))
        .map((r) => r.id);
      const passed = returned.length >= min && expectedIds.every((id) => returned.includes(id));
      return mk({ returned, expected: expectedIds }, passed === cond.expected);
    }
    default:
      return mk(`unknown condition kind '${cond.kind}'`, false);
  }
}

/** True when the last ok listing/search step returned exactly the rows matching its filters. */
export function listingComplete(trace: RawTrace, selector: JsonObject): boolean {
  const step = [...trace.steps].reverse().find((s) => s.result_status === 'ok' && Array.isArray(s.result_summary.ids));
  if (!step) return false;
  const returned = new Set(step.result_summary.ids as number[]);
  const rows = trace.env_after.rows as RowLike[];
  const expected = rows.filter((r) => {
    if (typeof selector.status === 'string' && r.status !== selector.status) return false;
    if (typeof selector.project === 'string' && r.project !== selector.project) return false;
    return true;
  });
  return expected.length === returned.size && expected.every((r) => returned.has(r.id));
}

export function verifyOutcome(scenario: Scenario, trace: RawTrace): OutcomeRecord {
  const evidence: OutcomeEvidence[] = scenario.postconditions.map((c) => evalStateCondition(c, trace));

  const errSteps = trace.steps.filter((s) => s.result_status === 'error');
  if (scenario.expect_error) {
    const gotExpected = errSteps.some((s) => s.error_code === scenario.expect_error);
    evidence.push({
      check: `expected_error(${scenario.expect_error})`,
      expected: scenario.expect_error,
      observed: errSteps.map((s) => s.error_code ?? 'null'),
      passed: gotExpected,
    });
  }

  const allPassed = evidence.every((e) => e.passed);
  const anyPassed = evidence.some((e) => e.passed);
  let label: OutcomeLabel;
  if (evidence.length === 0) label = 'unknown';
  else if (allPassed) label = scenario.expect_error ? 'valid_rejection' : 'verified_success';
  else if (scenario.expect_error && !errSteps.some((s) => s.error_code === scenario.expect_error) && trace.steps.some((s) => s.result_status === 'ok')) {
    label = 'invalid_acceptance';
  } else if (anyPassed) label = 'partial_success';
  else label = 'verified_failure';

  return {
    schema_version: SCHEMA_VERSION,
    trace_id: trace.trace_id,
    label,
    evidence,
    verified_at: new Date().toISOString(),
    verifier: 'deterministic-state-v1',
  };
}

export function snapshotsEqual(a: EnvSnapshot, b: EnvSnapshot): boolean {
  return a.state_hash === b.state_hash;
}
