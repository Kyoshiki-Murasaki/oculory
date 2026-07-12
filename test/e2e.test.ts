import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/pipeline/store.js';
import { loadFixture, runExperiment } from '../src/pipeline/experiment.js';

const fixture = loadFixture('fixtures/seed.json');

test('e2e experiment: clean baseline, behaviour-level detections, no benign false positives', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'oculory-e2e-')));
  const metrics = await runExperiment(store, fixture);

  assert.equal(metrics.baseline_run_pass_rate, 1, 'unmutated suite must be 100% green');
  assert.equal(metrics.other_outcomes, 0, 'all traffic must verify as success or valid rejection');
  assert.notEqual(metrics.decision, 'technical_failure');

  const byId = new Map(metrics.mutations.map((m) => [m.mutation_id, m]));
  // Behaviour-level defects the schema-smoke proxy cannot see:
  assert.equal(byId.get('silent_write_failure')!.mined_detected, true);
  assert.equal(byId.get('wrong_success')!.mined_detected, true);
  assert.equal(byId.get('wrong_success')!.baseline_detected, false);
  assert.equal(byId.get('partial_match_changed')!.mined_detected, true);
  assert.equal(byId.get('partial_match_changed')!.baseline_detected, false);
  // Benign mutation must not trip the mined suite:
  assert.equal(byId.get('tool_order_changed')!.mined_detected, false);
  assert.equal(metrics.mined.fp, 0);
  assert.equal(metrics.unique_detections_beyond_baseline.length >= 3, true);

  // Artifacts written and internally consistent:
  const report = readFileSync(join(store.root, 'reports', 'experiment-report.md'), 'utf8');
  assert.match(report, /Decision \(pre-registered rule/);
  assert.equal(store.loadSuite()!.tests.length > 0, true);
  store.clean();
});

test('e2e reproducibility: two experiment runs produce identical suite hashes and decisions', async () => {
  const a = await runExperiment(new Store(mkdtempSync(join(tmpdir(), 'oculory-r1-'))), fixture);
  const b = await runExperiment(new Store(mkdtempSync(join(tmpdir(), 'oculory-r2-'))), fixture);
  assert.equal(a.decision, b.decision);
  assert.deepEqual(a.mutations, b.mutations);
  assert.equal(a.stable_assertions, b.stable_assertions);
});

/* ------------------------------- CLI ------------------------------------ */

function cli(args: string[], storeDir: string): { code: number; out: string; err: string } {
  const r = spawnSync(
    process.execPath,
    ['--experimental-sqlite', '--no-warnings', 'dist/src/cli/main.js', ...args, '--store', storeDir],
    { encoding: 'utf8' },
  );
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

test('cli: help exits 0, unknown command exits 1 with message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oculory-cli-'));
  assert.equal(cli(['help'], dir).code, 0);
  const bad = cli(['frobnicate'], dir);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown command/);
});

test('cli: pipeline commands chain with correct exit codes, run exits 2 under a mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oculory-cli2-'));
  assert.equal(cli(['record', '--all'], dir).code, 0);
  assert.equal(cli(['verify'], dir).code, 0);
  assert.equal(cli(['mine'], dir).code, 0);
  assert.equal(cli(['review'], dir).code, 0);
  assert.equal(cli(['approve', '--all-stable'], dir).code, 0);
  assert.equal(cli(['suite'], dir).code, 0);
  assert.equal(cli(['run'], dir).code, 0, 'unmutated run must pass');
  const mutated = cli(['run', '--mutation', 'silent_write_failure'], dir);
  assert.equal(mutated.code, 2, 'regression must exit 2 for CI gating');
  const guard = cli(['verify'], mkdtempSync(join(tmpdir(), 'oculory-cli3-')));
  assert.equal(guard.code, 1, 'verify without traces is a usage error');
  assert.match(guard.err, /no raw traces/);
});
