import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approveRun } from '../src/mlp/approve.js';
import { loadContractConfig } from '../src/mlp/config.js';
import {
  renderReplaySummary,
  renderViolation,
  type ViolationRenderModel,
} from '../src/mlp/renderer.js';
import type { ReplayAssertionEvaluation } from '../src/mlp/replay.js';
import type { PublicRunSummary } from '../src/mlp/record.js';
import { PublicRunStore } from '../src/mlp/run-store.js';
import { showRun } from '../src/mlp/show.js';

const violationModel: ViolationRenderModel = {
  assertion_id: 'feature-branch-outcome',
  claim: { status: 'available', text: 'Created branch and committed changes ✓', source: 'stdout-final' },
  tool: { status: 'success', detail: 'success' },
  failures: [
    {
      selector: { kind: 'branch_base', branch: 'feature/demo' },
      result: {
        assertionId: 'branch-base',
        passed: false,
        ignored: false,
        operator: 'equals',
        evaluationMode: 'exact',
        expected: 'develop',
        observed: 'main',
        detail: 'branch base did not match',
      },
      description: 'feature branch was based on main',
    },
    {
      selector: { kind: 'staged_files' },
      result: {
        assertionId: 'no-staged-files',
        passed: false,
        ignored: false,
        operator: 'none',
        evaluationMode: 'exact',
        expected: [],
        observed: ['config/demo.txt', 'feature.txt'],
        detail: 'staged files remained',
      },
      description: 'files remained staged',
    },
  ],
  profiles: [
    { profile: 'changed', status: 'FAIL', passed: 3, requested: 12, threshold: 10 },
    { profile: 'baseline', status: 'PASS', passed: 12, requested: 12, threshold: 10 },
  ],
  run_id: 'run_0025',
};

const violationGolden = `✗ CONTRACT VIOLATED: feature-branch-outcome

  Agent said:      "Created branch and committed changes ✓"
  Tool returned:   success
  Actual state:    branch created from wrong base (main, expected develop)
                   2 files staged, never committed

  Replay results:
    baseline           PASS  (12/12 runs)
    changed            FAIL  (3/12 runs passed; threshold 10)

  → Diff: oculory show run_0025 --diff
`;

test('approve drafts the same editable one-run contract without statistical mining or timestamps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-approve-'));
  const store = new PublicRunStore(join(root, 'evidence', 'runs'));
  const firstCwd = join(root, 'first');
  const secondCwd = join(root, 'second');
  mkdirSync(firstCwd);
  mkdirSync(secondCwd);
  try {
    initRepository(firstCwd);
    initRepository(secondCwd);
    const runId = seedApprovedGitRun(store);
    const first = await approveRun(runId, { store, cwd: firstCwd, yes: true });
    const second = await approveRun(runId, { store, cwd: secondCwd, yes: true });

    assert.equal(first.source, second.source);
    assert.deepEqual(first.contract, second.contract);
    assert.deepEqual(first.contract.tolerance, { runs: 12, min_pass: 10 });
    assert.deepEqual(first.contract.assertions.map((assertion) => assertion.id), [
      'workspace-branch-feature-demo-base',
      'workspace-branch-feature-demo-exists',
      'workspace-clean-tree',
      'workspace-current-branch',
      'workspace-file-feature-txt-digest',
      'workspace-file-feature-txt-exists',
      'workspace-file-obsolete-txt-absent',
      'workspace-no-staged-files',
      'workspace-no-unstaged-files',
      'workspace-no-untracked-files',
    ]);
    assert.deepEqual(first.contract.assertions.find((entry) => entry.id === 'workspace-file-feature-txt-digest'), {
      id: 'workspace-file-feature-txt-digest',
      target: 'workspace',
      selector: { kind: 'file_digest', path: 'feature.txt' },
      operator: 'equals',
      expected: '1'.repeat(64),
      evaluation: 'exact',
    });
    assert.equal(first.contract.assertions.some((entry) => entry.evaluation === 'subset'), false);
    assert.match(first.source, /^# Drafted deterministically from one approved run\./);
    assert.doesNotMatch(first.source, /created_at|timestamp|run_0001/i);
    assert.doesNotMatch(first.source, /api-token|session\.tmp|<private-path>|<redacted>/i);
    assert.equal(readFileSync(first.path, 'utf8'), first.source);
    assert.equal(readFileSync(second.path, 'utf8'), second.source);
    assert.deepEqual(loadContractConfig(first.path).value, first.contract);
    assert.match(first.path.replaceAll('\\', '/'), /oculory\.contracts\/create-feature-branch\.yaml$/);

    await assert.rejects(
      approveRun(runId, { store, cwd: firstCwd, yes: true }),
      /contract already exists.*--force/,
    );
    const forced = await approveRun(runId, { store, cwd: firstCwd, yes: true, force: true });
    assert.equal(forced.source, first.source);
    assert.deepEqual(loadContractConfig(forced.path).value, forced.contract);

    const implementation = readFileSync(join(process.cwd(), 'src', 'mlp', 'approve.ts'), 'utf8');
    assert.doesNotMatch(implementation, /from ['"].*(?:miner|statistical)/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approve pins exact Postgres rows so same-count substitutions cannot satisfy a draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-approve-postgres-'));
  const store = new PublicRunStore(join(root, 'evidence', 'runs'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  initRepository(cwd);
  try {
    const runId = store.allocateRunId();
    const before = {
      schema: 'public',
      tables: {
        items: {
          exists: true,
          columns: [
            { name: 'id', dataType: 'integer', nullable: false, ordinal: 1 },
            { name: 'name', dataType: 'text', nullable: false, ordinal: 2 },
          ],
          rows: [{ id: 1, name: 'alpha' }, { id: 2, name: 'remove-me' }],
        },
      },
    };
    const after = structuredClone(before);
    after.tables.items.rows = [{ id: 1, name: 'changed' }, { id: 3, name: 'replacement' }];
    store.writeJson(runId, 'summary.json', summary(runId, 'behaviorally-passed', 'database-update'));
    store.writeJson(runId, 'target-index.json', [{ id: 'database', adapter: 'postgres' }]);
    store.writeJson(runId, 'snapshots/database-before.json', before);
    store.writeJson(runId, 'snapshots/database-after.json', after);
    store.writeJson(runId, 'diffs/database.json', {
      changed: true,
      changedTables: ['items'],
      missingTables: [],
      rowCountChanges: {},
    });
    store.finalize(runId);

    const draft = await approveRun(runId, { store, cwd, yes: true });
    const rows = draft.contract.assertions.find((entry) => entry.id === 'database-table-items-rows');
    assert.deepEqual(rows, {
      id: 'database-table-items-rows',
      target: 'database',
      selector: { kind: 'rows', table: 'items' },
      operator: 'equals',
      expected: after.tables.items.rows,
      evaluation: 'exact',
    });
    assert.equal(draft.contract.assertions.find((entry) => entry.id === 'database-table-items-row-count')?.expected, 2);
    assert.equal(draft.contract.assertions.some((entry) => entry.evaluation === 'subset'), false);
    assert.deepEqual(loadContractConfig(draft.path).value, draft.contract);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approve omits secret-shaped GitHub labels from a drafted contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-approve-github-labels-'));
  const store = new PublicRunStore(join(root, 'evidence', 'runs'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  initRepository(cwd);
  try {
    const runId = store.allocateRunId();
    const before = {
      issues: { '7': { exists: true, fields: { title: 'Before' }, labels: ['triage'], comments: { count: 0, entries: [] } } },
      pullRequests: {},
      branches: {},
    };
    const after = {
      issues: { '7': { exists: true, fields: { title: 'After' }, labels: ['github_pat_synthetic123'], comments: { count: 0, entries: [] } } },
      pullRequests: {},
      branches: {},
    };
    store.writeJson(runId, 'summary.json', summary(runId, 'behaviorally-passed', 'github-update'));
    store.writeJson(runId, 'target-index.json', [{ id: 'github', adapter: 'github-api' }]);
    store.writeJson(runId, 'snapshots/github-before.json', before);
    store.writeJson(runId, 'snapshots/github-after.json', after);
    store.writeJson(runId, 'diffs/github.json', {
      changed: true,
      changedIssues: [7],
      changedPullRequests: [],
      changedBranches: [],
    });
    store.finalize(runId);

    const draft = await approveRun(runId, { store, cwd, yes: true });
    assert.equal(draft.contract.assertions.some((entry) => String(entry.selector.kind).includes('labels')), false);
    assert.equal(draft.source.includes('github_pat_synthetic123'), false);
    assert.equal(draft.contract.assertions.find((entry) => entry.id === 'github-issue-7-title')?.expected, 'After');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approve refuses non-interactive writes and Git-ignored contract locations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-approve-location-'));
  const store = new PublicRunStore(join(root, 'evidence', 'runs'));
  const nonInteractive = join(root, 'non-interactive');
  const ignored = join(root, 'ignored');
  const symlinked = join(root, 'symlinked');
  const external = join(root, 'external-contracts');
  mkdirSync(nonInteractive);
  mkdirSync(ignored);
  mkdirSync(symlinked);
  mkdirSync(external);
  initRepository(nonInteractive);
  initRepository(ignored);
  initRepository(symlinked);
  writeFileSync(join(ignored, '.gitignore'), 'oculory.contracts/\n', 'utf8');
  symlinkSync(external, join(symlinked, 'oculory.contracts'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const runId = seedApprovedGitRun(store);
    const nonTty = spawnSync(process.execPath, [
      '--experimental-sqlite', '--no-warnings', join(process.cwd(), 'dist', 'src', 'cli', 'main.js'),
      'approve', runId, '--store', join(root, 'evidence'),
    ], {
      cwd: nonInteractive,
      env: { PATH: process.env.PATH, LC_ALL: 'C', LANG: 'C' },
      encoding: 'utf8',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(nonTty.status, 1);
    assert.match(nonTty.stderr, /interactive terminal or --yes/);
    await assert.rejects(
      approveRun(runId, { store, cwd: ignored, yes: true }),
      /contract location is ignored by Git/,
    );
    await assert.rejects(
      approveRun(runId, { store, cwd: symlinked, yes: true }),
      /contract directory must be a real directory inside the Git worktree/,
    );
    assert.equal(existsSync(join(external, 'create-feature-branch.yaml')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('violation renderer has a deterministic plain-text golden and exact accounting summary', () => {
  const rendered = renderViolation(violationModel, { color: false, width: 80 });
  assert.equal(rendered, violationGolden);
  assert.equal(renderViolation(structuredClone(violationModel), { color: false, width: 80 }), rendered);
  assert.doesNotMatch(rendered, /\u001b\[/);

  assert.equal(renderReplaySummary({
    requested: 12,
    completed: 12,
    passed: 3,
    failed: 9,
    infrastructure_failed: 0,
    indeterminate: 0,
    threshold: 10,
    status: 'FAIL',
  }), `Replay FAIL
  Requested runs:        12
  Completed runs:        12
  Behaviorally passed:   3
  Behaviorally failed:   9
  Infrastructure-failed: 0
  Indeterminate:         0
  Required threshold:    10
`);
});

test('violation renderer bounds human detail while retaining the complete failure model', () => {
  const failures = Array.from({ length: 9 }, (_, index) => ({
    selector: { kind: 'custom', index },
    result: {
      assertionId: `failure-${index + 1}`,
      passed: false,
      ignored: false,
      operator: 'equals' as const,
      evaluationMode: 'exact' as const,
      expected: 'expected',
      observed: `observed-${index + 1}`,
      detail: `failure detail ${index + 1}`,
    },
    description: `observed failure ${index + 1}`,
  }));
  const model: ViolationRenderModel = { ...violationModel, failures };
  const rendered = renderViolation(model, { color: false, width: 80 });
  assert.match(rendered, /observed failure 1/);
  assert.match(rendered, /observed failure 4/);
  assert.doesNotMatch(rendered, /observed failure 5/);
  assert.match(rendered, /5 additional observed failures omitted; see JSON report/);
  assert.equal(model.failures.length, 9);
  assert.equal(model.failures[8]?.description, 'observed failure 9');
});

test('violation renderer wraps at 80 columns and honors NO_COLOR deterministically', () => {
  const longModel = structuredClone(violationModel);
  longModel.claim.text = 'A deliberately long local claim with enough ordinary words to exercise deterministic terminal wrapping without any provider output.';
  longModel.failures = [{
    selector: { kind: 'custom_state' },
    result: {
      assertionId: 'custom-state',
      passed: false,
      ignored: false,
      operator: 'equals',
      evaluationMode: 'exact',
      expected: 'expected',
      observed: 'observed',
      detail: 'mismatch',
    },
    description: 'The independently observed local state differed from the expected contract in a deliberately verbose but readable way.',
  }];
  const plain = renderViolation(longModel, { color: false, width: 80 });
  assert.ok(plain.split('\n').every((line) => line.length <= 80), plain);
  assert.equal(renderViolation(longModel, { color: false, width: 80 }), plain);

  const prior = process.env.NO_COLOR;
  try {
    process.env.NO_COLOR = '1';
    const noColor = renderViolation(longModel, { color: true, width: 80 });
    assert.equal(noColor, plain);
    assert.doesNotMatch(noColor, /\u001b\[/);
  } finally {
    if (prior === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prior;
  }
});

test('show reconstructs a saved violation and diff from checksum-verified run evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-show-'));
  const store = new PublicRunStore(join(root, '.oculory', 'runs'));
  try {
    const runId = seedViolatedRun(store);
    const reconstructed = showRun(runId, { store, diff: true, color: false, width: 80 });
    assert.equal(reconstructed.output, violationGolden.replace('feature-branch-outcome', 'branch-base'));
    assert.deepEqual(reconstructed.view.diffs, {
      workspace: { changed: true, stagedFiles: ['config/demo.txt', 'feature.txt'] },
    });
    assert.equal(reconstructed.view.assertions?.length, 2);
    assert.deepEqual(reconstructed.view.replay?.profiles, violationModel.profiles);

    const json = showRun(runId, { store, json: true });
    assert.deepEqual(JSON.parse(json.output), json.view);
    assert.doesNotMatch(json.output, /\u001b\[/);

    const summary = showRun(runId, { store });
    assert.match(summary.output, /^run_0025  behaviorally-violated$/m);
    assert.match(summary.output, /Agent claim:\s+"Created branch and committed changes ✓"/);
    assert.match(summary.output, /Observed state: available/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedApprovedGitRun(store: PublicRunStore): string {
  const runId = store.allocateRunId();
  const develop = 'd'.repeat(40);
  const main = 'a'.repeat(40);
  const feature = 'f'.repeat(40);
  const before = {
    mode: 'git',
    baseRefs: ['develop', 'main'],
    currentBranch: 'develop',
    head: develop,
    refs: { HEAD: develop, develop, main },
    commits: { [develop]: [main], [main]: [] },
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    clean: true,
    files: [
      { path: 'obsolete.txt', kind: 'file', byteLength: 9, sha256: '0'.repeat(64), symlinkTarget: null },
    ],
  };
  const after = {
    ...before,
    currentBranch: 'feature/demo',
    head: feature,
    refs: { HEAD: feature, develop, 'feature/demo': feature, main },
    commits: { [develop]: [main], [feature]: [develop], [main]: [] },
    files: [
      { path: 'feature.txt', kind: 'file', byteLength: 8, sha256: '1'.repeat(64), symlinkTarget: null },
      { path: 'api-token.txt', kind: 'file', byteLength: 8, sha256: '2'.repeat(64), symlinkTarget: null },
      { path: 'tmp/session.tmp', kind: 'file', byteLength: 8, sha256: '3'.repeat(64), symlinkTarget: null },
      { path: 'notes/created_at.txt', kind: 'file', byteLength: 8, sha256: '4'.repeat(64), symlinkTarget: null },
    ],
  };
  store.writeJson(runId, 'summary.json', summary(runId, 'behaviorally-passed'));
  store.writeJson(runId, 'target-index.json', [{ id: 'workspace', adapter: 'git-filesystem' }]);
  store.writeJson(runId, 'snapshots/workspace-before.json', before);
  store.writeJson(runId, 'snapshots/workspace-after.json', after);
  store.writeJson(runId, 'diffs/workspace.json', {
    changed: true,
    currentBranchChanged: true,
    headChanged: true,
    addedBranches: ['feature/demo'],
    removedBranches: [],
    changedBranches: [],
    addedPaths: ['api-token.txt', 'feature.txt', 'notes/created_at.txt', 'tmp/session.tmp'],
    removedPaths: ['obsolete.txt'],
    changedPaths: [],
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
  });
  store.finalize(runId);
  return runId;
}

function initRepository(directory: string): void {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: directory,
    env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

function seedViolatedRun(store: PublicRunStore): string {
  let runId = '';
  for (let index = 1; index <= 25; index += 1) {
    runId = store.allocateRunId();
  }
  assert.equal(runId, 'run_0025');
  const evaluations: ReplayAssertionEvaluation[] = violationModel.failures.map((failure, index) => ({
    assertion: {
      id: index === 0 ? 'branch-base' : 'no-staged-files',
      target: 'workspace',
      selector: failure.selector,
      operator: failure.result.operator,
      expected: failure.result.expected,
      evaluation: failure.result.evaluationMode,
    },
    result: failure.result,
    description: failure.description,
    error: null,
  }));
  store.writeJson(runId, 'summary.json', summary(runId, 'behaviorally-violated'));
  store.writeJson(runId, 'diffs/workspace.json', {
    changed: true,
    stagedFiles: ['config/demo.txt', 'feature.txt'],
  });
  store.writeJson(runId, 'assertion-matrix.json', evaluations);
  store.writeJson(runId, 'replay-context.json', {
    totals: {
      requested: 12,
      completed: 12,
      behaviorally_passed: 3,
      behaviorally_failed: 9,
      infrastructure_failed: 0,
      indeterminate: 0,
      required_threshold: 10,
    },
    status: 'FAIL',
    profiles: violationModel.profiles,
  });
  store.finalize(runId);
  return runId;
}

function summary(
  runId: string,
  classification: PublicRunSummary['classification'],
  taskId = 'create-feature-branch',
): PublicRunSummary {
  return {
    schema_version: 'oculory-public-run-v1',
    run_id: runId,
    task_id: taskId,
    profile: 'changed',
    classification,
    agent_claim: violationModel.claim,
    tool_result: violationModel.tool,
    observed_state: { status: 'available', changed_targets: ['workspace'] },
    process: {
      exit_code: 0,
      timed_out: false,
      cancelled: false,
      output_limit_exceeded: false,
    },
    cleanup: {
      passed: true,
      process_group_absent: true,
      proxy: true,
      adapters: { workspace: true },
      workspace: true,
    },
    infrastructure_error: null,
  };
}
