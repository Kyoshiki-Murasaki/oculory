import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { createBuiltinAdapterRegistry } from '../src/mlp/adapters/index.js';
import { executeTaskRun } from '../src/mlp/record.js';
import { startParentProxy } from '../src/mlp/proxy.js';
import { PublicRunStore } from '../src/mlp/run-store.js';
import type { OculoryTaskConfig } from '../src/mlp/types.js';

const SUPPORT_ROOT = resolve(process.cwd(), 'test', 'support');
const AGENT = join(SUPPORT_ROOT, 'mlp-fault-agent.mjs');
const SERVER = join(SUPPORT_ROOT, 'mlp-fault-server.mjs');
const FIXTURE = join(SUPPORT_ROOT, 'mlp-fault-fixture.mjs');
const CREDENTIAL_ENV = 'OCULORY_SYNTHETIC_LOCAL_CREDENTIAL';

test('MCP-only environment is available upstream but unavailable to the agent and persisted evidence', {
  skip: process.platform === 'win32',
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-mlp-proxy-boundary-'));
  const taskPath = join(root, 'task.yaml');
  const priorCredential = process.env[CREDENTIAL_ENV];
  const syntheticCredential = `opaque-local-${randomUUID()}`;
  try {
    process.env[CREDENTIAL_ENV] = syntheticCredential;
    const task = isolationTask();
    const taskSource = stringify(task, { lineWidth: 100, indent: 2 });
    writeFileSync(taskPath, taskSource, { encoding: 'utf8', mode: 0o600 });
    const store = new PublicRunStore(join(root, '.oculory', 'runs'));

    const executed = await executeTaskRun(task, {
      taskPath,
      taskSource,
      profile: 'isolated',
      registry: createBuiltinAdapterRegistry(),
      store,
      timeoutMs: 15_000,
    });

    assert.equal(
      executed.summary.classification,
      'behaviorally-passed',
      executed.summary.infrastructure_error ?? undefined,
    );
    assert.deepEqual(executed.summary.agent_claim, {
      status: 'available',
      text: 'MCP-only credential unavailable to agent',
      source: 'line-prefix',
    });
    assert.deepEqual(executed.summary.tool_result, { status: 'success', detail: 'success' });
    assert.deepEqual(executed.summary.observed_state, {
      status: 'available',
      changed_targets: ['workspace'],
    });
    assert.equal(executed.summary.cleanup.proxy, true);
    assert.equal(executed.summary.cleanup.passed, true);
    assert.match(JSON.stringify(executed.proxyEvents), /\[REDACTED\]/);
    store.verify(executed.summary.run_id);
    assert.equal(readTree(root).includes(syntheticCredential), false);
  } finally {
    if (priorCredential === undefined) delete process.env[CREDENTIAL_ENV];
    else process.env[CREDENTIAL_ENV] = priorCredential;
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent-only environment values are scrubbed from benign MCP arguments and finalized evidence', {
  skip: process.platform === 'win32',
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-mlp-agent-secret-boundary-'));
  const taskPath = join(root, 'task.yaml');
  const priorCredential = process.env[CREDENTIAL_ENV];
  const syntheticCredential = `opaque-agent-${randomUUID()}`;
  try {
    process.env[CREDENTIAL_ENV] = syntheticCredential;
    const task = agentSecretTask();
    const taskSource = stringify(task, { lineWidth: 100, indent: 2 });
    writeFileSync(taskPath, taskSource, { encoding: 'utf8', mode: 0o600 });
    const store = new PublicRunStore(join(root, '.oculory', 'runs'));

    const executed = await executeTaskRun(task, {
      taskPath,
      taskSource,
      profile: 'isolated',
      registry: createBuiltinAdapterRegistry(),
      store,
      timeoutMs: 15_000,
    });

    assert.equal(executed.summary.classification, 'behaviorally-passed', executed.summary.infrastructure_error ?? undefined);
    const proxyEvidence = JSON.stringify(executed.proxyEvents);
    assert.match(proxyEvidence, /\[REDACTED/);
    assert.equal(proxyEvidence.includes(syntheticCredential), false);
    store.verify(executed.summary.run_id);
    assert.equal(readTree(root).includes(syntheticCredential), false);
  } finally {
    if (priorCredential === undefined) delete process.env[CREDENTIAL_ENV];
    else process.env[CREDENTIAL_ENV] = priorCredential;
    rmSync(root, { recursive: true, force: true });
  }
});

test('parent broker records malformed JSON-RPC input without retaining the unsafe frame', {
  skip: process.platform === 'win32',
  timeout: 15_000,
}, async () => {
  const unsafe = `unsafe-raw-${randomUUID()}`;
  const frame = `{"jsonrpc":"2.0","id":1,"method":"ping","unsafe":"${unsafe}"\n`;
  const result = await abusiveBrokerSession([frame]);
  const evidence = JSON.stringify(result.events);
  assert.equal(result.connected, true);
  assert.equal(result.cleanup_passed, true);
  assert.match(evidence, /agent_request_rejected/);
  assert.match(evidence, /malformed_json_rpc/);
  assert.match(evidence, /frame_bytes/);
  assert.equal(evidence.includes(unsafe), false);
});

test('parent broker fails closed on an agent frame above 1 MiB', {
  skip: process.platform === 'win32',
  timeout: 15_000,
}, async () => {
  const result = await abusiveBrokerSession([
    `${JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: { padding: 'x'.repeat(1024 * 1024) } })}\n`,
  ]);
  assert.equal(result.connected, true);
  assert.equal(result.cleanup_passed, true);
  assert.match(result.error ?? '', /frame exceeded the 1 MiB cap/);
});

test('parent broker fails closed before cumulative evidence exceeds 4 MiB', {
  skip: process.platform === 'win32',
  timeout: 15_000,
}, async () => {
  const frames = Array.from({ length: 6 }, (_, index) => `${JSON.stringify({
    jsonrpc: '2.0',
    method: 'ping',
    params: Object.fromEntries(Array.from(
      { length: 400 },
      (_entry, field) => [`field_${index}_${field}`, 'x'.repeat(2_000)],
    )),
  })}\n`);
  const result = await abusiveBrokerSession(frames);
  assert.equal(result.connected, true);
  assert.equal(result.cleanup_passed, true);
  assert.match(result.error ?? '', /evidence exceeded the 4 MiB cap/);
  assert.ok(Buffer.byteLength(JSON.stringify(result.events)) <= 4 * 1024 * 1024);
});

function isolationTask(): OculoryTaskConfig {
  return {
    version: 'oculory-task-v1',
    task_id: 'proxy-environment-isolation',
    prompt: 'Invoke the disposable state mutation tool.',
    agent_profiles: {
      isolated: {
        argv: [
          process.execPath,
          AGENT,
          '--mcp-config',
          '{mcp_config}',
          '--mode',
          'env-isolation',
          '--run-id',
          '{run_id}',
        ],
        env_allowlist: safeEnvironmentNames(),
      },
    },
    mcp_server: {
      command: process.execPath,
      arguments: [
        SERVER,
        '--workspace',
        '{workspace}',
        '--mode',
        'env-isolation',
        '--run-id',
        '{run_id}',
      ],
      env_allowlist: [...safeEnvironmentNames(), CREDENTIAL_ENV],
    },
    workspace: {
      strategy: 'command',
      setup: [process.execPath, FIXTURE, 'setup', 'none', '{workspace}'],
      reset: [process.execPath, FIXTURE, 'reset', 'none', '{workspace}'],
      cleanup: [process.execPath, FIXTURE, 'cleanup', 'none', '{workspace}'],
    },
    targets: [{
      id: 'workspace',
      adapter: 'git-filesystem',
      configuration: { mode: 'filesystem' },
      watch: { paths: ['state.json'] },
    }],
    claim_extraction: { type: 'line-prefix', prefix: 'CLAIM: ' },
  };
}

function agentSecretTask(): OculoryTaskConfig {
  const task = isolationTask();
  return {
    ...task,
    task_id: 'proxy-agent-environment-redaction',
    agent_profiles: {
      isolated: {
        argv: task.agent_profiles.isolated!.argv.map((value) => value === 'env-isolation' ? 'agent-secret-request' : value),
        env_allowlist: [...safeEnvironmentNames(), CREDENTIAL_ENV],
      },
    },
    mcp_server: {
      ...task.mcp_server,
      arguments: task.mcp_server.arguments.map((value) => value === 'env-isolation' ? 'agent-secret-request' : value),
      env_allowlist: safeEnvironmentNames(),
    },
  };
}

function safeEnvironmentNames(): string[] {
  return ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'].filter((name) => process.env[name] !== undefined);
}

function readTree(root: string): string {
  const values: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else values.push(readFileSync(path, 'utf8'));
    }
  };
  visit(root);
  return values.join('\n');
}

async function abusiveBrokerSession(frames: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'oculory-mlp-proxy-abuse-'));
  const endpoint = `/tmp/oculory-${process.pid}-${randomUUID()}.sock`;
  const handle = await startParentProxy({
    upstream: {
      command: process.execPath,
      arguments: [SERVER, '--workspace', root, '--mode', 'good', '--run-id', 'run_0001'],
      cwd: root,
      environment: Object.fromEntries(
        ['PATH', 'SystemRoot'].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]),
      ),
    },
    private_roots: [root, endpoint],
  }, endpoint);
  try {
    const socket = createConnection(handle.endpoint);
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    socket.on('error', () => undefined);
    socket.resume();
    for (const frame of frames) socket.write(frame);
    socket.end();
    await closed;
    return await handle.close();
  } finally {
    await handle.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
