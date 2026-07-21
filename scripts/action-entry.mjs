import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runBoundedCommand } from './bounded-process.mjs';

const ACTION_REPLAY_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const ACTION_REPORT_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_EXTERNAL_VALUE_BYTES = 4096;
const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/u;
const CONTROL_CHARACTERS_GLOBAL = /[\p{Cc}\u2028\u2029]/gu;

await main().catch((error) => {
  process.stderr.write(`oculory-action: ${safeMessage(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const mode = process.argv[2];
  if (mode !== 'validate' && mode !== 'replay') fail('expected validate or replay');

  const actionRoot = requiredDirectory(process.env.GITHUB_ACTION_PATH, 'GITHUB_ACTION_PATH');
  const workspaceRoot = requiredDirectory(process.env.GITHUB_WORKSPACE, 'GITHUB_WORKSPACE');
  const workingDirectory = containedDirectory(
    workspaceRoot,
    optionalInput('OCULORY_ACTION_WORKING_DIRECTORY', '.'),
    'working-directory',
  );
  const task = containedFile(workingDirectory, requiredInput('OCULORY_ACTION_TASK'), 'task');
  const contract = containedFile(workingDirectory, requiredInput('OCULORY_ACTION_CONTRACT'), 'contract');
  const model = validateModel(requiredInput('OCULORY_ACTION_MODEL'));
  const launcher = containedFile(actionRoot, join('bin', 'oculory'), 'packaged Oculory launcher');
  const validatedTask = await productionPreflight(actionRoot, workingDirectory, task, contract, model);
  const declaredEnvironmentNames = taskEnvironmentNames(validatedTask, model);

  if (mode === 'validate') return;

  const runnerTemp = requiredDirectory(process.env.RUNNER_TEMP, 'RUNNER_TEMP');
  const githubOutput = outputFile(runnerTemp, process.env.GITHUB_OUTPUT);
  const runId = boundedIdentifier(process.env.GITHUB_RUN_ID ?? 'local', 'GITHUB_RUN_ID');
  const attempt = boundedIdentifier(process.env.GITHUB_RUN_ATTEMPT ?? '1', 'GITHUB_RUN_ATTEMPT');
  const profileDigest = createHash('sha256').update(model).digest('hex').slice(0, 12);
  let invocationDirectory = null;
  let runtimeRoot = null;
  let preserveReport = false;
  try {
    invocationDirectory = mkdtempSync(
      join(runnerTemp, `oculory-action-report-${runId}-${attempt}-${profileDigest}-`),
    );
    const reportPath = join(invocationDirectory, 'report.json');
    runtimeRoot = mkdtempSync(join(runnerTemp, 'oculory-action-runtime-'));
    const result = await runBoundedCommand(
      process.execPath,
      [
        launcher,
        'replay',
        '--task', task,
        '--contract', contract,
        '--model', model,
        '--report', reportPath,
      ],
      {
        cwd: workingDirectory,
        env: replayEnvironment(declaredEnvironmentNames, runtimeRoot),
        output: 'pipe',
        maxOutputBytes: ACTION_REPLAY_OUTPUT_LIMIT_BYTES,
        timeoutMs: 5 * 60 * 1_000,
      },
    );
    forwardCapturedOutput(result);

    if (result.timedOut) fail('Oculory replay exceeded the five-minute Action limit');
    if (result.outputLimitExceeded) {
      fail(`Oculory replay exceeded the ${ACTION_REPLAY_OUTPUT_LIMIT_BYTES / (1024 * 1024)} MiB per-stream output limit`);
    }
    if (result.status === null) fail(`Oculory replay terminated by signal ${result.signal ?? 'unknown'}`);
    const exitCode = result.status;
    if (exitCode !== 0 && exitCode !== 1 && exitCode !== 2 && exitCode !== 3) {
      fail(`Oculory replay returned unsupported exit status ${exitCode}`);
    }
    if (exitCode === 0 || exitCode === 2 || exitCode === 3) {
      validateReport(reportPath, exitCode);
      writeOutput(githubOutput, 'report-path', reportPath);
      preserveReport = true;
    } else if (existsSync(reportPath)) {
      fail('configuration failure unexpectedly persisted a replay report');
    }
    process.exitCode = exitCode;
  } finally {
    if (runtimeRoot !== null) removeOwnedTemporary(runnerTemp, runtimeRoot, 'oculory-action-runtime-');
    if (!preserveReport && invocationDirectory !== null) {
      removeOwnedTemporary(runnerTemp, invocationDirectory, 'oculory-action-report-');
    }
  }
}

function requiredInput(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    fail(`${name.toLowerCase().replaceAll('_', '-')} is required`);
  }
  validateExternalString(value, name.toLowerCase());
  return value;
}

function validateExternalString(value, name) {
  if (CONTROL_CHARACTERS.test(value)) fail(`${name} contains control characters`);
  if (Buffer.byteLength(value, 'utf8') > MAX_EXTERNAL_VALUE_BYTES) {
    fail(`${name} exceeds the ${MAX_EXTERNAL_VALUE_BYTES}-byte limit`);
  }
}

function optionalInput(name, fallback) {
  const value = process.env[name] ?? fallback;
  validateExternalString(value, name.toLowerCase());
  return value;
}

function requiredDirectory(value, name) {
  if (!value) fail(`${name} is required`);
  validateExternalString(value, name);
  const path = realpathSync(resolve(value));
  if (!lstatSync(path).isDirectory()) fail(`${name} must name a directory`);
  return path;
}

function containedDirectory(root, candidate, name) {
  const path = resolveContained(root, candidate, name);
  if (!existsSync(path) || !lstatSync(path).isDirectory()) fail(`${name} must name an existing directory`);
  return realpathContained(root, path, name);
}

function containedFile(root, candidate, name) {
  const path = resolveContained(root, candidate, name);
  if (!existsSync(path) || !lstatSync(path).isFile()) fail(`${name} must name an existing regular file`);
  return realpathContained(root, path, name);
}

function resolveContained(root, candidate, name) {
  if (isAbsolute(candidate)) fail(`${name} must be relative to working-directory`);
  const path = resolve(root, candidate);
  const offset = relative(root, path);
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    fail(`${name} escapes working-directory`);
  }
  return path;
}

function realpathContained(root, path, name) {
  const resolved = realpathSync(path);
  assertContained(root, resolved, name);
  return resolved;
}

function assertContained(root, path, name) {
  const offset = relative(root, path);
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    fail(`${name} resolves outside working-directory`);
  }
}

function outputFile(root, value) {
  if (!value) fail('GITHUB_OUTPUT is required during replay');
  validateExternalString(value, 'GITHUB_OUTPUT');
  if (!isAbsolute(value)) fail('GITHUB_OUTPUT must be an absolute path');
  const requested = resolve(value);
  const parent = realpathContained(root, dirname(requested), 'GITHUB_OUTPUT parent');
  const path = join(parent, basename(requested));
  assertContained(root, path, 'GITHUB_OUTPUT');
  if (existsSync(path)) {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) fail('GITHUB_OUTPUT must name a regular file');
    realpathContained(root, path, 'GITHUB_OUTPUT');
  }
  return path;
}

function validateModel(value) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    fail('model must match the task profile label pattern ^[a-z][a-z0-9-]{0,63}$');
  }
  return value;
}

function boundedIdentifier(value, name) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) fail(`${name} is invalid`);
  return value;
}

async function productionPreflight(actionRoot, workingDirectory, taskPath, contractPath, profile) {
  const configModule = containedFile(actionRoot, join('dist', 'src', 'mlp', 'config.js'), 'built configuration module');
  const adapterModule = containedFile(actionRoot, join('dist', 'src', 'mlp', 'adapters', 'index.js'), 'built adapter module');
  const recordModule = containedFile(actionRoot, join('dist', 'src', 'mlp', 'record.js'), 'built record preflight module');
  const replayModule = containedFile(actionRoot, join('dist', 'src', 'mlp', 'replay.js'), 'built replay preflight module');
  const [configuration, adapters, record, replay] = await Promise.all([
    import(pathToFileURL(configModule).href),
    import(pathToFileURL(adapterModule).href),
    import(pathToFileURL(recordModule).href),
    import(pathToFileURL(replayModule).href),
  ]);
  if (
    typeof configuration.loadTaskConfig !== 'function' ||
    typeof configuration.loadContractConfig !== 'function' ||
    typeof adapters.createBuiltinAdapterRegistry !== 'function' ||
    typeof record.assertTaskRunPreflight !== 'function' ||
    typeof replay.assertReplayPreflight !== 'function'
  ) {
    fail('the built production preflight surface is incomplete');
  }
  const task = configuration.loadTaskConfig(taskPath).value;
  const contract = configuration.loadContractConfig(contractPath).value;
  const registry = adapters.createBuiltinAdapterRegistry();
  record.assertTaskRunPreflight(task, registry, workingDirectory);
  replay.assertReplayPreflight(contract, task, profile, registry);
  return task;
}

function taskEnvironmentNames(task, profile) {
  const names = new Set();
  const profileValue = task.agent_profiles[profile];
  if (profileValue === undefined) fail(`task has no agent profile '${profile}'`);
  addEnvironmentList(names, profileValue.env_allowlist);
  addEnvironmentList(names, task.mcp_server.env_allowlist);
  for (const target of task.targets) {
    if (target?.adapter === 'postgres') addOptionalEnvironmentName(names, target.configuration?.connectionEnv);
    if (target?.adapter === 'github-api') addOptionalEnvironmentName(names, target.configuration?.tokenEnv);
  }
  return [...names].sort();
}

function addEnvironmentList(names, value) {
  if (!Array.isArray(value)) fail('validated task environment allowlist is unavailable');
  for (const name of value) addEnvironmentName(names, name);
}

function addEnvironmentName(names, value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    fail('validated task contains an invalid environment variable name');
  }
  names.add(value);
}

function addOptionalEnvironmentName(names, value) {
  if (value !== undefined) addEnvironmentName(names, value);
}

function replayEnvironment(declaredNames, runtimeRoot) {
  const names = new Set([
    'PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'LANG', 'LC_ALL', 'TZ', 'CI', 'GITHUB_ACTIONS',
    ...declaredNames,
  ]);
  const env = Object.fromEntries([...names].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
  const home = join(runtimeRoot, 'home');
  const appData = join(runtimeRoot, 'app-data');
  const localAppData = join(runtimeRoot, 'local-app-data');
  const temporary = join(runtimeRoot, 'tmp');
  for (const directory of [home, appData, localAppData, temporary]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: join(home, '.config'),
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    NO_COLOR: '1',
    OCULORY_TELEMETRY_DISABLED: '1',
  };
}

function forwardCapturedOutput(result) {
  // Each stream is independently capped at 4 MiB before these exact captured strings are forwarded.
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
}

function validateReport(path, exitCode) {
  if (!existsSync(path)) fail('replay completed without the required machine-readable report');
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) fail('replay report is not a regular file');
  if (entry.size < 1 || entry.size > ACTION_REPORT_LIMIT_BYTES) fail('replay report has an invalid size');
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('replay report is not valid JSON');
  }
  const expectedStatus = exitCode === 0 ? 'PASS' : exitCode === 2 ? 'FAIL' : 'INFRA';
  if (
    report === null || typeof report !== 'object' || Array.isArray(report) ||
    report.schema_version !== 'oculory-replay-report-v1' ||
    report.exit_code !== exitCode || report.status !== expectedStatus
  ) {
    fail('replay report does not match the replay exit status');
  }
}

function writeOutput(output, name, value) {
  if (CONTROL_CHARACTERS.test(name) || CONTROL_CHARACTERS.test(value)) {
    fail('Action output contains control characters');
  }
  appendFileSync(output, `${name}=${value}\n`, { encoding: 'utf8' });
}

function removeOwnedTemporary(root, path, prefix) {
  assertContained(root, path, 'temporary Action directory');
  const offset = relative(root, path);
  if (offset.includes(sep) || !offset.startsWith(prefix)) fail('refusing to remove an unverified Action directory');
  if (!existsSync(path)) return;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  if (!entry.isDirectory()) fail('temporary Action path is not a directory');
  rmSync(path, { recursive: true, force: true, maxRetries: 2 });
}

function safeMessage(error) {
  if (!(error instanceof Error)) return 'unknown process error';
  return error.message
    .replace(/(?:\/Users|\/home|\/root|\/private\/var)\/[^\s:'"]+/g, '<private-path>')
    .replace(/[A-Za-z]:\\Users\\[^\s:'"]+/g, '<private-path>')
    .replace(/\b(?:sk-ant-|sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g, '<redacted>')
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgresql://<redacted>@')
    .replace(CONTROL_CHARACTERS_GLOBAL, ' ')
    .slice(0, 240);
}

function fail(message) {
  throw new Error(message);
}
