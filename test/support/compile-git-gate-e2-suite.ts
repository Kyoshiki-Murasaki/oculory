import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Json } from '../../src/schema/types.js';
import { compileGitGateE2Suite } from '../../src/targets/git/gate-e2.js';

function required(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return resolve(value);
}

const output = required('--output-dir');
const compiled = compileGitGateE2Suite({
  e1RunDirectory: required('--e1-run'),
  reviewPath: required('--review'),
});
mkdirSync(output, { recursive: true });
write('git-stage-contract-v1.json', compiled.stageContract as unknown as Json);
write('git-branch-create-contract-v1.json', compiled.branchContract as unknown as Json);
write('git-suite-v1.json', compiled.suite as unknown as Json);
process.stdout.write(`${JSON.stringify({ suiteId: compiled.suite.suiteId, suiteSha256: compiled.suite.suiteSha256, reviewArtifactDigest: compiled.reviewArtifactDigest })}\n`);

function write(name: string, value: Json): void {
  writeFileSync(resolve(output, name), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' });
}
