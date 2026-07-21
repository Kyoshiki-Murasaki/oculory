import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { assertDemoWorkspace, git } from './demo-fixture.js';

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export async function runDemoServer(workspace: string): Promise<void> {
  workspace = assertDemoWorkspace(workspace);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw new Error('invalid JSON-RPC request');
    } catch {
      respond(null, undefined, { code: -32700, message: 'invalid JSON-RPC request' });
      continue;
    }
    if (request.id === undefined) continue;
    try {
      if (request.method === 'initialize') {
        respond(request.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'oculory-demo-git', version: '0.1.0' },
        });
      } else if (request.method === 'tools/list') {
        respond(request.id, { tools: [{
          name: 'create_feature_branch',
          description: 'Create the demo feature branch and stage or commit two files.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['base', 'commit'],
            properties: { base: { enum: ['develop', 'main'] }, commit: { type: 'boolean' } },
          },
        }] });
      } else if (request.method === 'tools/call') {
        const params = object(request.params);
        if (params.name !== 'create_feature_branch') throw new Error('unknown tool');
        const args = object(params.arguments);
        if ((args.base !== 'develop' && args.base !== 'main') || typeof args.commit !== 'boolean') throw new Error('invalid tool arguments');
        applyChange(workspace, args.base, args.commit);
        respond(request.id, {
          content: [{ type: 'text', text: 'success' }],
          structuredContent: { ok: true },
          isError: false,
        });
      } else if (request.method === 'ping') respond(request.id, {});
      else respond(request.id, undefined, { code: -32601, message: 'method not found' });
    } catch (error) {
      respond(request.id, undefined, { code: -32000, message: error instanceof Error ? error.message : 'demo operation failed' });
    }
  }
}

function applyChange(workspace: string, base: 'develop' | 'main', commit: boolean): void {
  git(workspace, ['checkout', '--quiet', base]);
  git(workspace, ['checkout', '--quiet', '-b', 'feature/demo']);
  writeFileSync(resolve(workspace, 'feature.txt'), 'demo feature\n', 'utf8');
  mkdirSync(resolve(workspace, 'config'), { recursive: true, mode: 0o755 });
  writeFileSync(resolve(workspace, 'config', 'demo.txt'), 'enabled=true\n', 'utf8');
  git(workspace, ['add', '--', 'feature.txt', 'config/demo.txt']);
  if (commit) {
    git(workspace, ['-c', 'user.name=Oculory Demo', '-c', 'user.email=demo@oculory.invalid', 'commit', '--quiet', '-m', 'Create demo feature']);
  }
}

function respond(id: Request['id'], result?: unknown, error?: { code: number; message: string }): void {
  process.stdout.write(`${JSON.stringify(error === undefined ? { jsonrpc: '2.0', id, result } : { jsonrpc: '2.0', id, error })}\n`);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
