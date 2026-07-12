import type { JsonObject } from '../../schema/types.js';
import { KNOWN_USERS, ALLOWED_LABELS, ISSUE_PRIORITIES } from './server.js';

/**
 * Deterministic entity extraction for issue-tracker intents (Phase 5, docs/28).
 *
 * No LLM: pulls the structured entities a mined assertion can bind to out of the
 * natural-language intent, so the miner links a tool argument (or a state
 * postcondition) back to the INTENT rather than freezing an incidental literal:
 *   - `id`        an issue reference like ISSUE-2
 *   - `title`     a quoted issue title (create intents; the FIRST quoted span)
 *   - `body`      a quoted body / comment payload (the SECOND quoted span, or the
 *                 only quoted span in a comment intent)
 *   - `query`     a quoted search term (search / ambiguous intents)
 *   - `assignee`  a bare known-user token (alice / bob / carla)
 *   - `label`     a bare allowed-label token (bug / feature / urgent / docs)
 *   - `priority`  low / normal / high when stated
 * Parallels src/pipeline/entities.ts (task) and src/examples/filesystem/entities.ts.
 */
const QUOTED = /'([^']*)'|"([^"]*)"/g;
const ID = /\bISSUE-\d+\b/i;

export function extractIssueEntities(intent: string): JsonObject {
  const out: JsonObject = {};

  // Work on a copy with quoted spans removed so a quoted payload — which may itself
  // contain an issue id, a user name, a label word, or the word "search" — is never
  // mistaken for a reference / assignee / label / query keyword.
  const withoutQuotes = intent.replace(QUOTED, ' ');
  const lc = withoutQuotes.toLowerCase();

  // 1. Issue id reference (case-normalised to ISSUE-<n>) — from the quote-stripped copy,
  //    so an id mentioned inside a quoted title/body is never taken as the referenced issue.
  const idMatch = withoutQuotes.match(ID);
  if (idMatch) out.id = idMatch[0].toUpperCase();

  const quoted: string[] = [];
  for (const m of intent.matchAll(QUOTED)) quoted.push((m[1] ?? m[2]) ?? '');

  // 3. Classify the quoted spans by the surrounding (quote-free) verb context.
  const searchish = /\b(search|searching|find|matching|contains|containing)\b/.test(lc);
  const commentish = /\b(comment|remark|note)\b/.test(lc);
  const createish = /\b(create|creating|open a|file a|new issue|titled|title)\b/.test(lc);
  if (quoted.length > 0) {
    if (searchish) {
      out.query = quoted[0] ?? '';
    } else if (createish) {
      out.title = quoted[0] ?? '';
      if (quoted.length > 1) out.body = quoted[1] ?? '';
    } else if (commentish) {
      out.body = quoted[quoted.length - 1] ?? '';
    } else {
      out.title = quoted[0] ?? '';
    }
  }

  // 4. Bare-token entities from the quote-stripped copy.
  const user = lc.match(new RegExp(`\\b(${KNOWN_USERS.join('|')})\\b`));
  if (user) out.assignee = user[1]!;
  const label = lc.match(new RegExp(`\\b(${ALLOWED_LABELS.join('|')})\\b`));
  if (label) out.label = label[1]!;
  const priority = lc.match(new RegExp(`\\b(${ISSUE_PRIORITIES.join('|')})\\s+priority\\b|\\bpriority\\s+(${ISSUE_PRIORITIES.join('|')})\\b`));
  if (priority) out.priority = (priority[1] ?? priority[2])!;

  return out;
}
