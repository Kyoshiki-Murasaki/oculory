import type {
  Assertion,
  AssertionType,
  CandidateTest,
  Json,
  JsonObject,
  NormalizedTrace,
  OutcomeRecord,
  RawTrace,
} from '../../schema/types.js';
import { shortId } from '../../schema/canonical.js';
import { groupByFamily, mineAll } from '../../pipeline/mine.js';
import { redactText } from '../../pipeline/normalize.js';
import { extractIssueEntities } from './entities.js';

/**
 * Issue-tracker mining (Phase 5, docs/28).
 *
 * The generic miner (src/pipeline/mine.ts) is reused verbatim for tool / arg /
 * error / state-unchanged assertions AND for the SCALAR issue postconditions
 * (status / assignee / priority keyed by an id or title selector) — because the
 * tracker snapshot rows already expose those fields, `mineStateAssertions` fires
 * directly. On top of that we add a conservative, trace-derived pass for the
 * ARRAY-valued postconditions the generic miner cannot express: a label applied
 * to an issue, or a comment appended to it. Both are emitted only when every
 * usable trace in the family agrees (support == total, ≥2) and the value
 * generalises to an intent entity. Mirrors `augmentFsState` in the fs miner.
 */
const MINER_ID = 'issue-miner-v1';
const MIN_SUPPORT = 2;

/** Normalise an issue raw trace: redact free text, attach issue intent entities. */
export function normalizeIssueTrace(raw: RawTrace, outcome: OutcomeRecord): NormalizedTrace {
  if (outcome.trace_id !== raw.trace_id) {
    throw new Error(`outcome ${outcome.trace_id} does not belong to trace ${raw.trace_id}`);
  }
  return {
    ...raw,
    user_intent: redactText(raw.user_intent),
    final_response: raw.final_response === null ? null : redactText(raw.final_response),
    normalized: true,
    outcome,
    intent_entities: extractIssueEntities(raw.user_intent),
  };
}

interface IssueRow {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  labels: string[];
  comments: string[];
}
function rowById(rows: JsonObject[], id: string): IssueRow | undefined {
  return (rows as unknown as IssueRow[]).find((r) => r.id === id);
}

function mkIssueAssertion(type: AssertionType, params: JsonObject, total: number, traceIds: string[]): Assertion {
  return {
    assertion_id: shortId('as', { type, params }),
    type,
    params,
    confidence: 1,
    support: total,
    total,
    stable: total >= MIN_SUPPORT,
    provenance: { trace_ids: traceIds, miner: MINER_ID },
  };
}

/**
 * Add label/comment state postconditions derived from the before/after diff of a
 * family's verified traces. Only emitted when they hold across EVERY usable
 * trace and generalise to an intent entity (id + label, or id + body).
 */
function augmentIssueState(candidate: CandidateTest, familyTraces: NormalizedTrace[]): CandidateTest {
  const usable = familyTraces.filter(
    (t) => t.outcome.label === 'verified_success' || t.outcome.label === 'valid_rejection',
  );
  if (usable.length < MIN_SUPPORT) return candidate;
  const total = usable.length;
  const ids = usable.map((t) => t.trace_id);
  const extra: Assertion[] = [];

  const ent = (t: NormalizedTrace, key: string): string | undefined => {
    const v = (t.intent_entities as JsonObject)[key];
    return typeof v === 'string' ? v : undefined;
  };
  const allHave = (key: string): boolean => usable.every((t) => ent(t, key) !== undefined);

  // Label applied to the issue referenced by id.
  if (allHave('id') && allHave('label')) {
    const allLabelled = usable.every((t) => {
      const row = rowById(t.env_after.rows, ent(t, 'id')!);
      return row !== undefined && row.labels.includes(ent(t, 'label')!);
    });
    if (allLabelled) {
      extra.push(
        mkIssueAssertion('state_postcondition', { check: 'label_present', selector_entity: 'id', label: '@entity:label', expected: true }, total, ids),
      );
    }
  }

  // Comment appended to the issue referenced by id.
  if (allHave('id') && allHave('body')) {
    const allCommented = usable.every((t) => {
      const row = rowById(t.env_after.rows, ent(t, 'id')!);
      return row !== undefined && row.comments.includes(ent(t, 'body')!);
    });
    if (allCommented) {
      extra.push(
        mkIssueAssertion('state_postcondition', { check: 'comment_present', selector_entity: 'id', body: '@entity:body', expected: true }, total, ids),
      );
    }
  }

  if (extra.length === 0) return candidate;
  const seen = new Set(candidate.assertions.map((a) => a.assertion_id));
  const merged = [...candidate.assertions, ...extra.filter((a) => !seen.has(a.assertion_id))];
  return {
    ...candidate,
    assertions: merged,
    candidate_id: shortId('cand', { family: candidate.scenario_family, assertions: merged.map((a) => a.assertion_id) }),
  };
}

export function mineIssueAll(traces: NormalizedTrace[]): CandidateTest[] {
  const base = mineAll(traces);
  const byFamily = new Map(groupByFamily(traces).map((g) => [g.family, g.traces]));
  return base.map((c) => augmentIssueState(c, byFamily.get(c.scenario_family) ?? []));
}

/** Convenience for tests/verifier symmetry: does this value reference an entity? */
export function isEntityRef(v: Json): boolean {
  return typeof v === 'string' && v.startsWith('@entity:');
}
