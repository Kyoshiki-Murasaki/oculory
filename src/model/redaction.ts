import { ModelExecutionError } from './errors.js';

const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{12,}\b/g,
  /\bAKIA[A-Z0-9]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\bFAKE_GATE_F_SECRET_[A-Za-z0-9_]+\b/g,
];

export const PROVIDER_ENV_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
const FORBIDDEN_CHILD_ENV = /(API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PROVIDER|OPENAI|ANTHROPIC|GOOGLE|AZURE|AWS|COHERE|MISTRAL|GROQ|OPENROUTER)/i;

export function validateKeyEnvironmentName(name: string): void {
  if (!PROVIDER_ENV_NAME.test(name) || !/(KEY|TOKEN|SECRET)$/.test(name)) {
    throw new ModelExecutionError('authorization_mismatch', 'provider key environment-variable name is invalid');
  }
}

export function redactSecrets(value: string): string {
  let output = value;
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '<REDACTED>');
  return output;
}

export function containsSecret(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function assertSecretFree(value: unknown, context: string): void {
  if (containsSecret(value)) throw new ModelExecutionError('credential_exposure', `secret-like value in ${context}`);
}

export function assertLiteralSecretExcluded(value: Record<string, unknown>): void {
  const keys = Object.keys(value);
  const allowedPolicyFields = new Set(['key_environment_variable_name', 'literal_secrets_excluded', 'tool_token_rules']);
  if (keys.some((key) => /(^|_)(api_?key|secret|token|credential|password)($|_)/i.test(key) && !allowedPolicyFields.has(key))) {
    throw new ModelExecutionError('credential_exposure', 'authorization contains a literal secret field');
  }
  assertSecretFree(value, 'authorization');
}

export function sanitizeChildEnvironment(env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const safe = Object.fromEntries(Object.entries(env).filter(([name]) => !FORBIDDEN_CHILD_ENV.test(name)));
  for (const [name, value] of Object.entries(safe)) {
    assertSecretFree(value, `child environment ${name}`);
  }
  return Object.freeze(safe);
}

export function forbiddenChildEnvironmentNames(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).filter((name) => FORBIDDEN_CHILD_ENV.test(name)).sort();
}
