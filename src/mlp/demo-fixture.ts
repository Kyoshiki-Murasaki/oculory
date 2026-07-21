import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

export function prepareDemoFixture(workspaceInput: string): void {
  const workspace = assertDemoWorkspace(workspaceInput);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  if (!existsSync(resolve(workspace, '.git'))) {
    git(workspace, ['init', '--quiet', '--initial-branch=main']);
    writeFileSync(resolve(workspace, 'README.md'), 'Oculory demo fixture\n', 'utf8');
    git(workspace, ['add', '--', 'README.md']);
    commit(workspace, 'Initial fixture');
    git(workspace, ['checkout', '--quiet', '-b', 'develop']);
    writeFileSync(resolve(workspace, 'develop.txt'), 'develop baseline\n', 'utf8');
    git(workspace, ['add', '--', 'develop.txt']);
    commit(workspace, 'Develop baseline');
    git(workspace, ['checkout', '--quiet', 'main']);
    writeFileSync(resolve(workspace, 'main.txt'), 'main-only change\n', 'utf8');
    git(workspace, ['add', '--', 'main.txt']);
    commit(workspace, 'Main change');
  }
  resetDemoFixture(workspace);
}

export function resetDemoFixture(workspaceInput: string): void {
  const workspace = assertDemoWorkspace(workspaceInput);
  git(workspace, ['checkout', '--quiet', '--detach', 'develop']);
  if (branchExists(workspace, 'feature/demo')) git(workspace, ['branch', '-D', 'feature/demo']);
  git(workspace, ['reset', '--hard', 'develop']);
  git(workspace, ['clean', '-fdx']);
  const status = git(workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.length !== 0) throw new Error('demo fixture reset could not be verified');
}

export function demoFixtureCli(argv: readonly string[]): void {
  const mode = argv[0] ?? 'prepare';
  const workspace = argv[1];
  if (workspace === undefined || !['prepare', 'reset', 'cleanup'].includes(mode)) {
    throw new Error('usage: oculory-demo-fixture prepare|reset|cleanup <workspace>');
  }
  if (mode === 'prepare') prepareDemoFixture(workspace);
  else if (mode === 'reset') resetDemoFixture(workspace);
  else assertDemoWorkspace(workspace);
}

function commit(workspace: string, message: string): void {
  git(workspace, ['-c', 'user.name=Oculory Demo', '-c', 'user.email=demo@oculory.invalid', 'commit', '--quiet', '-m', message]);
}

function branchExists(workspace: string, branch: string): boolean {
  try {
    git(workspace, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export function git(workspace: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: workspace,
    env: safeEnvironment(),
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function assertDemoWorkspace(input: string): string {
  const workspace = resolve(input);
  const root = resolve(tmpdir());
  const rel = relative(root, workspace);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !rel.split(sep).some((part) => part.startsWith('oculory-'))) {
    throw new Error('demo fixture requires an Oculory temporary workspace');
  }
  return workspace;
}

function safeEnvironment(): Record<string, string> {
  const env: Record<string, string> = {
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT']) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  return env;
}
