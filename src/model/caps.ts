import { ModelExecutionError } from './errors.js';
import type { AccountingLedger, GateFCapPolicy, ModelUsage } from './types.js';

const MAX = Number.MAX_SAFE_INTEGER;

export const EMPTY_LEDGER = (): AccountingLedger => ({
  sessions: 0, turns: 0, mcpCalls: 0, inputTokens: 0, outputTokens: 0,
  contextTokens: 0, retries: 0, costMicros: 0, responseDigests: [],
});

export class CapEngine {
  readonly ledger: AccountingLedger;
  private readonly accounted = new Set<string>();
  private currentSessionTurns = 0;

  constructor(readonly policy: GateFCapPolicy, initial: AccountingLedger = EMPTY_LEDGER()) {
    validatePolicy(policy);
    this.ledger = structuredClone(initial);
    validateLedger(this.ledger);
    for (const digest of this.ledger.responseDigests) this.accounted.add(digest);
  }

  reserveSession(): void {
    this.check('session_cap_exceeded', this.ledger.sessions, 1, this.policy.maximumSessions);
    this.ledger.sessions += 1;
    this.currentSessionTurns = 0;
  }

  checkWorstCaseNextRequest(inputTokens: number, outputTokens: number, contextTokens: number, retryIndex: number): void {
    for (const value of [inputTokens, outputTokens, contextTokens, retryIndex]) integer(value);
    this.check('turn_cap_exceeded', this.currentSessionTurns, 1, this.policy.maximumTurnsPerSession);
    this.check('input_token_cap_exceeded', this.ledger.inputTokens, inputTokens, this.policy.maximumInputTokens);
    this.check('output_token_cap_exceeded', this.ledger.outputTokens, outputTokens, this.policy.maximumOutputTokens);
    this.check('context_token_cap_exceeded', this.ledger.contextTokens, contextTokens, this.policy.maximumContextTokens);
    this.check('retry_cap_exceeded', this.ledger.retries, retryIndex, this.policy.maximumRetries);
    const worstCost = tokenCost(inputTokens, outputTokens, this.policy);
    this.check('budget_cap_exceeded', this.ledger.costMicros, worstCost, this.policy.hardDollarMicros);
  }

  recordAttempt(retry: boolean): void {
    this.check('turn_cap_exceeded', this.currentSessionTurns, 1, this.policy.maximumTurnsPerSession);
    if (retry) {
      this.check('retry_cap_exceeded', this.ledger.retries, 1, this.policy.maximumRetries);
      this.ledger.retries += 1;
    }
    this.ledger.turns = safeAdd(this.ledger.turns, 1);
    this.currentSessionTurns = safeAdd(this.currentSessionTurns, 1);
  }

  reserveMcpCalls(sessionCalls: number, nextCalls: number): void {
    integer(sessionCalls); integer(nextCalls);
    this.check('mcp_call_cap_exceeded', sessionCalls, nextCalls, this.policy.maximumMcpCallsPerSession);
    this.check('mcp_call_cap_exceeded', this.ledger.mcpCalls, nextCalls, this.policy.maximumTotalMcpCalls);
    this.ledger.mcpCalls = safeAdd(this.ledger.mcpCalls, nextCalls);
  }

  accountUsage(responseDigest: string, usage: ModelUsage | null): void {
    if (usage === null) throw new ModelExecutionError('provider_usage_missing', 'provider response omitted usage');
    if (this.accounted.has(responseDigest)) throw new ModelExecutionError('provider_usage_invalid', 'duplicate usage accounting');
    for (const value of Object.values(usage)) integer(value);
    if (usage.cachedInputTokens > usage.inputTokens) throw new ModelExecutionError('provider_usage_invalid', 'cached input exceeds input usage');
    this.check('input_token_cap_exceeded', this.ledger.inputTokens, usage.inputTokens, this.policy.maximumInputTokens);
    this.check('output_token_cap_exceeded', this.ledger.outputTokens, usage.outputTokens, this.policy.maximumOutputTokens);
    this.check('context_token_cap_exceeded', this.ledger.contextTokens, usage.toolResultTokens, this.policy.maximumContextTokens);
    const cost = tokenCost(usage.inputTokens - usage.cachedInputTokens, usage.outputTokens, this.policy);
    this.check('budget_cap_exceeded', this.ledger.costMicros, cost, this.policy.hardDollarMicros);
    this.ledger.inputTokens = safeAdd(this.ledger.inputTokens, usage.inputTokens);
    this.ledger.outputTokens = safeAdd(this.ledger.outputTokens, usage.outputTokens);
    this.ledger.contextTokens = safeAdd(this.ledger.contextTokens, usage.toolResultTokens);
    this.ledger.costMicros = safeAdd(this.ledger.costMicros, cost);
    this.ledger.responseDigests.push(responseDigest);
    this.accounted.add(responseDigest);
  }

  private check(code: ConstructorParameters<typeof ModelExecutionError>[0], current: number, next: number, maximum: number): void {
    if (safeAdd(current, next) > maximum) throw new ModelExecutionError(code, `worst-case next action exceeds cap`, { current, next, maximum });
  }
}

export function tokenCost(inputTokens: number, outputTokens: number, policy: GateFCapPolicy): number {
  integer(inputTokens); integer(outputTokens);
  const numerator = safeAdd(safeMultiply(inputTokens, policy.inputPriceMicrosPerMillion), safeMultiply(outputTokens, policy.outputPriceMicrosPerMillion));
  return Math.ceil(numerator / 1_000_000);
}

function validatePolicy(policy: GateFCapPolicy): void {
  if (policy.version !== 'gate-f-cap-policy-v1') throw new ModelExecutionError('authorization_mismatch', 'unsupported cap policy version');
  for (const value of Object.values(policy).filter((entry): entry is number => typeof entry === 'number')) integer(value);
}

function validateLedger(ledger: AccountingLedger): void {
  for (const [key, value] of Object.entries(ledger)) if (key !== 'responseDigests') integer(value as number);
  if (new Set(ledger.responseDigests).size !== ledger.responseDigests.length) throw new ModelExecutionError('provider_usage_invalid', 'ledger contains duplicate response digests');
}

function integer(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ModelExecutionError('provider_usage_invalid', 'accounting values must be non-negative safe integers');
}

function safeAdd(a: number, b: number): number {
  integer(a); integer(b);
  const value = a + b;
  if (!Number.isSafeInteger(value) || value > MAX) throw new ModelExecutionError('provider_usage_invalid', 'integer accounting overflow');
  return value;
}

function safeMultiply(a: number, b: number): number {
  integer(a); integer(b);
  const value = a * b;
  if (!Number.isSafeInteger(value) || value > MAX) throw new ModelExecutionError('provider_usage_invalid', 'integer accounting overflow');
  return value;
}
