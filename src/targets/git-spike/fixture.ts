import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256 } from '../../schema/canonical.js';
import type { JsonObject } from '../../schema/types.js';
import {
  assertNoForbiddenEnvironmentNames,
  digestBytes,
  type GitSpikeEnvironmentPaths,
} from './config.js';

const PRIMARY_FILES = Object.freeze({
  'README.md': '# Oculory Git spike\n\nDeterministic fixture.\n',
  'src/app.txt': 'mode=seed\nversion=1\n',
  'docs/guide.md': 'Guide version 1\n',
  'docs/rollback.md': 'Rollback procedure version 1\n',
  'notes/plan.txt': 'Plan version 1\n',
  'docs/release.md': 'Release notes version 1\n',
});

const SECOND_COMMIT_FILES = Object.freeze({
  'src/app.txt': 'mode=seed\nversion=2\n',
  'docs/guide.md': 'Guide version 2\n',
});

const SEED_RECIPE = Object.freeze({
  version: 'git-spike-seed-v1',
  objectFormat: 'sha1',
  defaultBranch: 'main',
  firstCommit: {
    message: 'Seed deterministic repository',
    date: '2024-01-01T00:00:00Z',
    files: PRIMARY_FILES,
  },
  featureBranch: { name: 'feature/seed', target: 'firstCommit' },
  secondCommit: {
    message: 'Advance deterministic repository',
    date: '2024-01-02T00:00:00Z',
    files: SECOND_COMMIT_FILES,
  },
  identity: { name: 'Oculory Fixture', email: 'fixture@oculory.invalid' },
  configuration: {
    'commit.gpgSign': 'false',
    'tag.gpgSign': 'false',
    'core.autocrlf': 'false',
    'core.fileMode': 'false',
    'core.fsmonitor': 'false',
    'core.logAllRefUpdates': 'true',
    'gc.auto': '0',
    'maintenance.auto': 'false',
  },
});

export const GIT_SPIKE_SEED_RECIPE_DIGEST = sha256(canonicalJson(SEED_RECIPE));
export const GIT_SPIKE_PRIMARY_PATHS = Object.freeze(Object.keys(PRIMARY_FILES));

export interface SentinelMetadata {
  byteLength: number;
  sha256: string;
  mode: string;
  mtimeNanoseconds: string;
}

export interface GitSpikeFixture {
  id: string;
  baseDirectory: string;
  trialRoot: string;
  repositoryRoot: string;
  siblingRepositoryRoot: string;
  sentinelPath: string;
  gitDirectory: string;
  siblingGitDirectory: string;
  emptyHooksDirectory: string;
  emptyTemplateDirectory: string;
  environmentPaths: GitSpikeEnvironmentPaths;
  gitExecutable: string;
  gitEnvironment: Readonly<Record<string, string>>;
  seedRecipeDigest: string;
  firstCommit: string;
  mainHead: string;
  featureSeedHead: string;
  siblingHead: string;
  sentinelInitial: SentinelMetadata;
}

export interface GitSpikeProcessCleanupEvidence {
  closeObserved: boolean;
  allRequestsSettled: boolean;
  childAlive: boolean;
  managedProcessGroupAlive: boolean | null;
  emergencyCleanupUsed: boolean;
}

export interface GitSpikeCleanupProof {
  process: GitSpikeProcessCleanupEvidence;
  noRemoteBeforeCleanup: boolean;
  sentinelUnchangedBeforeRepositoryRemoval: boolean;
  sentinelUnchangedAfterRepositoryRemoval: boolean;
  runtimePathsContained: boolean;
  repositoryRemoved: boolean;
  fixturePathAbsent: boolean;
  trialRootRemoved: boolean;
  parentContainsTrialName: boolean;
  steps: GitSpikeCleanupStep[];
  failures: GitSpikeCleanupFailure[];
  passed: boolean;
}

export interface GitSpikeCleanupStep {
  name: string;
  attempted: boolean;
  passed: boolean;
  detail: string | null;
}

export interface GitSpikeCleanupFailure {
  step: string;
  operation: string;
  message: string;
  timedOut: boolean;
  timeoutMs: number | null;
}

export const NATIVE_GIT_TIMEOUT_MS = 5_000;

export interface CreateGitSpikeFixtureOptions {
  baseDirectory: string;
  trialId: string;
  gitExecutable: string;
}

export function createGitSpikeFixture(options: CreateGitSpikeFixtureOptions): GitSpikeFixture {
  const baseDirectory = requireSafeTemporaryBase(options.baseDirectory);
  const gitExecutable = realpathSync(options.gitExecutable);
  const id = validateTrialId(options.trialId);
  const trialRoot = join(baseDirectory, id);
  mkdirSync(trialRoot, { recursive: false, mode: 0o700 });

  const repositoryRoot = join(trialRoot, 'repository');
  const siblingRepositoryRoot = join(trialRoot, 'sibling');
  const runtimeRoot = join(trialRoot, 'runtime');
  const emptyHooksDirectory = join(runtimeRoot, 'hooks');
  const emptyTemplateDirectory = join(runtimeRoot, 'git-template');
  const home = join(runtimeRoot, 'home');
  const xdgConfigHome = join(runtimeRoot, 'xdg-config');
  const xdgCacheHome = join(runtimeRoot, 'xdg-cache');
  const temporaryDirectory = join(runtimeRoot, 'tmp');
  const globalGitConfig = join(runtimeRoot, 'global.gitconfig');
  const askpassExecutable = join(runtimeRoot, 'git-askpass');

  for (const directory of [
    runtimeRoot,
    emptyHooksDirectory,
    emptyTemplateDirectory,
    home,
    xdgConfigHome,
    xdgCacheHome,
    temporaryDirectory,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeFileSync(globalGitConfig, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  writeFileSync(askpassExecutable, '#!/bin/sh\nexit 1\n', { encoding: 'utf8', mode: 0o700, flag: 'wx' });
  chmodSync(askpassExecutable, 0o700);

  const environmentPaths: GitSpikeEnvironmentPaths = {
    trialRoot,
    repositoryRoot,
    home,
    xdgConfigHome,
    xdgCacheHome,
    temporaryDirectory,
    globalGitConfig,
    askpassExecutable,
  };
  const gitEnvironment = buildFixtureGitEnvironment(gitExecutable, environmentPaths);

  try {
    initializeRepository(
      gitExecutable,
      repositoryRoot,
      emptyTemplateDirectory,
      emptyHooksDirectory,
      gitEnvironment,
    );
    writeManifest(repositoryRoot, PRIMARY_FILES);
    runGitRaw(gitExecutable, repositoryRoot, gitEnvironment, ['add', '--', ...Object.keys(PRIMARY_FILES)]);
    commitFixture(gitExecutable, repositoryRoot, gitEnvironment, SEED_RECIPE.firstCommit.message, SEED_RECIPE.firstCommit.date);
    const firstCommit = gitText(gitExecutable, repositoryRoot, gitEnvironment, ['rev-parse', '--verify', 'HEAD^{commit}']);
    runGitRaw(
      gitExecutable,
      repositoryRoot,
      withCommitDate(gitEnvironment, SEED_RECIPE.firstCommit.date),
      ['branch', 'feature/seed', firstCommit],
    );

    writeManifest(repositoryRoot, SECOND_COMMIT_FILES);
    runGitRaw(gitExecutable, repositoryRoot, gitEnvironment, ['add', '--', ...Object.keys(SECOND_COMMIT_FILES)]);
    commitFixture(gitExecutable, repositoryRoot, gitEnvironment, SEED_RECIPE.secondCommit.message, SEED_RECIPE.secondCommit.date);
    const mainHead = gitText(gitExecutable, repositoryRoot, gitEnvironment, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const featureSeedHead = gitText(gitExecutable, repositoryRoot, gitEnvironment, [
      'rev-parse',
      '--verify',
      'refs/heads/feature/seed^{commit}',
    ]);

    initializeRepository(
      gitExecutable,
      siblingRepositoryRoot,
      emptyTemplateDirectory,
      emptyHooksDirectory,
      gitEnvironment,
    );
    const sentinelPath = join(siblingRepositoryRoot, 'sentinel.txt');
    writeFileSync(sentinelPath, 'Oculory out-of-scope sentinel\n', { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    chmodSync(sentinelPath, 0o644);
    runGitRaw(gitExecutable, siblingRepositoryRoot, gitEnvironment, ['add', '--', 'sentinel.txt']);
    commitFixture(
      gitExecutable,
      siblingRepositoryRoot,
      gitEnvironment,
      'Seed out-of-scope sentinel',
      '2024-01-01T12:00:00Z',
    );
    const siblingHead = gitText(gitExecutable, siblingRepositoryRoot, gitEnvironment, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    const sentinelInitial = readSentinelMetadata(sentinelPath);

    const fixture: GitSpikeFixture = {
      id,
      baseDirectory,
      trialRoot,
      repositoryRoot,
      siblingRepositoryRoot,
      sentinelPath,
      gitDirectory: join(repositoryRoot, '.git'),
      siblingGitDirectory: join(siblingRepositoryRoot, '.git'),
      emptyHooksDirectory,
      emptyTemplateDirectory,
      environmentPaths,
      gitExecutable,
      gitEnvironment,
      seedRecipeDigest: GIT_SPIKE_SEED_RECIPE_DIGEST,
      firstCommit,
      mainHead,
      featureSeedHead,
      siblingHead,
      sentinelInitial,
    };
    assertBaseFixtureInvariants(fixture);
    return fixture;
  } catch (error) {
    try {
      rmSync(trialRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'fixture creation failed and emergency fixture removal also failed',
        { cause: error },
      );
    }
    throw error;
  }
}

export function applyFixtureEdit(fixture: GitSpikeFixture, relativePath: string, content: string): void {
  if (!GIT_SPIKE_PRIMARY_PATHS.includes(relativePath)) {
    throw new Error(`fixture edit is not a registered seed path: ${relativePath}`);
  }
  const path = exactPathBelow(fixture.repositoryRoot, relativePath);
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o644, flag: 'w' });
  chmodSync(path, 0o644);
}

export function stageFixturePath(fixture: GitSpikeFixture, relativePath: string): void {
  if (!GIT_SPIKE_PRIMARY_PATHS.includes(relativePath)) {
    throw new Error(`fixture stage path is not registered: ${relativePath}`);
  }
  runFixtureGit(fixture, ['add', '--', relativePath]);
}

export function runFixtureGit(fixture: GitSpikeFixture, args: readonly string[]): Buffer {
  return runGitRaw(
    fixture.gitExecutable,
    fixture.repositoryRoot,
    fixture.gitEnvironment,
    args,
  );
}

export function runSiblingGit(fixture: GitSpikeFixture, args: readonly string[]): Buffer {
  return runGitRaw(
    fixture.gitExecutable,
    fixture.siblingRepositoryRoot,
    fixture.gitEnvironment,
    args,
  );
}

export function runGitRaw(
  gitExecutable: string,
  repositoryRoot: string,
  env: Readonly<Record<string, string>>,
  args: readonly string[],
  timeoutMs = NATIVE_GIT_TIMEOUT_MS,
): Buffer {
  assertNoForbiddenEnvironmentNames(env);
  return execFileSync(gitExecutable, [...args], {
    cwd: repositoryRoot,
    env: { ...env },
    encoding: 'buffer',
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function cleanupGitSpikeFixture(
  fixture: GitSpikeFixture,
  process: GitSpikeProcessCleanupEvidence,
): GitSpikeCleanupProof {
  const steps: GitSpikeCleanupStep[] = [];
  const failures: GitSpikeCleanupFailure[] = [];
  let safeTrialRoot = false;
  let noRemoteBeforeCleanup = false;
  let sentinelUnchangedBeforeRepositoryRemoval = false;
  let sentinelUnchangedAfterRepositoryRemoval = false;
  let runtimePathsContained = false;
  let repositoryRemoved = false;
  let fixturePathAbsent = false;
  let trialRootRemoved = false;
  let parentContainsTrialName = true;

  cleanupStep(steps, failures, 'safe_trial_root_verification', 'registered temporary-root safety inspection', () => {
    assertSafeTrialRoot(fixture);
    safeTrialRoot = true;
  });

  cleanupStep(steps, failures, 'native_git_remote_inspection', 'git remote', () => {
    const remotes = gitText(fixture.gitExecutable, fixture.repositoryRoot, fixture.gitEnvironment, ['remote']);
    noRemoteBeforeCleanup = remotes.length === 0;
    if (!noRemoteBeforeCleanup) throw new Error('fixture unexpectedly has a Git remote before cleanup');
  });
  cleanupStep(steps, failures, 'sentinel_inspection_before_removal', 'lstat/read sibling sentinel', () => {
    sentinelUnchangedBeforeRepositoryRemoval = metadataEqual(readSentinelMetadata(fixture.sentinelPath), fixture.sentinelInitial);
    if (!sentinelUnchangedBeforeRepositoryRemoval) throw new Error('sibling sentinel changed before repository removal');
  });
  cleanupStep(steps, failures, 'runtime_path_containment', 'path containment inspection', () => {
    runtimePathsContained = Object.values(fixture.environmentPaths).every((path) => pathWithin(path, fixture.trialRoot));
    if (!runtimePathsContained) throw new Error('a runtime path escaped the registered trial root');
  });
  cleanupStep(steps, failures, 'repository_removal', 'recursive primary repository removal', () => {
    if (!safeTrialRoot) throw new Error('repository removal skipped because trial-root safety verification failed');
    if (existsSync(fixture.repositoryRoot)) rmSync(fixture.repositoryRoot, { recursive: true, force: false });
    repositoryRemoved = !existsSync(fixture.repositoryRoot);
    if (!repositoryRemoved) throw new Error('primary repository remains after removal');
  });
  cleanupStep(steps, failures, 'sentinel_inspection_after_repository_removal', 'lstat/read sibling sentinel', () => {
    sentinelUnchangedAfterRepositoryRemoval = metadataEqual(readSentinelMetadata(fixture.sentinelPath), fixture.sentinelInitial);
    if (!sentinelUnchangedAfterRepositoryRemoval) throw new Error('sibling sentinel changed after primary repository removal');
  });
  cleanupStep(steps, failures, 'fixture_path_absence_check', 'primary repository absence inspection', () => {
    fixturePathAbsent = !existsSync(fixture.repositoryRoot);
    if (!fixturePathAbsent) throw new Error('primary repository path remains present');
  });
  cleanupStep(steps, failures, 'trial_root_removal', 'recursive trial-root removal', () => {
    if (!safeTrialRoot) throw new Error('trial-root removal skipped because safety verification failed');
    if (existsSync(fixture.trialRoot)) rmSync(fixture.trialRoot, { recursive: true, force: false });
    trialRootRemoved = !existsSync(fixture.trialRoot);
    if (!trialRootRemoved) throw new Error('trial root remains after removal');
  });
  cleanupStep(steps, failures, 'post_removal_parent_absence_check', 'trial-parent directory inspection', () => {
    parentContainsTrialName = readdirSync(fixture.baseDirectory).includes(basename(fixture.trialRoot));
    if (parentContainsTrialName) throw new Error('trial parent still contains the removed trial name');
  });

  const passed =
    process.closeObserved &&
    process.allRequestsSettled &&
    !process.childAlive &&
    process.managedProcessGroupAlive !== true &&
    !process.emergencyCleanupUsed &&
    noRemoteBeforeCleanup &&
    sentinelUnchangedBeforeRepositoryRemoval &&
    sentinelUnchangedAfterRepositoryRemoval &&
    runtimePathsContained &&
    repositoryRemoved &&
    fixturePathAbsent &&
    trialRootRemoved &&
    !parentContainsTrialName;

  return {
    process: { ...process },
    noRemoteBeforeCleanup,
    sentinelUnchangedBeforeRepositoryRemoval,
    sentinelUnchangedAfterRepositoryRemoval,
    runtimePathsContained,
    repositoryRemoved,
    fixturePathAbsent,
    trialRootRemoved,
    parentContainsTrialName,
    steps,
    failures,
    passed,
  };
}

function cleanupStep(
  steps: GitSpikeCleanupStep[],
  failures: GitSpikeCleanupFailure[],
  name: string,
  operation: string,
  body: () => void,
): void {
  try {
    body();
    steps.push({ name, attempted: true, passed: true, detail: null });
  } catch (error) {
    const failure = nativeGitFailure(error, name, operation);
    failures.push(failure);
    steps.push({ name, attempted: true, passed: false, detail: failure.message });
  }
}

function nativeGitFailure(error: unknown, step: string, operation: string): GitSpikeCleanupFailure {
  const value = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: string | number };
  const timedOut = value.code === 'ETIMEDOUT' || value.killed === true || /timed out/i.test(value.message ?? '');
  return {
    step,
    operation,
    message: error instanceof Error ? error.message : String(error),
    timedOut,
    timeoutMs: timedOut ? NATIVE_GIT_TIMEOUT_MS : null,
  };
}

export function readSentinelMetadata(path: string): SentinelMetadata {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error(`sentinel is not a regular file: ${path}`);
  const bytes = readFileSync(path);
  return {
    byteLength: bytes.length,
    sha256: digestBytes(bytes),
    mode: Number(stat.mode & 0o777n).toString(8).padStart(3, '0'),
    mtimeNanoseconds: stat.mtimeNs.toString(),
  };
}

function initializeRepository(
  gitExecutable: string,
  repositoryRoot: string,
  templateDirectory: string,
  hooksDirectory: string,
  env: Readonly<Record<string, string>>,
): void {
  mkdirSync(repositoryRoot, { recursive: false, mode: 0o700 });
  runGitRaw(gitExecutable, repositoryRoot, env, [
    'init',
    '--quiet',
    '--initial-branch=main',
    '--object-format=sha1',
    `--template=${templateDirectory}`,
    repositoryRoot,
  ]);
  const config: Readonly<Record<string, string>> = {
    'core.hooksPath': hooksDirectory,
    ...SEED_RECIPE.configuration,
  };
  for (const [key, value] of Object.entries(config)) {
    runGitRaw(gitExecutable, repositoryRoot, env, ['config', '--local', key, value]);
  }
}

function commitFixture(
  gitExecutable: string,
  repositoryRoot: string,
  env: Readonly<Record<string, string>>,
  message: string,
  date: string,
): void {
  runGitRaw(gitExecutable, repositoryRoot, withCommitDate(env, date), [
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '--no-verify',
    '-m',
    message,
  ]);
}

function buildFixtureGitEnvironment(
  gitExecutable: string,
  paths: GitSpikeEnvironmentPaths,
): Readonly<Record<string, string>> {
  const env = Object.freeze({
    PATH: [...new Set([dirname(gitExecutable), '/usr/bin', '/bin'])].join(':'),
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    TMPDIR: paths.temporaryDirectory,
    GIT_CONFIG_GLOBAL: paths.globalGitConfig,
    GIT_ASKPASS: paths.askpassExecutable,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: paths.trialRoot,
    GIT_AUTHOR_NAME: SEED_RECIPE.identity.name,
    GIT_AUTHOR_EMAIL: SEED_RECIPE.identity.email,
    GIT_COMMITTER_NAME: SEED_RECIPE.identity.name,
    GIT_COMMITTER_EMAIL: SEED_RECIPE.identity.email,
    GIT_AUTHOR_DATE: SEED_RECIPE.secondCommit.date,
    GIT_COMMITTER_DATE: SEED_RECIPE.secondCommit.date,
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC',
  });
  assertNoForbiddenEnvironmentNames(env);
  return env;
}

function assertBaseFixtureInvariants(fixture: GitSpikeFixture): void {
  const branch = gitText(fixture.gitExecutable, fixture.repositoryRoot, fixture.gitEnvironment, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const status = gitText(fixture.gitExecutable, fixture.repositoryRoot, fixture.gitEnvironment, [
    'status',
    '--porcelain=v2',
    '--untracked-files=all',
  ]);
  const remotes = gitText(fixture.gitExecutable, fixture.repositoryRoot, fixture.gitEnvironment, ['remote']);
  const tags = gitText(fixture.gitExecutable, fixture.repositoryRoot, fixture.gitEnvironment, ['tag', '--list']);
  const filters = gitTextAllowNoMatch(
    fixture.gitExecutable,
    fixture.repositoryRoot,
    fixture.gitEnvironment,
    ['config', '--local', '--get-regexp', '^filter\\.'],
  );
  const hooks = readdirSync(fixture.emptyHooksDirectory);
  const siblingStatus = gitText(
    fixture.gitExecutable,
    fixture.siblingRepositoryRoot,
    fixture.gitEnvironment,
    ['status', '--porcelain=v2', '--untracked-files=all'],
  );
  if (branch !== 'main') throw new Error(`fixture checked out unexpected branch: ${branch}`);
  if (status !== '') throw new Error(`fixture is not clean after materialization: ${status}`);
  if (remotes !== '') throw new Error('fixture unexpectedly has a remote');
  if (tags !== '') throw new Error('fixture unexpectedly has a tag');
  if (filters !== '') throw new Error('fixture unexpectedly has a filter configuration');
  if (hooks.length !== 0) throw new Error('fixture hooks directory is not empty');
  if (siblingStatus !== '') throw new Error(`sibling sentinel repository is not clean: ${siblingStatus}`);
  if (fixture.firstCommit !== fixture.featureSeedHead) {
    throw new Error('feature/seed does not point at the deterministic first commit');
  }
}

function writeManifest(repositoryRoot: string, manifest: Readonly<Record<string, string>>): void {
  for (const [relativePath, content] of Object.entries(manifest)) {
    const path = exactPathBelow(repositoryRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o644, flag: existsSync(path) ? 'w' : 'wx' });
    chmodSync(path, 0o644);
  }
}

function withCommitDate(env: Readonly<Record<string, string>>, date: string): Readonly<Record<string, string>> {
  return { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

function gitText(
  gitExecutable: string,
  repositoryRoot: string,
  env: Readonly<Record<string, string>>,
  args: readonly string[],
): string {
  return runGitRaw(gitExecutable, repositoryRoot, env, args).toString('utf8').trim();
}

function gitTextAllowNoMatch(
  gitExecutable: string,
  repositoryRoot: string,
  env: Readonly<Record<string, string>>,
  args: readonly string[],
): string {
  try {
    return gitText(gitExecutable, repositoryRoot, env, args);
  } catch (error) {
    if (isExitCode(error, 1)) return '';
    throw error;
  }
}

function isExitCode(error: unknown, code: number): boolean {
  return error instanceof Error && 'status' in error && (error as { status?: number }).status === code;
}

function metadataEqual(a: SentinelMetadata, b: SentinelMetadata): boolean {
  return canonicalJson(a as unknown as JsonObject) === canonicalJson(b as unknown as JsonObject);
}

function exactPathBelow(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error(`fixture path must be relative: ${relativePath}`);
  const path = resolve(root, relativePath);
  if (!pathWithin(path, root) || path === resolve(root)) {
    throw new Error(`fixture path escapes repository: ${relativePath}`);
  }
  return path;
}

function pathWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function requireSafeTemporaryBase(path: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`temporary base must exist and be absolute: ${path}`);
  const base = realpathSync(path);
  const systemTemporary = realpathSync(tmpdir());
  if (base === systemTemporary || !pathWithin(base, systemTemporary)) {
    throw new Error(`Git spike base must be a dedicated directory beneath ${systemTemporary}`);
  }
  return base;
}

function assertSafeTrialRoot(fixture: GitSpikeFixture): void {
  const base = requireSafeTemporaryBase(fixture.baseDirectory);
  if (dirname(fixture.trialRoot) !== base || basename(fixture.trialRoot) !== fixture.id) {
    throw new Error(`refusing to remove unregistered trial root: ${fixture.trialRoot}`);
  }
}

function validateTrialId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{2,80}$/.test(value)) {
    throw new Error(`invalid Git spike trial id: ${value}`);
  }
  return value;
}

function digestObject(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value as JsonObject)).digest('hex');
}

// Keep the recipe object live in emitted JavaScript and fail if its exported digest drifts.
if (digestObject(SEED_RECIPE) !== GIT_SPIKE_SEED_RECIPE_DIGEST) {
  throw new Error('Git spike seed recipe digest mismatch');
}
