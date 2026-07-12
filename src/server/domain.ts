import { DatabaseSync } from 'node:sqlite';
import type { JsonObject } from '../schema/types.js';
import { hashJson } from '../schema/canonical.js';
import type { MutationFlags } from './mutations.js';

export const TASK_STATUSES = ['open', 'in_progress', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const PRIORITIES = ['low', 'medium', 'high'] as const;

export interface TaskRow extends JsonObject {
  id: number;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  project: string;
}

export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/**
 * Deterministic task-tracker domain. All timestamps are logical counters
 * (not wall clock) so state hashes are reproducible across runs.
 */
export class TaskDomain {
  private db: DatabaseSync;
  private clock = 0;

  constructor(private readonly mutations: MutationFlags, path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        priority TEXT NOT NULL DEFAULT 'medium',
        assignee TEXT,
        project TEXT NOT NULL DEFAULT 'general',
        created_seq INTEGER NOT NULL,
        updated_seq INTEGER NOT NULL
      );
    `);
  }

  reset(fixtureRows: Omit<TaskRow, 'id'>[] & JsonObject[]): void {
    this.db.exec('DELETE FROM tasks;');
    this.clock = 0;
    const stmt = this.db.prepare(
      'INSERT INTO tasks (title, status, priority, assignee, project, created_seq, updated_seq) VALUES (?,?,?,?,?,?,?)',
    );
    for (const r of fixtureRows) {
      this.clock += 1;
      stmt.run(
        String(r.title),
        String(r.status ?? 'open'),
        String(r.priority ?? 'medium'),
        r.assignee === null || r.assignee === undefined ? null : String(r.assignee),
        String(r.project ?? 'general'),
        this.clock,
        this.clock,
      );
    }
  }

  /* ------------------------------ Queries ------------------------------- */

  listTasks(status?: string, project?: string, limit = 50): TaskRow[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (status) {
      clauses.push('status = ?');
      args.push(status);
    }
    if (project) {
      clauses.push('project = ?');
      args.push(project);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT id, title, status, priority, assignee, project FROM tasks ${where} ORDER BY id LIMIT ?`)
      .all(...args, limit) as unknown as TaskRow[];
    return rows;
  }

  searchTasks(query: string): TaskRow[] {
    const q = query.trim();
    // Mutation `partial_match_changed`: switch from substring match to
    // exact-title match — silently narrows results (schema unchanged).
    const where = this.mutations.partial_match_changed ? 'title = ?' : "title LIKE '%' || ? || '%'";
    return this.db
      .prepare(`SELECT id, title, status, priority, assignee, project FROM tasks WHERE ${where} ORDER BY id`)
      .all(q) as unknown as TaskRow[];
  }

  getTask(id: number): TaskRow {
    const row = this.db
      .prepare('SELECT id, title, status, priority, assignee, project FROM tasks WHERE id = ?')
      .get(id) as unknown as TaskRow | undefined;
    if (!row) throw new DomainError('NOT_FOUND', `task ${id} does not exist`);
    return row;
  }

  /* ----------------------------- Mutations ------------------------------ */

  createTask(title: string, priority: string, project: string, assignee: string | null): TaskRow {
    if (!title.trim()) throw new DomainError('INVALID_ARGUMENT', 'title must be non-empty');
    this.validatePriority(priority);
    this.clock += 1;
    const res = this.db
      .prepare('INSERT INTO tasks (title, status, priority, assignee, project, created_seq, updated_seq) VALUES (?,?,?,?,?,?,?)')
      .run(title, 'open', priority, assignee, project, this.clock, this.clock);
    return this.getTask(Number(res.lastInsertRowid));
  }

  updateTask(id: number, fields: { title?: string; priority?: string; status?: string; project?: string }): TaskRow {
    const existing = this.getTask(id);
    if (fields.priority !== undefined) this.validatePriority(fields.priority);
    if (fields.status !== undefined && !(TASK_STATUSES as readonly string[]).includes(fields.status)) {
      throw new DomainError('INVALID_ARGUMENT', `status must be one of ${TASK_STATUSES.join(', ')}`);
    }
    this.clock += 1;
    this.db
      .prepare('UPDATE tasks SET title = ?, priority = ?, status = ?, project = ?, updated_seq = ? WHERE id = ?')
      .run(
        fields.title ?? existing.title,
        fields.priority ?? existing.priority,
        fields.status ?? existing.status,
        fields.project ?? existing.project,
        this.clock,
        id,
      );
    return this.getTask(id);
  }

  completeTask(id: number): { task: TaskRow; changed: boolean } {
    const existing = this.getTask(id); // throws NOT_FOUND for nonexistent
    if (existing.status === 'done') return { task: existing, changed: false }; // idempotent
    // Mutation `silent_write_failure`: report success but skip the write.
    if (!this.mutations.silent_write_failure) {
      this.clock += 1;
      this.db.prepare('UPDATE tasks SET status = ?, updated_seq = ? WHERE id = ?').run('done', this.clock, id);
    }
    return { task: this.getTask(id), changed: true };
  }

  reopenTask(id: number): TaskRow {
    const existing = this.getTask(id);
    if (existing.status !== 'done') {
      // invalid transition: only done tasks can be reopened
      throw new DomainError('INVALID_TRANSITION', `task ${id} is '${existing.status}', only done tasks can be reopened`);
    }
    this.clock += 1;
    this.db.prepare('UPDATE tasks SET status = ?, updated_seq = ? WHERE id = ?').run('open', this.clock, id);
    return this.getTask(id);
  }

  assignTask(id: number, assignee: string): TaskRow {
    this.getTask(id);
    if (!assignee.trim()) throw new DomainError('INVALID_ARGUMENT', 'assignee must be non-empty');
    this.clock += 1;
    this.db.prepare('UPDATE tasks SET assignee = ?, updated_seq = ? WHERE id = ?').run(assignee, this.clock, id);
    return this.getTask(id);
  }

  /* ------------------------------ Snapshot ------------------------------ */

  snapshot(): { state_hash: string; rows: TaskRow[] } {
    const rows = this.db
      .prepare('SELECT id, title, status, priority, assignee, project FROM tasks ORDER BY id')
      .all() as unknown as TaskRow[];
    return { state_hash: hashJson(rows as unknown as JsonObject[]), rows };
  }

  private validatePriority(p: string): void {
    // Mutation `enum_changed`: server now expects p1/p2/p3 instead of low/medium/high.
    const allowed = this.mutations.enum_changed ? ['p1', 'p2', 'p3'] : [...PRIORITIES];
    if (!allowed.includes(p)) throw new DomainError('INVALID_ARGUMENT', `priority must be one of ${allowed.join(', ')}`);
  }

  close(): void {
    this.db.close();
  }
}
