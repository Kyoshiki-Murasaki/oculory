import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { TaskDomain, DomainError } from '../src/server/domain.js';
import { DemoServer } from '../src/server/tools.js';
import { flagsFor, NO_MUTATIONS, MUTATIONS } from '../src/server/mutations.js';
import { handleRpc } from '../src/mcp/mcp.js';
import type { JsonObject } from '../src/schema/types.js';

const fixture = JSON.parse(readFileSync('fixtures/seed.json', 'utf8')) as { rows: JsonObject[] };

function freshDomain(): TaskDomain {
  const d = new TaskDomain(NO_MUTATIONS);
  d.reset(fixture.rows as never);
  return d;
}

test('domain: fixture reset is deterministic (identical state hash)', () => {
  const a = freshDomain().snapshot().state_hash;
  const b = freshDomain().snapshot().state_hash;
  assert.equal(a, b);
});

test('domain: complete is idempotent, reopen enforces transition, NOT_FOUND is structured', () => {
  const d = freshDomain();
  assert.equal(d.completeTask(1).changed, true);
  assert.equal(d.completeTask(1).changed, false); // idempotent
  assert.equal(d.getTask(1).status, 'done');
  assert.throws(() => d.reopenTask(2), (e: unknown) => e instanceof DomainError && e.code === 'INVALID_TRANSITION');
  assert.throws(() => d.getTask(999), (e: unknown) => e instanceof DomainError && e.code === 'NOT_FOUND');
  d.reopenTask(1);
  assert.equal(d.getTask(1).status, 'open');
});

test('domain: search is substring; enum validation rejects bad priority', () => {
  const d = freshDomain();
  assert.equal(d.searchTasks('login').length, 2);
  assert.throws(() => d.createTask('x', 'urgent', 'general', null), /priority must be one of/);
});

test('mutations: silent_write_failure reports ok without writing', () => {
  const d = new TaskDomain(flagsFor('silent_write_failure'));
  d.reset(fixture.rows as never);
  const { changed } = d.completeTask(1);
  assert.equal(changed, true); // lies
  assert.equal(d.getTask(1).status, 'open'); // truth
});

test('mutations: every registered mutation id maps to a flag; unknown ids rejected', () => {
  for (const m of MUTATIONS) assert.doesNotThrow(() => flagsFor(m.mutation_id));
  assert.throws(() => flagsFor('nope'));
});

test('mcp: initialize / tools/list / tools/call round-trip with JSON Schema shapes', () => {
  const server = new DemoServer(flagsFor(null));
  server.domain.reset(fixture.rows as never);
  const init = handleRpc(server, { jsonrpc: '2.0', id: 1, method: 'initialize' })!;
  assert.equal((init.result as JsonObject).protocolVersion, '2025-06-18');
  const list = handleRpc(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })!;
  const tools = (list.result as { tools: { name: string; inputSchema: JsonObject }[] }).tools;
  assert.equal(tools.length, 8);
  const create = tools.find((t) => t.name === 'create_task')!;
  assert.deepEqual((create.inputSchema.required as string[]), ['title']);
  const call = handleRpc(server, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'get_task', arguments: { id: 999 } } as never,
  })!;
  assert.equal((call.result as JsonObject).isError, true);
  const bad = handleRpc(server, { jsonrpc: '2.0', id: 4, method: 'bogus/method' })!;
  assert.equal((bad.error as JsonObject).code, -32601);
  assert.equal(handleRpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('mcp stdio integration: spawned server answers a real client over stdin/stdout', async () => {
  const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', 'dist/src/server/main.js'], {
    env: { ...process.env, OCULORY_FIXTURE: 'fixtures/seed.json' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines: string[] = [];
  child.stdout.setEncoding('utf8');
  let buf = '';
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  const send = (msg: JsonObject) => child.stdin.write(JSON.stringify(msg) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_tasks', arguments: { query: 'login' } } });
  const deadline = Date.now() + 5000;
  while (lines.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  child.stdin.end();
  child.kill();
  await once(child, 'exit');
  assert.equal(lines.length >= 2, true, 'expected two JSON-RPC responses');
  const second = JSON.parse(lines[1]!) as { result: { content: { text: string }[]; isError: boolean } };
  assert.equal(second.result.isError, false);
  const payload = JSON.parse(second.result.content[0]!.text) as { tasks: unknown[] };
  assert.equal(payload.tasks.length, 2);
});
