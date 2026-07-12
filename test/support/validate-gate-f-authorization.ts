import { readFileSync } from 'node:fs';
import { validateAuthorizationShape } from '../../src/model/authorization.js';

const path = process.argv[2] ?? 'authorizations/gate-f1-authorization-template.json';
const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
validateAuthorizationShape(value);
process.stdout.write(`validated ${path}; status=${value.status}; executable=${value.status === 'approved' ? 'requires binding validation' : 'false'}\n`);
