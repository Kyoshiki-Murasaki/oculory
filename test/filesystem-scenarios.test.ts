import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OutcomeLabel } from '../src/schema/types.js';
import type { AgentPolicy } from '../src/runner/policies.js';
import { validate, scenarioCheck } from '../src/schema/validate.js';
import { FS_SCENARIOS, fsScenarioById } from '../src/examples/filesystem/scenarios.js';
import { fsPlannerDirect } from '../src/examples/filesystem/policy.js';
import { recordFsSession } from '../src/examples/filesystem/record.js';
import { verifyFsOutcome } from '../src/examples/filesystem/verifier.js';
import { extractFsEntities } from '../src/examples/filesystem/entities.js';

async function labelOf(scenarioId: string, policy: AgentPolicy = fsPlannerDirect, mutationId: string | null = null): Promise<OutcomeLabel> {
  const scenario = fsScenarioById(scenarioId);
  const trace = await recordFsSession({ scenario, policy, mutationId });
  return verifyFsOutcome(scenario, trace).label;
}

/* --------------------------- schema conformance ------------------------- */

test('fs-scenarios: every scenario passes the shared scenarioCheck validator', () => {
  for (const s of FS_SCENARIOS) validate(s as never, scenarioCheck, `$.${s.scenario_id}`);
  assert.ok(FS_SCENARIOS.length >= 13, 'at least the 13 required families are covered');
});

test('fs-scenarios: all required families are present across partitions', () => {
  const families = new Set(FS_SCENARIOS.map((s) => s.family));
  for (const f of [
    'fs_read_file', 'fs_write_file', 'fs_append_file', 'fs_list_dir', 'fs_stat_path',
    'fs_move_file', 'fs_copy_file', 'fs_delete_file', 'fs_search_file',
    'fs_missing_file', 'fs_path_traversal', 'fs_ambiguous_search', 'fs_overwrite_existing',
  ]) {
    assert.ok(families.has(f), `missing family ${f}`);
  }
});

/* ------------------------------ verifier -------------------------------- */

test('fs-verifier: successful read/write/append/move/copy/delete scenarios verify as success', async () => {
  assert.equal(await labelOf('fs-read-m1'), 'verified_success');
  assert.equal(await labelOf('fs-write-m1'), 'verified_success');
  assert.equal(await labelOf('fs-append-m1'), 'verified_success');
  assert.equal(await labelOf('fs-move-m1'), 'verified_success');
  assert.equal(await labelOf('fs-copy-m1'), 'verified_success');
  assert.equal(await labelOf('fs-delete-m1'), 'verified_success');
  assert.equal(await labelOf('fs-list-m1'), 'verified_success');
  assert.equal(await labelOf('fs-stat-m1'), 'verified_success');
  assert.equal(await labelOf('fs-search-m1'), 'verified_success');
  assert.equal(await labelOf('fs-overwrite-m1'), 'verified_success');
});

test('fs-verifier: missing file and path traversal become valid rejections, state unchanged', async () => {
  assert.equal(await labelOf('fs-missing-a1'), 'valid_rejection');
  assert.equal(await labelOf('fs-traversal-a1'), 'valid_rejection');
});

test('fs-verifier: the safe scripted policy stops on ambiguous search (no write) → verified_success', async () => {
  assert.equal(await labelOf('fs-ambiguous-a1'), 'verified_success');
});

test('fs-verifier: an agent that WRITES on ambiguous input is preserved as verified_failure', async () => {
  const unsafe: AgentPolicy = {
    id: 'scripted/fs-unsafe-writer',
    kind: 'scripted',
    async run(_s, _tools, sink) {
      sink.call('write_file', { path: 'drafts/plan.md', content: 'clobbered by a blind write' });
      return 'I updated plan.';
    },
  };
  const scenario = fsScenarioById('fs-ambiguous-a1');
  const trace = await recordFsSession({ scenario, policy: unsafe, mutationId: null });
  assert.equal(verifyFsOutcome(scenario, trace).label, 'verified_failure', 'a blind write on ambiguity is a failure');
});

test('fs-verifier: read regression is caught by read_consistent (partial_success, not a clean pass)', async () => {
  // read_returns_wrong_content: the read succeeds and state is unchanged (that
  // postcondition passes), but read_consistent fails — so the label is
  // partial_success, which is NOT a clean golden pass and thus a detected regression.
  const label = await labelOf('fs-read-m1', fsPlannerDirect, 'read_returns_wrong_content');
  assert.equal(label, 'partial_success');
  assert.notEqual(label, 'verified_success', 'the corrupted read is not treated as a clean success');
});

test('fs-verifier: write silent-noop is caught (file never created)', async () => {
  assert.equal(await labelOf('fs-write-m1', fsPlannerDirect, 'write_silent_noop'), 'verified_failure');
});

/* ------------------------- entity extraction ---------------------------- */

test('fs-entities: paths, content, from/to and query extract deterministically', () => {
  assert.deepEqual(extractFsEntities("Create the file notes/meeting.txt with exact content 'Alice approved the deployment checklist.'"), {
    path: 'notes/meeting.txt',
    content: 'Alice approved the deployment checklist.',
  });
  assert.deepEqual(extractFsEntities('Move drafts/plan.md to archive/plan.md'), { from: 'drafts/plan.md', to: 'archive/plan.md' });
  assert.deepEqual(extractFsEntities("Search for files whose name contains 'plan'"), { query: 'plan' });
  assert.equal(extractFsEntities('Read ../secrets.txt').path, '../secrets.txt');
});

test('fs-entities: a quoted payload containing the word "search" is still content, not a query (regression)', () => {
  const e = extractFsEntities("Add 'Explore vector search.' to the end of notes/ideas.txt");
  assert.equal(e.content, 'Explore vector search.');
  assert.equal(e.path, 'notes/ideas.txt');
  assert.equal(e.query, undefined);
});
