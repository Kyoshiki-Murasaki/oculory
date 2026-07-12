import type { Json, JsonObject, ToolSpec } from '../schema/types.js';
import { DomainError, TaskDomain, PRIORITIES } from './domain.js';
import type { MutationFlags } from './mutations.js';

export const SERVER_VERSION = '0.1.0';

export interface ToolCallOutcome {
  status: 'ok' | 'error';
  error_code: string | null;
  payload: Json;
}

export class DemoServer {
  readonly domain: TaskDomain;

  constructor(readonly mutations: MutationFlags, dbPath = ':memory:') {
    this.domain = new TaskDomain(mutations, dbPath);
  }

  toolSpecs(): ToolSpec[] {
    const m = this.mutations;
    const priorityEnum = m.enum_changed ? ['p1', 'p2', 'p3'] : [...PRIORITIES];
    const specs: ToolSpec[] = [
      {
        name: 'search_tasks',
        description: m.description_weakened
          ? 'Task helper.'
          : 'Search tasks by matching a text query against task titles (substring match). Use when the user refers to a task by name or partial name.',
        params: [{ name: 'query', type: 'string', required: true, description: 'Text to match against task titles' }],
      },
      {
        name: 'list_tasks',
        description: m.description_weakened
          ? 'List tasks. Can also be used to search and query tasks by any criteria, matching what the user asked for.'
          : 'List tasks, optionally filtered by status and/or project. Use for browsing or counting, not for finding one task by name.',
        params: [
          { name: 'status', type: 'string', required: false, description: 'Filter by status', enum: ['open', 'in_progress', 'done'] },
          { name: 'project', type: 'string', required: false, description: 'Filter by project name' },
          { name: 'limit', type: 'integer', required: false, description: 'Maximum rows returned (default 50)' },
        ],
      },
      {
        name: 'get_task',
        description: 'Fetch a single task by its numeric id.',
        params: [{ name: 'id', type: 'integer', required: true, description: 'Task id' }],
      },
      {
        name: 'create_task',
        description: 'Create a new task. Returns the created task including its id.',
        params: [
          { name: m.arg_renamed ? 'task_title' : 'title', type: 'string', required: true, description: 'Task title' },
          { name: 'priority', type: 'string', required: false, description: 'Task priority (default medium)', enum: priorityEnum },
          { name: 'project', type: 'string', required: false, description: 'Project name (default general)' },
          { name: 'assignee', type: 'string', required: false, description: 'Assignee username' },
        ],
      },
      {
        name: 'update_task',
        description: 'Update fields of an existing task by id. Only provided fields change.',
        params: [
          { name: 'id', type: 'integer', required: true, description: 'Task id' },
          { name: 'title', type: 'string', required: false, description: 'New title' },
          { name: 'priority', type: 'string', required: false, description: 'New priority', enum: priorityEnum },
          { name: 'status', type: 'string', required: false, description: 'New status', enum: ['open', 'in_progress', 'done'] },
          { name: 'project', type: 'string', required: false, description: 'New project' },
        ],
      },
      {
        name: 'complete_task',
        description: 'Mark a task as done by id. Idempotent: completing a done task succeeds without change.',
        params: [{ name: 'id', type: 'integer', required: true, description: 'Task id' }],
      },
      {
        name: 'reopen_task',
        description: 'Reopen a done task (set status back to open). Fails with INVALID_TRANSITION if the task is not done.',
        params: [{ name: 'id', type: 'integer', required: true, description: 'Task id' }],
      },
      {
        name: 'assign_task',
        description: 'Assign a task to a user by id.',
        params: [
          { name: 'id', type: 'integer', required: true, description: 'Task id' },
          { name: 'assignee', type: 'string', required: true, description: 'Assignee username' },
        ],
      },
    ];
    if (m.overlapping_tool_added) {
      specs.push({
        name: 'find_tasks',
        description: 'Search tasks by matching a text query against task titles.',
        params: [{ name: 'q', type: 'string', required: true, description: 'Text to match' }],
      });
    }
    if (m.tool_order_changed) specs.reverse();
    return specs;
  }

  callTool(name: string, args: JsonObject): ToolCallOutcome {
    try {
      const payload = this.dispatch(name, args);
      return { status: 'ok', error_code: null, payload };
    } catch (err) {
      if (err instanceof DomainError) {
        const code = this.mutations.error_changed && err.code === 'NOT_FOUND' ? 'INTERNAL' : err.code;
        const message = this.mutations.error_changed && err.code === 'NOT_FOUND' ? 'internal error' : err.message;
        return { status: 'error', error_code: code, payload: { code, message } };
      }
      throw err;
    }
  }

  private dispatch(name: string, args: JsonObject): Json {
    const m = this.mutations;
    switch (name) {
      case 'search_tasks': {
        const query = reqString(args, 'query');
        return { tasks: this.domain.searchTasks(query) };
      }
      case 'find_tasks': {
        if (!m.overlapping_tool_added) throw new DomainError('UNKNOWN_TOOL', `no tool named ${name}`);
        const q = reqString(args, 'q');
        return { tasks: this.domain.searchTasks(q) };
      }
      case 'list_tasks': {
        const status = optString(args, 'status');
        const project = optString(args, 'project');
        const defaultLimit = m.default_changed ? 3 : 50;
        const limit = typeof args.limit === 'number' ? args.limit : defaultLimit;
        return { tasks: this.domain.listTasks(status, project, limit) };
      }
      case 'get_task':
        return { task: this.domain.getTask(reqInt(args, 'id')) };
      case 'create_task': {
        const titleKey = m.arg_renamed ? 'task_title' : 'title';
        const title = reqString(args, titleKey);
        const priority = optString(args, 'priority') ?? 'medium';
        const project = optString(args, 'project') ?? 'general';
        const assignee = optString(args, 'assignee') ?? null;
        return { task: this.domain.createTask(title, priority, project, assignee) };
      }
      case 'update_task': {
        const id = reqInt(args, 'id');
        return {
          task: this.domain.updateTask(id, {
            title: optString(args, 'title'),
            priority: optString(args, 'priority'),
            status: optString(args, 'status'),
            project: optString(args, 'project'),
          }),
        };
      }
      case 'complete_task': {
        const id = reqInt(args, 'id');
        if (m.wrong_success) {
          // Defect: skip existence check, always report success.
          try {
            const { task, changed } = this.domain.completeTask(id);
            return { task, changed };
          } catch {
            return { task: { id }, changed: true };
          }
        }
        const { task, changed } = this.domain.completeTask(id);
        return { task, changed };
      }
      case 'reopen_task':
        return { task: this.domain.reopenTask(reqInt(args, 'id')) };
      case 'assign_task':
        return { task: this.domain.assignTask(reqInt(args, 'id'), reqString(args, 'assignee')) };
      default:
        throw new DomainError('UNKNOWN_TOOL', `no tool named ${name}`);
    }
  }
}

function reqString(args: JsonObject, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new DomainError('INVALID_ARGUMENT', `missing or non-string argument '${key}'`);
  return v;
}
function optString(args: JsonObject, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new DomainError('INVALID_ARGUMENT', `argument '${key}' must be a string`);
  return v;
}
function reqInt(args: JsonObject, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isInteger(v))
    throw new DomainError('INVALID_ARGUMENT', `missing or non-integer argument '${key}'`);
  return v;
}
