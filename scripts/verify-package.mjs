import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackageEntries } from './package-policy.mjs';

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const tempRoot = mkdtempSync(join(tmpdir(), 'oculory package verification '));
const packDirectory = join(tempRoot, 'pack output');
const consumerDirectory = join(tempRoot, 'consumer project');
let summary;

function run(command, args, cwd) {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status ?? 'without a status'}\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function parsePackOutput(stdout) {
  const match = stdout.match(/\[\s*\{/);
  if (match?.index === undefined) throw new Error(`npm pack --json did not return a JSON array:\n${stdout}`);
  return JSON.parse(stdout.slice(match.index));
}

function npxOculory(args) {
  return run(npxCommand, ['--no-install', 'oculory', ...args], consumerDirectory);
}

try {
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });

  const packResult = run(
    npmCommand,
    ['pack', '--json', '--pack-destination', packDirectory],
    repoRoot,
  );
  const packed = parsePackOutput(packResult.stdout);
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error(`expected one npm package, received ${Array.isArray(packed) ? packed.length : 'non-array output'}`);
  }
  const artifact = packed[0];
  const contentResult = validatePackageEntries(artifact.files, (path) => {
    const sourcePath = join(repoRoot, path);
    if (!existsSync(sourcePath) || statSync(sourcePath).isDirectory()) return null;
    const buffer = readFileSync(sourcePath);
    if (buffer.includes(0)) return null;
    return buffer.toString('utf8');
  });

  const tarballPath = join(packDirectory, artifact.filename);
  const tarball = readFileSync(tarballPath);
  const sha256 = createHash('sha256').update(tarball).digest('hex');

  run(npmCommand, ['init', '--yes'], consumerDirectory);
  run(
    npmCommand,
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    consumerDirectory,
  );

  const version = npxOculory(['--version']);
  if (version.stdout.trim() !== packageJson.version) {
    throw new Error(`installed --version returned ${JSON.stringify(version.stdout.trim())}, expected ${packageJson.version}`);
  }

  const help = npxOculory(['--help']);
  if (!/Usage:\s+oculory <command>/.test(help.stdout)) {
    throw new Error('installed --help did not contain the CLI usage line');
  }

  const doctor = JSON.parse(npxOculory(['doctor', '--json']).stdout);
  if (doctor.ok !== true) throw new Error('installed doctor --json did not report ok=true');
  if (!doctor.checks.some((check) => check.status === 'ok' && check.name.startsWith('fixture readable at '))) {
    throw new Error('installed doctor did not prove the packaged fixture is readable');
  }
  if (!doctor.checks.some((check) => check.status === 'ok' && check.name === 'node:sqlite functional')) {
    throw new Error('installed doctor did not prove node:sqlite is functional');
  }

  const inspect = JSON.parse(npxOculory(['inspect', '--json']).stdout);
  if (!Array.isArray(inspect.tools) || inspect.tools.length === 0) {
    throw new Error('installed inspect --json did not return runtime tool definitions');
  }

  summary = {
    package_filename: artifact.filename,
    package_version: artifact.version,
    package_sha256: sha256,
    package_bytes: tarball.length,
    package_file_count: contentResult.fileCount,
    required_files: contentResult.requiredFiles,
    prohibited_checks: contentResult.prohibitedChecks,
    installed_checks: {
      version: 'passed',
      help: 'passed',
      doctor_json: 'passed',
      packaged_fixture: 'passed',
      sqlite: 'passed',
      deterministic_inspect: 'passed',
      provider_calls: 0,
    },
  };
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

summary.temporary_directory_removed = !existsSync(tempRoot);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
