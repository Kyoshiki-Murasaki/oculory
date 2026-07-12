import type { JsonObject } from '../../schema/types.js';

/**
 * Deterministic entity extraction for filesystem intents (Phase 4).
 *
 * No LLM: pulls `path` / `from` / `to` (sandbox-relative paths), `content`
 * (quoted write/append payloads), and `query` (quoted search terms) out of the
 * natural-language intent so the miner can link a tool argument back to the
 * intent (arg_equals_entity / content_equals) rather than freezing a literal.
 * Parallels src/pipeline/entities.ts for the task server.
 */
const QUOTED = /'([^']*)'|"([^"]*)"/g;
const MOVE_COPY = /\b(?:move|copy|relocate|rename|backup of)\s+(\S+)\s+(?:to|at)\s+(\S+)/i;

function looksLikePath(token: string): boolean {
  return token.includes('/') || /\.[A-Za-z0-9]+$/.test(token);
}

function cleanToken(token: string): string {
  // strip surrounding punctuation, then a single trailing slash (dir refs).
  return token.replace(/^[^A-Za-z0-9._/-]+/, '').replace(/[.,?!;:]+$/, '').replace(/\/$/, '');
}

export function extractFsEntities(intent: string): JsonObject {
  const out: JsonObject = {};

  // Work on a copy with quoted spans removed so a quoted payload — which may
  // itself contain words like "search" or a "."  — is never mistaken for a
  // search keyword or a path.
  const withoutQuotes = intent.replace(QUOTED, ' ');

  // 1. Quoted spans (content / query payloads). "search intent" is decided
  //    from the text OUTSIDE the quotes only.
  const quoted: string[] = [];
  for (const m of intent.matchAll(QUOTED)) quoted.push((m[1] ?? m[2]) ?? '');
  const searchish = /\b(named|matching|contains|search|find files)\b/i.test(withoutQuotes);
  if (quoted.length > 0) {
    if (searchish) out.query = quoted[0] ?? '';
    else out.content = quoted[quoted.length - 1] ?? '';
  }

  // 2. Paths (from the quote-stripped copy).
  const move = withoutQuotes.match(MOVE_COPY);
  if (move) {
    out.from = cleanToken(move[1]!);
    out.to = cleanToken(move[2]!);
  } else {
    for (const rawTok of withoutQuotes.split(/\s+/)) {
      const tok = cleanToken(rawTok);
      if (tok.length > 0 && looksLikePath(tok)) {
        out.path = tok;
        break;
      }
    }
  }

  return out;
}
