import { createHash } from 'node:crypto';
import {
  assertSupportedMode,
  evaluateObserved,
  equalJson,
  redactSecrets,
  rejectUnknownKeys,
  requireBoundedInteger,
  requireObject,
  requireString,
  requireStringArray,
  toAdapterJson,
} from './shared.js';
import type {
  AdapterAssertion,
  AdapterAssertionResult,
  AdapterJson,
  AdapterOperationResult,
  AdapterPrepareContext,
  OculoryAdapter,
} from './types.js';

export const GITHUB_API_ADAPTER_ID = 'github-api';
export const GITHUB_API_ADAPTER_VERSION = '1.0.0';

const SCOPE = /^[A-Za-z0-9_.-]{1,100}$/;
const TOKEN_ENV = /^[A-Z][A-Z0-9_]{0,127}$/;
const ISSUE_FIELDS = ['title', 'state', 'body', 'locked', 'labels'] as const;
const PULL_REQUEST_FIELDS = ['title', 'state', 'body', 'draft', 'merged', 'base', 'head', 'labels'] as const;
const PROTECTION_FIELDS = [
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
] as const;
const UNSUPPORTED_ISSUE_RESTORE_FIELDS = new Set(['locked']);
const UNSUPPORTED_PULL_REQUEST_RESTORE_FIELDS = new Set(['draft', 'merged', 'head']);
const MAX_RATE_LIMIT_RESPONSE_BYTES = 64 * 1024;

export type GitHubCommentMode = 'none' | 'body' | 'digest';
export type GitHubResetMode = 'read-only' | 'restore';

export interface GitHubApiAdapterConfiguration {
  owner: string;
  repository: string;
  apiBaseUrl: string;
  tokenEnv: string | null;
  issueNumbers: number[];
  pullRequestNumbers: number[];
  branchNames: string[];
  issueFields: string[];
  pullRequestFields: string[];
  branchProtectionFields: string[];
  commentMode: GitHubCommentMode;
  resetMode: GitHubResetMode;
  pageSize: number;
  maxPages: number;
  maxItems: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
}

interface RawComment {
  id: number;
  body: string;
  digest: string;
}

interface RawResource {
  exists: boolean;
  fields: Record<string, AdapterJson>;
  labels: string[];
  comments: RawComment[];
}

interface RawBranch {
  exists: boolean;
  sha: string | null;
  protected: boolean;
  protection: Record<string, AdapterJson> | null;
  protectionRaw: Record<string, unknown> | null;
}

export interface GitHubApiSnapshotScope {
  issueFields: string[];
  pullRequestFields: string[];
  branchNames: string[];
  branchProtectionFields: string[];
}

export interface GitHubApiSnapshot {
  scope: GitHubApiSnapshotScope;
  commentMode: GitHubCommentMode;
  issues: Record<string, RawResource>;
  pullRequests: Record<string, RawResource>;
  branches: Record<string, RawBranch>;
}

export interface NormalizedGitHubComments {
  count: number;
  entries: string[];
}

export interface NormalizedGitHubResource {
  exists: boolean;
  fields: Record<string, AdapterJson>;
  labels: string[];
  comments: NormalizedGitHubComments;
}

export interface NormalizedGitHubBranch {
  exists: boolean;
  sha: string | null;
  protected: boolean;
  protection: Record<string, AdapterJson> | null;
}

export interface NormalizedGitHubApiSnapshot {
  scope: GitHubApiSnapshotScope;
  commentMode: GitHubCommentMode;
  issues: Record<string, NormalizedGitHubResource>;
  pullRequests: Record<string, NormalizedGitHubResource>;
  branches: Record<string, NormalizedGitHubBranch>;
}

export interface GitHubApiDiff {
  changed: boolean;
  changedIssues: number[];
  changedPullRequests: number[];
  changedBranches: string[];
}

export interface GitHubApiPrepared {
  readonly configuration: GitHubApiAdapterConfiguration;
  baselineRaw: GitHubApiSnapshot | null;
  baseline: NormalizedGitHubApiSnapshot | null;
  cleanupResult: AdapterOperationResult | null;
  cleaned: boolean;
}

export type GitHubAdapterFailureKind = 'rate_limited' | 'timeout' | 'http_failure' | 'invalid_response';

export class GitHubAdapterError extends Error {
  constructor(readonly kind: GitHubAdapterFailureKind, message: string) {
    super(message);
    this.name = 'GitHubAdapterError';
  }
}

export function createGitHubApiAdapter(): OculoryAdapter<
  GitHubApiAdapterConfiguration,
  GitHubApiPrepared,
  GitHubApiSnapshot,
  NormalizedGitHubApiSnapshot,
  GitHubApiDiff
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

function validateConfiguration(value: unknown): GitHubApiAdapterConfiguration {
  const input = requireObject(value, 'GitHub API adapter configuration');
  rejectUnknownKeys(input, [
    'owner', 'repository', 'apiBaseUrl', 'tokenEnv', 'issueNumbers', 'pullRequestNumbers', 'branchNames',
    'issueFields', 'pullRequestFields', 'branchProtectionFields', 'commentMode', 'resetMode', 'pageSize',
    'maxPages', 'maxItems', 'requestTimeoutMs', 'maxResponseBytes',
  ], 'GitHub API adapter configuration');
  const owner = requireString(input.owner, 'owner', SCOPE);
  const repository = requireString(input.repository, 'repository', SCOPE);
  const apiBaseUrl = validatedBaseUrl(requireString(input.apiBaseUrl, 'apiBaseUrl'));
  const tokenEnv = input.tokenEnv === undefined || input.tokenEnv === null ? null : requireString(input.tokenEnv, 'tokenEnv', TOKEN_ENV);
  const issueNumbers = positiveNumbers(input.issueNumbers, 'issueNumbers');
  const pullRequestNumbers = positiveNumbers(input.pullRequestNumbers, 'pullRequestNumbers');
  if (issueNumbers.some((number) => pullRequestNumbers.includes(number))) {
    throw new Error('issueNumbers and pullRequestNumbers must not overlap');
  }
  const branchNames = input.branchNames === undefined || Array.isArray(input.branchNames) && input.branchNames.length === 0
    ? []
    : requireStringArray(input.branchNames, 'branchNames', 128).map(safeBranch).sort();
  if (issueNumbers.length + pullRequestNumbers.length + branchNames.length === 0) throw new Error('GitHub watch scope must not be empty');
  const issueFields = selectedFields(input.issueFields, ISSUE_FIELDS, 'issueFields');
  const pullRequestFields = selectedFields(input.pullRequestFields, PULL_REQUEST_FIELDS, 'pullRequestFields');
  const branchProtectionFields = selectedFields(input.branchProtectionFields, PROTECTION_FIELDS, 'branchProtectionFields');
  const commentMode = input.commentMode === undefined ? 'digest' : input.commentMode;
  if (commentMode !== 'none' && commentMode !== 'body' && commentMode !== 'digest') throw new Error('commentMode is invalid');
  const resetMode = input.resetMode === undefined ? 'read-only' : input.resetMode;
  if (resetMode !== 'read-only' && resetMode !== 'restore') throw new Error('resetMode is invalid');
  if (resetMode === 'restore' && commentMode === 'digest' && issueNumbers.length + pullRequestNumbers.length > 0) {
    throw new Error('restore mode requires body or none comment mode');
  }
  if (resetMode === 'restore') {
    const unsupportedIssueFields = issueFields.filter((field) => UNSUPPORTED_ISSUE_RESTORE_FIELDS.has(field));
    if (unsupportedIssueFields.length > 0) {
      throw new Error(`restore mode does not support issue fields: ${unsupportedIssueFields.join(', ')}`);
    }
    const unsupportedPullRequestFields = pullRequestFields.filter((field) => UNSUPPORTED_PULL_REQUEST_RESTORE_FIELDS.has(field));
    if (unsupportedPullRequestFields.length > 0) {
      throw new Error(`restore mode does not support pull request fields: ${unsupportedPullRequestFields.join(', ')}`);
    }
  }
  const base = new URL(apiBaseUrl);
  if (resetMode === 'restore' && !isLoopback(base.hostname) && tokenEnv === null) {
    throw new Error('live restore mode requires an explicitly named token environment variable');
  }
  return {
    owner,
    repository,
    apiBaseUrl,
    tokenEnv,
    issueNumbers,
    pullRequestNumbers,
    branchNames,
    issueFields,
    pullRequestFields,
    branchProtectionFields,
    commentMode,
    resetMode,
    pageSize: input.pageSize === undefined ? 50 : requireBoundedInteger(input.pageSize, 'pageSize', 1, 100),
    maxPages: input.maxPages === undefined ? 10 : requireBoundedInteger(input.maxPages, 'maxPages', 1, 50),
    maxItems: input.maxItems === undefined ? 500 : requireBoundedInteger(input.maxItems, 'maxItems', 1, 5_000),
    requestTimeoutMs: input.requestTimeoutMs === undefined ? 5_000 : requireBoundedInteger(input.requestTimeoutMs, 'requestTimeoutMs', 100, 30_000),
    maxResponseBytes: input.maxResponseBytes === undefined ? 2 * 1024 * 1024 : requireBoundedInteger(input.maxResponseBytes, 'maxResponseBytes', 1_024, 16 * 1024 * 1024),
  };
}

async function prepare(configuration: GitHubApiAdapterConfiguration, context: AdapterPrepareContext): Promise<GitHubApiPrepared> {
  if (context.signal?.aborted === true) throw new Error('adapter preparation cancelled');
  requireString(context.runId, 'runId', /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  configuration = validateConfiguration(configuration);
  Object.freeze(configuration.issueNumbers);
  Object.freeze(configuration.pullRequestNumbers);
  Object.freeze(configuration.branchNames);
  Object.freeze(configuration.issueFields);
  Object.freeze(configuration.pullRequestFields);
  Object.freeze(configuration.branchProtectionFields);
  Object.freeze(configuration);
  const prepared: GitHubApiPrepared = { configuration, baselineRaw: null, baseline: null, cleanupResult: null, cleaned: false };
  const baselineRaw = await capture(prepared);
  prepared.baselineRaw = structuredClone(baselineRaw);
  prepared.baseline = normalizeSnapshot(baselineRaw);
  return prepared;
}

async function snapshotBefore(prepared: GitHubApiPrepared): Promise<GitHubApiSnapshot> {
  assertPrepared(prepared);
  const value = await capture(prepared);
  const normalized = normalizeSnapshot(value);
  if (prepared.baseline !== null && !equalJson(
    prepared.baseline as unknown as AdapterJson,
    normalized as unknown as AdapterJson,
  )) {
    throw new Error('GitHub scope changed before baseline registration');
  }
  if (prepared.baseline === null) {
    prepared.baselineRaw = structuredClone(value);
    prepared.baseline = normalized;
  }
  return value;
}

async function capture(prepared: GitHubApiPrepared): Promise<GitHubApiSnapshot> {
  assertPrepared(prepared);
  const issues: Record<string, RawResource> = {};
  for (const number of prepared.configuration.issueNumbers) issues[String(number)] = await captureResource(prepared, 'issues', number);
  const pullRequests: Record<string, RawResource> = {};
  for (const number of prepared.configuration.pullRequestNumbers) pullRequests[String(number)] = await captureResource(prepared, 'pulls', number);
  const branches: Record<string, RawBranch> = {};
  for (const name of prepared.configuration.branchNames) branches[name] = await captureBranch(prepared, name);
  return {
    scope: {
      issueFields: [...prepared.configuration.issueFields],
      pullRequestFields: [...prepared.configuration.pullRequestFields],
      branchNames: [...prepared.configuration.branchNames],
      branchProtectionFields: [...prepared.configuration.branchProtectionFields],
    },
    commentMode: prepared.configuration.commentMode,
    issues,
    pullRequests,
    branches,
  };
}

async function captureResource(prepared: GitHubApiPrepared, kind: 'issues' | 'pulls', number: number): Promise<RawResource> {
  const response = await requestJson<unknown | null>(prepared, repoPath(prepared, `${kind}/${number}`), { allow404: true });
  if (response === null) return { exists: false, fields: {}, labels: [], comments: [] };
  const data = responseObject(response, `${kind} response`);
  const selected = kind === 'issues' ? prepared.configuration.issueFields : prepared.configuration.pullRequestFields;
  const fields: Record<string, AdapterJson> = {};
  for (const field of selected) {
    if (field === 'labels') continue;
    const rawValue = selectedResourceField(data, kind, field);
    const safeValue = redactSecrets(rawValue);
    if (prepared.configuration.resetMode === 'restore' && !equalJson(safeValue, toAdapterJson(rawValue))) {
      throw new GitHubAdapterError('invalid_response', 'GitHub restore scope contains a redacted field');
    }
    fields[field] = safeValue;
  }
  const labels = selected.includes('labels') ? normalizeLabels(data.labels) : [];
  const comments = await paginatedComments(prepared, number);
  return { exists: true, fields, labels, comments };
}

async function captureBranch(prepared: GitHubApiPrepared, name: string): Promise<RawBranch> {
  const response = await requestJson<unknown | null>(prepared, repoPath(prepared, `branches/${encodeURIComponent(name)}`), { allow404: true });
  if (response === null) return { exists: false, sha: null, protected: false, protection: null, protectionRaw: null };
  const data = responseObject(response, 'branch response');
  const commit = responseObject(data.commit, 'branch.commit');
  const protectedValue = responseBoolean(data.protected, 'branch.protected');
  let protectionRaw: Record<string, unknown> | null = null;
  let protection: Record<string, AdapterJson> | null = null;
  if (prepared.configuration.branchProtectionFields.length > 0 && protectedValue) {
    const rawProtection = await requestJson<unknown | null>(
      prepared,
      repoPath(prepared, `branches/${encodeURIComponent(name)}/protection`),
      { allow404: true },
    );
    if (rawProtection === null) throw new GitHubAdapterError('invalid_response', 'GitHub branch protection response is unavailable');
    protectionRaw = protectionRequest(
      responseObject(rawProtection, 'branch protection response'),
      prepared.configuration.branchProtectionFields,
    );
    protection = Object.fromEntries(prepared.configuration.branchProtectionFields.map((field) => [field, toAdapterJson(protectionRaw![field])]));
  }
  return {
    exists: true,
    sha: responseString(commit.sha, 'branch.commit.sha', /^[a-f0-9]{40,64}$/i),
    protected: protectedValue,
    protection,
    protectionRaw,
  };
}

async function paginatedComments(prepared: GitHubApiPrepared, number: number): Promise<RawComment[]> {
  const comments: RawComment[] = [];
  for (let page = 1; page <= prepared.configuration.maxPages; page += 1) {
    const path = `${repoPath(prepared, `issues/${number}/comments`)}?per_page=${prepared.configuration.pageSize}&page=${page}`;
    const values = await requestJson<unknown>(prepared, path);
    if (!Array.isArray(values)) throw new GitHubAdapterError('invalid_response', 'GitHub comments response is invalid');
    for (const value of values) {
      if (comments.length >= prepared.configuration.maxItems) throw new GitHubAdapterError('invalid_response', 'GitHub comment limit exceeded');
      const comment = responseObject(value, 'GitHub comment');
      const id = responsePositiveInteger(comment.id, 'GitHub comment id');
      if (prepared.configuration.commentMode === 'none') {
        comments.push({ id, body: '', digest: '' });
        continue;
      }
      if (typeof comment.body !== 'string') throw new GitHubAdapterError('invalid_response', 'GitHub comment body is invalid');
      const safeBody = redactSecrets(comment.body);
      if (prepared.configuration.resetMode === 'restore' && prepared.configuration.commentMode === 'body' && !equalJson(safeBody, toAdapterJson(comment.body))) {
        throw new GitHubAdapterError('invalid_response', 'GitHub restore scope contains a redacted comment');
      }
      const body = typeof safeBody === 'string' ? safeBody : '';
      comments.push({
        id,
        body,
        digest: createHash('sha256').update(body).digest('hex'),
      });
    }
    if (values.length < prepared.configuration.pageSize) break;
    if (page === prepared.configuration.maxPages) throw new GitHubAdapterError('invalid_response', 'GitHub comment pagination limit exceeded');
  }
  return comments.sort((left, right) => left.id - right.id);
}

function normalizeSnapshot(snapshot: GitHubApiSnapshot): NormalizedGitHubApiSnapshot {
  return {
    scope: {
      issueFields: [...snapshot.scope.issueFields].sort(),
      pullRequestFields: [...snapshot.scope.pullRequestFields].sort(),
      branchNames: [...snapshot.scope.branchNames].sort(),
      branchProtectionFields: [...snapshot.scope.branchProtectionFields].sort(),
    },
    commentMode: snapshot.commentMode,
    issues: normalizeResources(snapshot.issues, snapshot.commentMode),
    pullRequests: normalizeResources(snapshot.pullRequests, snapshot.commentMode),
    branches: Object.fromEntries(Object.entries(snapshot.branches).sort(([left], [right]) => left.localeCompare(right)).map(([name, branch]) => [name, {
      exists: branch.exists,
      sha: branch.sha,
      protected: branch.protected,
      protection: branch.protection === null ? null : sortedObject(branch.protection),
    }])),
  };
}

function normalizeResources(resources: Record<string, RawResource>, mode: GitHubCommentMode): Record<string, NormalizedGitHubResource> {
  return Object.fromEntries(Object.entries(resources).sort(([left], [right]) => Number(left) - Number(right)).map(([number, resource]) => [number, {
    exists: resource.exists,
    fields: sortedObject(resource.fields),
    labels: [...resource.labels].sort(),
    comments: {
      count: resource.comments.length,
      entries: mode === 'none' ? [] : resource.comments.map((comment) => mode === 'body' ? comment.body : comment.digest).sort(),
    },
  }]));
}

function diff(before: NormalizedGitHubApiSnapshot, after: NormalizedGitHubApiSnapshot): GitHubApiDiff {
  const changedIssues = changedNumericKeys(before.issues, after.issues);
  const changedPullRequests = changedNumericKeys(before.pullRequests, after.pullRequests);
  const changedBranches = changedKeys(before.branches, after.branches);
  return { changed: changedIssues.length + changedPullRequests.length + changedBranches.length > 0, changedIssues, changedPullRequests, changedBranches };
}

function evaluateAssertion(
  assertion: AdapterAssertion,
  before: NormalizedGitHubApiSnapshot,
  after: NormalizedGitHubApiSnapshot,
  _diff: GitHubApiDiff,
): AdapterAssertionResult {
  assertSupportedMode(assertion.evaluationMode);
  return evaluateObserved(assertion, selectedValue(assertion, before), selectedValue(assertion, after));
}

async function reset(prepared: GitHubApiPrepared, expected: NormalizedGitHubApiSnapshot): Promise<AdapterOperationResult> {
  assertPrepared(prepared);
  const baseline = prepared.baseline;
  if (baseline === null || !equalJson(
    expected as unknown as AdapterJson,
    baseline as unknown as AdapterJson,
  )) {
    return { passed: false, detail: 'reset refused because the requested baseline was not registered' };
  }
  if (prepared.configuration.resetMode !== 'restore' || prepared.baselineRaw === null) {
    const current = normalizeSnapshot(await capture(prepared));
    const passed = equalJson(baseline as unknown as AdapterJson, current as unknown as AdapterJson);
    return { passed, detail: passed ? 'read-only GitHub scope remained unchanged' : 'GitHub reset is not authorized for this scope' };
  }
  try {
    await restoreSnapshot(prepared, prepared.baselineRaw);
    const current = normalizeSnapshot(await capture(prepared));
    const passed = equalJson(baseline as unknown as AdapterJson, current as unknown as AdapterJson);
    return { passed, detail: passed ? 'GitHub scoped resources restored and verified' : 'GitHub scoped restore could not be verified' };
  } catch (error) {
    if (error instanceof GitHubAdapterError && error.kind === 'rate_limited') return { passed: false, detail: 'GitHub reset rate limited' };
    return { passed: false, detail: 'GitHub scoped restore failed' };
  }
}

async function cleanup(prepared: GitHubApiPrepared): Promise<AdapterOperationResult> {
  if (prepared.cleaned) return prepared.cleanupResult ?? { passed: false, detail: 'cleanup result is unavailable' };
  if (prepared.baseline === null) return { passed: false, detail: 'GitHub baseline unavailable for cleanup' };
  const result = await reset(prepared, prepared.baseline);
  prepared.cleanupResult = result;
  prepared.cleaned = true;
  return result;
}

function describeViolation(assertion: AdapterAssertion, result: AdapterAssertionResult): string {
  const kind = typeof assertion.selector.kind === 'string' ? assertion.selector.kind : 'GitHub resource';
  return `${kind} violated: ${result.detail}`;
}

function selectedValue(assertion: AdapterAssertion, snapshot: NormalizedGitHubApiSnapshot): AdapterJson | null {
  const selector = assertion.selector;
  const kind = requireString(selector.kind, 'selector.kind');
  if (kind.startsWith('issue_') || kind === 'issue') {
    return resourceValue(kind, selector, snapshot.issues, snapshot.scope.issueFields, snapshot.commentMode, 'issue');
  }
  if (kind.startsWith('pull_request_') || kind === 'pull_request') {
    return resourceValue(kind.replace('pull_request', 'issue'), selector, snapshot.pullRequests, snapshot.scope.pullRequestFields, snapshot.commentMode, 'pull request');
  }
  const branchName = safeBranch(requireString(selector.branch, 'selector.branch'));
  if (!snapshot.scope.branchNames.includes(branchName)) throw new Error('selector branch is outside the configured watch scope');
  const branch = snapshot.branches[branchName];
  switch (kind) {
    case 'branch':
      return branch?.exists === true ? { name: branchName, sha: branch.sha } : null;
    case 'branch_field': {
      const field = requireString(selector.field, 'selector.field');
      if (field !== 'sha' && field !== 'protected') throw new Error('unsupported branch field');
      return branch?.exists === true ? toAdapterJson(branch[field]) : null;
    }
    case 'branch_protection':
      if (snapshot.scope.branchProtectionFields.length === 0) throw new Error('branch protection is outside the configured watch scope');
      return branch?.protection ?? null;
    case 'branch_protection_field': {
      const field = requireString(selector.field, 'selector.field');
      if (!snapshot.scope.branchProtectionFields.includes(field)) throw new Error('branch protection field is outside the configured watch scope');
      return branch?.protection?.[field] ?? null;
    }
    default:
      throw new Error(`unsupported GitHub selector: ${kind}`);
  }
}

function resourceValue(
  kind: string,
  selector: Readonly<Record<string, AdapterJson>>,
  resources: Record<string, NormalizedGitHubResource>,
  selectedFields: string[],
  commentMode: GitHubCommentMode,
  label: string,
): AdapterJson | null {
  const number = requireBoundedInteger(selector.number, 'selector.number', 1, Number.MAX_SAFE_INTEGER);
  if (!Object.prototype.hasOwnProperty.call(resources, String(number))) throw new Error(`${label} selector is outside the configured watch scope`);
  const resource = resources[String(number)];
  switch (kind) {
    case 'issue':
      return resource?.exists === true
        ? { number, ...resource.fields, ...(selectedFields.includes('labels') ? { labels: resource.labels } : {}) }
        : null;
    case 'issue_field': {
      const field = requireString(selector.field, 'selector.field');
      if (field === 'labels' || !selectedFields.includes(field)) throw new Error(`${label} field is outside the configured watch scope`);
      return resource?.exists === true ? resource.fields[field] ?? null : null;
    }
    case 'issue_labels':
      if (!selectedFields.includes('labels')) throw new Error(`${label} labels are outside the configured watch scope`);
      return resource?.exists === true ? resource.labels : null;
    case 'issue_comment_count':
      return resource?.exists === true ? resource.comments.count : null;
    case 'issue_comments':
      if (commentMode === 'none') throw new Error(`${label} comment bodies are outside the configured watch scope`);
      return resource?.exists === true ? resource.comments.entries : null;
    default:
      throw new Error(`unsupported GitHub resource selector: ${kind}`);
  }
}

async function restoreSnapshot(prepared: GitHubApiPrepared, baseline: GitHubApiSnapshot): Promise<void> {
  const current = await capture(prepared);
  for (const [number, resource] of Object.entries(baseline.issues)) {
    await restoreResource(prepared, 'issues', Number(number), resource, current.issues[number]!);
  }
  for (const [number, resource] of Object.entries(baseline.pullRequests)) {
    await restoreResource(prepared, 'pulls', Number(number), resource, current.pullRequests[number]!);
  }
  for (const [name, branch] of Object.entries(baseline.branches)) {
    await restoreBranch(prepared, name, branch, current.branches[name]!);
  }
}

async function restoreResource(
  prepared: GitHubApiPrepared,
  kind: 'issues' | 'pulls',
  number: number,
  baseline: RawResource,
  current: RawResource,
): Promise<void> {
  if (baseline.exists !== current.exists) throw new Error('resource existence cannot be safely restored');
  if (!baseline.exists) return;
  const body = Object.fromEntries(Object.entries(baseline.fields).filter(([field]) => field !== 'merged' && field !== 'draft' && field !== 'head'));
  await requestJson(prepared, repoPath(prepared, `${kind}/${number}`), { method: 'PATCH', body });
  if ((kind === 'issues' ? prepared.configuration.issueFields : prepared.configuration.pullRequestFields).includes('labels')) {
    await requestJson(prepared, repoPath(prepared, `issues/${number}`), { method: 'PATCH', body: { labels: baseline.labels } });
  }
  if (prepared.configuration.commentMode === 'body' && !equalJson(
    baseline.comments.map((comment) => comment.body),
    current.comments.map((comment) => comment.body),
  )) {
    for (const comment of current.comments) {
      await requestJson(prepared, repoPath(prepared, `issues/comments/${comment.id}`), { method: 'DELETE' });
    }
    for (const comment of baseline.comments) {
      await requestJson(prepared, repoPath(prepared, `issues/${number}/comments`), { method: 'POST', body: { body: comment.body } });
    }
  } else if (prepared.configuration.commentMode === 'none' && baseline.comments.length !== current.comments.length) {
    throw new Error('comment reset requires body capture');
  }
}

async function restoreBranch(prepared: GitHubApiPrepared, name: string, baseline: RawBranch, current: RawBranch): Promise<void> {
  const encoded = encodeURIComponent(name);
  if (!baseline.exists && current.exists) {
    await requestJson(prepared, repoPath(prepared, `git/refs/heads/${encoded}`), { method: 'DELETE' });
    return;
  }
  if (baseline.exists && !current.exists) {
    await requestJson(prepared, repoPath(prepared, 'git/refs'), { method: 'POST', body: { ref: `refs/heads/${name}`, sha: baseline.sha } });
  } else if (baseline.exists && current.sha !== baseline.sha) {
    await requestJson(prepared, repoPath(prepared, `git/refs/heads/${encoded}`), { method: 'PATCH', body: { sha: baseline.sha, force: true } });
  }
  if (!baseline.exists || equalJson(baseline.protection as unknown as AdapterJson, current.protection as unknown as AdapterJson)) return;
  const protectionPath = repoPath(prepared, `branches/${encoded}/protection`);
  if (!baseline.protected) await requestJson(prepared, protectionPath, { method: 'DELETE' });
  else if (baseline.protectionRaw !== null) {
    const body = current.protected && current.protectionRaw !== null
      ? { ...current.protectionRaw }
      : { ...baseline.protectionRaw };
    for (const field of prepared.configuration.branchProtectionFields) body[field] = baseline.protectionRaw[field];
    await requestJson(prepared, protectionPath, { method: 'PUT', body });
  }
  else throw new Error('branch protection baseline is incomplete');
}

function protectionRequest(raw: Record<string, unknown>, selected: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(selected.map((field) => [field, protectionFieldRequest(field, raw[field])]));
}

function protectionFieldRequest(field: string, value: unknown): unknown {
  switch (field) {
    case 'required_status_checks':
      return statusChecksRequest(value);
    case 'enforce_admins':
    case 'required_linear_history':
    case 'allow_force_pushes':
    case 'allow_deletions':
    case 'required_conversation_resolution':
    case 'block_creations':
    case 'lock_branch':
    case 'allow_fork_syncing':
      return protectionEnabled(value, `branch protection ${field}`);
    case 'required_pull_request_reviews':
      return pullRequestReviewsRequest(value);
    case 'restrictions':
      return restrictionsRequest(value);
    default:
      throw new GitHubAdapterError('invalid_response', `GitHub branch protection field is unsupported: ${field}`);
  }
}

function protectionEnabled(value: unknown, label: string): boolean {
  const input = responseObject(value, label);
  return responseBoolean(input.enabled, `${label}.enabled`);
}

function statusChecksRequest(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  const input = responseObject(value, 'branch protection required_status_checks');
  const result: Record<string, unknown> = {
    strict: responseBoolean(input.strict, 'branch protection required_status_checks.strict'),
    contexts: boundedStrings(input.contexts, 'branch protection contexts'),
  };
  if (input.checks !== undefined) {
    if (!Array.isArray(input.checks) || input.checks.length > 100) throw new GitHubAdapterError('invalid_response', 'GitHub protection checks are invalid');
    result.checks = input.checks.map((entry) => {
      const check = responseObject(entry, 'branch protection check');
      const appId = check.app_id === null
        ? null
        : responseBoundedInteger(check.app_id, 'branch protection check app_id', 1, Number.MAX_SAFE_INTEGER);
      return { context: responseString(check.context, 'branch protection check context'), app_id: appId };
    });
  }
  return result;
}

function pullRequestReviewsRequest(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  const input = responseObject(value, 'branch protection required_pull_request_reviews');
  return {
    dismissal_restrictions: actorRestrictions(input.dismissal_restrictions),
    dismiss_stale_reviews: responseBoolean(input.dismiss_stale_reviews, 'branch protection dismiss_stale_reviews'),
    require_code_owner_reviews: responseBoolean(input.require_code_owner_reviews, 'branch protection require_code_owner_reviews'),
    required_approving_review_count: responseBoundedInteger(
      input.required_approving_review_count,
      'branch protection required_approving_review_count',
      0,
      100,
    ),
    require_last_push_approval: responseBoolean(input.require_last_push_approval, 'branch protection require_last_push_approval'),
  };
}

function restrictionsRequest(value: unknown): Record<string, string[]> | null {
  if (value === null) return null;
  return actorRestrictions(value);
}

function actorRestrictions(value: unknown): Record<string, string[]> {
  if (value === null) return { users: [], teams: [], apps: [] };
  const input = responseObject(value, 'branch protection restrictions');
  return {
    users: actorNames(input.users, 'login', 'branch protection users'),
    teams: actorNames(input.teams, 'slug', 'branch protection teams'),
    apps: actorNames(input.apps, 'slug', 'branch protection apps'),
  };
}

function actorNames(value: unknown, key: string, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new GitHubAdapterError('invalid_response', `${label} are invalid`);
  return value.map((entry) => responseString(responseObject(entry, label)[key], label)).sort();
}

function boundedStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new GitHubAdapterError('invalid_response', `${label} are invalid`);
  }
  return [...new Set(value as string[])].sort();
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  allow404?: boolean;
}

async function requestJson<T>(prepared: GitHubApiPrepared, path: string, options: RequestOptions = {}): Promise<T> {
  const configuration = prepared.configuration;
  const url = scopedUrl(configuration.apiBaseUrl, path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), configuration.requestTimeoutMs);
  let token: string | undefined;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'oculory-adapter' };
  try {
    if (configuration.tokenEnv !== null) {
      token = process.env[configuration.tokenEnv];
      if (token === undefined || token.length === 0) throw new GitHubAdapterError('http_failure', 'GitHub authentication is unavailable');
      headers.Authorization = `Bearer ${token}`;
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      redirect: 'error',
    });
    delete headers.Authorization;
    if (isRateLimitedResponse(response)) {
      await discardBoundedBody(response, MAX_RATE_LIMIT_RESPONSE_BYTES);
      throw new GitHubAdapterError('rate_limited', 'GitHub API rate limit reached');
    }
    const bytes = await boundedBody(response, configuration.maxResponseBytes);
    if (response.status === 404 && options.allow404 === true) return null as T;
    if (!response.ok) throw new GitHubAdapterError('http_failure', `GitHub API request failed with status ${response.status}`);
    if (bytes.byteLength === 0) return null as T;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    } catch {
      throw new GitHubAdapterError('invalid_response', 'GitHub API returned invalid JSON');
    }
    if (token === undefined) return parsed as T;
    const scrubbed = scrubCredential(parsed, token);
    if (scrubbed.redacted && configuration.resetMode === 'restore') {
      throw new GitHubAdapterError('invalid_response', 'GitHub restore response contains the configured credential');
    }
    return scrubbed.value as T;
  } catch (error) {
    if (error instanceof GitHubAdapterError) throw error;
    if (controller.signal.aborted) throw new GitHubAdapterError('timeout', 'GitHub API request timed out');
    throw new GitHubAdapterError('http_failure', 'GitHub API request failed');
  } finally {
    token = undefined;
    delete headers.Authorization;
    clearTimeout(timeout);
  }
}

function isRateLimitedResponse(response: Response): boolean {
  return response.status === 429 || response.status === 403 && (
    response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')
  );
}

async function discardBoundedBody(response: Response, limit: number): Promise<void> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  let length = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) return;
      length += value.value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  } catch {
    await reader.cancel().catch(() => undefined);
  }
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const value = await reader.read();
    if (value.done) break;
    length += value.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new GitHubAdapterError('invalid_response', 'GitHub API response exceeds configured byte limit');
    }
    chunks.push(value.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function repoPath(prepared: GitHubApiPrepared, suffix: string): string {
  return `/repos/${encodeURIComponent(prepared.configuration.owner)}/${encodeURIComponent(prepared.configuration.repository)}/${suffix}`;
}

function scopedUrl(base: string, path: string): URL {
  const baseUrl = new URL(base.endsWith('/') ? base : `${base}/`);
  const relativePath = path.replace(/^\//, '');
  const url = new URL(relativePath, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) throw new Error('GitHub request escaped the configured API scope');
  return url;
}

function validatedBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new Error('apiBaseUrl must not contain credentials, query, or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('apiBaseUrl must use HTTPS, except for a loopback mock server');
  }
  return url.toString().replace(/\/$/, '');
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function selectedFields(value: unknown, allowed: readonly string[], label: string): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.length === 0) return [];
  const fields = requireStringArray(value, label, allowed.length);
  for (const field of fields) if (!allowed.includes(field)) throw new Error(`${label} contains unsupported field: ${field}`);
  return fields.sort();
}

function positiveNumbers(value: unknown, label: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) throw new Error(`${label} must be a bounded array`);
  const values = value.map((entry) => requireBoundedInteger(entry, label, 1, Number.MAX_SAFE_INTEGER));
  return [...new Set(values)].sort((left, right) => left - right);
}

function safeBranch(value: string): string {
  if (value.startsWith('-') || value.includes('..') || value.includes('@{') || /[\s~^:?*[\]\\]/.test(value)) throw new Error('branch name is unsafe');
  return value;
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new GitHubAdapterError('invalid_response', 'GitHub labels response is invalid');
  return value.map((entry) => {
    if (typeof entry === 'string') return entry;
    const label = responseObject(entry, 'GitHub label');
    if (typeof label.name !== 'string' || label.name.length === 0) {
      throw new GitHubAdapterError('invalid_response', 'GitHub label name is invalid');
    }
    return label.name;
  }).sort();
}

function responseObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubAdapterError('invalid_response', `${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function responsePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new GitHubAdapterError('invalid_response', `${label} is invalid`);
  }
  return Number(value);
}

function selectedResourceField(data: Record<string, unknown>, kind: 'issues' | 'pulls', field: string): AdapterJson {
  const label = `${kind}.${field}`;
  switch (field) {
    case 'title':
      return responseString(data[field], label);
    case 'state':
      return responseEnum(data[field], label, ['open', 'closed']);
    case 'body':
      return responseNullableText(data[field], label);
    case 'locked':
    case 'draft':
    case 'merged':
      return responseBoolean(data[field], label);
    case 'base':
    case 'head':
      return responseString(responseObject(data[field], label).ref, `${label}.ref`);
    default:
      throw new GitHubAdapterError('invalid_response', `GitHub selected field is unsupported: ${field}`);
  }
}

function responseString(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || pattern !== undefined && !pattern.test(value)) {
    throw new GitHubAdapterError('invalid_response', `${label} is invalid`);
  }
  return value;
}

function responseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new GitHubAdapterError('invalid_response', `${label} is invalid`);
  return value;
}

function responseNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new GitHubAdapterError('invalid_response', `${label} is invalid`);
  return value;
}

function responseEnum(value: unknown, label: string, allowed: readonly string[]): string {
  const selected = responseString(value, label);
  if (!allowed.includes(selected)) throw new GitHubAdapterError('invalid_response', `${label} is invalid`);
  return selected;
}

function responseBoundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new GitHubAdapterError('invalid_response', `${label} is invalid`);
  }
  return Number(value);
}

function scrubCredential(value: unknown, credential: string, depth = 0): { value: unknown; redacted: boolean } {
  if (depth > 64) throw new GitHubAdapterError('invalid_response', 'GitHub API response nesting limit exceeded');
  if (typeof value === 'string') {
    const redacted = value.includes(credential);
    return { value: redacted ? value.replaceAll(credential, '<redacted>') : value, redacted };
  }
  if (Array.isArray(value)) {
    let redacted = false;
    const result = value.map((entry) => {
      const scrubbed = scrubCredential(entry, credential, depth + 1);
      redacted ||= scrubbed.redacted;
      return scrubbed.value;
    });
    return { value: result, redacted };
  }
  if (value !== null && typeof value === 'object') {
    let redacted = false;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      const scrubbedKey = scrubCredential(key, credential, depth + 1);
      const scrubbedValue = scrubCredential(entry, credential, depth + 1);
      redacted ||= scrubbedKey.redacted || scrubbedValue.redacted;
      return [scrubbedKey.value as string, scrubbedValue.value] as const;
    });
    return { value: Object.fromEntries(entries), redacted };
  }
  return { value, redacted: false };
}

function sortedObject(value: Record<string, AdapterJson>): Record<string, AdapterJson> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function changedNumericKeys<T>(before: Record<string, T>, after: Record<string, T>): number[] {
  return changedKeys(before, after).map(Number).sort((left, right) => left - right);
}

function changedKeys<T>(before: Record<string, T>, after: Record<string, T>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !equalJson(before[key] as unknown as AdapterJson ?? null, after[key] as unknown as AdapterJson ?? null))
    .sort();
}

function assertPrepared(prepared: GitHubApiPrepared): void {
  if (prepared.cleaned) throw new Error('GitHub adapter is already cleaned');
}
