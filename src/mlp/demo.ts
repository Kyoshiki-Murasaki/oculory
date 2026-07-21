import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { approveRun } from './approve.js';
import { createBuiltinAdapterRegistry } from './adapters/index.js';
import { loadContractConfig, parseTaskConfig } from './config.js';
import { executeTaskRun, type PublicRunSummary } from './record.js';
import { renderViolation } from './renderer.js';
import { replayContract, violationModelFromSavedRun } from './replay.js';
import { PublicRunStore } from './run-store.js';
import { assertPublicMlpExecutionSupported } from './process.js';
import type { OculoryTaskConfig } from './types.js';

export interface DemoResult {
  output: string;
  duration_ms: number;
  residue: boolean;
  baseline_passes: number;
  changed_passes: number;
}

export async function runDemo(options: { color?: boolean; width?: number } = {}): Promise<DemoResult> {
  assertPublicMlpExecutionSupported();
  const started = Date.now();
  const project = mkdtempSync(join(tmpdir(), 'oculory-demo with spaces-'));
  let output = '';
  let baselinePasses = 0;
  let changedPasses = 0;
  try {
    initializeDemoProject(project);
    const taskPath = resolve(project, 'task.yaml');
    const task = demoTask();
    const taskSource = stringify(task, { lineWidth: 80, indent: 2 });
    parseTaskConfig(taskSource);
    writeFileSync(taskPath, taskSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    const store = new PublicRunStore(resolve(project, '.oculory', 'runs'));
    const registry = createBuiltinAdapterRegistry();
    const recorded = await executeTaskRun(task, {
      taskPath,
      taskSource,
      profile: 'baseline',
      registry,
      store,
      registerTask: true,
    });
    if (recorded.summary.classification !== 'behaviorally-passed') {
      const agent = store.readJson<{ stderr?: unknown }>(recorded.summary.run_id, 'evidence/agent.json');
      const proxy = store.readJson<Array<{ kind?: unknown; value?: unknown }>>(recorded.summary.run_id, 'evidence/proxy.json');
      const proxyError = [...proxy].reverse().find((event) => event.kind === 'upstream_error');
      const message = proxyError?.value !== null && typeof proxyError?.value === 'object'
        ? (proxyError.value as Record<string, unknown>).message
        : null;
      const detail = typeof message === 'string' ? message.slice(0, 300) : typeof agent.stderr === 'string' && agent.stderr.trim().length > 0
        ? agent.stderr.trim().slice(0, 300)
        : recorded.summary.infrastructure_error ?? 'unknown error';
      throw new Error(`demo record failed: ${detail}`);
    }
    const draft = await approveRun(recorded.summary.run_id, { store, cwd: project, yes: true });
    const contract = loadContractConfig(draft.path).value;
    const baseline = await replayContract(contract, {
      taskPath,
      taskSource,
      profile: 'baseline',
      registry,
      store,
      color: false,
      width: options.width,
    });
    const changed = await replayContract(contract, {
      taskPath,
      taskSource,
      profile: 'changed',
      registry,
      store,
      color: false,
      width: options.width,
    });
    baselinePasses = baseline.report.totals.behaviorally_passed;
    changedPasses = changed.report.totals.behaviorally_passed;
    if (baseline.report.status !== 'PASS' || baselinePasses !== 12) throw new Error('demo clean baseline replay did not pass 12/12');
    if (changed.report.status !== 'FAIL' || changedPasses !== 3 || changed.report.exit_code !== 2) {
      throw new Error('demo changed-agent replay did not produce the expected 3/12 behavioral violation');
    }
    const failed = changed.report.iterations.find((iteration) => iteration.classification === 'behaviorally-violated');
    if (failed === undefined) throw new Error('demo replay has no reconstructable violated run');
    const summary = store.readJson<PublicRunSummary>(failed.run_id, 'summary.json');
    const model = violationModelFromSavedRun(summary, failed.assertions, {
      profiles: changed.report.profiles,
    });
    const contradiction = renderViolation(model, { color: options.color, width: options.width });
    output = [
      'Oculory provider-free demo',
      '',
      `1. Recorded real MCP traffic as ${recorded.summary.run_id}.`,
      `2. Drafted and validated oculory.contracts/${task.task_id}.yaml.`,
      `3. Clean baseline replay: PASS (${baselinePasses}/12).`,
      `4. Rigged changed-agent replay: FAIL (${changedPasses}/12).`,
      '',
      contradiction.trimEnd(),
      '',
      'Try it on your own task:',
      '  oculory record ./task.yaml',
    ].join('\n') + '\n';
  } finally {
    rmSync(project, { recursive: true, force: true, maxRetries: 2 });
  }
  const duration = Date.now() - started;
  if (duration >= 5 * 60 * 1_000) throw new Error(`demo exceeded five minutes (${duration}ms)`);
  const residue = existsSync(project);
  if (residue) throw new Error('demo left temporary residue');
  return { output, duration_ms: duration, residue, baseline_passes: baselinePasses, changed_passes: changedPasses };
}

function initializeDemoProject(project: string): void {
  const environment: Record<string, string> = {
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name]!;
  }
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: project,
    env: environment,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function demoTask(): OculoryTaskConfig {
  const agent = fileURLToPath(new URL('./scripted-agent-main.js', import.meta.url));
  const server = fileURLToPath(new URL('./demo-server-main.js', import.meta.url));
  const fixture = fileURLToPath(new URL('./demo-fixture-main.js', import.meta.url));
  const environment = process.platform === 'win32'
    ? ['NODE_OPTIONS', 'OCULORY_NETWORK_GUARD_PROOF', 'PATH', 'SystemRoot', 'TEMP', 'TMP']
    : ['NODE_OPTIONS', 'OCULORY_NETWORK_GUARD_PROOF', 'PATH', 'TMPDIR'];
  return {
    version: 'oculory-task-v1',
    task_id: 'demo-create-feature-branch',
    prompt: 'Create feature/demo from develop, add the demo files, and commit them.',
    agent_profiles: {
      baseline: {
        argv: [process.execPath, agent, '--mcp-config', '{mcp_config}', '--mode', 'baseline', '--run-id', '{run_id}'],
        env_allowlist: [...environment],
      },
      changed: {
        argv: [process.execPath, agent, '--mcp-config', '{mcp_config}', '--mode', 'changed', '--run-id', '{run_id}'],
        env_allowlist: [...environment],
      },
    },
    mcp_server: {
      command: process.execPath,
      arguments: [server, '--workspace', '{workspace}'],
      env_allowlist: [...environment],
    },
    workspace: {
      strategy: 'command',
      setup: [process.execPath, fixture, 'prepare', '{workspace}'],
      reset: [process.execPath, fixture, 'reset', '{workspace}'],
      cleanup: [process.execPath, fixture, 'cleanup', '{workspace}'],
    },
    targets: [{
      id: 'workspace',
      adapter: 'git-filesystem',
      configuration: { mode: 'git', baseRefs: ['develop', 'main'] },
      watch: { branches: ['develop', 'feature/demo', 'main'], paths: ['.'] },
    }],
    claim_extraction: { type: 'stdout-final' },
  };
}
