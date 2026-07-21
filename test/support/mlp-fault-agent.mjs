import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
};
const mode = option('--mode');
const runId = option('--run-id');
const syntheticCredentialUnavailable = process.env.OCULORY_SYNTHETIC_LOCAL_CREDENTIAL === undefined;

if (mode === 'hang') {
  setInterval(() => {}, 1_000);
} else if (mode === 'mixed-infra' && Number(/^run_(\d+)$/.exec(runId)?.[1]) % 2 === 0) {
  process.stderr.write('synthetic intermittent infrastructure failure\n');
  process.exitCode = 7;
} else {
  const parsed = JSON.parse(readFileSync(option('--mcp-config'), 'utf8'));
  const server = parsed.mcpServers.oculory;
  const child = spawn(server.command, server.args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let proxyStderr = '';
  child.stderr.on('data', (chunk) => { proxyStderr += chunk.toString('utf8'); });
  const pending = new Map();
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter === undefined) return;
    pending.delete(response.id);
    clearTimeout(waiter.timer);
    if (response.error !== undefined) waiter.reject(new Error(response.error.message));
    else waiter.resolve(response.result);
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 8_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mlp-fault-agent', version: '1.0.0' },
  });
  await rpc('tools/list', {});
  const calls = mode === 'ambiguous' ? 2 : 1;
  for (let index = 0; index < calls; index++) {
    try {
      const argumentsValue = mode === 'agent-secret-request'
        ? {
            note: process.env.OCULORY_SYNTHETIC_LOCAL_CREDENTIAL,
            [process.env.OCULORY_SYNTHETIC_LOCAL_CREDENTIAL]: 'synthetic argument key',
          }
        : {};
      const result = await rpc('tools/call', { name: 'mutate_state', arguments: argumentsValue });
      if (mode === 'agent-secret-request') {
        const serialized = JSON.stringify(result);
        if (serialized.includes(process.env.OCULORY_SYNTHETIC_LOCAL_CREDENTIAL)) {
          throw new Error('proxy returned a sensitive object key to the agent');
        }
        if (!serialized.includes('[REDACTED]')) throw new Error('proxy did not redact the sensitive response key');
      }
    } catch (error) {
      if (mode !== 'malformed') throw error;
    }
  }
  child.stdin.end();
  const outcome = await exited;
  if (outcome.code !== 0) throw new Error(`proxy exited abnormally: ${proxyStderr}`);
  if (mode === 'unavailable-claim') process.stdout.write('agent completed without a claim witness\n');
  else if (mode === 'env-isolation') {
    process.stdout.write(`CLAIM: MCP-only credential ${syntheticCredentialUnavailable ? 'unavailable' : 'available'} to agent\n`);
  }
  else process.stdout.write(`CLAIM: completed ${mode}\n`);
}
