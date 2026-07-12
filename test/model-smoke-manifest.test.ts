import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Regression test for a TDZ bug: `const commandLine` was declared AFTER
 * `void main();` in src/cli/main.ts, but `openModelRun()` — called
 * synchronously (before any `await`) from the `model-smoke` /
 * `model-experiment` / `model-replay` cases — reads `commandLine` while
 * writing the run manifest. Because `main()` runs synchronously up to its
 * first `await`, that reference executed before the `const commandLine = ...`
 * line ever ran, throwing "Cannot access 'commandLine' before
 * initialization" the moment a real invocation reached manifest creation.
 *
 * No unit test on an exported function could catch this: the whole defect
 * is about the ORDER two top-level module statements execute in, which only
 * manifests when the real compiled module is loaded and run — exactly what
 * this test does. It also would NOT have been caught by the existing
 * "refuses a non-empty --out-dir" test (test/doctor-and-cli.test.ts), because
 * that path fails inside openModelRun's try/catch (`prepareRunDir` throwing)
 * BEFORE ever reaching the `commandLine` reference. This test uses a FRESH
 * empty --out-dir so `prepareRunDir` succeeds and execution reaches the
 * manifest-write line.
 *
 * It spawns the real compiled CLI (not a stub of the CLI itself) through a
 * tiny bootstrap that monkey-patches global `fetch` so the real
 * `OpenAiClient` gets a canned response instead of ever touching the
 * network — genuinely end to end, through manifest creation, no real API call.
 */
const BOOTSTRAP = 'test/support/model-smoke-stub-bootstrap.mjs';
const FAKE_KEY = 'sk-test-not-real';
const TDZ_MESSAGE = /Cannot access 'commandLine' before initialization/;

function spawnCli(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', BOOTSTRAP, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OPENAI_API_KEY: FAKE_KEY },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

test('model-smoke: reaches manifest creation without the commandLine TDZ crash (regression)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'oculory-modelsmoke-manifest-'));
  const r = spawnCli(['model-smoke', '--model', 'gpt-4.1-mini', '--trials', '1', '--budget-usd', '1', '--out-dir', outDir]);

  assert.doesNotMatch(r.err, TDZ_MESSAGE, `TDZ regression reintroduced; stderr: ${r.err}`);
  assert.equal(r.code, 0, `expected a clean exit; stderr: ${r.err}`);

  const manifestPath = join(outDir, 'manifest.json');
  assert.equal(existsSync(manifestPath), true, 'manifest.json must be written');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { kind: string; command: string; model: string };
  assert.equal(manifest.kind, 'model-smoke');
  assert.equal(manifest.model, 'gpt-4.1-mini');
  // Proves `commandLine` (built from the real argv) was captured correctly, not just absent-of-crash.
  assert.match(manifest.command, /^oculory model-smoke --model gpt-4\.1-mini --trials 1 --budget-usd 1 --out-dir/);

  assert.equal(existsSync(join(outDir, 'reports', 'model-smoke-summary.json')), true);
});

test('model-experiment: also reaches manifest creation via the same openModelRun path (regression)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'oculory-modelexp-manifest-'));
  const r = spawnCli([
    'model-experiment',
    '--model', 'gpt-4.1-mini',
    '--trials', '1',
    '--budget-usd', '1',
    '--max-scenarios', '1',
    '--out-dir', outDir,
  ]);

  assert.doesNotMatch(r.err, TDZ_MESSAGE, `TDZ regression reintroduced; stderr: ${r.err}`);
  assert.equal(r.code, 0, `expected a clean exit; stderr: ${r.err}`);

  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as { kind: string; command: string };
  assert.equal(manifest.kind, 'model-experiment');
  assert.match(manifest.command, /^oculory model-experiment\b/);
});

test('model-smoke --append: the append-manifest path also reads commandLine safely (regression)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'oculory-modelsmoke-append-'));
  const first = spawnCli(['model-smoke', '--model', 'gpt-4.1-mini', '--trials', '1', '--budget-usd', '1', '--out-dir', outDir]);
  assert.equal(first.code, 0, `first run failed; stderr: ${first.err}`);

  const second = spawnCli(['model-smoke', '--model', 'gpt-4.1-mini', '--trials', '1', '--budget-usd', '1', '--out-dir', outDir, '--append']);
  assert.doesNotMatch(second.err, TDZ_MESSAGE, `TDZ regression reintroduced on --append; stderr: ${second.err}`);
  assert.equal(second.code, 0, `expected a clean exit; stderr: ${second.err}`);

  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as { append_count: number; command: string };
  assert.equal(manifest.append_count, 1);
  assert.match(manifest.command, /--append/);
});
