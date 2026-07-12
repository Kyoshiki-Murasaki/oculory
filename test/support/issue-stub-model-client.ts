import type { ModelCompletionRequest, ModelCompletionResult } from '../../src/runner/model-policy.js';
import { extractIssueEntities } from '../../src/examples/issuetracker/entities.js';
import { finalMessage, hasToolResult, toolCall, toolNames } from './stub-model-client.js';

/**
 * A well-behaved issue-tracker agent stub (Phase 5). Reads the raw user intent,
 * parses ids / assignees / labels / bodies / queries, and calls the obvious
 * tool. It is multi-turn aware: for a "find the issue matching 'X' and close/read
 * it" request it searches first, then acts on a UNIQUE match and STOPS on an
 * ambiguous one. Used only by tests through StubModelClient — never a real API.
 */
function rawUser(req: ModelCompletionRequest): string {
  return req.messages.find((m) => m.role === 'user')?.content ?? '';
}

function lastToolPayload(req: ModelCompletionRequest): Record<string, unknown> | null {
  const toolMsgs = req.messages.filter((m) => m.role === 'tool');
  if (toolMsgs.length === 0) return null;
  try {
    const parsed = JSON.parse(toolMsgs[toolMsgs.length - 1]!.content ?? 'null');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function idOf(raw: string): string | null {
  const m = raw.match(/\bISSUE-\d+\b/i);
  return m ? m[0].toUpperCase() : null;
}

export function issueGoodCitizen(): (i: number, req: ModelCompletionRequest) => ModelCompletionResult {
  return (_i, req) => {
    const raw = rawUser(req);
    // Detect the VERB on quote-stripped text so a quoted title/body (e.g. "Search
    // is slow") never triggers the wrong tool; entity VALUES still come from `raw`.
    const lc = raw.replace(/'[^']*'|"[^"]*"/g, ' ').toLowerCase();
    const names = toolNames(req);
    const e = extractIssueEntities(raw);
    const id = idOf(raw);

    const multiStepClose = /\bmatching\b/.test(lc) && /\bclos/.test(lc);
    const multiStepRead = /\bmatching\b/.test(lc) && /(show|detail|read)/.test(lc);
    const multiStep = multiStepClose || multiStepRead;

    // Turn 2+: we already called a tool. For a multi-step request, act on a unique
    // search match (or STOP safely on an ambiguous one); otherwise we are done.
    const prior = lastToolPayload(req);
    if (prior) {
      if (multiStep && Array.isArray(prior.ids)) {
        const ids = (prior.ids as unknown[]).map(String);
        if (ids.length === 1) {
          if (multiStepClose && names.includes('close_issue')) return toolCall('close_issue', { id: ids[0] });
          if (multiStepRead && names.includes('read_issue')) return toolCall('read_issue', { id: ids[0] });
        }
        return finalMessage(`More than one issue matches (or none). I will not modify anything.`);
      }
      return finalMessage('Done.');
    }

    // Turn 1: pick the obvious first tool.
    if (multiStep && names.includes('search_issues')) return toolCall('search_issues', { query: String(e.query ?? '') });
    if (/\blist\b/.test(lc) && names.includes('list_issues')) {
      const status = /\bclosed\b/.test(lc) ? 'closed' : /\bopen\b/.test(lc) ? 'open' : undefined;
      return toolCall('list_issues', status ? { status } : {});
    }
    if (/\b(search|find|matching)\b/.test(lc) && names.includes('search_issues')) {
      return toolCall('search_issues', { query: String(e.query ?? '') });
    }
    if (/\b(create|open a|file a|new issue)\b/.test(lc) && names.includes('create_issue')) {
      const args: Record<string, unknown> = { title: String(e.title ?? ''), body: String(e.body ?? '') };
      if (typeof e.priority === 'string') args.priority = e.priority;
      return toolCall('create_issue', args);
    }
    if (/\bassign\b/.test(lc) && names.includes('assign_issue')) {
      const assignee = lc.match(/\bto\s+([a-z]+)\b/);
      return toolCall('assign_issue', { id: id ?? '', assignee: assignee ? assignee[1]! : '' });
    }
    if (/\blabel\b/.test(lc) && names.includes('label_issue')) {
      const label = lc.match(/\bas\s+([a-z]+)\b/) ?? lc.match(/\blabel\s+([a-z]+)\s+to\b/);
      return toolCall('label_issue', { id: id ?? '', label: label ? label[1]! : '' });
    }
    if (/\bcomment\b/.test(lc) && names.includes('comment_issue')) {
      return toolCall('comment_issue', { id: id ?? '', body: String(e.body ?? '') });
    }
    if (/\bclose\b/.test(lc) && names.includes('close_issue')) return toolCall('close_issue', { id: id ?? '' });
    if (/\breopen\b/.test(lc) && names.includes('reopen_issue')) return toolCall('reopen_issue', { id: id ?? '' });
    if (/\b(read|show)\b/.test(lc) && names.includes('read_issue')) return toolCall('read_issue', { id: id ?? '' });
    return finalMessage('Nothing to do.');
  };
}
