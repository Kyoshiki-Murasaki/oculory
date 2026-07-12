import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, hashJson, sha256 } from '../src/schema/canonical.js';
import { is, validate, ValidationError, rawTraceCheck } from '../src/schema/validate.js';
import { extractEntities } from '../src/pipeline/entities.js';
import { SCHEMA_VERSION } from '../src/schema/types.js';

test('canonicalJson sorts keys at every level and is stable', () => {
  const a = canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } });
  const b = canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":"x","d":[1,2]},"b":1}');
});

test('canonicalJson normalises -0 and rejects non-finite numbers', () => {
  assert.equal(canonicalJson(-0), '0');
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY));
});

test('hashJson is order-insensitive for keys, sensitive for arrays', () => {
  assert.equal(hashJson({ x: 1, y: 2 }), hashJson({ y: 2, x: 1 }));
  assert.notEqual(hashJson([1, 2]), hashJson([2, 1]));
  assert.equal(sha256('a').length, 64);
});

test('validator accepts valid objects and reports precise paths', () => {
  const check = is.object({ name: is.string(), tags: is.array(is.string()) }, { optional: ['tags'] });
  validate({ name: 'x', tags: ['a'] }, check);
  validate({ name: 'x' }, check);
  assert.throws(() => validate({ name: 5 } as never, check), (e: unknown) => e instanceof ValidationError && e.message.includes('$.name'));
  assert.throws(() => validate({ name: 'x', extra: 1 } as never, check), /unexpected field/);
});

test('rawTraceCheck rejects traces missing required provenance fields', () => {
  // Use the live SCHEMA_VERSION (not a hardcoded literal) so this test keeps
  // testing "missing fields are rejected" rather than incidentally re-testing
  // the schema_version literal check on the next version bump.
  assert.throws(() => validate({ schema_version: SCHEMA_VERSION } as never, rawTraceCheck), /missing required field/);
});

test('rawTraceCheck rejects a stale schema_version loudly (docs/04 migration policy)', () => {
  assert.throws(() => validate({ schema_version: 1 } as never, rawTraceCheck), /expected one of \[2\]/);
});

test('entity extraction: quoted titles, ids, priorities, assignees, projects, status', () => {
  assert.deepEqual(extractEntities("Create a task called 'Order new laptops'"), { title: 'Order new laptops' });
  assert.deepEqual(extractEntities('Mark task 3 as done'), { id: 3, status: 'done' });
  assert.deepEqual(extractEntities('Assign task 5 to dana'), { id: 5, assignee: 'dana' });
  assert.equal(extractEntities("Add 'Prepare board deck' with high priority").priority, 'high');
  assert.equal(extractEntities('How many tasks are in project infra?').project, 'infra');
  // 'Reopen' must not leak a 'open' status entity (word boundary).
  assert.equal(extractEntities('Reopen task 7').status, undefined);
});
