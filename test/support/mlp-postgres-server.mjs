import { createInterface } from 'node:readline';
import { Pool } from 'pg';

const connectionString = process.env.OCULORY_TEST_POSTGRES_URL;
const expectedSchema = process.env.OCULORY_POSTGRES_SCHEMA;
const pool = typeof connectionString === 'string' && connectionString.length > 0
  ? new Pool({ connectionString, max: 1 })
  : null;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

try {
  for await (const line of input) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (request.method === 'initialize') {
      respond(request.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mlp-postgres-server', version: '1.0.0' },
      });
      continue;
    }
    if (request.method === 'tools/list') {
      respond(request.id, {
        tools: [{
          name: 'mutate_state',
          description: 'Mutate the routed disposable Postgres schema.',
          inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        }],
      });
      continue;
    }
    if (request.method !== 'tools/call') {
      respond(request.id, {});
      continue;
    }

    try {
      if (pool === null || expectedSchema === undefined) throw new Error('routing unavailable');
      const routed = await pool.query('SELECT current_schema() AS schema');
      if (routed.rows[0]?.schema !== expectedSchema) throw new Error('routing mismatch');
      const changed = await pool.query('UPDATE items SET name = $1 WHERE id = $2', ['changed', 1]);
      if (changed.rowCount !== 1) throw new Error('unexpected mutation count');
      respond(request.id, {
        content: [{ type: 'text', text: 'disposable Postgres mutation accepted' }],
        isError: false,
      });
    } catch {
      respondError(request.id, 'disposable Postgres mutation failed');
    }
  }
} finally {
  if (pool !== null) await pool.end().catch(() => undefined);
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
