import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createBuiltinAdapterRegistry } from '../src/mlp/adapters/index.js';
import { parseContractConfig, parseTaskConfig } from '../src/mlp/config.js';
import { runDemo } from '../src/mlp/demo.js';
import { assertPublicMlpExecutionSupported } from '../src/mlp/process.js';
import { executeTaskRun } from '../src/mlp/record.js';
import { replayContract } from '../src/mlp/replay.js';
import { PublicRunStore } from '../src/mlp/run-store.js';
import { materializeWorkspace } from '../src/mlp/workspace.js';

test('public MLP workspace and demo reject Windows before spawning a child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-platform-'));
  const marker = join(root, 'child-spawned');
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  try {
    assert.throws(() => assertPublicMlpExecutionSupported(), /no child process was started/);
    await assert.rejects(materializeWorkspace({
      strategy: 'command',
      setup: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
      reset: [process.execPath, '-e', ''],
      cleanup: [process.execPath, '-e', ''],
    }, root, 'windows-preflight'), /no child process was started/);
    assert.equal(existsSync(marker), false);
    await assert.rejects(runDemo(), /no child process was started/);
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    rmSync(root, { recursive: true, force: true });
  }
});

test('the public MLP platform preflight accepts supported POSIX platforms', () => {
  assert.doesNotThrow(() => assertPublicMlpExecutionSupported('darwin'));
  assert.doesNotThrow(() => assertPublicMlpExecutionSupported('linux'));
});

test('record and replay reject Windows before task registration or run allocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-platform-entry-'));
  const taskSource = readFileSync(resolve('fixtures/demo/task.yaml'), 'utf8');
  const contractSource = readFileSync(resolve('fixtures/demo/contract.yaml'), 'utf8');
  const taskPath = join(root, 'task.yaml');
  writeFileSync(taskPath, taskSource, 'utf8');
  const store = new PublicRunStore(join(root, '.oculory', 'runs'));
  const registry = createBuiltinAdapterRegistry();
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  try {
    await assert.rejects(executeTaskRun(parseTaskConfig(taskSource).value, {
      taskPath,
      taskSource,
      profile: 'baseline',
      registry,
      store,
      registerTask: true,
    }), /no child process was started/);
    await assert.rejects(replayContract(parseContractConfig(contractSource).value, {
      profile: 'baseline',
      registry,
      store,
    }), /no child process was started/);
    assert.equal(existsSync(join(root, '.oculory')), false);
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    rmSync(root, { recursive: true, force: true });
  }
});

test('public CLI execution commands reject Windows with usage status before resolving inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-platform-cli-'));
  try {
    for (const args of [
      ['record', 'missing-task.yaml'],
      ['replay', '--model', 'baseline'],
      ['demo'],
    ]) {
      const result = runCliAsWindows(args, root);
      assert.equal(result.status, 1, `${args[0]} should use the configuration-error exit status`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /no child process was started/);
    }
    assert.equal(existsSync(join(root, '.oculory')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCliAsWindows(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const main = pathToFileURL(resolve('dist/src/cli/main.js')).href;
  const bootstrap = [
    "Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });",
    `process.argv = [process.execPath, 'oculory', ...${JSON.stringify(args)}];`,
    `await import(${JSON.stringify(main)});`,
  ].join('\n');
  const result = spawnSync(process.execPath, [
    '--experimental-sqlite',
    '--no-warnings',
    '--input-type=module',
    '--eval',
    bootstrap,
  ], {
    cwd,
    encoding: 'utf8',
    env: safeTestEnvironment(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function safeTestEnvironment(): Record<string, string> {
  const environment: Record<string, string> = { LC_ALL: 'C', LANG: 'C' };
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
