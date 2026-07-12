import type { JsonObject } from '../schema/types.js';

/**
 * Deterministic entity extraction from a user intent string.
 * No LLM involved: quoted spans, task-id patterns, priority/status words,
 * assignee ("to <name>" / "assign <name>") and project ("project <name>").
 * Used by the miner to link argument values back to the intent
 * (arg_equals_entity), never to invent ground truth.
 */
export function extractEntities(intent: string): JsonObject {
  const out: JsonObject = {};
  const quoted = intent.match(/'([^']+)'|"([^"]+)"/);
  if (quoted) out.title = (quoted[1] ?? quoted[2])!;

  const idMatch = intent.match(/\btask\s+(?:#\s*)?(\d+)\b/i) ?? intent.match(/\b#(\d+)\b/);
  if (idMatch) out.id = Number(idMatch[1]);

  const prio = intent.match(/\b(low|medium|high)\s+priority\b/i) ?? intent.match(/\bpriority\s+(?:to\s+)?(low|medium|high)\b/i);
  if (prio) out.priority = prio[1]!.toLowerCase();

  const status = intent.match(/\b(open|in_progress|done)\b/i);
  if (status) out.status = status[1]!.toLowerCase();

  const stop = new Set(['low', 'medium', 'high', 'the', 'task', 'done', 'it', 'open']);
  for (const m of intent.matchAll(/\b(?:to|assign(?:ee)?:?)\s+([a-z][a-z0-9_]{1,20})\b/gi)) {
    const name = m[1]!.toLowerCase();
    if (!stop.has(name)) {
      out.assignee = name;
      break;
    }
  }

  const project = intent.match(/\bproject\s+['"]?([a-z0-9_-]+)['"]?/i);
  if (project) out.project = project[1]!.toLowerCase();

  return out;
}
