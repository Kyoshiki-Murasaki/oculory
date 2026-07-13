const ALLOWED_TOP_LEVEL_FILES = new Set([
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'package.json',
]);

const ALLOWED_TOP_LEVEL_DIRECTORIES = new Set(['bin', 'dist', 'docs', 'fixtures']);

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  'package.json',
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'bin/oculory',
  'fixtures/seed.json',
  'dist/src/cli/main.js',
  'dist/src/server/main.js',
  'dist/src/pipeline/store.js',
]);

export const PROHIBITED_PACKAGE_CHECKS = Object.freeze([
  'Git and GitHub metadata',
  'dependencies and compiled tests',
  'test-only support code',
  'local Oculory evidence and run roots',
  'environment and credential material',
  'archives and Git bundles',
  'coverage and temporary output',
  'private handoff material',
  'raw transcripts and evidence sidecars',
  'local absolute paths',
  'credential-like content',
]);

const PATH_RULES = [
  ['Git and GitHub metadata', /(^|\/)\.git(?:\/|$)|(^|\/)\.github(?:\/|$)/i],
  ['dependencies and compiled tests', /(^|\/)node_modules(?:\/|$)|^dist\/test(?:\/|$)/i],
  ['test-only support code', /(^|\/)tests?(?:\/|$)|(^|\/)test-support(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]s$/i],
  ['local Oculory evidence and run roots', /(^|\/)\.oculory(?:[-/]|$)|(^|\/)(?:runs-live|runs-external|runs-model)(?:\/|$)/i],
  ['environment and credential material', /(^|\/)\.env(?:\.|$)|(^|\/)(?:credentials?|secrets?)(?:\/|\.(?:json|ya?ml|txt)$)|\.(?:pem|key|p12|pfx)$/i],
  ['archives and Git bundles', /\.(?:bundle|tar|tar\.gz|tgz|zip|7z|gz)$/i],
  ['coverage and temporary output', /(^|\/)(?:coverage|\.nyc_output|tmp|temp)(?:\/|$)|(?:\.tmp|\.temp|\.swp|~)$|(^|\/)\.DS_Store$/i],
  ['private handoff material', /(^|\/)(?:private|handoff)(?:[-_/]|$)|(^|\/)pasted-text(?:\.|$)/i],
  ['raw transcripts and evidence sidecars', /(^|\/)(?:raw-evidence|transcripts?|sidecars?)(?:\/|$)/i],
];

const CONTENT_RULES = [
  ['local absolute paths', /(?:^|[\s`"'(])(?:\/Users\/[^\s`"')]+|\/home\/[^\s`"')]+|[A-Za-z]:\\Users\\[^\s`"')]+|file:\/\/\/[^\s`"')]+)/m],
  ['credential-like content', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-ant-|sk-|gh[pousr]_)[A-Za-z0-9_-]{20,}\b/],
  ['private handoff material', /\.codex\/attachments\/|pasted-text\.txt|\/private-history\//i],
];

function normalizePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/^package\//, '');
}

export function packagePaths(entries) {
  return entries.map((entry) => normalizePath(typeof entry === 'string' ? entry : entry.path));
}

export function validatePackageEntries(entries, readText = () => null) {
  const paths = packagePaths(entries);
  const errors = [];
  const pathSet = new Set(paths);

  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!pathSet.has(required)) errors.push(`missing required package file: ${required}`);
  }

  if (!paths.some((path) => path.startsWith('dist/src/') && path.endsWith('.js'))) {
    errors.push('missing compiled runtime JavaScript under dist/src');
  }

  for (const path of paths) {
    const [top] = path.split('/');
    if (!ALLOWED_TOP_LEVEL_FILES.has(path) && !ALLOWED_TOP_LEVEL_DIRECTORIES.has(top)) {
      errors.push(`unexpected top-level package path: ${path}`);
    }
    for (const [category, pattern] of PATH_RULES) {
      if (pattern.test(path)) errors.push(`${category}: ${path}`);
    }

    const text = readText(path);
    if (typeof text !== 'string') continue;
    for (const [category, pattern] of CONTENT_RULES) {
      if (pattern.test(text)) errors.push(`${category}: ${path}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`package verification failed:\n- ${[...new Set(errors)].join('\n- ')}`);
  }

  return {
    fileCount: paths.length,
    requiredFiles: [...REQUIRED_PACKAGE_FILES],
    prohibitedChecks: [...PROHIBITED_PACKAGE_CHECKS],
  };
}
