import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_PACKAGE_FILES, validatePackageEntries } from '../scripts/package-policy.mjs';

const minimalPackage = [...REQUIRED_PACKAGE_FILES];

test('package policy accepts the deliberate public runtime allowlist', () => {
  const result = validatePackageEntries(minimalPackage, () => 'public package content');
  assert.equal(result.fileCount, minimalPackage.length);
  assert.deepEqual(result.requiredFiles, REQUIRED_PACKAGE_FILES);
});

test('package policy rejects prohibited paths and test-only material', () => {
  const prohibited = [
    '.git/config',
    '.github/workflows/ci.yml',
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

test('package policy rejects local absolute paths and credential-like content', () => {
  assert.throws(
    () => validatePackageEntries(minimalPackage, (path) => path === 'README.md' ? 'local path: /Users/person/private/repo' : 'x'),
    /local absolute paths: README\.md/,
  );
  assert.throws(
    () => validatePackageEntries(minimalPackage, (path) => path === 'README.md' ? `token: sk-${'a'.repeat(32)}` : 'x'),
    /credential-like content: README\.md/,
  );
});

test('package policy requires metadata, launcher, runtime, fixture, README, and license', () => {
  for (const required of REQUIRED_PACKAGE_FILES) {
    assert.throws(
      () => validatePackageEntries(minimalPackage.filter((path) => path !== required), () => 'x'),
      new RegExp(`missing required package file: ${required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      required,
    );
  }
});
