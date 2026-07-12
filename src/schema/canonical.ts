import { createHash } from 'node:crypto';
import type { Json } from './types.js';

/**
 * Canonical JSON: object keys sorted lexicographically at every level,
 * no whitespace, arrays in given order. Stable across runs and platforms.
 * Numbers must be finite; -0 normalised to 0.
 */
export function canonicalJson(value: Json): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(Object.is(n, -0) ? 0 : n);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as { [k: string]: Json };
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k]!)}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashJson(value: Json): string {
  return sha256(canonicalJson(value));
}

export function shortId(prefix: string, value: Json): string {
  return `${prefix}-${hashJson(value).slice(0, 10)}`;
}
