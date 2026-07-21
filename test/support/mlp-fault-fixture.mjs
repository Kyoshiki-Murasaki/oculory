import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [operation, fault, workspace] = process.argv.slice(2);
if (!['setup', 'reset', 'cleanup'].includes(operation) || fault === undefined || workspace === undefined) {
  throw new Error('usage: mlp-fault-fixture <setup|reset|cleanup> <fault> <workspace>');
}

if (operation === 'reset' && fault === 'reset-fail') {
  process.stderr.write('synthetic reset failure\n');
  process.exitCode = 9;
} else if (operation === 'cleanup' && fault === 'cleanup-fail') {
  process.stderr.write('synthetic cleanup failure\n');
  process.exitCode = 10;
} else if (operation !== 'cleanup') {
  writeFileSync(
    resolve(workspace, 'state.json'),
    `${JSON.stringify({ left: 'initial', right: 'initial' })}\n`,
    'utf8',
  );
}
