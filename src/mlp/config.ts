import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseDocument, type Document } from 'yaml';
import {
  CONTRACT_SCHEMA_VERSION,
  DEFAULT_CONTRACT_TOLERANCE,
  PROFILE_PLACEHOLDERS,
  TASK_SCHEMA_VERSION,
  type AgentProfileConfig,
  type ClaimExtractionConfig,
  type ContractAssertion,
  type ContractOperator,
  type EvaluationMode,
  type Json,
  type JsonObject,
  type McpServerConfig,
  type OculoryContractConfig,
  type OculoryTaskConfig,
  type TargetConfig,
  type WorkspaceConfig,
} from './types.js';
import { assertSafeClaimRegex } from './regex-policy.js';

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ISSUES = 8;
const MAX_ISSUE_LENGTH = 220;
const MAX_COLLECTION_ITEMS = 512;
const MAX_NESTING_DEPTH = 24;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_EXTRACT_BYTES = 1024 * 1024;
const MAX_REGEX_BYTES = 256;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_SHAPED = /^(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AIza[A-Za-z0-9_-]{20,}|sk[_-][A-Za-z0-9_-]{8,})$/i;
const SECRET_CONTENT = /(?:\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9_]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}|\bxox[baprs]-[A-Za-z0-9-]{8,}|\bAKIA[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@)/i;
const PLACEHOLDER = /\{[^{}]*\}/g;
const SHELL_SYNTAX = /[\0\r\n;&|`]|\$\(|<\(|>\(|(?:^|\s)(?:>|<|>>|<<)(?:\s|$)/;
const SHELL_EXECUTABLES = new Set(['bash', 'cmd', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'sh', 'zsh']);
const SECRET_ARGUMENT = /^--?(?:authorization|cookie|credential|password|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?string|database[_-]?url|dsn)(?:=|$)/i;
const PRIVATE_PATH_CONTENT = /(?:^|[\s`"'(])(?:\/(?:Users|home|root|private\/var)\/|[A-Za-z]:[\\/]Users[\\/]|file:\/\/\/)/;
const PATH_KEY = /(?:^|_)(?:cwd|path|paths|directory|directories|root|roots|repo|repository|file|files|workdir|workspace)$/i;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const OPERATORS = new Set<ContractOperator>(['exists', 'equals', 'count', 'unchanged', 'none', 'subset']);
const EVALUATIONS = new Set<EvaluationMode>(['exact', 'subset', 'ignore']);

export interface LoadedYamlConfig<T> {
  value: T;
  document: Document.Parsed;
  source: string;
}

export interface ConfigValidationIssue {
  path: string;
  message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigValidationIssue[];

  constructor(kind: 'task' | 'contract', issues: readonly ConfigValidationIssue[]) {
    const bounded = issues.slice(0, MAX_ISSUES).map((issue) => ({
      path: bound(issue.path, 120),
      message: bound(issue.message, MAX_ISSUE_LENGTH),
    }));
    const omitted = issues.length - bounded.length;
    const details = bounded.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    super(`Invalid ${kind} configuration: ${details}${omitted > 0 ? `; ${omitted} more issue(s) omitted` : ''}`);
    this.name = 'ConfigValidationError';
    this.issues = bounded;
  }
}

export function parseTaskConfig(source: string): LoadedYamlConfig<OculoryTaskConfig> {
  const document = parseYamlDocument(source, 'task');
  const collector = new IssueCollector('task');
  const raw = toJsonRoot(document, collector);
  const value = validateTask(raw, collector);
  collector.throwIfAny();
  rejectCredentialContent(source, 'task');
  return { value, document, source };
}

export function loadTaskConfig(path: string): LoadedYamlConfig<OculoryTaskConfig> {
  return parseTaskConfig(readBoundedConfig(path, 'task'));
}

export function parseContractConfig(source: string): LoadedYamlConfig<OculoryContractConfig> {
  const document = parseYamlDocument(source, 'contract');
  const collector = new IssueCollector('contract');
  const raw = toJsonRoot(document, collector);
  const value = validateContract(raw, collector);
  collector.throwIfAny();
  rejectCredentialContent(source, 'contract');
  return { value, document, source };
}

function rejectCredentialContent(source: string, kind: 'task' | 'contract'): void {
  if (SECRET_CONTENT.test(source)) {
    throw new ConfigValidationError(kind, [{
      path: '$',
      message: 'file must not contain credential-shaped content; use an allowlisted environment variable',
    }]);
  }
}

export function loadContractConfig(path: string): LoadedYamlConfig<OculoryContractConfig> {
  return parseContractConfig(readBoundedConfig(path, 'contract'));
}

function parseYamlDocument(source: string, kind: 'task' | 'contract'): Document.Parsed {
  if (Buffer.byteLength(source, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ConfigValidationError(kind, [{ path: '$', message: `file exceeds ${MAX_CONFIG_BYTES} bytes` }]);
  }

  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
    keepSourceTokens: true,
    version: '1.2',
    schema: 'core',
    merge: false,
  });
  const issues = [...document.errors, ...document.warnings].map((error) => ({ path: '$', message: error.message }));
  if (issues.length > 0) throw new ConfigValidationError(kind, issues);
  return document;
}

function toJsonRoot(document: Document.Parsed, collector: IssueCollector): JsonObject {
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch (error) {
    collector.add('$', error instanceof Error ? error.message : 'could not resolve YAML document');
    return {};
  }
  validateJsonValue(value, '$', 0, collector);
  return objectValue(value, '$', collector);
}

function validateTask(raw: JsonObject, collector: IssueCollector): OculoryTaskConfig {
  rejectUnknown(raw, ['version', 'task_id', 'prompt', 'agent_profiles', 'mcp_server', 'workspace', 'targets', 'claim_extraction'], '$', collector);

  const version = stringValue(raw.version, '$.version', collector);
  if (version !== TASK_SCHEMA_VERSION) collector.add('$.version', `expected ${TASK_SCHEMA_VERSION}`);
  const taskId = idValue(raw.task_id, '$.task_id', collector);
  const prompt = stringValue(raw.prompt, '$.prompt', collector, MAX_PROMPT_BYTES);

  const profilesRaw = objectValue(raw.agent_profiles, '$.agent_profiles', collector);
  const profiles: Record<string, AgentProfileConfig> = {};
  const profileEntries = Object.entries(profilesRaw);
  if (profileEntries.length === 0) collector.add('$.agent_profiles', 'must define at least one profile');
  if (profileEntries.length > 64) collector.add('$.agent_profiles', 'must define at most 64 profiles');
  for (const [label, profileRaw] of profileEntries.slice(0, 64)) {
    const path = `$.agent_profiles.${safePathSegment(label)}`;
    if (!ID.test(label)) collector.add(path, 'profile label must match ^[a-z][a-z0-9-]{0,63}$');
    const profile = objectValue(profileRaw, path, collector);
    rejectUnknown(profile, ['argv', 'env_allowlist', 'model'], path, collector);
    const argv = argvValue(profile.argv, `${path}.argv`, collector, true);
    const envAllowlist = envAllowlistValue(profile.env_allowlist, `${path}.env_allowlist`, collector);
    const model = optionalStringValue(profile.model, `${path}.model`, collector, 256);
    profiles[label] = model === undefined ? { argv, env_allowlist: envAllowlist } : { argv, env_allowlist: envAllowlist, model };
  }

  const mcp = validateMcp(raw.mcp_server, collector);
  const workspace = validateWorkspace(raw.workspace, collector);
  const targets = validateTargets(raw.targets, collector);
  const claimExtraction = raw.claim_extraction === undefined
    ? { type: 'stdout-final' as const }
    : validateClaimExtraction(raw.claim_extraction, collector);

  return {
    version: TASK_SCHEMA_VERSION,
    task_id: taskId,
    prompt,
    agent_profiles: profiles,
    mcp_server: mcp,
    workspace,
    targets,
    claim_extraction: claimExtraction,
  };
}

function validateMcp(value: Json | undefined, collector: IssueCollector): McpServerConfig {
  const raw = objectValue(value, '$.mcp_server', collector);
  rejectUnknown(raw, ['command', 'arguments', 'env_allowlist'], '$.mcp_server', collector);
  const command = executableValue(raw.command, '$.mcp_server.command', collector);
  const argumentsValue = argvValue(raw.arguments, '$.mcp_server.arguments', collector, false);
  const envAllowlist = envAllowlistValue(raw.env_allowlist, '$.mcp_server.env_allowlist', collector);
  return { command, arguments: argumentsValue, env_allowlist: envAllowlist };
}

function validateWorkspace(value: Json | undefined, collector: IssueCollector): WorkspaceConfig {
  const raw = objectValue(value, '$.workspace', collector);
  const strategy = stringValue(raw.strategy, '$.workspace.strategy', collector);
  if (strategy === 'git-worktree') {
    rejectUnknown(raw, ['strategy', 'repository', 'base_ref'], '$.workspace', collector);
    const repository = relativePathValue(raw.repository, '$.workspace.repository', collector);
    const baseRef = optionalStringValue(raw.base_ref, '$.workspace.base_ref', collector, 1024);
    return baseRef === undefined
      ? { strategy: 'git-worktree', repository }
      : { strategy: 'git-worktree', repository, base_ref: baseRef };
  }
  if (strategy === 'command') {
    rejectUnknown(raw, ['strategy', 'setup', 'reset', 'cleanup'], '$.workspace', collector);
    return {
      strategy: 'command',
      setup: argvValue(raw.setup, '$.workspace.setup', collector, true),
      reset: argvValue(raw.reset, '$.workspace.reset', collector, true),
      cleanup: argvValue(raw.cleanup, '$.workspace.cleanup', collector, true),
    };
  }
  collector.add('$.workspace.strategy', 'expected git-worktree or command');
  rejectUnknown(raw, ['strategy', 'repository', 'base_ref', 'setup', 'reset', 'cleanup'], '$.workspace', collector);
  return { strategy: 'git-worktree', repository: '' };
}

function validateTargets(value: Json | undefined, collector: IssueCollector): TargetConfig[] {
  const values = arrayValue(value, '$.targets', collector, 1, 64);
  const seen = new Set<string>();
  return values.map((entry, index) => {
    const path = `$.targets[${index}]`;
    const raw = objectValue(entry, path, collector);
    rejectUnknown(raw, ['id', 'adapter', 'configuration', 'watch'], path, collector);
    const id = idValue(raw.id, `${path}.id`, collector);
    if (seen.has(id)) collector.add(`${path}.id`, 'duplicate target ID; target IDs must be unique');
    seen.add(id);
    const adapter = idValue(raw.adapter, `${path}.adapter`, collector);
    const configuration = raw.configuration === undefined ? {} : objectValue(raw.configuration, `${path}.configuration`, collector);
    const watch = objectValue(raw.watch, `${path}.watch`, collector);
    if (Object.keys(watch).length === 0) collector.add(`${path}.watch`, 'must define an explicit watch scope');
    if (adapter === 'git-filesystem') {
      for (const runtimeField of ['sourcePath', 'inPlace', 'watchPaths', 'watchBranches']) {
        if (Object.hasOwn(configuration, runtimeField)) {
          collector.add(`${path}.configuration.${runtimeField}`, 'is runtime-owned; declare the disposable workspace and watch.paths instead');
        }
      }
    }
    validateBuiltinWatch(adapter, configuration, watch, path, collector);
    validatePathFields(configuration, `${path}.configuration`, collector);
    validatePathFields(watch, `${path}.watch`, collector);
    return { id, adapter, configuration, watch };
  });
}

function validateBuiltinWatch(
  adapter: string,
  configuration: JsonObject,
  watch: JsonObject,
  targetPath: string,
  collector: IssueCollector,
): void {
  const path = `${targetPath}.watch`;
  if (adapter === 'git-filesystem') {
    rejectUnknown(watch, ['branches', 'paths'], path, collector);
    scopedStringArray(watch.paths, `${path}.paths`, collector, 1);
    const filesystemMode = configuration.mode === 'filesystem';
    if (filesystemMode) {
      if (watch.branches !== undefined) collector.add(`${path}.branches`, 'is only valid when configuration.mode is git');
      return;
    }
    const branches = scopedStringArray(watch.branches, `${path}.branches`, collector, 1);
    const baseRefs = Array.isArray(configuration.baseRefs)
      ? configuration.baseRefs.filter((entry): entry is string => typeof entry === 'string')
      : [];
    for (const ref of baseRefs) {
      if (!branches.includes(ref)) collector.add(`${targetPath}.configuration.baseRefs`, `ref '${ref}' must also be declared in watch.branches`);
    }
    return;
  }
  if (adapter === 'postgres') {
    rejectUnknown(watch, ['tables'], path, collector);
    scopedStringArray(watch.tables, `${path}.tables`, collector, 1);
    return;
  }
  if (adapter === 'github-api') {
    rejectUnknown(watch, ['issues', 'pullRequests', 'branches'], path, collector);
    const issues = scopedPositiveIntegerArray(watch.issues, `${path}.issues`, collector);
    const pullRequests = scopedPositiveIntegerArray(watch.pullRequests, `${path}.pullRequests`, collector);
    const branches = scopedStringArray(watch.branches, `${path}.branches`, collector, 0);
    if (issues.length + pullRequests.length + branches.length === 0) collector.add(path, 'must declare at least one issue, pull request, or branch');
  }
}

function scopedStringArray(
  value: Json | undefined,
  path: string,
  collector: IssueCollector,
  minimum: number,
): string[] {
  if (value === undefined && minimum === 0) return [];
  const entries = arrayValue(value, path, collector, minimum, 128);
  const output = entries.map((entry, index) => stringValue(entry, `${path}[${index}]`, collector, 1024));
  const seen = new Set<string>();
  output.forEach((entry, index) => {
    if (seen.has(entry)) collector.add(`${path}[${index}]`, 'contains a duplicate watch value');
    seen.add(entry);
  });
  return output;
}

function scopedPositiveIntegerArray(value: Json | undefined, path: string, collector: IssueCollector): number[] {
  if (value === undefined) return [];
  const entries = arrayValue(value, path, collector, 0, 128);
  const output = entries.map((entry, index) => integerValue(entry, `${path}[${index}]`, collector, 1, Number.MAX_SAFE_INTEGER));
  const seen = new Set<number>();
  output.forEach((entry, index) => {
    if (seen.has(entry)) collector.add(`${path}[${index}]`, 'contains a duplicate watch value');
    seen.add(entry);
  });
  return output;
}

function validateClaimExtraction(value: Json, collector: IssueCollector): ClaimExtractionConfig {
  const raw = objectValue(value, '$.claim_extraction', collector);
  const type = stringValue(raw.type, '$.claim_extraction.type', collector);
  switch (type) {
    case 'stdout-final':
      rejectUnknown(raw, ['type'], '$.claim_extraction', collector);
      return { type };
    case 'json-field': {
      rejectUnknown(raw, ['type', 'field'], '$.claim_extraction', collector);
      const field = stringValue(raw.field, '$.claim_extraction.field', collector, 256);
      if (!isSafeFieldPath(field)) collector.add('$.claim_extraction.field', 'must be a dotted object field path without traversal segments');
      return { type, field };
    }
    case 'line-prefix':
      rejectUnknown(raw, ['type', 'prefix'], '$.claim_extraction', collector);
      return { type, prefix: stringValue(raw.prefix, '$.claim_extraction.prefix', collector, 1024) };
    case 'regex': {
      rejectUnknown(raw, ['type', 'pattern', 'max_bytes'], '$.claim_extraction', collector);
      const pattern = stringValue(raw.pattern, '$.claim_extraction.pattern', collector, MAX_REGEX_BYTES);
      const maxBytes = integerValue(raw.max_bytes, '$.claim_extraction.max_bytes', collector, 1, MAX_EXTRACT_BYTES);
      validateRegex(pattern, collector);
      return { type, pattern, max_bytes: maxBytes };
    }
    case 'output-file':
      rejectUnknown(raw, ['type', 'path', 'max_bytes'], '$.claim_extraction', collector);
      return {
        type,
        path: relativePathValue(raw.path, '$.claim_extraction.path', collector),
        max_bytes: integerValue(raw.max_bytes, '$.claim_extraction.max_bytes', collector, 1, MAX_EXTRACT_BYTES),
      };
    default:
      collector.add('$.claim_extraction.type', 'expected stdout-final, json-field, line-prefix, regex, or output-file');
      rejectUnknown(raw, ['type', 'field', 'prefix', 'pattern', 'path', 'max_bytes'], '$.claim_extraction', collector);
      return { type: 'stdout-final' };
  }
}

function validateContract(raw: JsonObject, collector: IssueCollector): OculoryContractConfig {
  rejectUnknown(raw, ['version', 'task', 'tolerance', 'assertions'], '$', collector);
  const version = stringValue(raw.version, '$.version', collector);
  if (version !== CONTRACT_SCHEMA_VERSION) collector.add('$.version', `expected ${CONTRACT_SCHEMA_VERSION}`);
  const task = idValue(raw.task, '$.task', collector);
  const toleranceRaw = raw.tolerance === undefined ? undefined : objectValue(raw.tolerance, '$.tolerance', collector);
  if (toleranceRaw !== undefined) rejectUnknown(toleranceRaw, ['runs', 'min_pass'], '$.tolerance', collector);
  const runs = toleranceRaw === undefined
    ? DEFAULT_CONTRACT_TOLERANCE.runs
    : integerValue(toleranceRaw.runs, '$.tolerance.runs', collector, 1, 1000);
  const minPass = toleranceRaw === undefined
    ? DEFAULT_CONTRACT_TOLERANCE.min_pass
    : integerValue(toleranceRaw.min_pass, '$.tolerance.min_pass', collector, 1, 1000);
  if (minPass > runs) collector.add('$.tolerance.min_pass', 'must be less than or equal to tolerance.runs');

  const assertionsRaw = arrayValue(raw.assertions, '$.assertions', collector, 1, 512);
  const seen = new Set<string>();
  const assertions: ContractAssertion[] = assertionsRaw.map((entry, index) => {
    const path = `$.assertions[${index}]`;
    const assertion = objectValue(entry, path, collector);
    rejectUnknown(assertion, ['id', 'target', 'selector', 'operator', 'expected', 'evaluation'], path, collector);
    const id = idValue(assertion.id, `${path}.id`, collector);
    if (seen.has(id)) collector.add(`${path}.id`, 'duplicate assertion ID; assertion IDs must be unique');
    seen.add(id);
    const target = idValue(assertion.target, `${path}.target`, collector);
    const selector = objectValue(assertion.selector, `${path}.selector`, collector);
    validatePathFields(selector, `${path}.selector`, collector);
    const operatorRaw = stringValue(assertion.operator, `${path}.operator`, collector);
    if (!OPERATORS.has(operatorRaw as ContractOperator)) {
      collector.add(`${path}.operator`, 'expected exists, equals, count, unchanged, none, or subset');
    }
    const evaluationRaw = stringValue(assertion.evaluation, `${path}.evaluation`, collector);
    if (!EVALUATIONS.has(evaluationRaw as EvaluationMode)) {
      collector.add(`${path}.evaluation`, 'expected exact, subset, or ignore');
    }
    if (!Object.hasOwn(assertion, 'expected')) collector.add(`${path}.expected`, 'is required, including when the expected value is null');
    if (containsPrivatePath(assertion.expected)) collector.add(`${path}.expected`, 'must not contain a private absolute path');
    return {
      id,
      target,
      selector,
      operator: OPERATORS.has(operatorRaw as ContractOperator) ? operatorRaw as ContractOperator : 'equals',
      expected: assertion.expected ?? null,
      evaluation: EVALUATIONS.has(evaluationRaw as EvaluationMode) ? evaluationRaw as EvaluationMode : 'exact',
    };
  });

  return {
    version: CONTRACT_SCHEMA_VERSION,
    task,
    tolerance: { runs, min_pass: minPass },
    assertions,
  };
}

function readBoundedConfig(path: string, kind: 'task' | 'contract'): string {
  try {
    const size = statSync(path).size;
    if (size > MAX_CONFIG_BYTES) {
      throw new ConfigValidationError(kind, [
        { path: basename(path), message: `file exceeds ${MAX_CONFIG_BYTES} bytes` },
      ]);
    }
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ConfigValidationError) throw error;
    throw new ConfigValidationError(kind, [{
      path: basename(path),
      message: error instanceof Error && 'code' in error ? `could not be read (${String(error.code)})` : 'could not be read',
    }]);
  }
}

class IssueCollector {
  readonly issues: ConfigValidationIssue[] = [];

  constructor(readonly kind: 'task' | 'contract') {}

  add(path: string, message: string): void {
    if (this.issues.length < MAX_ISSUES + 1) this.issues.push({ path, message });
  }

  throwIfAny(): void {
    if (this.issues.length > 0) throw new ConfigValidationError(this.kind, this.issues);
  }
}

function rejectUnknown(raw: JsonObject, allowed: readonly string[], path: string, collector: IssueCollector): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw).sort()) {
    if (!allowedSet.has(key)) collector.add(`${path}.${safePathSegment(key)}`, 'unknown field');
  }
}

function objectValue(value: Json | undefined | unknown, path: string, collector: IssueCollector): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    collector.add(path, 'must be an object');
    return {};
  }
  return value as JsonObject;
}

function arrayValue(
  value: Json | undefined,
  path: string,
  collector: IssueCollector,
  minimum: number,
  maximum: number,
): Json[] {
  if (!Array.isArray(value)) {
    collector.add(path, `must be an array with ${minimum}-${maximum} items`);
    return [];
  }
  if (value.length < minimum || value.length > maximum) collector.add(path, `must contain ${minimum}-${maximum} items`);
  return value.slice(0, maximum);
}

function stringValue(value: Json | undefined, path: string, collector: IssueCollector, maximumBytes = 4096): string {
  if (typeof value !== 'string' || value.length === 0) {
    collector.add(path, 'must be a non-empty string');
    return '';
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) collector.add(path, `must be at most ${maximumBytes} bytes`);
  return value;
}

function optionalStringValue(value: Json | undefined, path: string, collector: IssueCollector, maximumBytes: number): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, path, collector, maximumBytes);
}

function idValue(value: Json | undefined, path: string, collector: IssueCollector): string {
  const result = stringValue(value, path, collector, 64);
  if (result !== '' && !ID.test(result)) collector.add(path, 'must match ^[a-z][a-z0-9-]{0,63}$');
  return result;
}

function integerValue(
  value: Json | undefined,
  path: string,
  collector: IssueCollector,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    collector.add(path, `must be an integer from ${minimum} to ${maximum}`);
    return minimum;
  }
  return Number(value);
}

function argvValue(value: Json | undefined, path: string, collector: IssueCollector, requireExecutable: boolean): string[] {
  const entries = arrayValue(value, path, collector, requireExecutable ? 1 : 0, MAX_ARGUMENTS);
  const argv = entries.map((entry, index) => stringValue(entry, `${path}[${index}]`, collector, MAX_ARGUMENT_BYTES));
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    validatePlaceholders(argument, `${path}[${index}]`, collector);
    if (SHELL_SYNTAX.test(argument)) collector.add(`${path}[${index}]`, 'contains shell syntax; use literal argv entries');
    if (hasTraversalSegment(argument)) collector.add(`${path}[${index}]`, 'contains an unsafe path traversal segment');
    if (SECRET_ARGUMENT.test(argument)) {
      collector.add(`${path}[${index}]`, 'credential values may not be passed in argv; use an allowlisted environment variable');
    }
  }
  if (requireExecutable && argv.length > 0) validateExecutable(argv[0] ?? '', `${path}[0]`, collector);
  return argv;
}

function executableValue(value: Json | undefined, path: string, collector: IssueCollector): string {
  const executable = stringValue(value, path, collector, MAX_ARGUMENT_BYTES);
  validateExecutable(executable, path, collector);
  return executable;
}

function validateExecutable(executable: string, path: string, collector: IssueCollector): void {
  if (PLACEHOLDER.test(executable)) collector.add(path, 'executable may not contain placeholders');
  PLACEHOLDER.lastIndex = 0;
  if (SHELL_SYNTAX.test(executable)) collector.add(path, 'must be one executable, not a shell command');
  if (hasTraversalSegment(executable)) collector.add(path, 'contains an unsafe path traversal segment');
  const name = executable.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  if (SHELL_EXECUTABLES.has(name)) collector.add(path, 'shell interpreters are not allowed; name the executable directly');
}

function validatePlaceholders(value: string, path: string, collector: IssueCollector): void {
  for (const placeholder of value.match(PLACEHOLDER) ?? []) {
    if (!(PROFILE_PLACEHOLDERS as readonly string[]).includes(placeholder)) {
      collector.add(path, `unknown placeholder; allowed placeholders are ${PROFILE_PLACEHOLDERS.join(', ')}`);
    }
  }
  if (value.replace(PLACEHOLDER, '').includes('{') || value.replace(PLACEHOLDER, '').includes('}')) {
    collector.add(path, 'contains a malformed placeholder');
  }
  PLACEHOLDER.lastIndex = 0;
}

function envAllowlistValue(value: Json | undefined, path: string, collector: IssueCollector): string[] {
  const entries = arrayValue(value, path, collector, 0, 128);
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const name = stringValue(entries[index], `${path}[${index}]`, collector, 128);
    if (name !== '' && !ENV_NAME.test(name)) collector.add(`${path}[${index}]`, 'must be an environment variable name, not a value');
    if (SECRET_SHAPED.test(name)) collector.add(`${path}[${index}]`, 'must name an environment variable, not contain a credential value');
    if (seen.has(name)) collector.add(`${path}[${index}]`, 'contains a duplicate environment variable name');
    seen.add(name);
    result.push(name);
  }
  return result;
}

function relativePathValue(value: Json | undefined, path: string, collector: IssueCollector): string {
  const result = stringValue(value, path, collector, MAX_ARGUMENT_BYTES);
  if (!isSafeRelativePath(result)) collector.add(path, 'must stay inside the disposable workspace and may not contain traversal segments');
  return result;
}

function isSafeRelativePath(value: string): boolean {
  if (value === '') return false;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.includes('\0')) return false;
  return !hasTraversalSegment(normalized);
}

function hasTraversalSegment(value: string): boolean {
  return value.replaceAll('\\', '/').split('/').some((segment) => segment === '..');
}

function validatePathFields(value: Json, path: string, collector: IssueCollector, depth = 0): void {
  if (depth > MAX_NESTING_DEPTH) return;
  if (typeof value === 'string') {
    if (hasTraversalSegment(value)) collector.add(path, 'value may not contain path traversal segments');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validatePathFields(entry, `${path}[${index}]`, collector, depth + 1));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${safePathSegment(key)}`;
    if (PATH_KEY.test(key)) {
      if (typeof entry === 'string' && !hasTraversalSegment(entry) && !isSafeRelativePath(entry)) {
        collector.add(entryPath, 'path must stay inside the disposable workspace and may not contain traversal segments');
      } else if (Array.isArray(entry)) {
        entry.forEach((candidate, index) => {
          if (typeof candidate === 'string' && !hasTraversalSegment(candidate) && !isSafeRelativePath(candidate)) {
            collector.add(`${entryPath}[${index}]`, 'path must stay inside the disposable workspace and may not contain traversal segments');
          }
        });
      }
    }
    validatePathFields(entry, entryPath, collector, depth + 1);
  }
}

function validateJsonValue(value: unknown, path: string, depth: number, collector: IssueCollector): value is Json {
  if (depth > MAX_NESTING_DEPTH) {
    collector.add(path, `nesting exceeds ${MAX_NESTING_DEPTH} levels`);
    return false;
  }
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') {
    if (SECRET_CONTENT.test(value)) collector.add(path, 'must not contain a credential value or credential-shaped content; use an allowlisted environment variable');
    return true;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) collector.add(path, 'number must be finite');
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) collector.add(path, `array exceeds ${MAX_COLLECTION_ITEMS} items`);
    value.slice(0, MAX_COLLECTION_ITEMS).forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, depth + 1, collector));
    return true;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_COLLECTION_ITEMS) collector.add(path, `object exceeds ${MAX_COLLECTION_ITEMS} fields`);
    for (const [key, entry] of entries.slice(0, MAX_COLLECTION_ITEMS)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) collector.add(`${path}.${safePathSegment(key)}`, 'unsafe object key');
      validateJsonValue(entry, `${path}.${safePathSegment(key)}`, depth + 1, collector);
    }
    return true;
  }
  collector.add(path, 'must be a JSON-compatible value');
  return false;
}

function containsPrivatePath(value: unknown): boolean {
  if (typeof value === 'string') return PRIVATE_PATH_CONTENT.test(value);
  if (Array.isArray(value)) return value.some(containsPrivatePath);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .some(([key, entry]) => PRIVATE_PATH_CONTENT.test(key) || containsPrivatePath(entry));
  }
  return false;
}

function validateRegex(pattern: string, collector: IssueCollector): void {
  try {
    assertSafeClaimRegex(pattern);
  } catch (error) {
    collector.add('$.claim_extraction.pattern', error instanceof Error ? error.message : 'must be a bounded safe regular expression');
  }
}

function isSafeFieldPath(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(value);
}

function safePathSegment(value: string): string {
  if (SECRET_SHAPED.test(value)) return '[redacted-key]';
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : JSON.stringify(value);
}

function bound(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}
