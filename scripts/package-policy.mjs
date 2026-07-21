import { TextDecoder } from 'node:util';

export const MAX_PACKAGE_FILES = 1024;
export const MAX_PACKAGE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PACKAGE_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_PACKAGE_TARBALL_BYTES = 16 * 1024 * 1024;

const ALLOWED_EXACT_FILES = new Set([
  'LICENSE',
  'README.md',
  'bin/oculory',
  'bin/oculory-demo-agent',
  'bin/oculory-demo-fixture',
  'bin/oculory-demo-server',
  'fixtures/demo/contract.yaml',
  'fixtures/demo/task.yaml',
  'fixtures/seed.json',
  'package.json',
  'schemas/contract.schema.json',
  'schemas/task.schema.json',
]);

const ALLOWED_PREFIXES = Object.freeze([
  'dist/src/',
]);

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  'package.json',
  'README.md',
  'LICENSE',
  'bin/oculory',
  'bin/oculory-demo-agent',
  'bin/oculory-demo-fixture',
  'bin/oculory-demo-server',
  'schemas/task.schema.json',
  'schemas/contract.schema.json',
  'fixtures/demo/task.yaml',
  'fixtures/demo/contract.yaml',
  'fixtures/seed.json',
]);

export const REQUIRED_PACKAGE_GROUPS = Object.freeze([
  Object.freeze({
    name: 'compiled CLI runtime',
    example: 'dist/src/cli/main.js',
    matches: (path) => path === 'dist/src/cli/main.js',
  }),
  Object.freeze({
    name: 'Git/filesystem adapter runtime',
    example: 'dist/src/mlp/adapters/git-filesystem.js',
    matches: (path) => path === 'dist/src/mlp/adapters/git-filesystem.js',
  }),
  Object.freeze({
    name: 'Postgres adapter runtime',
    example: 'dist/src/mlp/adapters/postgres.js',
    matches: (path) => path === 'dist/src/mlp/adapters/postgres.js',
  }),
  Object.freeze({
    name: 'GitHub API adapter runtime',
    example: 'dist/src/mlp/adapters/github.js',
    matches: (path) => path === 'dist/src/mlp/adapters/github.js',
  }),
  Object.freeze({
    name: 'scripted demo agent runtime',
    example: 'dist/src/mlp/scripted-agent-main.js',
    matches: (path) => path === 'dist/src/mlp/scripted-agent-main.js',
  }),
  Object.freeze({
    name: 'toy demo MCP server runtime',
    example: 'dist/src/mlp/demo-server-main.js',
    matches: (path) => path === 'dist/src/mlp/demo-server-main.js',
  }),
  Object.freeze({
    name: 'deterministic demo fixture runtime',
    example: 'dist/src/mlp/demo-fixture-main.js',
    matches: (path) => path === 'dist/src/mlp/demo-fixture-main.js',
  }),
]);

export const PROHIBITED_PACKAGE_CHECKS = Object.freeze([
  'Git and GitHub metadata',
  'dependencies and compiled tests',
  'test-only support code',
  'developer-only fixtures',
  'local Oculory evidence and run roots',
  'pilot reports and operations/session workspaces',
  'environment and credential material',
  'archives and Git bundles',
  'coverage and temporary output',
  'private handoff material',
  'raw runs, evidence, transcripts, and sidecars',
  'local absolute paths',
  'credential-like content',
  'binary or invalid UTF-8 content',
  'oversized files and package totals',
]);

const PATH_RULES = [
  ['Git and GitHub metadata', /(^|\/)\.git(?:\/|$)|(^|\/)\.github(?:\/|$)/i],
  ['dependencies and compiled tests', /(^|\/)node_modules(?:\/|$)|^dist\/test(?:\/|$)/i],
  ['test-only support code', /(^|\/)tests?(?:\/|$)|(^|\/)test-support(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]s$/i],
  ['developer-only fixtures', /(^|\/)(?:developer-only|dev-only|internal-only|private-fixture)(?:[._/-]|$)/i],
  ['local Oculory evidence and run roots', /(^|\/)\.oculory(?:[-/]|$)|(^|\/)(?:runs-live|runs-external|runs-model)(?:\/|$)/i],
  ['pilot reports and operations/session workspaces', /(^|\/)(?:(?:oculory-)?pilot[-_](?:operations|sessions)|pilot[-_]?reports?|operations[-_]?workspace|sessions?[-_]?workspace)(?:[._\/-]|$)|(^|\/)(?:pilot|operations|reviews?|authorizations?|manifests?|mutations?|suites?)(?:\/|$)/i],
  ['environment and credential material', /(^|\/)\.env(?:\.|$)|(^|\/)(?:credentials?|secrets?)(?:\/|\.(?:json|ya?ml|txt)$)|\.(?:pem|key|p12|pfx)$/i],
  ['archives and Git bundles', /\.(?:bundle|tar|tar\.gz|tgz|zip|7z|gz)$/i],
  ['coverage and temporary output', /(^|\/)(?:coverage|\.nyc_output|tmp|temp)(?:\/|$)|(?:\.tmp|\.temp|\.swp|~)$|(^|\/)\.DS_Store$/i],
  ['private handoff material', /(^|\/)(?:private|handoff)(?:[._\/-]|$)|(^|\/)pasted-text(?:[._\/-]|$)/i],
  ['raw runs, evidence, transcripts, and sidecars', /(^|\/)(?:raw[-_]?(?:runs?|evidence)|transcripts?|sidecars?)(?:[._\/-]|$)/i],
];

const CONTENT_RULES = [
  ['local absolute paths', /(?:^|[\s`"'(=:[,])(?:\/Users\/[^\s`"')]+|\/home\/[^\s`"')]+|\/root\/[^\s`"')]+|\/(?:private\/)?var\/folders\/[^\s`"')]+|[A-Za-z]:[\\/]Users[\\/][^\s`"')]+|file:\/\/\/[^\s`"')]+)/m],
  ['credential-like content', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-ant-|sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{20,}\b|\bAKIA[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{30,}\b|\b_authToken\s*[=:]\s*[^\s"']{12,}|\bAuthorization\s*:\s*Bearer\s+[^\s"']{12,}|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@/i],
  ['private handoff material', /\.codex\/attachments\/|pasted-text\.txt|\/private-history\//i],
];

function normalizePath(value) {
  const path = String(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/^package\//, '');
  if (
    path.length === 0 || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || /[\0\r\n]/.test(path) ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('package verification failed:\n- package content contains an unsafe path');
  }
  return path;
}

function allowedPath(path) {
  return ALLOWED_EXACT_FILES.has(path) || ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function packagePaths(entries) {
  return entries.map((entry) => normalizePath(typeof entry === 'string' ? entry : entry.path));
}

export function validatePackageEntries(entries, readContent = () => null, options = {}) {
  const paths = packagePaths(entries);
  const errors = [];
  const pathSet = new Set(paths);
  const privatePathValues = normalizedPrivatePathValues(options.privatePathValues);
  let declaredBytes = 0;
  let scannedBytes = 0;
  let scanBudgetExceeded = false;

  if (paths.length > MAX_PACKAGE_FILES) errors.push(`package contains more than ${MAX_PACKAGE_FILES} files`);
  if (pathSet.size !== paths.length) errors.push('package content contains duplicate paths');
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!pathSet.has(required)) errors.push(`missing required package file: ${required}`);
  }
  for (const group of REQUIRED_PACKAGE_GROUPS) {
    if (!paths.some(group.matches)) errors.push(`missing required package group: ${group.name}`);
  }

  entries.forEach((entry, index) => {
    if (typeof entry === 'string' || entry === null || typeof entry !== 'object' || entry.size === undefined) return;
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      errors.push(`package file has an invalid declared size: ${paths[index]}`);
      return;
    }
    declaredBytes += entry.size;
    if (entry.size > MAX_PACKAGE_FILE_BYTES) {
      errors.push(`package file exceeds ${MAX_PACKAGE_FILE_BYTES} declared bytes: ${paths[index]}`);
    }
  });
  if (declaredBytes > MAX_PACKAGE_TOTAL_BYTES) {
    errors.push(`package contents exceed ${MAX_PACKAGE_TOTAL_BYTES} declared bytes`);
  }

  for (const path of paths) {
    if (!allowedPath(path)) errors.push(`unexpected package path: ${path}`);
    for (const [category, pattern] of PATH_RULES) {
      if (pattern.test(path)) errors.push(`${category}: ${path}`);
    }

    if (scanBudgetExceeded) continue;
    const content = readContent(path);
    if (content === null || content === undefined) continue;
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    scannedBytes += bytes.length;
    if (bytes.length > MAX_PACKAGE_FILE_BYTES) {
      errors.push(`package file exceeds ${MAX_PACKAGE_FILE_BYTES} scanned bytes: ${path}`);
      continue;
    }
    if (scannedBytes > MAX_PACKAGE_TOTAL_BYTES) {
      errors.push(`package contents exceed ${MAX_PACKAGE_TOTAL_BYTES} scanned bytes`);
      scanBudgetExceeded = true;
      continue;
    }
    if (bytes.includes(0)) {
      errors.push(`binary content is not allowed: ${path}`);
      continue;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      errors.push(`invalid UTF-8 content is not allowed: ${path}`);
      continue;
    }
    if (privatePathValues.some((value) => text.includes(value))) errors.push(`local absolute paths: ${path}`);
    for (const [category, pattern] of CONTENT_RULES) {
      if (pattern.test(text)) errors.push(`${category}: ${path}`);
    }
  }
  entries.forEach((entry, index) => {
    if (typeof entry === 'string' || !paths[index]?.startsWith('bin/')) return;
    if (Number.isInteger(entry.mode) && (entry.mode & 0o111) === 0) errors.push(`package launcher is not executable: ${paths[index]}`);
  });

  if (errors.length > 0) {
    throw new Error(`package verification failed:\n- ${[...new Set(errors)].join('\n- ')}`);
  }

  return {
    fileCount: paths.length,
    requiredFiles: [...REQUIRED_PACKAGE_FILES],
    requiredGroups: REQUIRED_PACKAGE_GROUPS.map((group) => group.name),
    prohibitedChecks: [...PROHIBITED_PACKAGE_CHECKS],
    declaredBytes,
    scannedBytes,
  };
}

function normalizedPrivatePathValues(values) {
  if (!Array.isArray(values)) return [];
  const output = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 4) continue;
    output.add(value);
    output.add(value.replaceAll('\\', '/'));
    output.add(value.replaceAll('/', '\\'));
  }
  return [...output];
}
