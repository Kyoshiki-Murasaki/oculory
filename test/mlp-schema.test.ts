import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConfigValidationError,
  loadContractConfig,
  loadTaskConfig,
  parseContractConfig,
  parseTaskConfig,
} from '../src/mlp/config.js';
import {
  CONTRACT_SCHEMA_VERSION,
  DEFAULT_CONTRACT_TOLERANCE,
  PROFILE_PLACEHOLDERS,
  TASK_SCHEMA_VERSION,
} from '../src/mlp/types.js';

const root = process.cwd();
const taskExample = join(root, 'examples/v0.1/task.yaml');
const contractExample = join(root, 'examples/v0.1/contract.yaml');

const validTask = `
version: oculory-task-v1
task_id: demo-task
prompt: Make the requested change.
agent_profiles:
  local-agent:
    argv: [local-agent, --prompt, "{prompt}"]
    env_allowlist: [PATH]
mcp_server:
  command: task-mcp-server
  arguments: []
  env_allowlist: []
workspace:
  strategy: git-worktree
  repository: .
targets:
  - id: repository
    adapter: git-filesystem
    watch:
      branches: [main]
      paths: [src]
`;

const validContract = `
version: oculory-contract-v1
task: demo-task
assertions:
  - id: source-exists
    target: repository
    selector:
      path: src
    operator: exists
    expected: true
    evaluation: exact
`;

test('worked task and contract examples load without rewriting their source', () => {
  const taskBefore = readFileSync(taskExample, 'utf8');
  const contractBefore = readFileSync(contractExample, 'utf8');

  const task = loadTaskConfig(taskExample);
  const contract = loadContractConfig(contractExample);

  assert.equal(task.value.version, TASK_SCHEMA_VERSION);
  assert.equal(task.value.task_id, 'create-feature-branch');
  assert.deepEqual(task.value.mcp_server.env_allowlist, ['PATH']);
  assert.equal(task.value.claim_extraction.type, 'line-prefix');
  assert.match(task.document.toString(), /Oculory records the executable/);
  assert.equal(contract.value.version, CONTRACT_SCHEMA_VERSION);
  assert.deepEqual(contract.value.tolerance, { runs: 12, min_pass: 10 });
  assert.match(contract.document.toString(), /editable outcome contract/);

  assert.equal(readFileSync(taskExample, 'utf8'), taskBefore);
  assert.equal(readFileSync(contractExample, 'utf8'), contractBefore);
});

test('loader normalizes defaults in values without mutating retained documents', () => {
  const task = parseTaskConfig(validTask);
  const contract = parseContractConfig(validContract);

  assert.deepEqual(task.value.claim_extraction, { type: 'stdout-final' });
  assert.equal(task.document.has('claim_extraction'), false);
  assert.deepEqual(contract.value.tolerance, DEFAULT_CONTRACT_TOLERANCE);
  assert.equal(contract.document.has('tolerance'), false);
  assert.deepEqual(task.value.targets[0]?.configuration, {});
  assert.equal(task.document.hasIn(['targets', 0, 'configuration']), false);
});

test('only the documented profile placeholders are accepted', () => {
  const loaded = parseTaskConfig(validTask.replace('[local-agent, --prompt, "{prompt}"]', `[local-agent, ${PROFILE_PLACEHOLDERS.map((value) => JSON.stringify(value)).join(', ')}]`));
  assert.equal(loaded.value.agent_profiles['local-agent']?.argv.length, PROFILE_PLACEHOLDERS.length + 1);

  assertConfigError(
    () => parseTaskConfig(validTask.replace('{prompt}', '{provider_token}')),
    '$.agent_profiles.local-agent.argv[2]',
    'unknown placeholder',
  );
  assertConfigError(
    () => parseTaskConfig(validTask.replace('{prompt}', '{prompt')),
    '$.agent_profiles.local-agent.argv[2]',
    'malformed placeholder',
  );
});

test('task loader rejects unknown versions, top-level fields, and structured nested fields', () => {
  assertConfigError(
    () => parseTaskConfig(validTask.replace(TASK_SCHEMA_VERSION, 'oculory-task-v2')),
    '$.version',
    TASK_SCHEMA_VERSION,
  );
  assertConfigError(() => parseTaskConfig(`${validTask}\nunexpected: true\n`), '$.unexpected', 'unknown field');
  assertConfigError(
    () => parseTaskConfig(validTask.replace('env_allowlist: [PATH]', 'env_allowlist: [PATH]\n    provider: direct-sdk')),
    '$.agent_profiles.local-agent.provider',
    'unknown field',
  );
});

test('contract loader rejects unknown versions, top-level fields, and assertion fields', () => {
  assertConfigError(
    () => parseContractConfig(validContract.replace(CONTRACT_SCHEMA_VERSION, 'oculory-contract-v2')),
    '$.version',
    CONTRACT_SCHEMA_VERSION,
  );
  assertConfigError(() => parseContractConfig(`${validContract}\nnotes: unsafe\n`), '$.notes', 'unknown field');
  assertConfigError(
    () => parseContractConfig(validContract.replace('evaluation: exact', 'evaluation: exact\n    comment: hidden')),
    '$.assertions[0].comment',
    'unknown field',
  );
});

test('task process fields require argv arrays and reject shell command forms', () => {
  assertConfigError(
    () => parseTaskConfig(validTask.replace('argv: [local-agent, --prompt, "{prompt}"]', 'argv: "local-agent --prompt {prompt}"')),
    '$.agent_profiles.local-agent.argv',
    'must be an array',
  );
  assertConfigError(
    () => parseTaskConfig(validTask.replace('command: task-mcp-server', 'command: "task-mcp-server; echo leaked"')),
    '$.mcp_server.command',
    'shell command',
  );
  assertConfigError(
    () => parseTaskConfig(validTask.replace('argv: [local-agent, --prompt, "{prompt}"]', 'argv: [bash, -c, echo]')),
    '$.agent_profiles.local-agent.argv[0]',
    'shell interpreters are not allowed',
  );

  const commandWorkspace = validTask.replace(
    'strategy: git-worktree\n  repository: .',
    'strategy: command\n  setup: "prepare workspace"\n  reset: [workspace-reset]\n  cleanup: [workspace-cleanup]',
  );
  assertConfigError(() => parseTaskConfig(commandWorkspace), '$.workspace.setup', 'must be an array');
});

test('environment allowlists accept names and reject credential-shaped values', () => {
  assert.doesNotThrow(() => parseTaskConfig(validTask.replace('env_allowlist: [PATH]', 'env_allowlist: [PATH, OCULORY_PROFILE]')));
  assertConfigError(
    () => parseTaskConfig(validTask.replace('env_allowlist: [PATH]', 'env_allowlist: [PATH, ghp_examplecredential]')),
    '$.agent_profiles.local-agent.env_allowlist[1]',
    'not contain a credential value',
  );
});

test('task process argv rejects credential-bearing flags', () => {
  assertConfigError(
    () => parseTaskConfig(validTask.replace('--prompt, "{prompt}"', '--token, synthetic-value')),
    '$.agent_profiles.local-agent.argv[1]',
    'may not be passed in argv',
  );
  assertConfigError(
    () => parseTaskConfig(validTask.replace('arguments: []', 'arguments: [--password=synthetic-value]')),
    '$.mcp_server.arguments[0]',
    'may not be passed in argv',
  );
});

test('task YAML rejects credential-shaped content instead of persisting it', () => {
  assertConfigError(
    () => parseTaskConfig(validTask.replace('Make the requested change.', 'Use Bearer synthetic-credential-value.')),
    '$.prompt',
    'credential-shaped content',
  );
  assertConfigError(
    () => parseTaskConfig(`# Bearer synthetic-comment-credential\n${validTask}`),
    '$',
    'credential-shaped content',
  );
});

test('unsafe path traversal is rejected in workspace, extractors, watch scopes, and selectors', () => {
  assertConfigError(
    () => parseTaskConfig(validTask.replace('repository: .', 'repository: ../production')),
    '$.workspace.repository',
    'traversal',
  );
  assertConfigError(
    () => parseTaskConfig(`${validTask}\nclaim_extraction:\n  type: output-file\n  path: ../../claim.txt\n  max_bytes: 1024\n`),
    '$.claim_extraction.path',
    'traversal',
  );
  assertConfigError(
    () => parseTaskConfig(validTask.replace('paths: [src]', 'paths: [src, ../private]')),
    '$.targets[0].watch.paths[1]',
    'traversal',
  );
  assertConfigError(
    () => parseContractConfig(validContract.replace('path: src', 'path: ../../private')),
    '$.assertions[0].selector.path',
    'traversal',
  );
  assertConfigError(
    () => parseContractConfig(validContract.replace('expected: true', 'expected: "/Users/example/private/result.txt"')),
    '$.assertions[0].expected',
    'private absolute path',
  );

  const spaces = parseTaskConfig(validTask.replace('repository: .', 'repository: "fixtures/project with spaces"'));
  assert.equal(spaces.value.workspace.strategy, 'git-worktree');
});

test('Git adapter source, in-place mode, and effective watch scope are runtime-owned', () => {
  for (const [field, value] of [
    ['sourcePath', '/tmp/arbitrary-real-target'],
    ['sourcePath', '"{workspace}/symlink-out"'],
    ['inPlace', 'true'],
    ['watchPaths', '[.]'],
    ['watchBranches', '[main]'],
  ]) {
    const configured = validTask.replace(
      '    watch:\n      branches: [main]\n      paths: [src]',
      `    configuration:\n      ${field}: ${value}\n    watch:\n      branches: [main]\n      paths: [src]`,
    );
    assertConfigError(
      () => parseTaskConfig(configured),
      `$.targets[0].configuration.${field}`,
      'runtime-owned',
    );
  }
});

test('duplicate target and assertion IDs are rejected', () => {
  const secondTarget = `
  - id: repository
    adapter: filesystem
    watch:
      paths: [output]
`;
  assertConfigError(
    () => parseTaskConfig(validTask.replace(/\n$/, `${secondTarget}\n`)),
    '$.targets[1].id',
    'duplicate target ID',
  );

  const secondAssertion = `
  - id: source-exists
    target: repository
    selector: {path: test}
    operator: exists
    expected: true
    evaluation: exact
`;
  assertConfigError(
    () => parseContractConfig(validContract.replace(/\n$/, `${secondAssertion}\n`)),
    '$.assertions[1].id',
    'duplicate assertion ID',
  );
});

test('contract thresholds and public vocabularies are exact', () => {
  assertConfigError(
    () => parseContractConfig(validContract.replace('assertions:', 'tolerance:\n  runs: 4\n  min_pass: 5\nassertions:')),
    '$.tolerance.min_pass',
    'less than or equal',
  );
  assertConfigError(
    () => parseContractConfig(validContract.replace('operator: exists', 'operator: contains')),
    '$.assertions[0].operator',
    'exists, equals, count, unchanged, none, or subset',
  );
  assertConfigError(
    () => parseContractConfig(validContract.replace('evaluation: exact', 'evaluation: approximate')),
    '$.assertions[0].evaluation',
    'exact, subset, or ignore',
  );
  assertConfigError(
    () => parseContractConfig(validContract.replace('    expected: true\n', '')),
    '$.assertions[0].expected',
    'is required',
  );
});

test('all safe claim extractor forms validate and unsafe regular expressions fail', () => {
  const extractors = [
    '  type: stdout-final',
    '  type: json-field\n  field: result.message',
    '  type: line-prefix\n  prefix: "CLAIM: "',
    '  type: regex\n  pattern: "CLAIM: (.+)"\n  max_bytes: 4096',
    '  type: output-file\n  path: output/claim.txt\n  max_bytes: 4096',
  ];
  for (const extractor of extractors) {
    assert.doesNotThrow(() => parseTaskConfig(`${validTask}\nclaim_extraction:\n${extractor}\n`));
  }

  assertConfigError(
    () => parseTaskConfig(`${validTask}\nclaim_extraction:\n  type: regex\n  pattern: "(a+)+"\n  max_bytes: 4096\n`),
    '$.claim_extraction.pattern',
    'at most one unbounded quantifier',
  );
  assertConfigError(
    () => parseTaskConfig(`${validTask}\nclaim_extraction:\n  type: regex\n  pattern: "(a|aa)+$"\n  max_bytes: 4096\n`),
    '$.claim_extraction.pattern',
    'alternation',
  );
  assertConfigError(
    () => parseTaskConfig(`${validTask}\nclaim_extraction:\n  type: regex\n  pattern: "(["\n  max_bytes: 4096\n`),
    '$.claim_extraction.pattern',
    'valid regular expression',
  );
});

test('aliases and duplicate YAML keys fail closed', () => {
  const aliasTask = validTask.replace(
    'watch:\n      branches: [main]\n      paths: [src]',
    'configuration: &shared {root: src}\n    watch:\n      source: *shared',
  );
  assertConfigError(() => parseTaskConfig(aliasTask), '$', 'Alias resolution is disabled');
  assertConfigError(
    () => parseTaskConfig(validTask.replace('prompt: Make the requested change.', 'prompt: first\nprompt: second')),
    '$',
    'Map keys must be unique',
  );
});

test('validation errors are actionable and bounded', () => {
  const unknownFields = Array.from({ length: 30 }, (_, index) => `unknown_${index}: true`).join('\n');
  let error: ConfigValidationError | undefined;
  try {
    parseTaskConfig(`${validTask}\n${unknownFields}\n`);
  } catch (caught) {
    if (caught instanceof ConfigValidationError) error = caught;
  }
  assert.ok(error);
  assert.ok(error.issues.length <= 8);
  assert.ok(error.message.length < 2500);
  assert.match(error.message, /^Invalid task configuration:/);
  assert.match(error.message, /more issue\(s\) omitted/);
});

test('published JSON schemas pin versions, strict roots, operators, modes, and defaults', () => {
  const taskSchema = readJsonObject(join(root, 'schemas/task.schema.json'));
  const contractSchema = readJsonObject(join(root, 'schemas/contract.schema.json'));

  assert.equal(taskSchema.additionalProperties, false);
  assert.equal(property(taskSchema, 'version').const, TASK_SCHEMA_VERSION);
  assert.deepEqual(property(taskSchema, 'claim_extraction').default, { type: 'stdout-final' });
  assert.equal(contractSchema.additionalProperties, false);
  assert.equal(property(contractSchema, 'version').const, CONTRACT_SCHEMA_VERSION);
  assert.deepEqual(property(contractSchema, 'tolerance').default, { runs: 12, min_pass: 10 });

  const assertion = definition(contractSchema, 'assertion');
  assert.deepEqual(property(assertion, 'operator').enum, ['exists', 'equals', 'count', 'unchanged', 'none', 'subset']);
  assert.deepEqual(property(assertion, 'evaluation').enum, ['exact', 'subset', 'ignore']);
});

function assertConfigError(action: () => unknown, path: string, detail: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ConfigValidationError);
    assert.ok(error.issues.some((issue) => issue.path === path && issue.message.includes(detail)), error.message);
    return true;
  });
}

function readJsonObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function property(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  const properties = schema.properties;
  assert.ok(properties !== null && typeof properties === 'object' && !Array.isArray(properties));
  const value = (properties as Record<string, unknown>)[name];
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function definition(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  const definitions = schema.$defs;
  assert.ok(definitions !== null && typeof definitions === 'object' && !Array.isArray(definitions));
  const value = (definitions as Record<string, unknown>)[name];
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
