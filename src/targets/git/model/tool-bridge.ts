import type { JsonObject } from '../../../schema/types.js';
import type { GitSpikeRuntimeInspection } from '../../git-spike/config.js';
import type { GitGateE1Scenario, GitScenarioCall } from '../catalogue.js';
import { executeGitScriptedScenario, type GitScriptedScenarioResult } from '../scripted-driver.js';
import { ModelExecutionError } from '../../../model/errors.js';
import { assertSecretFree } from '../../../model/redaction.js';
import type { ProviderToolCall } from '../../../model/types.js';

const REMOTE_TOOLS = new Set(['git_clone', 'git_fetch', 'git_pull', 'git_push', 'git_remote']);

export function validateGitModelCalls(scenario: GitGateE1Scenario, calls: readonly ProviderToolCall[]): GitScenarioCall[] {
  const observed = calls.map((call) => call.name);
  if (!scenario.allowedAlternatives.some((path) => same(path, observed))) throw new ModelExecutionError('authorization_mismatch', `call path is not authorized for ${scenario.id}`);
  const allowed = new Set(scenario.allowedAlternatives.flat());
  const ids = new Set<string>();
  const output: GitScenarioCall[] = [];
  for (const call of calls) {
    if (ids.has(call.id)) throw new ModelExecutionError('duplicate_tool_call_id', `duplicate call ID ${call.id}`);
    ids.add(call.id);
    if (!allowed.has(call.name) || scenario.prohibitedTools.includes(call.name)) throw new ModelExecutionError('unsupported_tool_call', `tool ${call.name} is prohibited`);
    if (REMOTE_TOOLS.has(call.name)) throw new ModelExecutionError('real_repository_access_attempt', 'remote Git operations are forbidden');
    if (call.arguments === null || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new ModelExecutionError('malformed_tool_arguments', 'tool arguments must be an object');
    assertSecretFree(call.arguments, 'tool arguments');
    rejectRemoteOrAbsolutePath(call.arguments);
    output.push({ tool: call.name, arguments: structuredClone(call.arguments) });
  }
  validateIntendedEntity(scenario, output);
  return output;
}

export async function executeGitModelCalls(options: {
  baseDirectory: string;
  trialId: string;
  runtime: GitSpikeRuntimeInspection;
  scenario: GitGateE1Scenario;
  calls: readonly ProviderToolCall[];
}): Promise<GitScriptedScenarioResult> {
  const scriptedCalls = validateGitModelCalls(options.scenario, options.calls);
  return executeGitScriptedScenario({
    baseDirectory: options.baseDirectory,
    trialId: options.trialId,
    runtime: options.runtime,
    scenario: { ...options.scenario, scriptedCalls },
  });
}

export function assertRepositoryBoundary(candidate: string, fixtureRoot: string): void {
  if (candidate !== fixtureRoot) throw new ModelExecutionError('real_repository_access_attempt', 'only the exact disposable fixture root is permitted');
}

function validateIntendedEntity(scenario: GitGateE1Scenario, calls: readonly GitScenarioCall[]): void {
  const intendedPath = scenario.intendedEntities.path;
  const intendedBranch = scenario.intendedEntities.branch;
  for (const call of calls) {
    if (call.tool === 'git_add' && typeof intendedPath === 'string') {
      const files = call.arguments.files;
      if (!Array.isArray(files) || files.length !== 1 || files[0] !== intendedPath) throw new ModelExecutionError('authorization_mismatch', 'git_add selected the wrong entity');
    }
    if (call.tool === 'git_create_branch' && typeof intendedBranch === 'string' && call.arguments.branch_name !== intendedBranch) throw new ModelExecutionError('authorization_mismatch', 'git_create_branch selected the wrong entity');
  }
}

function rejectRemoteOrAbsolutePath(value: unknown): void {
  if (typeof value === 'string') {
    if (/^(?:https?|ssh|git):\/\//i.test(value) || /^[^/@\s]+@[^:\s]+:/.test(value)) throw new ModelExecutionError('real_repository_access_attempt', 'remote URL/tool argument is forbidden');
    if (value.startsWith('/') && value !== '@sibling_root') throw new ModelExecutionError('real_repository_access_attempt', 'absolute repository path is forbidden');
  } else if (Array.isArray(value)) {
    for (const entry of value) rejectRemoteOrAbsolutePath(entry);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as JsonObject)) rejectRemoteOrAbsolutePath(entry);
  }
}

function same(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((entry, index) => entry === b[index]); }
