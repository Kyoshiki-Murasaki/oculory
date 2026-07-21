import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runtimeConfiguration } from '../src/mlp/record.js';
import type { TargetConfig } from '../src/mlp/types.js';

test('record derives Git adapter branch and path scope from watch only', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-runtime-scope-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  try {
    const result = runtimeConfiguration(target('git-filesystem', {
      mode: 'git',
      baseRefs: ['develop'],
    }, {
      branches: ['feature/demo', 'develop'],
      paths: ['test', 'src'],
    }), workspace) as Record<string, unknown>;
    assert.equal(result.sourcePath, realpathSync(workspace));
    assert.equal(result.inPlace, true);
    assert.deepEqual(result.watchBranches, ['develop', 'feature/demo']);
    assert.deepEqual(result.watchPaths, ['src', 'test']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('record narrows Postgres and GitHub configuration to declared watch resources', () => {
  const postgres = runtimeConfiguration(target('postgres', {
    connectionEnv: 'OCULORY_TEST_POSTGRES_URL',
    sourceSchema: 'public',
    tables: [
      { name: 'audit_log', columns: ['id'], orderBy: ['id'] },
      { name: 'tasks', columns: ['id'], orderBy: ['id'] },
    ],
  }, { tables: ['tasks'] }), '.') as Record<string, unknown>;
  assert.deepEqual(postgres.tables, [{ name: 'tasks', columns: ['id'], orderBy: ['id'] }]);

  const github = runtimeConfiguration(target('github-api', {
    owner: 'octo',
    repository: 'widgets',
    apiBaseUrl: 'http://127.0.0.1:8080',
    issueNumbers: [7, 11],
    pullRequestNumbers: [23, 29],
    branchNames: ['develop', 'main'],
  }, {
    issues: [11],
    pullRequests: [23],
    branches: ['main'],
  }), '.') as Record<string, unknown>;
  assert.deepEqual(github.issueNumbers, [11]);
  assert.deepEqual(github.pullRequestNumbers, [23]);
  assert.deepEqual(github.branchNames, ['main']);
});

test('record fails closed when a watch scope names an unconfigured resource', () => {
  assert.throws(() => runtimeConfiguration(target('postgres', {
    tables: [{ name: 'tasks', columns: ['id'], orderBy: ['id'] }],
  }, { tables: ['secrets'] }), '.'), /watch table 'secrets' is not configured/);
  assert.throws(() => runtimeConfiguration(target('github-api', {
    issueNumbers: [7],
  }, { issues: [8] }), '.'), /watched issue '8' is not configured/);
});

function target(adapter: string, configuration: TargetConfig['configuration'], watch: TargetConfig['watch']): TargetConfig {
  return { id: 'scope', adapter, configuration, watch };
}
