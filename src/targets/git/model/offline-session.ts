import type { JsonObject } from '../../../schema/types.js';
import { CapEngine } from '../../../model/caps.js';
import { DeterministicMockProvider, trajectoryForScenario, type MockTrajectory } from '../../../model/mock-provider.js';
import { F0ProviderRegistry, MOCK_MODEL_IDENTITY, MOCK_MODEL_SNAPSHOT, MOCK_PROVIDER_IDENTITY, validateProviderResponse } from '../../../model/provider.js';
import { assertSecretFree } from '../../../model/redaction.js';
import { ModelSessionStateMachine } from '../../../model/runner.js';
import {
  MODEL_PROTOCOL_VERSION,
  PROVIDER_ADAPTER_VERSION,
  type ModelMessage,
  type ModelToolDefinition,
  type ProviderRequest,
  type ProviderResponse,
} from '../../../model/types.js';
import type { GitSpikeRuntimeInspection } from '../../git-spike/config.js';
import type { GitGateE1Scenario } from '../catalogue.js';
import type { GitScriptedScenarioResult } from '../scripted-driver.js';
import { executeGitModelCalls } from './tool-bridge.js';

export interface DeterministicMockGitTurnOptions {
  machine: ModelSessionStateMachine;
  caps: CapEngine;
  baseDirectory: string;
  trialId: string;
  sessionId: string;
  runtime: GitSpikeRuntimeInspection;
  scenario: GitGateE1Scenario;
  exactSchemas: JsonObject[];
  promptDigest: string;
  scenarioDigest: string;
  authorizationDigest: string;
  systemInstructions: string;
}

export interface DeterministicMockGitTurnResult {
  trajectory: MockTrajectory;
  messages: ModelMessage[];
  requests: ProviderRequest[];
  responses: ProviderResponse[];
  result: GitScriptedScenarioResult;
  sessionCalls: number;
}

/**
 * Execute the shared provider-free mock turn loop used by Gate F0 and the
 * offline developer pilot. Callers retain ownership of authorization,
 * evidence persistence, terminal classification, and cleanup reporting.
 */
export async function executeDeterministicMockGitTurns(
  options: DeterministicMockGitTurnOptions,
): Promise<DeterministicMockGitTurnResult> {
  const trajectory = trajectoryForScenario(options.scenario.id, options.scenario.scriptedCalls);
  const provider = new DeterministicMockProvider(trajectory);
  const selected = new F0ProviderRegistry(provider).select('mock');
  const messages: ModelMessage[] = [
    { role: 'system', content: options.systemInstructions },
    { role: 'user', content: options.scenario.intent },
  ];
  const requests: ProviderRequest[] = [];
  const responses: ProviderResponse[] = [];
  let result: GitScriptedScenarioResult | null = null;
  let sessionCalls = 0;

  for (let turnIndex = 0; turnIndex < trajectory.turns.length; turnIndex += 1) {
    options.machine.transition('provider_request', `mock turn ${turnIndex}`);
    options.caps.checkWorstCaseNextRequest(4_000, 2_000, 8_000, 0);
    options.caps.recordAttempt(false);
    const request: ProviderRequest = {
      protocolVersion: MODEL_PROTOCOL_VERSION,
      requestId: `${options.sessionId}-request-${turnIndex + 1}`,
      sessionId: options.sessionId,
      turnIndex,
      providerAdapterVersion: PROVIDER_ADAPTER_VERSION,
      providerIdentity: MOCK_PROVIDER_IDENTITY,
      modelIdentity: MOCK_MODEL_IDENTITY,
      modelSnapshot: MOCK_MODEL_SNAPSHOT,
      promptManifestDigest: options.promptDigest,
      scenarioManifestDigest: options.scenarioDigest,
      authorizationDigest: options.authorizationDigest,
      systemInstructions: messages[0]!.content,
      scenarioInstructions: options.scenario.intent,
      messages: structuredClone(messages),
      availableTools: toolDefinitions(options.exactSchemas, new Set(options.scenario.allowedAlternatives.flat())),
      exactMcpToolSchemas: structuredClone(options.exactSchemas),
      allowedToolNames: [...new Set(options.scenario.allowedAlternatives.flat())],
      maximumOutputTokens: 2_000,
      temperature: 0,
      seed: 0,
      reasoningControl: null,
      metadata: { scenarioId: options.scenario.id },
      timeoutMs: 30_000,
      retryPolicy: { maximumRetries: 0, attemptIndex: 0 },
      tracingPolicy: { retainRawResponse: true, redactSecrets: true },
    };
    assertSecretFree(request, 'provider request');
    requests.push(request);
    const response = validateProviderResponse(request, await selected.execute(request));
    responses.push(response);
    options.caps.accountUsage(response.responseDigest, response.usage);
    options.machine.transition('provider_response_validation', 'response correlated and validated');
    if (response.orderedToolCalls.length === 0) {
      options.machine.transition('continuation_decision', 'provider stopped without a tool call');
      break;
    }
    options.machine.transition('tool_call_validation', 'tool calls validated against scenario');
    options.caps.reserveMcpCalls(sessionCalls, response.orderedToolCalls.length);
    sessionCalls += response.orderedToolCalls.length;
    options.machine.transition('tool_execution', 'ordered calls bridged to pinned MCP target');
    result = await executeGitModelCalls({
      baseDirectory: options.baseDirectory,
      trialId: options.trialId,
      runtime: options.runtime,
      scenario: options.scenario,
      calls: response.orderedToolCalls,
    });
    options.machine.transition('post_call_snapshot', 'independent snapshot captured');
    options.machine.transition('verifier_checkpoint', 'git-verifier-v1 checkpoint recorded');
    options.machine.transition('continuation_decision', 'tool results require final provider stop');
    for (const [index, call] of response.orderedToolCalls.entries()) {
      messages.push({
        role: 'tool',
        name: call.name,
        toolCallId: call.id,
        content: JSON.stringify(result.execution.calls[index]?.rawOutcome ?? {}),
      });
    }
  }

  if (result === null) {
    result = await executeGitModelCalls({
      baseDirectory: options.baseDirectory,
      trialId: options.trialId,
      runtime: options.runtime,
      scenario: options.scenario,
      calls: [],
    });
  }

  return { trajectory, messages, requests, responses, result, sessionCalls };
}

function toolDefinitions(raw: JsonObject[], allowed: ReadonlySet<string>): ModelToolDefinition[] {
  return raw
    .filter((entry) => allowed.has(String(entry.name)))
    .map((entry) => ({
      name: String(entry.name),
      description: typeof entry.description === 'string' ? entry.description : '',
      inputSchema: entry.inputSchema as JsonObject,
    }));
}
