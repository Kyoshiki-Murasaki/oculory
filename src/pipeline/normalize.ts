import type { NormalizedTrace, OutcomeRecord, RawTrace } from '../schema/types.js';
import { extractEntities } from './entities.js';

/**
 * Normalisation (docs/04 §Normalised trace): a normalized trace is the raw
 * trace plus (a) its deterministic outcome record and (b) deterministically
 * extracted intent entities, with a redaction pass applied to free text.
 *
 * Redaction here is the minimal local-development pass (emails and long
 * digit runs masked in the user intent and final response). Importing
 * EXTERNAL traces requires the stronger pass specified in docs/13 before it
 * is permitted — this hook is where it plugs in.
 */
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const LONG_DIGITS = /\b\d{7,}\b/g;

export function redactText(text: string): string {
  return text.replace(EMAIL, '[email]').replace(LONG_DIGITS, '[number]');
}

export function normalizeTrace(raw: RawTrace, outcome: OutcomeRecord): NormalizedTrace {
  if (outcome.trace_id !== raw.trace_id) {
    throw new Error(`outcome ${outcome.trace_id} does not belong to trace ${raw.trace_id}`);
  }
  return {
    ...raw,
    user_intent: redactText(raw.user_intent),
    final_response: raw.final_response === null ? null : redactText(raw.final_response),
    normalized: true,
    outcome,
    intent_entities: extractEntities(raw.user_intent),
  };
}
