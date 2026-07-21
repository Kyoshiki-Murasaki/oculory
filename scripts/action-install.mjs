import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runBoundedCommand } from './bounded-process.mjs';

const actionRoot = realpathSync(resolve(required('GITHUB_ACTION_PATH')));
const runnerTemp = resolve(process.env.RUNNER_TEMP ?? tmpdir());
mkdirSync(runnerTemp, { recursive: true });
const temporaryRoot = mkdtempSync(join(runnerTemp, 'oculory-action-install-'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let failure = null;

try {
  const userConfig = join(temporaryRoot, 'empty.npmrc');
  const globalConfig = join(temporaryRoot, 'empty-global.npmrc');
  writeFileSync(userConfig, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  writeFileSync(globalConfig, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const env = selectedEnvironment({
    HOME: temporaryRoot,
    USERPROFILE: temporaryRoot,
    TMPDIR: temporaryRoot,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: join(temporaryRoot, 'npm-cache'),
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  });
  await run(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', actionRoot], env);
  await run(['run', 'build', '--prefix', actionRoot], env);
  const actionBin = join(actionRoot, 'bin');
  const githubPath = required('GITHUB_PATH');
  if (/[\r\n]/.test(actionBin) || /[\r\n]/.test(githubPath)) {
    throw new Error('Action paths contain control characters');
  }
  appendFileSync(githubPath, `${actionBin}\n`, { encoding: 'utf8' });
} catch (error) {
  failure = error;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

if (failure !== null) {
  process.stderr.write('oculory-action: dependency installation or build failed\n');
  process.exitCode = 1;
}

async function run(args, env) {
  const result = await runBoundedCommand(npmCommand, args, {
    cwd: actionRoot,
    env,
    output: 'ignore',
    timeoutMs: 5 * 60 * 1_000,
  });
  if (result.status !== 0 || result.timedOut || result.outputLimitExceeded) {
    throw new Error(`build failed with exit ${result.status ?? 'unknown'}`);
  }
}

function selectedEnvironment(overrides) {
  const names = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ', 'CI', 'GITHUB_ACTIONS'];
  return {
    ...Object.fromEntries(names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    })),
    ...overrides,
  };
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
