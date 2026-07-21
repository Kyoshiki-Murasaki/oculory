import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RunStore } from '../src/pipeline/run-store.js';
import { buildRunManifest } from '../src/pipeline/run-context.js';
import { Store } from '../src/pipeline/store.js';
import { SCHEMA_VERSION, type ApprovedSuite, type CandidateTest } from '../src/schema/types.js';

/**
 * Regression test: `oculory suite --run-dir <dir>` compiled a suite but saved
 * it via the module-level `store` (bound to `.oculory`), ignoring `--run-dir`
 * entirely — unlike verify/mine/review/approve, which already honour it. The
 * CLI printed "Compiled suite-... with N tests" but the file landed at
 * `.oculory/suite.json`, not `<run-dir>/suite.json`, so a subsequent
 * `model-replay --suite <run-dir>/suite.json` failed with "does not exist".
 */

const WHEN = new Date('2026-07-05T00:00:00.000Z');

function approvedCandidate(id: string): CandidateTest {
  return {
    schema_version: SCHEMA_VERSION,
    candidate_id: id,
    scenario_family: 'complete_by_id',
    scenario_ids: ['complete_by_id-m1'],
    fixture_id: 'seed-v1',
    intents: ['x'],
    assertions: [
      {
        assertion_id: 'a1',
        type: 'tool_required',
        params: { tool: 'complete_task' },
        confidence: 1,
        support: 2,
        total: 2,
        stable: true,
        provenance: { trace_ids: [], miner: 'm' },
      },
    ],
    status: 'approved',
    recommended_gate: 'gate_eligible',
    risk_notes: [],
    review: null,
  };
}

function cli(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', 'dist/src/cli/main.js', ...args], {
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

test('suite --run-dir <dir>: writes suite.json inside the run directory, not .oculory', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'oculory-suite-rundir-'));
  const rs = new RunStore(runDir);
  rs.writeManifest(
    buildRunManifest({
      kind: 'model-experiment',
      runId: 'model-experiment-suite-test',
      rootDir: runDir,
      command: 'oculory model-experiment',
      when: WHEN,
      policyId: 'model/openai/gpt-4.1-mini',
    }),
  );
  rs.saveCandidates([approvedCandidate('cand-1')]);

  const r = cli(['suite', '--run-dir', runDir]);
  assert.equal(r.code, 0, `expected a clean exit; stderr: ${r.err}`);

  const suitePath = join(runDir, 'suite.json');
  assert.match(r.out, new RegExp(suitePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'CLI output must print the exact path written');
  assert.equal(existsSync(suitePath), true, 'suite.json must exist inside the run directory');

  const suite = JSON.parse(readFileSync(suitePath, 'utf8')) as ApprovedSuite;
  assert.equal(suite.tests.length, 1);
  assert.equal(suite.tests[0]!.candidate_id, 'cand-1');

  // The legacy scripted store must NOT have been touched by this isolated run.
  assert.equal(existsSync(join('.oculory', 'suite.json')) && readFileSync(join('.oculory', 'suite.json'), 'utf8').includes('cand-1'), false);
});

test('suite --run-dir <dir>: model-replay can subsequently find the suite at the printed path', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'oculory-suite-rundir-replay-'));
  const rs = new RunStore(runDir);
  rs.writeManifest(
    buildRunManifest({
      kind: 'model-experiment',
      runId: 'model-experiment-suite-test-2',
      rootDir: runDir,
      command: 'oculory model-experiment',
      when: WHEN,
      policyId: 'model/openai/gpt-4.1-mini',
    }),
  );
  rs.saveCandidates([approvedCandidate('cand-2')]);
  const compiled = cli(['suite', '--run-dir', runDir]);
  assert.equal(compiled.code, 0);

  const suitePath = join(runDir, 'suite.json');
  // Reproduces the user's exact reported symptom: `model-replay --suite
  // "$latest/suite.json"` failed with "does not exist" because suite --run-dir
  // wrote to .oculory/suite.json instead. Uses the fetch-stub bootstrap (added
  // for the commandLine TDZ fix) with a fake key so execution gets past
  // requireApiKey() and reaches the --suite existence check and beyond,
  // without ever calling the real OpenAI API.
  const out = mkdtempSync(join(tmpdir(), 'oculory-suite-replay-out-'));
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-sqlite', '--no-warnings', 'test/support/model-smoke-stub-bootstrap.mjs',
      'advanced', 'model-replay', '--suite', suitePath, '--model', 'gpt-4.1-mini', '--trials', '1', '--budget-usd', '1', '--out-dir', out,
    ],
    { encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: 'sk-test-not-real' } },
  );
  assert.doesNotMatch(r.stderr, /--suite .* does not exist/, `model-replay must find the suite written by suite --run-dir; stderr: ${r.stderr}`);
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);
});

test('legacy suite (no --run-dir): keeps existing behaviour, writing to the --store root', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'oculory-suite-legacy-'));
  const store = new Store(storeDir);
  store.saveCandidates([approvedCandidate('cand-legacy')]);

  const r = spawnSync(
    process.execPath,
    ['--experimental-sqlite', '--no-warnings', 'dist/src/cli/main.js', 'suite', '--store', storeDir],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `expected a clean exit; stderr: ${r.stderr}`);

  const suitePath = join(storeDir, 'suite.json');
  assert.equal(existsSync(suitePath), true, 'suite.json must exist at the --store root, exactly as before');
  const suite = JSON.parse(readFileSync(suitePath, 'utf8')) as ApprovedSuite;
  assert.equal(suite.tests.length, 1);
  assert.equal(suite.tests[0]!.candidate_id, 'cand-legacy');
  assert.match(r.stdout ?? '', new RegExp(suitePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
