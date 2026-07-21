import { isAbsolute } from 'node:path';
import type { ContractAssertion, Json, JsonObject, TargetConfig } from '../types.js';

const OPERATORS = new Set(['exists', 'equals', 'count', 'unchanged', 'none', 'subset']);
const EVALUATIONS = new Set(['exact', 'subset', 'ignore']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const ISSUE_FIELDS = new Set(['title', 'state', 'body', 'locked', 'labels']);
const PULL_REQUEST_FIELDS = new Set(['title', 'state', 'body', 'draft', 'merged', 'base', 'head', 'labels']);
const PROTECTION_FIELDS = new Set([
  'required_status_checks',
  'enforce_admins',
  'required_pull_request_reviews',
  'restrictions',
  'required_linear_history',
  'allow_force_pushes',
  'allow_deletions',
  'required_conversation_resolution',
  'block_creations',
  'lock_branch',
  'allow_fork_syncing',
]);

interface SelectorShape {
  required?: readonly string[];
  optional?: readonly string[];
}

const GIT_SHAPES: Readonly<Record<string, SelectorShape>> = {
  branch: { required: ['branch'] },
  branch_base: { required: ['branch'] },
  current_branch: {},
  commit_count: { optional: ['ref'] },
  commit_ancestry: { required: ['ancestor', 'descendant'] },
  staged_files: {},
  unstaged_files: {},
  untracked_files: {},
  file: { required: ['path'] },
  file_digest: { required: ['path'] },
  directory_tree: { optional: ['path'] },
  path_count: { optional: ['path'] },
  clean_tree: {},
};

const GIT_ONLY_SELECTORS = new Set([
  'branch',
  'branch_base',
  'current_branch',
  'commit_count',
  'commit_ancestry',
  'staged_files',
  'unstaged_files',
  'untracked_files',
  'clean_tree',
]);

const POSTGRES_SHAPES: Readonly<Record<string, SelectorShape>> = {
  table: { required: ['table'], optional: ['schema'] },
  row_count: { required: ['table'], optional: ['schema', 'where'] },
  rows: { required: ['table'], optional: ['schema', 'where', 'columns'] },
  unexpected_rows: { required: ['table'], optional: ['schema', 'where', 'columns'] },
  cell: { required: ['table', 'column'], optional: ['schema', 'where'] },
  columns: { required: ['table'], optional: ['schema', 'columns'] },
};

const GITHUB_SHAPES: Readonly<Record<string, SelectorShape>> = {
  issue: { required: ['number'] },
  issue_field: { required: ['number', 'field'] },
  issue_labels: { required: ['number'] },
  issue_comment_count: { required: ['number'] },
  issue_comments: { required: ['number'] },
  pull_request: { required: ['number'] },
  pull_request_field: { required: ['number', 'field'] },
  pull_request_labels: { required: ['number'] },
  pull_request_comment_count: { required: ['number'] },
  pull_request_comments: { required: ['number'] },
  branch: { required: ['branch'] },
  branch_field: { required: ['branch', 'field'] },
  branch_protection: { required: ['branch'] },
  branch_protection_field: { required: ['branch', 'field'] },
};

export function assertAdapterAssertionPreflight(target: TargetConfig, assertion: ContractAssertion): void {
  try {
    assertUniformAssertion(assertion);
    if (target.adapter === 'git-filesystem') assertGitAssertion(target, assertion);
    else if (target.adapter === 'postgres') assertPostgresAssertion(target, assertion);
    else if (target.adapter === 'github-api') assertGitHubAssertion(target, assertion);
  } catch (error) {
    const assertionId = safeId(assertion.id);
    const targetId = safeId(target.id);
    const detail = error instanceof Error ? error.message : 'assertion preflight failed';
    throw new Error(`contract assertion '${assertionId}' for target '${targetId}' is invalid: ${detail}`);
  }
}

function assertUniformAssertion(assertion: ContractAssertion): void {
  if (!OPERATORS.has(assertion.operator)) throw new Error('operator is unsupported');
  if (!EVALUATIONS.has(assertion.evaluation)) throw new Error('evaluation mode is unsupported');
  if (!Object.hasOwn(assertion, 'expected') || assertion.expected === undefined) {
    throw new Error('expected is required, including when its value is null');
  }
  if (assertion.operator === 'exists' && typeof assertion.expected !== 'boolean') {
    throw new Error('operator exists requires a boolean expected value');
  }
  if (assertion.operator === 'count' && (!Number.isSafeInteger(assertion.expected) || Number(assertion.expected) < 0)) {
    throw new Error('operator count requires a non-negative integer expected value');
  }
}

function assertGitAssertion(target: TargetConfig, assertion: ContractAssertion): void {
  const { selector, kind } = selectorShape(assertion.selector, GIT_SHAPES, 'Git/filesystem');
  const mode = target.configuration.mode ?? 'git';
  if (mode !== 'git' && mode !== 'filesystem') throw new Error('target configuration.mode must be git or filesystem');
  if (mode === 'filesystem' && GIT_ONLY_SELECTORS.has(kind)) {
    throw new Error(`selector.kind '${kind}' is unavailable in filesystem mode`);
  }
  const watchedPaths = stringArray(target.watch.paths, 'target watch.paths', 1);
  watchedPaths.forEach((path) => safeRelativePath(path, 'target watch.paths'));
  const watchedBranches = mode === 'git' ? stringArray(target.watch.branches, 'target watch.branches', 1) : [];
  watchedBranches.forEach((branch) => safeRef(branch, 'target watch.branches'));

  if (kind === 'branch' || kind === 'branch_base') {
    requireWatchedBranch(stringField(selector, 'branch'), watchedBranches);
  } else if (kind === 'commit_count') {
    const ref = selector.ref === undefined ? 'HEAD' : stringField(selector, 'ref');
    safeRef(ref, 'selector.ref');
    if (ref !== 'HEAD') requireWatchedBranch(ref, watchedBranches);
  } else if (kind === 'commit_ancestry') {
    requireWatchedBranch(stringField(selector, 'ancestor'), watchedBranches);
    requireWatchedBranch(stringField(selector, 'descendant'), watchedBranches);
  } else if (kind === 'file' || kind === 'file_digest') {
    requireWatchedPath(stringField(selector, 'path'), watchedPaths, false);
  } else if (kind === 'directory_tree' || kind === 'path_count') {
    const path = selector.path === undefined ? '.' : stringField(selector, 'path');
    requireWatchedPath(path, watchedPaths, true);
  }
}

function assertPostgresAssertion(target: TargetConfig, assertion: ContractAssertion): void {
  const { selector } = selectorShape(assertion.selector, POSTGRES_SHAPES, 'Postgres');
  const sourceSchema = identifier(target.configuration.sourceSchema, 'target configuration.sourceSchema');
  if (selector.schema !== undefined && identifier(selector.schema, 'selector.schema') !== sourceSchema) {
    throw new Error('selector.schema is outside the configured schema allowlist');
  }
  const watchedTables = stringArray(target.watch.tables, 'target watch.tables', 1).map((value) => identifier(value, 'target watch.tables'));
  const tableName = identifier(selector.table, 'selector.table');
  if (!watchedTables.includes(tableName)) throw new Error('selector.table is outside target watch.tables');
  const configuredColumns = postgresTableColumns(target.configuration, tableName);

  if (selector.where !== undefined) {
    const where = objectField(selector, 'where');
    for (const column of Object.keys(where)) {
      identifier(column, 'selector.where column');
      if (!configuredColumns.has(column)) throw new Error('selector.where uses a column outside the configured allowlist');
    }
  }
  if (selector.columns !== undefined) {
    for (const column of stringArray(selector.columns, 'selector.columns', 1)) {
      identifier(column, 'selector.columns');
      if (!configuredColumns.has(column)) throw new Error('selector.columns uses a column outside the configured allowlist');
    }
  }
  if (selector.column !== undefined) {
    const column = identifier(selector.column, 'selector.column');
    if (!configuredColumns.has(column)) throw new Error('selector.column is outside the configured allowlist');
  }
}

function assertGitHubAssertion(target: TargetConfig, assertion: ContractAssertion): void {
  const { selector, kind } = selectorShape(assertion.selector, GITHUB_SHAPES, 'GitHub');
  const watchedIssues = optionalPositiveIntegers(target.watch.issues, 'target watch.issues');
  const watchedPullRequests = optionalPositiveIntegers(target.watch.pullRequests, 'target watch.pullRequests');
  const watchedBranches = optionalStringArray(target.watch.branches, 'target watch.branches');
  const configuredIssues = optionalPositiveIntegers(target.configuration.issueNumbers, 'target configuration.issueNumbers');
  const configuredPullRequests = optionalPositiveIntegers(target.configuration.pullRequestNumbers, 'target configuration.pullRequestNumbers');
  const configuredBranches = optionalStringArray(target.configuration.branchNames, 'target configuration.branchNames');
  if (watchedIssues.some((number) => watchedPullRequests.includes(number))) {
    throw new Error('target watch issues and pull requests must not overlap');
  }

  const issueFields = selectedFields(target.configuration.issueFields, ISSUE_FIELDS, 'target configuration.issueFields');
  const pullRequestFields = selectedFields(target.configuration.pullRequestFields, PULL_REQUEST_FIELDS, 'target configuration.pullRequestFields');
  const protectionFields = selectedFields(target.configuration.branchProtectionFields, PROTECTION_FIELDS, 'target configuration.branchProtectionFields');
  const commentMode = target.configuration.commentMode ?? 'digest';
  if (commentMode !== 'none' && commentMode !== 'body' && commentMode !== 'digest') {
    throw new Error('target configuration.commentMode is invalid');
  }

  if (kind.startsWith('issue')) {
    const number = positiveInteger(selector.number, 'selector.number');
    requireWatchedNumber(number, watchedIssues, configuredIssues, 'issue');
    assertGitHubResourceField(kind, selector, issueFields, commentMode, 'issue');
    return;
  }
  if (kind.startsWith('pull_request')) {
    const number = positiveInteger(selector.number, 'selector.number');
    requireWatchedNumber(number, watchedPullRequests, configuredPullRequests, 'pull request');
    assertGitHubResourceField(kind, selector, pullRequestFields, commentMode, 'pull request');
    return;
  }

  const branch = stringField(selector, 'branch');
  safeRef(branch, 'selector.branch');
  if (!watchedBranches.includes(branch)) throw new Error('selector.branch is outside target watch.branches');
  if (!configuredBranches.includes(branch)) throw new Error('target watch branch is outside configuration.branchNames');
  if (kind === 'branch_field') {
    const field = stringField(selector, 'field');
    if (field !== 'sha' && field !== 'protected') throw new Error('selector.field must be sha or protected');
  } else if (kind === 'branch_protection') {
    if (protectionFields.length === 0) throw new Error('branch protection is outside the configured field allowlist');
  } else if (kind === 'branch_protection_field') {
    const field = stringField(selector, 'field');
    if (!protectionFields.includes(field)) throw new Error('selector.field is outside configuration.branchProtectionFields');
  }
}

function assertGitHubResourceField(
  kind: string,
  selector: JsonObject,
  fields: string[],
  commentMode: Json,
  label: string,
): void {
  if (kind.endsWith('_field')) {
    const field = stringField(selector, 'field');
    if (field === 'labels' || !fields.includes(field)) throw new Error(`selector.field is outside the configured ${label} field allowlist`);
  } else if (kind.endsWith('_labels') && !fields.includes('labels')) {
    throw new Error(`${label} labels are outside the configured field allowlist`);
  } else if (kind.endsWith('_comments') && commentMode === 'none') {
    throw new Error(`${label} comments are unavailable when commentMode is none`);
  }
}

function selectorShape(
  value: JsonObject,
  shapes: Readonly<Record<string, SelectorShape>>,
  adapter: string,
): { selector: JsonObject; kind: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('selector must be an object');
  const kind = stringField(value, 'kind');
  const shape = shapes[kind];
  if (shape === undefined) throw new Error(`${adapter} selector.kind is unsupported`);
  const required = shape.required ?? [];
  const allowed = new Set(['kind', ...required, ...(shape.optional ?? [])]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('selector has an unknown field');
  for (const field of required) if (!Object.hasOwn(value, field)) throw new Error(`selector.${field} is required`);
  return { selector: value, kind };
}

function postgresTableColumns(configuration: JsonObject, selectedTable: string): Set<string> {
  if (!Array.isArray(configuration.tables) || configuration.tables.length === 0 || configuration.tables.length > 64) {
    throw new Error('target configuration.tables must be a bounded non-empty array');
  }
  const tables = new Map<string, Set<string>>();
  for (const value of configuration.tables) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('target configuration.tables contains an invalid entry');
    const name = identifier(value.name, 'target configuration.tables.name');
    if (tables.has(name)) throw new Error('target configuration.tables contains a duplicate name');
    const columns = stringArray(value.columns, 'target configuration.tables.columns', 1).map((column) => identifier(column, 'target configuration.tables.columns'));
    tables.set(name, new Set(columns));
  }
  const selected = tables.get(selectedTable);
  if (selected === undefined) throw new Error('target watch table is outside configuration.tables');
  return selected;
}

function selectedFields(value: Json | undefined, allowed: ReadonlySet<string>, label: string): string[] {
  const fields = optionalStringArray(value, label);
  if (fields.some((field) => !allowed.has(field))) throw new Error(`${label} contains an unsupported field`);
  return fields;
}

function requireWatchedBranch(branch: string, watched: string[]): void {
  safeRef(branch, 'selector branch');
  if (!watched.includes(branch)) throw new Error('selector branch is outside target watch.branches');
}

function requireWatchedPath(path: string, watched: string[], allowAncestor: boolean): void {
  safeRelativePath(path, 'selector.path');
  const within = watched.some((scope) => pathWithin(path, scope) || allowAncestor && pathWithin(scope, path));
  if (!within) throw new Error('selector.path is outside target watch.paths');
}

function requireWatchedNumber(number: number, watched: number[], configured: number[], label: string): void {
  if (!watched.includes(number)) throw new Error(`selector.number is outside target watch ${label} scope`);
  if (!configured.includes(number)) throw new Error(`target watch ${label} is outside its configuration allowlist`);
}

function stringField(value: JsonObject, key: string): string {
  const selected = value[key];
  if (typeof selected !== 'string' || selected.length === 0 || Buffer.byteLength(selected, 'utf8') > 1024) {
    throw new Error(`selector.${key} must be a bounded non-empty string`);
  }
  return selected;
}

function objectField(value: JsonObject, key: string): JsonObject {
  const selected = value[key];
  if (selected === null || typeof selected !== 'object' || Array.isArray(selected)) throw new Error(`selector.${key} must be an object`);
  return selected;
}

function stringArray(value: Json | undefined, label: string, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 128 || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`${label} must be a bounded string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return value as string[];
}

function optionalStringArray(value: Json | undefined, label: string): string[] {
  return value === undefined ? [] : stringArray(value, label, 0);
}

function optionalPositiveIntegers(value: Json | undefined, label: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || value.some((entry) => !Number.isSafeInteger(entry) || Number(entry) <= 0)) {
    throw new Error(`${label} must be a bounded positive-integer array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return value as number[];
}

function positiveInteger(value: Json | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function identifier(value: Json | undefined, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function safeRef(value: string, label: string): void {
  if (value.startsWith('-') || value.includes('..') || value.includes('@{') || value.includes('\\') || /[\s~^:?*[\]]/.test(value)) {
    throw new Error(`${label} is unsafe`);
  }
}

function safeRelativePath(value: string, label: string): void {
  if (value === '.') return;
  if (isAbsolute(value) || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) || value.includes('\\') || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} must be a safe relative path`);
  }
}

function pathWithin(path: string, scope: string): boolean {
  return scope === '.' || path === scope || path.startsWith(`${scope}/`);
}

function safeId(value: unknown): string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : '<invalid>';
}
