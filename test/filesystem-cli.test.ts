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

test('fs CLI: help lists the filesystem commands', () => {
  const r = cli(['help']);
  assert.equal(r.code, 0);
  for (const cmd of ['fs-inspect', 'fs-scenarios', 'fs-experiment', 'fs-model-smoke', 'fs-model-experiment', 'fs-model-replay']) {
    assert.match(r.out, new RegExp(cmd), `help should mention ${cmd}`);
  }
});

test('fs CLI: fs-inspect lists the 9 sandboxed filesystem tools', () => {
  const r = cli(['fs-inspect']);
  assert.equal(r.code, 0);
  for (const tool of ['read_file', 'write_file', 'append_file', 'list_dir', 'stat_path', 'delete_file', 'move_file', 'copy_file', 'search_files']) {
    assert.match(r.out, new RegExp(`^${tool}\\(`, 'm'), `should list ${tool}`);
  }
});

test('fs CLI: fs-scenarios and fs-mutate are selectable and non-empty', () => {
  const scen = cli(['fs-scenarios']);
  assert.equal(scen.code, 0);
  assert.match(scen.out, /fs-traversal-a1/);
  const mut = cli(['fs-mutate']);
  assert.equal(mut.code, 0);
  assert.match(mut.out, /path_traversal_allowed/);
});

/* These fail BEFORE any network call — no test hits a real API. */

test('fs CLI: fs-model-smoke without OPENAI_API_KEY fails clearly (exit 1, no network)', () => {
  const r = cli(['fs-model-smoke', '--model', 'gpt-4.1-mini'], { OPENAI_API_KEY: '' });
  assert.equal(r.code, 1);
  assert.match(r.err, /OPENAI_API_KEY/);
});

test('fs CLI: fs-model-experiment rejects an invalid --partition (exit 1)', () => {
  const r = cli(['fs-model-experiment', '--partition', 'bogus'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(r.code, 1);
  assert.match(r.err, /--partition must be one of/);
});

test('fs CLI: fs-model-replay requires --suite and an existing file', () => {
  const noSuite = cli(['fs-model-replay', '--model', 'gpt-4.1-mini', '--budget-usd', '5'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(noSuite.code, 1);
  assert.match(noSuite.err, /--suite/);

  const missing = cli(['fs-model-replay', '--model', 'gpt-4.1-mini', '--budget-usd', '5', '--suite', '/no/such/fs-suite.json'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /does not exist/);
});
