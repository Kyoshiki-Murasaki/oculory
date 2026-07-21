import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { createBuiltinAdapterRegistry } from '../src/mlp/adapters/index.js';
import { loadTaskConfig, parseTaskConfig } from '../src/mlp/config.js';
import { executeTaskRun } from '../src/mlp/record.js';
import { redactEvidence } from '../src/mlp/redact.js';
import { PublicRunStore } from '../src/mlp/run-store.js';
import { extractClaim } from '../src/mlp/claim.js';

test('evidence redaction covers keyed, argv, URI, provider-shaped, and private-path values', () => {
  const privateRoot = join(tmpdir(), 'oculory-private-root');
  const redacted = redactEvidence({
    authorization: 'Bearer synthetic-authorization-value',
    argv: ['agent', '--token', 'synthetic-token-value', '--password=synthetic-password'],
    message: `failure at ${privateRoot}/workspace with sk-syntheticvalue`,
    url: 'postgresql://local-user:local-password@127.0.0.1/database',
  }, [privateRoot]);
  const source = JSON.stringify(redacted);

  assert.deepEqual((redacted as { argv: unknown }).argv, [
    'agent',
    '--token',
    '[REDACTED]',
    '--password=[REDACTED]',
  ]);
  assert.equal((redacted as { authorization?: unknown }).authorization, undefined);
  assert.equal((redacted as Record<string, unknown>)['[REDACTED_KEY]'], '[REDACTED]');
  for (const forbidden of [
    'synthetic-authorization-value',
    'synthetic-token-value',
    'synthetic-password',
    'local-password',
    'sk-syntheticvalue',
    privateRoot,
  ]) assert.doesNotMatch(source, new RegExp(escapeRegex(forbidden)));
});

test('a declared synthetic MCP environment value never enters finalized run evidence', {
  skip: process.platform === 'win32',
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-mlp-security-'));
  const repository = process.cwd();
  const fixtureTaskPath = join(repository, 'fixtures', 'demo', 'task.yaml');
  const loaded = loadTaskConfig(fixtureTaskPath).value;
  const baseline = loaded.agent_profiles.baseline;
  if (baseline === undefined) throw new Error('demo task is missing its baseline agent profile');
  const environmentName = 'OCULORY_SYNTHETIC_LOCAL_CREDENTIAL';
  const syntheticValue = 'Bearer synthetic-local-credential-value';
  const agentEnvironmentName = 'OCULORY_SYNTHETIC_AGENT_CONTEXT';
  const agentSyntheticValue = 'opaque-agent-context-must-not-persist';
  const task = {
    ...loaded,
    agent_profiles: {
      ...loaded.agent_profiles,
      baseline: {
        ...baseline,
        argv: [
          process.execPath,
          join(repository, 'dist', 'test', 'support', 'mlp-env-probe-agent.js'),
          '--forbidden-env', environmentName,
          '--echo-env', agentEnvironmentName,
          '--mcp-config', '{mcp_config}',
          '--mode', 'baseline',
          '--run-id', '{run_id}',
        ],
        env_allowlist: [...baseline.env_allowlist, agentEnvironmentName],
      },
    },
    mcp_server: {
      ...loaded.mcp_server,
      env_allowlist: [...loaded.mcp_server.env_allowlist, environmentName],
    },
  };
  const taskSource = stringify(task, { lineWidth: 100, indent: 2 });
  parseTaskConfig(taskSource);
  const taskPath = join(root, 'task.yaml');
  writeFileSync(taskPath, taskSource, 'utf8');
  const priorValue = process.env[environmentName];
  const priorAgentValue = process.env[agentEnvironmentName];
  const priorPath = process.env.PATH;
  try {
    process.env[environmentName] = syntheticValue;
    process.env[agentEnvironmentName] = agentSyntheticValue;
    process.env.PATH = [join(repository, 'bin'), priorPath ?? ''].filter(Boolean).join(delimiter);
    const store = new PublicRunStore(join(root, '.oculory', 'runs'));
    const executed = await executeTaskRun(task, {
      taskPath,
      taskSource,
      profile: 'baseline',
      registry: createBuiltinAdapterRegistry(),
      store,
    });
    assert.equal(executed.summary.classification, 'behaviorally-passed');
    store.verify(executed.summary.run_id);
    assert.doesNotMatch(readTree(root), new RegExp(escapeRegex(syntheticValue)));
    assert.doesNotMatch(readTree(root), new RegExp(escapeRegex(agentSyntheticValue)));
  } finally {
    if (priorValue === undefined) delete process.env[environmentName];
    else process.env[environmentName] = priorValue;
    if (priorAgentValue === undefined) delete process.env[agentEnvironmentName];
    else process.env[agentEnvironmentName] = priorAgentValue;
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('output-file claim extraction refuses a symlink or junction escape', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-claim-path-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(outside, 'claim.txt'), 'outside claim must not be read\n', 'utf8');
  symlinkSync(outside, join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.deepEqual(extractClaim('', workspace, {
      type: 'output-file',
      path: 'link/claim.txt',
      max_bytes: 1024,
    }), { status: 'unavailable', text: null, source: 'output-file' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
