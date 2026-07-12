import { runGateF0, type GateF0Arguments } from '../../src/targets/git/model/gate-f0-runner.js';

function value(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) throw new Error(`missing required argument ${name}`);
  return argv[index + 1]!;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args: GateF0Arguments = {
    pythonExecutable: value(argv, '--python'), targetExecutable: value(argv, '--executable'),
    gitExecutable: value(argv, '--git'), lockPath: value(argv, '--lock'), provider: value(argv, '--provider'),
    scenarioManifestPath: value(argv, '--scenario-manifest'), promptManifestPath: value(argv, '--prompt-manifest'),
    authorizationPath: value(argv, '--authorization'), runRoot: value(argv, '--run-root'), runId: value(argv, '--run-id'),
  };
  const output = await runGateF0(args);
  process.stdout.write(`${JSON.stringify({ gate_f0: output.decision, ...output })}\n`);
  if (output.decision !== 'passed') process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
