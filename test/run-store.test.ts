import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RunStore } from '../src/pipeline/run-store.js';
import {
  DEFAULT_LIVE_RUNS_ROOT,
  assertRunDirSafe,
  assertSafeRunId,
  buildRunManifest,
  isNonEmptyDir,
  prepareRunDir,
  resolveRunDir,
  runIdFor,
  updateManifestForAppend,
} from '../src/pipeline/run-context.js';
import { Store } from '../src/pipeline/store.js';
import { loadFixture, runExperiment } from '../src/pipeline/experiment.js';
import type { RawTrace } from '../src/schema/types.js';

const WHEN = new Date('2026-07-04T08:15:00.000Z');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'oculory-run-'));
}

test('run-id: default is sortable & filesystem-safe; explicit ids are validated', () => {
  assert.equal(runIdFor('model-smoke', WHEN), 'model-smoke-2026-07-04T08-15-00-000Z');
  assert.equal(runIdFor('model-smoke', WHEN, 'my-run_1'), 'my-run_1');
  assert.throws(() => assertSafeRunId('../escape'), /invalid --run-id/);
  assert.throws(() => assertSafeRunId('a/b'), /invalid --run-id/);
  assert.throws(() => runIdFor('replay', WHEN, '..'), /invalid --run-id/);
});

test('resolveRunDir: defaults under .oculory/runs-live, honours --out-dir', () => {
  assert.equal(resolveRunDir({ runId: 'model-smoke-x' }), join(DEFAULT_LIVE_RUNS_ROOT, 'model-smoke-x'));
  assert.equal(resolveRunDir({ outDir: '/some/where', runId: 'x' }), '/some/where');
});

test('path safety: refuses the cwd, an ancestor of it, and the filesystem root', () => {
  assert.throws(() => assertRunDirSafe('.'), /current working directory|run directory/);
  assert.throws(() => assertRunDirSafe('..'), /contains the current working directory/);
  assert.throws(() => assertRunDirSafe('/'), /filesystem root/);
  // A fresh subdirectory is fine.
  assert.doesNotThrow(() => assertRunDirSafe(join('.oculory', 'runs-live', 'ok')));
});

test('fresh run: prepareRunDir creates the directory, manifest round-trips', () => {
  const dir = join(tmp(), 'model-smoke-1');
  const prepared = prepareRunDir(dir, 'create');
  assert.equal(prepared.reused, false);
  assert.equal(existsSync(dir), true);

  const rs = new RunStore(dir);
  const manifest = buildRunManifest({
    kind: 'model-smoke',
    runId: 'model-smoke-1',
    rootDir: dir,
    command: 'oculory model-smoke',
    when: WHEN,
    policyId: 'model/openai/gpt-4.1-mini',
    model: 'gpt-4.1-mini',
    provider: 'openai',
    trials: 3,
    budgetUsd: 1,
    partition: 'smoke',
  });
  rs.writeManifest(manifest);
  const read = rs.readManifest()!;
  assert.equal(read.run_id, 'model-smoke-1');
  assert.equal(read.kind, 'model-smoke');
  assert.equal(read.model, 'gpt-4.1-mini');
  assert.equal(read.node_version, process.versions.node);
  assert.equal(read.created_at, WHEN.toISOString());
  assert.equal(existsSync(join(dir, 'logs')), true, 'logs/ dir is created');
  rmSync(dir, { recursive: true });
});

test('refusal: writing into a non-empty run directory fails without --clean/--append/--force', () => {
  const dir = join(tmp(), 'run');
  prepareRunDir(dir, 'create');
  new RunStore(dir).appendRawTrace({ trace_id: 'x' } as unknown as RawTrace);
  assert.equal(isNonEmptyDir(dir), true);
  assert.throws(() => prepareRunDir(dir, 'create'), /already exists and is not empty/);
});

test('--clean empties the directory; --append preserves it', () => {
  const dir = join(tmp(), 'run');
  prepareRunDir(dir, 'create');
  const rs = new RunStore(dir);
  rs.appendRawTrace({ trace_id: 'a' } as unknown as RawTrace);
  assert.equal(rs.loadRawTraces().length, 1);

  // append: contents survive.
  prepareRunDir(dir, 'append');
  assert.equal(new RunStore(dir).loadRawTraces().length, 1);

  // clean: contents are wiped.
  prepareRunDir(dir, 'clean');
  assert.equal(new RunStore(dir).loadRawTraces().length, 0);
});

test('--force resets this run\'s append-only outputs but not the directory', () => {
  const dir = join(tmp(), 'run');
  prepareRunDir(dir, 'create');
  const rs = new RunStore(dir);
  rs.writeManifest(buildRunManifest({ kind: 'model-smoke', runId: 'r', rootDir: dir, command: 'c', when: WHEN, policyId: 'p' }));
  rs.appendRawTrace({ trace_id: 'a' } as unknown as RawTrace);
  rs.resetTraceOutputs();
  assert.equal(rs.loadRawTraces().length, 0, 'raw traces are cleared');
  assert.equal(rs.readManifest() !== null, true, 'unrelated files (manifest) are preserved');
});

test('append manifest update: created_at kept, append_count bumped, updated_at stamped', () => {
  const base = buildRunManifest({ kind: 'model-smoke', runId: 'r', rootDir: 'd', command: 'c1', when: WHEN, policyId: 'p' });
  const next = updateManifestForAppend(base, { when: new Date('2026-07-05T00:00:00.000Z'), command: 'c2' });
  assert.equal(next.created_at, base.created_at);
  assert.equal(next.append_count, 1);
  assert.equal(next.command, 'c2');
  assert.equal(next.updated_at, '2026-07-05T00:00:00.000Z');
});

test('generated files stay inside the run directory (nothing escapes root)', () => {
  const root = tmp();
  const dir = join(root, 'model-smoke-1');
  prepareRunDir(dir, 'create');
  const rs = new RunStore(dir);
  rs.writeManifest(buildRunManifest({ kind: 'model-smoke', runId: 'r', rootDir: dir, command: 'c', when: WHEN, policyId: 'p' }));
  rs.appendRawTrace({ trace_id: 'a' } as unknown as RawTrace);
  rs.saveJsonReport('summary.json', { ok: true });
  rs.appendLog('run.log', 'hello');
  for (const rel of ['manifest.json', join('traces', 'raw.jsonl'), join('reports', 'summary.json'), join('logs', 'run.log')]) {
    const p = resolve(join(dir, rel));
    assert.equal(existsSync(p), true, `${rel} exists`);
    assert.equal(p.startsWith(resolve(dir)), true, `${rel} is inside the run directory`);
  }
});

test('legacy scripted experiment is unaffected by the run-isolation layer', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'oculory-legacy-')));
  const metrics = await runExperiment(store, loadFixture('fixtures/seed.json'));
  assert.notEqual(metrics.decision, 'technical_failure');
  assert.equal(store.loadSuite()!.tests.length > 0, true);
  // The legacy store must not have grown a runs-live directory.
  assert.equal(existsSync(join(store.root, 'runs-live')), false);
  // None of these candidates carry a model risk_profile.
  assert.equal(store.loadCandidates().every((c) => c.risk_profile === undefined || c.risk_profile === null), true);
  store.clean();
});

test('a plain (non-manifest) directory is not mistaken for a run', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'note.txt'), 'not a run');
  assert.equal(new RunStore(dir).readManifest(), null);
});
