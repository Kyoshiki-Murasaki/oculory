import { constants as fsConstants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { accessSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { GIT_SPIKE_TARGET, inspectGitSpikeRuntime, type GitSpikeRuntimeInspection } from '../../src/targets/git-spike/config.js';
import { PILOT_COMMAND_TIMEOUT_MS, PILOT_DOCTOR_SCHEMA_VERSION } from './constants.js';
import { runBoundedProcess } from './process.js';
import { providerConfigurationPresent, validatePilotOutputPath } from './safety.js';

export interface PilotDoctorCheck {
  id: string;
  status: 'pass' | 'fail';
  message: string;
  recovery: string | null;
}

export interface PilotDoctorReport {
  schemaVersion: typeof PILOT_DOCTOR_SCHEMA_VERSION;
  ok: boolean;
  mode: 'provider_free_offline';
  checks: PilotDoctorCheck[];
  accounting: {
    providerCalls: 0;
    providerNetworkCalls: 0;
    providerCredentialsRead: 0;
  };
}

export interface PilotRuntimePaths {
  pythonExecutable: string;
  targetExecutable: string;
  gitExecutable: string;
}

export interface PilotDoctorResult {
  report: PilotDoctorReport;
  runtime: GitSpikeRuntimeInspection | null;
  paths: PilotRuntimePaths | null;
  versions: { npm: string | null; git: string | null };
  outputDirectory: string | null;
}

export interface PilotDoctorOptions {
  repositoryRoot: string;
  outputDirectory: string;
  pythonExecutable?: string;
  targetExecutable?: string;
  gitExecutable?: string;
  nodeVersion?: string;
  environmentNames?: readonly string[];
  pathValue?: string;
}

export async function runPilotDoctor(options: PilotDoctorOptions): Promise<PilotDoctorResult> {
  const checks: PilotDoctorCheck[] = [];
  const repositoryRoot = resolve(options.repositoryRoot);
  const environmentNames = options.environmentNames ?? Object.keys(process.env);
  const pathValue = options.pathValue ?? process.env.PATH ?? '';
  const nodeVersion = options.nodeVersion ?? process.version;
  let npmVersion: string | null = null;
  let gitVersion: string | null = null;
  let runtime: GitSpikeRuntimeInspection | null = null;
  let paths: PilotRuntimePaths | null = null;
  let outputDirectory: string | null = null;

  const nodeSupported = supportedNodeVersion(nodeVersion);
  check(
    checks,
    'supported_node',
    nodeSupported,
    `Node ${normalizeVersion(nodeVersion)} is ${nodeSupported ? 'supported' : 'unsupported'}`,
    'Use Node 22.13 or a Node 24 release.',
  );

  const npmExecutable = findExecutable('npm', pathValue);
  if (npmExecutable === null) {
    check(checks, 'npm_available', false, 'npm is unavailable', 'Install npm and ensure it is on PATH.');
  } else {
    try {
      const result = await runBoundedProcess(npmExecutable, ['--version'], {
        cwd: repositoryRoot,
        env: commandEnvironment(pathValue),
        timeoutMs: PILOT_COMMAND_TIMEOUT_MS,
        shell: process.platform === 'win32' && /\.cmd$/i.test(npmExecutable),
      });
      npmVersion = firstLine(result.stdout);
      check(checks, 'npm_available', result.exitCode === 0 && !result.timedOut && npmVersion.length > 0, `npm ${npmVersion || 'version unavailable'} is available`, 'Repair the npm installation and retry.');
    } catch {
      check(checks, 'npm_available', false, 'npm could not be executed', 'Repair the npm installation and retry.');
    }
  }

  const gitExecutable = resolveConfiguredExecutable(options.gitExecutable, 'git', pathValue);
  if (gitExecutable === null) {
    check(checks, 'git_available', false, 'Git is unavailable', 'Install Git and ensure it is on PATH.');
  } else {
    try {
      const result = await runBoundedProcess(gitExecutable, ['--version'], {
        cwd: repositoryRoot,
        env: commandEnvironment(pathValue),
        timeoutMs: PILOT_COMMAND_TIMEOUT_MS,
      });
      gitVersion = firstLine(result.stdout).replace(/^git version\s+/i, '');
      check(checks, 'git_available', result.exitCode === 0 && !result.timedOut && gitVersion.length > 0, `Git ${gitVersion || 'version unavailable'} is available`, 'Repair the Git installation and retry.');
    } catch {
      check(checks, 'git_available', false, 'Git could not be executed', 'Repair the Git installation and retry.');
    }
  }

  const requiredBuilds = [
    'dist/src/targets/git/model/offline-session.js',
    'dist/pilot/src/cli.js',
  ];
  check(
    checks,
    'required_builds',
    requiredBuilds.every((entry) => existsSync(resolve(repositoryRoot, entry))),
    'required built files are present',
    'Run npm run build and retry.',
  );

  try {
    const result = await runBoundedProcess(process.execPath, ['bin/oculory', '--version'], {
      cwd: repositoryRoot,
      env: commandEnvironment(pathValue),
      timeoutMs: PILOT_COMMAND_TIMEOUT_MS,
    });
    check(checks, 'cli_available', result.exitCode === 0 && !result.timedOut && firstLine(result.stdout).length > 0, 'the repository CLI is available', 'Run npm run build and inspect node bin/oculory --version.');
  } catch {
    check(checks, 'cli_available', false, 'the repository CLI could not be executed', 'Run npm run build and inspect node bin/oculory --version.');
  }

  const targetExecutable = resolveConfiguredExecutable(options.targetExecutable, 'mcp-server-git', pathValue);
  const pythonExecutable = resolvePythonExecutable(options.pythonExecutable, targetExecutable, pathValue);
  if (targetExecutable === null || pythonExecutable === null || gitExecutable === null) {
    check(
      checks,
      'pinned_git_mcp',
      false,
      'the pinned Git MCP runtime is unavailable',
      `Create a Python ${GIT_SPIKE_TARGET.pythonVersion} virtual environment, install mcp-server-git==${GIT_SPIKE_TARGET.packageVersion}, and put its executable directory on PATH.`,
    );
  } else {
    try {
      runtime = inspectGitSpikeRuntime({
        pythonExecutable,
        targetExecutable,
        gitExecutable,
        lockSha256: GIT_SPIKE_TARGET.lockSha256,
      });
      validatePinnedDistributions(runtime, repositoryRoot);
      paths = { pythonExecutable, targetExecutable, gitExecutable };
      check(
        checks,
        'pinned_git_mcp',
        true,
        `mcp-server-git ${runtime.packageVersion} matches the pinned source`,
        null,
      );
    } catch {
      check(
        checks,
        'pinned_git_mcp',
        false,
        'the Git MCP runtime does not match the pinned source',
        `Recreate the disposable Python ${GIT_SPIKE_TARGET.pythonVersion} environment with mcp-server-git==${GIT_SPIKE_TARGET.packageVersion}.`,
      );
    }
  }

  checkTemporaryWrite(checks, false);
  checkTemporaryWrite(checks, true);

  const providerPresent = providerConfigurationPresent(environmentNames);
  check(
    checks,
    'provider_configuration_absent',
    !providerPresent,
    providerPresent ? 'provider configuration is present; values were not inspected' : 'provider configuration is absent',
    'Run the pilot in a shell without provider credential or endpoint variables.',
  );
  check(
    checks,
    'provider_credentials_not_required',
    !providerPresent,
    'no provider credential is required or read',
    'Remove provider configuration from the pilot shell and retry.',
  );

  try {
    outputDirectory = validatePilotOutputPath(repositoryRoot, resolve(options.outputDirectory));
    check(checks, 'output_directory_safe', true, 'the output directory is outside the repository and writable', null);
  } catch (error) {
    check(
      checks,
      'output_directory_safe',
      false,
      'the output directory is unsafe or unwritable',
      error instanceof Error ? error.message : 'Choose a new writable directory outside the repository.',
    );
  }

  const report: PilotDoctorReport = {
    schemaVersion: PILOT_DOCTOR_SCHEMA_VERSION,
    ok: checks.every((entry) => entry.status === 'pass'),
    mode: 'provider_free_offline',
    checks,
    accounting: { providerCalls: 0, providerNetworkCalls: 0, providerCredentialsRead: 0 },
  };
  return { report, runtime, paths, versions: { npm: npmVersion, git: gitVersion }, outputDirectory };
}

export function renderPilotDoctorText(report: PilotDoctorReport): string {
  const lines = [
    `Oculory offline pilot doctor: ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
    ...report.checks.map((entry) => `${entry.status === 'pass' ? 'PASS' : 'FAIL'}  ${entry.id}: ${entry.message}${entry.status === 'fail' && entry.recovery !== null ? `\n      Recovery: ${entry.recovery}` : ''}`),
    '',
    'Provider calls: 0; provider network calls: 0; provider credentials read: 0.',
  ];
  return `${lines.join('\n')}\n`;
}

export function supportedNodeVersion(value: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 13) || major === 24;
}

export function findExecutable(name: string, pathValue = process.env.PATH ?? ''): string | null {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const names = process.platform === 'win32' && !extensions.some((extension) => name.toUpperCase().endsWith(extension.toUpperCase()))
    ? extensions.map((extension) => `${name}${extension.toLowerCase()}`)
    : [name];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const candidateName of names) {
      const candidate = resolve(directory, candidateName);
      if (!existsSync(candidate)) continue;
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        if (process.platform === 'win32') return candidate;
      }
    }
  }
  return null;
}

function resolveConfiguredExecutable(configured: string | undefined, name: string, pathValue: string): string | null {
  if (configured === undefined) return findExecutable(name, pathValue);
  const candidate = resolve(configured);
  return isAbsolute(candidate) && existsSync(candidate) ? candidate : null;
}

function resolvePythonExecutable(configured: string | undefined, target: string | null, pathValue: string): string | null {
  if (configured !== undefined) return resolveConfiguredExecutable(configured, 'python', pathValue);
  if (target !== null) {
    for (const name of process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python', 'python3']) {
      const candidate = join(dirname(target), name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return findExecutable(process.platform === 'win32' ? 'python' : 'python3', pathValue);
}

function checkTemporaryWrite(checks: PilotDoctorCheck[], spaces: boolean): void {
  const id = spaces ? 'path_with_spaces' : 'temporary_directory_write';
  const label = spaces ? 'paths containing spaces are writable and removable' : 'the temporary directory is writable';
  let directory: string | null = null;
  try {
    directory = mkdtempSync(join(tmpdir(), spaces ? 'oculory pilot doctor ' : 'oculory-pilot-doctor-'));
    writeFileSync(join(directory, spaces ? 'probe with spaces.txt' : 'probe.txt'), 'provider-free pilot probe\n', { encoding: 'utf8', flag: 'wx' });
    rmSync(directory, { recursive: true, force: false });
    directory = null;
    check(checks, id, true, label, null);
  } catch {
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
    check(checks, id, false, `${label} check failed`, 'Use a writable operating-system temporary directory.');
  }
}

function commandEnvironment(pathValue: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: pathValue, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
  if (process.platform === 'win32' && process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function check(
  checks: PilotDoctorCheck[],
  id: string,
  passed: boolean,
  message: string,
  recovery: string | null,
): void {
  checks.push({ id, status: passed ? 'pass' : 'fail', message, recovery: passed ? null : recovery });
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function normalizeVersion(value: string): string {
  return value.startsWith('v') ? value.slice(1) : value;
}

function validatePinnedDistributions(runtime: GitSpikeRuntimeInspection, repositoryRoot: string): void {
  const constraints = readFileSync(
    resolve(repositoryRoot, 'pilot/constraints.git-mcp-2026.7.10-py312.txt'),
    'utf8',
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const expected = new Map(constraints.map((line) => {
    const [name, version, extra] = line.split('==');
    if (name === undefined || version === undefined || extra !== undefined) throw new Error('invalid pilot target constraint');
    return [canonicalPackageName(name), version] as const;
  }));
  const observed = new Map(Object.entries(runtime.distributions).map(([name, version]) => [canonicalPackageName(name), version]));
  if (expected.size !== 33) throw new Error('pilot target constraint count differs');
  for (const [name, version] of expected) {
    if (observed.get(name) !== version) throw new Error(`pilot target distribution differs: ${name}`);
  }
  const allowedBootstrapExtras = new Set(['pip', 'setuptools', 'wheel']);
  for (const name of observed.keys()) {
    if (!expected.has(name) && !allowedBootstrapExtras.has(name)) throw new Error(`unreviewed pilot target distribution: ${name}`);
  }
}

function canonicalPackageName(value: string): string {
  return value.toLowerCase().replace(/[-_.]+/g, '-');
}
