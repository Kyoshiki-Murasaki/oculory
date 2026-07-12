import type {
  ModelClient,
  ModelCompletionRequest,
  ModelCompletionResult,
} from '../../src/runner/model-policy.js';

/**
 * The ONLY ModelClient any test constructs. It replays deterministic canned
 * behaviour instead of hitting the network — no test in this repo calls a real
 * model API (constraint 3). `responder(callIndex, request)` decides each turn.
 */
export class StubModelClient implements ModelClient {
  readonly provider: string;
  readonly requests: ModelCompletionRequest[] = [];
  private i = 0;

  constructor(
    private readonly responder: (callIndex: number, request: ModelCompletionRequest) => ModelCompletionResult,
    provider = 'stub',
  ) {
    this.provider = provider;
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResult> {
    this.requests.push(request);
    return this.responder(this.i++, request);
  }
}

const USAGE = { input_tokens: 50, output_tokens: 10 };

export function finalMessage(text: string, usage = USAGE): ModelCompletionResult {
  return { content: text, tool_calls: null, usage };
}

export function toolCall(name: string, args: Record<string, unknown>, usage = USAGE, id = 'call'): ModelCompletionResult {
  return { content: null, tool_calls: [{ id, name, argumentsJson: JSON.stringify(args) }], usage };
}

export function hasToolResult(req: ModelCompletionRequest): boolean {
  return req.messages.some((m) => m.role === 'tool');
}

export function intentOf(req: ModelCompletionRequest): string {
  return (req.messages.find((m) => m.role === 'user')?.content ?? '').toLowerCase();
}

export function toolNames(req: ModelCompletionRequest): string[] {
  return req.tools.map((t) => t.function.name);
}

function idFrom(intent: string): number {
  const m = intent.match(/task\s+#?\s*(\d+)/i) ?? intent.match(/\b(\d+)\b/);
  return m ? Number(m[1]) : 1;
}

function quotedTitle(req: ModelCompletionRequest): string {
  const q = intentOf(req).match(/'([^']+)'/);
  return q ? q[1]! : 'untitled';
}

/**
 * A well-behaved single-step agent: reads the intent + available tools and
 * calls the obvious tool once, then replies. Enough to drive smoke scenarios
 * (list / complete) and the simple mining scenarios to clean outcomes.
 */
export function goodCitizen(): (i: number, req: ModelCompletionRequest) => ModelCompletionResult {
  return (_i, req) => {
    if (hasToolResult(req)) return finalMessage('Done.');
    const intent = intentOf(req);
    const names = toolNames(req);
    if (/\b(list|show|outstanding|open|how many)\b/.test(intent) && names.includes('list_tasks')) {
      return toolCall('list_tasks', intent.includes('open') ? { status: 'open' } : {});
    }
    if (/\b(search|find)\b/.test(intent) && names.includes('search_tasks')) {
      return toolCall('search_tasks', { query: 'deployment' });
    }
    if (/\b(create|add|new)\b/.test(intent) && names.includes('create_task')) {
      return toolCall('create_task', { title: quotedTitle(req) });
    }
    if (/\b(assign|give)\b/.test(intent) && names.includes('assign_task')) {
      return toolCall('assign_task', { id: idFrom(intent), assignee: 'dana' });
    }
    if (/\breopen\b/.test(intent) && names.includes('reopen_task')) {
      return toolCall('reopen_task', { id: idFrom(intent) });
    }
    if (/\bpriority\b/.test(intent) && names.includes('update_task')) {
      return toolCall('update_task', { id: idFrom(intent), priority: 'high' });
    }
    if (/\b(mark|complete|done|finish|close)\b/.test(intent) && names.includes('complete_task')) {
      return toolCall('complete_task', { id: idFrom(intent) });
    }
    return finalMessage('Nothing to do.');
  };
}
