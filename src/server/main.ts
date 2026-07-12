/**
 * Stdio entrypoint for the demo MCP server.
 *   OCULORY_MUTATION=<mutation_id>  enable one named defect (default: none)
 *   OCULORY_FIXTURE=<path.json>     seed fixture (default: fixtures/seed.json)
 * Any MCP stdio client (Inspector, Claude Desktop, oculory record) can talk
 * to this process.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DemoServer } from './tools.js';
import { flagsFor } from './mutations.js';
import { serveStdio } from '../mcp/mcp.js';
import type { JsonObject } from '../schema/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const mutationId = process.env.OCULORY_MUTATION ?? null;
const fixturePath = process.env.OCULORY_FIXTURE ?? join(here, '..', '..', '..', 'fixtures', 'seed.json');

const server = new DemoServer(flagsFor(mutationId === '' ? null : mutationId));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { rows: JsonObject[] };
server.domain.reset(fixture.rows as never);
serveStdio(server);
