/**
 * Minimal MCP (Model Context Protocol) layer.
 *
 * DECISION (docs/03): the official @modelcontextprotocol/sdk is the intended
 * dependency; without network access this file implements the subset the MVP
 * needs — JSON-RPC 2.0 over newline-delimited stdio, `initialize`,
 * `tools/list`, `tools/call`, `ping` — with wire formats matching the spec
 * (inputSchema as JSON Schema; tool results as content blocks + isError).
 * The abstraction boundary is `McpEndpoint`; swapping in the SDK touches
 * only this file and src/server/main.ts.
 */
import { createInterface } from 'node:readline';
import type { Json, JsonObject, ToolSpec } from '../schema/types.js';
import { DemoServer } from '../server/tools.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpToolResult {
  status: 'ok' | 'error';
  error_code: string | null;
  payload: Json;
}

/** What recorders and replayers program against. */
export interface McpEndpoint {
  listTools(): ToolSpec[];
  callTool(name: string, args: JsonObject): McpToolResult;
  serverVersion(): string;
}

/* --------------------- In-process endpoint (default) -------------------- */

export class InProcessEndpoint implements McpEndpoint {
  constructor(private readonly server: DemoServer) {}
  listTools(): ToolSpec[] {
    return this.server.toolSpecs();
  }
  callTool(name: string, args: JsonObject): McpToolResult {
    return this.server.callTool(name, args);
  }
  serverVersion(): string {
    return '0.1.0';
  }
}

/* ------------------------- JSON Schema mapping -------------------------- */

export function toolSpecToJsonSchema(spec: ToolSpec): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const p of spec.params) {
    const prop: JsonObject = { type: p.type === 'integer' ? 'integer' : p.type, description: p.description };
    if (p.enum) prop.enum = [...p.enum];
    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/* ----------------------- JSON-RPC message handling ---------------------- */

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: JsonObject;
}

export function handleRpc(server: DemoServer, msg: RpcRequest): JsonObject | null {
  const reply = (result: Json): JsonObject => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
  const fail = (code: number, message: string): JsonObject => ({
    jsonrpc: '2.0',
    id: msg.id ?? null,
    error: { code, message },
  });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'oculory-demo-tasks', version: '0.1.0' },
      });
    case 'notifications/initialized':
      return null; // notification: no response
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: server.toolSpecs().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: toolSpecToJsonSchema(t),
        })),
      });
    case 'tools/call': {
      const params = msg.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as JsonObject;
      const out = server.callTool(name, args);
      return reply({
        content: [{ type: 'text', text: JSON.stringify(out.payload) }],
        isError: out.status === 'error',
      });
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

/** Serve MCP over stdio (newline-delimited JSON-RPC), per the MCP stdio transport. */
export function serveStdio(server: DemoServer): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcRequest;
    try {
      msg = JSON.parse(trimmed) as RpcRequest;
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n',
      );
      return;
    }
    const response = handleRpc(server, msg);
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  });
}
