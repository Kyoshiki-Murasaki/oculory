import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { stringify } from 'yaml';
import { parseContractConfig } from './config.js';
import { assertPublicWritablePath } from './path-policy.js';
import { PublicRunStore } from './run-store.js';
import type { ContractAssertion, OculoryContractConfig } from './types.js';
import type { PublicRunSummary, TargetRunEvidence } from './record.js';

export interface ApproveRunOptions {
  store?: PublicRunStore;
  cwd?: string;
  yes?: boolean;
  force?: boolean;
}

export interface ApprovedContractDraft {
  path: string;
  contract: OculoryContractConfig;
  source: string;
}

export async function approveRun(runId: string, options: ApproveRunOptions = {}): Promise<ApprovedContractDraft> {
  const store = options.store ?? new PublicRunStore();
  store.verify(runId);
  const summary = store.readJson<PublicRunSummary>(runId, 'summary.json');
  if (summary.classification === 'infrastructure-failed') throw new Error(`cannot approve infrastructure-failed run ${runId}`);
  if (summary.observed_state.status !== 'available') throw new Error(`cannot approve ${runId}: independently observed state is unavailable`);
  const targets = loadTargets(store, runId, summary);
  const assertions = targets.flatMap(draftTargetAssertions);
  if (assertions.length === 0) throw new Error(`run ${runId} contains no stable outcome facts within the configured watch scope`);

  const contract: OculoryContractConfig = {
    version: 'oculory-contract-v1',
    task: summary.task_id,
    tolerance: { runs: 12, min_pass: 10 },
    assertions: uniqueAssertions(assertions),
  };
  const source =
    '# Drafted deterministically from one approved run. Review every assertion before replay.\n' +
    stringify(contract, { lineWidth: 80, indent: 2 });
  parseContractConfig(source);

  const cwd = resolve(options.cwd ?? process.cwd());
  const directory = resolve(cwd, 'oculory.contracts');
  const path = resolve(directory, `${summary.task_id}.yaml`);
  if (dirname(path) !== directory) throw new Error('contract path escapes oculory.contracts');
  assertTrackedLocation(cwd, path);
  if (existsSync(path) && options.force !== true) throw new Error(`contract already exists at ${relativeDisplay(cwd, path)}; pass --force to replace it`);
  if (options.yes !== true) {
    if (!input.isTTY || !output.isTTY) throw new Error('approval requires an interactive terminal or --yes');
    const terminal = createInterface({ input, output });
    try {
      const answer = await terminal.question(`Write ${relativeDisplay(cwd, path)}? [y/N] `);
      if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error('approval cancelled');
    } finally {
      terminal.close();
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  assertTrackedLocation(cwd, path);
  atomicContractWrite(path, source, options.force === true);
  return { path, contract, source };
}

function loadTargets(store: PublicRunStore, runId: string, summary: PublicRunSummary): TargetRunEvidence[] {
  return store.listJsonFiles(runId, 'diffs')
    .map((name) => basename(name, '.json'))
    .sort()
    .map((id) => ({
      id,
      adapter: inferAdapter(store, runId, id, summary),
      before: store.readJson(runId, `snapshots/${id}-before.json`),
      after: store.readJson(runId, `snapshots/${id}-after.json`),
      diff: store.readJson(runId, `diffs/${id}.json`),
      error: null,
    }));
}

function inferAdapter(store: PublicRunStore, runId: string, id: string, summary: PublicRunSummary): string {
  const evidence = store.readJson<Array<{ id?: unknown; adapter?: unknown }>>(runId, 'target-index.json');
  const entry = evidence.find((target) => target.id === id);
  if (entry === undefined || typeof entry.adapter !== 'string') throw new Error(`run ${summary.run_id} has no adapter metadata for target ${id}`);
  return entry.adapter;
}

function draftTargetAssertions(target: TargetRunEvidence): ContractAssertion[] {
  if (target.adapter === 'git-filesystem') return draftGitFilesystem(target);
  if (target.adapter === 'postgres') return draftPostgres(target);
  if (target.adapter === 'github-api') return draftGitHub(target);
  return [];
}

function draftGitFilesystem(target: TargetRunEvidence): ContractAssertion[] {
  const before = object(target.before);
  const after = object(target.after);
  const diff = object(target.diff);
  const assertions: ContractAssertion[] = [];
  for (const branch of strings(diff.addedBranches)) {
    assertions.push(assertion(target.id, `branch-${branch}-exists`, { kind: 'branch', branch }, 'exists', true));
    const base = closestBase(branch, after);
    if (base !== null) assertions.push(assertion(target.id, `branch-${branch}-base`, { kind: 'branch_base', branch }, 'equals', base));
  }
  for (const branch of strings(diff.changedBranches)) {
    assertions.push(assertion(target.id, `branch-${branch}-exists`, { kind: 'branch', branch }, 'exists', true));
    const base = closestBase(branch, after);
    if (base !== null) assertions.push(assertion(target.id, `branch-${branch}-base`, { kind: 'branch_base', branch }, 'equals', base));
  }
  for (const branch of strings(diff.removedBranches)) {
    assertions.push(assertion(target.id, `branch-${branch}-absent`, { kind: 'branch', branch }, 'none', null));
  }
  if (before.currentBranch !== after.currentBranch && typeof after.currentBranch === 'string') {
    assertions.push(assertion(target.id, 'current-branch', { kind: 'current_branch' }, 'equals', after.currentBranch));
  }
  draftGitStatus(assertions, target.id, 'staged', after.stagedFiles);
  draftGitStatus(assertions, target.id, 'unstaged', after.unstagedFiles);
  draftGitStatus(assertions, target.id, 'untracked', after.untrackedFiles);
  if (typeof after.clean === 'boolean') {
    assertions.push(assertion(target.id, 'clean-tree', { kind: 'clean_tree' }, 'equals', after.clean));
  }
  for (const path of strings(diff.addedPaths)) {
    if (volatilePath(path)) continue;
    assertions.push(assertion(target.id, `file-${path}-exists`, { kind: 'file', path }, 'exists', true));
    const digest = fileDigest(after, path);
    if (digest !== null) assertions.push(assertion(target.id, `file-${path}-digest`, { kind: 'file_digest', path }, 'equals', digest));
  }
  for (const path of strings(diff.removedPaths)) {
    if (!volatilePath(path)) assertions.push(assertion(target.id, `file-${path}-absent`, { kind: 'file', path }, 'none', null));
  }
  for (const path of strings(diff.changedPaths)) {
    if (volatilePath(path)) continue;
    const digest = fileDigest(after, path);
    if (digest === null) assertions.push(assertion(target.id, `file-${path}-exists`, { kind: 'file', path }, 'exists', true));
    else assertions.push(assertion(target.id, `file-${path}-digest`, { kind: 'file_digest', path }, 'equals', digest));
  }
  return assertions;
}

function draftGitStatus(
  assertions: ContractAssertion[],
  target: string,
  status: 'staged' | 'unstaged' | 'untracked',
  value: unknown,
): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return;
  assertions.push(value.length === 0
    ? assertion(target, `no-${status}-files`, { kind: `${status}_files` }, 'none', [])
    : assertion(target, `${status}-files`, { kind: `${status}_files` }, 'equals', json([...value].sort())));
}

function draftPostgres(target: TargetRunEvidence): ContractAssertion[] {
  const before = object(target.before);
  const after = object(target.after);
  const diff = object(target.diff);
  const assertions: ContractAssertion[] = [];
  const beforeTables = object(before.tables);
  const afterTables = object(after.tables);
  const changed = [...new Set([...strings(diff.changedTables), ...Object.keys(object(diff.rowCountChanges))])].sort();
  for (const table of changed) {
    const beforeTable = object(beforeTables[table]);
    const afterTable = object(afterTables[table]);
    if (afterTable.exists !== true) {
      assertions.push(assertion(target.id, `table-${table}-absent`, { kind: 'table', table }, 'none', null));
      continue;
    }
    assertions.push(assertion(target.id, `table-${table}-exists`, { kind: 'table', table }, 'exists', true));
    const rows = Array.isArray(afterTable.rows) ? afterTable.rows : [];
    assertions.push(assertion(target.id, `table-${table}-row-count`, { kind: 'row_count', table }, 'equals', rows.length));
    if (safeExpected(rows)) assertions.push(assertion(target.id, `table-${table}-rows`, { kind: 'rows', table }, 'equals', json(rows)));
    if (Array.isArray(afterTable.columns) && !same(beforeTable.columns, afterTable.columns)) {
      assertions.push(assertion(target.id, `table-${table}-columns`, { kind: 'columns', table }, 'equals', json(afterTable.columns)));
    }
  }
  return assertions;
}

function draftGitHub(target: TargetRunEvidence): ContractAssertion[] {
  const after = object(target.after);
  const diff = object(target.diff);
  const assertions: ContractAssertion[] = [];
  for (const number of numbers(diff.changedIssues)) {
    assertions.push(...draftGitHubResource(target.id, 'issue', number, object(object(after.issues)[String(number)])));
  }
  for (const number of numbers(diff.changedPullRequests)) {
    assertions.push(...draftGitHubResource(target.id, 'pull_request', number, object(object(after.pullRequests)[String(number)])));
  }
  for (const branch of strings(diff.changedBranches)) {
    const observed = object(object(after.branches)[branch]);
    if (observed.exists !== true) {
      assertions.push(assertion(target.id, `branch-${branch}-absent`, { kind: 'branch', branch }, 'none', null));
      continue;
    }
    assertions.push(assertion(target.id, `branch-${branch}-exists`, { kind: 'branch', branch }, 'exists', true));
    if (typeof observed.sha === 'string') assertions.push(assertion(target.id, `branch-${branch}-sha`, { kind: 'branch_field', branch, field: 'sha' }, 'equals', observed.sha));
    if (typeof observed.protected === 'boolean') assertions.push(assertion(target.id, `branch-${branch}-protected`, { kind: 'branch_field', branch, field: 'protected' }, 'equals', observed.protected));
    for (const [field, value] of Object.entries(object(observed.protection)).sort(([left], [right]) => left.localeCompare(right))) {
      if (!secretOrVolatile(field) && safeExpected(value)) {
        assertions.push(assertion(target.id, `branch-${branch}-protection-${field}`, { kind: 'branch_protection_field', branch, field }, 'equals', json(value)));
      }
    }
  }
  return assertions;
}

function draftGitHubResource(
  target: string,
  kind: 'issue' | 'pull_request',
  number: number,
  resource: Record<string, unknown>,
): ContractAssertion[] {
  const output: ContractAssertion[] = [];
  if (resource.exists !== true) {
    output.push(assertion(target, `${kind}-${number}-absent`, { kind, number }, 'none', null));
    return output;
  }
  output.push(assertion(target, `${kind}-${number}-exists`, { kind, number }, 'exists', true));
  for (const [field, value] of Object.entries(object(resource.fields)).sort(([left], [right]) => left.localeCompare(right))) {
    if (!secretOrVolatile(field) && safeExpected(value)) {
      output.push(assertion(target, `${kind}-${number}-${field}`, { kind: `${kind}_field`, number, field }, 'equals', json(value)));
    }
  }
  if (Array.isArray(resource.labels) && safeExpected(resource.labels)) {
    output.push(assertion(target, `${kind}-${number}-labels`, { kind: `${kind}_labels`, number }, 'equals', json(resource.labels)));
  }
  const comments = object(resource.comments);
  if (typeof comments.count === 'number') {
    output.push(assertion(target, `${kind}-${number}-comment-count`, { kind: `${kind}_comment_count`, number }, 'equals', comments.count));
  }
  if (Array.isArray(comments.entries) && comments.entries.every(safeExpected)) {
    output.push(assertion(target, `${kind}-${number}-comments`, { kind: `${kind}_comments`, number }, 'equals', json(comments.entries)));
  }
  return output;
}

function assertion(
  target: string,
  id: string,
  selector: ContractAssertion['selector'],
  operator: ContractAssertion['operator'],
  expected: ContractAssertion['expected'],
): ContractAssertion {
  return {
    id: slug(`${target}-${id}`),
    target,
    selector,
    operator,
    expected,
    evaluation: 'exact',
  };
}

function uniqueAssertions(assertions: ContractAssertion[]): ContractAssertion[] {
  const seen = new Map<string, number>();
  return assertions.map((entry) => {
    const count = (seen.get(entry.id) ?? 0) + 1;
    seen.set(entry.id, count);
    if (count === 1) return entry;
    const suffix = `-${count}`;
    return { ...entry, id: `${entry.id.slice(0, 64 - suffix.length)}${suffix}` };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function closestBase(branch: string, snapshot: Record<string, unknown>): string | null {
  const refs = object(snapshot.refs);
  const commits = object(snapshot.commits);
  const head = refs[branch];
  if (typeof head !== 'string') return null;
  const distances = new Map<string, number>([[head, 0]]);
  const queue = [head];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const parent of strings(commits[current])) {
      if (!distances.has(parent)) {
        distances.set(parent, distances.get(current)! + 1);
        queue.push(parent);
      }
    }
  }
  const candidates = strings(snapshot.baseRefs)
    .filter((name) => name !== branch && typeof refs[name] === 'string' && distances.has(refs[name] as string))
    .map((name) => ({ name, distance: distances.get(refs[name] as string)! }))
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name));
  return candidates[0]?.name ?? null;
}

function fileDigest(snapshot: Record<string, unknown>, path: string): string | null {
  if (!Array.isArray(snapshot.files)) return null;
  const entry = snapshot.files.find((candidate) => object(candidate).path === path);
  const digest = object(entry).sha256;
  return typeof digest === 'string' ? digest : null;
}

function volatilePath(path: string): boolean {
  return path.startsWith('.git/') || /(?:\.lock$|\.tmp$|^tmp\/)/.test(path) || secretOrVolatile(path);
}

function secretOrVolatile(value: string): boolean {
  return /(authorization|credential|password|secret|token|api[_-]?key|created_at|updated_at|timestamp)/i.test(value);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').sort() : [];
}

function records(value: unknown): Array<{ key: string; after?: unknown }> {
  const objectValue = object(value);
  return Object.keys(objectValue).sort().map((key) => ({ key, after: object(objectValue[key]).after }));
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => Number.isSafeInteger(entry) && entry > 0).sort((left, right) => left - right) : [];
}

function safeExpected(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return serialized.length <= 32_000 && !sensitiveObservation(value);
}

function sensitiveObservation(value: unknown): boolean {
  if (typeof value === 'string') {
    return secretOrVolatile(value) ||
      /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value) ||
      /^(?:<redacted>|<private-path>|\[REDACTED\]|\{private-path\})$/i.test(value) ||
      /(Bearer\s+[A-Za-z0-9._~+\/-]{8,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_)/i.test(value);
  }
  if (Array.isArray(value)) return value.some(sensitiveObservation);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .some(([key, entry]) => secretOrVolatile(key) || sensitiveObservation(entry));
  }
  return false;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function json(value: unknown): ContractAssertion['expected'] {
  return JSON.parse(JSON.stringify(value)) as ContractAssertion['expected'];
}

function slug(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, '');
  return safe.length > 0 ? safe : 'assertion';
}

function assertTrackedLocation(cwd: string, path: string): void {
  assertPublicWritablePath(path, 'contract location');
  if (path.includes(`${join('', '.oculory')}`)) throw new Error('contracts must not be written inside evidence storage');
  const relativePath = relativeDisplay(cwd, path);
  const worktree = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: minimalGitEnvironment(),
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (worktree.error !== undefined || worktree.status !== 0 || worktree.stdout.trim().length === 0) {
    throw new Error('contract location must be inside a Git worktree');
  }
  const worktreeRoot = realpathSync.native(worktree.stdout.trim());
  const canonicalCwd = realpathSync.native(cwd);
  if (!inside(worktreeRoot, canonicalCwd)) throw new Error('contract location must be inside a Git worktree');
  const directory = dirname(path);
  if (existsSync(directory) && !lstatSync(directory).isDirectory()) {
    throw new Error('contract directory must be a real directory inside the Git worktree');
  }
  const existingParent = existsSync(directory) ? directory : dirname(directory);
  if (!inside(worktreeRoot, realpathSync.native(existingParent))) {
    throw new Error('contract directory must remain inside the Git worktree');
  }
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('contract path must be a regular file');
  const result = spawnSync('git', ['check-ignore', '--quiet', '--', relativePath], {
    cwd,
    shell: false,
    stdio: 'ignore',
    env: minimalGitEnvironment(),
    timeout: 5_000,
  });
  if (result.error !== undefined) throw new Error('could not verify whether the contract location is tracked');
  if (result.status === 0) throw new Error(`contract location is ignored by Git: ${relativePath}`);
  if (result.status !== 1) throw new Error('could not verify whether the contract location is tracked');
}

function minimalGitEnvironment(): Record<string, string> {
  const env: Record<string, string> = { LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  return env;
}

function atomicContractWrite(path: string, source: string, replace: boolean): void {
  if (!lstatSync(dirname(path)).isDirectory()) throw new Error('contract directory must be a real directory inside the Git worktree');
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o644);
    writeFileSync(descriptor, source, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (replace && existsSync(path)) rmSync(path);
    renameSync(temporary, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function relativeDisplay(cwd: string, path: string): string {
  const display = relative(cwd, path);
  if (display === '..' || display.startsWith(`..${sep}`) || isAbsolute(display)) return '<external-contract>';
  return display.split(sep).join('/');
}

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
