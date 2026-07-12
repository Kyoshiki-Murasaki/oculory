import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { JsonObject } from '../../schema/types.js';
import type { McpStdioClientOptions } from '../../mcp/client/types.js';

export const GIT_SPIKE_TARGET = Object.freeze({
  packageName: 'mcp-server-git',
  packageVersion: '2026.7.10',
  wheelFilename: 'mcp_server_git-2026.7.10-py3-none-any.whl',
  wheelSha256: '6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5',
  sdistFilename: 'mcp_server_git-2026.7.10.tar.gz',
  sdistSha256: '95107b8b2989814e8c230e8e489feef4bfa4d80ca4a7ac1612cea05283ff5ea5',
  installedServerSourceSha256: '52325521ec8ec00297248fa03eaee6802b9cad3ec1e5bebee25971e1b897d56e',
  releaseCommit: '9a96ea6e5913736f92b88345bf51caeaaa8e719f',
  attestedWorkflowCommit: 'd31124c982401739917fd817c2a59db344529c16',
  annotatedTagObject: '78193e98024b35dbc67deeddafe5dd31d23b382b',
  pythonVersion: '3.12.13',
  lockSha256: '5f7f42f1f4b40051836ce7a308e8e4206a87032edf9bc4cc19e9e2ec75a02b63',
  requestedProtocolVersion: '2025-11-25',
  acceptedProtocolVersions: ['2025-11-25'] as const,
});

export const EXPECTED_GIT_TOOL_ORDER = Object.freeze([
  'git_status',
  'git_diff_unstaged',
  'git_diff_staged',
  'git_diff',
  'git_commit',
  'git_add',
  'git_reset',
  'git_log',
  'git_create_branch',
  'git_checkout',
  'git_show',
  'git_branch',
] as const);

export type ExpectedGitToolName = (typeof EXPECTED_GIT_TOOL_ORDER)[number];

export const GATE_B_DIRECT_TOOLS = Object.freeze([
  'git_status',
  'git_diff_unstaged',
  'git_diff_staged',
  'git_add',
  'git_reset',
  'git_log',
  'git_show',
  'git_branch',
  'git_create_branch',
  'git_checkout',
] as const);

export const GATE_B_EXCLUDED_TOOLS = Object.freeze(['git_diff', 'git_commit'] as const);

export interface GitSpikeRuntimeInspection {
  pythonExecutable: string;
  pythonBaseExecutable: string;
  pythonVersion: string;
  targetExecutable: string;
  targetModulePath: string;
  targetServerPath: string;
  targetServerSha256: string;
  packageName: string;
  packageVersion: string;
  consoleEntryPoint: string;
  distributions: Readonly<Record<string, string>>;
  gitExecutable: string;
  gitVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  lockSha256: string;
}

export interface GitSpikeRuntimeConfig {
  pythonExecutable: string;
  targetExecutable: string;
  gitExecutable: string;
  lockSha256: string;
}

export interface GitSpikeEnvironmentPaths {
  trialRoot: string;
  repositoryRoot: string;
  home: string;
  xdgConfigHome: string;
  xdgCacheHome: string;
  temporaryDirectory: string;
  globalGitConfig: string;
  askpassExecutable: string;
}

const FORBIDDEN_ENVIRONMENT_NAMES = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'SSH_AUTH_SOCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'GIT_CONFIG_SYSTEM',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GPG_TTY',
]);

const INSPECTION_SCRIPT = String.raw`
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import sys
import mcp_server_git

distribution = metadata.distribution("mcp-server-git")
entry_points = [
    entry.value
    for entry in metadata.entry_points(group="console_scripts")
    if entry.name == "mcp-server-git" and entry.dist.name == "mcp-server-git"
]
module_path = Path(mcp_server_git.__file__).resolve()
server_path = module_path.parent / "server.py"
print(json.dumps({
    "python_executable": str(Path(sys.executable).resolve()),
    "python_version": ".".join(str(value) for value in sys.version_info[:3]),
    "module_path": str(module_path),
    "server_path": str(server_path),
    "server_sha256": hashlib.sha256(server_path.read_bytes()).hexdigest(),
    "package_name": distribution.metadata["Name"],
    "package_version": distribution.version,
    "entry_points": entry_points,
    "distributions": {
        item.metadata["Name"].lower(): item.version
        for item in metadata.distributions()
        if item.metadata["Name"] is not None
    },
}, sort_keys=True))
`;

export function inspectGitSpikeRuntime(config: GitSpikeRuntimeConfig): GitSpikeRuntimeInspection {
  const pythonConfiguredPath = existingAbsolutePath(config.pythonExecutable, 'Python executable');
  const pythonBin = realpathSync(dirname(pythonConfiguredPath));
  const pythonExecutable = resolve(pythonBin, pythonConfiguredPath.split(sep).at(-1)!);
  const pythonBaseExecutable = realpathSync(pythonConfiguredPath);
  const targetExecutable = exactExistingPath(config.targetExecutable, 'target executable');
  const gitExecutable = exactExistingPath(config.gitExecutable, 'Git executable');
  if (config.lockSha256 !== GIT_SPIKE_TARGET.lockSha256) {
    throw new Error(
      `Git spike lock digest mismatch: expected ${GIT_SPIKE_TARGET.lockSha256}, observed ${config.lockSha256}`,
    );
  }

  const targetBin = dirname(targetExecutable);
  if (pythonBin !== targetBin) {
    throw new Error('target executable and Python executable must come from the same disposable environment');
  }
  if (targetExecutable.split(sep).at(-1) !== 'mcp-server-git') {
    throw new Error(`unexpected target executable name: ${targetExecutable}`);
  }

  const raw = execFileSync(pythonExecutable, ['-c', INSPECTION_SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: [pythonBin, dirname(gitExecutable), '/usr/bin', '/bin'].join(':'),
      PYTHONNOUSERSITE: '1',
      PYTHONSAFEPATH: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      LC_ALL: 'C',
      TZ: 'UTC',
    },
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  });
  const observed = JSON.parse(raw) as {
    python_executable: string;
    python_version: string;
    module_path: string;
    server_path: string;
    server_sha256: string;
    package_name: string;
    package_version: string;
    entry_points: string[];
    distributions: Record<string, string>;
  };

  if (realpathSync(observed.python_executable) !== pythonBaseExecutable) {
    throw new Error('runtime inspection resolved a different Python executable');
  }
  if (observed.python_version !== GIT_SPIKE_TARGET.pythonVersion) {
    throw new Error(
      `Python version mismatch: expected ${GIT_SPIKE_TARGET.pythonVersion}, observed ${observed.python_version}`,
    );
  }
  if (observed.package_name.toLowerCase() !== GIT_SPIKE_TARGET.packageName) {
    throw new Error(`installed distribution is ${observed.package_name}, not ${GIT_SPIKE_TARGET.packageName}`);
  }
  if (observed.package_version !== GIT_SPIKE_TARGET.packageVersion) {
    throw new Error(
      `target version mismatch: expected ${GIT_SPIKE_TARGET.packageVersion}, observed ${observed.package_version}`,
    );
  }
  if (observed.server_sha256 !== GIT_SPIKE_TARGET.installedServerSourceSha256) {
    throw new Error(
      `installed server source mismatch: expected ${GIT_SPIKE_TARGET.installedServerSourceSha256}, observed ${observed.server_sha256}`,
    );
  }
  if (observed.entry_points.length !== 1 || observed.entry_points[0] !== 'mcp_server_git:main') {
    throw new Error(`unexpected mcp-server-git console entry point: ${JSON.stringify(observed.entry_points)}`);
  }

  const environmentRoot = resolve(pythonBin, '..');
  for (const path of [observed.module_path, observed.server_path, targetExecutable]) {
    assertPathWithin(path, environmentRoot, 'installed target path');
  }

  const gitVersion = execFileSync(gitExecutable, ['--version'], {
    encoding: 'utf8',
    env: { PATH: [dirname(gitExecutable), '/usr/bin', '/bin'].join(':'), LC_ALL: 'C' },
    maxBuffer: 64 * 1024,
    timeout: 5_000,
  }).trim();

  return {
    pythonExecutable,
    pythonBaseExecutable,
    pythonVersion: observed.python_version,
    targetExecutable,
    targetModulePath: observed.module_path,
    targetServerPath: observed.server_path,
    targetServerSha256: observed.server_sha256,
    packageName: observed.package_name,
    packageVersion: observed.package_version,
    consoleEntryPoint: observed.entry_points[0],
    distributions: Object.fromEntries(Object.entries(observed.distributions).sort(([a], [b]) => a.localeCompare(b))),
    gitExecutable,
    gitVersion,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    lockSha256: config.lockSha256,
  };
}

export function buildGitSpikeChildEnvironment(
  runtime: GitSpikeRuntimeInspection,
  paths: GitSpikeEnvironmentPaths,
): Readonly<Record<string, string>> {
  for (const path of Object.values(paths)) {
    if (!isAbsolute(path)) throw new Error(`Git spike environment path must be absolute: ${path}`);
  }
  for (const path of [
    paths.repositoryRoot,
    paths.home,
    paths.xdgConfigHome,
    paths.xdgCacheHome,
    paths.temporaryDirectory,
    paths.globalGitConfig,
    paths.askpassExecutable,
  ]) {
    assertPathWithin(path, paths.trialRoot, 'runtime environment path');
  }

  const env = Object.freeze({
    PATH: uniquePath([dirname(runtime.targetExecutable), dirname(runtime.gitExecutable), '/usr/bin', '/bin']),
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    TMPDIR: paths.temporaryDirectory,
    GIT_CONFIG_GLOBAL: paths.globalGitConfig,
    GIT_ASKPASS: paths.askpassExecutable,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: paths.trialRoot,
    GIT_AUTHOR_NAME: 'Oculory Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@oculory.invalid',
    GIT_COMMITTER_NAME: 'Oculory Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@oculory.invalid',
    GIT_AUTHOR_DATE: '2024-01-02T00:00:00Z',
    GIT_COMMITTER_DATE: '2024-01-02T00:00:00Z',
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC',
    PYTHONNOUSERSITE: '1',
    PYTHONSAFEPATH: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONHASHSEED: '0',
    VIRTUAL_ENV: resolve(dirname(runtime.pythonExecutable), '..'),
  });
  assertNoForbiddenEnvironmentNames(env);
  return env;
}

export function buildGitSpikeClientOptions(
  runtime: GitSpikeRuntimeInspection,
  paths: GitSpikeEnvironmentPaths,
): McpStdioClientOptions {
  return {
    executable: runtime.targetExecutable,
    args: ['--repository', paths.repositoryRoot],
    cwd: paths.repositoryRoot,
    env: buildGitSpikeChildEnvironment(runtime, paths),
    clientInfo: { name: 'oculory-git-gate-ab-spike', version: '1.0.0' },
    requestedProtocolVersion: GIT_SPIKE_TARGET.requestedProtocolVersion,
    acceptedProtocolVersions: [...GIT_SPIKE_TARGET.acceptedProtocolVersions],
    clientCapabilities: {},
    limits: {
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      postCancellationTimeoutMs: 500,
      gracefulShutdownTimeoutMs: 2_000,
      sigtermTimeoutMs: 1_000,
      sigkillTimeoutMs: 1_000,
      maxToolListPages: 16,
      maxFrameBytes: 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
      maxTranscriptBytes: 5 * 1024 * 1024,
    },
    manageProcessGroup: true,
  };
}

export function assertExactFixtureRepositoryPath(candidate: string, repositoryRoot: string): string {
  const exactCandidate = exactExistingPath(candidate, 'requested repository');
  const exactRoot = exactExistingPath(repositoryRoot, 'fixture repository');
  if (exactCandidate !== exactRoot) {
    throw new Error(`repository path must resolve exactly to the fixture root: ${candidate}`);
  }
  return exactRoot;
}

export function assertNoForbiddenEnvironmentNames(env: Readonly<Record<string, string>>): void {
  for (const name of FORBIDDEN_ENVIRONMENT_NAMES) {
    if (Object.hasOwn(env, name)) throw new Error(`forbidden environment variable was allowlisted: ${name}`);
  }
  for (const name of Object.keys(env)) {
    if (/(_API_KEY|_TOKEN|_PASSWORD|_CREDENTIALS?)$/i.test(name)) {
      throw new Error(`credential-shaped environment variable was allowlisted: ${name}`);
    }
  }
}

export function environmentNameSummary(env: Readonly<Record<string, string>>): string[] {
  assertNoForbiddenEnvironmentNames(env);
  return Object.keys(env).sort();
}

export function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function digestJsonObject(value: JsonObject): string {
  return digestBytes(Buffer.from(JSON.stringify(value), 'utf8'));
}

function exactExistingPath(path: string, label: string): string {
  return realpathSync(existingAbsolutePath(path, label));
}

function existingAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path: ${path}`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  return resolve(path);
}

function assertPathWithin(path: string, root: string, label: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return;
  throw new Error(`${label} escapes its reviewed root: ${path}`);
}

function uniquePath(entries: readonly string[]): string {
  return [...new Set(entries)].join(':');
}
