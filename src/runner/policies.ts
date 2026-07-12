import type { JsonObject, Scenario, ToolSpec } from '../schema/types.js';
import type { McpEndpoint, McpToolResult } from '../mcp/mcp.js';

/**
 * Scripted agent policies (docs/05 §Traffic generation).
 *
 * HONESTY NOTE: these are deterministic stand-ins for model-driven agents,
 * used because this environment has no model API access. They are
 * schema-SENSITIVE on purpose — tool selection scores live descriptions,
 * argument names come from the live schema, argument values come from the
 * user intent — so server mutations change their behaviour the way they
 * would change a model's. They validate the pipeline mechanically; they do
 * NOT prove how real models behave (docs/20 A-01). Swapping in a model
 * provider means implementing this same `AgentPolicy` interface over an API.
 */

export interface StepSink {
  call(tool: string, args: JsonObject): McpToolResult;
}

/**
 * Metadata a real (non-scripted) policy can expose about its most recent
 * run() call — token usage, cost, the system prompt actually used. Scripted
 * policies have none of this, so it is surfaced via an OPTIONAL method
 * (`lastRunMetadata`) rather than widening the required AgentPolicy surface.
 * recordSession() calls it (if present) right after run() resolves.
 */
export interface AgentRunMetadata {
  provider: string | null;
  model: string | null;
  temperature: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  system_prompt_digest: string | null;
}

export interface AgentPolicy {
  id: string;
  /** 'scripted' = deterministic stand-in, no network I/O. 'model' = real provider call. */
  kind: 'model' | 'scripted';
  /**
   * Async because real policies make network calls. Scripted policies have
   * no I/O and simply resolve immediately — behaviourally identical to the
   * old synchronous version, just wrapped in a Promise.
   */
  run(scenario: Scenario, tools: ToolSpec[], sink: StepSink): Promise<string>;
  lastRunMetadata?(): AgentRunMetadata | null;
}

interface TaskLike {
  id: number;
  title: string;
  status: string;
}

function lc(s: string): string {
  return s.toLowerCase();
}

/** Score tools by keyword occurrences in name + description; ties keep list order. */
function selectTool(tools: ToolSpec[], keywords: string[]): ToolSpec | null {
  let best: ToolSpec | null = null;
  let bestScore = 0;
  for (const t of tools) {
    const hay = lc(`${t.name} ${t.description}`);
    let score = 0;
    for (const k of keywords) if (hay.includes(k)) score += 1;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

/** Fill args for a tool from an intent-derived value map, by schema param name. */
function fillArgs(tool: ToolSpec, values: Record<string, unknown>): JsonObject {
  const args: JsonObject = {};
  for (const p of tool.params) {
    const n = lc(p.name);
    let v: unknown;
    if (n === 'query' || n === 'q') v = values.searchText;
    else if (n === 'id') v = values.id;
    else if (n.includes('title')) v = values.title;
    else if (n === 'priority') v = values.priority;
    else if (n === 'assignee') v = values.assignee;
    else if (n === 'project') v = values.project;
    else if (n === 'status') v = values.status;
    // limit: never filled — rely on server default (probes default_changed).
    if (v !== undefined && v !== null) args[p.name] = v as never;
  }
  return args;
}

function tasksFrom(result: McpToolResult): TaskLike[] {
  if (result.status !== 'ok' || result.payload === null || typeof result.payload !== 'object') return [];
  const p = result.payload as JsonObject;
  const arr = Array.isArray(p.tasks) ? p.tasks : p.task ? [p.task] : [];
  return arr.filter((t): t is never => t !== null && typeof t === 'object') as unknown as TaskLike[];
}

const FIND_KEYWORDS = ['search', 'match', 'query'];
const LIST_KEYWORDS = ['list', 'browsing', 'filter'];
const CREATE_KEYWORDS = ['create', 'new'];
const COMPLETE_KEYWORDS = ['done', 'complete'];
const REOPEN_KEYWORDS = ['reopen'];
const ASSIGN_KEYWORDS = ['assign'];
const UPDATE_KEYWORDS = ['update', 'fields', 'change'];
const GET_KEYWORDS = ['single', 'fetch', 'numeric id'];

/** Locate a task by title text: search tool if one scores, else list + client-side filter. */
function findByTitle(
  tools: ToolSpec[],
  sink: StepSink,
  titleText: string,
): { matches: TaskLike[]; toolUsed: string } {
  const searchTool = selectTool(tools, FIND_KEYWORDS);
  const listTool = selectTool(tools, LIST_KEYWORDS);
  const tool = searchTool ?? listTool ?? tools[0]!;
  const args = fillArgs(tool, { searchText: titleText });
  const result = sink.call(tool.name, args);
  const returned = tasksFrom(result);
  const needle = lc(titleText);
  const matches = returned.filter((t) => lc(t.title).includes(needle));
  return { matches, toolUsed: tool.name };
}

class PlannerBase implements AgentPolicy {
  readonly kind = 'scripted';

  constructor(
    public readonly id: string,
    private readonly opts: { verifyBeforeMutate: boolean; completeViaUpdate: boolean; splitCompound: boolean },
  ) {}

  // No I/O in this method; async only to satisfy AgentPolicy's Promise<string> contract.
  async run(scenario: Scenario, tools: ToolSpec[], sink: StepSink): Promise<string> {
    const intent = scenario.intent as Record<string, unknown>;
    const action = String(intent.action ?? '');
    switch (action) {
      case 'list': {
        const tool = selectTool(tools, LIST_KEYWORDS) ?? tools[0]!;
        sink.call(tool.name, fillArgs(tool, { status: intent.status, project: intent.project }));
        return 'Here is the listing.';
      }
      case 'search': {
        const tool = selectTool(tools, FIND_KEYWORDS) ?? selectTool(tools, LIST_KEYWORDS) ?? tools[0]!;
        sink.call(tool.name, fillArgs(tool, { searchText: intent.query }));
        return 'Here are the matching tasks.';
      }
      case 'create':
      case 'create_assign': {
        const create = selectTool(tools, CREATE_KEYWORDS);
        if (!create) return 'No creation tool available.';
        const values: Record<string, unknown> = {
          title: intent.title,
          priority: intent.priority,
          project: intent.project,
        };
        if (!this.opts.splitCompound) values.assignee = intent.assignee;
        const created = sink.call(create.name, fillArgs(create, values));
        if (created.status === 'error') return 'Creating the task failed.';
        const createdTask = tasksFrom(created)[0];
        if (this.opts.splitCompound && intent.assignee && createdTask) {
          const assign = selectTool(tools, ASSIGN_KEYWORDS);
          if (assign) sink.call(assign.name, fillArgs(assign, { id: createdTask.id, assignee: intent.assignee }));
        }
        return 'Created.';
      }
      case 'assign': {
        const assign = selectTool(tools, ASSIGN_KEYWORDS) ?? tools[0]!;
        const r = sink.call(assign.name, fillArgs(assign, { id: intent.id, assignee: intent.assignee }));
        return r.status === 'ok' ? 'Assigned.' : 'Assignment failed.';
      }
      case 'reopen': {
        const reopen = selectTool(tools, REOPEN_KEYWORDS) ?? tools[0]!;
        const r = sink.call(reopen.name, fillArgs(reopen, { id: intent.id }));
        return r.status === 'ok' ? 'Reopened.' : 'The server rejected the reopen request.';
      }
      case 'update_priority': {
        const update = selectTool(tools, UPDATE_KEYWORDS) ?? tools[0]!;
        const r = sink.call(update.name, fillArgs(update, { id: intent.id, priority: intent.priority }));
        return r.status === 'ok' ? 'Priority updated.' : 'Update failed.';
      }
      case 'complete':
        return this.complete(intent, tools, sink);
      default:
        return `I do not know how to handle intent action '${action}'.`;
    }
  }

  private complete(intent: Record<string, unknown>, tools: ToolSpec[], sink: StepSink): string {
    let id: number | undefined = typeof intent.id === 'number' ? intent.id : undefined;
    if (id === undefined && typeof intent.title === 'string') {
      const { matches } = findByTitle(tools, sink, intent.title);
      if (matches.length === 0) return `I could not find a task matching '${intent.title}'.`;
      if (matches.length > 1) {
        const names = matches.map((m) => `#${m.id} '${m.title}'`).join(', ');
        return `Multiple tasks match: ${names}. Which one should I complete?`;
      }
      id = matches[0]!.id;
    }
    if (id === undefined) return 'I could not determine which task to complete.';
    if (this.opts.verifyBeforeMutate) {
      const get = selectTool(tools, GET_KEYWORDS);
      if (get) {
        const g = sink.call(get.name, fillArgs(get, { id }));
        if (g.status === 'error') return `Task ${id} does not exist.`;
        const task = tasksFrom(g)[0];
        if (task && task.status === 'done') return `Task ${id} is already done.`;
      }
    }
    if (this.opts.completeViaUpdate) {
      const update = selectTool(tools, UPDATE_KEYWORDS) ?? tools[0]!;
      const r = sink.call(update.name, { ...fillArgs(update, { id }), status: 'done' });
      return r.status === 'ok' ? `Task ${id} marked done.` : 'The server rejected the update.';
    }
    const complete = selectTool(tools, COMPLETE_KEYWORDS) ?? tools[0]!;
    const r = sink.call(complete.name, fillArgs(complete, { id }));
    return r.status === 'ok' ? `Task ${id} marked done.` : 'The server reported an error completing the task.';
  }
}

/** Careful agent: verifies before mutating, single compound calls. */
export const plannerV1: AgentPolicy = new PlannerBase('scripted/planner-v1', {
  verifyBeforeMutate: true,
  completeViaUpdate: false,
  splitCompound: false,
});

/** Terser agent: no pre-verification, direct complete_task, splits compounds. */
export const plannerLite: AgentPolicy = new PlannerBase('scripted/planner-lite', {
  verifyBeforeMutate: false,
  completeViaUpdate: false,
  splitCompound: true,
});

/** Alternative-path agent: completes via update_task(status=done). */
export const plannerAlt: AgentPolicy = new PlannerBase('scripted/planner-alt', {
  verifyBeforeMutate: false,
  completeViaUpdate: true,
  splitCompound: false,
});

export const DEFAULT_POLICIES: AgentPolicy[] = [plannerV1, plannerLite, plannerAlt];

export function policyById(id: string): AgentPolicy {
  const found = DEFAULT_POLICIES.find((p) => p.id === id);
  if (!found) throw new Error(`unknown policy: ${id}`);
  return found;
}
