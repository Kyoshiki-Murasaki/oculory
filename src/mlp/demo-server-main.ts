#!/usr/bin/env node
import { runDemoServer } from './demo-server.js';

const marker = process.argv.indexOf('--workspace');
const workspace = marker >= 0 ? process.argv[marker + 1] : undefined;
if (workspace === undefined) {
  process.stderr.write('oculory demo server: --workspace is required\n');
  process.exitCode = 1;
} else {
  runDemoServer(workspace).catch((error: unknown) => {
    process.stderr.write(`oculory demo server: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
