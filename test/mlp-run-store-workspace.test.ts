import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PublicRunStore } from '../src/mlp/run-store.js';
import { materializeWorkspace } from '../src/mlp/workspace.js';

test('public run storage is sequential, append-only, checksum-verified, and path-contained', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-run-store-'));
  const store = new PublicRunStore(join(root, '.oculory', 'runs'));
  try {
    mkdirSync(store.root, { recursive: true });
    const heldLock = join(store.root, '.sequence.lock');
    writeFileSync(heldLock, 'held by another allocator\n', 'utf8');
    assert.throws(() => store.allocateRunId(), /EEXIST/);
    assert.equal(readFileSync(heldLock, 'utf8'), 'held by another allocator\n');
    unlinkSync(heldLock);

    const first = store.allocateRunId();
    const second = store.allocateRunId();
    assert.equal(first, 'run_0001');
    assert.equal(second, 'run_0002');

    store.writeJson(first, 'summary.json', { state: 'draft', nested: { b: 2, a: 1 } });
    store.writeText(first, 'evidence/output.txt', 'bounded local evidence\n');
    assert.throws(
      () => store.writeJson(first, 'summary.json', { state: 'overwritten' }),
      /refusing to overwrite public run evidence/,
    );
    assert.throws(() => store.writeText(first, '../escaped.txt', 'no'), /unsafe public run path/);
    assert.throws(() => store.writeText(first, '/tmp/escaped.txt', 'no'), /unsafe public run path/);
    assert.throws(() => store.runPath('run_../../outside'), /invalid public run ID/);

    store.replaceJsonBeforeFinalize(first, 'summary.json', { state: 'complete', nested: { a: 1, b: 2 } });
    assert.deepEqual(store.readJson(first, 'summary.json'), { nested: { a: 1, b: 2 }, state: 'complete' });
    const checksumPath = store.finalize(first);
    const checksumSource = readFileSync(checksumPath, 'utf8');
    assert.match(checksumSource, /^[a-f0-9]{64}  evidence\/output\.txt\n[a-f0-9]{64}  summary\.json\n$/);
    assert.doesNotThrow(() => store.verify(first));
    assert.throws(
      () => store.replaceJsonBeforeFinalize(first, 'summary.json', { state: 'late' }),
      /finalized and append-only/,
    );
    assert.throws(() => store.writeText(first, 'late.txt', 'late'), /finalized and append-only/);
    assert.throws(() => store.finalize(first), /refusing to overwrite public run evidence/);

    const extra = join(store.runPath(first), 'late.txt');
    writeFileSync(extra, 'late\n', 'utf8');
    assert.throws(() => store.verify(first), /evidence outside its finalized checksum manifest/);
    unlinkSync(extra);

    writeFileSync(join(store.runPath(first), 'summary.json'), '{"state":"tampered"}\n', 'utf8');
    assert.throws(() => store.verify(first), /run evidence checksum mismatch: summary\.json/);

    const taskPath = join(root, 'task.yaml');
    writeFileSync(taskPath, 'version: local\n', 'utf8');
    const registered = store.registerTask('local-task', taskPath, 'version: local\n');
    assert.equal(store.registerTask('local-task', taskPath, 'version: local\n'), registered);
    const registration = readFileSync(join(store.taskRoot, 'local-task.json'), 'utf8');
    assert.deepEqual(JSON.parse(registration), {
      path: 'task.yaml',
      schema_version: 'oculory-task-registration-v1',
      task_id: 'local-task',
    });
    assert.equal(registration.includes(root), false);
    writeFileSync(taskPath, 'version: changed\n', 'utf8');
    assert.equal(store.registerTask('local-task', taskPath, 'version: changed\n'), registered);
    assert.equal(readFileSync(store.registeredTaskPath('local-task'), 'utf8'), 'version: changed\n');
    const otherTaskPath = join(root, 'other-task.yaml');
    writeFileSync(otherTaskPath, 'version: other\n', 'utf8');
    assert.throws(() => store.registerTask('local-task', otherTaskPath), /different local task path/);
    assert.throws(() => store.registerTask('../outside', taskPath), /invalid task ID/);
    assert.throws(() => store.registeredTaskPath('missing'), /no registered local task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('public writable paths refuse protected evidence, operations workspaces, and symlink aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-path-policy-'));
  try {
    assert.throws(
      () => new PublicRunStore(join(root, '.oculory', 'runs-live', 'public')),
      /must not target protected evidence/,
    );
    assert.throws(
      () => new PublicRunStore(join(root, 'oculory-pilot-operations', 'public')),
      /must not target an operations workspace/,
    );
    const protectedTarget = join(root, 'target', '.oculory', 'runs-model');
    mkdirSync(protectedTarget, { recursive: true });
    const alias = join(root, 'alias');
    symlinkSync(protectedTarget, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => new PublicRunStore(join(alias, 'public')), /must not target protected evidence/);

    const project = join(root, 'project');
    mkdirSync(project);
    const store = new PublicRunStore(join(project, '.oculory', 'runs'));
    const externalTask = join(root, 'external-task.yaml');
    writeFileSync(externalTask, 'version: external\n', 'utf8');
    assert.throws(() => store.registerTask('external-task', externalTask), /must stay inside the public project root/);
    assert.throws(() => store.resolveTaskPath(externalTask), /must stay inside the public project root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('public run inspection rejects oversized artifacts and checksum manifests before reading evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-run-store-bounds-'));
  const store = new PublicRunStore(join(root, '.oculory', 'runs'));
  try {
    const oversized = store.allocateRunId();
    const oversizedPath = join(store.runPath(oversized), 'oversized.json');
    writeFileSync(oversizedPath, '{}\n', 'utf8');
    truncateSync(oversizedPath, 16 * 1024 * 1024 + 1);
    assert.throws(() => store.readJson(oversized, 'oversized.json'), /exceeds its byte inspection limit/);
    assert.throws(() => store.finalize(oversized), /per-file byte inspection limit/);

    const excessiveManifest = store.allocateRunId();
    const lines = Array.from({ length: 8_193 }, (_, index) =>
      `${'0'.repeat(64)}  evidence/file-${String(index).padStart(4, '0')}.json`,
    );
    writeFileSync(join(store.runPath(excessiveManifest), 'checksums.sha256'), `${lines.join('\n')}\n`, 'utf8');
    assert.throws(() => store.verify(excessiveManifest), /file-count inspection limit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git-worktree strategy isolates the requested source ref and never registers a worktree in the source repository', {
  skip: process.platform === 'win32',
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-worktree-source-ref-'));
  const repository = join(root, 'source repository');
  try {
    git(root, ['init', '--quiet', '--initial-branch=main', repository]);
    writeFileSync(join(repository, 'tracked.txt'), 'main baseline\n', 'utf8');
    git(repository, ['add', '--', 'tracked.txt']);
    commit(repository, 'main baseline');
    const mainCommit = git(repository, ['rev-parse', 'main']).trim();

    git(repository, ['checkout', '--quiet', '-b', 'feature/source-head']);
    writeFileSync(join(repository, 'feature.txt'), 'source-only feature\n', 'utf8');
    git(repository, ['add', '--', 'feature.txt']);
    commit(repository, 'source feature');
    const sourceHead = git(repository, ['rev-parse', 'HEAD']).trim();
    const sourceWorktrees = git(repository, ['worktree', 'list', '--porcelain']);

    const workspace = await materializeWorkspace({
      strategy: 'git-worktree',
      repository,
      base_ref: 'main',
    }, root, 'run_0001');
    try {
      assert.equal(git(workspace.root, ['rev-parse', 'HEAD']).trim(), mainCommit);
      assert.equal(gitAllowFailure(workspace.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).status, 1);
      assert.equal(git(workspace.root, ['remote']).trim(), '');
      assert.equal(existsSync(join(workspace.root, 'feature.txt')), false);
      assert.equal(git(repository, ['worktree', 'list', '--porcelain']), sourceWorktrees);

      writeFileSync(join(workspace.root, 'tracked.txt'), 'disposable mutation\n', 'utf8');
      writeFileSync(join(workspace.root, 'untracked.txt'), 'disposable untracked file\n', 'utf8');
      const reset = await workspace.reset();
      assert.deepEqual(reset, { passed: true, detail: 'fresh Git worktree reset independently verified' });
      assert.equal(readFileSync(join(workspace.root, 'tracked.txt'), 'utf8'), 'main baseline\n');
      assert.equal(existsSync(join(workspace.root, 'untracked.txt')), false);
      assert.equal(git(workspace.root, ['status', '--porcelain=v1', '--untracked-files=all']), '');
    } finally {
      const cleanup = await workspace.cleanup();
      assert.equal(cleanup.passed, true);
      assert.equal(cleanup.residue, false);
      assert.equal(existsSync(workspace.temporary_root), false);
    }

    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), sourceHead);
    assert.equal(git(repository, ['symbolic-ref', '--short', 'HEAD']).trim(), 'feature/source-head');
    assert.equal(readFileSync(join(repository, 'tracked.txt'), 'utf8'), 'main baseline\n');
    assert.equal(readFileSync(join(repository, 'feature.txt'), 'utf8'), 'source-only feature\n');
    assert.equal(git(repository, ['worktree', 'list', '--porcelain']), sourceWorktrees);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command workspace rejects setup/reset symlink swaps and skips unsafe cleanup commands', {
  skip: process.platform === 'win32',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-command-workspace-swap-'));
  const external = join(root, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'sentinel.txt'), 'outside remains\n', 'utf8');
  const initialize = [
    process.execPath,
    '-e',
    "require('node:fs').writeFileSync(require('node:path').join(process.argv[1], 'state.txt'), 'initial\\n')",
    '{workspace}',
  ] as [string, ...string[]];
  const replaceWithSymlink = [
    process.execPath,
    '-e',
    "const fs=require('node:fs');fs.rmSync(process.argv[1],{recursive:true,force:true});fs.symlinkSync(process.argv[2],process.argv[1],process.platform==='win32'?'junction':'dir')",
    '{workspace}',
    external,
  ] as [string, ...string[]];
  const unsafeCleanup = [
    process.execPath,
    '-e',
    "require('node:fs').writeFileSync(require('node:path').join(process.argv[1], 'cleanup-ran.txt'), 'unsafe\\n')",
    external,
  ] as [string, ...string[]];
  try {
    await assert.rejects(
      materializeWorkspace({
        strategy: 'command',
        setup: replaceWithSymlink,
        reset: initialize,
        cleanup: unsafeCleanup,
      }, root, 'run_0000'),
      /command workspace is no longer a real local directory/,
    );
    assert.equal(existsSync(join(external, 'cleanup-ran.txt')), false);
    assert.equal(readFileSync(join(external, 'sentinel.txt'), 'utf8'), 'outside remains\n');

    const workspace = await materializeWorkspace({
      strategy: 'command',
      setup: initialize,
      reset: replaceWithSymlink,
      cleanup: unsafeCleanup,
    }, root, 'run_0001');
    const reset = await workspace.reset();
    assert.equal(reset.passed, false);
    assert.match(reset.detail, /command workspace is no longer a real local directory/);

    const cleanup = await workspace.cleanup();
    assert.equal(cleanup.passed, false);
    assert.equal(cleanup.residue, false);
    assert.match(cleanup.detail, /command workspace is no longer a real local directory/);
    assert.equal(existsSync(join(external, 'cleanup-ran.txt')), false);
    assert.equal(readFileSync(join(external, 'sentinel.txt'), 'utf8'), 'outside remains\n');
    assert.equal(existsSync(workspace.temporary_root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function commit(repository: string, message: string): void {
  git(repository, [
    '-c', 'user.name=Oculory Test',
    '-c', 'user.email=test@oculory.invalid',
    'commit', '--quiet', '-m', message,
  ]);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnvironment(),
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitAllowFailure(cwd: string, args: readonly string[]): { status: number | null } {
  try {
    git(cwd, args);
    return { status: 0 };
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
      return { status: error.status };
    }
    throw error;
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}
