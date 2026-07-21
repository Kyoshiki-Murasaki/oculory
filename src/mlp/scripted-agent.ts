import { readFileSync } from 'node:fs';
import { McpStdioClient } from '../mcp/client/stdio-client.js';

export async function runScriptedAgent(argv: readonly string[]): Promise<void> {
  const mcpConfigPath = option(argv, '--mcp-config');
  const mode = option(argv, '--mode');
  const runId = option(argv, '--run-id');
  if (mode !== 'baseline' && mode !== 'changed') throw new Error('--mode must be baseline or changed');
  const server = readServer(mcpConfigPath);
  const client = new McpStdioClient({
    executable: server.command,
    args: server.args,
    cwd: process.cwd(),
    env: safeEnvironment(),
    clientInfo: { name: 'oculory-scripted-agent', version: '0.1.0' },
    requestedProtocolVersion: '2024-11-05',
    acceptedProtocolVersions: ['2024-11-05'],
    limits: { requestTimeoutMs: 30_000, startupTimeoutMs: 10_000 },
  });
  await client.start();
  try {
    await client.initialize();
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === 'create_feature_branch')) throw new Error('demo tool is unavailable');
    const number = Number(/^run_(\d+)$/.exec(runId)?.[1] ?? NaN);
    const changedPass = Number.isSafeInteger(number) && ((number - 1) % 12 + 12) % 12 < 3;
    const correct = mode === 'baseline' || changedPass;
    const outcome = await client.callTool('create_feature_branch', { base: correct ? 'develop' : 'main', commit: correct });
    if (outcome.kind !== 'tool_success') throw new Error('demo tool did not return success');
  } finally {
    await client.close();
  }
  process.stdout.write('Created branch and committed changes ✓\n');
}

function readServer(path: string): { command: string; args: string[] } {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object') throw new Error('invalid MCP configuration');
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (servers === null || typeof servers !== 'object') throw new Error('invalid MCP server configuration');
  const server = (servers as Record<string, unknown>).oculory;
  if (server === null || typeof server !== 'object') throw new Error('missing Oculory proxy configuration');
  const command = (server as Record<string, unknown>).command;
  const args = (server as Record<string, unknown>).args;
  if (typeof command !== 'string' || !Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) throw new Error('invalid Oculory proxy argv');
  return { command, args: args as string[] };
}

function option(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function safeEnvironment(): Record<string, string> {
  const environment: Record<string, string> = { LC_ALL: 'C', LANG: 'C' };
  for (const name of ['NODE_OPTIONS', 'OCULORY_NETWORK_GUARD_PROOF', 'PATH', 'SystemRoot', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name]!;
  }
  return environment;
}
