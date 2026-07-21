import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { createBuiltinAdapterRegistry } from '../src/mlp/adapters/index.js';
import { assertReplayPreflight, replayContract } from '../src/mlp/replay.js';
import { PublicRunStore } from '../src/mlp/run-store.js';
import type { ContractAssertion, Json, OculoryContractConfig, OculoryTaskConfig } from '../src/mlp/types.js';

test('replay preflight accepts every built-in selector shape and all uniform operators', () => {
  const task = builtInTask();
  const assertions: ContractAssertion[] = [
    assertion('git-branch', 'repository', { kind: 'branch', branch: 'feature/demo' }),
    assertion('git-branch-base', 'repository', { kind: 'branch_base', branch: 'feature/demo' }),
    assertion('git-current-branch', 'repository', { kind: 'current_branch' }),
    assertion('git-commit-count', 'repository', { kind: 'commit_count', ref: 'develop' }),
    assertion('git-commit-count-head', 'repository', { kind: 'commit_count' }),
    assertion('git-commit-ancestry', 'repository', { kind: 'commit_ancestry', ancestor: 'develop', descendant: 'feature/demo' }),
    assertion('git-staged', 'repository', { kind: 'staged_files' }),
    assertion('git-unstaged', 'repository', { kind: 'unstaged_files' }),
    assertion('git-untracked', 'repository', { kind: 'untracked_files' }),
    assertion('git-file', 'repository', { kind: 'file', path: 'src/index.ts' }),
    assertion('git-file-digest', 'repository', { kind: 'file_digest', path: 'src/index.ts' }),
    assertion('git-directory-tree', 'repository', { kind: 'directory_tree' }),
    assertion('git-path-count', 'repository', { kind: 'path_count', path: 'src' }),
    assertion('git-clean-tree', 'repository', { kind: 'clean_tree' }),
    assertion('pg-table', 'database', { kind: 'table', table: 'tasks', schema: 'public' }),
    assertion('pg-row-count', 'database', { kind: 'row_count', table: 'tasks', where: { status: 'open' } }),
    assertion('pg-rows', 'database', { kind: 'rows', table: 'tasks', columns: ['id', 'status'] }),
    assertion('pg-unexpected-rows', 'database', { kind: 'unexpected_rows', table: 'tasks', where: { status: 'unexpected' } }),
    assertion('pg-cell', 'database', { kind: 'cell', table: 'tasks', column: 'status', where: { id: 1 } }),
    assertion('pg-columns', 'database', { kind: 'columns', table: 'tasks', columns: ['status'] }),
    assertion('gh-issue', 'github', { kind: 'issue', number: 17 }),
    assertion('gh-issue-field', 'github', { kind: 'issue_field', number: 17, field: 'title' }),
    assertion('gh-issue-labels', 'github', { kind: 'issue_labels', number: 17 }),
    assertion('gh-issue-comment-count', 'github', { kind: 'issue_comment_count', number: 17 }),
    assertion('gh-issue-comments', 'github', { kind: 'issue_comments', number: 17 }),
    assertion('gh-pull', 'github', { kind: 'pull_request', number: 23 }),
    assertion('gh-pull-field', 'github', { kind: 'pull_request_field', number: 23, field: 'title' }),
    assertion('gh-pull-labels', 'github', { kind: 'pull_request_labels', number: 23 }),
    assertion('gh-pull-comment-count', 'github', { kind: 'pull_request_comment_count', number: 23 }),
    assertion('gh-pull-comments', 'github', { kind: 'pull_request_comments', number: 23 }),
    assertion('gh-branch', 'github', { kind: 'branch', branch: 'main' }),
    assertion('gh-branch-field', 'github', { kind: 'branch_field', branch: 'main', field: 'sha' }),
    assertion('gh-branch-protection', 'github', { kind: 'branch_protection', branch: 'main' }),
    assertion('gh-branch-protection-field', 'github', { kind: 'branch_protection_field', branch: 'main', field: 'enforce_admins' }),
    assertion('operator-exists', 'repository', { kind: 'file', path: 'src/index.ts' }, 'exists', true),
    assertion('operator-equals', 'repository', { kind: 'file', path: 'src/index.ts' }, 'equals', null),
    assertion('operator-count', 'repository', { kind: 'file', path: 'src/index.ts' }, 'count', 0),
    assertion('operator-unchanged', 'repository', { kind: 'file', path: 'src/index.ts' }, 'unchanged', null),
    assertion('operator-none', 'repository', { kind: 'file', path: 'src/index.ts' }, 'none', null),
    assertion('operator-subset', 'repository', { kind: 'file', path: 'src/index.ts' }, 'subset', {}),
  ];
  assert.doesNotThrow(() => assertReplayPreflight(
    contract(assertions),
    task,
    'local',
    createBuiltinAdapterRegistry(),
  ));
});

test('replay rejects malformed, unsupported, and out-of-scope assertions before allocating a run', async () => {
  const cases: Array<{
    name: string;
    expected: RegExp;
    change(task: OculoryTaskConfig, assertion: ContractAssertion): void;
  }> = [
    {
      name: 'missing selector field',
      expected: /selector\.branch is required/,
      change: (_task, value) => { value.selector = { kind: 'branch' }; },
    },
    {
      name: 'unsupported selector kind',
      expected: /selector\.kind is unsupported/,
      change: (_task, value) => { value.selector = { kind: 'remote_branch' }; },
    },
    {
      name: 'unknown selector field',
      expected: /selector has an unknown field/,
      change: (_task, value) => { value.selector = { kind: 'clean_tree', path: 'src' }; },
    },
    {
      name: 'Git branch outside watch scope',
      expected: /outside target watch\.branches/,
      change: (_task, value) => { value.selector = { kind: 'branch', branch: 'release' }; },
    },
    {
      name: 'Git path outside watch scope',
      expected: /outside target watch\.paths/,
      change: (_task, value) => { value.selector = { kind: 'file', path: 'docs/private.txt' }; },
    },
    {
      name: 'Git selector unavailable in filesystem mode',
      expected: /unavailable in filesystem mode/,
      change: (task, value) => {
        const target = task.targets[0]!;
        target.configuration = { mode: 'filesystem' };
        target.watch = { paths: ['src'] };
        value.selector = { kind: 'branch', branch: 'feature/demo' };
      },
    },
    {
      name: 'Postgres table outside watch scope',
      expected: /selector\.table is outside target watch\.tables/,
      change: (_task, value) => {
        value.target = 'database';
        value.selector = { kind: 'rows', table: 'audit_log' };
      },
    },
    {
      name: 'Postgres column outside allowlist',
      expected: /selector\.where uses a column outside/,
      change: (_task, value) => {
        value.target = 'database';
        value.selector = { kind: 'rows', table: 'tasks', where: { credential: 'value' } };
      },
    },
    {
      name: 'GitHub issue outside watch scope',
      expected: /selector\.number is outside target watch issue scope/,
      change: (_task, value) => {
        value.target = 'github';
        value.selector = { kind: 'issue', number: 18 };
      },
    },
    {
      name: 'GitHub field outside configured selection',
      expected: /outside the configured issue field allowlist/,
      change: (_task, value) => {
        value.target = 'github';
        value.selector = { kind: 'issue_field', number: 17, field: 'body' };
      },
    },
    {
      name: 'GitHub comments disabled',
      expected: /comments are unavailable when commentMode is none/,
      change: (task, value) => {
        task.targets[2]!.configuration.commentMode = 'none';
        value.target = 'github';
        value.selector = { kind: 'issue_comments', number: 17 };
      },
    },
    {
      name: 'GitHub protection field outside configured selection',
      expected: /outside configuration\.branchProtectionFields/,
      change: (_task, value) => {
        value.target = 'github';
        value.selector = { kind: 'branch_protection_field', branch: 'main', field: 'required_status_checks' };
      },
    },
    {
      name: 'unsupported operator',
      expected: /operator is unsupported/,
      change: (_task, value) => { value.operator = 'matches' as ContractAssertion['operator']; },
    },
    {
      name: 'exists expected type',
      expected: /operator exists requires a boolean expected value/,
      change: (_task, value) => { value.operator = 'exists'; value.expected = null; },
    },
    {
      name: 'count expected type',
      expected: /operator count requires a non-negative integer expected value/,
      change: (_task, value) => { value.operator = 'count'; value.expected = 'one'; },
    },
    {
      name: 'missing expected value',
      expected: /expected is required/,
      change: (_task, value) => { delete (value as { expected?: Json }).expected; },
    },
    {
      name: 'unregistered adapter',
      expected: /uses unregistered adapter 'unregistered-adapter'/,
      change: (task) => { task.targets[0]!.adapter = 'unregistered-adapter'; },
    },
    {
      name: 'Postgres connection missing from MCP allowlist',
      expected: /connectionEnv 'OCULORY_TEST_POSTGRES_URL' must appear in the MCP server environment allowlist/,
      change: (task) => { task.mcp_server.env_allowlist = []; },
    },
    {
      name: 'Postgres connection exposed to agent',
      expected: /connectionEnv 'OCULORY_TEST_POSTGRES_URL' must not appear in agent profile 'local'/,
      change: (task) => { task.agent_profiles.local!.env_allowlist = ['OCULORY_TEST_POSTGRES_URL']; },
    },
    {
      name: 'GitHub token exposed to MCP server',
      expected: /tokenEnv 'OCULORY_TEST_GITHUB_TOKEN' must not appear in the MCP server environment allowlist/,
      change: (task) => {
        task.targets[2]!.configuration.tokenEnv = 'OCULORY_TEST_GITHUB_TOKEN';
        task.mcp_server.env_allowlist.push('OCULORY_TEST_GITHUB_TOKEN');
      },
    },
    {
      name: 'GitHub token exposed to agent',
      expected: /tokenEnv 'OCULORY_TEST_GITHUB_TOKEN' must not appear in agent profile 'local'/,
      change: (task) => {
        task.targets[2]!.configuration.tokenEnv = 'OCULORY_TEST_GITHUB_TOKEN';
        task.agent_profiles.local!.env_allowlist = ['OCULORY_TEST_GITHUB_TOKEN'];
      },
    },
  ];

  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), 'oculory-replay-preflight-'));
    try {
      const task = builtInTask();
      const selected = assertion('preflight-check', 'repository', { kind: 'file', path: 'src/index.ts' }, 'exists', true);
      scenario.change(task, selected);
      const store = new PublicRunStore(join(root, '.oculory', 'runs'));
      await assert.rejects(
        replayContract(contract([selected]), {
          taskPath: join(root, 'task.yaml'),
          taskSource: stringify(task, { lineWidth: 100, indent: 2 }),
          profile: 'local',
          registry: createBuiltinAdapterRegistry(),
          store,
        }),
        scenario.expected,
        scenario.name,
      );
      assert.equal(existsSync(store.root), false, `${scenario.name} allocated a run root`);
      assert.equal(existsSync(join(root, '.oculory', 'replays')), false, `${scenario.name} allocated a replay report root`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function builtInTask(): OculoryTaskConfig {
  const command = (): string[] => [process.execPath, '--version'];
  return {
    version: 'oculory-task-v1',
    task_id: 'adapter-preflight',
    prompt: 'Exercise assertion preflight without starting a process.',
    agent_profiles: { local: { argv: command(), env_allowlist: [] } },
    mcp_server: {
      command: process.execPath,
      arguments: ['--version'],
      env_allowlist: ['OCULORY_TEST_POSTGRES_URL'],
    },
    workspace: { strategy: 'command', setup: command(), reset: command(), cleanup: command() },
    targets: [
      {
        id: 'repository',
        adapter: 'git-filesystem',
        configuration: { mode: 'git', baseRefs: ['develop'] },
        watch: { branches: ['develop', 'feature/demo'], paths: ['src'] },
      },
      {
        id: 'database',
        adapter: 'postgres',
        configuration: {
          connectionEnv: 'OCULORY_TEST_POSTGRES_URL',
          sourceSchema: 'public',
          tables: [{ name: 'tasks', columns: ['id', 'status'], orderBy: ['id'] }],
        },
        watch: { tables: ['tasks'] },
      },
      {
        id: 'github',
        adapter: 'github-api',
        configuration: {
          owner: 'octo',
          repository: 'widgets',
          apiBaseUrl: 'http://127.0.0.1:8080',
          tokenEnv: null,
          issueNumbers: [17],
          pullRequestNumbers: [23],
          branchNames: ['main'],
          issueFields: ['title', 'labels'],
          pullRequestFields: ['title', 'labels'],
          branchProtectionFields: ['enforce_admins'],
          commentMode: 'digest',
          resetMode: 'read-only',
        },
        watch: { issues: [17], pullRequests: [23], branches: ['main'] },
      },
    ],
    claim_extraction: { type: 'stdout-final' },
  };
}

function contract(assertions: ContractAssertion[]): OculoryContractConfig {
  return {
    version: 'oculory-contract-v1',
    task: 'adapter-preflight',
    tolerance: { runs: 1, min_pass: 1 },
    assertions,
  };
}

function assertion(
  id: string,
  target: string,
  selector: ContractAssertion['selector'],
  operator: ContractAssertion['operator'] = 'equals',
  expected: Json = null,
): ContractAssertion {
  return { id, target, selector, operator, expected, evaluation: 'exact' };
}
