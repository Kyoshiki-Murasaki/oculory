import type { ModelCompletionRequest, ModelCompletionResult } from '../../src/runner/model-policy.js';
import { extractFsEntities } from '../../src/examples/filesystem/entities.js';
import { finalMessage, hasToolResult, toolCall, toolNames } from './stub-model-client.js';

/**
 * A well-behaved filesystem agent stub (Phase 4). Reads the raw user intent
 * (NOT lowercased — paths and content are case-sensitive), parses the
 * path/content/query with the same deterministic extractor the miner uses, and
 * calls the obvious tool once. Used only by tests through StubModelClient —
 * never touches a real API.
 */
function rawUser(req: ModelCompletionRequest): string {
  return req.messages.find((m) => m.role === 'user')?.content ?? '';
}

export function fsGoodCitizen(): (i: number, req: ModelCompletionRequest) => ModelCompletionResult {
  return (_i, req) => {
    if (hasToolResult(req)) return finalMessage('Done.');
    const raw = rawUser(req);
    const lc = raw.toLowerCase();
    const names = toolNames(req);
    const e = extractFsEntities(raw);
    const path = typeof e.path === 'string' ? e.path : '.';
    const content = typeof e.content === 'string' ? e.content : '';
    const query = typeof e.query === 'string' ? e.query : '';
    const from = typeof e.from === 'string' ? e.from : '';
    const to = typeof e.to === 'string' ? e.to : '';

    if (/\blist\b/.test(lc) && names.includes('list_dir')) return toolCall('list_dir', { path });
    if (/\b(search|find|named)\b/.test(lc) && names.includes('search_files')) return toolCall('search_files', { query });
    if (/\b(stat|exist|how big)\b/.test(lc) && names.includes('stat_path')) return toolCall('stat_path', { path });
    if (/\b(move|relocate)\b/.test(lc) && names.includes('move_file')) return toolCall('move_file', { from, to });
    if (/\b(copy|backup)\b/.test(lc) && names.includes('copy_file')) return toolCall('copy_file', { from, to });
    if (/\b(delete|remove)\b/.test(lc) && names.includes('delete_file')) return toolCall('delete_file', { path });
    if (/\b(append|add)\b/.test(lc) && names.includes('append_file')) return toolCall('append_file', { path, content });
    if (/\b(create|write|save|overwrite)\b/.test(lc) && names.includes('write_file')) return toolCall('write_file', { path, content });
    if (/\b(read|show)\b/.test(lc) && names.includes('read_file')) return toolCall('read_file', { path });
    return finalMessage('Nothing to do.');
  };
}
