#!/usr/bin/env node
import { runRelay } from './proxy.js';

const endpoint = process.argv[2];
if (endpoint === undefined) {
  process.stderr.write('oculory relay: missing broker endpoint\n');
  finish(1);
} else {
  runRelay(endpoint).then(
    () => finish(0),
    (error: unknown) => {
      process.stderr.write(`oculory relay: ${error instanceof Error ? error.message : String(error)}\n`);
      finish(1);
    },
  );
}

function finish(code: number): void {
  process.stdout.write('', () => process.exit(code));
}
