import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const launcher = join(repoRoot, 'bin', 'oculory');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    },
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('portable launcher exposes --help without provider traffic', () => {
  const result = run(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:\s+oculory <command>/);
  assert.equal(result.stderr, '');
});

test('portable launcher derives --version and version from package metadata', () => {
  assert.equal(packageJson.version, packageLock.version);
  assert.equal(packageJson.version, packageLock.packages[''].version);

  for (const command of [['--version'], ['version']]) {
    const result = run(command);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), packageJson.version);
    assert.equal(result.stderr, '');
  }
});

test('portable launcher propagates arguments containing spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory launcher space '));
  try {
    const fixture = join(root, 'seed fixture.json');
    copyFileSync(join(repoRoot, 'fixtures', 'seed.json'), fixture);
    const result = run(['doctor', '--fixture', fixture, '--json'], { cwd: root });
    assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.ok(report.checks.some((check) => check.name === `fixture readable at ${fixture}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('portable launcher propagates CLI exit status', () => {
  const result = run(['not-a-command']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown command 'not-a-command'/);
});

test('Gate F1 authorization remains a non-executable draft', () => {
  const authorization = JSON.parse(
    readFileSync(join(repoRoot, 'authorizations', 'gate-f1-authorization-template.json'), 'utf8'),
  );
  assert.equal(authorization.status, 'draft');
  assert.equal(authorization.authorization_statement, 'NOT AUTHORIZED — TEMPLATE ONLY');
  assert.equal(authorization.provider_identity, null);
  assert.equal(authorization.exact_model_identifier, null);
  assert.equal(authorization.hard_dollar_cap, null);
});
