import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { runBoundedCommand } from './bounded-process.mjs';

const repositoryRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const actionEntry = join(repositoryRoot, 'scripts', 'action-entry.mjs');
const sourceFixtures = join(repositoryRoot, 'fixtures', 'demo');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'oculory action verification '));
const workspace = join(temporaryRoot, 'workspace with spaces');
const syntheticSecretName = 'OCULORY_ACTION_SYNTHETIC_SECRET';
const syntheticSecret = 'phase9-action-opaque-value-must-not-persist';
const secretBytes = Buffer.from(syntheticSecret, 'utf8');
let summary;
let failure = null;

try {
  if (!existsSync(sourceFixtures)) throw new Error('bundled demo fixtures are unavailable');
  verifyStaticActionBoundary();
  mkdirSync(join(workspace, 'fixtures'), { recursive: true, mode: 0o700 });
  mkdirSync(join(temporaryRoot, 'home'), { recursive: true, mode: 0o700 });
  cpSync(sourceFixtures, join(workspace, 'fixtures', 'demo'), { recursive: true });
  declareSyntheticEnvironment(join(workspace, 'fixtures', 'demo', 'task.yaml'));
  prepareInvalidInputs();

  const rejectedCases = await verifyPreflightRejections();
  const validation = await runEntry('validate', 'baseline', '1099');
  assertStatus(validation, 0, 'valid Action preflight');
  assertNoPreflightResidue('valid Action preflight', validation.output);

  const success = await runEntry('replay', 'baseline', '1101');
  assertStatus(success, 0, 'baseline Action replay');
  const successReport = outputPath(success.output);
  const successJson = readReport(successReport, 'PASS', 0);

  const violation = await runEntry('replay', 'changed', '1102');
  assertStatus(violation, 2, 'changed Action replay');
  const violationReport = outputPath(violation.output);
  const violationJson = readReport(violationReport, 'FAIL', 2);

  const terminalOutput = `${success.stdout}${success.stderr}${violation.stdout}${violation.stderr}`;
  if (terminalOutput.includes('\u001b[')) throw new Error('Action output ignored NO_COLOR');
  if (!terminalOutput.includes('CONTRACT VIOLATED')) throw new Error('Action did not forward the contradiction renderer output');
  assertSecretAbsent(Buffer.from(terminalOutput, 'utf8'), 'Action terminal output');
  assertSecretAbsent(readFileSync(successReport), 'baseline report');
  assertSecretAbsent(readFileSync(violationReport), 'violation report');

  const runArtifacts = scanTreeForSecret(join(workspace, '.oculory'));
  const allArtifacts = scanTreeForSecret(temporaryRoot);
  if (allArtifacts.symlinks < 1) throw new Error('Action verifier did not exercise its symlink scanner');
  assertNoRuntimeResidue();

  summary = {
    action: 'passed',
    production_preflight: true,
    provider_credentials_inherited: false,
    synthetic_declared_environment_forwarded: true,
    success_exit_code: success.status,
    violation_exit_code: violation.status,
    reports_persisted: 2,
    reports_validated: successJson.exit_code === 0 && violationJson.exit_code === 2,
    path_with_spaces: workspace.includes(' '),
    no_automatic_upload: true,
    no_external_composite_actions: true,
    bounded_terminal_output: true,
    rejected_preflight_cases: rejectedCases,
    run_artifact_files_scanned: runArtifacts.files,
    symlinks_scanned: allArtifacts.symlinks,
  };
} catch (error) {
  failure = safeMessage(error);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

if (failure !== null) {
  process.stderr.write(`Action verification failed: ${failure}\n`);
  process.exitCode = 1;
} else {
  summary.temporary_directory_removed = !existsSync(temporaryRoot);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function verifyStaticActionBoundary() {
  const actionSource = readFileSync(join(repositoryRoot, 'action.yml'), 'utf8');
  const entrySource = readFileSync(actionEntry, 'utf8');
  const installSource = readFileSync(join(repositoryRoot, 'scripts', 'action-install.mjs'), 'utf8');
  const boundedSource = readFileSync(join(repositoryRoot, 'scripts', 'bounded-process.mjs'), 'utf8');
  const action = parse(actionSource);
  const steps = action?.runs?.steps;
  if (!Array.isArray(steps) || steps.length !== 3) throw new Error('Action must contain exactly build, validate, and replay steps');
  if (steps.some((step) => step && typeof step === 'object' && Object.hasOwn(step, 'uses'))) {
    throw new Error('composite Action must not invoke an external Action');
  }
  if (!String(steps[0]?.run ?? '').includes('action-install.mjs')) {
    throw new Error('isolated dependency installation and build must be the first Action step');
  }
  if (!String(steps[1]?.run ?? '').includes('action-entry.mjs" validate')) {
    throw new Error('production validation must follow the isolated build');
  }
  if (!String(steps[2]?.run ?? '').includes('action-entry.mjs" replay')) {
    throw new Error('replay must follow production validation');
  }
  const executableSource = [actionSource, entrySource, installSource, boundedSource].join('\n');
  if (/upload-artifact|actions\/upload|\b(?:curl|wget)\b|\bgh\s+api\b|(?:^|[^A-Za-z])fetch\s*\(/im.test(executableSource)) {
    throw new Error('Action implementation contains an automatic upload or direct HTTP command');
  }
  if (/output:\s*['"]inherit['"]/.test(entrySource)) throw new Error('Action replay inherits unbounded child output');
  if (!/maxOutputBytes:\s*ACTION_REPLAY_OUTPUT_LIMIT_BYTES/.test(entrySource)) {
    throw new Error('Action replay does not declare its output bound');
  }
  if (!/npmCommand[\s\S]*\['ci'/.test(installSource) || !/npmCommand[\s\S]*\['run', 'build'/.test(installSource)) {
    throw new Error('Action install step does not perform npm ci and build');
  }
}

function declareSyntheticEnvironment(taskPath) {
  const task = parse(readFileSync(taskPath, 'utf8'));
  for (const label of ['baseline', 'changed']) {
    const profile = task?.agent_profiles?.[label];
    if (!profile || !Array.isArray(profile.env_allowlist)) throw new Error(`demo task is missing profile ${label}`);
    if (!profile.env_allowlist.includes(syntheticSecretName)) profile.env_allowlist.push(syntheticSecretName);
    profile.argv[0] = './action-env-agent.mjs';
  }
  writeFileSync(taskPath, stringify(task, { indent: 2, lineWidth: 100 }), { encoding: 'utf8', mode: 0o600 });
  const probe = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
if (!process.env.${syntheticSecretName}) process.exit(91);
const environment = {};
for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP']) {
  if (process.env[name] !== undefined) environment[name] = process.env[name];
}
const result = spawnSync('oculory-demo-agent', process.argv.slice(2), {
  env: environment,
  shell: false,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) process.exit(92);
process.exit(result.status ?? 93);
`;
  writeFileSync(join(dirname(taskPath), 'action-env-agent.mjs'), probe, { encoding: 'utf8', mode: 0o700 });
}

function prepareInvalidInputs() {
  const fixtureRoot = join(workspace, 'fixtures', 'demo');
  writeFileSync(join(fixtureRoot, 'malformed-task.yaml'), 'version: [\n', { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(fixtureRoot, 'malformed-contract.yaml'), 'version: oculory-contract-v1\nassertions: [\n', { encoding: 'utf8', mode: 0o600 });
  symlinkSync('task.yaml', join(fixtureRoot, 'task-link.yaml'));
}

async function verifyPreflightRejections() {
  const cases = [
    {
      name: 'malformed task YAML',
      inputs: { task: 'fixtures/demo/malformed-task.yaml' },
      expected: /Invalid task configuration|YAML/i,
    },
    {
      name: 'malformed contract YAML',
      inputs: { contract: 'fixtures/demo/malformed-contract.yaml' },
      expected: /Invalid contract configuration|YAML/i,
    },
    {
      name: 'missing profile',
      inputs: { model: 'missing-profile' },
      expected: /no agent profile/i,
    },
    {
      name: 'schema-invalid profile label',
      inputs: { model: 'baseline/other' },
      expected: /profile label pattern/i,
    },
    {
      name: 'absolute task input',
      inputs: { task: join(workspace, 'fixtures', 'demo', 'task.yaml') },
      expected: /must be relative/i,
    },
    {
      name: 'absolute contract input',
      inputs: { contract: join(workspace, 'fixtures', 'demo', 'contract.yaml') },
      expected: /must be relative/i,
    },
    {
      name: 'absolute working-directory input',
      inputs: { workingDirectory: workspace },
      expected: /must be relative/i,
    },
    {
      name: 'symlink task input',
      inputs: { task: 'fixtures/demo/task-link.yaml' },
      expected: /regular file/i,
    },
    {
      name: 'control-character input',
      inputs: { task: 'fixtures/demo/task.yaml\t' },
      expected: /control characters/i,
    },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const result = await runEntry('replay', testCase.inputs.model ?? 'baseline', String(1200 + index), testCase.inputs);
    assertStatus(result, 1, testCase.name);
    if (!testCase.expected.test(terminalText(result))) {
      throw new Error(`${testCase.name} did not fail at the expected preflight boundary: ${terminalText(result)}`);
    }
    assertNoPreflightResidue(testCase.name, result.output);
  }
  return cases.length;
}

async function runEntry(mode, model, runId, overrides = {}) {
  const output = join(temporaryRoot, `github-output-${runId}.txt`);
  const result = await runBoundedCommand(process.execPath, [actionEntry, mode], {
    cwd: workspace,
    env: {
      PATH: [join(repositoryRoot, 'bin'), process.env.PATH ?? ''].filter(Boolean).join(delimiter),
      HOME: join(temporaryRoot, 'home'),
      TMPDIR: temporaryRoot,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      GITHUB_ACTION_PATH: repositoryRoot,
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: temporaryRoot,
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: '1',
      OCULORY_ACTION_TASK: overrides.task ?? 'fixtures/demo/task.yaml',
      OCULORY_ACTION_CONTRACT: overrides.contract ?? 'fixtures/demo/contract.yaml',
      OCULORY_ACTION_MODEL: model,
      OCULORY_ACTION_WORKING_DIRECTORY: overrides.workingDirectory ?? '.',
      NO_COLOR: '1',
      [syntheticSecretName]: syntheticSecret,
    },
    output: 'pipe',
    maxOutputBytes: 16 * 1024 * 1024,
    timeoutMs: mode === 'replay' ? 6 * 60 * 1_000 : 30_000,
  });
  if (result.timedOut) throw new Error(`Action ${mode} verification exceeded its timeout`);
  if (result.outputLimitExceeded) throw new Error(`Action ${mode} verification output exceeded its bound`);
  return { ...result, output };
}

function assertStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(`${label} exited ${result.status ?? 'without a status'} instead of ${expected}: ${terminalText(result)}`);
  }
}

function assertNoPreflightResidue(label, output) {
  if (existsSync(join(workspace, '.oculory'))) throw new Error(`${label} allocated a run store before preflight completed`);
  if (existsSync(output)) throw new Error(`${label} wrote a GitHub output before preflight completed`);
  const residue = actionTemporaryDirectories();
  if (residue.length > 0) throw new Error(`${label} left Action temporary residue: ${residue.join(', ')}`);
}

function assertNoRuntimeResidue() {
  const residue = actionTemporaryDirectories().filter((name) => name.startsWith('oculory-action-runtime-'));
  if (residue.length > 0) throw new Error(`Action replay left runtime residue: ${residue.join(', ')}`);
}

function actionTemporaryDirectories() {
  return readdirSync(temporaryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (
      entry.name.startsWith('oculory-action-runtime-') ||
      entry.name.startsWith('oculory-action-report-')
    ))
    .map((entry) => entry.name)
    .sort();
}

function readReport(path, status, exitCode) {
  if (!isAbsolute(path) || !existsSync(path) || !lstatSync(path).isFile()) throw new Error('Action replay report is absent or invalid');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (report.status !== status || report.exit_code !== exitCode) {
    throw new Error(`Action report does not describe ${status} exit ${exitCode}`);
  }
  return report;
}

function scanTreeForSecret(root) {
  const result = { files: 0, symlinks: 0 };
  visit(root);
  return result;

  function visit(path) {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      result.symlinks += 1;
      assertSecretAbsent(Buffer.from(readlinkSync(path), 'utf8'), `symlink target at ${path}`);
      return;
    }
    if (entry.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (entry.isFile()) {
      result.files += 1;
      assertSecretAbsent(readFileSync(path), `artifact ${path}`);
    }
  }
}

function assertSecretAbsent(value, label) {
  if (value.includes(secretBytes)) throw new Error(`${label} contains the synthetic secret`);
}

function outputPath(path) {
  const line = readFileSync(path, 'utf8').split(/\r?\n/).find((entry) => entry.startsWith('report-path='));
  if (!line) throw new Error('Action output did not include report-path');
  return line.slice('report-path='.length);
}

function terminalText(result) {
  return safeText(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

function safeMessage(error) {
  return safeText(error instanceof Error ? error.message : 'unknown verification error');
}

function safeText(value) {
  return String(value)
    .replaceAll(syntheticSecret, '<redacted>')
    .replaceAll(repositoryRoot, '<repository>')
    .replaceAll(temporaryRoot, '<temporary>')
    .replace(/(?:\/Users|\/home|\/root)\/[^\s:'"]+/g, '<private-path>')
    .replace(/[A-Za-z]:\\Users\\[^\s:'"]+/g, '<private-path>')
    .replace(/\b(?:sk-ant-|sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g, '<redacted>')
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .slice(0, 16000);
}
