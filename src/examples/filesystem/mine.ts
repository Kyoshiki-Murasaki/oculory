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
import { extractFsEntities } from './entities.js';

/**
 * Filesystem mining (Phase 4, docs/26).
 *
 * The generic miner (src/pipeline/mine.ts) is reused verbatim for tool/arg/
 * error/state-unchanged assertions — it only needs each trace's
 * `intent_entities`, which `normalizeFsTrace` fills with FILESYSTEM entities.
 * On top of that we add a conservative, trace-derived pass for filesystem
 * STATE postconditions (file created/deleted/moved with expected content),
 * emitted only when every verified trace in the family agrees (support ==
 * total, ≥2). Mirrors `mineStateAssertions` in the task miner.
 */
const MINER_ID = 'fs-miner-v1';
const MIN_SUPPORT = 2;

/** Normalise a filesystem raw trace: redact free text, attach fs intent entities. */
export function normalizeFsTrace(raw: RawTrace, outcome: OutcomeRecord): NormalizedTrace {
  if (outcome.trace_id !== raw.trace_id) {
    throw new Error(`outcome ${outcome.trace_id} does not belong to trace ${raw.trace_id}`);
  }
  return {
    ...raw,
    user_intent: redactText(raw.user_intent),
    final_response: raw.final_response === null ? null : redactText(raw.final_response),
    normalized: true,
    outcome,
    intent_entities: extractFsEntities(raw.user_intent),
  };
}

interface FsRow {
  path: string;
  type: 'file' | 'dir';
  content?: string;
}
function fileExists(rows: JsonObject[], path: string): boolean {
  return (rows as unknown as FsRow[]).some((r) => r.path === path && r.type === 'file');
}
function fileContent(rows: JsonObject[], path: string): string | null {
  const r = (rows as unknown as FsRow[]).find((x) => x.path === path && x.type === 'file');
  return r && typeof r.content === 'string' ? r.content : null;
}
function lastOkStep(trace: NormalizedTrace, tool: string): NormalizedTrace['steps'][number] | null {
  return [...trace.steps].reverse().find((s) => s.tool === tool && s.result_status === 'ok') ?? null;
}

function mkFsAssertion(type: AssertionType, params: JsonObject, total: number, traceIds: string[]): Assertion {
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
 * Add filesystem state postconditions to a candidate, derived from the
 * before/after diff of its family's verified traces. Only assertions that hold
 * across EVERY usable trace and generalise to an intent entity are emitted.
 */
function augmentFsState(candidate: CandidateTest, familyTraces: NormalizedTrace[]): CandidateTest {
  const usable = familyTraces.filter(
    (t) => t.outcome.label === 'verified_success' || t.outcome.label === 'valid_rejection',
  );
  if (usable.length < MIN_SUPPORT) return candidate;
  const total = usable.length;
  const ids = usable.map((t) => t.trace_id);
  const extra: Assertion[] = [];

  const allHave = (key: string): boolean => usable.every((t) => typeof (t.intent_entities as JsonObject)[key] === 'string');
  const entOf = (t: NormalizedTrace, key: string): string => String((t.intent_entities as JsonObject)[key]);

  // Single-path create / modify / delete.
  if (allHave('path')) {
    const createdOrModified = usable.every((t) => fileExists(t.env_after.rows, entOf(t, 'path')));
    const deleted = usable.every((t) => !fileExists(t.env_after.rows, entOf(t, 'path')) && fileExists(t.env_before.rows, entOf(t, 'path')));
    if (deleted) {
      extra.push(mkFsAssertion('state_postcondition', { check: 'file_absent', path: '@entity:path', expected: true }, total, ids));
    } else if (createdOrModified && usable.some((t) => t.env_after.state_hash !== t.env_before.state_hash)) {
      extra.push(mkFsAssertion('state_postcondition', { check: 'file_exists', path: '@entity:path', expected: true }, total, ids));
      if (allHave('content') && usable.every((t) => fileContent(t.env_after.rows, entOf(t, 'path')) === entOf(t, 'content'))) {
        extra.push(mkFsAssertion('state_postcondition', { check: 'content_equals', path: '@entity:path', expected: '@entity:content' }, total, ids));
      }
    }
  }

  // Read-only retrieval invariants (parallel to the task miner's retrieval_consistent).
  const readOnly = usable.every((t) => t.env_after.state_hash === t.env_before.state_hash);
  if (readOnly) {
    const reads = usable.map((t) => lastOkStep(t, 'read_file'));
    if (reads.every((s) => s !== null)) {
      const consistent = usable.every((t, i) => {
        const step = reads[i]!;
        const returned = step.result_summary.content;
        return typeof returned === 'string' && returned === fileContent(t.env_after.rows, String(step.args.path));
      });
      if (consistent) extra.push(mkFsAssertion('state_postcondition', { check: 'read_consistent' }, total, ids));
    }
    if (allHave('query')) {
      const searches = usable.map((t) => lastOkStep(t, 'search_files'));
      if (searches.every((s) => s !== null)) {
        let minCount = Infinity;
        const allExact = usable.every((t, i) => {
          const step = searches[i]!;
          const returned = Array.isArray(step.result_summary.paths) ? (step.result_summary.paths as string[]).map(String) : [];
          minCount = Math.min(minCount, returned.length);
          const q = entOf(t, 'query').toLowerCase();
          const expected = (t.env_after.rows as unknown as FsRow[])
            .filter((r) => r.type === 'file' && (r.path.split('/').pop() ?? '').toLowerCase().includes(q))
            .map((r) => r.path)
            .sort();
          const rs = [...returned].sort();
          return rs.length === expected.length && expected.every((p, j) => p === rs[j]);
        });
        if (allExact && Number.isFinite(minCount)) {
          extra.push(mkFsAssertion('state_postcondition', { check: 'search_consistent', query: '@entity:query', min_count: minCount }, total, ids));
        }
      }
    }
  }

  // Move / copy (from -> to).
  if (allHave('from') && allHave('to')) {
    if (usable.every((t) => fileExists(t.env_after.rows, entOf(t, 'to')))) {
      extra.push(mkFsAssertion('state_postcondition', { check: 'file_exists', path: '@entity:to', expected: true }, total, ids));
    }
    const sourceGone = usable.every((t) => !fileExists(t.env_after.rows, entOf(t, 'from')));
    const sourceKept = usable.every((t) => fileExists(t.env_after.rows, entOf(t, 'from')));
    if (sourceGone) {
      extra.push(mkFsAssertion('state_postcondition', { check: 'file_absent', path: '@entity:from', expected: true }, total, ids));
    } else if (sourceKept) {
      extra.push(mkFsAssertion('state_postcondition', { check: 'file_exists', path: '@entity:from', expected: true }, total, ids));
    }
  }

  if (extra.length === 0) return candidate;
  // De-dupe by assertion_id, then re-key the candidate id so it reflects the new assertion set.
  const seen = new Set(candidate.assertions.map((a) => a.assertion_id));
  const merged = [...candidate.assertions, ...extra.filter((a) => !seen.has(a.assertion_id))];
  return {
    ...candidate,
    assertions: merged,
    candidate_id: shortId('cand', { family: candidate.scenario_family, assertions: merged.map((a) => a.assertion_id) }),
  };
}

export function mineFsAll(traces: NormalizedTrace[]): CandidateTest[] {
  const base = mineAll(traces);
  const byFamily = new Map(groupByFamily(traces).map((g) => [g.family, g.traces]));
  return base.map((c) => augmentFsState(c, byFamily.get(c.scenario_family) ?? []));
}

/** Convenience for tests/verifier symmetry: does this value reference an entity? */
export function isEntityRef(v: Json): boolean {
  return typeof v === 'string' && v.startsWith('@entity:');
}
