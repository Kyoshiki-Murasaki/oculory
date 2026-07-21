import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_PACKAGE_FILE_BYTES,
  MAX_PACKAGE_TARBALL_BYTES,
  MAX_PACKAGE_TOTAL_BYTES,
  packagePaths,
  validatePackageEntries,
} from './package-policy.mjs';
import { runBoundedCommand } from './bounded-process.mjs';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const tempRoot = mkdtempSync(join(tmpdir(), 'oculory package verification '));
const sourceDirectory = join(tempRoot, 'clean package source with spaces');
const packDirectory = join(tempRoot, 'pack output');
const consumerDirectory = join(tempRoot, 'consumer project with spaces');
const globalPrefix = join(tempRoot, 'global installation with spaces');
const isolatedHome = join(tempRoot, 'isolated home');
const isolatedTmp = join(tempRoot, 'isolated tmp');
const npmUserConfig = join(tempRoot, 'empty npmrc');
const npmGlobalConfig = join(tempRoot, 'empty global npmrc');
const npmCache = join(tempRoot, 'npm cache');
const networkGuardPath = join(tempRoot, 'network-denial-preload.cjs');
const networkGuardProofPath = join(tempRoot, 'network-guard-proof.log');
const userHome = homedir();
const CLEAN_SOURCE_FILES = Object.freeze([
  'LICENSE',
  'README.md',
  'package-lock.json',
  'package.json',
  'tsconfig.json',
  'bin/oculory',
  'bin/oculory-demo-agent',
  'bin/oculory-demo-fixture',
  'bin/oculory-demo-server',
  'fixtures/demo/contract.yaml',
  'fixtures/demo/task.yaml',
  'fixtures/seed.json',
  'schemas/contract.schema.json',
  'schemas/task.schema.json',
]);
const REQUIRED_GUARDED_NODE_ROLE_GROUPS = Object.freeze([
  Object.freeze({ label: 'guard probe', roles: Object.freeze(['node']) }),
  Object.freeze({ label: 'installed launcher', roles: Object.freeze(['oculory']) }),
  Object.freeze({ label: 'CLI runtime', roles: Object.freeze(['main.js']) }),
  Object.freeze({ label: 'workspace fixture', roles: Object.freeze(['oculory-demo-fixture', 'demo-fixture-main.js']) }),
  Object.freeze({ label: 'scripted agent', roles: Object.freeze(['oculory-demo-agent', 'scripted-agent-main.js']) }),
  Object.freeze({ label: 'MCP relay', roles: Object.freeze(['relay-main.js']) }),
  Object.freeze({ label: 'MCP server', roles: Object.freeze(['oculory-demo-server', 'demo-server-main.js']) }),
]);
let summary;
let failure = null;
let repositoryBefore = null;
let repositoryUnchanged = false;

try {
  repositoryBefore = snapshotRepositoryMetadata(repoRoot);
  for (const directory of [packDirectory, consumerDirectory, globalPrefix, isolatedHome, isolatedTmp]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeFileSync(npmUserConfig, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  writeFileSync(npmGlobalConfig, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  copyFileSync(join(repoRoot, 'scripts', 'network-denial-preload.cjs'), networkGuardPath);
  chmodSync(networkGuardPath, 0o600);
  writeFileSync(networkGuardProofPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });

  const copiedSource = copyCleanSourceTree();
  await run(
    npmCommand,
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier'],
    sourceDirectory,
    npmEnvironment(),
    5 * 60 * 1_000,
  );

  const packResult = await run(
    npmCommand,
    ['pack', '--json', '--pack-destination', packDirectory],
    sourceDirectory,
    npmEnvironment(),
    5 * 60 * 1_000,
  );
  const packed = parsePackOutput(packResult.stdout);
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error(`expected one npm package, received ${Array.isArray(packed) ? packed.length : 'non-array output'}`);
  }
  const artifact = packed[0];
  if (artifact.filename !== basename(artifact.filename) || /[\0\r\n]/.test(artifact.filename)) {
    throw new Error('npm pack returned an unsafe tarball filename');
  }
  if (artifact.version !== packageJson.version) throw new Error('npm pack returned an unexpected package version');
  const declaredContent = validatePackageEntries(artifact.files);
  if (Number.isSafeInteger(artifact.unpackedSize) && artifact.unpackedSize > MAX_PACKAGE_TOTAL_BYTES) {
    throw new Error('npm package exceeds the bounded unpacked-size limit');
  }

  const tarballPath = join(packDirectory, artifact.filename);
  const tarballEntry = lstatSync(tarballPath);
  if (!tarballEntry.isFile()) throw new Error('npm pack did not create a regular tarball file');
  if (tarballEntry.size > MAX_PACKAGE_TARBALL_BYTES) throw new Error('npm tarball exceeds the bounded size limit');
  if (Number.isSafeInteger(artifact.size) && artifact.size !== tarballEntry.size) {
    throw new Error('npm pack metadata does not match the tarball byte count');
  }
  await run(
    npmCommand,
    [
      'install', '--global', '--prefix', globalPrefix, '--ignore-scripts',
      '--no-audit', '--no-fund', '--no-update-notifier', tarballPath,
    ],
    consumerDirectory,
    npmEnvironment(),
    5 * 60 * 1_000,
  );

  const packageRoot = installedPackageRoot(globalPrefix);
  if (!existsSync(packageRoot) || !lstatSync(packageRoot).isDirectory()) {
    throw new Error('global installation did not create the package directory');
  }
  const packedPaths = packagePaths(artifact.files).sort();
  const installedPaths = installedPackagePaths(packageRoot);
  if (JSON.stringify(installedPaths) !== JSON.stringify(packedPaths)) {
    throw new Error('installed package contents differ from the verified tarball manifest');
  }
  const contentResult = validatePackageEntries(
    installedPaths,
    (path) => installedContent(packageRoot, path),
    { privatePathValues: [repoRoot, userHome, tempRoot, sourceDirectory] },
  );
  const sha256 = await sha256File(tarballPath);
  const installedMetadata = JSON.parse(installedContent(packageRoot, 'package.json').toString('utf8'));
  const expectedBins = {
    oculory: './bin/oculory',
    'oculory-demo-agent': './dist/src/mlp/scripted-agent-main.js',
    'oculory-demo-server': './dist/src/mlp/demo-server-main.js',
    'oculory-demo-fixture': './dist/src/mlp/demo-fixture-main.js',
  };
  if (JSON.stringify(installedMetadata.bin) !== JSON.stringify(expectedBins)) {
    throw new Error('installed package metadata does not expose the exact public and demo executables');
  }
  for (const name of Object.keys(expectedBins)) {
    if (!existsSync(globalCommandPath(name))) throw new Error(`global installation did not create executable: ${name}`);
  }

  const version = await installedOculory(['--version'], packageRoot);
  if (version.stdout.trim() !== packageJson.version) {
    throw new Error(`installed --version returned ${JSON.stringify(version.stdout.trim())}, expected ${packageJson.version}`);
  }

  await installedOculory(['doctor'], packageRoot);
  const doctorJson = JSON.parse((await installedOculory(['doctor', '--json'], packageRoot)).stdout);
  if (doctorJson.ok !== true) throw new Error('installed doctor --json did not report ok=true');

  const adapterModule = await installedAdapterModule(packageRoot);
  if (adapterModule.status !== 0 || adapterModule.stdout.trim() !== 'git-filesystem,github-api,postgres') {
    throw new Error('installed public adapter export did not expose the three built-in adapters');
  }

  const demoEnvironment = cliEnvironment({
    NODE_OPTIONS: nodeRequireOption(networkGuardPath),
    OCULORY_INTERNAL_TEST_NETWORK_GUARD_PRELOAD: networkGuardPath,
    OCULORY_NETWORK_GUARD_PROOF: networkGuardProofPath,
  });
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']) {
    if (Object.hasOwn(demoEnvironment, name)) throw new Error(`demo environment inherited provider credential name: ${name}`);
  }
  await verifyNodeNetworkGuard(demoEnvironment);
  const beforeDemo = snapshotWritableRoots();
  const demoStarted = Date.now();
  const demo = await installedOculory(['demo'], packageRoot, 5 * 60 * 1_000, demoEnvironment);
  const demoDurationMs = Date.now() - demoStarted;
  if (demoDurationMs >= 5 * 60 * 1_000) throw new Error('installed demo exceeded five minutes');
  if (!/Try it on your own task:\r?\n {2}oculory record \.\/task\.yaml\s*$/.test(demo.stdout)) {
    throw new Error('installed demo did not print the required final next step');
  }
  const afterDemo = snapshotWritableRoots();
  if (JSON.stringify(afterDemo) !== JSON.stringify(beforeDemo)) {
    throw new Error('installed demo left residue in a writable acceptance-test root');
  }
  const guardEvidence = networkGuardEvidence();

  summary = {
    package_filename: artifact.filename,
    package_version: artifact.version,
    package_sha256: sha256,
    package_bytes: tarballEntry.size,
    package_file_count: contentResult.fileCount,
    package_declared_bytes: declaredContent.declaredBytes,
    package_scanned_bytes: contentResult.scannedBytes,
    required_files: contentResult.requiredFiles,
    required_groups: contentResult.requiredGroups,
    prohibited_checks: contentResult.prohibitedChecks,
    clean_source: {
      explicit_allowlist: true,
      file_count: copiedSource.fileCount,
      source_path_contains_spaces: sourceDirectory.includes(' '),
      npm_ci: 'passed',
      build_and_pack: 'passed',
    },
    repository_snapshot: {
      scope: 'worktree metadata excluding .git and protected .oculory',
      entry_count: repositoryBefore.size,
      unchanged: false,
    },
    installed_checks: {
      global_install: 'passed',
      version: 'passed',
      doctor: 'passed',
      doctor_json: 'passed',
      adapter_export: 'passed',
      executable_shims: 'passed',
      demo: 'passed',
      demo_duration_ms: demoDurationMs,
      path_with_spaces: true,
      zero_project_residue: true,
      provider_credentials_inherited: false,
      node_outbound_network_guard: 'passed',
      unix_domain_ipc_under_guard: 'passed',
      guarded_node_processes: guardEvidence.processCount,
      guarded_node_roles: guardEvidence.roles,
    },
  };
} catch (error) {
  failure = safeMessage(error);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
  if (repositoryBefore !== null) {
    try {
      repositoryUnchanged = sameRepositorySnapshot(repositoryBefore, snapshotRepositoryMetadata(repoRoot));
      if (!repositoryUnchanged) {
        const message = 'repository worktree metadata changed during package verification';
        failure = failure === null ? message : `${failure}; ${message}`;
      }
    } catch (error) {
      const message = safeMessage(error);
      failure = failure === null ? message : `${failure}; repository recheck failed`;
    }
  }
}

if (failure !== null) {
  process.stderr.write(`package verification failed: ${failure}\n`);
  process.exitCode = 1;
} else {
  summary.repository_snapshot.unchanged = repositoryUnchanged;
  summary.temporary_directory_removed = !existsSync(tempRoot);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function run(command, args, cwd, env, timeoutMs) {
  const result = await runBoundedCommand(command, args, {
    cwd,
    env,
    output: 'pipe',
    timeoutMs,
  });
  if (result.timedOut) throw new Error(`${command} exceeded its bounded timeout`);
  if (result.outputLimitExceeded) throw new Error(`${command} exceeded its bounded output limit`);
  if (result.status !== 0) {
    throw new Error(
      `${safeOutput(command)} exited ${result.status ?? 'without a status'}\n${safeOutput(result.stdout)}${safeOutput(result.stderr)}`,
    );
  }
  return result;
}

function parsePackOutput(stdout) {
  const match = stdout.match(/\[\s*\{/);
  if (match?.index === undefined) throw new Error(`npm pack --json did not return a JSON array:\n${safeOutput(stdout)}`);
  return JSON.parse(stdout.slice(match.index));
}

function copyCleanSourceTree() {
  const paths = [...CLEAN_SOURCE_FILES, ...sourceTypeScriptPaths()];
  let totalBytes = 0;
  mkdirSync(sourceDirectory, { recursive: true, mode: 0o700 });
  for (const path of paths) {
    const source = resolve(repoRoot, path);
    const offset = relative(repoRoot, source);
    if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
      throw new Error('clean-source allowlist contains an unsafe path');
    }
    const entry = lstatSync(source);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`clean-source entry is not a regular file: ${path}`);
    if (entry.size > MAX_PACKAGE_FILE_BYTES) throw new Error(`clean-source file exceeds the bounded size limit: ${path}`);
    totalBytes += entry.size;
    if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) throw new Error('clean-source allowlist exceeds the bounded total-size limit');
    const destination = join(sourceDirectory, path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
    chmodSync(destination, entry.mode & 0o777);
  }
  return { fileCount: paths.length, totalBytes };
}

function sourceTypeScriptPaths() {
  const output = [];
  visit(join(repoRoot, 'src'), 'src');
  return output.sort();

  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = `${prefix}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      const metadata = lstatSync(absolutePath);
      if (metadata.isSymbolicLink()) throw new Error('clean-source src tree contains a symbolic link');
      if (metadata.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (metadata.isFile() && entry.name.endsWith('.ts')) {
        output.push(relativePath);
      } else if (!metadata.isFile()) {
        throw new Error('clean-source src tree contains an unsupported entry');
      }
    }
  }
}

function snapshotRepositoryMetadata(root) {
  const snapshot = new Map();
  visit(root, '');
  return snapshot;

  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (prefix === '' && (entry.name === '.git' || entry.name === '.oculory')) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      snapshot.set(relativePath, metadataMarker(absolutePath));
      if (entry.isDirectory()) visit(absolutePath, relativePath);
    }
  }
}

function sameRepositorySnapshot(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, marker] of left) {
    if (right.get(path) !== marker) return false;
  }
  return true;
}

function metadataMarker(path) {
  const entry = lstatSync(path, { bigint: true });
  const type = entry.isFile() ? 'f' : entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'o';
  return `${type}:${entry.mode & 0o7777n}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`;
}

async function sha256File(path) {
  const digest = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest('hex');
}

function nodeRequireOption(path) {
  if (/\0|\r|\n/.test(path)) throw new Error('network guard path is invalid');
  return `--require=${JSON.stringify(path)}`;
}

async function verifyNodeNetworkGuard(environment) {
  const uniqueSuffix = basename(tempRoot).slice(-6).replace(/[^A-Za-z0-9]/g, 'x');
  const unixProbe = join(tmpdir(), `ocg-${process.pid}-${uniqueSuffix}.sock`);
  if (existsSync(unixProbe)) throw new Error('owned network guard probe path already exists');
  const source = [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const tls = require('node:tls');",
    "const http = require('node:http');",
    "const dns = require('node:dns');",
    "const dgram = require('node:dgram');",
    "const code = 'OCULORY_NODE_NETWORK_DENIED';",
    "const denied = (callback) => { try { callback(); } catch (error) { if (error && error.code === code) return; throw error; } throw new Error('network operation was not denied'); };",
    "if (globalThis[Symbol.for('oculory.node-network-denied')] !== true) throw new Error('network guard preload is absent');",
    "denied(() => net.connect({ host: '127.0.0.1', port: 9 }));",
    "denied(() => net.createServer().listen(0, '127.0.0.1'));",
    "denied(() => tls.connect({ host: '127.0.0.1', port: 9 }));",
    "denied(() => http.get('http://127.0.0.1:9/'));",
    "denied(() => dns.lookup('provider.invalid', () => {}));",
    "denied(() => dgram.createSocket('udp4'));",
    "(async () => {",
    "  try { await fetch('http://127.0.0.1:9/'); throw new Error('fetch was not denied'); } catch (error) { if (!error || error.code !== code) throw error; }",
    "  const socketPath = process.env.OCULORY_NETWORK_GUARD_UNIX_PROBE;",
    "  const server = net.createServer((socket) => socket.end());",
    "  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });",
    "  await new Promise((resolve, reject) => { const socket = net.createConnection(socketPath); socket.once('error', reject); socket.once('close', resolve); });",
    "  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));",
    "  if (fs.existsSync(socketPath)) {",
    "    const entry = fs.lstatSync(socketPath);",
    "    if (!entry.isSocket() || entry.isSymbolicLink()) throw new Error('Unix-domain probe residue is not an owned socket');",
    "    fs.rmSync(socketPath);",
    "  }",
    "})().catch((error) => { process.stderr.write(error instanceof Error ? error.message : 'network guard probe failed'); process.exitCode = 1; });",
  ].join('\n');
  try {
    await run(
      process.execPath,
      ['-e', source],
      consumerDirectory,
      { ...environment, OCULORY_NETWORK_GUARD_UNIX_PROBE: unixProbe },
      30_000,
    );
    if (existsSync(unixProbe)) throw new Error('network guard Unix-domain probe left residue');
  } finally {
    removeOwnedGuardSocket(unixProbe);
  }
}

function removeOwnedGuardSocket(path) {
  if (!existsSync(path)) return;
  const offset = relative(resolve(tmpdir()), resolve(path));
  if (
    offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset) ||
    !/^ocg-\d+-[A-Za-z0-9]{6}\.sock$/.test(offset)
  ) {
    throw new Error('refusing to remove an unverified network guard probe path');
  }
  const entry = lstatSync(path);
  if (!entry.isSocket() || entry.isSymbolicLink()) throw new Error('network guard probe residue is not an owned socket');
  rmSync(path);
  if (existsSync(path)) throw new Error('network guard probe socket cleanup failed');
}

function networkGuardEvidence() {
  const entry = lstatSync(networkGuardProofPath);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024) {
    throw new Error('network guard proof is not a bounded regular file');
  }
  const lines = readFileSync(networkGuardProofPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const records = lines.map((line) => {
    const match = /^(\d+):([A-Za-z0-9._-]+)$/.exec(line);
    if (match === null) throw new Error('network guard proof contains an invalid record');
    return { pid: match[1], role: match[2] };
  });
  const roles = new Set(records.map((record) => record.role));
  for (const group of REQUIRED_GUARDED_NODE_ROLE_GROUPS) {
    if (!group.roles.some((role) => roles.has(role))) {
      throw new Error(`network guard proof is missing the ${group.label} layer`);
    }
  }
  const processCount = new Set(records.map((record) => record.pid)).size;
  if (processCount < 8) throw new Error('network guard proof contains too few distinct package/demo processes');
  return { processCount, roles: [...roles].sort() };
}

function npmEnvironment() {
  return selectedEnvironment({
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TMPDIR: isolatedTmp,
    TEMP: isolatedTmp,
    TMP: isolatedTmp,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  });
}

function cliEnvironment(overrides = {}) {
  const globalBin = process.platform === 'win32' ? globalPrefix : join(globalPrefix, 'bin');
  return selectedEnvironment({
    PATH: [globalBin, dirname(process.execPath), process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TMPDIR: isolatedTmp,
    TEMP: isolatedTmp,
    TMP: isolatedTmp,
    NO_COLOR: '1',
    OCULORY_OFFLINE: '1',
    OCULORY_TELEMETRY_DISABLED: '1',
    ...overrides,
  });
}

function selectedEnvironment(overrides) {
  const names = [
    'PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'LANG', 'LC_ALL', 'TZ', 'CI', 'GITHUB_ACTIONS',
  ];
  return {
    ...Object.fromEntries(names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    })),
    ...overrides,
  };
}

function installedPackageRoot(prefix) {
  return process.platform === 'win32'
    ? join(prefix, 'node_modules', packageJson.name)
    : join(prefix, 'lib', 'node_modules', packageJson.name);
}

function globalCommandPath(name) {
  return process.platform === 'win32' ? join(globalPrefix, `${name}.cmd`) : join(globalPrefix, 'bin', name);
}

async function installedOculory(args, packageRoot, timeoutMs = 30_000, environment = cliEnvironment()) {
  if (process.platform === 'win32') {
    return await run(process.execPath, [join(packageRoot, 'bin', 'oculory'), ...args], consumerDirectory, environment, timeoutMs);
  }
  return await run(join(globalPrefix, 'bin', 'oculory'), args, consumerDirectory, environment, timeoutMs);
}

async function installedAdapterModule(packageRoot) {
  const parent = join(packageRoot, 'package-export-probe.cjs');
  const source = [
    "const { createRequire } = require('node:module');",
    'const requireFromPackage = createRequire(process.argv[1]);',
    "const target = requireFromPackage.resolve('oculory/adapters');",
    'import(target).then((module) => {',
    '  const ids = module.createBuiltinAdapterRegistry().list().map((entry) => entry.id).sort();',
    "  process.stdout.write(ids.join(','));",
    '}).catch((error) => {',
    "  process.stderr.write(error instanceof Error ? error.message : 'adapter import failed');",
    '  process.exitCode = 1;',
    '});',
  ].join('\n');
  return await run(process.execPath, ['-e', source, parent], consumerDirectory, cliEnvironment(), 30_000);
}

function installedContent(packageRoot, path) {
  const absolute = resolve(packageRoot, path);
  const offset = relative(resolve(packageRoot), absolute);
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error('installed package path escapes its package root');
  }
  if (!existsSync(absolute)) {
    throw new Error(`installed package file is absent: ${path}`);
  }
  const entry = lstatSync(absolute);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`installed package entry is not a regular file: ${path}`);
  if (entry.size > MAX_PACKAGE_FILE_BYTES) throw new Error(`installed package file exceeds the bounded size limit: ${path}`);
  const buffer = readFileSync(absolute);
  if (buffer.length !== entry.size) throw new Error(`installed package file changed while being read: ${path}`);
  return buffer;
}

function installedPackagePaths(packageRoot) {
  const output = [];
  visit(packageRoot, '');
  return output.sort();

  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (prefix === '' && entry.name === 'node_modules') continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        output.push(relativePath);
      } else {
        throw new Error(`installed package contains unsupported entry: ${relativePath}`);
      }
    }
  }
}

function snapshotDirectory(root) {
  const entries = [];
  visit(root, '');
  return entries.sort();

  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      const absolutePath = join(directory, entry.name);
      const marker = metadataMarker(absolutePath);
      entries.push(`${marker}:${relativePath}`);
      if (entry.isDirectory()) visit(join(directory, entry.name), relativePath);
    }
  }
}

function snapshotWritableRoots() {
  return Object.fromEntries([
    ['consumer', consumerDirectory],
    ['home', isolatedHome],
    ['temporary', isolatedTmp],
    ['global-prefix', globalPrefix],
  ].map(([name, root]) => [name, snapshotDirectory(root)]));
}

function safeOutput(value) {
  return String(value ?? '')
    .replaceAll(repoRoot, '<repository>')
    .replaceAll(tempRoot, '<temporary>')
    .replace(/(?:\/Users|\/home|\/root|\/(?:private\/)?var\/folders)\/[^\s:'"]+/g, '<private-path>')
    .replace(/[A-Za-z]:[\\/]Users[\\/][^\s:'"]+/g, '<private-path>')
    .replace(/\b(?:sk-ant-|sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g, '<redacted>')
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgresql://<redacted>@')
    .slice(0, 16 * 1024);
}

function safeMessage(error) {
  return error instanceof Error ? safeOutput(error.message).replace(/[\r\n]+/g, ' ') : 'unknown process error';
}
