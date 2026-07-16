import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedPilotTargetDistributions, renderPilotDoctorText, runPilotDoctor, supportedNodeVersion } from '../pilot/src/doctor.js';
import { runBoundedProcess } from '../pilot/src/process.js';
import { providerConfigurationPresent, validatePilotOutputPath } from '../pilot/src/safety.js';
import { runPilotWorkflow } from '../pilot/src/workflow.js';

const ROOT = resolve(import.meta.dirname, '../..');

test('pilot doctor rejects unsupported Node versions', () => {
  assert.equal(supportedNodeVersion('v22.12.0'), false);
  assert.equal(supportedNodeVersion('v23.9.0'), false);
  assert.equal(supportedNodeVersion('v25.0.0'), false);
  assert.equal(supportedNodeVersion('v22.13.0'), true);
  assert.equal(supportedNodeVersion('v24.7.0'), true);
});

test('pilot target constraints select the exact Unix and Windows distribution sets', () => {
  const unix = expectedPilotTargetDistributions(ROOT, 'darwin');
  const windows = expectedPilotTargetDistributions(ROOT, 'win32');
  assert.equal(unix.size, 33);
  assert.equal(unix.has('colorama'), false);
  assert.equal(unix.has('pywin32'), false);
  assert.equal(windows.size, 35);
  assert.equal(windows.get('colorama'), '0.4.6');
  assert.equal(windows.get('pywin32'), '312');
});

test('pilot doctor reports missing Git and pinned target without reading provider values', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oculory-pilot-doctor-test-'));
  try {
    const result = await runPilotDoctor({
      repositoryRoot: ROOT,
      outputDirectory: join(base, 'output'),
      environmentNames: [],
      pathValue: '',
      nodeVersion: 'v26.4.0',
    });
    assert.equal(result.report.ok, false);
    assert.equal(result.report.checks.find((entry) => entry.id === 'supported_node')?.message, 'Node 26.4.0 is unsupported');
    assert.equal(result.report.checks.find((entry) => entry.id === 'git_available')?.status, 'fail');
    assert.equal(result.report.checks.find((entry) => entry.id === 'pinned_git_mcp')?.status, 'fail');
    assert.equal(result.report.accounting.providerCredentialsRead, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('provider-key presence fails closed by name without requiring or retaining a value', () => {
  assert.equal(providerConfigurationPresent(['PATH', 'OPENAI_API_KEY']), true);
  assert.equal(providerConfigurationPresent(['PATH', 'HOME']), false);
});

test('pilot doctor fails closed when a provider key name is present and never prints its synthetic value', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oculory-pilot-provider-key-test-'));
  const sentinel = 'synthetic-provider-secret-that-must-not-appear';
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = sentinel;
  try {
    const result = await runPilotDoctor({
      repositoryRoot: ROOT,
      outputDirectory: join(base, 'output'),
      pathValue: '',
    });
    const rendered = JSON.stringify(result.report) + renderPilotDoctorText(result.report);
    assert.equal(result.report.ok, false);
    assert.equal(result.report.checks.find((entry) => entry.id === 'provider_configuration_absent')?.status, 'fail');
    assert.equal(result.report.accounting.providerCredentialsRead, 0);
    assert.equal(rendered.includes(sentinel), false);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    rmSync(base, { recursive: true, force: true });
  }
});

test('pilot output safety accepts spaces and rejects repository, .git, and protected evidence roots', () => {
  const base = mkdtempSync(join(tmpdir(), 'oculory pilot path safety '));
  try {
    assert.doesNotThrow(() => validatePilotOutputPath(ROOT, join(base, 'safe output with spaces')));
    assert.throws(() => validatePilotOutputPath(ROOT, join(ROOT, 'pilot-output')), /outside the current repository/);
    assert.throws(() => validatePilotOutputPath(ROOT, join(ROOT, '.git', 'pilot-output')), /Git metadata/);
    assert.throws(() => validatePilotOutputPath(ROOT, join(ROOT, '.oculory', 'runs-live', 'pilot-output')), /protected evidence/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('pilot output safety rejects an unwritable output parent', { skip: process.platform === 'win32' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'oculory-pilot-unwritable-'));
  const parent = join(base, 'readonly');
  mkdirSync(parent, { mode: 0o500 });
  try {
    chmodSync(parent, 0o500);
    assert.throws(() => validatePilotOutputPath(ROOT, join(parent, 'output')), /not writable/);
  } finally {
    chmodSync(parent, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

test('bounded pilot child process is terminated on timeout without a live process leak', async () => {
  const result = await runBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 50,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  if (result.pid !== null && process.platform !== 'win32') {
    assert.throws(() => process.kill(result.pid!, 0));
  }
});

test('participant cancellation produces a sanitized cancelled report and removes temporary work', async () => {
  const base = mkdtempSync(join(tmpdir(), 'oculory-pilot-cancel-'));
  const output = join(base, 'cancelled output');
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await runPilotWorkflow({ repositoryRoot: ROOT, outputDirectory: output, signal: controller.signal });
    assert.equal(result.report.overallResult, 'cancelled');
    assert.equal(result.report.stages[0]?.status, 'cancelled');
    assert.equal(result.report.cleanup.workingDirectoryRemoved, true);
    assert.equal(result.report.providerAccounting.providerCalls, 0);
    assert.equal(existsSync(result.reportPath), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
