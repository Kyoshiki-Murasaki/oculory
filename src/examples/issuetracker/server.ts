import type { Json, JsonObject, ToolSpec } from '../../schema/types.js';
import { hashJson } from '../../schema/canonical.js';
import type { IssueMutationFlags } from './mutations.js';
import { NO_ISSUE_MUTATIONS } from './mutations.js';

export const ISSUE_SERVER_VERSION = '0.1.0';

/** The three principals a real issue can be assigned to (a closed allow-list). */
export const KNOWN_USERS = ['alice', 'bob', 'carla'] as const;
/** The label taxonomy the tracker enforces (a closed allow-list). */
export const ALLOWED_LABELS = ['bug', 'feature', 'urgent', 'docs'] as const;
/** Priority enum; `create_issue` defaults to `normal` when omitted. */
export const ISSUE_PRIORITIES = ['low', 'normal', 'high'] as const;
export const ISSUE_STATUSES = ['open', 'closed'] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** A structured, code-carrying error. Everything the tools reject is one of these. */
export class IssueError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IssueError';
  }
}

export interface IssueRecord {
  id: string;
  order: number;
  title: string;
  body: string;
  status: IssueStatus;
  assignee: string | null;
  priority: string;
  labels: string[];
  comments: string[];
}

/** A seed row: everything except `id`/`order` (assigned deterministically on load). */
export interface IssueSeed {
  title: string;
  body?: string;
  status?: IssueStatus;
  assignee?: string | null;
  priority?: string;
  labels?: string[];
  comments?: string[];
}

export interface IssueToolOutcome {
  status: 'ok' | 'error';
  error_code: string | null;
  payload: Json;
}

/**
 * A local, deterministic, in-memory issue tracker MCP-like server (Phase 5,
 * docs/28). It simulates a GitHub / Linear-style tracker: entity resolution,
 * state transitions (open ⇄ closed), a closed user allow-list, a closed label
 * taxonomy, and read-only vs write behaviour. It is NOT a real GitHub/Linear
 * integration — every issue lives in this process' memory and is thrown away
 * after each recording session.
 *
 * Mutations toggle realistic behavioural defects (docs/28) using the SAME real
 * code paths; none of them can reach anything outside this object.
 */
export class IssueTrackerServer {
  private issues: IssueRecord[] = [];
  private nextOrder = 1;

  constructor(
    seed: IssueSeed[] = [],
    readonly mutations: IssueMutationFlags = NO_ISSUE_MUTATIONS,
  ) {
    for (const s of seed) this.load(s);
  }

  private load(s: IssueSeed): void {
    const order = this.nextOrder++;
    this.issues.push({
      id: `ISSUE-${order}`,
      order,
      title: s.title,
      body: s.body ?? '',
      status: s.status ?? 'open',
      assignee: s.assignee ?? null,
      priority: s.priority ?? 'normal',
      labels: [...(s.labels ?? [])].sort(),
      comments: [...(s.comments ?? [])],
    });
  }

  toolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [
      {
        name: 'create_issue',
        description: 'Create a new open issue with a title and body. Returns the new issue including its assigned id.',
        params: [
          { name: 'title', type: 'string', required: true, description: 'Short issue title' },
          { name: 'body', type: 'string', required: true, description: 'Issue description / body text' },
          { name: 'priority', type: 'string', required: false, description: 'Priority', enum: [...ISSUE_PRIORITIES] },
        ],
      },
      {
        name: 'read_issue',
        description: 'Read a single issue by its id. Fails with NOT_FOUND if no such issue exists.',
        params: [{ name: 'id', type: 'string', required: true, description: 'Issue id, e.g. ISSUE-1' }],
      },
      {
        name: 'search_issues',
        description: 'Search issues whose title contains the query substring (case-insensitive). Returns matching issues.',
        params: [{ name: 'query', type: 'string', required: true, description: 'Substring to match against issue titles' }],
      },
      {
        name: 'assign_issue',
        description: 'Assign an issue to a known user. Fails with INVALID_USER if the assignee is not a known user.',
        params: [
          { name: 'id', type: 'string', required: true, description: 'Issue id' },
          { name: 'assignee', type: 'string', required: true, description: 'Known user to assign (alice, bob, carla)' },
        ],
      },
      {
        // NOTE: `label` deliberately does NOT advertise a JSON-schema enum. The allowed
        // set is enforced at runtime (INVALID_LABEL) and one adversarial scenario passes a
        // disallowed label ON PURPOSE — advertising an enum would make the generic miner emit
        // an arg_enum assertion that the adversarial scenario contradicts. The allow-list lives
        // in the description + runtime check instead.
        name: 'label_issue',
        description: `Apply a label to an issue. Allowed labels: ${ALLOWED_LABELS.join(', ')}. Fails with INVALID_LABEL otherwise.`,
        params: [
          { name: 'id', type: 'string', required: true, description: 'Issue id' },
          { name: 'label', type: 'string', required: true, description: `Label to apply (one of: ${ALLOWED_LABELS.join(', ')})` },
        ],
      },
      {
        name: 'comment_issue',
        description: 'Append a comment to an issue, preserving existing comments.',
        params: [
          { name: 'id', type: 'string', required: true, description: 'Issue id' },
          { name: 'body', type: 'string', required: true, description: 'Comment text to append' },
        ],
      },
      {
        name: 'close_issue',
        description: 'Close an open issue. Fails with INVALID_STATE if the issue is already closed.',
        params: [{ name: 'id', type: 'string', required: true, description: 'Issue id' }],
      },
      {
        name: 'reopen_issue',
        description: 'Reopen a closed issue. Fails with INVALID_STATE if the issue is already open.',
        params: [{ name: 'id', type: 'string', required: true, description: 'Issue id' }],
      },
      {
        name: 'list_issues',
        description: 'List issues, optionally filtered by status (open or closed).',
        params: [{ name: 'status', type: 'string', required: false, description: 'Optional status filter', enum: [...ISSUE_STATUSES] }],
      },
    ];
    if (this.mutations.tool_order_changed) specs.reverse();
    return specs;
  }

  callTool(name: string, args: JsonObject): IssueToolOutcome {
    try {
      const payload = this.dispatch(name, args);
      return { status: 'ok', error_code: null, payload };
    } catch (err) {
      if (err instanceof IssueError) {
        return { status: 'error', error_code: err.code, payload: { code: err.code, message: err.message } };
      }
      throw err;
    }
  }

  /* --------------------------------- lookup -------------------------------- */

  private find(id: string): IssueRecord | undefined {
    return this.issues.find((i) => i.id === id);
  }

  /**
   * Resolve an issue by id, or throw NOT_FOUND. Under `missing_id_succeeds`,
   * a missing id is NOT rejected: a fabricated, non-persisted placeholder is
   * returned so read-only callers see a (wrong) success and mutating callers
   * get a decoy to operate on — the security/consistency rejection is removed
   * without corrupting stored state.
   */
  private require(id: string): IssueRecord {
    const found = this.find(id);
    if (found) return found;
    if (this.mutations.missing_id_succeeds) {
      return { id, order: -1, title: '(fabricated)', body: '', status: 'open', assignee: null, priority: 'normal', labels: [], comments: [] };
    }
    throw new IssueError('NOT_FOUND', `no issue with id '${id}'`);
  }

  /** Deterministically pick a different issue than `target` for the wrong-issue regressions. */
  private wrongSibling(target: IssueRecord): IssueRecord {
    const others = this.issues.filter((i) => i.id !== target.id).sort((a, b) => a.order - b.order);
    return others[0] ?? target;
  }

  private dispatch(name: string, args: JsonObject): Json {
    switch (name) {
      case 'create_issue': {
        const title = reqString(args, 'title');
        const body = reqString(args, 'body');
        const priority = optString(args, 'priority') ?? 'normal';
        if (!title.trim()) throw new IssueError('INVALID_ARGUMENT', 'title must be non-empty');
        if (!(ISSUE_PRIORITIES as readonly string[]).includes(priority)) {
          throw new IssueError('INVALID_ARGUMENT', `priority must be one of ${ISSUE_PRIORITIES.join(', ')}`);
        }
        const order = this.nextOrder++;
        const issue: IssueRecord = { id: `ISSUE-${order}`, order, title, body, status: 'open', assignee: null, priority, labels: [], comments: [] };
        this.issues.push(issue);
        return { issue: view(issue) };
      }
      case 'read_issue': {
        const id = reqString(args, 'id');
        const issue = this.require(id);
        return { issue: view(issue) };
      }
      case 'search_issues': {
        const query = reqString(args, 'query');
        const needle = query.toLowerCase();
        let matches = this.issues.filter((i) => i.title.toLowerCase().includes(needle)).sort((a, b) => a.order - b.order);
        if (this.mutations.readonly_search_mutates_state) {
          // A read-only tool that writes: stamp a comment on the first issue.
          const victim = matches[0] ?? this.issues[0];
          if (victim) victim.comments.push(`[auto] searched: ${query}`);
        }
        if (this.mutations.search_returns_partial_wrong_match) matches = matches.slice(1);
        return { query, matches: matches.map(view), ids: matches.map((i) => i.id) };
      }
      case 'assign_issue': {
        const id = reqString(args, 'id');
        const assignee = reqString(args, 'assignee');
        const issue = this.require(id);
        if (!this.mutations.invalid_user_allowed && !(KNOWN_USERS as readonly string[]).includes(assignee)) {
          throw new IssueError('INVALID_USER', `'${assignee}' is not a known user`);
        }
        const applied = this.mutations.assign_wrong_user ? nextUser(assignee) : assignee;
        if (issue.order !== -1) issue.assignee = applied;
        return { issue: view(issue) };
      }
      case 'label_issue': {
        const id = reqString(args, 'id');
        const label = reqString(args, 'label');
        const issue = this.require(id);
        if (!this.mutations.invalid_label_allowed && !(ALLOWED_LABELS as readonly string[]).includes(label)) {
          throw new IssueError('INVALID_LABEL', `'${label}' is not an allowed label`);
        }
        const target = this.mutations.label_wrong_issue ? this.wrongSibling(issue) : issue;
        if (target.order !== -1 && !target.labels.includes(label)) {
          target.labels = [...target.labels, label].sort();
        }
        return { issue: view(target) };
      }
      case 'comment_issue': {
        const id = reqString(args, 'id');
        const body = reqString(args, 'body');
        const issue = this.require(id);
        const target = this.mutations.comment_wrong_issue ? this.wrongSibling(issue) : issue;
        if (target.order !== -1) target.comments.push(body);
        return { issue: view(target) };
      }
      case 'close_issue': {
        const id = reqString(args, 'id');
        const issue = this.require(id);
        if (issue.status === 'closed') {
          // Already closed: normally an INVALID_STATE rejection. Under
          // already_closed_policy_changed it becomes a silent idempotent no-op.
          if (this.mutations.already_closed_policy_changed) return { issue: view(issue) };
          throw new IssueError('INVALID_STATE', `issue '${id}' is already closed`);
        }
        if (!this.mutations.close_noop && issue.order !== -1) issue.status = 'closed';
        return { issue: view(issue) };
      }
      case 'reopen_issue': {
        const id = reqString(args, 'id');
        const issue = this.require(id);
        if (issue.status === 'open') throw new IssueError('INVALID_STATE', `issue '${id}' is already open`);
        if (issue.order !== -1) issue.status = 'open';
        return { issue: view(issue) };
      }
      case 'list_issues': {
        const status = optString(args, 'status');
        if (status !== null && !(ISSUE_STATUSES as readonly string[]).includes(status)) {
          throw new IssueError('INVALID_ARGUMENT', `status must be one of ${ISSUE_STATUSES.join(', ')}`);
        }
        const rows = this.issues
          .filter((i) => (status === null ? true : i.status === status))
          .sort((a, b) => a.order - b.order);
        return { status: status ?? null, issues: rows.map(view), ids: rows.map((i) => i.id) };
      }
      default:
        throw new IssueError('UNKNOWN_TOOL', `no tool named '${name}'`);
    }
  }

  /** Snapshot: sorted issue rows, exposing id/title/status/assignee/priority at top level. */
  snapshot(): { state_hash: string; rows: JsonObject[] } {
    return issueSnapshot(this.issues);
  }
}

/** A stable, comparable view of one issue row (labels sorted, comments in order). */
function view(i: IssueRecord): JsonObject {
  return {
    id: i.id,
    order: i.order,
    title: i.title,
    body: i.body,
    status: i.status,
    assignee: i.assignee,
    priority: i.priority,
    labels: [...i.labels].sort(),
    comments: [...i.comments],
  };
}

export function issueSnapshot(issues: IssueRecord[]): { state_hash: string; rows: JsonObject[] } {
  const rows = [...issues].sort((a, b) => a.order - b.order).map(view);
  return { state_hash: hashJson(rows), rows };
}

/** The known user cyclically after `u` (used by the assign_wrong_user regression). */
function nextUser(u: string): string {
  const i = (KNOWN_USERS as readonly string[]).indexOf(u);
  if (i === -1) return KNOWN_USERS[0];
  return KNOWN_USERS[(i + 1) % KNOWN_USERS.length]!;
}

function reqString(args: JsonObject, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new IssueError('INVALID_ARGUMENT', `missing or non-string argument '${key}'`);
  return v;
}

function optString(args: JsonObject, key: string): string | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new IssueError('INVALID_ARGUMENT', `argument '${key}' must be a string`);
  return v;
}
