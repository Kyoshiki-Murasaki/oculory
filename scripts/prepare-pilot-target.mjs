import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_PYTHON = '3.12.13';
const EXPECTED_TARGET = '2026.7.10';
const EXPECTED_SOURCE_SHA256 = '52325521ec8ec00297248fa03eaee6802b9cad3ec1e5bebee25971e1b897d56e';
const repositoryRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const constraints = join(repositoryRoot, 'pilot', 'constraints.git-mcp-2026.7.10-py312.txt');
const root = process.env.RUNNER_TEMP
  ? join(process.env.RUNNER_TEMP, 'oculory pilot target')
  : join(tmpdir(), `oculory pilot target ${process.pid}`);
if (existsSync(root)) throw new Error('pilot target directory already exists');
mkdirSync(dirname(root), { recursive: true });

// Dependency installation is the one network-capable pilot setup step. Give it
// only operating-system, package-index, certificate, and proxy settings; never
// clone the ambient environment or read provider credential values.
const environment = pickEnvironment([
  'PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_TRUSTED_HOST',
  'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
]);

const bootstrapPython = process.platform === 'win32' ? 'python.exe' : 'python3';
run(bootstrapPython, ['--version']);
run(bootstrapPython, ['-m', 'venv', root]);
const executableDirectory = join(root, process.platform === 'win32' ? 'Scripts' : 'bin');
const python = join(executableDirectory, process.platform === 'win32' ? 'python.exe' : 'python');
run(python, [
  '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--only-binary=:all:',
  '--constraint', constraints,
  `mcp-server-git==${EXPECTED_TARGET}`,
]);

const inspection = JSON.parse(run(python, ['-c', String.raw`
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import sys
import mcp_server_git
server = Path(mcp_server_git.__file__).resolve().parent / "server.py"
print(json.dumps({
    "python": ".".join(str(value) for value in sys.version_info[:3]),
    "target": metadata.version("mcp-server-git"),
    "source_sha256": hashlib.sha256(server.read_bytes()).hexdigest(),
}, sort_keys=True))
`]).stdout);
if (inspection.python !== EXPECTED_PYTHON) throw new Error(`pilot Python differs: ${inspection.python}`);
if (inspection.target !== EXPECTED_TARGET) throw new Error(`pilot target differs: ${inspection.target}`);
if (inspection.source_sha256 !== EXPECTED_SOURCE_SHA256) throw new Error('pilot target source digest differs');

if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${executableDirectory}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  prepared: true,
  pythonVersion: inspection.python,
  targetVersion: inspection.target,
  targetSourceSha256: inspection.source_sha256,
  pathContainsSpaces: root.includes(' '),
  providerCredentialsRead: 0,
  providerCalls: 0,
})}\n`);

function run(command, args) {
  const result = spawnSync(command, args, {
    env: environment,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit ${result.status ?? 'unknown'}`);
  }
  return result;
}

function pickEnvironment(names) {
  return Object.fromEntries(names.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}
