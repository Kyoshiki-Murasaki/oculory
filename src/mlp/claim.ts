import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { assertSafeClaimRegex } from './regex-policy.js';
import type { OculoryTaskConfig } from './types.js';

export interface ExtractedClaim {
  status: 'available' | 'unavailable';
  text: string | null;
  source: string;
}

export function extractClaim(
  stdout: string,
  workspace: string,
  extractor: OculoryTaskConfig['claim_extraction'],
  maxBytes = 16 * 1024,
): ExtractedClaim {
  const bounded = Buffer.byteLength(stdout) <= maxBytes
    ? stdout
    : Buffer.from(stdout).subarray(0, maxBytes).toString('utf8');

  if (extractor.type === 'stdout-final') {
    const segments = bounded.trim().split(/\r?\n\s*\r?\n/).map((part) => part.trim()).filter(Boolean);
    return result(segments.at(-1) ?? null, 'stdout-final');
  }
  if (extractor.type === 'json-field') {
    try {
      let value: unknown = JSON.parse(bounded);
      for (const part of extractor.field.split('.')) {
        if (value === null || typeof value !== 'object' || !(part in value)) return result(null, 'json-field');
        value = (value as Record<string, unknown>)[part];
      }
      return result(typeof value === 'string' ? value : JSON.stringify(value), 'json-field');
    } catch {
      return result(null, 'json-field');
    }
  }
  if (extractor.type === 'line-prefix') {
    const lines = bounded.split(/\r?\n/);
    let line: string | undefined;
    for (let index = lines.length - 1; index >= 0; index--) {
      if (lines[index]!.startsWith(extractor.prefix)) {
        line = lines[index];
        break;
      }
    }
    return result(line === undefined ? null : line.slice(extractor.prefix.length).trim(), 'line-prefix');
  }
  if (extractor.type === 'regex') {
    assertSafeClaimRegex(extractor.pattern);
    const input = Buffer.from(bounded).subarray(0, extractor.max_bytes).toString('utf8');
    const match = new RegExp(extractor.pattern).exec(input);
    return result(match?.[1] ?? match?.[0] ?? null, 'regex');
  }

  const file = resolveInside(workspace, extractor.path);
  try {
    if (lstatSync(file).isSymbolicLink()) return result(null, 'output-file');
    const resolved = realpathSync(file);
    assertCanonicalInside(workspace, resolved);
    if (statSync(resolved).size > extractor.max_bytes) return result(null, 'output-file');
    return result(readFileSync(resolved, 'utf8').trim(), 'output-file');
  } catch {
    return result(null, 'output-file');
  }
}

function assertCanonicalInside(root: string, target: string): void {
  const rel = relative(realpathSync(root), target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('claim output path resolves outside the disposable workspace');
  }
}

function result(text: string | null, source: string): ExtractedClaim {
  const normalized = text?.trim() ?? '';
  return normalized.length === 0
    ? { status: 'unavailable', text: null, source }
    : { status: 'available', text: normalized, source };
}

function resolveInside(root: string, input: string): string {
  if (isAbsolute(input) || input.split(/[\\/]/).includes('..')) throw new Error('claim output path must stay inside the disposable workspace');
  const target = resolve(root, input);
  const rel = relative(resolve(root), target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('claim output path escapes the disposable workspace');
  return target;
}
