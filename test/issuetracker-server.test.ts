import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IssueTrackerServer } from '../src/examples/issuetracker/server.js';
import { issueFlagsFor } from '../src/examples/issuetracker/mutations.js';
import { issueSeed } from '../src/examples/issuetracker/fixtures.js';

function server(mutationId: string | null = null): IssueTrackerServer {
  return new IssueTrackerServer(issueSeed(), issueFlagsFor(mutationId));
}
function issueOf(payload: unknown): Record<string, unknown> {
  return (payload as { issue: Record<string, unknown> }).issue;
}

/* ------------------------------- semantics ------------------------------ */

test('issue-server: create opens a new issue with an assigned id, status open', () => {
  const s = server();
  const r = s.callTool('create_issue', { title: 'New bug', body: 'details' });
  assert.equal(r.status, 'ok');
  const issue = issueOf(r.payload);
  assert.equal(issue.id, 'ISSUE-7', 'id assigned after the 6 seed issues');
  assert.equal(issue.status, 'open');
  assert.equal(issue.priority, 'normal', 'default priority');
});

test('issue-server: read returns the exact stored issue; missing id is NOT_FOUND', () => {
  const s = server();
  assert.equal(issueOf(s.callTool('read_issue', { id: 'ISSUE-1' }).payload).title, 'Login button is broken');
  const miss = s.callTool('read_issue', { id: 'ISSUE-999' });
  assert.equal(miss.status, 'error');
  assert.equal(miss.error_code, 'NOT_FOUND');
});

test('issue-server: search matches titles case-insensitively (login → two issues)', () => {
  const r = server().callTool('search_issues', { query: 'login' });
  assert.equal(r.status, 'ok');
  const ids = (r.payload as { ids: string[] }).ids;
  assert.deepEqual(ids, ['ISSUE-1', 'ISSUE-2']);
});

test('issue-server: assign to a known user succeeds; unknown user is INVALID_USER', () => {
  const s = server();
  assert.equal(issueOf(s.callTool('assign_issue', { id: 'ISSUE-1', assignee: 'alice' }).payload).assignee, 'alice');
  const bad = s.callTool('assign_issue', { id: 'ISSUE-2', assignee: 'dave' });
  assert.equal(bad.status, 'error');
  assert.equal(bad.error_code, 'INVALID_USER');
});

test('issue-server: label with an allowed label succeeds; disallowed label is INVALID_LABEL', () => {
  const s = server();
  assert.deepEqual(issueOf(s.callTool('label_issue', { id: 'ISSUE-1', label: 'bug' }).payload).labels, ['bug']);
  const bad = s.callTool('label_issue', { id: 'ISSUE-1', label: 'wontfix' });
  assert.equal(bad.status, 'error');
  assert.equal(bad.error_code, 'INVALID_LABEL');
});

test('issue-server: comment appends and preserves prior comments', () => {
  const s = server();
  s.callTool('comment_issue', { id: 'ISSUE-1', body: 'first' });
  const r = s.callTool('comment_issue', { id: 'ISSUE-1', body: 'second' });
  assert.deepEqual(issueOf(r.payload).comments, ['first', 'second']);
});

test('issue-server: close open → closed; closing an already-closed issue is INVALID_STATE', () => {
  const s = server();
  assert.equal(issueOf(s.callTool('close_issue', { id: 'ISSUE-1' }).payload).status, 'closed');
  const again = s.callTool('close_issue', { id: 'ISSUE-4' }); // ISSUE-4 seeded closed
  assert.equal(again.status, 'error');
  assert.equal(again.error_code, 'INVALID_STATE');
});

test('issue-server: reopen closed → open; reopening an open issue is INVALID_STATE', () => {
  const s = server();
  assert.equal(issueOf(s.callTool('reopen_issue', { id: 'ISSUE-4' }).payload).status, 'open');
  const bad = s.callTool('reopen_issue', { id: 'ISSUE-1' });
  assert.equal(bad.status, 'error');
  assert.equal(bad.error_code, 'INVALID_STATE');
});

test('issue-server: list filters by status', () => {
  const s = server();
  const open = (s.callTool('list_issues', { status: 'open' }).payload as { ids: string[] }).ids;
  const closed = (s.callTool('list_issues', { status: 'closed' }).payload as { ids: string[] }).ids;
  assert.deepEqual(open, ['ISSUE-1', 'ISSUE-2', 'ISSUE-3', 'ISSUE-5']);
  assert.deepEqual(closed, ['ISSUE-4', 'ISSUE-6']);
});

test('issue-server: read/search/list never change state', () => {
  const s = server();
  const before = s.snapshot().state_hash;
  s.callTool('read_issue', { id: 'ISSUE-1' });
  s.callTool('search_issues', { query: 'login' });
  s.callTool('list_issues', {});
  assert.equal(s.snapshot().state_hash, before, 'read-only tools leave state untouched');
});

/* -------------------------- induced regressions ------------------------- */

test('issue-server: close_noop reports ok but never changes status', () => {
  const s = server('close_noop');
  const r = s.callTool('close_issue', { id: 'ISSUE-1' });
  assert.equal(r.status, 'ok', 'reports success (the defect)');
  assert.equal(issueOf(s.callTool('read_issue', { id: 'ISSUE-1' }).payload).status, 'open', 'but stays open');
});

test('issue-server: assign_wrong_user assigns a different known user', () => {
  const s = server('assign_wrong_user');
  s.callTool('assign_issue', { id: 'ISSUE-1', assignee: 'alice' });
  assert.notEqual(issueOf(s.callTool('read_issue', { id: 'ISSUE-1' }).payload).assignee, 'alice');
});

test('issue-server: label_wrong_issue applies the label to a different issue', () => {
  const s = server('label_wrong_issue');
  s.callTool('label_issue', { id: 'ISSUE-2', label: 'bug' });
  assert.ok(!(issueOf(s.callTool('read_issue', { id: 'ISSUE-2' }).payload).labels as string[]).includes('bug'), 'requested issue untouched');
});

test('issue-server: comment_wrong_issue appends to a different issue', () => {
  const s = server('comment_wrong_issue');
  s.callTool('comment_issue', { id: 'ISSUE-2', body: 'note' });
  assert.deepEqual(issueOf(s.callTool('read_issue', { id: 'ISSUE-2' }).payload).comments, [], 'requested issue got no comment');
});

test('issue-server: search_returns_partial_wrong_match drops a real match', () => {
  const ids = (server('search_returns_partial_wrong_match').callTool('search_issues', { query: 'login' }).payload as { ids: string[] }).ids;
  assert.deepEqual(ids, ['ISSUE-2'], 'the first match is silently dropped');
});

test('issue-server: missing_id_succeeds fabricates a success instead of NOT_FOUND', () => {
  const r = server('missing_id_succeeds').callTool('read_issue', { id: 'ISSUE-999' });
  assert.equal(r.status, 'ok', 'the NOT_FOUND rejection is wrongly removed');
});

test('issue-server: invalid_user_allowed accepts an unknown assignee', () => {
  const s = server('invalid_user_allowed');
  const r = s.callTool('assign_issue', { id: 'ISSUE-1', assignee: 'dave' });
  assert.equal(r.status, 'ok');
  assert.equal(issueOf(s.callTool('read_issue', { id: 'ISSUE-1' }).payload).assignee, 'dave');
});

test('issue-server: invalid_label_allowed accepts a disallowed label', () => {
  const s = server('invalid_label_allowed');
  const r = s.callTool('label_issue', { id: 'ISSUE-1', label: 'wontfix' });
  assert.equal(r.status, 'ok');
  assert.ok((issueOf(s.callTool('read_issue', { id: 'ISSUE-1' }).payload).labels as string[]).includes('wontfix'));
});

test('issue-server: already_closed_policy_changed makes a double-close a silent no-op', () => {
  const r = server('already_closed_policy_changed').callTool('close_issue', { id: 'ISSUE-4' });
  assert.equal(r.status, 'ok', 'the INVALID_STATE rejection is wrongly removed');
});

test('issue-server: readonly_search_mutates_state changes state on a search', () => {
  const s = server('readonly_search_mutates_state');
  const before = s.snapshot().state_hash;
  s.callTool('search_issues', { query: 'login' });
  assert.notEqual(s.snapshot().state_hash, before, 'a read-only search wrongly mutated state');
});

test('issue-server: tool_order_changed reverses tool order but keeps the same set', () => {
  const plain = server().toolSpecs().map((t) => t.name);
  const mutated = server('tool_order_changed').toolSpecs().map((t) => t.name);
  assert.notDeepEqual(mutated, plain, 'order differs');
  assert.deepEqual([...mutated].sort(), [...plain].sort(), 'same set of tools');
});
