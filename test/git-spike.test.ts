import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  assertExactFixtureRepositoryPath,
  buildGitSpikeChildEnvironment,
  type GitSpikeRuntimeInspection,
} from '../src/targets/git-spike/config.js';
import {
  applyFixtureEdit,
  cleanupGitSpikeFixture,
  createGitSpikeFixture,
  runFixtureGit,
  stageFixturePath,
  type GitSpikeFixture,
  type GitSpikeProcessCleanupEvidence,
} from '../src/targets/git-spike/fixture.js';
import {
  classifyStateDiff,
  trialHasUnexpectedIntermediateChange,
} from '../src/targets/git-spike/direct-harness.js';
import {
  captureGitSpikeSnapshot,
  changedIndexPaths,
  changedRefNames,
  diffGitSpikeSnapshots,
  snapshotIndexMatchesCommit,
  snapshotWorktreeMatchesCommit,
  type GitSpikeSnapshotDiff,
} from '../src/targets/git-spike/snapshot.js';

const GIT = findExecutable('git');
const CLEAN_PROCESS: GitSpikeProcessCleanupEvidence = {
  closeObserved: true,
  allRequestsSettled: true,
  childAlive: false,
  managedProcessGroupAlive: false,
  emergencyCleanupUsed: false,
};

test('Git spike fixture: two materializations have identical semantic state and commit IDs', () => {
  withBase((base) => {
    const first = fixture(base, 'determinism-one');
    const firstSnapshot = captureGitSpikeSnapshot(first);
    const firstCleanup = cleanupGitSpikeFixture(first, CLEAN_PROCESS);
    const second = fixture(base, 'determinism-two');
    const secondSnapshot = captureGitSpikeSnapshot(second);
    const secondCleanup = cleanupGitSpikeFixture(second, CLEAN_PROCESS);

    assert.equal(firstSnapshot.stateHash, secondSnapshot.stateHash);
    assert.equal(first.mainHead, second.mainHead);
    assert.equal(first.featureSeedHead, second.featureSeedHead);
    assert.equal(first.siblingHead, second.siblingHead);
    assert.equal(firstSnapshot.symbolicBranch, 'main');
    assert.equal(firstSnapshot.clean, true);
    assert.equal(firstSnapshot.indexMatchesHead, true);
    assert.equal(firstSnapshot.commits.length, 2);
    assert.match(first.mainHead, /^[a-f0-9]{40}$/);
    assert.equal(firstCleanup.passed, true);
    assert.equal(secondCleanup.passed, true);
  });
});

test('Git spike fixture: isolation config, hooks, remotes, signing, and environment allowlist are explicit', () => {
  withFixture('isolation', (value) => {
    const snapshot = captureGitSpikeSnapshot(value);
    const config = new Map(snapshot.config.map((entry) => [entry.key, entry.value]));
    assert.equal(config.get('commit.gpgsign'), 'false');
    assert.equal(config.get('tag.gpgsign'), 'false');
    assert.equal(config.get('core.autocrlf'), 'false');
    assert.equal(config.get('core.fsmonitor'), 'false');
    assert.equal(config.get('core.filemode'), 'false');
    assert.equal(config.get('core.hookspath'), '<TRIAL_ROOT>/runtime/hooks');
    assert.deepEqual(snapshot.remotes, []);
    assert.deepEqual(snapshot.hooks, []);
    assert.deepEqual(snapshot.submodules, []);
    assert.equal(snapshot.alternates, null);

    const runtime = fakeRuntime(value);
    const env = buildGitSpikeChildEnvironment(runtime, value.environmentPaths);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.HTTP_PROXY, undefined);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.ok(env.HOME?.startsWith(value.trialRoot));
    assert.ok(env.GIT_CONFIG_GLOBAL?.startsWith(value.trialRoot));
    assert.ok(env.GIT_ASKPASS?.startsWith(value.trialRoot));
  });
});

test('Git spike snapshot: worktree, index, object, ref, reflog, and lockfile changes are distinct', () => {
  withFixture('layers', (value) => {
    const clean = captureGitSpikeSnapshot(value);
    applyFixtureEdit(value, 'README.md', '# Changed only in the worktree\n');
    const edited = captureGitSpikeSnapshot(value);
    assert.deepEqual(diffGitSpikeSnapshots(clean, edited).changedLayers, ['worktree', 'status']);

    stageFixturePath(value, 'README.md');
    const staged = captureGitSpikeSnapshot(value);
    assert.deepEqual(diffGitSpikeSnapshots(edited, staged).changedLayers, ['status', 'index', 'objects']);
    assert.deepEqual(changedIndexPaths(edited, staged), ['README.md']);

    runFixtureGit(value, ['branch', 'test/probe']);
    const branched = captureGitSpikeSnapshot(value);
    assert.deepEqual(diffGitSpikeSnapshots(staged, branched).changedLayers, ['head_and_refs', 'reflogs']);
    assert.deepEqual(changedRefNames(staged, branched), ['refs/heads/test/probe']);

    writeFileSync(join(value.gitDirectory, 'oculory-test.lock'), 'lock evidence\n', 'utf8');
    const locked = captureGitSpikeSnapshot(value);
    assert.deepEqual(locked.lockfiles, ['oculory-test.lock']);
    assert.deepEqual(diffGitSpikeSnapshots(branched, locked).changedLayers, ['lockfiles']);
    rmSync(join(value.gitDirectory, 'oculory-test.lock'));
  });
});

test('Git spike snapshot: index and worktree can be checked independently against a commit tree', () => {
  withFixture('commit-match', (value) => {
    let snapshot = captureGitSpikeSnapshot(value);
    assert.equal(snapshotIndexMatchesCommit(snapshot, value.mainHead), true);
    assert.equal(snapshotWorktreeMatchesCommit(snapshot, value.mainHead), true);
    applyFixtureEdit(value, 'notes/plan.txt', 'Unstaged plan change\n');
    snapshot = captureGitSpikeSnapshot(value);
    assert.equal(snapshotIndexMatchesCommit(snapshot, value.mainHead), true);
    assert.equal(snapshotWorktreeMatchesCommit(snapshot, value.mainHead), false);
  });
});

test('Git spike boundary: exact root accepts aliases to the root and rejects descendants or sibling repositories', () => {
  withFixture('exact-boundary', (value) => {
    assert.equal(
      assertExactFixtureRepositoryPath(value.repositoryRoot, value.repositoryRoot),
      resolve(value.repositoryRoot),
    );
    const alias = join(value.trialRoot, 'repository-alias');
    symlinkSync(value.repositoryRoot, alias, 'dir');
    assert.equal(
      assertExactFixtureRepositoryPath(alias, value.repositoryRoot),
      resolve(value.repositoryRoot),
    );
    assert.throws(
      () => assertExactFixtureRepositoryPath(join(value.repositoryRoot, 'src'), value.repositoryRoot),
      /exactly to the fixture root/,
    );
    assert.throws(
      () => assertExactFixtureRepositoryPath(value.siblingRepositoryRoot, value.repositoryRoot),
      /exactly to the fixture root/,
    );
  });
});

test('Git spike boundary: sibling sentinel changes are independently detected and fail cleanup proof', () => {
  withBase((base) => {
    const value = fixture(base, 'sentinel-change');
    const before = captureGitSpikeSnapshot(value);
    writeFileSync(value.sentinelPath, 'tampered sentinel\n', 'utf8');
    const after = captureGitSpikeSnapshot(value);
    const diff = diffGitSpikeSnapshots(before, after);
    assert.ok(diff.changedLayers.includes('sibling_boundary'));
    assert.equal(diff.sentinelMetadataChanged, true);
    const cleanup = cleanupGitSpikeFixture(value, CLEAN_PROCESS);
    assert.equal(cleanup.sentinelUnchangedBeforeRepositoryRemoval, false);
    assert.equal(cleanup.passed, false);
  });
});

test('Git spike cleanup: removes only the registered temporary trial and proves parent absence', () => {
  withBase((base) => {
    const value = fixture(base, 'cleanup-proof');
    const root = value.trialRoot;
    const cleanup = cleanupGitSpikeFixture(value, CLEAN_PROCESS);
    assert.equal(cleanup.passed, true);
    assert.equal(cleanup.repositoryRemoved, true);
    assert.equal(cleanup.fixturePathAbsent, true);
    assert.equal(cleanup.trialRootRemoved, true);
    assert.equal(cleanup.parentContainsTrialName, false);
    assert.equal(existsSync(root), false);
  });
});

test('Git spike cleanup: live-process evidence is fail-closed even when filesystem cleanup succeeds', () => {
  withBase((base) => {
    const value = fixture(base, 'cleanup-live-child');
    const cleanup = cleanupGitSpikeFixture(value, {
      ...CLEAN_PROCESS,
      childAlive: true,
    });
    assert.equal(cleanup.repositoryRemoved, true);
    assert.equal(cleanup.trialRootRemoved, true);
    assert.equal(cleanup.passed, false);
  });
});

test('Git spike direct classification: unchanged rejections and exact changed-state successes remain distinct', () => {
  withFixture('classification', (value) => {
    const before = captureGitSpikeSnapshot(value);
    const unchanged = captureGitSpikeSnapshot(value);
    const unchangedDiff = diffGitSpikeSnapshots(before, unchanged);
    assert.equal(classifyStateDiff(unchangedDiff, 'unchanged'), 'unchanged');

    applyFixtureEdit(value, 'README.md', '# Direct-classification change\n');
    const changed = captureGitSpikeSnapshot(value);
    const changedDiff = diffGitSpikeSnapshots(before, changed);
    assert.equal(classifyStateDiff(changedDiff, ['worktree', 'status']), 'expected_delta');
    assert.equal(classifyStateDiff(changedDiff, 'unchanged'), 'unexpected_delta');
    assert.equal(classifyStateDiff(changedDiff, ['index']), 'unexpected_delta');
  });
});

test('Git spike direct classification: an unexpected intermediate mutation fails closed', () => {
  const unchanged = fakeDiff([]);
  const changed = fakeDiff(['index']);
  const execution = {
    calls: [
      { stateDiff: unchanged },
      { stateDiff: changed },
    ],
  } as Parameters<typeof trialHasUnexpectedIntermediateChange>[0];
  assert.equal(
    trialHasUnexpectedIntermediateChange(execution, ['unchanged', 'unchanged']),
    true,
  );
  assert.equal(
    trialHasUnexpectedIntermediateChange(execution, ['unchanged', ['index']]),
    false,
  );
});

function withFixture(name: string, body: (value: GitSpikeFixture) => void): void {
  withBase((base) => {
    const value = fixture(base, name);
    let bodyError: unknown = null;
    try {
      body(value);
    } catch (error) {
      bodyError = error;
    }
    if (existsSync(value.trialRoot)) {
      try {
        cleanupGitSpikeFixture(value, CLEAN_PROCESS);
      } catch (cleanupError) {
        if (bodyError === null) bodyError = cleanupError;
        else bodyError = new AggregateError([bodyError, cleanupError], 'test body and fixture cleanup failed');
      }
    }
    if (bodyError !== null) throw bodyError;
  });
}

function withBase(body: (base: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'oculory-git-spike-test-'));
  try {
    body(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function fixture(base: string, name: string): GitSpikeFixture {
  return createGitSpikeFixture({
    baseDirectory: base,
    trialId: `${name}-001`,
    gitExecutable: GIT,
  });
}

function fakeRuntime(value: GitSpikeFixture): GitSpikeRuntimeInspection {
  return {
    pythonExecutable: process.execPath,
    pythonBaseExecutable: process.execPath,
    pythonVersion: process.versions.node,
    targetExecutable: process.execPath,
    targetModulePath: process.execPath,
    targetServerPath: process.execPath,
    targetServerSha256: '0'.repeat(64),
    packageName: 'mcp-server-git',
    packageVersion: '2026.7.10',
    consoleEntryPoint: 'mcp_server_git:main',
    distributions: {},
    gitExecutable: value.gitExecutable,
    gitVersion: 'test',
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    lockSha256: '0'.repeat(64),
  };
}

function fakeDiff(changedLayers: GitSpikeSnapshotDiff['changedLayers']): GitSpikeSnapshotDiff {
  return {
    beforeStateHash: 'a',
    afterStateHash: changedLayers.length === 0 ? 'a' : 'b',
    changedLayers,
    layerChanges: {},
    sentinelMetadataChanged: false,
    reflogRawEvidenceChanged: false,
  };
}

function findExecutable(name: string): string {
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
    : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return resolve(candidate);
    }
  }
  throw new Error(`${name} was not found on PATH`);
}
