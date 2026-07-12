import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function cli(args: string[], env: Record<string, string | undefined> = {}): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', 'dist/src/cli/main.js', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

test('issue CLI: help lists the issue-tracker commands', () => {
  const r = cli(['help']);
  assert.equal(r.code, 0);
  for (const cmd of ['issue-inspect', 'issue-scenarios', 'issue-experiment', 'issue-model-smoke', 'issue-model-experiment', 'issue-model-replay']) {
    assert.match(r.out, new RegExp(cmd), `help should mention ${cmd}`);
  }
});

test('issue CLI: issue-inspect lists the 9 issue-tracker tools', () => {
  const r = cli(['issue-inspect']);
  assert.equal(r.code, 0);
  for (const tool of ['create_issue', 'read_issue', 'search_issues', 'assign_issue', 'label_issue', 'comment_issue', 'close_issue', 'reopen_issue', 'list_issues']) {
    assert.match(r.out, new RegExp(`^${tool}\\(`, 'm'), `should list ${tool}`);
  }
});

test('issue CLI: issue-scenarios and issue-mutate are selectable and non-empty', () => {
  const scen = cli(['issue-scenarios']);
  assert.equal(scen.code, 0);
  assert.match(scen.out, /issue-ambiguous-a1/);
  const mut = cli(['issue-mutate']);
  assert.equal(mut.code, 0);
  assert.match(mut.out, /already_closed_policy_changed/);
});

/* These fail BEFORE any network call — no test hits a real API. */

test('issue CLI: issue-model-smoke without OPENAI_API_KEY fails clearly (exit 1, no network)', () => {
  const r = cli(['issue-model-smoke', '--model', 'gpt-4.1-mini'], { OPENAI_API_KEY: '' });
  assert.equal(r.code, 1);
  assert.match(r.err, /OPENAI_API_KEY/);
});

test('issue CLI: issue-model-experiment rejects an invalid --partition (exit 1)', () => {
  const r = cli(['issue-model-experiment', '--partition', 'bogus'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(r.code, 1);
  assert.match(r.err, /--partition must be one of/);
});

test('issue CLI: issue-model-replay requires --suite and an existing file', () => {
  const noSuite = cli(['issue-model-replay', '--model', 'gpt-4.1-mini', '--budget-usd', '5'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(noSuite.code, 1);
  assert.match(noSuite.err, /--suite/);

  const missing = cli(['issue-model-replay', '--model', 'gpt-4.1-mini', '--budget-usd', '5', '--suite', '/no/such/issue-suite.json'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /does not exist/);
});
