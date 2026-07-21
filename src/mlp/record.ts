import { randomUUID } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { AdapterJson, AdapterOperationResult, AnyOculoryAdapter } from './adapters/types.js';
import type { AdapterRegistry } from './adapters/registry.js';
import { postgresRuntimeEnvironment } from './adapters/postgres.js';
import { extractClaim, type ExtractedClaim } from './claim.js';
import { parseTaskConfig } from './config.js';
import { assertPublicMlpExecutionSupported, runBoundedProcess, type BoundedProcessResult } from './process.js';
import { startParentProxy, type ParentProxyHandle, type ParentProxyResult } from './proxy.js';
import { redactEvidence, sanitizeDiagnostic, sensitiveEnvironmentValues } from './redact.js';
import { PublicRunStore } from './run-store.js';
import type { OculoryTaskConfig, TargetConfig } from './types.js';
import { materializeWorkspace } from './workspace.js';

export type PublicRunClassification =
  | 'behaviorally-passed'
  | 'behaviorally-violated'
  | 'infrastructure-failed'
  | 'indeterminate';

export interface ToolWitness {
  status: 'success' | 'error' | 'unavailable' | 'ambiguous';
  detail: string;
}

export interface TargetRunEvidence {
  id: string;
  adapter: string;
  before: AdapterJson | null;
  after: AdapterJson | null;
  diff: AdapterJson | null;
  error: string | null;
}

export interface PublicRunSummary {
  schema_version: 'oculory-public-run-v1';
  run_id: string;
  task_id: string;
  profile: string;
  classification: PublicRunClassification;
  agent_claim: ExtractedClaim;
  tool_result: ToolWitness;
  observed_state: {
    status: 'available' | 'unavailable';
    changed_targets: string[];
  };
  process: {
    exit_code: number | null;
    timed_out: boolean;
    cancelled: boolean;
    output_limit_exceeded: boolean;
  } | null;
  cleanup: {
    passed: boolean;
    process_group_absent: boolean;
    proxy: boolean;
    adapters: Record<string, boolean>;
    workspace: boolean;
  };
  infrastructure_error: string | null;
}

export interface ExecuteTaskRunOptions {
  taskPath: string;
  taskSource: string;
  profile: string;
  registry: AdapterRegistry;
  store?: PublicRunStore;
  signal?: AbortSignal;
  finalize?: boolean;
  timeoutMs?: number;
  registerTask?: boolean;
}

export interface ExecutedTaskRun {
  summary: PublicRunSummary;
  targets: TargetRunEvidence[];
  runtimeTargets: Array<{ id: string; adapter: string; before: unknown; after: unknown | null; diff: unknown | null }>;
  proxyEvents: unknown[];
  store: PublicRunStore;
}

interface PreparedTarget {
  definition: TargetConfig;
  adapter: AnyOculoryAdapter;
  prepared: unknown;
  before: unknown | null;
  beforeReady: boolean;
  reset: AdapterOperationResult | null;
  after: unknown | null;
  diff: unknown | null;
  error: string | null;
}

export async function executeTaskRun(task: OculoryTaskConfig, options: ExecuteTaskRunOptions): Promise<ExecutedTaskRun> {
  assertPublicMlpExecutionSupported();
  const store = options.store ?? new PublicRunStore();
  const taskPath = store.resolveTaskPath(options.taskPath, options.taskSource);
  const validatedTask = parseTaskConfig(options.taskSource).value;
  if (!isDeepStrictEqual(task, validatedTask)) throw new Error('validated task source does not match the requested task configuration');
  const profile = task.agent_profiles[options.profile];
  if (profile === undefined) throw new Error(`task has no agent profile '${options.profile}'`);
  assertTaskRunPreflight(task, options.registry, store.projectRoot);
  if (options.registerTask === true) store.registerTask(task.task_id, taskPath, options.taskSource);
  const runId = store.allocateRunId();
  store.writeText(runId, 'task.yaml', options.taskSource);

  const taskDirectory = dirname(taskPath);
  let workspace: Awaited<ReturnType<typeof materializeWorkspace>> | null = null;
  let processResult: BoundedProcessResult | null = null;
  let proxyEvents: unknown[] = [];
  let proxyHandle: ParentProxyHandle | null = null;
  let proxyResult: ParentProxyResult | null = null;
  let claim: ExtractedClaim = { status: 'unavailable', text: null, source: task.claim_extraction.type };
  let toolWitness: ToolWitness = { status: 'unavailable', detail: 'no uniquely attributable tool result' };
  let infrastructureError: string | null = null;
  const targets: PreparedTarget[] = [];
  const adapterCleanup: Record<string, boolean> = {};
  let workspaceCleanup = false;
  let agentSensitiveValues: string[] = [];

  try {
    workspace = await materializeWorkspace(task.workspace, taskDirectory, runId);
    const reset = await workspace.reset();
    if (!reset.passed) throw new Error(`workspace reset verification failed: ${reset.detail}`);

    for (const definition of [...task.targets].sort((left, right) => left.id.localeCompare(right.id))) {
      const adapter = options.registry.resolve(definition.adapter).adapter;
      const rawConfiguration = runtimeConfiguration(definition, workspace.root);
      const configuration = adapter.validateConfiguration(rawConfiguration);
      adapterCleanup[definition.id] = false;
      const prepared = await adapter.prepare(configuration, {
        runId,
        workspaceRoot: workspace.root,
        signal: options.signal,
      });
      const target: PreparedTarget = {
        definition,
        adapter,
        prepared,
        before: null,
        beforeReady: false,
        reset: null,
        after: null,
        diff: null,
        error: null,
      };
      targets.push(target);
      const registeredBaseline = adapter.normalizeSnapshot(await adapter.snapshotBefore(prepared));
      target.reset = await adapter.reset(prepared, registeredBaseline);
      if (!target.reset.passed) throw new Error(`adapter reset verification failed for ${definition.id}: ${target.reset.detail}`);
      target.before = adapter.normalizeSnapshot(await adapter.snapshotBefore(prepared));
      target.beforeReady = true;
    }

    const promptPath = resolve(workspace.temporary_root, 'prompt.txt');
    const mcpConfigPath = resolve(workspace.temporary_root, 'mcp.json');
    writeFileSync(promptPath, task.prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const upstreamCommand = resolveExecutable(expand(task.mcp_server.command, replacements(task, options.profile, runId, workspace.root, promptPath, mcpConfigPath)), taskDirectory);
    const upstreamArguments = task.mcp_server.arguments.map((part) => expand(part, replacements(task, options.profile, runId, workspace!.root, promptPath, mcpConfigPath)));
    const upstreamEnvironment = selectEnvironment(task.mcp_server.env_allowlist);
    const agentEnvironment = selectEnvironment(profile.env_allowlist);
    agentSensitiveValues = sensitiveEnvironmentValues(agentEnvironment);
    const runtimeEnvironment = new Map<string, string>();
    for (const target of targets) {
      if (target.definition.adapter !== 'postgres') continue;
      for (const [name, value] of Object.entries(postgresRuntimeEnvironment(target.prepared, task.mcp_server.env_allowlist))) {
        const prior = runtimeEnvironment.get(name);
        if (prior !== undefined && prior !== value) throw new Error(`multiple targets require conflicting upstream environment variable '${name}'`);
        runtimeEnvironment.set(name, value);
      }
    }
    for (const [name, value] of runtimeEnvironment) upstreamEnvironment[name] = value;
    const endpoint = proxyEndpoint(runId);
    proxyHandle = await startParentProxy({
      upstream: {
        command: upstreamCommand,
        arguments: upstreamArguments,
        cwd: workspace.root,
        environment: upstreamEnvironment,
      },
      private_roots: [workspace.root, workspace.temporary_root, taskDirectory, endpoint],
      sensitive_values: agentSensitiveValues,
    }, endpoint);
    writeFileSync(mcpConfigPath, `${JSON.stringify({
      mcpServers: {
        oculory: {
          command: process.execPath,
          args: [fileURLToPath(new URL('./relay-main.js', import.meta.url)), endpoint],
        },
      },
    })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    const values = replacements(task, options.profile, runId, workspace.root, promptPath, mcpConfigPath);
    const argv = profile.argv.map((part) => expand(part, values));
    if (argv.length === 0) throw new Error('agent profile argv must not be empty');
    argv[0] = resolveExecutable(argv[0]!, taskDirectory);
    processResult = await runBoundedProcess({
      argv: argv as [string, ...string[]],
      cwd: workspace.root,
      env: agentEnvironment,
      timeoutMs: options.timeoutMs,
      privateRoots: [workspace.root, workspace.temporary_root, taskDirectory],
      signal: options.signal,
    });
    claim = processResult.stdout_truncated
      ? { status: 'unavailable', text: null, source: task.claim_extraction.type }
      : extractClaim(processResult.stdout, workspace.root, task.claim_extraction);
    if (claim.text !== null) {
      claim = {
        ...claim,
        text: sanitizeDiagnostic(
          claim.text,
          [workspace.root, workspace.temporary_root, taskDirectory],
          agentSensitiveValues,
        ),
      };
    }
    proxyResult = await proxyHandle.close();
    proxyEvents = proxyResult.events;
    if (proxyResult.error !== null && infrastructureError === null) infrastructureError = `parent proxy failed: ${proxyResult.error}`;
    toolWitness = deriveToolWitness(proxyEvents);

    for (const target of targets) {
      try {
        if (!target.beforeReady) throw new Error('registered before-state is unavailable');
        target.after = target.adapter.normalizeSnapshot(await target.adapter.snapshotAfter(target.prepared));
        target.diff = target.adapter.diff(target.before, target.after);
      } catch (error) {
        target.error = sanitizeDiagnostic(errorMessage(error), [workspace.root, workspace.temporary_root, taskDirectory]);
      }
    }
  } catch (error) {
    infrastructureError = sanitizeDiagnostic(errorMessage(error), workspace === null ? [taskDirectory] : [workspace.root, workspace.temporary_root, taskDirectory]);
  } finally {
    if (proxyHandle !== null && proxyResult === null) {
      try {
        proxyResult = await proxyHandle.close();
        proxyEvents = proxyResult.events;
        if (proxyResult.error !== null && infrastructureError === null) infrastructureError = `parent proxy failed: ${proxyResult.error}`;
      } catch (error) {
        if (infrastructureError === null) infrastructureError = `parent proxy cleanup failed: ${sanitizeDiagnostic(errorMessage(error), workspace === null ? [taskDirectory] : [workspace.root, workspace.temporary_root, taskDirectory])}`;
      }
    }
    for (const target of [...targets].reverse()) {
      try {
        const cleaned = await target.adapter.cleanup(target.prepared);
        adapterCleanup[target.definition.id] = cleaned.passed;
        if (!cleaned.passed && infrastructureError === null) infrastructureError = `adapter cleanup failed for ${target.definition.id}: ${cleaned.detail}`;
      } catch (error) {
        adapterCleanup[target.definition.id] = false;
        if (infrastructureError === null) infrastructureError = `adapter cleanup failed for ${target.definition.id}: ${errorMessage(error)}`;
      }
    }
    if (workspace !== null) {
      try {
        const cleaned = await workspace.cleanup();
        workspaceCleanup = cleaned.passed && !cleaned.residue;
        if (!workspaceCleanup && infrastructureError === null) infrastructureError = `workspace cleanup failed: ${cleaned.detail}`;
      } catch (error) {
        if (infrastructureError === null) infrastructureError = `workspace cleanup failed: ${errorMessage(error)}`;
      }
    }
  }

  const processFailed = processResult === null || processResult.exit_code !== 0 || processResult.timed_out || processResult.cancelled || processResult.output_limit_exceeded;
  const snapshotsAvailable = targets.length === task.targets.length && targets.every((target) => target.beforeReady && target.after !== null && target.diff !== null && target.error === null);
  const proxyCleanup = proxyResult?.cleanup_passed ?? false;
  const processGroupAbsent = (processResult?.cleanup.process_group_absent ?? false) && proxyCleanup;
  const cleanupPassed = processGroupAbsent && workspaceCleanup && Object.values(adapterCleanup).every(Boolean);
  if (processFailed && infrastructureError === null) infrastructureError = processFailure(processResult);
  if (!snapshotsAvailable && infrastructureError === null) infrastructureError = 'independent final target state is unavailable';
  if (!cleanupPassed && infrastructureError === null) infrastructureError = 'run cleanup could not be proven';

  const targetEvidence = targets.map((target): TargetRunEvidence => ({
    id: target.definition.id,
    adapter: target.definition.adapter,
    before: target.adapter.redact(target.before),
    after: target.after === null ? null : target.adapter.redact(target.after),
    diff: target.diff === null ? null : target.adapter.redact(target.diff),
    error: target.error,
  }));
  const summary: PublicRunSummary = {
    schema_version: 'oculory-public-run-v1',
    run_id: runId,
    task_id: task.task_id,
    profile: options.profile,
    classification: infrastructureError === null ? 'behaviorally-passed' : 'infrastructure-failed',
    agent_claim: claim,
    tool_result: toolWitness,
    observed_state: {
      status: snapshotsAvailable ? 'available' : 'unavailable',
      changed_targets: targetEvidence.filter((target) => target.diff !== null && hasChanged(target.diff)).map((target) => target.id).sort(),
    },
    process: processResult === null ? null : {
      exit_code: processResult.exit_code,
      timed_out: processResult.timed_out,
      cancelled: processResult.cancelled,
      output_limit_exceeded: processResult.output_limit_exceeded,
    },
    cleanup: {
      passed: cleanupPassed,
      process_group_absent: processGroupAbsent,
      proxy: proxyCleanup,
      adapters: Object.fromEntries(Object.entries(adapterCleanup).sort(([left], [right]) => left.localeCompare(right))),
      workspace: workspaceCleanup,
    },
    infrastructure_error: infrastructureError,
  };

  store.writeJson(runId, 'summary.json', summary);
  store.writeJson(runId, 'evidence/agent.json', redactEvidence({
    stdout: processResult?.stdout ?? '',
    stderr: processResult?.stderr ?? '',
    process: processResult,
  }, [taskDirectory, ...(workspace === null ? [] : [workspace.root, workspace.temporary_root])], agentSensitiveValues));
  store.writeJson(runId, 'evidence/proxy.json', proxyEvents);
  store.writeJson(runId, 'target-index.json', targetEvidence.map(({ id, adapter }) => ({ id, adapter })));
  for (const target of targetEvidence) {
    store.writeJson(runId, `snapshots/${target.id}-before.json`, target.before);
    store.writeJson(runId, `snapshots/${target.id}-after.json`, target.after);
    store.writeJson(runId, `diffs/${target.id}.json`, target.diff);
  }
  for (const target of targets) store.writeJson(runId, `resets/${target.definition.id}.json`, target.reset);
  store.writeJson(runId, 'cleanup.json', summary.cleanup);
  if (options.finalize !== false) store.finalize(runId);
  return {
    summary,
    targets: targetEvidence,
    runtimeTargets: targets.map((target) => ({
      id: target.definition.id,
      adapter: target.definition.adapter,
      before: target.before,
      after: target.after,
      diff: target.diff,
    })),
    proxyEvents,
    store,
  };
}

export function assertTaskRunPreflight(
  task: OculoryTaskConfig,
  registry: AdapterRegistry,
  validationWorkspace: string,
): void {
  for (const definition of [...task.targets].sort((left, right) => left.id.localeCompare(right.id))) {
    let adapter: AnyOculoryAdapter;
    try {
      adapter = registry.resolve(definition.adapter).adapter;
    } catch {
      throw new Error(`task target '${definition.id}' uses unregistered adapter '${definition.adapter}'`);
    }
    try {
      const configuration = adapter.validateConfiguration(runtimeConfiguration(definition, validationWorkspace));
      assertAdapterCredentialIsolation(task, definition, configuration);
    } catch (error) {
      throw new Error(`task target '${definition.id}' has invalid ${definition.adapter} configuration: ${errorMessage(error)}`);
    }
  }
}

function assertAdapterCredentialIsolation(task: OculoryTaskConfig, target: TargetConfig, value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const configuration = value as Record<string, unknown>;
  if (target.adapter === 'postgres') {
    const connectionEnv = configuration.connectionEnv;
    if (typeof connectionEnv !== 'string') return;
    if (!task.mcp_server.env_allowlist.includes(connectionEnv)) {
      throw new Error(`connectionEnv '${connectionEnv}' must appear in the MCP server environment allowlist`);
    }
    for (const [profile, definition] of Object.entries(task.agent_profiles).sort(([left], [right]) => left.localeCompare(right))) {
      if (definition.env_allowlist.includes(connectionEnv)) {
        throw new Error(`connectionEnv '${connectionEnv}' must not appear in agent profile '${profile}' environment allowlist`);
      }
    }
    return;
  }
  if (target.adapter !== 'github-api') return;
  const tokenEnv = configuration.tokenEnv;
  if (typeof tokenEnv !== 'string') return;
  if (task.mcp_server.env_allowlist.includes(tokenEnv)) {
    throw new Error(`tokenEnv '${tokenEnv}' must not appear in the MCP server environment allowlist`);
  }
  for (const [profile, definition] of Object.entries(task.agent_profiles).sort(([left], [right]) => left.localeCompare(right))) {
    if (definition.env_allowlist.includes(tokenEnv)) {
      throw new Error(`tokenEnv '${tokenEnv}' must not appear in agent profile '${profile}' environment allowlist`);
    }
  }
}

export function runtimeConfiguration(target: TargetConfig, workspace: string): unknown {
  const configuration = expandUnknown(target.configuration, { '{workspace}': workspace }) as Record<string, unknown>;
  const watch = expandUnknown(target.watch, { '{workspace}': workspace }) as Record<string, unknown>;
  if (target.adapter === 'git-filesystem') {
    requireWatchKeys(watch, ['branches', 'paths'], 'git-filesystem');
    const watchPaths = runtimeStrings(watch.paths, 'git-filesystem target watch.paths');
    const filesystemMode = configuration.mode === 'filesystem';
    const watchBranches = watch.branches === undefined
      ? []
      : runtimeStrings(watch.branches, 'git-filesystem target watch.branches');
    if (!filesystemMode && watchBranches.length === 0) {
      throw new Error('git-filesystem target watch.branches must declare at least one branch in Git mode');
    }
    if (filesystemMode && watchBranches.length > 0) {
      throw new Error('git-filesystem target watch.branches is only valid in Git mode');
    }
    configuration.sourcePath = realpathSync(workspace);
    configuration.watchPaths = watchPaths;
    configuration.watchBranches = watchBranches;
    configuration.inPlace = true;
  } else if (target.adapter === 'postgres') {
    requireWatchKeys(watch, ['tables'], 'postgres');
    const watchedTables = runtimeStrings(watch.tables, 'postgres target watch.tables');
    if (!Array.isArray(configuration.tables)) throw new Error('postgres target configuration.tables must be an array');
    const configuredTables = new Map<string, unknown>();
    for (const entry of configuration.tables) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as Record<string, unknown>).name !== 'string') {
        throw new Error('postgres target configuration.tables entries must have a name');
      }
      configuredTables.set((entry as Record<string, unknown>).name as string, entry);
    }
    configuration.tables = watchedTables.map((name) => {
      const table = configuredTables.get(name);
      if (table === undefined) throw new Error(`postgres target watch table '${name}' is not configured`);
      return table;
    });
  } else if (target.adapter === 'github-api') {
    requireWatchKeys(watch, ['issues', 'pullRequests', 'branches'], 'github-api');
    const issues = runtimePositiveIntegers(watch.issues, 'github-api target watch.issues');
    const pullRequests = runtimePositiveIntegers(watch.pullRequests, 'github-api target watch.pullRequests');
    const branches = runtimeOptionalStrings(watch.branches, 'github-api target watch.branches');
    if (issues.length + pullRequests.length + branches.length === 0) {
      throw new Error('github-api target watch scope must not be empty');
    }
    configuration.issueNumbers = scopedNumbers(configuration.issueNumbers, issues, 'issue');
    configuration.pullRequestNumbers = scopedNumbers(configuration.pullRequestNumbers, pullRequests, 'pull request');
    configuration.branchNames = scopedStrings(configuration.branchNames, branches, 'branch');
  }
  return configuration;
}

function requireWatchKeys(watch: Record<string, unknown>, allowed: readonly string[], adapter: string): void {
  const unknown = Object.keys(watch).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) throw new Error(`${adapter} target watch has unknown field '${unknown[0]}'`);
}

function runtimeStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128 || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return [...value].sort() as string[];
}

function runtimeOptionalStrings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.length === 0) return [];
  return runtimeStrings(value, label);
}

function runtimePositiveIntegers(value: unknown, label: string): number[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.length === 0) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 128 || value.some((entry) => !Number.isSafeInteger(entry) || (entry as number) <= 0)) {
    throw new Error(`${label} must be a non-empty positive-integer array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return [...value].sort((left, right) => (left as number) - (right as number)) as number[];
}

function scopedNumbers(configured: unknown, watched: number[], label: string): number[] {
  const allowed = new Set(Array.isArray(configured) ? configured.filter((value): value is number => Number.isSafeInteger(value) && value > 0) : []);
  for (const value of watched) if (!allowed.has(value)) throw new Error(`github-api target watched ${label} '${value}' is not configured`);
  return watched;
}

function scopedStrings(configured: unknown, watched: string[], label: string): string[] {
  const allowed = new Set(Array.isArray(configured) ? configured.filter((value): value is string => typeof value === 'string') : []);
  for (const value of watched) if (!allowed.has(value)) throw new Error(`github-api target watched ${label} '${value}' is not configured`);
  return watched;
}

function replacements(
  task: OculoryTaskConfig,
  profile: string,
  runId: string,
  workspace: string,
  promptFile: string,
  mcpConfig: string,
): Record<string, string> {
  return {
    '{prompt}': task.prompt,
    '{prompt_file}': promptFile,
    '{mcp_config}': mcpConfig,
    '{workspace}': workspace,
    '{model}': task.agent_profiles[profile]?.model ?? profile,
    '{run_id}': runId,
  };
}

function expand(value: string, values: Record<string, string>): string {
  let output = value;
  for (const [placeholder, replacement] of Object.entries(values)) output = output.replaceAll(placeholder, replacement);
  return output;
}

function expandUnknown(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === 'string') return expand(value, values);
  if (Array.isArray(value)) return value.map((entry) => expandUnknown(entry, values));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandUnknown(entry, values)]));
  }
  return value;
}

function selectEnvironment(allowlist: readonly string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of [...new Set(allowlist)].sort()) {
    const value = process.env[name];
    if (value !== undefined) output[name] = value;
  }
  return output;
}

function resolveExecutable(executable: string, taskDirectory: string): string {
  if (isAbsolute(executable) || (!executable.includes('/') && !executable.includes('\\'))) return executable;
  return resolve(taskDirectory, executable);
}

function proxyEndpoint(runId: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\oculory-${process.pid}-${runId}-${randomUUID()}`;
  return resolve('/tmp', `oculory-${process.pid}-${runId}-${randomUUID()}.sock`);
}

function deriveToolWitness(events: unknown[]): ToolWitness {
  const results = events.filter((event) => {
    if (event === null || typeof event !== 'object') return false;
    const object = event as Record<string, unknown>;
    if (object.kind !== 'upstream_response' && object.kind !== 'upstream_error') return false;
    const value = object.value;
    return value !== null && typeof value === 'object' && (value as Record<string, unknown>).method === 'tools/call';
  }) as Array<Record<string, unknown>>;
  if (results.length === 0) return { status: 'unavailable', detail: 'no uniquely attributable tool result' };
  if (results.length > 1) return { status: 'ambiguous', detail: 'no uniquely attributable tool result' };
  const result = results[0]!;
  if (result.kind === 'upstream_error') return { status: 'error', detail: 'error' };
  const value = result.value as Record<string, unknown>;
  const payload = value.result;
  const isError = payload !== null && typeof payload === 'object' && (payload as Record<string, unknown>).isError === true;
  return isError ? { status: 'error', detail: 'error' } : { status: 'success', detail: 'success' };
}

function processFailure(result: BoundedProcessResult | null): string {
  if (result === null) return 'agent process did not start';
  if (result.cancelled) return 'agent execution was cancelled';
  if (result.timed_out) return 'agent execution timed out';
  if (result.output_limit_exceeded) return 'agent output exceeded its configured bound';
  return `agent process exited with code ${result.exit_code ?? 'unknown'}`;
}

function hasChanged(diff: AdapterJson): boolean {
  return diff !== null && typeof diff === 'object' && !Array.isArray(diff) && diff.changed === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
