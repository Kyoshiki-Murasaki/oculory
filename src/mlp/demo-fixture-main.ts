#!/usr/bin/env node
import { demoFixtureCli } from './demo-fixture.js';

try {
  demoFixtureCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`oculory demo fixture: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
