import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { OculoryTaskConfig } from './types.js';
import { assertPublicMlpExecutionSupported, runBoundedProcess } from './process.js';
import { sanitizeDiagnostic } from './redact.js';

export interface MaterializedWorkspace {
  root: string;
  temporary_root: string;
  reset(): Promise<{ passed: boolean; detail: string }>;
  cleanup(): Promise<{ passed: boolean; detail: string; residue: boolean }>;
}

export async function materializeWorkspace(
  strategy: OculoryTaskConfig['workspace'],
  taskDirectory: string,
  runId: string,
): Promise<MaterializedWorkspace> {
  assertPublicMlpExecutionSupported();
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'oculory-run-'));
  const canonicalTemporaryRoot = realpathSync(temporaryRoot);
  const workspace = join(temporaryRoot, 'workspace');
  try {
    if (strategy.strategy === 'git-worktree') {
      const configured = isAbsolute(strategy.repository)
        ? strategy.repository
        : resolve(taskDirectory, strategy.repository);
      const sourceRepository = realpathSync(configured);
      const top = git(['-C', sourceRepository, 'rev-parse', '--show-toplevel'], taskDirectory).trim();
      if (realpathSync(top) !== sourceRepository) throw new Error('git-worktree repository must name the repository root');
      const repository = join(temporaryRoot, 'repository.git');
      git(['clone', '--quiet', '--bare', '--no-hardlinks', '--', sourceRepository, repository], taskDirectory);
      git(['-C', repository, 'remote', 'remove', 'origin'], taskDirectory);
      const baseRef = strategy.base_ref ?? 'HEAD';
      const baseCommit = git(['-C', repository, 'rev-parse', '--verify', `${baseRef}^{commit}`], taskDirectory).trim();
      git(['-C', repository, 'worktree', 'add', '--detach', workspace, baseCommit], taskDirectory);
      await verifyGitReset(workspace, baseCommit);
      return {
        root: workspace,
        temporary_root: temporaryRoot,
        reset: async () => {
          try {
            git(['-C', workspace, 'reset', '--hard', baseCommit], taskDirectory);
            git(['-C', workspace, 'clean', '-fdx'], taskDirectory);
            await verifyGitReset(workspace, baseCommit);
            return { passed: true, detail: 'fresh Git worktree reset independently verified' };
          } catch (error) {
            return { passed: false, detail: sanitizeDiagnostic(errorMessage(error), [workspace, temporaryRoot, repository]) };
          }
        },
        cleanup: async () => {
          let detail = 'Git worktree removed';
          try {
            if (existsSync(workspace)) git(['-C', repository, 'worktree', 'remove', '--force', workspace], taskDirectory);
            git(['-C', repository, 'worktree', 'prune'], taskDirectory);
          } catch (error) {
            detail = sanitizeDiagnostic(errorMessage(error), [workspace, temporaryRoot, repository, sourceRepository]);
          }
          safeRemoveTemporary(temporaryRoot);
          const residue = existsSync(temporaryRoot) || existsSync(workspace);
          return { passed: !residue, detail: residue ? `${detail}; temporary residue remains` : detail, residue };
        },
      };
    }

    mkdirSync(workspace, { recursive: false, mode: 0o700 });
    await runWorkspaceCommand(strategy.setup, temporaryRoot, workspace, runId);
    assertCommandWorkspace(canonicalTemporaryRoot, workspace);
    return {
      root: workspace,
      temporary_root: temporaryRoot,
      reset: async () => {
        try {
          assertCommandWorkspace(canonicalTemporaryRoot, workspace);
          await runWorkspaceCommand(strategy.reset, temporaryRoot, workspace, runId);
          assertCommandWorkspace(canonicalTemporaryRoot, workspace);
          return { passed: true, detail: 'workspace reset command completed' };
        } catch (error) {
          return { passed: false, detail: sanitizeDiagnostic(errorMessage(error), [workspace, temporaryRoot]) };
        }
      },
      cleanup: async () => {
        let commandPassed = true;
        let detail = 'workspace cleanup command completed';
        try {
          assertCommandWorkspace(canonicalTemporaryRoot, workspace);
          await runWorkspaceCommand(strategy.cleanup, temporaryRoot, workspace, runId);
        } catch (error) {
          commandPassed = false;
          detail = sanitizeDiagnostic(errorMessage(error), [workspace, temporaryRoot]);
        }
        safeRemoveTemporary(temporaryRoot);
        const residue = existsSync(temporaryRoot);
        return { passed: commandPassed && !residue, detail, residue };
      },
    };
  } catch (error) {
    safeRemoveTemporary(temporaryRoot);
    throw error;
  }
}

function assertCommandWorkspace(canonicalTemporaryRoot: string, workspace: string): void {
  if (!existsSync(workspace) || !lstatSync(workspace).isDirectory()) {
    throw new Error('command workspace is no longer a real local directory');
  }
  const canonicalWorkspace = realpathSync(workspace);
  if (!inside(canonicalTemporaryRoot, canonicalWorkspace)) {
    throw new Error('command workspace escaped its temporary root');
  }
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    env: baseChildEnvironment(),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function verifyGitReset(workspace: string, expectedCommit: string): Promise<void> {
  const head = git(['-C', workspace, 'rev-parse', 'HEAD'], workspace).trim();
  const status = git(['-C', workspace, 'status', '--porcelain=v1', '--untracked-files=all'], workspace);
  if (head !== expectedCommit || status.length !== 0) throw new Error('Git workspace reset could not be independently verified');
}

async function runWorkspaceCommand(argv: readonly string[], cwd: string, workspace: string, runId: string): Promise<void> {
  if (argv.length === 0) throw new Error('workspace command argv must not be empty');
  const expanded = argv.map((part) => part.replaceAll('{workspace}', workspace).replaceAll('{run_id}', runId));
  const result = await runBoundedProcess({
    argv: expanded as [string, ...string[]],
    cwd,
    env: baseChildEnvironment(),
    timeoutMs: 60_000,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
    privateRoots: [workspace, cwd],
  });
  if (
    result.exit_code !== 0 || result.timed_out || result.cancelled ||
    result.output_limit_exceeded || !result.cleanup.process_group_absent
  ) {
    const detail = result.stderr.trim().length > 0 ? `: ${result.stderr.trim()}` : '';
    throw new Error(`workspace command failed${sanitizeDiagnostic(detail, [workspace, cwd])}`);
  }
}

export function baseChildEnvironment(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) output[name] = value;
  }
  output.LC_ALL = 'C';
  output.LANG = 'C';
  output.GIT_CONFIG_NOSYSTEM = '1';
  output.GIT_TERMINAL_PROMPT = '0';
  const guardPreload = process.env.OCULORY_INTERNAL_TEST_NETWORK_GUARD_PRELOAD;
  if (guardPreload !== undefined) {
    const configuredPreload = resolve(guardPreload);
    if (
      basename(configuredPreload) !== 'network-denial-preload.cjs' ||
      lstatSync(configuredPreload).isSymbolicLink() ||
      !lstatSync(realpathSync(configuredPreload)).isFile()
    ) {
      throw new Error('offline verification network guard is invalid');
    }
    const proofInput = process.env.OCULORY_NETWORK_GUARD_PROOF;
    if (proofInput === undefined) throw new Error('offline verification network guard proof is unavailable');
    const configuredProof = resolve(proofInput);
    if (
      basename(configuredProof) !== 'network-guard-proof.log' ||
      lstatSync(configuredProof).isSymbolicLink() ||
      !lstatSync(realpathSync(configuredProof)).isFile()
    ) {
      throw new Error('offline verification network guard proof is invalid');
    }
    output.NODE_OPTIONS = `--require=${JSON.stringify(realpathSync(configuredPreload))}`;
    output.OCULORY_NETWORK_GUARD_PROOF = realpathSync(configuredProof);
  }
  return output;
}

function safeRemoveTemporary(path: string): void {
  const parent = resolve(tmpdir());
  const target = resolve(path);
  const rel = relative(parent, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !rel.startsWith('oculory-run-')) {
    throw new Error('refusing to remove an unverified temporary path');
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 2 });
}

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
