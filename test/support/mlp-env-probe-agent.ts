import { runScriptedAgent } from '../../src/mlp/scripted-agent.js';

const name = option('--forbidden-env');
const echoName = option('--echo-env');
if (process.env[name] !== undefined) {
  process.stderr.write('agent inherited an MCP-only environment variable\n');
  finish(1);
} else {
  process.stderr.write(`declared agent context: ${process.env[echoName] ?? 'unavailable'}\n`);
  runScriptedAgent(process.argv.slice(2)).then(
    () => finish(0),
    (error: unknown) => {
      process.stderr.write(`environment probe agent: ${error instanceof Error ? error.message : String(error)}\n`);
      finish(1);
    },
  );
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function finish(code: number): void {
  process.stdout.write('', () => process.exit(code));
}
