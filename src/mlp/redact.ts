const SECRET_KEY = /(authorization|cookie|credential|password|private[_-]?key|secret|token|api[_-]?key)/i;
const SECRET_VALUE = /(?:\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9_]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}|\bxox[baprs]-[A-Za-z0-9-]{8,}|\bAKIA[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@)/gi;
const SECRET_ARGUMENT = /^--?(?:authorization|cookie|credential|password|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?string|database[_-]?url|dsn)(?:=|$)/i;
const NON_SENSITIVE_ENVIRONMENT_NAMES = new Set([
  'APPDATA', 'CI', 'COMSPEC', 'GITHUB_ACTIONS', 'HOME', 'LANG', 'LC_ALL', 'LOCALAPPDATA',
  'NO_COLOR', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'TZ',
  'USERPROFILE', 'WINDIR', 'XDG_CONFIG_HOME',
]);

export function sensitiveEnvironmentValues(environment: Readonly<Record<string, string>>): string[] {
  return Object.entries(environment)
    .filter(([name]) => !NON_SENSITIVE_ENVIRONMENT_NAMES.has(name))
    .map(([, value]) => value);
}

export function redactEvidence(
  value: unknown,
  privateRoots: readonly string[] = [],
  sensitiveValues: readonly string[] = [],
): unknown {
  return redact(
    value,
    privateRoots.filter((root) => root.length > 0),
    normalizedSensitiveValues(sensitiveValues),
    new WeakSet<object>(),
  );
}

export function sanitizeDiagnostic(
  message: string,
  privateRoots: readonly string[] = [],
  sensitiveValues: readonly string[] = [],
): string {
  let safe = message;
  for (const value of normalizedSensitiveValues(sensitiveValues)) safe = safe.split(value).join('[REDACTED]');
  safe = safe.replace(SECRET_VALUE, '[REDACTED]');
  for (const root of [...privateRoots].sort((a, b) => b.length - a.length)) {
    safe = safe.split(root).join('{private-path}');
  }
  safe = safe
    .replace(/(?:\/Users|\/home|\/root|\/private\/var)\/[^\s:'"`]+/g, '{private-path}')
    .replace(/[A-Za-z]:\\Users\\[^\s:'"`]+/g, '{private-path}')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '?');
  return safe.length <= 2_000 ? safe : `${safe.slice(0, 1_997)}...`;
}

function redact(
  value: unknown,
  privateRoots: readonly string[],
  sensitiveValues: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return sanitizeDiagnostic(value, privateRoots, sensitiveValues);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return redactArray(value, privateRoots, sensitiveValues, seen);

  const entries: Array<[string, unknown]> = [];
  const keys = new Set<string>();
  for (const [key, entry] of Object.entries(value).slice(0, 1_000)) {
    const sensitiveKey = SECRET_KEY.test(key);
    const sanitizedKey = sanitizeDiagnostic(key, privateRoots, sensitiveValues);
    const requestedKey = sensitiveKey || sanitizedKey.includes('[REDACTED]') ? '[REDACTED_KEY]' : sanitizedKey;
    const safeKey = uniqueRedactedKey(keys, requestedKey);
    entries.push([safeKey, sensitiveKey ? '[REDACTED]' : redact(entry, privateRoots, sensitiveValues, seen)]);
  }
  return Object.fromEntries(entries);
}

function redactArray(
  value: unknown[],
  privateRoots: readonly string[],
  sensitiveValues: readonly string[],
  seen: WeakSet<object>,
): unknown[] {
  const output: unknown[] = [];
  let redactNext = false;
  for (const entry of value.slice(0, 1_000)) {
    if (redactNext) {
      output.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    if (typeof entry === 'string' && SECRET_ARGUMENT.test(entry)) {
      const equals = entry.indexOf('=');
      output.push(equals === -1 ? entry : `${entry.slice(0, equals + 1)}[REDACTED]`);
      redactNext = equals === -1;
      continue;
    }
    output.push(redact(entry, privateRoots, sensitiveValues, seen));
  }
  return output;
}

function normalizedSensitiveValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((left, right) => right.length - left.length);
}

function uniqueRedactedKey(keys: Set<string>, requested: string): string {
  let key = requested;
  for (let suffix = 2; keys.has(key); suffix += 1) key = `${requested}#${suffix}`;
  keys.add(key);
  return key;
}
