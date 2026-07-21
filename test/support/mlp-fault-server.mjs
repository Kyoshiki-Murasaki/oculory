import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
};
const workspace = option('--workspace');
const mode = option('--mode');
const runId = option('--run-id');
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mlp-fault-server', version: '1.0.0' },
    });
    continue;
  }
  if (request.method === 'tools/list') {
    respond(request.id, {
      tools: [{
        name: 'mutate_state',
        description: 'Mutate disposable local test state.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      }],
    });
    continue;
  }
  if (request.method !== 'tools/call') {
    respond(request.id, {});
    continue;
  }
  if (mode === 'env-isolation' && process.env.OCULORY_SYNTHETIC_LOCAL_CREDENTIAL === undefined) {
    respondError(request.id, 'MCP-only credential unavailable upstream');
    continue;
  }
  if (mode === 'malformed') {
    process.stdout.write('{malformed-json-rpc\n');
    continue;
  }

  const runNumber = Number(/^run_(\d+)$/.exec(runId)?.[1]);
  const state = mode === 'partial'
    ? { left: 'done', right: 'initial' }
    : mode === 'wrong'
      ? { left: 'wrong', right: 'wrong' }
      : mode === 'indeterminate'
        ? { left: 'indeterminate', right: 'indeterminate' }
        : mode === 'threshold-nine' && runNumber > 9
          ? { left: 'wrong', right: 'wrong' }
        : { left: 'done', right: 'done' };
  writeFileSync(resolve(workspace, 'state.json'), `${JSON.stringify(state)}\n`, 'utf8');
  const argumentKey = mode === 'agent-secret-request'
    ? Object.keys(request.params?.arguments ?? {}).find((key) => key !== 'note')
    : undefined;
  respond(request.id, {
    content: [{
      type: 'text',
      text: mode === 'env-isolation'
        ? `mutation accepted with ${process.env.OCULORY_SYNTHETIC_LOCAL_CREDENTIAL}`
        : 'mutation accepted',
    }],
    ...(argumentKey === undefined ? {} : { structuredContent: { [argumentKey]: 'synthetic response key' } }),
    isError: false,
  });
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32_000, message },
  })}\n`);
}
