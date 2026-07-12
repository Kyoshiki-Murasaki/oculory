import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function cli(args: string[], env: Record<string, string | undefined> = {}): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', 'dist/src/cli/main.js', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/* -------------------------------- doctor -------------------------------- */

test('doctor: passes in this environment and reports the new best-effort checks', () => {
  const r = cli(['doctor']);
  assert.equal(r.code, 0);
  assert.match(r.out, /node .* \(>=22\.13\)/);
  assert.match(r.out, /node:sqlite functional/);
  assert.match(r.out, /gitignored/);
  // best-effort checks never turn a clean environment red.
  assert.doesNotMatch(r.out, /^FAIL/m);
});

test('doctor --model: reports OPENAI_API_KEY presence WITHOUT printing the key, stays exit 0 when absent', () => {
  const r = cli(['doctor', '--model', 'gpt-4.1-mini'], { OPENAI_API_KEY: '' });
  assert.equal(r.code, 0);
  assert.match(r.out, /OPENAI_API_KEY present: no/);

  const secret = 'sk-super-secret-value-should-never-appear';
  const r2 = cli(['doctor', '--model', 'gpt-4.1-mini'], { OPENAI_API_KEY: secret });
  assert.match(r2.out, /OPENAI_API_KEY present: yes/);
  assert.doesNotMatch(r2.out, /sk-super-secret/, 'never echoes the key value');
});

/* --------------------- model command argument validation ---------------- */
/* These paths all fail BEFORE any network call — no test hits a real API.  */

test('model-smoke: missing OPENAI_API_KEY fails clearly (exit 1), never reaches the network', () => {
  const r = cli(['model-smoke', '--model', 'gpt-4.1-mini'], { OPENAI_API_KEY: '' });
  assert.equal(r.code, 1);
  assert.match(r.err, /OPENAI_API_KEY/);
});

test('model-smoke: invalid --trials / --budget-usd are rejected before any client is built', () => {
  const t = cli(['model-smoke', '--trials', '0'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(t.code, 1);
  assert.match(t.err, /--trials must be a positive integer/);

  const b = cli(['model-smoke', '--budget-usd', '0'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(b.code, 1);
  assert.match(b.err, /--budget-usd must be a positive number/);
});

test('model-smoke: refuses a non-empty --out-dir without --clean/--append/--force (exit 1, no network)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oculory-outdir-'));
  writeFileSync(join(dir, 'preexisting.txt'), 'contamination');
  const r = cli(['model-smoke', '--model', 'gpt-4.1-mini', '--out-dir', dir], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists and is not empty/);
});

test('model-smoke: an unsafe --run-id is rejected (path safety)', () => {
  const r = cli(['model-smoke', '--model', 'gpt-4.1-mini', '--run-id', '../escape'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid --run-id/);
});

test('model-experiment: an invalid --partition is rejected', () => {
  const r = cli(['model-experiment', '--partition', 'bogus'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(r.code, 1);
  assert.match(r.err, /--partition must be one of/);
});

test('model-replay: requires an explicit --suite and --budget-usd', () => {
  const noSuite = cli(['model-replay', '--model', 'gpt-4.1-mini', '--budget-usd', '5'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(noSuite.code, 1);
  assert.match(noSuite.err, /--suite/);

  const missingFile = cli(['model-replay', '--model', 'gpt-4.1-mini', '--budget-usd', '5', '--suite', '/no/such/suite.json'], { OPENAI_API_KEY: 'sk-fake-not-real' });
  assert.equal(missingFile.code, 1);
  assert.match(missingFile.err, /does not exist/);
});

test('help lists the isolated model commands and run-isolation flags', () => {
  const r = cli(['help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /model-smoke/);
  assert.match(r.out, /model-experiment/);
  assert.match(r.out, /model-replay/);
  assert.match(r.out, /--out-dir .* --run-id .* --clean --append --force/);
});
