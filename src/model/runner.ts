import { ModelExecutionError } from './errors.js';
import type { ModelSessionPhase, StateTransition } from './types.js';

const ORDER: ModelSessionPhase[] = [
  'preflight', 'authorization_validation', 'source_provenance', 'scenario_loading',
  'fixture_creation', 'initial_snapshot', 'target_startup', 'protocol_initialize', 'tool_discovery',
  'prompt_assembly', 'provider_request', 'provider_response_validation', 'tool_call_validation',
  'tool_execution', 'post_call_snapshot', 'verifier_checkpoint', 'continuation_decision',
  'final_verification', 'target_shutdown', 'cleanup', 'evidence_finalization', 'terminal',
];

export class ModelSessionStateMachine {
  private current: ModelSessionPhase | null = null;
  private readonly entries: StateTransition[] = [];

  transition(to: ModelSessionPhase, reason: string): void {
    if (!legal(this.current, to)) throw new ModelExecutionError('provider_malformed_response', `illegal session transition ${String(this.current)} -> ${to}`);
    this.entries.push({ index: this.entries.length, from: this.current, to, reason });
    this.current = to;
  }

  phase(): ModelSessionPhase | null { return this.current; }
  journal(): StateTransition[] { return structuredClone(this.entries); }
}

function legal(from: ModelSessionPhase | null, to: ModelSessionPhase): boolean {
  if (from === null) return to === 'preflight';
  if (from === 'continuation_decision' && to === 'provider_request') return true;
  if (from === 'provider_response_validation' && to === 'continuation_decision') return true;
  if (from === 'tool_call_validation' && to === 'continuation_decision') return true;
  if (from !== 'terminal' && to === 'target_shutdown') return true;
  if (from === 'cleanup' && to === 'evidence_finalization') return true;
  return ORDER.indexOf(to) === ORDER.indexOf(from) + 1;
}
