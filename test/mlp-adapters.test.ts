import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import {
  GITHUB_API_ADAPTER_ID,
  GIT_FILESYSTEM_ADAPTER_ID,
  POSTGRES_ADAPTER_ID,
  GitHubAdapterError,
  createBuiltinAdapterRegistry,
  createGitFilesystemAdapter,
  createGitHubApiAdapter,
  createPostgresAdapter,
  type AdapterAssertion,
  type NormalizedPostgresSnapshot,
} from '../src/mlp/adapters/index.js';

const METHODS = [
  'cleanup',
  'describeViolation',
  'diff',
  'evaluateAssertion',
  'normalizeSnapshot',
  'prepare',
  'redact',
  'reset',
  'snapshotAfter',
  'snapshotBefore',
  'validateConfiguration',
] as const;

test('adapter public registry exposes the three versioned built-ins with the exact lifecycle', () => {
  const registry = createBuiltinAdapterRegistry();
  assert.deepEqual(registry.list().map((entry) => entry.id), [GIT_FILESYSTEM_ADAPTER_ID, GITHUB_API_ADAPTER_ID, POSTGRES_ADAPTER_ID]);
  for (const { id } of registry.list()) {
    assert.deepEqual(Object.keys(registry.resolve(id).adapter).sort(), [...METHODS]);
  }
  assert.throws(() => registry.register(registry.resolve(GIT_FILESYSTEM_ADAPTER_ID)), /already registered/);
});

test('Git adapter observes an exact disposable workspace, catches a wrong branch base, and verifies reset', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory adapter git '));
  const repository = join(root, 'workspace');
  try {
    git(root, ['init', '--initial-branch=main', repository]);
    git(repository, ['config', 'user.name', 'Adapter Test']);
    git(repository, ['config', 'user.email', 'adapter@oculory.invalid']);
    writeFileSync(join(repository, 'README.md'), 'baseline\n');
    git(repository, ['add', '--', 'README.md']);
    git(repository, ['commit', '-m', 'baseline']);
    git(repository, ['checkout', '-b', 'develop']);
    writeFileSync(join(repository, 'develop.txt'), 'develop\n');
    git(repository, ['add', '--', 'develop.txt']);
    git(repository, ['commit', '-m', 'develop']);

    const adapter = createGitFilesystemAdapter();
    const configuration = adapter.validateConfiguration({
      sourcePath: repository,
      inPlace: true,
      baseRefs: ['develop', 'main'],
      watchPaths: ['README.md', 'scratch.txt'],
      watchBranches: ['develop', 'feature/wrong-base', 'main'],
    });
    const outside = join(root, 'outside');
    await import('node:fs').then(({ mkdirSync }) => mkdirSync(outside));
    await assert.rejects(
      adapter.prepare(configuration, { runId: 'git-test-unauthorized', workspaceRoot: outside }),
      /source differs from the authorized disposable workspace root/,
    );
    const prepared = await adapter.prepare(configuration, { runId: 'git-test', workspaceRoot: repository });
    assert.equal(prepared.workspacePath, realpathSync(repository));
    const before = adapter.normalizeSnapshot(await adapter.snapshotBefore(prepared));

    git(repository, ['branch', 'feature/wrong-base', 'main']);
    git(repository, ['branch', 'private/hidden', 'main']);
    git(repository, ['checkout', 'private/hidden']);
    writeFileSync(join(repository, 'hidden-commit.txt'), 'outside declared branch scope\n');
    git(repository, ['add', '--', 'hidden-commit.txt']);
    git(repository, ['commit', '-m', 'hidden commit']);
    const privateHead = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['checkout', 'develop']);
    writeFileSync(join(repository, 'README.md'), 'changed but staged\n');
    git(repository, ['add', '--', 'README.md']);
    writeFileSync(join(repository, 'scratch.txt'), 'untracked\n');
    writeFileSync(join(repository, 'private.txt'), 'outside declared path scope\n');

    const after = adapter.normalizeSnapshot(await adapter.snapshotAfter(prepared));
    const difference = adapter.diff(before, after);
    assert.deepEqual(difference.addedBranches, ['feature/wrong-base']);
    assert.equal(after.refs['private/hidden'], undefined);
    assert.equal(after.commits[privateHead], undefined);
    assert.deepEqual(after.stagedFiles, ['README.md']);
    assert.deepEqual(after.untrackedFiles, ['scratch.txt']);
    assert.equal(after.files.some((entry) => entry.path === 'private.txt'), false);

    const branchExists = adapter.evaluateAssertion(
      assertion('branch-exists', { kind: 'branch', branch: 'feature/wrong-base' }, 'exists'),
      before,
      after,
      difference,
    );
    assert.equal(branchExists.passed, true);
    const wrongBase = adapter.evaluateAssertion(
      assertion('branch-base', { kind: 'branch_base', branch: 'feature/wrong-base' }, 'equals', 'develop'),
      before,
      after,
      difference,
    );
    assert.equal(wrongBase.passed, false);
    assert.equal(wrongBase.observed, 'main');
    assert.equal(adapter.evaluateAssertion(
      assertion('staged', { kind: 'staged_files' }, 'subset', ['README.md']),
      before,
      after,
      difference,
    ).passed, true);
    assert.equal(adapter.evaluateAssertion(
      assertion('file', { kind: 'file', path: 'README.md' }, 'exists'),
      before,
      after,
      difference,
    ).passed, true);
    assert.equal(adapter.evaluateAssertion(
      assertion('tree', { kind: 'directory_tree', path: '.' }, 'subset', ['README.md']),
      before,
      after,
      difference,
    ).passed, true);
    assert.throws(() => adapter.evaluateAssertion(
      assertion('private-branch', { kind: 'branch', branch: 'private/hidden' }, 'exists'),
      before,
      after,
      difference,
    ), /outside the configured watch scope/);
    assert.throws(() => adapter.evaluateAssertion(
      assertion('private-path', { kind: 'file', path: 'private.txt' }, 'exists'),
      before,
      after,
      difference,
    ), /outside the configured watch scope/);
    assert.equal(adapter.evaluateAssertion(
      assertion('clean', { kind: 'clean_tree' }, 'equals', true),
      before,
      after,
      difference,
    ).passed, false);

    const unregistered = structuredClone(before);
    unregistered.currentBranch = 'main';
    assert.equal((await adapter.reset(prepared, unregistered)).passed, false);
    assert.notEqual(git(repository, ['branch', '--list', 'feature/wrong-base']).trim(), '');
    assert.equal((await adapter.reset(prepared, before)).passed, true);
    assert.equal(existsSync(repository), true);
    assert.equal(git(repository, ['status', '--porcelain']).trim(), '');
    assert.equal(git(repository, ['branch', '--list', 'feature/wrong-base']).trim(), '');
    assert.equal(git(repository, ['branch', '--list', 'private/hidden']).trim(), '');
    assert.equal((await adapter.cleanup(prepared)).passed, true);
    assert.equal(existsSync(repository), true, 'in-place cleanup must leave the orchestrator workspace');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('filesystem adapter snapshots bounded path state and restores an in-place disposable workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory adapter fs '));
  const workspace = join(root, 'workspace');
  try {
    await import('node:fs').then(({ mkdirSync }) => mkdirSync(join(workspace, 'docs'), { recursive: true }));
    writeFileSync(join(workspace, 'docs', 'guide.txt'), 'one\n');
    const adapter = createGitFilesystemAdapter();
    const configuration = adapter.validateConfiguration({ mode: 'filesystem', sourcePath: workspace, inPlace: true });
    const prepared = await adapter.prepare(configuration, { runId: 'fs-test', workspaceRoot: workspace });
    const before = adapter.normalizeSnapshot(await adapter.snapshotBefore(prepared));
    writeFileSync(join(workspace, 'docs', 'guide.txt'), 'two\n');
    writeFileSync(join(workspace, 'extra.txt'), 'extra\n');
    const after = adapter.normalizeSnapshot(await adapter.snapshotAfter(prepared));
    const difference = adapter.diff(before, after);
    assert.deepEqual(difference.addedPaths, ['extra.txt']);
    assert.deepEqual(difference.changedPaths, ['docs/guide.txt']);
    assert.equal(adapter.evaluateAssertion(
      assertion('unchanged', { kind: 'file_digest', path: 'docs/guide.txt' }, 'unchanged'),
      before,
      after,
      difference,
    ).passed, false);
    assert.equal(adapter.evaluateAssertion(
      assertion('count', { kind: 'path_count', path: '.' }, 'count', 3),
      before,
      after,
      difference,
    ).passed, true);
    assert.equal((await adapter.reset(prepared, before)).passed, true);
    assert.equal(readFileSync(join(workspace, 'docs', 'guide.txt'), 'utf8'), 'one\n');
    assert.equal(existsSync(join(workspace, 'extra.txt')), false);
    assert.equal((await adapter.cleanup(prepared)).passed, true);
    assert.equal(existsSync(workspace), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git adapter masks traversal-bearing symlink targets before hashing or persistence', {
  skip: process.platform === 'win32',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory adapter symlink '));
  const repository = join(root, 'workspace');
  try {
    git(root, ['init', '--initial-branch=main', repository]);
    git(repository, ['config', 'user.name', 'Adapter Test']);
    git(repository, ['config', 'user.email', 'adapter@oculory.invalid']);
    mkdirSync(join(repository, 'links'));
    writeFileSync(join(root, 'private'), 'outside workspace\n');
    symlinkSync('../../private', join(repository, 'links', 'escape'));
    git(repository, ['add', '--', 'links/escape']);
    git(repository, ['commit', '-m', 'symlink fixture']);

    const adapter = createGitFilesystemAdapter();
    const configuration = adapter.validateConfiguration({
      sourcePath: repository,
      inPlace: true,
      watchPaths: ['links/escape'],
      watchBranches: ['main'],
    });
    const prepared = await adapter.prepare(configuration, { runId: 'git-symlink', workspaceRoot: repository });
    const snapshot = adapter.normalizeSnapshot(await adapter.snapshotBefore(prepared));
    const entry = snapshot.files.find((candidate) => candidate.path === 'links/escape');
    assert.equal(entry?.symlinkTarget, '<outside-target>');
    assert.equal(entry?.byteLength, Buffer.byteLength('<outside-target>'));
    assert.equal(entry?.sha256, createHash('sha256').update('<outside-target>').digest('hex'));
    assert.doesNotMatch(JSON.stringify(snapshot), /\.\.\/\.\.\/private/);
    assert.equal((await adapter.cleanup(prepared)).passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git adapter rejects a watched path that traverses a symbolic-link parent', {
  skip: process.platform === 'win32',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory adapter parent symlink '));
  const repository = join(root, 'workspace');
  try {
    git(root, ['init', '--initial-branch=main', repository]);
    git(repository, ['config', 'user.name', 'Adapter Test']);
    git(repository, ['config', 'user.email', 'adapter@oculory.invalid']);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'outside-file'), 'must never be read or hashed\n');
    symlinkSync('../outside', join(repository, 'link'));
    git(repository, ['add', '--', 'link']);
    git(repository, ['commit', '-m', 'parent symlink fixture']);

    const adapter = createGitFilesystemAdapter();
    const configuration = adapter.validateConfiguration({
      sourcePath: repository,
      inPlace: true,
      watchPaths: ['link/outside-file'],
      watchBranches: ['main'],
    });
    await assert.rejects(
      adapter.prepare(configuration, { runId: 'git-parent-symlink', workspaceRoot: repository }),
      /snapshot path traverses a symbolic-link parent/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Postgres adapter validates structured allowlists and evaluates rows without a network connection', async () => {
  const adapter = createPostgresAdapter();
  assert.throws(() => adapter.validateConfiguration({
    connectionEnv: 'OCULORY_TEST_POSTGRES_URL',
    sourceSchema: 'public',
    tables: [{ name: 'items; DROP TABLE x', columns: ['id'], orderBy: ['id'] }],
  }), /invalid/);
  assert.throws(() => adapter.validateConfiguration({
    connectionEnv: 'OCULORY_TEST_POSTGRES_URL',
    sourceSchema: 'public',
    tables: [{ name: 'items', columns: ['id'], orderBy: ['id'], sql: 'SELECT *' }],
  }), /unknown field/);
  assert.throws(() => adapter.validateConfiguration({
    connectionEnv: 'OCULORY_TEST_POSTGRES_URL',
    sourceSchema: 'public',
    tables: [{ name: 'items', columns: ['id', 'access_token'], orderBy: ['id'] }],
  }), /secret-shaped/);

  const snapshot: NormalizedPostgresSnapshot = {
    schema: 'public',
    tables: {
      items: {
        exists: true,
        columns: [
          { name: 'id', dataType: 'integer', nullable: false, ordinal: 1 },
          { name: 'name', dataType: 'text', nullable: false, ordinal: 2 },
        ],
        rows: [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }],
      },
    },
  };
  const difference = adapter.diff(snapshot, snapshot);
  const reversed = structuredClone(snapshot);
  reversed.tables.items!.rows.reverse();
  assert.deepEqual(
    adapter.normalizeSnapshot(snapshot),
    adapter.normalizeSnapshot(reversed),
    'normalized row order must not depend on non-unique SQL ordering ties',
  );
  assert.equal(adapter.evaluateAssertion(
    assertion('rows', { kind: 'rows', schema: 'public', table: 'items', where: { id: 2 } }, 'subset', [{ id: 2, name: 'beta' }]),
    snapshot,
    snapshot,
    difference,
  ).passed, true);
  assert.equal(adapter.evaluateAssertion(
    assertion('cell', { kind: 'cell', table: 'items', where: { id: 1 }, column: 'name' }, 'equals', 'alpha'),
    snapshot,
    snapshot,
    difference,
  ).passed, true);
  assert.throws(() => adapter.evaluateAssertion(
    assertion('cell-empty', { kind: 'cell', table: 'items', where: { id: 99 }, column: 'name' }, 'equals', null),
    snapshot,
    snapshot,
    difference,
  ), /cell selector requires exactly one matching row; observed 0/);
  assert.throws(() => adapter.evaluateAssertion(
    assertion('cell-ambiguous', { kind: 'cell', table: 'items', column: 'name' }, 'equals', null),
    snapshot,
    snapshot,
    difference,
  ), /cell selector requires exactly one matching row; observed 2/);
  assert.equal(adapter.evaluateAssertion(
    assertion('none', { kind: 'unexpected_rows', table: 'items', where: { name: 'missing' } }, 'none'),
    snapshot,
    snapshot,
    difference,
  ).passed, true);
  const mismatchAssertion = assertion('cell-mismatch', { kind: 'cell', table: 'items', where: { id: 1 }, column: 'name' }, 'equals', 'wrong');
  const mismatch = adapter.evaluateAssertion(mismatchAssertion, snapshot, snapshot, difference);
  assert.equal(mismatch.passed, false);
  assert.match(adapter.describeViolation(mismatchAssertion, mismatch), /^items violated: expected/);
  const sensitiveKey = `ghp_${'x'.repeat(20)}`;
  const redacted = adapter.redact({
    bytes: Buffer.from([1, 2, 3]),
    connectionString: 'postgres://user:value@host/db',
    diagnostic: 'failure \u001b[31mred\u001b[0m at /Users/example/private\u0000',
    password: 'value',
    sourcePath: '/Users/example/private',
    typed: new Uint8Array([1, 2]),
    when: new Date('2026-07-22T00:00:00.000Z'),
    [sensitiveKey]: 'must not retain its key',
  }) as Record<string, unknown>;
  assert.equal(JSON.stringify(redacted).includes(sensitiveKey), false);
  assert.equal(redacted.bytes, '<bytes:3>');
  assert.equal(redacted.typed, '<bytes:2>');
  assert.equal(redacted.when, '2026-07-22T00:00:00.000Z');
  assert.equal(redacted.sourcePath, '<private-path>');
  assert.equal(redacted.diagnostic, 'failure red at <private-path>');
  assert.deepEqual(
    Object.entries(redacted).filter(([key]) => key.startsWith('<redacted-key>')).map(([, value]) => value),
    ['<redacted>', '<redacted>', '<redacted>'],
  );

  if (process.env.OCULORY_TEST_POSTGRES_URL === undefined) {
    const configuration = adapter.validateConfiguration({
      connectionEnv: 'OCULORY_TEST_POSTGRES_URL',
      sourceSchema: 'public',
      tables: [{ name: 'items', columns: ['id'], orderBy: ['id'] }],
    });
    await assert.rejects(adapter.prepare(configuration, { runId: 'pg-no-network' }), /environment variable is unavailable/);
  }
});

test('Postgres adapter integration uses only the explicitly configured disposable service', {
  skip: process.env.OCULORY_TEST_POSTGRES_URL === undefined,
}, async () => {
  const schema = `oculory_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new Pool({ connectionString: process.env.OCULORY_TEST_POSTGRES_URL, max: 1 });
  const adapter = createPostgresAdapter();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE TABLE "${schema}"."items" (id integer NOT NULL, name text NOT NULL)`);
    await admin.query(`INSERT INTO "${schema}"."items" (id, name) VALUES (1, 'alpha')`);
    const configuration = adapter.validateConfiguration({
      connectionEnv: 'OCULORY_TEST_POSTGRES_URL',
      sourceSchema: schema,
      tables: [{ name: 'items', columns: ['id', 'name'], orderBy: ['id'] }],
      rowLimit: 10,
    });
    const prepared = await adapter.prepare(configuration, { runId: 'pg-integration' });
    const before = adapter.normalizeSnapshot(await adapter.snapshotBefore(prepared));
    await prepared.pool.query(`UPDATE "${prepared.workspaceSchema}"."items" SET name = 'changed' WHERE id = 1`);
    const after = adapter.normalizeSnapshot(await adapter.snapshotAfter(prepared));
    assert.equal(adapter.diff(before, after).changed, true);
    const unregistered = structuredClone(before);
    unregistered.schema = 'unregistered';
    assert.equal((await adapter.reset(prepared, unregistered)).passed, false);
    const unchangedMutation = await prepared.pool.query<{ name: string }>(`SELECT name FROM "${prepared.workspaceSchema}"."items" WHERE id = 1`);
    assert.equal(unchangedMutation.rows[0]?.name, 'changed');
    assert.equal((await adapter.reset(prepared, before)).passed, true);
    await prepared.pool.query(
      `UPDATE "${prepared.workspaceSchema}"."items" SET name = repeat('x', $1) WHERE id = 1`,
      [16 * 1024 * 1024 + 1],
    );
    await assert.rejects(adapter.snapshotAfter(prepared), /selected-row byte limit exceeded/);
    assert.equal((await adapter.reset(prepared, before)).passed, true);
    assert.equal((await adapter.cleanup(prepared)).passed, true);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test('GitHub adapter rejects invalid values for every selected API response field', async () => {
  const mock = await startGitHubMock();
  const environmentName = 'OCULORY_TEST_GITHUB_TOKEN';
  const priorToken = process.env[environmentName];
  process.env[environmentName] = 'synthetic-local-token';
  const adapter = createGitHubApiAdapter();
  const invalidResponse = (error: unknown): boolean => error instanceof GitHubAdapterError && error.kind === 'invalid_response';
  try {
    const invalidIssueFields: Record<string, unknown> = {
      title: [],
      state: 'pending',
      body: 42,
      locked: 'true',
      labels: {},
    };
    for (const [field, invalid] of Object.entries(invalidIssueFields)) {
      const original = mock.state.issue[field];
      mock.state.issue[field] = invalid;
      try {
        await assert.rejects(
          adapter.prepare(adapter.validateConfiguration({
            owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
            issueNumbers: [1], issueFields: [field], commentMode: 'none', resetMode: 'read-only',
          }), { runId: `invalid-issue-${field}` }),
          invalidResponse,
        );
      } finally {
        mock.state.issue[field] = original;
      }
    }

    const invalidPullRequestFields: Record<string, unknown> = {
      title: [],
      state: 'pending',
      body: 42,
      draft: 'false',
      merged: 0,
      base: { ref: 7 },
      head: null,
      labels: {},
    };
    for (const [field, invalid] of Object.entries(invalidPullRequestFields)) {
      const original = mock.state.pullRequest[field];
      mock.state.pullRequest[field] = invalid;
      try {
        await assert.rejects(
          adapter.prepare(adapter.validateConfiguration({
            owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
            pullRequestNumbers: [2], pullRequestFields: [field], commentMode: 'none', resetMode: 'read-only',
          }), { runId: `invalid-pull-${field}` }),
          invalidResponse,
        );
      } finally {
        mock.state.pullRequest[field] = original;
      }
    }

    const invalidProtectionFields: Record<string, unknown> = {
      required_status_checks: { strict: 'true', contexts: [] },
      enforce_admins: { enabled: 'true' },
      required_pull_request_reviews: {
        dismissal_restrictions: null,
        dismiss_stale_reviews: 'false',
        require_code_owner_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: false,
      },
      restrictions: { users: 'invalid', teams: [], apps: [] },
      required_linear_history: { enabled: 'true' },
      allow_force_pushes: { enabled: 'true' },
      allow_deletions: { enabled: 'true' },
      required_conversation_resolution: { enabled: 'true' },
      block_creations: { enabled: 'true' },
      lock_branch: { enabled: 'true' },
      allow_fork_syncing: { enabled: 'true' },
    };
    for (const [field, invalid] of Object.entries(invalidProtectionFields)) {
      const original = mock.state.protection[field];
      mock.state.protection[field] = invalid;
      try {
        await assert.rejects(
          adapter.prepare(adapter.validateConfiguration({
            owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
            branchNames: ['main'], branchProtectionFields: [field], commentMode: 'none', resetMode: 'read-only',
          }), { runId: `invalid-protection-${field}` }),
          invalidResponse,
        );
      } finally {
        if (original === undefined) delete mock.state.protection[field];
        else mock.state.protection[field] = original;
      }
    }

    for (const field of ['required_status_checks', 'required_pull_request_reviews', 'restrictions']) {
      mock.state.protection[field] = null;
      const prepared = await adapter.prepare(adapter.validateConfiguration({
        owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
        branchNames: ['main'], branchProtectionFields: [field], commentMode: 'none', resetMode: 'read-only',
      }), { runId: `nullable-protection-${field}` });
      assert.equal((await adapter.cleanup(prepared)).passed, true);
      delete mock.state.protection[field];
    }
    await assert.rejects(
      adapter.prepare(adapter.validateConfiguration({
        owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
        branchNames: ['main'], branchProtectionFields: ['required_status_checks'], commentMode: 'none', resetMode: 'read-only',
      }), { runId: 'missing-selected-protection-field' }),
      invalidResponse,
    );
  } finally {
    if (priorToken === undefined) delete process.env[environmentName];
    else process.env[environmentName] = priorToken;
    await mock.close();
  }
});

test('GitHub adapter classifies rate-limit responses before the ordinary body cap', async () => {
  const mock = await startGitHubMock();
  const environmentName = 'OCULORY_TEST_GITHUB_TOKEN';
  const priorToken = process.env[environmentName];
  process.env[environmentName] = 'synthetic-local-token';
  const adapter = createGitHubApiAdapter();
  const configuration = adapter.validateConfiguration({
    owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
    issueNumbers: [1], issueFields: ['title'], commentMode: 'none', maxResponseBytes: 1_024,
  });
  try {
    mock.state.rateLimitStatus = 403;
    mock.state.rateLimitBodyBytes = 4 * 1_024;
    await assert.rejects(
      adapter.prepare(configuration, { runId: 'bounded-primary-rate-limit' }),
      (error) => error instanceof GitHubAdapterError && error.kind === 'rate_limited',
    );
    mock.state.rateLimitStatus = 429;
    mock.state.rateLimitBodyBytes = 128 * 1_024;
    await assert.rejects(
      adapter.prepare(configuration, { runId: 'bounded-secondary-rate-limit' }),
      (error) => error instanceof GitHubAdapterError && error.kind === 'rate_limited',
    );
  } finally {
    if (priorToken === undefined) delete process.env[environmentName];
    else process.env[environmentName] = priorToken;
    await mock.close();
  }
});

test('GitHub adapter uses bounded local HTTP, captures selected resources, restores scope, and classifies rate limits', async () => {
  const mock = await startGitHubMock();
  const environmentName = 'OCULORY_TEST_GITHUB_TOKEN';
  process.env[environmentName] = 'synthetic-local-token';
  try {
    const adapter = createGitHubApiAdapter();
    assert.throws(() => adapter.validateConfiguration({
      owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl,
      issueNumbers: [2], pullRequestNumbers: [2], commentMode: 'none',
    }), /must not overlap/);
    assert.throws(() => adapter.validateConfiguration({
      owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl,
      issueNumbers: [1], issueFields: ['locked'], commentMode: 'body', resetMode: 'restore',
    }), /restore mode does not support issue fields: locked/);
    assert.throws(() => adapter.validateConfiguration({
      owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl,
      pullRequestNumbers: [2], pullRequestFields: ['draft'], commentMode: 'body', resetMode: 'restore',
    }), /restore mode does not support pull request fields: draft/);
    const configuration = adapter.validateConfiguration({
      owner: 'octo',
      repository: 'widgets',
      apiBaseUrl: mock.baseUrl,
      tokenEnv: environmentName,
      issueNumbers: [1],
      pullRequestNumbers: [2],
      branchNames: ['main'],
      issueFields: ['title', 'state', 'labels'],
      pullRequestFields: ['title', 'state', 'labels'],
      branchProtectionFields: ['enforce_admins'],
      commentMode: 'body',
      resetMode: 'restore',
      pageSize: 2,
      maxPages: 2,
      maxItems: 8,
    });
    const raceAdapter = createGitHubApiAdapter();
    const racePrepared = await raceAdapter.prepare(raceAdapter.validateConfiguration({
      owner: 'octo',
      repository: 'widgets',
      apiBaseUrl: mock.baseUrl,
      tokenEnv: environmentName,
      issueNumbers: [1],
      issueFields: ['title'],
      commentMode: 'none',
      resetMode: 'restore',
    }), { runId: 'github-baseline-race' });
    const originalRaw = structuredClone(racePrepared.baselineRaw);
    const originalNormalized = structuredClone(racePrepared.baseline);
    assert.deepEqual(
      raceAdapter.normalizeSnapshot(await raceAdapter.snapshotBefore(racePrepared)),
      originalNormalized,
    );
    mock.state.issue.title = 'agent mutation';
    assert.equal((await raceAdapter.reset(racePrepared, originalNormalized!)).passed, true);
    assert.equal(mock.state.issue.title, 'Baseline issue');
    mock.state.issue.title = 'concurrent drift after reset';
    await assert.rejects(
      raceAdapter.snapshotBefore(racePrepared),
      /GitHub scope changed before baseline registration/,
    );
    assert.deepEqual(racePrepared.baselineRaw, originalRaw);
    assert.deepEqual(racePrepared.baseline, originalNormalized);
    assert.equal((await raceAdapter.reset(racePrepared, originalNormalized!)).passed, true);
    assert.equal(mock.state.issue.title, 'Baseline issue');
    assert.deepEqual(
      raceAdapter.normalizeSnapshot(await raceAdapter.snapshotBefore(racePrepared)),
      originalNormalized,
    );
    assert.equal((await raceAdapter.cleanup(racePrepared)).passed, true);

    const prepared = await adapter.prepare(configuration, { runId: 'github-test' });
    const before = adapter.normalizeSnapshot(await adapter.snapshotBefore(prepared));
    assert.deepEqual(before.issues['1']?.labels, ['bug', 'urgent']);
    assert.deepEqual(before.issues['1']?.comments.entries, ['baseline comment']);
    assert.equal(before.branches.main?.protection?.enforce_admins, true);

    mock.state.issue.title = 'changed';
    mock.state.issue.labels = [{ name: 'regression' }];
    mock.state.issueComments[0]!.body = 'changed comment';
    mock.state.branch.commit.sha = 'b'.repeat(40);
    mock.state.protection.enforce_admins = { enabled: false };
    const after = adapter.normalizeSnapshot(await adapter.snapshotAfter(prepared));
    const difference = adapter.diff(before, after);
    assert.deepEqual(difference.changedIssues, [1]);
    assert.deepEqual(difference.changedBranches, ['main']);
    const labelsAssertion = assertion('labels', { kind: 'issue_labels', number: 1 }, 'subset', ['bug']);
    const labelsResult = adapter.evaluateAssertion(
      labelsAssertion,
      before,
      after,
      difference,
    );
    assert.equal(labelsResult.passed, false);
    assert.match(adapter.describeViolation(labelsAssertion, labelsResult), /^issue_labels violated: expected/);
    assert.equal(adapter.evaluateAssertion(
      assertion('comment-count', { kind: 'issue_comment_count', number: 1 }, 'count', 1),
      before,
      after,
      difference,
    ).passed, true);
    const unregistered = structuredClone(before);
    unregistered.issues['1']!.fields.title = 'unregistered';
    assert.equal((await adapter.reset(prepared, unregistered)).passed, false);
    assert.equal(mock.state.issue.title, 'changed');
    assert.equal((await adapter.reset(prepared, before)).passed, true);
    assert.equal(mock.state.issue.title, 'Baseline issue');
    assert.deepEqual(mock.state.issue.labels, ['bug', 'urgent']);
    assert.equal(mock.state.issueComments[0]?.body, 'baseline comment');
    assert.equal(mock.state.branch.commit.sha, 'a'.repeat(40));
    assert.deepEqual(mock.state.protection.enforce_admins, { enabled: true });
    assert.equal((await adapter.cleanup(prepared)).passed, true);
    const redactedAuthorization = adapter.redact({ authorization: 'synthetic-local-token' });
    assert.equal(JSON.stringify(redactedAuthorization).includes('synthetic-local-token'), false);
    assert.deepEqual(Object.values(redactedAuthorization as Record<string, unknown>), ['<redacted>']);

    mock.state.issue.title = `echo ${process.env[environmentName]} value`;
    mock.state.issueComments[0]!.body = `comment ${process.env[environmentName]}`;
    const credentialBoundary = createGitHubApiAdapter();
    const credentialPrepared = await credentialBoundary.prepare(credentialBoundary.validateConfiguration({
      owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
      issueNumbers: [1], issueFields: ['title'], commentMode: 'digest', resetMode: 'read-only',
    }), { runId: 'credential-boundary' });
    const credentialSnapshot = credentialBoundary.normalizeSnapshot(await credentialBoundary.snapshotBefore(credentialPrepared));
    assert.equal(credentialSnapshot.issues['1']?.fields.title, 'echo <redacted> value');
    assert.deepEqual(credentialSnapshot.issues['1']?.comments.entries, [
      createHash('sha256').update('comment <redacted>').digest('hex'),
    ]);
    assert.doesNotMatch(JSON.stringify(credentialPrepared), /synthetic-local-token/);
    assert.equal((await credentialBoundary.cleanup(credentialPrepared)).passed, true);

    mock.state.malformedIssue = true;
    const malformed = createGitHubApiAdapter();
    await assert.rejects(
      malformed.prepare(malformed.validateConfiguration({
        owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
        issueNumbers: [1], issueFields: ['title'], commentMode: 'none',
      }), { runId: 'malformed-response' }),
      (error) => error instanceof GitHubAdapterError && error.kind === 'invalid_response',
    );
    mock.state.malformedIssue = false;

    const savedLabels = mock.state.issue.labels;
    mock.state.issue.labels = null;
    const malformedLabels = createGitHubApiAdapter();
    await assert.rejects(
      malformedLabels.prepare(malformedLabels.validateConfiguration({
        owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
        issueNumbers: [1], issueFields: ['labels'], commentMode: 'none',
      }), { runId: 'malformed-labels' }),
      (error) => error instanceof GitHubAdapterError && error.kind === 'invalid_response',
    );
    mock.state.issue.labels = savedLabels;

    mock.state.issueComments.push({ id: 11, body: 'second bounded comment' });
    const itemBounded = createGitHubApiAdapter();
    await assert.rejects(
      itemBounded.prepare(itemBounded.validateConfiguration({
        owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
        issueNumbers: [1], commentMode: 'digest', pageSize: 2, maxPages: 2, maxItems: 1,
      }), { runId: 'item-limit' }),
      (error) => error instanceof GitHubAdapterError && error.kind === 'invalid_response',
    );

    mock.state.issue.title = 'x'.repeat(2_048);
    const oversized = createGitHubApiAdapter();
    await assert.rejects(
      oversized.prepare(oversized.validateConfiguration({
        owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
        issueNumbers: [1], issueFields: ['title'], commentMode: 'none', maxResponseBytes: 1_024,
      }), { runId: 'oversized-response' }),
      (error) => error instanceof GitHubAdapterError && error.kind === 'invalid_response',
    );

    mock.state.rateLimitStatus = 403;
    const rateLimited = createGitHubApiAdapter();
    await assert.rejects(
      rateLimited.prepare(rateLimited.validateConfiguration({
        owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
        issueNumbers: [1], commentMode: 'none', maxPages: 1,
      }), { runId: 'rate-limit' }),
      (error) => error instanceof GitHubAdapterError && error.kind === 'rate_limited',
    );
    mock.state.rateLimitStatus = 429;
    await assert.rejects(
      rateLimited.prepare(rateLimited.validateConfiguration({
        owner: 'octo', repository: 'widgets', apiBaseUrl: mock.baseUrl, tokenEnv: environmentName,
        issueNumbers: [1], commentMode: 'none', maxPages: 1,
      }), { runId: 'secondary-rate-limit' }),
      (error) => error instanceof GitHubAdapterError && error.kind === 'rate_limited',
    );
  } finally {
    delete process.env[environmentName];
    await mock.close();
  }
});

function assertion(
  id: string,
  selector: AdapterAssertion['selector'],
  operator: AdapterAssertion['operator'],
  expected?: AdapterAssertion['expected'],
): AdapterAssertion {
  return { id, target: 'test', selector, operator, expected, evaluationMode: 'exact' };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

interface MockState {
  rateLimitStatus: 403 | 429 | null;
  rateLimitBodyBytes: number;
  malformedIssue: boolean;
  nextCommentId: number;
  issue: Record<string, any>;
  pullRequest: Record<string, any>;
  issueComments: Array<{ id: number; body: string }>;
  pullRequestComments: Array<{ id: number; body: string }>;
  branch: { name: string; protected: boolean; commit: { sha: string } };
  protection: Record<string, unknown>;
}

async function startGitHubMock(): Promise<{ baseUrl: string; state: MockState; close(): Promise<void> }> {
  const state: MockState = {
    rateLimitStatus: null,
    rateLimitBodyBytes: 0,
    malformedIssue: false,
    nextCommentId: 30,
    issue: { number: 1, title: 'Baseline issue', state: 'open', body: 'body', locked: false, labels: [{ name: 'bug' }, { name: 'urgent' }] },
    pullRequest: { number: 2, title: 'Baseline PR', state: 'open', body: 'pr body', draft: false, merged: false, labels: [{ name: 'review' }], base: { ref: 'main' }, head: { ref: 'feature' } },
    issueComments: [{ id: 10, body: 'baseline comment' }],
    pullRequestComments: [{ id: 20, body: 'review comment' }],
    branch: { name: 'main', protected: true, commit: { sha: 'a'.repeat(40) } },
    protection: { enforce_admins: { enabled: true } },
  };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer synthetic-local-token');
      if (state.rateLimitStatus !== null) {
        const headers: Record<string, string> = state.rateLimitStatus === 403 ? { 'x-ratelimit-remaining': '0' } : {};
        return json(response, state.rateLimitStatus, {
          message: state.rateLimitBodyBytes === 0 ? 'rate limited' : 'x'.repeat(state.rateLimitBodyBytes),
        }, headers);
      }
      await routeMock(state, request, response);
    } catch {
      json(response, 500, { message: 'mock failure' });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock server did not bind TCP');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

async function routeMock(state: MockState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = request.method ?? 'GET';
  const body = method === 'GET' || method === 'DELETE' ? null : await requestBody(request);
  if (path === '/repos/octo/widgets/issues/1' && method === 'GET') {
    return json(response, 200, state.malformedIssue ? [] : state.issue);
  }
  if (path === '/repos/octo/widgets/issues/1' && method === 'PATCH') {
    Object.assign(state.issue, body);
    return json(response, 200, state.issue);
  }
  if (path === '/repos/octo/widgets/pulls/2' && method === 'GET') return json(response, 200, state.pullRequest);
  if (path === '/repos/octo/widgets/pulls/2' && method === 'PATCH') {
    Object.assign(state.pullRequest, body);
    return json(response, 200, state.pullRequest);
  }
  if (path === '/repos/octo/widgets/issues/2' && method === 'PATCH') {
    Object.assign(state.pullRequest, body);
    return json(response, 200, state.pullRequest);
  }
  if (path === '/repos/octo/widgets/issues/1/comments' && method === 'GET') return json(response, 200, page(state.issueComments, url));
  if (path === '/repos/octo/widgets/issues/2/comments' && method === 'GET') return json(response, 200, page(state.pullRequestComments, url));
  if (path === '/repos/octo/widgets/issues/1/comments' && method === 'POST') {
    const comment = { id: state.nextCommentId++, body: String(body?.body ?? '') };
    state.issueComments.push(comment);
    return json(response, 201, comment);
  }
  if (path === '/repos/octo/widgets/issues/2/comments' && method === 'POST') {
    const comment = { id: state.nextCommentId++, body: String(body?.body ?? '') };
    state.pullRequestComments.push(comment);
    return json(response, 201, comment);
  }
  const commentMatch = path.match(/^\/repos\/octo\/widgets\/issues\/comments\/(\d+)$/);
  if (commentMatch && method === 'DELETE') {
    const id = Number(commentMatch[1]);
    state.issueComments = state.issueComments.filter((comment) => comment.id !== id);
    state.pullRequestComments = state.pullRequestComments.filter((comment) => comment.id !== id);
    response.writeHead(204).end();
    return;
  }
  if (path === '/repos/octo/widgets/branches/main' && method === 'GET') return json(response, 200, state.branch);
  if (path === '/repos/octo/widgets/branches/main/protection' && method === 'GET') return json(response, 200, state.protection);
  if (path === '/repos/octo/widgets/branches/main/protection' && method === 'PUT') {
    state.protection.enforce_admins = { enabled: body?.enforce_admins === true };
    return json(response, 200, state.protection);
  }
  if (path === '/repos/octo/widgets/git/refs/heads/main' && method === 'PATCH') {
    state.branch.commit.sha = String(body?.sha);
    return json(response, 200, { object: { sha: state.branch.commit.sha } });
  }
  json(response, 404, { message: 'not found' });
}

function page<T>(values: T[], url: URL): T[] {
  const size = Number(url.searchParams.get('per_page') ?? 50);
  const number = Number(url.searchParams.get('page') ?? 1);
  return values.slice((number - 1) * size, number * size);
}

async function requestBody(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  response.end(body);
}
