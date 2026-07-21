import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { stringify } from 'yaml';
import { createBuiltinAdapterRegistry, type NormalizedPostgresSnapshot } from '../src/mlp/adapters/index.js';
import { executeTaskRun } from '../src/mlp/record.js';
import { PublicRunStore } from '../src/mlp/run-store.js';
import type { OculoryTaskConfig } from '../src/mlp/types.js';

const SUPPORT_ROOT = resolve(process.cwd(), 'test', 'support');
const AGENT = join(SUPPORT_ROOT, 'mlp-fault-agent.mjs');
const SERVER = join(SUPPORT_ROOT, 'mlp-postgres-server.mjs');
const FIXTURE = join(SUPPORT_ROOT, 'mlp-fault-fixture.mjs');
const CONNECTION_ENV = 'OCULORY_TEST_POSTGRES_URL';

test('an unqualified MCP write is routed to the disposable Postgres schema and leaves source unchanged', {
  skip: process.env[CONNECTION_ENV] === undefined,
  timeout: 45_000,
}, async () => {
  const connectionString = process.env[CONNECTION_ENV];
  assert.ok(connectionString);
  const root = mkdtempSync(join(tmpdir(), 'oculory-mlp-postgres-routing-'));
  const sourceSchema = `oculory_route_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const taskPath = join(root, 'task.yaml');
  const admin = new Pool({ connectionString, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA "${sourceSchema}"`);
    await admin.query(`CREATE TABLE "${sourceSchema}"."items" (id integer PRIMARY KEY, name text NOT NULL)`);
    await admin.query(`INSERT INTO "${sourceSchema}"."items" (id, name) VALUES (1, 'alpha')`);

    const task = postgresTask(sourceSchema);
    const taskSource = stringify(task, { lineWidth: 100, indent: 2 });
    writeFileSync(taskPath, taskSource, { encoding: 'utf8', mode: 0o600 });
    const store = new PublicRunStore(join(root, '.oculory', 'runs'));
    const executed = await executeTaskRun(task, {
      taskPath,
      taskSource,
      profile: 'writer',
      registry: createBuiltinAdapterRegistry(),
      store,
      timeoutMs: 20_000,
    });

    assert.equal(
      executed.summary.classification,
      'behaviorally-passed',
      executed.summary.infrastructure_error ?? undefined,
    );
    assert.deepEqual(executed.summary.tool_result, { status: 'success', detail: 'success' });
    assert.deepEqual(executed.summary.observed_state, {
      status: 'available',
      changed_targets: ['database'],
    });
    assert.equal(executed.summary.cleanup.passed, true);
    const target = executed.runtimeTargets.find((entry) => entry.id === 'database');
    assert.ok(target);
    const before = target.before as NormalizedPostgresSnapshot;
    const after = target.after as NormalizedPostgresSnapshot;
    assert.equal(before.tables.items?.rows[0]?.name, 'alpha');
    assert.equal(after.tables.items?.rows[0]?.name, 'changed');

    const source = await admin.query<{ name: string }>(
      `SELECT name FROM "${sourceSchema}"."items" WHERE id = 1`,
    );
    assert.equal(source.rows[0]?.name, 'alpha');
    store.verify(executed.summary.run_id);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

function postgresTask(sourceSchema: string): OculoryTaskConfig {
  return {
    version: 'oculory-task-v1',
    task_id: 'postgres-disposable-routing',
    prompt: 'Update item 1 using the unqualified items table.',
    agent_profiles: {
      writer: {
        argv: [
          process.execPath,
          AGENT,
          '--mcp-config',
          '{mcp_config}',
          '--mode',
          'good',
          '--run-id',
          '{run_id}',
        ],
        env_allowlist: safeEnvironmentNames(),
      },
    },
    mcp_server: {
      command: process.execPath,
      arguments: [SERVER],
      env_allowlist: [...safeEnvironmentNames(), CONNECTION_ENV],
    },
    workspace: {
      strategy: 'command',
      setup: [process.execPath, FIXTURE, 'setup', 'none', '{workspace}'],
      reset: [process.execPath, FIXTURE, 'reset', 'none', '{workspace}'],
      cleanup: [process.execPath, FIXTURE, 'cleanup', 'none', '{workspace}'],
    },
    targets: [{
      id: 'database',
      adapter: 'postgres',
      configuration: {
        connectionEnv: CONNECTION_ENV,
        sourceSchema,
        tables: [{ name: 'items', columns: ['id', 'name'], orderBy: ['id'] }],
        rowLimit: 10,
        queryTimeoutMs: 5_000,
      },
      watch: { tables: ['items'] },
    }],
    claim_extraction: { type: 'line-prefix', prefix: 'CLAIM: ' },
  };
}

function safeEnvironmentNames(): string[] {
  return ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'].filter((name) => process.env[name] !== undefined);
}
