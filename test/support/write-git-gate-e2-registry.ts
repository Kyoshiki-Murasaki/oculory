import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGitGateE2MutationRegistry } from '../../src/targets/git/gate-e2-registry.js';

const index = process.argv.indexOf('--output');
const output = index < 0 ? undefined : process.argv[index + 1];
if (output === undefined) throw new Error('--output is required');
const registry = buildGitGateE2MutationRegistry();
writeFileSync(resolve(output), `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' });
process.stdout.write(`${JSON.stringify({ registryId: registry.registryId, registryDigest: registry.registryDigest, entries: registry.entries.length })}\n`);
