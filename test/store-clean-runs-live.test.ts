import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, LIVE_RUNS_SUBDIR, MODEL_RUNS_SUBDIR } from '../src/pipeline/store.js';
import { loadFixture, runExperiment } from '../src/pipeline/experiment.js';
import { runFsExperiment } from '../src/examples/filesystem/experiment.js';
import { runIssueExperiment } from '../src/examples/issuetracker/experiment.js';

/**
 * Regression guard for the `.oculory/runs-live` deletion footgun (docs/27).
 *
 * `oculory experiment` and `oculory fs-experiment` both call `store.clean()` at
 * the start of a run. Isolated live-model runs live under `<store>/runs-live/`
 * and cost real API spend (they are not regenerable offline), so a scripted
 * re-run must NEVER delete them. These tests seed a
 * `runs-live/sentinel/manifest.json` and prove every cleanup path spares it
 * while still wiping the scripted artifacts a fresh experiment is meant to
 * replace.
 */

/**
 * Seed a store with (a) one live run to protect, (b) stale scripted output that
 * a fresh experiment overwrites, and (c) a uniquely-named stale marker the
 * experiment never re-creates — so we can prove `clean()` actually wiped
 * non-live content even after the experiment repopulates `traces/`, etc.
 */
function seedStore(root: string): { live: string; staleTrace: string; staleCandidates: string; staleMarker: string } {
  const liveDir = join(root, LIVE_RUNS_SUBDIR, 'sentinel');
  mkdirSync(liveDir, { recursive: true });
  const live = join(liveDir, 'manifest.json');
  writeFileSync(live, JSON.stringify({ run_id: 'sentinel', kind: 'model-experiment', model: 'gpt-4.1-mini' }) + '\n', 'utf8');

  mkdirSync(join(root, 'traces'), { recursive: true });
  const staleTrace = join(root, 'traces', 'raw.jsonl');
  writeFileSync(staleTrace, '{"stale":true}\n', 'utf8');
  const staleCandidates = join(root, 'candidates.json');
  writeFileSync(staleCandidates, '[{"stale":true}]\n', 'utf8');
  const staleMarker = join(root, 'STALE_MARKER.txt');
  writeFileSync(staleMarker, 'this pre-existing scripted artifact must be wiped by clean()\n', 'utf8');
  return { live, staleTrace, staleCandidates, staleMarker };
}

function seedModelEvidence(root: string): string {
  const directory = join(root, MODEL_RUNS_SUBDIR, 'offline-sentinel');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'manifest.json');
  writeFileSync(path, '{"schemaVersion":"model-run-v1","finalized":true}\n', 'utf8');
  return path;
}

test('Store.clean(): preserves runs-live, wipes scripted artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-clean-'));
  const { live, staleTrace, staleCandidates } = seedStore(root);
  new Store(root).clean();
  assert.equal(existsSync(live), true, 'live run sentinel survives a routine clean');
  assert.equal(existsSync(staleTrace), false, 'stale scripted trace is removed');
  assert.equal(existsSync(staleCandidates), false, 'stale candidates are removed');
  rmSync(root, { recursive: true, force: true });
});

test('Store.clean(): preserves runs-model unless its distinct destructive flag is explicit', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-model-clean-'));
  const model = seedModelEvidence(root);
  new Store(root).clean();
  assert.equal(existsSync(model), true);
  new Store(root).clean({ includeModelRuns: true });
  assert.equal(existsSync(model), false);
});

test('Store.clean({includeLiveRuns:true}): explicit full wipe removes runs-live too', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-wipe-'));
  const { live } = seedStore(root);
  new Store(root).clean({ includeLiveRuns: true });
  assert.equal(existsSync(live), false, 'explicit --include-live removes live runs');
  assert.equal(existsSync(root), false, 'the whole store root is gone');
});

test('Store.clean(): no-op on a missing root (never throws)', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'oculory-none-')), 'does-not-exist');
  assert.doesNotThrow(() => new Store(root).clean());
});

test('experiment cleanup (runExperiment) spares a runs-live sentinel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-exp-'));
  const { live, staleMarker } = seedStore(root);
  await runExperiment(new Store(root), loadFixture('fixtures/seed.json'));
  assert.equal(existsSync(live), true, 'legacy scripted experiment must not delete <store>/runs-live');
  assert.equal(existsSync(staleMarker), false, 'the stale pre-seeded scripted artifact was still cleaned');
  assert.equal(existsSync(join(root, 'suite.json')), true, 'experiment still writes a fresh suite (clean+init ran)');
  rmSync(root, { recursive: true, force: true });
});

test('fs-experiment cleanup (runFsExperiment) spares a runs-live sentinel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-fsexp-'));
  const { live, staleMarker } = seedStore(root);
  await runFsExperiment(new Store(root));
  assert.equal(existsSync(live), true, 'filesystem scripted experiment must not delete <store>/runs-live');
  assert.equal(existsSync(staleMarker), false, 'the stale pre-seeded scripted artifact was still cleaned');
  assert.equal(existsSync(join(root, 'suite.json')), true, 'fs-experiment still writes a fresh suite (clean+init ran)');
  rmSync(root, { recursive: true, force: true });
});

test('task, filesystem, and issue experiments preserve runs-model by default', async () => {
  for (const kind of ['task', 'filesystem', 'issue'] as const) {
    const root = mkdtempSync(join(tmpdir(), `oculory-model-${kind}-`));
    const model = seedModelEvidence(root);
    if (kind === 'task') await runExperiment(new Store(root), loadFixture('fixtures/seed.json'));
    else if (kind === 'filesystem') await runFsExperiment(new Store(root));
    else await runIssueExperiment(new Store(root));
    assert.equal(existsSync(model), true, `${kind} experiment preserves runs-model`);
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------------- CLI ---------------------------------- */

function cli(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', 'dist/src/cli/main.js', ...args], {
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

test('CLI clean: preserves runs-live by default, --include-live forces a full wipe', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-cliclean-'));
  const { live, staleCandidates } = seedStore(root);

  const keep = cli(['clean', '--store', root]);
  assert.equal(keep.code, 0);
  assert.match(keep.out, /preserved/, 'clean reports that it preserved the live runs');
  assert.equal(existsSync(live), true, 'default clean keeps live runs');
  assert.equal(existsSync(staleCandidates), false, 'default clean removes scripted output');

  const wipe = cli(['clean', '--store', root, '--include-live']);
  assert.equal(wipe.code, 0);
  assert.equal(existsSync(live), false, '--include-live removes live runs');
});

test('CLI clean preserves runs-model by default and removes it only with --include-model', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-cli-model-clean-'));
  const model = seedModelEvidence(root);
  const keep = cli(['clean', '--store', root]);
  assert.equal(keep.code, 0);
  assert.match(keep.out, /preserved .*runs-model/);
  assert.equal(existsSync(model), true);
  const wipe = cli(['clean', '--store', root, '--include-model']);
  assert.equal(wipe.code, 0);
  assert.equal(existsSync(model), false);
});
