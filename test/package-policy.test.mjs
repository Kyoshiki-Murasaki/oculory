import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PACKAGE_FILE_BYTES,
  MAX_PACKAGE_TOTAL_BYTES,
  REQUIRED_PACKAGE_FILES,
  REQUIRED_PACKAGE_GROUPS,
  validatePackageEntries,
} from '../scripts/package-policy.mjs';

const minimalPackage = [
  ...REQUIRED_PACKAGE_FILES,
  ...REQUIRED_PACKAGE_GROUPS.map((group) => group.example),
];

test('package policy accepts the deliberate public runtime allowlist', () => {
  const result = validatePackageEntries(minimalPackage, () => 'public package content');
  assert.equal(result.fileCount, minimalPackage.length);
  assert.deepEqual(result.requiredFiles, REQUIRED_PACKAGE_FILES);
});

test('package policy rejects prohibited paths and test-only material', () => {
  const prohibited = [
    '.git/config',
    '.github/workflows/ci.yml',
    'CHANGELOG.md',
    'docs/internal-report.md',
    'fixtures/developer-only.json',
    'fixtures/demo/developer-only.json',
    'fixtures/demo/raw-run.jsonl',
    'fixtures/demo/pilot-report.json',
    'node_modules/example/index.js',
    'dist/test/example.test.js',
    'test/support/helper.js',
    '.oculory/runs-live/session/transcript.json',
    '.oculory-private/report.json',
    'runs-external/evidence.json',
    '.env',
    'credentials/token.json',
    'private/archive.tgz',
    'repo.bundle',
    'coverage/index.html',
    'tmp/output.json',
    'handoff/pasted-text.txt',
    'sidecars/provider-response.json',
  ];
  for (const path of prohibited) {
    assert.throws(
      () => validatePackageEntries([...minimalPackage, path], () => 'x'),
      /package verification failed/,
      path,
    );
  }
});

test('package denylist rejects protected material even under the compiled-runtime prefix', () => {
  const prohibited = [
    ['dist/src/pasted-text-1.js', /private handoff material/],
    ['dist/src/raw-run.json', /raw runs, evidence, transcripts, and sidecars/],
    ['dist/src/raw-evidence.jsonl', /raw runs, evidence, transcripts, and sidecars/],
    ['dist/src/transcript.json', /raw runs, evidence, transcripts, and sidecars/],
    ['dist/src/pilot-report.js', /pilot reports and operations\/session workspaces/],
    ['dist/src/oculory-pilot-operations/report.js', /pilot reports and operations\/session workspaces/],
    ['dist/src/oculory-pilot-sessions/report.js', /pilot reports and operations\/session workspaces/],
  ];
  for (const [path, category] of prohibited) {
    assert.throws(
      () => validatePackageEntries([...minimalPackage, path], () => 'public package content'),
      category,
      path,
    );
  }
});

test('package policy rejects local absolute paths and credential-like content', () => {
  assert.throws(
    () => validatePackageEntries(minimalPackage, (path) => path === 'README.md' ? 'local path: /Users/person/private/repo' : 'x'),
    /local absolute paths: README\.md/,
  );
  assert.throws(
    () => validatePackageEntries(minimalPackage, (path) => path === 'README.md' ? `token: sk-${'a'.repeat(32)}` : 'x'),
    /credential-like content: README\.md/,
  );
  for (const content of [
    `//registry.npmjs.org/:_authToken=${'a'.repeat(24)}`,
    `Authorization: Bearer ${'b'.repeat(24)}`,
    'postgresql://demo:private-password@database.invalid/demo',
  ]) {
    assert.throws(
      () => validatePackageEntries(minimalPackage, (path) => path === 'README.md' ? content : 'x'),
      /credential-like content: README\.md/,
      content,
    );
  }
  for (const content of ['/root/private/repo', '/private/var/folders/private/repo']) {
    assert.throws(
      () => validatePackageEntries(minimalPackage, (path) => path === 'README.md' ? content : 'x'),
      /local absolute paths: README\.md/,
      content,
    );
  }
  for (const content of ['C:/Users/person/private/repo', '/var/folders/ab/private/repo']) {
    assert.throws(
      () => validatePackageEntries(minimalPackage, (path) => path === 'README.md' ? content : 'x'),
      /local absolute paths: README\.md/,
      content,
    );
  }
  assert.throws(
    () => validatePackageEntries(
      minimalPackage,
      (path) => path === 'README.md' ? 'source root: /workspace/exact-private-root' : 'x',
      { privatePathValues: ['/workspace/exact-private-root'] },
    ),
    /local absolute paths: README\.md/,
  );
});

test('package policy rejects binary, invalid UTF-8, and oversized candidate content', () => {
  assert.throws(
    () => validatePackageEntries(minimalPackage, (path) => path === 'README.md' ? Buffer.from([0x41, 0, 0x42]) : 'x'),
    /binary content is not allowed: README\.md/,
  );
  assert.throws(
    () => validatePackageEntries(minimalPackage, (path) => path === 'README.md' ? Buffer.from([0xc3, 0x28]) : 'x'),
    /invalid UTF-8 content is not allowed: README\.md/,
  );
  assert.throws(
    () => validatePackageEntries(
      minimalPackage,
      (path) => path === 'README.md' ? Buffer.alloc(MAX_PACKAGE_FILE_BYTES + 1, 0x61) : 'x',
    ),
    new RegExp(`package file exceeds ${MAX_PACKAGE_FILE_BYTES} scanned bytes: README\\.md`),
  );

  const declaredSize = Math.floor(MAX_PACKAGE_TOTAL_BYTES / minimalPackage.length) + 1;
  const declared = minimalPackage.map((path) => ({ path, size: declaredSize, mode: path.startsWith('bin/') ? 0o755 : 0o644 }));
  assert.ok(declaredSize < MAX_PACKAGE_FILE_BYTES);
  assert.throws(
    () => validatePackageEntries(declared),
    new RegExp(`package contents exceed ${MAX_PACKAGE_TOTAL_BYTES} declared bytes`),
  );
});

test('package policy rejects traversal and absolute manifest paths before prefix matching', () => {
  for (const path of ['dist/src/../../private.txt', 'fixtures/demo/../../private.txt', '/private.txt', 'C:\\private.txt']) {
    assert.throws(
      () => validatePackageEntries([...minimalPackage, path], () => 'x'),
      /unsafe path/,
      path,
    );
  }
});

test('package policy requires metadata, launcher, schemas, fixtures, README, and license', () => {
  for (const required of REQUIRED_PACKAGE_FILES) {
    assert.throws(
      () => validatePackageEntries(minimalPackage.filter((path) => path !== required), () => 'x'),
      new RegExp(`missing required package file: ${required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      required,
    );
  }
});

test('package policy requires compiled CLI, every built-in adapter, and demo groups', () => {
  for (const group of REQUIRED_PACKAGE_GROUPS) {
    assert.throws(
      () => validatePackageEntries(minimalPackage.filter((path) => !group.matches(path)), () => 'x'),
      new RegExp(`missing required package group: ${group.name}`),
      group.name,
    );
  }
});

test('package policy rejects a non-executable launcher when npm reports file modes', () => {
  const entries = minimalPackage.map((path) => ({ path, mode: path.startsWith('bin/') ? 0o755 : 0o644 }));
  const broken = entries.map((entry) => entry.path === 'bin/oculory-demo-agent' ? { ...entry, mode: 0o644 } : entry);
  assert.throws(
    () => validatePackageEntries(broken, () => 'x'),
    /package launcher is not executable: bin\/oculory-demo-agent/,
  );
});
