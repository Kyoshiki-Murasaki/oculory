import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { canonicalJson, hashJson } from '../../schema/canonical.js';
import type { Json, JsonObject } from '../../schema/types.js';
import {
  readSentinelMetadata,
  runGitRaw,
  type GitSpikeFixture,
  type SentinelMetadata,
} from './fixture.js';

export type GitSpikeSnapshotLayer =
  | 'worktree'
  | 'status'
  | 'index'
  | 'head_and_refs'
  | 'commit_graph'
  | 'reflogs'
  | 'objects'
  | 'isolation'
  | 'lockfiles'
  | 'sibling_boundary';

export const GIT_SPIKE_SNAPSHOT_LAYERS = Object.freeze([
  'worktree',
  'status',
  'index',
  'head_and_refs',
  'commit_graph',
  'reflogs',
  'objects',
  'isolation',
  'lockfiles',
  'sibling_boundary',
] as const satisfies readonly GitSpikeSnapshotLayer[]);

export interface GitSpikePathTokenRoots {
  fixtureRoot: string;
  siblingRoot: string;
  trialRoot: string;
  fixtureRootAliases?: readonly string[];
  siblingRootAliases?: readonly string[];
  trialRootAliases?: readonly string[];
}

export interface GitWorktreeEntry {
  path: string;
  type: 'directory' | 'file' | 'symlink';
  mode: string;
  byteLength: number | null;
  sha256: string | null;
  symlinkTarget: string | null;
}

export interface GitIndexEntry {
  path: string;
  mode: string;
  objectId: string;
  stage: number;
  blobByteLength: number;
  blobSha256: string;
}

export interface GitRefEntry {
  name: string;
  objectId: string;
  objectType: string;
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: string;
  objectId: string;
  blobByteLength: number | null;
  blobSha256: string | null;
}

export interface GitCommitSemantic {
  objectId: string;
  treeId: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
  tree: GitTreeEntry[];
}

export interface GitReflogEntry {
  ref: string;
  oldObjectId: string;
  newObjectId: string;
  actorName: string;
  actorEmail: string;
  timestamp: string;
  timezone: string;
  action: string;
}

export interface GitObjectEntry {
  objectId: string;
  type: string;
  byteLength: number;
}

export interface GitConfigEntry {
  key: string;
  value: string;
}

export interface GitSiblingBoundarySnapshot {
  symbolicBranch: string;
  headObjectId: string;
  refs: GitRefEntry[];
  statusRecords: string[];
  index: GitIndexEntry[];
  objects: GitObjectEntry[];
  worktree: GitWorktreeEntry[];
  sentinel: SentinelMetadata;
}

export interface GitSpikeSnapshot {
  fixtureRecipeDigest: string;
  symbolicBranch: string;
  headObjectId: string;
  refs: GitRefEntry[];
  statusRecords: string[];
  clean: boolean;
  indexMatchesHead: boolean;
  worktree: GitWorktreeEntry[];
  index: GitIndexEntry[];
  commits: GitCommitSemantic[];
  reflogs: GitReflogEntry[];
  objects: GitObjectEntry[];
  config: GitConfigEntry[];
  remotes: string[];
  hooksPath: string;
  hooks: GitWorktreeEntry[];
  worktrees: string[];
  submodules: string[];
  alternates: string | null;
  lockfiles: string[];
  siblingBoundary: GitSiblingBoundarySnapshot;
  rawEvidence: {
    statusSha256: string;
    indexSha256: string;
    refsSha256: string;
    configSha256: string;
    worktreesSha256: string;
    reflogsSha256: string;
    siblingStatusSha256: string;
    sentinelMetadataSha256: string;
  };
  layerHashes: Readonly<Record<GitSpikeSnapshotLayer, string>>;
  stateHash: string;
}

export type GitSpikeSnapshotData = Omit<GitSpikeSnapshot, 'layerHashes' | 'stateHash'>;

export interface GitSpikeSnapshotDiff {
  beforeStateHash: string;
  afterStateHash: string;
  changedLayers: GitSpikeSnapshotLayer[];
  layerChanges: Partial<Record<GitSpikeSnapshotLayer, { before: string; after: string }>>;
  sentinelMetadataChanged: boolean;
  reflogRawEvidenceChanged: boolean;
}

export function captureGitSpikeSnapshot(fixture: GitSpikeFixture): GitSpikeSnapshot {
  const statusRaw = git(fixture, fixture.repositoryRoot, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  const indexRaw = git(fixture, fixture.repositoryRoot, ['ls-files', '--stage', '-z']);
  const refsRaw = git(fixture, fixture.repositoryRoot, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)%09%(objecttype)',
  ]);
  const configRaw = git(fixture, fixture.repositoryRoot, ['config', '--local', '--list', '--null']);
  const worktreesRaw = git(fixture, fixture.repositoryRoot, ['worktree', 'list', '--porcelain']);

  const symbolicBranch = gitText(fixture, fixture.repositoryRoot, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const headObjectId = gitText(fixture, fixture.repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const refs = parseRefs(refsRaw);
  const statusRecords = splitNul(statusRaw);
  const statusChanges = statusRecords.filter((record) => !record.startsWith('# '));
  const worktree = walkTree(fixture.repositoryRoot, '.git');
  const index = parseIndex(fixture, fixture.repositoryRoot, indexRaw);
  const commits = readCommitGraph(fixture, fixture.repositoryRoot);
  const objects = readObjectInventory(fixture, fixture.repositoryRoot);
  const reflogEvidence = readReflogs(fixture.gitDirectory);
  const config = parseConfig(configRaw).map((entry) => ({
    key: entry.key,
    value: tokenizeFixturePaths(entry.value, fixture),
  }));
  const remotes = nonemptyLines(git(fixture, fixture.repositoryRoot, ['remote', '-v']));
  const hooksPath = tokenizeFixturePaths(
    gitText(fixture, fixture.repositoryRoot, ['config', '--local', '--get', 'core.hooksPath']),
    fixture,
  );
  const hooks = walkTree(fixture.emptyHooksDirectory);
  const worktrees = normalizeWorktreeList(worktreesRaw, fixture);
  const submodules = gitAllowFailure(fixture, fixture.repositoryRoot, ['submodule', 'status', '--recursive']);
  const alternatePath = join(fixture.gitDirectory, 'objects', 'info', 'alternates');
  const alternates = existsSync(alternatePath)
    ? tokenizeFixturePaths(readFileSync(alternatePath, 'utf8'), fixture)
    : null;
  const lockfiles = findLockfiles(fixture.gitDirectory);
  const siblingBoundary = captureSiblingBoundary(fixture);
  const indexMatchesHead = git(fixture, fixture.repositoryRoot, ['diff', '--cached', '--name-only', '--']).length === 0;

  const snapshotData: GitSpikeSnapshotData = {
    fixtureRecipeDigest: fixture.seedRecipeDigest,
    symbolicBranch,
    headObjectId,
    refs,
    statusRecords,
    clean: statusChanges.length === 0,
    indexMatchesHead,
    worktree,
    index,
    commits,
    reflogs: reflogEvidence.entries,
    objects,
    config,
    remotes,
    hooksPath,
    hooks,
    worktrees,
    submodules,
    alternates,
    lockfiles,
    siblingBoundary,
    rawEvidence: {
      statusSha256: digest(statusRaw),
      indexSha256: digest(indexRaw),
      refsSha256: digest(refsRaw),
      configSha256: digest(configRaw),
      worktreesSha256: digest(worktreesRaw),
      reflogsSha256: reflogEvidence.rawDigest,
      siblingStatusSha256: digest(Buffer.from(siblingBoundary.statusRecords.join('\0'), 'utf8')),
      sentinelMetadataSha256: hashJson(siblingBoundary.sentinel as unknown as JsonObject),
    },
  };
  const layers = gitSpikeSemanticLayers(snapshotData);
  const layerHashes = Object.fromEntries(
    GIT_SPIKE_SNAPSHOT_LAYERS.map((name) => [name, hashJson(layers[name])]),
  ) as Record<GitSpikeSnapshotLayer, string>;
  const stateHash = hashJson({
    fixture_recipe_digest: fixture.seedRecipeDigest,
    layers: layers as unknown as JsonObject,
  });

  return { ...snapshotData, layerHashes, stateHash };
}

export function gitSpikeSemanticLayers(
  snapshot: GitSpikeSnapshotData,
): Readonly<Record<GitSpikeSnapshotLayer, Json>> {
  const semanticReflogs = snapshot.reflogs.map(stripReflogPresentation);
  const semanticSentinel = stripSentinelPresentation(snapshot.siblingBoundary.sentinel);
  return {
    worktree: snapshot.worktree as unknown as Json,
    status: {
      records: snapshot.statusRecords,
      clean: snapshot.clean,
      index_matches_head: snapshot.indexMatchesHead,
    },
    index: snapshot.index as unknown as Json,
    head_and_refs: {
      symbolic_branch: snapshot.symbolicBranch,
      head_object_id: snapshot.headObjectId,
      refs: snapshot.refs as unknown as Json,
    },
    commit_graph: snapshot.commits as unknown as Json,
    reflogs: semanticReflogs as unknown as Json,
    objects: snapshot.objects as unknown as Json,
    isolation: {
      config: snapshot.config as unknown as Json,
      remotes: snapshot.remotes,
      hooks_path: snapshot.hooksPath,
      hooks: snapshot.hooks as unknown as Json,
      worktrees: snapshot.worktrees,
      submodules: snapshot.submodules,
      alternates: snapshot.alternates,
    },
    lockfiles: snapshot.lockfiles,
    sibling_boundary: {
      symbolic_branch: snapshot.siblingBoundary.symbolicBranch,
      head_object_id: snapshot.siblingBoundary.headObjectId,
      refs: snapshot.siblingBoundary.refs as unknown as Json,
      status_records: snapshot.siblingBoundary.statusRecords,
      index: snapshot.siblingBoundary.index as unknown as Json,
      objects: snapshot.siblingBoundary.objects as unknown as Json,
      worktree: snapshot.siblingBoundary.worktree as unknown as Json,
      sentinel: semanticSentinel as unknown as Json,
    },
  };
}

export function diffGitSpikeSnapshots(
  before: GitSpikeSnapshot,
  after: GitSpikeSnapshot,
): GitSpikeSnapshotDiff {
  const changedLayers: GitSpikeSnapshotLayer[] = [];
  const layerChanges: GitSpikeSnapshotDiff['layerChanges'] = {};
  for (const name of GIT_SPIKE_SNAPSHOT_LAYERS) {
    if (before.layerHashes[name] === after.layerHashes[name]) continue;
    changedLayers.push(name);
    layerChanges[name] = { before: before.layerHashes[name], after: after.layerHashes[name] };
  }
  return {
    beforeStateHash: before.stateHash,
    afterStateHash: after.stateHash,
    changedLayers,
    layerChanges,
    sentinelMetadataChanged:
      canonicalJson(before.siblingBoundary.sentinel as unknown as JsonObject) !==
      canonicalJson(after.siblingBoundary.sentinel as unknown as JsonObject),
    reflogRawEvidenceChanged: before.rawEvidence.reflogsSha256 !== after.rawEvidence.reflogsSha256,
  };
}

export function changedIndexPaths(before: GitSpikeSnapshot, after: GitSpikeSnapshot): string[] {
  const beforeByPath = new Map(before.index.map((entry) => [`${entry.stage}:${entry.path}`, canonicalJson(entry as unknown as JsonObject)]));
  const afterByPath = new Map(after.index.map((entry) => [`${entry.stage}:${entry.path}`, canonicalJson(entry as unknown as JsonObject)]));
  return [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .filter((key) => beforeByPath.get(key) !== afterByPath.get(key))
    .map((key) => key.slice(key.indexOf(':') + 1))
    .sort();
}

export function changedRefNames(before: GitSpikeSnapshot, after: GitSpikeSnapshot): string[] {
  const beforeRefs = new Map(before.refs.map((entry) => [entry.name, entry.objectId]));
  const afterRefs = new Map(after.refs.map((entry) => [entry.name, entry.objectId]));
  return [...new Set([...beforeRefs.keys(), ...afterRefs.keys()])]
    .filter((name) => beforeRefs.get(name) !== afterRefs.get(name))
    .sort();
}

export function snapshotIndexMatchesCommit(snapshot: GitSpikeSnapshot, commitId: string): boolean {
  const commit = snapshot.commits.find((entry) => entry.objectId === commitId);
  if (commit === undefined) return false;
  const expected = commit.tree
    .filter((entry) => entry.type === 'blob')
    .map((entry) => ({ path: entry.path, mode: entry.mode, objectId: entry.objectId }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const actual = snapshot.index
    .filter((entry) => entry.stage === 0)
    .map((entry) => ({ path: entry.path, mode: entry.mode, objectId: entry.objectId }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return canonicalJson(expected as unknown as Json) === canonicalJson(actual as unknown as Json);
}

export function snapshotWorktreeMatchesCommit(snapshot: GitSpikeSnapshot, commitId: string): boolean {
  const commit = snapshot.commits.find((entry) => entry.objectId === commitId);
  if (commit === undefined) return false;
  const expected = commit.tree
    .filter((entry) => entry.type === 'blob')
    .map((entry) => ({ path: entry.path, byteLength: entry.blobByteLength, sha256: entry.blobSha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const actual = snapshot.worktree
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({ path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return canonicalJson(expected as unknown as Json) === canonicalJson(actual as unknown as Json);
}

function captureSiblingBoundary(fixture: GitSpikeFixture): GitSiblingBoundarySnapshot {
  const statusRaw = git(fixture, fixture.siblingRepositoryRoot, [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
  ]);
  const indexRaw = git(fixture, fixture.siblingRepositoryRoot, ['ls-files', '--stage', '-z']);
  const refsRaw = git(fixture, fixture.siblingRepositoryRoot, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)%09%(objecttype)',
  ]);
  return {
    symbolicBranch: gitText(fixture, fixture.siblingRepositoryRoot, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]),
    headObjectId: gitText(fixture, fixture.siblingRepositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    refs: parseRefs(refsRaw),
    statusRecords: splitNul(statusRaw),
    index: parseIndex(fixture, fixture.siblingRepositoryRoot, indexRaw),
    objects: readObjectInventory(fixture, fixture.siblingRepositoryRoot),
    worktree: walkTree(fixture.siblingRepositoryRoot, '.git'),
    sentinel: readSentinelMetadata(fixture.sentinelPath),
  };
}

function readCommitGraph(fixture: GitSpikeFixture, repositoryRoot: string): GitCommitSemantic[] {
  const ids = nonemptyLines(git(fixture, repositoryRoot, ['rev-list', '--all'])).sort();
  return ids.map((objectId) => {
    const metadata = git(fixture, repositoryRoot, [
      'show',
      '--no-patch',
      '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B',
      objectId,
    ]).toString('utf8').split('\0');
    if (metadata.length < 10) throw new Error(`unexpected commit metadata for ${objectId}`);
    const treeId = metadata[1]!.trim();
    return {
      objectId: metadata[0]!.trim(),
      treeId,
      parents: metadata[2]!.trim() === '' ? [] : metadata[2]!.trim().split(' '),
      authorName: metadata[3]!,
      authorEmail: metadata[4]!,
      authorDate: metadata[5]!,
      committerName: metadata[6]!,
      committerEmail: metadata[7]!,
      committerDate: metadata[8]!,
      message: metadata.slice(9).join('\0').replace(/\n+$/, ''),
      tree: parseTree(fixture, repositoryRoot, git(fixture, repositoryRoot, [
        'ls-tree',
        '-r',
        '-z',
        '--full-tree',
        treeId,
      ])),
    };
  });
}

function parseTree(fixture: GitSpikeFixture, repositoryRoot: string, raw: Buffer): GitTreeEntry[] {
  return splitNul(raw).map((record) => {
    const tab = record.indexOf('\t');
    const fields = record.slice(0, tab).split(' ');
    if (tab < 0 || fields.length !== 3) throw new Error(`invalid ls-tree record: ${record}`);
    const [mode, type, objectId] = fields as [string, string, string];
    let blob: Buffer | null = null;
    if (type === 'blob') blob = git(fixture, repositoryRoot, ['cat-file', 'blob', objectId]);
    return {
      path: record.slice(tab + 1),
      mode,
      type,
      objectId,
      blobByteLength: blob?.length ?? null,
      blobSha256: blob === null ? null : digest(blob),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function parseIndex(fixture: GitSpikeFixture, repositoryRoot: string, raw: Buffer): GitIndexEntry[] {
  return splitNul(raw).map((record) => {
    const tab = record.indexOf('\t');
    const fields = record.slice(0, tab).split(' ');
    if (tab < 0 || fields.length !== 3) throw new Error(`invalid ls-files record: ${record}`);
    const [mode, objectId, stageRaw] = fields as [string, string, string];
    const blob = git(fixture, repositoryRoot, ['cat-file', 'blob', objectId]);
    return {
      path: record.slice(tab + 1),
      mode,
      objectId,
      stage: Number(stageRaw),
      blobByteLength: blob.length,
      blobSha256: digest(blob),
    };
  }).sort((a, b) => a.path.localeCompare(b.path) || a.stage - b.stage);
}

function parseRefs(raw: Buffer): GitRefEntry[] {
  return nonemptyLines(raw).map((line) => {
    const [name, objectId, objectType] = line.split('\t');
    if (name === undefined || objectId === undefined || objectType === undefined) {
      throw new Error(`invalid for-each-ref record: ${line}`);
    }
    return { name, objectId, objectType };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function readObjectInventory(fixture: GitSpikeFixture, repositoryRoot: string): GitObjectEntry[] {
  return nonemptyLines(git(fixture, repositoryRoot, [
    'cat-file',
    '--batch-all-objects',
    '--batch-check=%(objectname) %(objecttype) %(objectsize)',
  ])).map((line) => {
    const [objectId, type, lengthRaw] = line.split(' ');
    if (objectId === undefined || type === undefined || lengthRaw === undefined) {
      throw new Error(`invalid object inventory record: ${line}`);
    }
    return { objectId, type, byteLength: Number(lengthRaw) };
  }).sort((a, b) => a.objectId.localeCompare(b.objectId));
}

function readReflogs(gitDirectory: string): { entries: GitReflogEntry[]; rawDigest: string } {
  const logsRoot = join(gitDirectory, 'logs');
  if (!existsSync(logsRoot)) return { entries: [], rawDigest: digest(Buffer.alloc(0)) };
  const files = walkFilePaths(logsRoot).sort();
  const rawManifest: { path: string; sha256: string }[] = [];
  const entries: GitReflogEntry[] = [];
  for (const path of files) {
    const bytes = readFileSync(path);
    const ref = relative(logsRoot, path).split('\\').join('/');
    rawManifest.push({ path: ref, sha256: digest(bytes) });
    for (const line of bytes.toString('utf8').split('\n').filter((value) => value.length > 0)) {
      const match = /^([0-9a-f]+) ([0-9a-f]+) (.+) <([^>]+)> ([0-9]+) ([+-][0-9]{4})\t(.*)$/.exec(line);
      if (match === null) throw new Error(`invalid reflog line in ${ref}`);
      entries.push({
        ref,
        oldObjectId: match[1]!,
        newObjectId: match[2]!,
        actorName: match[3]!,
        actorEmail: match[4]!,
        timestamp: match[5]!,
        timezone: match[6]!,
        action: match[7]!,
      });
    }
  }
  return {
    entries,
    rawDigest: hashJson(rawManifest as unknown as Json),
  };
}

function parseConfig(raw: Buffer): GitConfigEntry[] {
  return splitNul(raw).map((record) => {
    const separator = record.indexOf('\n');
    if (separator < 0) throw new Error(`invalid git config record: ${record}`);
    return { key: record.slice(0, separator), value: record.slice(separator + 1) };
  }).sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value));
}

function walkTree(root: string, ignoredTopLevelName?: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (directory === root && name === ignoredTopLevelName) continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      const relativePath = relative(root, path).split('\\').join('/');
      const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory', mode, byteLength: null, sha256: null, symlinkTarget: null });
        visit(path);
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        entries.push({
          path: relativePath,
          type: 'symlink',
          mode,
          byteLength: Buffer.byteLength(target, 'utf8'),
          sha256: digest(Buffer.from(target, 'utf8')),
          symlinkTarget: target,
        });
      } else if (stat.isFile()) {
        const bytes = readFileSync(path);
        entries.push({
          path: relativePath,
          type: 'file',
          mode,
          byteLength: bytes.length,
          sha256: digest(bytes),
          symlinkTarget: null,
        });
      } else {
        throw new Error(`unsupported filesystem entry in Git spike fixture: ${path}`);
      }
    }
  };
  visit(root);
  return entries;
}

function walkFilePaths(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (lstatSync(path).isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(root);
  return files;
}

function findLockfiles(gitDirectory: string): string[] {
  return walkFilePaths(gitDirectory)
    .map((path) => relative(gitDirectory, path).split('\\').join('/'))
    .filter((path) => path.endsWith('.lock'))
    .sort();
}

function stripReflogPresentation(entry: GitReflogEntry): JsonObject {
  return {
    ref: entry.ref,
    old_object_id: entry.oldObjectId,
    new_object_id: entry.newObjectId,
    actor_name: entry.actorName,
    actor_email: entry.actorEmail,
    action: entry.action,
  };
}

function stripSentinelPresentation(metadata: SentinelMetadata): JsonObject {
  return {
    byte_length: metadata.byteLength,
    sha256: metadata.sha256,
    mode: metadata.mode,
  };
}

export function tokenizeGitSpikePathPresentation(
  value: string,
  roots: GitSpikePathTokenRoots,
  platform: NodeJS.Platform = process.platform,
): string {
  const replacements = [
    ...[roots.fixtureRoot, ...(roots.fixtureRootAliases ?? [])].map((root) => ({ root, token: '<FIXTURE_ROOT>' })),
    ...[roots.siblingRoot, ...(roots.siblingRootAliases ?? [])].map((root) => ({ root, token: '<SIBLING_ROOT>' })),
    ...[roots.trialRoot, ...(roots.trialRootAliases ?? [])].map((root) => ({ root, token: '<TRIAL_ROOT>' })),
  ].map((entry) => ({ ...entry, root: portablePath(entry.root) }))
    .filter((entry) => entry.root.length > 0)
    .sort((a, b) => b.root.length - a.root.length || compareStrings(a.root, b.root));
  let result = portablePath(value);
  const seen = new Set<string>();
  for (const replacement of replacements) {
    const key = `${platform === 'win32' ? replacement.root.toLowerCase() : replacement.root}\0${replacement.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result = replaceRootOccurrences(result, replacement.root, replacement.token, platform === 'win32');
  }
  return result;
}

function tokenizeFixturePaths(value: string, fixture: GitSpikeFixture): string {
  return tokenizeGitSpikePathPresentation(value, {
    fixtureRoot: fixture.repositoryRoot,
    siblingRoot: fixture.siblingRepositoryRoot,
    trialRoot: fixture.trialRoot,
  });
}

function normalizeWorktreeList(raw: Buffer, fixture: GitSpikeFixture): string[] {
  return nonemptyLines(raw).map((line) => {
    if (!line.startsWith('worktree ')) return tokenizeFixturePaths(line, fixture);
    const reportedPath = line.slice('worktree '.length);
    const registrations = [
      { path: fixture.repositoryRoot, token: '<FIXTURE_ROOT>' },
      { path: fixture.siblingRepositoryRoot, token: '<SIBLING_ROOT>' },
      { path: fixture.trialRoot, token: '<TRIAL_ROOT>' },
    ] as const;
    const registered = registrations.find((entry) => samePhysicalEntry(reportedPath, entry.path));
    return `worktree ${registered?.token ?? tokenizeFixturePaths(reportedPath, fixture)}`;
  });
}

function samePhysicalEntry(a: string, b: string): boolean {
  try {
    const left = portablePath(realpathSync.native(a));
    const right = portablePath(realpathSync.native(b));
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  } catch {
    return false;
  }
}

function replaceRootOccurrences(value: string, root: string, token: string, caseInsensitive: boolean): string {
  const searchValue = caseInsensitive ? value.toLowerCase() : value;
  const searchRoot = caseInsensitive ? root.toLowerCase() : root;
  let result = '';
  let cursor = 0;
  while (cursor < value.length) {
    const index = searchValue.indexOf(searchRoot, cursor);
    if (index < 0) break;
    const end = index + root.length;
    if (isPathBoundaryBefore(value, index) && isPathBoundaryAfter(value, end)) {
      result += value.slice(cursor, index) + token;
      cursor = end;
    } else {
      result += value.slice(cursor, index + 1);
      cursor = index + 1;
    }
  }
  return result + value.slice(cursor);
}

function isPathBoundaryBefore(value: string, index: number): boolean {
  return index === 0 || /[\s"'=(:,]/.test(value[index - 1]!);
}

function isPathBoundaryAfter(value: string, index: number): boolean {
  return index === value.length || /[\s/"'),]/.test(value[index]!);
}

function portablePath(value: string): string {
  return value.split('\\').join('/');
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function git(fixture: GitSpikeFixture, repositoryRoot: string, args: readonly string[]): Buffer {
  return runGitRaw(fixture.gitExecutable, repositoryRoot, fixture.gitEnvironment, args);
}

function gitText(fixture: GitSpikeFixture, repositoryRoot: string, args: readonly string[]): string {
  return git(fixture, repositoryRoot, args).toString('utf8').trim();
}

function gitAllowFailure(fixture: GitSpikeFixture, repositoryRoot: string, args: readonly string[]): string[] {
  try {
    return nonemptyLines(git(fixture, repositoryRoot, args));
  } catch (error) {
    if (error instanceof Error && 'status' in error && (error as { status?: number }).status === 1) return [];
    throw error;
  }
}

function splitNul(raw: Buffer): string[] {
  return raw.toString('utf8').split('\0').filter((entry) => entry.length > 0);
}

function nonemptyLines(raw: Buffer | string): string[] {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  return text.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
