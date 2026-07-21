import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertSupportedMode,
  containsSecretValue,
  evaluateObserved,
  equalJson,
  isSecretShapedName,
  redactSecrets,
  rejectUnknownKeys,
  requireBoundedInteger,
  requireObject,
  requireString,
  requireStringArray,
} from './shared.js';
import type {
  AdapterAssertion,
  AdapterAssertionResult,
  AdapterJson,
  AdapterOperationResult,
  AdapterPrepareContext,
  OculoryAdapter,
} from './types.js';

export const GIT_FILESYSTEM_ADAPTER_ID = 'git-filesystem';
export const GIT_FILESYSTEM_ADAPTER_VERSION = '1.0.0';

export interface GitFilesystemAdapterConfiguration {
  mode: 'git' | 'filesystem';
  sourcePath: string;
  inPlace: boolean;
  watchPaths: string[];
  watchBranches: string[];
  baseRefs: string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxCommits: number;
  commandTimeoutMs: number;
}

export interface GitFilesystemPrepared {
  readonly configuration: GitFilesystemAdapterConfiguration;
  readonly temporaryRoot: string;
  readonly workspacePath: string;
  readonly gitEnvironment: Readonly<Record<string, string>>;
  readonly ownsWorkspace: boolean;
  readonly baselineBackupPath: string | null;
  workspaceDevice: number;
  workspaceInode: number;
  baseline: NormalizedGitFilesystemSnapshot | null;
  cleaned: boolean;
}

export interface GitFilesystemFileEntry {
  path: string;
  kind: 'directory' | 'file' | 'symlink';
  byteLength: number | null;
  sha256: string | null;
  symlinkTarget: string | null;
}

export interface GitFilesystemSnapshot {
  mode: 'git' | 'filesystem';
  watchPaths: string[];
  watchBranches: string[];
  baseRefs: string[];
  currentBranch: string | null;
  head: string | null;
  refs: Record<string, string>;
  commits: Record<string, string[]>;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  clean: boolean;
  files: GitFilesystemFileEntry[];
}

interface GitFilesystemResetBaseline {
  currentBranch: string | null;
  head: string;
  refs: Record<string, string>;
}

const RESET_BASELINES = new WeakMap<GitFilesystemPrepared, GitFilesystemResetBaseline>();

export type NormalizedGitFilesystemSnapshot = GitFilesystemSnapshot;

export interface GitFilesystemDiff {
  changed: boolean;
  currentBranchChanged: boolean;
  headChanged: boolean;
  addedBranches: string[];
  removedBranches: string[];
  changedBranches: string[];
  addedPaths: string[];
  removedPaths: string[];
  changedPaths: string[];
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
}

const CONFIGURATION_KEYS = [
  'mode',
  'sourcePath',
  'inPlace',
  'watchPaths',
  'watchBranches',
  'baseRefs',
  'maxFiles',
  'maxFileBytes',
  'maxTotalBytes',
  'maxCommits',
  'commandTimeoutMs',
] as const;

export function createGitFilesystemAdapter(): OculoryAdapter<
  GitFilesystemAdapterConfiguration,
  GitFilesystemPrepared,
  GitFilesystemSnapshot,
  NormalizedGitFilesystemSnapshot,
  GitFilesystemDiff
> {
  return {
    validateConfiguration,
    prepare,
    snapshotBefore,
    snapshotAfter: capture,
    normalizeSnapshot,
    diff,
    evaluateAssertion,
    reset,
    cleanup,
    describeViolation,
    redact: redactSecrets,
  };
}

async function snapshotBefore(prepared: GitFilesystemPrepared): Promise<GitFilesystemSnapshot> {
  const value = await capture(prepared);
  const normalized = normalizeSnapshot(value);
  if (prepared.baseline !== null && !equalJson(
    prepared.baseline as unknown as AdapterJson,
    normalized as unknown as AdapterJson,
  )) {
    throw new Error('Git/filesystem workspace changed before baseline registration');
  }
  prepared.baseline = normalized;
  return value;
}

function validateConfiguration(value: unknown): GitFilesystemAdapterConfiguration {
  const input = requireObject(value, 'Git/filesystem adapter configuration');
  rejectUnknownKeys(input, CONFIGURATION_KEYS, 'Git/filesystem adapter configuration');
  const mode = input.mode === undefined ? 'git' : input.mode;
  if (mode !== 'git' && mode !== 'filesystem') throw new Error('mode must be git or filesystem');
  const sourcePath = resolve(requireString(input.sourcePath, 'sourcePath'));
  if (!isAbsolute(sourcePath) || !existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    throw new Error('sourcePath must resolve to an existing directory');
  }
  const watchPaths = input.watchPaths === undefined ? ['.'] : requireStringArray(input.watchPaths, 'watchPaths');
  for (const path of watchPaths) requireSafeRelativePath(path, 'watch path');
  const watchBranches = input.watchBranches === undefined || Array.isArray(input.watchBranches) && input.watchBranches.length === 0
    ? []
    : requireStringArray(input.watchBranches, 'watchBranches', 128);
  for (const ref of watchBranches) requireSafeRef(ref);
  const baseRefs = input.baseRefs === undefined || Array.isArray(input.baseRefs) && input.baseRefs.length === 0
    ? []
    : requireStringArray(input.baseRefs, 'baseRefs', 64);
  for (const ref of baseRefs) requireSafeRef(ref);
  if (mode === 'git' && watchBranches.length === 0) throw new Error('watchBranches must declare at least one Git branch');
  if (mode === 'git' && baseRefs.some((ref) => !watchBranches.includes(ref))) {
    throw new Error('baseRefs must be contained in watchBranches');
  }
  if (mode === 'filesystem' && (baseRefs.length > 0 || watchBranches.length > 0)) {
    throw new Error('baseRefs and watchBranches are only valid in git mode');
  }
  return {
    mode,
    sourcePath,
    inPlace: input.inPlace === undefined ? false : requireBoolean(input.inPlace, 'inPlace'),
    watchPaths: minimalPaths(watchPaths),
    watchBranches: unique(watchBranches),
    baseRefs: unique(baseRefs),
    maxFiles: input.maxFiles === undefined ? 4_096 : requireBoundedInteger(input.maxFiles, 'maxFiles', 1, 20_000),
    maxFileBytes: input.maxFileBytes === undefined ? 8 * 1024 * 1024 : requireBoundedInteger(input.maxFileBytes, 'maxFileBytes', 1, 64 * 1024 * 1024),
    maxTotalBytes: input.maxTotalBytes === undefined ? 64 * 1024 * 1024 : requireBoundedInteger(input.maxTotalBytes, 'maxTotalBytes', 1, 512 * 1024 * 1024),
    maxCommits: input.maxCommits === undefined ? 4_096 : requireBoundedInteger(input.maxCommits, 'maxCommits', 1, 20_000),
    commandTimeoutMs: input.commandTimeoutMs === undefined ? 10_000 : requireBoundedInteger(input.commandTimeoutMs, 'commandTimeoutMs', 100, 60_000),
  };
}

async function prepare(
  configuration: GitFilesystemAdapterConfiguration,
  context: AdapterPrepareContext,
): Promise<GitFilesystemPrepared> {
  if (context.signal?.aborted === true) throw new Error('adapter preparation cancelled');
  requireString(context.runId, 'runId', /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  configuration = validateConfiguration(configuration);
  if (configuration.inPlace) {
    if (context.workspaceRoot === undefined) throw new Error('in-place adapter requires the authorized disposable workspace root');
    const source = realpathSync(configuration.sourcePath);
    const authorized = realpathSync(context.workspaceRoot);
    if (source !== authorized) throw new Error('in-place adapter source differs from the authorized disposable workspace root');
    configuration = { ...configuration, sourcePath: authorized };
  }
  Object.freeze(configuration.watchPaths);
  Object.freeze(configuration.watchBranches);
  Object.freeze(configuration.baseRefs);
  Object.freeze(configuration);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'oculory-adapter-'));
  const workspacePath = configuration.inPlace ? configuration.sourcePath : join(temporaryRoot, 'workspace');
  const home = join(temporaryRoot, 'home');
  mkdirSync(home, { mode: 0o700 });
  const globalConfig = join(temporaryRoot, 'gitconfig');
  writeFileSync(globalConfig, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const gitEnvironment = Object.freeze({
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
    LC_ALL: 'C',
    TZ: 'UTC',
  });
  const prepared: GitFilesystemPrepared = {
    configuration,
    temporaryRoot,
    workspacePath,
    gitEnvironment,
    ownsWorkspace: !configuration.inPlace,
    baselineBackupPath: configuration.inPlace && configuration.mode === 'filesystem' ? join(temporaryRoot, 'baseline') : null,
    workspaceDevice: 0,
    workspaceInode: 0,
    baseline: null,
    cleaned: false,
  };
  try {
    if (prepared.ownsWorkspace) materialize(prepared);
    else prepareInPlace(prepared);
    const identity = statSync(prepared.workspacePath);
    prepared.workspaceDevice = identity.dev;
    prepared.workspaceInode = identity.ino;
    if (configuration.mode === 'git') RESET_BASELINES.set(prepared, captureResetBaseline(prepared));
    prepared.baseline = normalizeSnapshot(await capture(prepared));
    return prepared;
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function materialize(prepared: GitFilesystemPrepared): void {
  const { configuration, workspacePath } = prepared;
  if (configuration.mode === 'git') {
    runGit(
      prepared,
      ['clone', '--quiet', '--no-hardlinks', '--no-tags', '--', configuration.sourcePath, workspacePath],
      prepared.temporaryRoot,
    );
    const current = runGitAllowFailure(prepared, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    for (const line of lines(runGit(prepared, ['for-each-ref', '--format=%(refname:strip=3)%09%(objectname)', 'refs/remotes/origin']))) {
      const [name, objectId] = line.split('\t');
      if (name === undefined || objectId === undefined || name === 'HEAD' || name === current) continue;
      runGit(prepared, ['branch', name, objectId]);
    }
    runGit(prepared, ['remote', 'remove', 'origin']);
    runGit(prepared, ['config', '--local', 'user.name', 'Oculory Replay']);
    runGit(prepared, ['config', '--local', 'user.email', 'replay@oculory.invalid']);
    for (const ref of configuration.baseRefs) {
      runGit(prepared, ['show-ref', '--verify', `refs/heads/${ref}`]);
    }
    return;
  }
  copyDirectory(configuration.sourcePath, workspacePath, configuration);
}

function prepareInPlace(prepared: GitFilesystemPrepared): void {
  if (resolve(prepared.workspacePath) === resolve(process.cwd())) {
    throw new Error('in-place adapter refuses the current Oculory process directory');
  }
  if (prepared.configuration.mode === 'git') {
    if (runGit(prepared, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
      throw new Error('in-place Git workspace is not a repository');
    }
    if (lines(runGit(prepared, ['remote'])).length > 0) throw new Error('in-place Git workspace must not have remotes');
    if (runGit(prepared, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length > 0) {
      throw new Error('in-place Git workspace must start clean');
    }
    if (runGit(prepared, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--']).length > 0) {
      throw new Error('in-place Git workspace must not contain ignored files');
    }
    for (const ref of prepared.configuration.baseRefs) runGit(prepared, ['show-ref', '--verify', `refs/heads/${ref}`]);
    return;
  }
  copyDirectory(prepared.workspacePath, prepared.baselineBackupPath!, prepared.configuration);
}

async function capture(prepared: GitFilesystemPrepared): Promise<GitFilesystemSnapshot> {
  assertPrepared(prepared);
  const files = snapshotFiles(prepared.workspacePath, prepared.configuration);
  if (prepared.configuration.mode === 'filesystem') {
    return {
      mode: 'filesystem',
      watchPaths: [...prepared.configuration.watchPaths],
      watchBranches: [],
      baseRefs: [],
      currentBranch: null,
      head: null,
      refs: {},
      commits: {},
      stagedFiles: [],
      unstagedFiles: [],
      untrackedFiles: [],
      clean: true,
      files,
    };
  }

  const observedBranch = runGitAllowFailure(prepared, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null;
  const observedHead = runGit(prepared, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const allRefs = captureRefs(prepared);
  const refs = Object.fromEntries(prepared.configuration.watchBranches
    .filter((name) => allRefs[name] !== undefined)
    .map((name) => [name, allRefs[name]!]));
  const tips = unique(Object.values(refs));
  const graphLines = tips.length === 0 ? [] : lines(runGit(prepared, [
    'rev-list',
    '--parents',
    `--max-count=${prepared.configuration.maxCommits + 1}`,
    ...tips,
    '--',
  ]));
  if (graphLines.length > prepared.configuration.maxCommits) throw new Error('Git commit graph exceeds configured limit');
  const commits = Object.fromEntries(graphLines.map((line) => {
    const [objectId, ...parents] = line.split(' ');
    return [objectId!, parents];
  }));
  const head = commits[observedHead] !== undefined || tips.includes(observedHead) ? observedHead : null;
  if (head !== null) refs.HEAD = head;
  const currentBranch = observedBranch !== null && prepared.configuration.watchBranches.includes(observedBranch)
    ? observedBranch
    : null;
  const pathspec = ['--', ...prepared.configuration.watchPaths];
  const stagedFiles = safeObservedPaths(nul(runGit(prepared, ['diff', '--cached', '--name-only', '-z', ...pathspec])));
  const unstagedFiles = safeObservedPaths(nul(runGit(prepared, ['diff', '--name-only', '-z', ...pathspec])));
  const untrackedFiles = safeObservedPaths(nul(runGit(prepared, ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec])));
  return {
    mode: 'git',
    watchPaths: [...prepared.configuration.watchPaths],
    watchBranches: [...prepared.configuration.watchBranches],
    baseRefs: [...prepared.configuration.baseRefs],
    currentBranch,
    head,
    refs: sortedRecord(refs),
    commits: sortedRecord(commits),
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    clean: stagedFiles.length === 0 && unstagedFiles.length === 0 && untrackedFiles.length === 0,
    files,
  };
}

function normalizeSnapshot(snapshot: GitFilesystemSnapshot): NormalizedGitFilesystemSnapshot {
  return structuredClone({
    ...snapshot,
    watchPaths: [...snapshot.watchPaths].sort(),
    watchBranches: [...snapshot.watchBranches].sort(),
    baseRefs: [...snapshot.baseRefs].sort(),
    refs: sortedRecord(snapshot.refs),
    commits: sortedRecord(snapshot.commits),
    stagedFiles: [...snapshot.stagedFiles].sort(),
    unstagedFiles: [...snapshot.unstagedFiles].sort(),
    untrackedFiles: [...snapshot.untrackedFiles].sort(),
    files: [...snapshot.files].sort((left, right) => left.path.localeCompare(right.path)),
  });
}

function diff(before: NormalizedGitFilesystemSnapshot, after: NormalizedGitFilesystemSnapshot): GitFilesystemDiff {
  const beforeRefs = before.refs;
  const afterRefs = after.refs;
  const addedBranches = Object.keys(afterRefs).filter((name) => name !== 'HEAD' && beforeRefs[name] === undefined).sort();
  const removedBranches = Object.keys(beforeRefs).filter((name) => name !== 'HEAD' && afterRefs[name] === undefined).sort();
  const changedBranches = Object.keys(afterRefs).filter((name) => name !== 'HEAD' && beforeRefs[name] !== undefined && beforeRefs[name] !== afterRefs[name]).sort();
  const beforeFiles = new Map(before.files.map((entry) => [entry.path, entry]));
  const afterFiles = new Map(after.files.map((entry) => [entry.path, entry]));
  const addedPaths = [...afterFiles.keys()].filter((path) => !beforeFiles.has(path)).sort();
  const removedPaths = [...beforeFiles.keys()].filter((path) => !afterFiles.has(path)).sort();
  const changedPaths = [...afterFiles.keys()]
    .filter((path) => beforeFiles.has(path) && !equalJson(beforeFiles.get(path) as unknown as AdapterJson, afterFiles.get(path) as unknown as AdapterJson))
    .sort();
  const value: GitFilesystemDiff = {
    changed: false,
    currentBranchChanged: before.currentBranch !== after.currentBranch,
    headChanged: before.head !== after.head,
    addedBranches,
    removedBranches,
    changedBranches,
    addedPaths,
    removedPaths,
    changedPaths,
    stagedFiles: [...after.stagedFiles],
    unstagedFiles: [...after.unstagedFiles],
    untrackedFiles: [...after.untrackedFiles],
  };
  value.changed = value.currentBranchChanged || value.headChanged ||
    addedBranches.length + removedBranches.length + changedBranches.length + addedPaths.length + removedPaths.length + changedPaths.length > 0 ||
    !equalJson(before.stagedFiles, after.stagedFiles) ||
    !equalJson(before.unstagedFiles, after.unstagedFiles) ||
    !equalJson(before.untrackedFiles, after.untrackedFiles);
  return value;
}

function evaluateAssertion(
  assertion: AdapterAssertion,
  before: NormalizedGitFilesystemSnapshot,
  after: NormalizedGitFilesystemSnapshot,
  _diff: GitFilesystemDiff,
): AdapterAssertionResult {
  assertSupportedMode(assertion.evaluationMode);
  const beforeValue = selectedValue(assertion, before);
  const afterValue = selectedValue(assertion, after);
  return evaluateObserved(assertion, beforeValue, afterValue);
}

async function reset(
  prepared: GitFilesystemPrepared,
  expected: NormalizedGitFilesystemSnapshot,
): Promise<AdapterOperationResult> {
  assertPrepared(prepared);
  const baseline = prepared.baseline;
  if (baseline === null || !equalJson(
    expected as unknown as AdapterJson,
    baseline as unknown as AdapterJson,
  )) {
    return { passed: false, detail: 'reset refused because the requested baseline was not registered' };
  }
  try {
    if (prepared.ownsWorkspace) {
      assertContained(prepared.workspacePath, prepared.temporaryRoot, 'workspace');
      rmSync(prepared.workspacePath, { recursive: true, force: false });
      materialize(prepared);
    } else if (prepared.configuration.mode === 'git') {
      const resetBaseline = RESET_BASELINES.get(prepared);
      if (resetBaseline === undefined) throw new Error('private Git reset baseline is unavailable');
      resetInPlaceGit(prepared, resetBaseline);
    } else {
      resetInPlaceFilesystem(prepared);
    }
    const observed = normalizeSnapshot(await capture(prepared));
    const passed = equalJson(baseline as unknown as AdapterJson, observed as unknown as AdapterJson);
    return { passed, detail: passed ? 'fresh disposable workspace verified' : 'fresh workspace differs from registered baseline' };
  } catch {
    return { passed: false, detail: 'fresh disposable workspace could not be verified' };
  }
}

async function cleanup(prepared: GitFilesystemPrepared): Promise<AdapterOperationResult> {
  if (prepared.cleaned) return { passed: !existsSync(prepared.temporaryRoot), detail: 'cleanup already attempted' };
  try {
    if (prepared.ownsWorkspace) assertContained(prepared.workspacePath, prepared.temporaryRoot, 'workspace');
    rmSync(prepared.temporaryRoot, { recursive: true, force: false });
    RESET_BASELINES.delete(prepared);
    prepared.cleaned = true;
    const passed = !existsSync(prepared.temporaryRoot);
    return { passed, detail: passed ? 'disposable workspace removed' : 'disposable workspace remains' };
  } catch {
    prepared.cleaned = true;
    return { passed: false, detail: 'disposable workspace cleanup failed' };
  }
}

function describeViolation(assertion: AdapterAssertion, result: AdapterAssertionResult): string {
  const kind = typeof assertion.selector.kind === 'string' ? assertion.selector.kind : 'state';
  return `${kind} violated: ${result.detail}`;
}

function selectedValue(assertion: AdapterAssertion, snapshot: NormalizedGitFilesystemSnapshot): AdapterJson | null {
  const selector = assertion.selector;
  const kind = requireString(selector.kind, 'selector.kind');
  switch (kind) {
    case 'branch': {
      const branch = requireSafeRef(requireString(selector.branch, 'selector.branch'));
      requireWatchedBranch(snapshot, branch);
      return snapshot.refs[branch] ?? null;
    }
    case 'branch_base': {
      const branch = requireSafeRef(requireString(selector.branch, 'selector.branch'));
      requireWatchedBranch(snapshot, branch);
      const branchHead = snapshot.refs[branch];
      if (branchHead === undefined) return null;
      const candidates = snapshot.baseRefs.filter((name) => name !== branch);
      return closestAncestorRef(branchHead, candidates, snapshot.refs, snapshot.commits);
    }
    case 'current_branch':
      return snapshot.currentBranch;
    case 'commit_count': {
      const ref = selector.ref === undefined ? 'HEAD' : requireSafeRef(requireString(selector.ref, 'selector.ref'));
      if (ref !== 'HEAD') requireWatchedBranch(snapshot, ref);
      const objectId = snapshot.refs[ref];
      return objectId === undefined ? null : reachable(objectId, snapshot.commits).size;
    }
    case 'commit_ancestry': {
      const ancestorRef = requireSafeRef(requireString(selector.ancestor, 'selector.ancestor'));
      const descendantRef = requireSafeRef(requireString(selector.descendant, 'selector.descendant'));
      requireWatchedBranch(snapshot, ancestorRef);
      requireWatchedBranch(snapshot, descendantRef);
      const ancestor = snapshot.refs[ancestorRef];
      const descendant = snapshot.refs[descendantRef];
      return ancestor === undefined || descendant === undefined ? null : reachable(descendant, snapshot.commits).has(ancestor);
    }
    case 'staged_files':
      return snapshot.stagedFiles;
    case 'unstaged_files':
      return snapshot.unstagedFiles;
    case 'untracked_files':
      return snapshot.untrackedFiles;
    case 'file': {
      const path = requireSafeRelativePath(requireString(selector.path, 'selector.path'), 'selector.path');
      requireWatchedPath(snapshot, path, false);
      return (snapshot.files.find((entry) => entry.path === path) as unknown as AdapterJson | undefined) ?? null;
    }
    case 'file_digest': {
      const path = requireSafeRelativePath(requireString(selector.path, 'selector.path'), 'selector.path');
      requireWatchedPath(snapshot, path, false);
      return snapshot.files.find((entry) => entry.path === path)?.sha256 ?? null;
    }
    case 'directory_tree': {
      const path = requireSafeRelativePath(requireString(selector.path ?? '.', 'selector.path'), 'selector.path');
      requireWatchedPath(snapshot, path, true);
      const prefix = path === '.' ? '' : `${path}/`;
      return snapshot.files.filter((entry) => entry.path === path || entry.path.startsWith(prefix)).map((entry) => entry.path);
    }
    case 'path_count': {
      const path = requireSafeRelativePath(requireString(selector.path ?? '.', 'selector.path'), 'selector.path');
      requireWatchedPath(snapshot, path, true);
      const prefix = path === '.' ? '' : `${path}/`;
      return snapshot.files.filter((entry) => entry.path === path || entry.path.startsWith(prefix)).length;
    }
    case 'clean_tree':
      return snapshot.clean;
    default:
      throw new Error(`unsupported Git/filesystem selector: ${kind}`);
  }
}

function snapshotFiles(root: string, configuration: GitFilesystemAdapterConfiguration): GitFilesystemFileEntry[] {
  const entries = new Map<string, GitFilesystemFileEntry>();
  let fileCount = 0;
  let totalBytes = 0;
  const visit = (absolute: string): void => {
    const rel = normalizeRelative(relative(root, absolute));
    if (rel === '.git' || rel.startsWith('.git/')) return;
    if (rel !== '.' && isSecretShapedName(rel)) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      fileCount += 1;
      if (fileCount > configuration.maxFiles) throw new Error('snapshot file count exceeds configured limit');
      const target = readlinkSync(absolute);
      const safeTarget = safeSymlinkTarget(target);
      entries.set(rel, { path: rel, kind: 'symlink', byteLength: Buffer.byteLength(safeTarget), sha256: digest(safeTarget), symlinkTarget: safeTarget });
      return;
    }
    assertResolvedInsideWorkspace(root, absolute);
    if (stat.isDirectory()) {
      if (rel !== '.') entries.set(rel, { path: rel, kind: 'directory', byteLength: null, sha256: null, symlinkTarget: null });
      for (const name of readdirSync(absolute).sort()) visit(join(absolute, name));
      return;
    }
    fileCount += 1;
    if (fileCount > configuration.maxFiles) throw new Error('snapshot file count exceeds configured limit');
    if (!stat.isFile()) throw new Error('snapshot contains an unsupported filesystem entry');
    if (stat.size > configuration.maxFileBytes) throw new Error('snapshot file exceeds configured byte limit');
    totalBytes += stat.size;
    if (totalBytes > configuration.maxTotalBytes) throw new Error('snapshot exceeds configured total byte limit');
    const bytes = readFileSync(absolute);
    const sha256 = containsSecretValue(bytes.toString('utf8')) ? null : digest(bytes);
    entries.set(rel, { path: rel, kind: 'file', byteLength: bytes.byteLength, sha256, symlinkTarget: null });
  };
  for (const watchPath of configuration.watchPaths) {
    const absolute = exactPath(root, watchPath);
    assertNoSymbolicLinkParents(root, absolute);
    if (lstatSync(absolute, { throwIfNoEntry: false }) !== undefined) visit(absolute);
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function copyDirectory(source: string, destination: string, configuration: GitFilesystemAdapterConfiguration): void {
  let files = 0;
  let totalBytes = 0;
  const copy = (from: string, to: string): void => {
    if (from !== source && isSecretShapedName(basename(from))) {
      throw new Error('filesystem source contains a secret-shaped path');
    }
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error('filesystem source may not contain symbolic links');
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: false, mode: stat.mode & 0o777 });
      for (const name of readdirSync(from).sort()) {
        if (name === '.git') continue;
        copy(join(from, name), join(to, name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error('filesystem source contains an unsupported entry');
    files += 1;
    totalBytes += stat.size;
    if (files > configuration.maxFiles || stat.size > configuration.maxFileBytes || totalBytes > configuration.maxTotalBytes) {
      throw new Error('filesystem source exceeds configured copy limits');
    }
    const bytes = readFileSync(from);
    if (containsSecretValue(bytes.toString('utf8'))) throw new Error('filesystem source contains secret-shaped content');
    writeFileSync(to, bytes, { flag: 'wx', mode: stat.mode & 0o777 });
    chmodSync(to, stat.mode & 0o777);
  };
  copy(source, destination);
}

function copyDirectoryContents(source: string, destination: string, configuration: GitFilesystemAdapterConfiguration): void {
  let files = 0;
  let totalBytes = 0;
  const copy = (from: string, to: string): void => {
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error('filesystem backup may not contain symbolic links');
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: false, mode: stat.mode & 0o777 });
      for (const name of readdirSync(from).sort()) copy(join(from, name), join(to, name));
      return;
    }
    if (!stat.isFile()) throw new Error('filesystem backup contains an unsupported entry');
    files += 1;
    totalBytes += stat.size;
    if (files > configuration.maxFiles || stat.size > configuration.maxFileBytes || totalBytes > configuration.maxTotalBytes) {
      throw new Error('filesystem backup exceeds configured copy limits');
    }
    const bytes = readFileSync(from);
    if (containsSecretValue(bytes.toString('utf8'))) throw new Error('filesystem backup contains secret-shaped content');
    writeFileSync(to, bytes, { flag: 'wx', mode: stat.mode & 0o777 });
    chmodSync(to, stat.mode & 0o777);
  };
  for (const name of readdirSync(source).sort()) copy(join(source, name), join(destination, name));
}

function runGit(prepared: GitFilesystemPrepared, args: readonly string[], cwd = prepared.workspacePath): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      env: prepared.gitEnvironment,
      encoding: 'utf8',
      timeout: prepared.configuration.commandTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Git command failed: ${args[0] ?? 'unknown'}`);
  }
}

function runGitAllowFailure(prepared: GitFilesystemPrepared, args: readonly string[]): string {
  try {
    return runGit(prepared, args).trim();
  } catch {
    return '';
  }
}

function assertPrepared(prepared: GitFilesystemPrepared): void {
  if (prepared.cleaned || !existsSync(prepared.workspacePath)) throw new Error('adapter workspace is unavailable');
  if (prepared.ownsWorkspace) {
    assertContained(prepared.workspacePath, prepared.temporaryRoot, 'workspace');
  } else {
    assertInPlaceIdentity(prepared);
  }
}

function resetInPlaceGit(prepared: GitFilesystemPrepared, expected: GitFilesystemResetBaseline): void {
  runGit(prepared, ['checkout', '--detach', expected.head]);
  runGit(prepared, ['reset', '--hard', expected.head]);
  runGit(prepared, ['clean', '-ffdx', '--']);
  const currentBranches = Object.keys(captureRefs(prepared));
  for (const branch of currentBranches.filter((name) => expected.refs[name] === undefined)) {
    runGit(prepared, ['branch', '-D', branch]);
  }
  for (const [branch, objectId] of Object.entries(expected.refs)) {
    runGit(prepared, ['branch', '-f', branch, objectId]);
  }
  if (expected.currentBranch !== null) runGit(prepared, ['checkout', expected.currentBranch]);
  else runGit(prepared, ['checkout', '--detach', expected.head]);
  runGit(prepared, ['reset', '--hard', expected.head]);
}

function captureResetBaseline(prepared: GitFilesystemPrepared): GitFilesystemResetBaseline {
  return {
    currentBranch: runGitAllowFailure(prepared, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null,
    head: runGit(prepared, ['rev-parse', '--verify', 'HEAD^{commit}']).trim(),
    refs: sortedRecord(captureRefs(prepared)),
  };
}

function resetInPlaceFilesystem(prepared: GitFilesystemPrepared): void {
  assertInPlaceIdentity(prepared);
  for (const name of readdirSync(prepared.workspacePath)) {
    rmSync(join(prepared.workspacePath, name), { recursive: true, force: false });
  }
  copyDirectoryContents(prepared.baselineBackupPath!, prepared.workspacePath, prepared.configuration);
}

function captureRefs(prepared: GitFilesystemPrepared): Record<string, string> {
  return Object.fromEntries(
    lines(runGit(prepared, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads']))
      .map((line) => line.split('\t') as [string, string]),
  );
}

function assertInPlaceIdentity(prepared: GitFilesystemPrepared): void {
  const identity = statSync(prepared.workspacePath);
  if (identity.dev !== prepared.workspaceDevice || identity.ino !== prepared.workspaceInode) {
    throw new Error('refusing operation after in-place workspace identity changed');
  }
}

function assertContained(path: string, root: string, label: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error(`${label} is outside its disposable root`);
}

function exactPath(root: string, path: string): string {
  const resolved = resolve(root, path);
  const rel = relative(resolve(root), resolved);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('path leaves workspace');
  return resolved;
}

function assertNoSymbolicLinkParents(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  const parts = rel === '' ? [] : rel.split(sep);
  let current = resolve(root);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) throw new Error('snapshot path traverses a symbolic-link parent');
  }
}

function assertResolvedInsideWorkspace(root: string, path: string): void {
  const rel = relative(realpathSync(root), realpathSync(path));
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error('snapshot path resolves outside workspace');
  }
}

function requireSafeRelativePath(path: string, label: string): string {
  if (path === '.') return path;
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} must be a safe workspace-relative path`);
  }
  return path;
}

function requireSafeRef(ref: string): string {
  if (ref.startsWith('-') || ref.includes('..') || ref.includes('@{') || ref.includes('\\') || /[\s~^:?*[\]]/.test(ref)) {
    throw new Error('Git ref is unsafe');
  }
  return ref;
}

function closestAncestorRef(
  descendant: string,
  candidates: string[],
  refs: Record<string, string>,
  commits: Record<string, string[]>,
): string | null {
  const distances = distancesFrom(descendant, commits);
  const matches = candidates
    .map((name) => ({ name, distance: distances.get(refs[name]!) }))
    .filter((entry): entry is { name: string; distance: number } => entry.distance !== undefined)
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name));
  return matches[0]?.name ?? null;
}

function distancesFrom(start: string, commits: Record<string, string[]>): Map<string, number> {
  const result = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const distance = result.get(current)!;
    for (const parent of commits[current] ?? []) {
      if (!result.has(parent)) {
        result.set(parent, distance + 1);
        queue.push(parent);
      }
    }
  }
  return result;
}

function reachable(start: string, commits: Record<string, string[]>): Set<string> {
  return new Set(distancesFrom(start, commits).keys());
}

function sortedRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeRelative(path: string): string {
  return path === '' ? '.' : path.split(sep).join('/');
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function nul(value: string): string[] {
  return value.split('\0').filter(Boolean).sort();
}

function safeObservedPaths(paths: string[]): string[] {
  return paths.filter((path) => !isSecretShapedName(path));
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function requireWatchedBranch(snapshot: NormalizedGitFilesystemSnapshot, branch: string): void {
  if (!snapshot.watchBranches.includes(branch)) throw new Error('selector branch is outside the configured watch scope');
}

function requireWatchedPath(snapshot: NormalizedGitFilesystemSnapshot, path: string, allowAncestor: boolean): void {
  const watched = snapshot.watchPaths.some((scope) => pathWithin(path, scope) || allowAncestor && pathWithin(scope, path));
  if (!watched) throw new Error('selector path is outside the configured watch scope');
}

function pathWithin(path: string, scope: string): boolean {
  return scope === '.' || path === scope || path.startsWith(`${scope}/`);
}

function safeSymlinkTarget(target: string): string {
  const normalized = target.replaceAll('\\', '/');
  if (isAbsolute(target) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) return '<absolute-target>';
  if (normalized.split('/').some((part) => part === '..')) return '<outside-target>';
  return isSecretShapedName(normalized) ? '<redacted-target>' : target;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function minimalPaths(values: readonly string[]): string[] {
  const sorted = unique(values);
  return sorted.filter((path) => !sorted.some((candidate) => candidate !== path && pathWithin(path, candidate)));
}
