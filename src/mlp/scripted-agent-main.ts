#!/usr/bin/env node
import { runScriptedAgent } from './scripted-agent.js';

runScriptedAgent(process.argv.slice(2)).then(
  () => finish(0),
  (error: unknown) => {
    process.stderr.write(`oculory scripted agent: ${error instanceof Error ? error.message : String(error)}\n`);
    finish(1);
  },
);

function finish(code: number): void {
  process.stdout.write('', () => process.exit(code));
}
