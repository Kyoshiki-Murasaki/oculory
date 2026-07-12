import { hashResponse, MOCK_MODEL_IDENTITY, MOCK_MODEL_SNAPSHOT, MOCK_PROVIDER_IDENTITY, validateProviderRequest } from './provider.js';
import { MODEL_PROTOCOL_VERSION, PROVIDER_ADAPTER_VERSION, type ModelUsage, type ProviderAdapter, type ProviderRequest, type ProviderResponse, type ProviderToolCall } from './types.js';

export const MOCK_PROVIDER_VERSION = 'deterministic-mock-provider-v1' as const;

export interface MockTurn {
  finishReason: 'tool_calls' | 'stop' | 'refusal';
  toolCalls?: ProviderToolCall[];
  text?: string;
  refusalClassification?: string;
  usage: ModelUsage;
}

export interface MockTrajectory {
  identity: string;
  turns: MockTurn[];
}

export class DeterministicMockProvider implements ProviderAdapter {
  readonly adapterVersion = PROVIDER_ADAPTER_VERSION;
  readonly providerIdentity = MOCK_PROVIDER_IDENTITY;
  readonly modelIdentity = MOCK_MODEL_IDENTITY;
  readonly modelSnapshot = MOCK_MODEL_SNAPSHOT;
  readonly networkCapable = false as const;
  private index = 0;

  constructor(readonly trajectory: MockTrajectory, private readonly reportedAttemptCount = 1) {}

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    validateProviderRequest(request);
    const turn = this.trajectory.turns[this.index++];
    if (turn === undefined) throw new Error(`mock trajectory exhausted: ${this.trajectory.identity}`);
    const base: Omit<ProviderResponse, 'responseDigest'> = {
      protocolVersion: MODEL_PROTOCOL_VERSION, requestId: request.requestId,
      providerRequestId: `mock-${this.trajectory.identity}-${String(this.index).padStart(2, '0')}`,
      providerIdentity: this.providerIdentity, reportedModelIdentity: this.modelIdentity,
      reportedModelSnapshot: this.modelSnapshot,
      responseMessages: [{ role: 'assistant', content: turn.text ?? '' }],
      orderedToolCalls: structuredClone(turn.toolCalls ?? []), textOutput: turn.text ?? '',
      finishReason: turn.finishReason, usage: structuredClone(turn.usage), providerWarnings: [],
      refusalClassification: turn.refusalClassification ?? null, rawResponseSidecarReference: null,
      attemptCount: this.reportedAttemptCount, latencyMs: 7,
    };
    const response = { ...base, responseDigest: '' };
    response.responseDigest = hashResponse(response);
    return response;
  }
}

const usage = (input: number, output: number, context = 0): ModelUsage => ({ inputTokens: input, outputTokens: output, cachedInputTokens: 0, toolResultTokens: context });

export function trajectoryForScenario(scenarioId: string, calls: readonly { tool: string; arguments: Record<string, unknown> }[]): MockTrajectory {
  return {
    identity: `${scenarioId}-mock-v1`,
    turns: [
      {
        finishReason: calls.length === 0 ? 'stop' : 'tool_calls',
        toolCalls: calls.map((call, index) => ({ id: `${scenarioId}-call-${index + 1}`, name: call.tool, arguments: structuredClone(call.arguments) as never })),
        text: calls.length === 0 ? 'The request is ambiguous; no mutation is safe.' : '',
        usage: usage(120 + calls.length * 10, 24 + calls.length * 4),
      },
      ...(calls.length === 0 ? [] : [{ finishReason: 'stop' as const, text: 'Task complete based on the recorded tool result.', usage: usage(180, 20, 48) }]),
    ],
  };
}
