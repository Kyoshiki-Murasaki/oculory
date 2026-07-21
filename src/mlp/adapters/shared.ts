import { timingSafeEqual } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type {
  AdapterAssertion,
  AdapterAssertionResult,
  AdapterEvaluationMode,
  AdapterJson,
  AdapterOperator,
} from './types.js';

const SECRET_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?string|database[_-]?url|dsn|session)/i;
const SECRET_VALUE = /(?:\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@)/i;
const SECRET_NAME = /(?:^|[._-])(?:auth|authorization|cookie|credential|credentials|password|passwd|private[_-]?key|secret|token|api[_-]?key|access[_-]?key)(?:$|[._-])/i;
const PRIVATE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const PRIVATE_PATH_FRAGMENT = /(?:\/(?:Users|home|root|private\/var)\/[^\s:'"`\u0000-\u001f]+|[A-Za-z]:\\Users\\[^\s:'"`\u0000-\u001f]+)/g;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.sort().join(', ')}`);
}

export function requireString(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (pattern !== undefined && !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function requireStringArray(value: unknown, label: string, maximum = 256): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`${label} must contain 1-${maximum} non-empty strings`);
  }
  return [...new Set(value as string[])];
}

export function requireBoundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

export function toAdapterJson(value: unknown): AdapterJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `<bytes:${value.byteLength}>`;
  if (Array.isArray(value)) return value.map(toAdapterJson);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, toAdapterJson(entry)]),
    );
  }
  return String(value);
}

export function redactSecrets(value: unknown): AdapterJson {
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Date || Buffer.isBuffer(value) || value instanceof Uint8Array) return toAdapterJson(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === 'object') {
    const keys = new Set<string>();
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        const sensitiveKey = SECRET_KEY.test(key) || SECRET_VALUE.test(key);
        const safeKey = uniqueRedactedKey(keys, sensitiveKey ? '<redacted-key>' : redactString(key));
        return [safeKey, sensitiveKey ? '<redacted>' : redactSecrets(entry)];
      }));
  }
  return toAdapterJson(value);
}

function redactString(value: string): string {
  if (SECRET_VALUE.test(value)) return '<redacted>';
  const withoutControls = stripVTControlCharacters(value).replace(CONTROL_CHARACTER, '?');
  if (PRIVATE_PATH.test(withoutControls)) return '<private-path>';
  return withoutControls.replace(PRIVATE_PATH_FRAGMENT, '<private-path>');
}

function uniqueRedactedKey(keys: Set<string>, requested: string): string {
  let key = requested;
  for (let suffix = 2; keys.has(key); suffix += 1) key = `${requested}#${suffix}`;
  keys.add(key);
  return key;
}

export function isSecretShapedName(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return normalized.split('/').some((part) =>
    part === '.env' ||
    part.startsWith('.env.') && !/^\.env\.(?:example|sample|template)$/.test(part) ||
    part === '.netrc' ||
    part === '.npmrc' ||
    part === '.pypirc' ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(part) ||
    SECRET_NAME.test(part));
}

export function containsSecretValue(value: string): boolean {
  return SECRET_VALUE.test(value);
}

export function evaluateObserved(
  assertion: AdapterAssertion,
  before: AdapterJson | null,
  after: AdapterJson | null,
): AdapterAssertionResult {
  const expected = assertion.expected ?? null;
  const reportedExpected = redactSecrets(expected);
  const reportedAfter = redactSecrets(after);
  if (assertion.evaluationMode === 'ignore') {
    return result(assertion, true, true, reportedExpected, reportedAfter, 'assertion ignored by contract');
  }

  let passed = false;
  switch (assertion.operator) {
    case 'exists':
      passed = expected === false ? after === null : after !== null;
      break;
    case 'equals':
      passed = assertion.evaluationMode === 'subset' ? isSubset(expected, after) : equalJson(expected, after);
      break;
    case 'count': {
      const count = Array.isArray(after) ? after.length : typeof after === 'number' ? after : null;
      passed = typeof expected === 'number' && count !== null &&
        (assertion.evaluationMode === 'subset' ? count >= expected : count === expected);
      break;
    }
    case 'unchanged':
      passed = equalJson(before, after);
      break;
    case 'none':
      passed = after === null || after === false || (Array.isArray(after) && after.length === 0);
      break;
    case 'subset':
      passed = isSubset(expected, after);
      break;
  }
  return result(
    assertion,
    passed,
    false,
    reportedExpected,
    reportedAfter,
    passed ? 'assertion satisfied' : `expected ${render(reportedExpected)}, observed ${render(reportedAfter)}`,
  );
}

export function equalJson(left: AdapterJson | null, right: AdapterJson | null): boolean {
  const leftBytes = Buffer.from(JSON.stringify(left));
  const rightBytes = Buffer.from(JSON.stringify(right));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function isSubset(expected: AdapterJson | null, observed: AdapterJson | null): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(observed)) return false;
    const remaining = [...observed];
    for (const entry of expected) {
      const match = remaining.findIndex((candidate) => isSubset(entry, candidate));
      if (match === -1) return false;
      remaining.splice(match, 1);
    }
    return true;
  }
  if (expected !== null && typeof expected === 'object') {
    if (observed === null || typeof observed !== 'object' || Array.isArray(observed)) return false;
    return Object.entries(expected).every(([key, value]) => key in observed && isSubset(value, observed[key] ?? null));
  }
  return equalJson(expected, observed);
}

function result(
  assertion: AdapterAssertion,
  passed: boolean,
  ignored: boolean,
  expected: AdapterJson | null,
  observed: AdapterJson | null,
  detail: string,
): AdapterAssertionResult {
  return {
    assertionId: assertion.id,
    passed,
    ignored,
    operator: assertion.operator,
    evaluationMode: assertion.evaluationMode,
    expected,
    observed,
    detail,
  };
}

function render(value: AdapterJson | null): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 240) return serialized;
  return `${serialized.slice(0, 237)}...`;
}

export function assertSupportedOperator(operator: AdapterOperator, supported: readonly AdapterOperator[]): void {
  if (!supported.includes(operator)) throw new Error(`operator ${operator} is not supported for this selector`);
}

export function assertSupportedMode(mode: AdapterEvaluationMode): void {
  if (mode !== 'exact' && mode !== 'subset' && mode !== 'ignore') throw new Error(`unsupported evaluation mode: ${mode as string}`);
}
