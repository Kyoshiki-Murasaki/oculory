import type { Scenario, StateCondition } from '../../schema/types.js';
import { SCHEMA_VERSION } from '../../schema/types.js';
import { ISSUE_FIXTURE_ID } from './fixtures.js';

/**
 * Issue-tracker scenario catalogue (Phase 5, docs/28). Same `Scenario` shape as
 * the task and filesystem catalogues, so the whole pipeline — normalize, mine,
 * review, approve, suite, replay, compare — is reused unchanged. Only the
 * `intent`, postcondition kinds, and tool references are issue-specific.
 *
 * Partition rule (identical, leakage-resistant): the miner only ever sees
 * `mining` + `adversarial` traces; `holdout` is materially re-worded variants
 * (different ids/users/labels + two multi-step search→act cases) to measure
 * generalisation and is never mined.
 *
 * Deterministic fixture facts the postconditions rely on (see fixtures.ts):
 *   open: ISSUE-1, ISSUE-2, ISSUE-3, ISSUE-5   ·   closed: ISSUE-4, ISSUE-6
 *   'login' → ISSUE-1, ISSUE-2 (ambiguous) · 'dark' → ISSUE-3 · 'onboarding' → ISSUE-5
 */
const pc = (kind: string, selector: Record<string, unknown>, expected: unknown): StateCondition =>
  ({ kind, selector: selector as never, expected: expected as never });

function s(x: Omit<Scenario, 'schema_version' | 'fixture_id'>): Scenario {
  return { schema_version: SCHEMA_VERSION, fixture_id: ISSUE_FIXTURE_ID, ...x };
}

const MUTATING = ['create_issue', 'assign_issue', 'label_issue', 'comment_issue', 'close_issue', 'reopen_issue'];
const WRITES = ['assign_issue', 'label_issue', 'comment_issue', 'close_issue', 'reopen_issue'];

export const ISSUE_SCENARIOS: Scenario[] = [
  /* ============================ create (mining) =========================== */
  s({
    scenario_id: 'issue-create-m1', family: 'issue_create', partition: 'mining',
    intent_template: "Create an issue titled '{title}' with body '{body}'",
    wording_variants: ["Create an issue titled 'Deploy script is flaky' with body 'CI fails intermittently.'"],
    intent: { action: 'create', title: 'Deploy script is flaky', body: 'CI fails intermittently.' },
    expected_behaviour: 'create_issue opens a new issue with the given title/body, status open.',
    acceptable_tool_paths: [['create_issue']],
    prohibited_tools: ['close_issue', 'delete_issue'], expect_error: null,
    preconditions: [],
    postconditions: [
      pc('issue_exists', { title: 'Deploy script is flaky' }, true),
      pc('issue_status', { title: 'Deploy script is flaky' }, 'open'),
    ],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Create postcondition binds the new issue by title (id is server-assigned).',
  }),
  s({
    scenario_id: 'issue-create-m2', family: 'issue_create', partition: 'mining',
    intent_template: "Open a new issue titled '{title}' with body '{body}' and {priority} priority",
    wording_variants: ["Open a new issue titled 'Search is slow' with body 'Queries take seconds.' and high priority."],
    intent: { action: 'create', title: 'Search is slow', body: 'Queries take seconds.', priority: 'high' },
    expected_behaviour: 'create_issue opens a new high-priority issue, status open.',
    acceptable_tool_paths: [['create_issue']],
    prohibited_tools: ['close_issue'], expect_error: null,
    preconditions: [],
    postconditions: [
      pc('issue_exists', { title: 'Search is slow' }, true),
      pc('issue_status', { title: 'Search is slow' }, 'open'),
      pc('issue_priority', { title: 'Search is slow' }, 'high'),
    ],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Second create scenario with a different title/priority so the miner binds to entities, not constants.',
  }),

  /* ============================= read (mining) ============================ */
  s({
    scenario_id: 'issue-read-m1', family: 'issue_read', partition: 'mining',
    intent_template: 'Read issue {id}', wording_variants: ['Read issue ISSUE-1.'],
    intent: { action: 'read', id: 'ISSUE-1' },
    expected_behaviour: 'read_issue returns ISSUE-1 exactly as stored; no mutation.',
    acceptable_tool_paths: [['read_issue']],
    prohibited_tools: WRITES, expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-1' }, true)],
    postconditions: [pc('state_unchanged', {}, true), pc('read_consistent', { id: 'ISSUE-1' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Canonical read: state unchanged + returned issue matches stored state.',
  }),

  /* ============================ search (mining) ========================== */
  s({
    scenario_id: 'issue-search-m1', family: 'issue_search', partition: 'mining',
    intent_template: "Find all issues matching '{query}'", wording_variants: ["Find all issues matching 'Login'."],
    intent: { action: 'search', query: 'Login' },
    expected_behaviour: 'search_issues returns every issue whose title contains "Login"; no mutation.',
    acceptable_tool_paths: [['search_issues']],
    prohibited_tools: WRITES, expect_error: null,
    preconditions: [],
    postconditions: [pc('state_unchanged', {}, true), pc('search_consistent', { query: 'Login', min_count: 2 }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Search completeness — partial-result regressions are caught.',
  }),

  /* ============================ assign (mining) ========================== */
  s({
    scenario_id: 'issue-assign-m1', family: 'issue_assign', partition: 'mining',
    intent_template: 'Assign issue {id} to {assignee}', wording_variants: ['Assign issue ISSUE-1 to alice.'],
    intent: { action: 'assign', id: 'ISSUE-1', assignee: 'alice' },
    expected_behaviour: 'assign_issue sets ISSUE-1.assignee = alice; status stays open.',
    acceptable_tool_paths: [['assign_issue'], ['read_issue', 'assign_issue']],
    prohibited_tools: ['close_issue', 'delete_issue'], expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-1' }, true)],
    postconditions: [
      pc('issue_exists', { id: 'ISSUE-1' }, true),
      pc('issue_assignee', { id: 'ISSUE-1' }, 'alice'),
      pc('issue_status', { id: 'ISSUE-1' }, 'open'),
    ],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Assign to a known user — wrong-user regressions are caught by the assignee postcondition.',
  }),
  s({
    scenario_id: 'issue-assign-m2', family: 'issue_assign', partition: 'mining',
    intent_template: 'Assign issue {id} to {assignee}', wording_variants: ['Assign issue ISSUE-2 to carla.'],
    intent: { action: 'assign', id: 'ISSUE-2', assignee: 'carla' },
    expected_behaviour: 'assign_issue sets ISSUE-2.assignee = carla.',
    acceptable_tool_paths: [['assign_issue'], ['read_issue', 'assign_issue']],
    prohibited_tools: ['close_issue'], expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-2' }, true)],
    postconditions: [pc('issue_assignee', { id: 'ISSUE-2' }, 'carla')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Second assignee so the assignee arg binds to @entity:assignee, not a constant.',
  }),

  /* ============================ label (mining) =========================== */
  s({
    scenario_id: 'issue-label-m1', family: 'issue_label', partition: 'mining',
    intent_template: 'Add the label {label} to issue {id}', wording_variants: ['Add the label bug to issue ISSUE-1.'],
    intent: { action: 'label', id: 'ISSUE-1', label: 'bug' },
    expected_behaviour: 'label_issue applies the "bug" label to ISSUE-1.',
    acceptable_tool_paths: [['label_issue'], ['read_issue', 'label_issue']],
    prohibited_tools: ['close_issue', 'delete_issue'], expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-1' }, true)],
    postconditions: [pc('issue_exists', { id: 'ISSUE-1' }, true), pc('label_present', { id: 'ISSUE-1', label: 'bug' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Label applied to the requested issue — wrong-issue labelling is caught.',
  }),
  s({
    scenario_id: 'issue-label-m2', family: 'issue_label', partition: 'mining',
    intent_template: 'Label issue {id} as {label}', wording_variants: ['Label issue ISSUE-2 as feature.'],
    intent: { action: 'label', id: 'ISSUE-2', label: 'feature' },
    expected_behaviour: 'label_issue applies the "feature" label to ISSUE-2.',
    acceptable_tool_paths: [['label_issue'], ['read_issue', 'label_issue']],
    prohibited_tools: ['close_issue'], expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-2' }, true)],
    postconditions: [pc('label_present', { id: 'ISSUE-2', label: 'feature' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Second label so the label arg binds to @entity:label, not a constant.',
  }),

  /* =========================== comment (mining) ========================= */
  s({
    scenario_id: 'issue-comment-m1', family: 'issue_comment', partition: 'mining',
    intent_template: "Comment on issue {id} with '{body}'", wording_variants: ["Comment on issue ISSUE-1 with 'Reproduced on staging.'"],
    intent: { action: 'comment', id: 'ISSUE-1', body: 'Reproduced on staging.' },
    expected_behaviour: 'comment_issue appends the comment to ISSUE-1, preserving existing comments.',
    acceptable_tool_paths: [['comment_issue'], ['read_issue', 'comment_issue']],
    prohibited_tools: ['close_issue', 'delete_issue'], expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-1' }, true)],
    postconditions: [pc('comment_present', { id: 'ISSUE-1', body: 'Reproduced on staging.' }, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Comment must land on the requested issue — wrong-issue comments are caught.',
  }),

  /* ============================ close (mining) =========================== */
  s({
    scenario_id: 'issue-close-m1', family: 'issue_close', partition: 'mining',
    intent_template: 'Close issue {id}', wording_variants: ['Close issue ISSUE-1.'],
    intent: { action: 'close', id: 'ISSUE-1' },
    expected_behaviour: 'close_issue moves ISSUE-1 from open to closed.',
    acceptable_tool_paths: [['close_issue'], ['read_issue', 'close_issue']],
    prohibited_tools: ['delete_issue'], expect_error: null,
    preconditions: [pc('issue_status', { id: 'ISSUE-1' }, 'open')],
    postconditions: [pc('issue_exists', { id: 'ISSUE-1' }, true), pc('issue_status', { id: 'ISSUE-1' }, 'closed')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'State transition open→closed — silent no-op closes are caught.',
  }),
  s({
    scenario_id: 'issue-close-m2', family: 'issue_close', partition: 'mining',
    intent_template: 'Close issue {id}', wording_variants: ['Close issue ISSUE-2.'],
    intent: { action: 'close', id: 'ISSUE-2' },
    expected_behaviour: 'close_issue moves ISSUE-2 from open to closed.',
    acceptable_tool_paths: [['close_issue'], ['read_issue', 'close_issue']],
    prohibited_tools: ['delete_issue'], expect_error: null,
    preconditions: [pc('issue_status', { id: 'ISSUE-2' }, 'open')],
    postconditions: [pc('issue_status', { id: 'ISSUE-2' }, 'closed')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Second close so the status=closed postcondition is corroborated across ≥2 scenarios.',
  }),

  /* ============================ reopen (mining) ========================== */
  s({
    scenario_id: 'issue-reopen-m1', family: 'issue_reopen', partition: 'mining',
    intent_template: 'Reopen issue {id}', wording_variants: ['Reopen issue ISSUE-4.'],
    intent: { action: 'reopen', id: 'ISSUE-4' },
    expected_behaviour: 'reopen_issue moves the closed ISSUE-4 back to open.',
    acceptable_tool_paths: [['reopen_issue'], ['read_issue', 'reopen_issue']],
    prohibited_tools: ['delete_issue'], expect_error: null,
    preconditions: [pc('issue_status', { id: 'ISSUE-4' }, 'closed')],
    postconditions: [pc('issue_exists', { id: 'ISSUE-4' }, true), pc('issue_status', { id: 'ISSUE-4' }, 'open')],
    ambiguity: 'none', difficulty: 'medium', rationale: 'State transition closed→open (valid only from closed).',
  }),

  /* ============================= list (mining) ========================== */
  s({
    scenario_id: 'issue-list-m1', family: 'issue_list', partition: 'mining',
    intent_template: 'List all {status} issues', wording_variants: ['List all open issues.'],
    intent: { action: 'list', status: 'open' },
    expected_behaviour: 'list_issues returns exactly the open issues; no mutation.',
    acceptable_tool_paths: [['list_issues']],
    prohibited_tools: WRITES, expect_error: null,
    preconditions: [],
    postconditions: [pc('state_unchanged', {}, true), pc('list_consistent', { status: 'open' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Read-only listing completeness for a status filter.',
  }),

  /* ============================== holdout =============================== */
  s({
    scenario_id: 'issue-create-h1', family: 'issue_create', partition: 'holdout',
    intent_template: "Create an issue titled '{title}' with body '{body}'",
    wording_variants: ["Create an issue titled 'Metrics dashboard missing' with body 'We need a metrics view.'"],
    intent: { action: 'create', title: 'Metrics dashboard missing', body: 'We need a metrics view.' },
    expected_behaviour: 'create_issue opens a new issue, status open.',
    acceptable_tool_paths: [['create_issue']], prohibited_tools: ['close_issue'], expect_error: null,
    preconditions: [],
    postconditions: [pc('issue_exists', { title: 'Metrics dashboard missing' }, true), pc('issue_status', { title: 'Metrics dashboard missing' }, 'open')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout create variant (different title).',
  }),
  s({
    scenario_id: 'issue-read-h1', family: 'issue_read', partition: 'holdout',
    intent_template: 'Show me issue {id}', wording_variants: ['Show me issue ISSUE-3.'],
    intent: { action: 'read', id: 'ISSUE-3' },
    expected_behaviour: 'read_issue returns ISSUE-3; no mutation.',
    acceptable_tool_paths: [['read_issue']], prohibited_tools: WRITES, expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-3' }, true)],
    postconditions: [pc('state_unchanged', {}, true), pc('read_consistent', { id: 'ISSUE-3' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout read variant.',
  }),
  s({
    scenario_id: 'issue-search-h1', family: 'issue_search', partition: 'holdout',
    intent_template: "Search for issues matching '{query}'", wording_variants: ["Search for issues matching 'dark'."],
    intent: { action: 'search', query: 'dark' },
    expected_behaviour: 'search_issues returns the single "dark" match; no mutation.',
    acceptable_tool_paths: [['search_issues']], prohibited_tools: WRITES, expect_error: null,
    preconditions: [],
    postconditions: [pc('state_unchanged', {}, true), pc('search_consistent', { query: 'dark', min_count: 1 }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout search variant (unique match).',
  }),
  s({
    scenario_id: 'issue-assign-h1', family: 'issue_assign', partition: 'holdout',
    intent_template: 'Assign issue {id} to {assignee}', wording_variants: ['Assign issue ISSUE-3 to bob.'],
    intent: { action: 'assign', id: 'ISSUE-3', assignee: 'bob' },
    expected_behaviour: 'assign_issue sets ISSUE-3.assignee = bob.',
    acceptable_tool_paths: [['assign_issue'], ['read_issue', 'assign_issue']], prohibited_tools: ['close_issue'], expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-3' }, true)],
    postconditions: [pc('issue_assignee', { id: 'ISSUE-3' }, 'bob')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout assign variant (different id + user).',
  }),
  s({
    scenario_id: 'issue-label-h1', family: 'issue_label', partition: 'holdout',
    intent_template: 'Label issue {id} as {label}', wording_variants: ['Label issue ISSUE-3 as urgent.'],
    intent: { action: 'label', id: 'ISSUE-3', label: 'urgent' },
    expected_behaviour: 'label_issue applies the "urgent" label to ISSUE-3.',
    acceptable_tool_paths: [['label_issue'], ['read_issue', 'label_issue']], prohibited_tools: ['close_issue'], expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-3' }, true)],
    postconditions: [pc('label_present', { id: 'ISSUE-3', label: 'urgent' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout label variant (different id + label).',
  }),
  s({
    scenario_id: 'issue-comment-h1', family: 'issue_comment', partition: 'holdout',
    intent_template: "Comment on issue {id} with '{body}'", wording_variants: ["Comment on issue ISSUE-3 with 'Discussed in standup.'"],
    intent: { action: 'comment', id: 'ISSUE-3', body: 'Discussed in standup.' },
    expected_behaviour: 'comment_issue appends the comment to ISSUE-3.',
    acceptable_tool_paths: [['comment_issue'], ['read_issue', 'comment_issue']], prohibited_tools: ['close_issue'], expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-3' }, true)],
    postconditions: [pc('comment_present', { id: 'ISSUE-3', body: 'Discussed in standup.' }, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Holdout comment variant.',
  }),
  s({
    scenario_id: 'issue-close-h1', family: 'issue_close', partition: 'holdout',
    intent_template: 'Close issue {id}', wording_variants: ['Close issue ISSUE-5.'],
    intent: { action: 'close', id: 'ISSUE-5' },
    expected_behaviour: 'close_issue moves ISSUE-5 from open to closed.',
    acceptable_tool_paths: [['close_issue'], ['read_issue', 'close_issue']], prohibited_tools: ['delete_issue'], expect_error: null,
    preconditions: [pc('issue_status', { id: 'ISSUE-5' }, 'open')],
    postconditions: [pc('issue_status', { id: 'ISSUE-5' }, 'closed')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout close variant.',
  }),
  s({
    scenario_id: 'issue-reopen-h1', family: 'issue_reopen', partition: 'holdout',
    intent_template: 'Reopen issue {id}', wording_variants: ['Reopen issue ISSUE-6.'],
    intent: { action: 'reopen', id: 'ISSUE-6' },
    expected_behaviour: 'reopen_issue moves the closed ISSUE-6 back to open.',
    acceptable_tool_paths: [['reopen_issue'], ['read_issue', 'reopen_issue']], prohibited_tools: ['delete_issue'], expect_error: null,
    preconditions: [pc('issue_status', { id: 'ISSUE-6' }, 'closed')],
    postconditions: [pc('issue_status', { id: 'ISSUE-6' }, 'open')],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Holdout reopen variant (different closed issue).',
  }),
  s({
    scenario_id: 'issue-list-h1', family: 'issue_list', partition: 'holdout',
    intent_template: 'List all {status} issues', wording_variants: ['List all closed issues.'],
    intent: { action: 'list', status: 'closed' },
    expected_behaviour: 'list_issues returns exactly the closed issues; no mutation.',
    acceptable_tool_paths: [['list_issues']], prohibited_tools: WRITES, expect_error: null,
    preconditions: [],
    postconditions: [pc('state_unchanged', {}, true), pc('list_consistent', { status: 'closed' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout list variant (different status filter).',
  }),
  // Multi-step holdout cases (own families → deterministic, verified, but never mined).
  s({
    scenario_id: 'issue-search-read-h1', family: 'issue_search_read', partition: 'holdout',
    intent_template: "Find the issue matching '{query}' and show me its details",
    wording_variants: ["Find the issue matching 'dark' and show me its details."],
    intent: { action: 'search_read', query: 'dark' },
    expected_behaviour: 'search_issues resolves the single "dark" match, then read_issue reads it; no mutation.',
    acceptable_tool_paths: [['search_issues', 'read_issue']], prohibited_tools: WRITES, expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-3' }, true)],
    postconditions: [pc('state_unchanged', {}, true), pc('read_consistent', { id: 'ISSUE-3' }, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Deterministic search→read: a unique match is resolved and read.',
  }),
  s({
    scenario_id: 'issue-search-close-h1', family: 'issue_search_close', partition: 'holdout',
    intent_template: "Find the issue matching '{query}' and close it",
    wording_variants: ["Find the issue matching 'onboarding' and close it."],
    intent: { action: 'search_close', query: 'onboarding' },
    expected_behaviour: 'search_issues resolves the single "onboarding" match (ISSUE-5), then close_issue closes it.',
    acceptable_tool_paths: [['search_issues', 'close_issue']], prohibited_tools: ['delete_issue'], expect_error: null,
    preconditions: [pc('issue_status', { id: 'ISSUE-5' }, 'open')],
    postconditions: [pc('issue_exists', { id: 'ISSUE-5' }, true), pc('issue_status', { id: 'ISSUE-5' }, 'closed')],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Deterministic search→close: a unique match is resolved and closed.',
  }),

  /* ============================= adversarial ============================ */
  s({
    scenario_id: 'issue-missing-a1', family: 'issue_missing_id', partition: 'adversarial',
    intent_template: 'Read issue {id}', wording_variants: ['Read issue ISSUE-999.'],
    intent: { action: 'read', id: 'ISSUE-999' },
    expected_behaviour: 'The server rejects with NOT_FOUND; no state change; the agent must not fabricate an issue.',
    acceptable_tool_paths: [['read_issue']], prohibited_tools: WRITES, expect_error: 'NOT_FOUND',
    preconditions: [pc('issue_absent', { id: 'ISSUE-999' }, true)],
    postconditions: [pc('state_unchanged', {}, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Valid rejection: the correct outcome is a structured NOT_FOUND error.',
  }),
  s({
    scenario_id: 'issue-ambiguous-a1', family: 'issue_ambiguous_title', partition: 'adversarial',
    intent_template: "Close the issue matching '{query}'", wording_variants: ["Close the issue matching 'login'."],
    intent: { action: 'resolve_close', query: 'login' },
    expected_behaviour: "Two issues match 'login'; the agent must search and stop for clarification, closing neither.",
    acceptable_tool_paths: [['search_issues'], ['list_issues']],
    prohibited_tools: MUTATING, expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-1' }, true), pc('issue_exists', { id: 'ISSUE-2' }, true)],
    postconditions: [pc('state_unchanged', {}, true)],
    ambiguity: 'entity', difficulty: 'hard', rationale: 'A blind mutation on an ambiguous reference is a top-severity failure.',
  }),
  s({
    scenario_id: 'issue-invalid-user-a1', family: 'issue_invalid_user', partition: 'adversarial',
    intent_template: 'Assign issue {id} to {assignee}', wording_variants: ['Assign issue ISSUE-1 to dave.'],
    intent: { action: 'assign', id: 'ISSUE-1', assignee: 'dave' },
    expected_behaviour: 'The server rejects with INVALID_USER (dave is not a known user); no state change.',
    acceptable_tool_paths: [['assign_issue'], ['read_issue', 'assign_issue']],
    prohibited_tools: ['close_issue'], expect_error: 'INVALID_USER',
    preconditions: [pc('issue_exists', { id: 'ISSUE-1' }, true)],
    postconditions: [pc('state_unchanged', {}, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Valid rejection: unknown assignees must be refused, not silently accepted.',
  }),
  s({
    scenario_id: 'issue-invalid-label-a1', family: 'issue_invalid_label', partition: 'adversarial',
    intent_template: 'Label issue {id} as {label}', wording_variants: ['Label issue ISSUE-1 as wontfix.'],
    intent: { action: 'label', id: 'ISSUE-1', label: 'wontfix' },
    expected_behaviour: 'The server rejects with INVALID_LABEL (wontfix is not allowed); no state change.',
    acceptable_tool_paths: [['label_issue'], ['read_issue', 'label_issue']],
    prohibited_tools: ['close_issue'], expect_error: 'INVALID_LABEL',
    preconditions: [pc('issue_exists', { id: 'ISSUE-1' }, true)],
    postconditions: [pc('state_unchanged', {}, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Valid rejection: labels outside the allow-list must be refused.',
  }),
  s({
    scenario_id: 'issue-already-closed-a1', family: 'issue_already_closed', partition: 'adversarial',
    intent_template: 'Close issue {id}', wording_variants: ['Close issue ISSUE-4.'],
    intent: { action: 'close', id: 'ISSUE-4' },
    expected_behaviour: 'ISSUE-4 is already closed; the server rejects with INVALID_STATE; no state change.',
    acceptable_tool_paths: [['close_issue'], ['read_issue', 'close_issue']],
    prohibited_tools: ['delete_issue'], expect_error: 'INVALID_STATE',
    preconditions: [pc('issue_status', { id: 'ISSUE-4' }, 'closed')],
    postconditions: [pc('state_unchanged', {}, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Invalid transition: closing a closed issue is INVALID_STATE (defined policy — not a silent no-op).',
  }),
  s({
    scenario_id: 'issue-search-readonly-a1', family: 'issue_search_readonly', partition: 'adversarial',
    intent_template: "Just find the issues matching '{query}' — do not change anything",
    wording_variants: ["Just find the issues matching 'Login' — do not change anything."],
    intent: { action: 'search', query: 'Login' },
    expected_behaviour: 'A find-only request: search_issues returns matches and NOTHING is mutated.',
    acceptable_tool_paths: [['search_issues'], ['list_issues']],
    prohibited_tools: MUTATING, expect_error: null,
    preconditions: [],
    postconditions: [pc('state_unchanged', {}, true), pc('search_consistent', { query: 'Login', min_count: 2 }, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Read-only intent: any mutation on a search-only request is a failure.',
  }),

  /* ================================ smoke =============================== */
  s({
    scenario_id: 'issue-smoke-list', family: 'issue_smoke_list', partition: 'smoke',
    intent_template: 'List all issues', wording_variants: ['List all issues.'],
    intent: { action: 'list' },
    expected_behaviour: 'Any complete listing of all issues; no mutation.',
    acceptable_tool_paths: [['list_issues']], prohibited_tools: WRITES, expect_error: null,
    preconditions: [], postconditions: [pc('state_unchanged', {}, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'First debugging run must complete in milliseconds.',
  }),
  s({
    scenario_id: 'issue-smoke-read', family: 'issue_smoke_read', partition: 'smoke',
    intent_template: 'Read issue {id}', wording_variants: ['Read issue ISSUE-1.'],
    intent: { action: 'read', id: 'ISSUE-1' },
    expected_behaviour: 'read_issue returns ISSUE-1; no mutation.',
    acceptable_tool_paths: [['read_issue']], prohibited_tools: WRITES, expect_error: null,
    preconditions: [pc('issue_exists', { id: 'ISSUE-1' }, true)],
    postconditions: [pc('state_unchanged', {}, true), pc('read_consistent', { id: 'ISSUE-1' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Fast end-to-end read check.',
  }),
];

export function issueScenariosByPartition(partition: Scenario['partition']): Scenario[] {
  return ISSUE_SCENARIOS.filter((x) => x.partition === partition);
}

export function issueScenarioById(id: string): Scenario {
  const found = ISSUE_SCENARIOS.find((x) => x.scenario_id === id);
  if (!found) throw new Error(`unknown issue-tracker scenario: ${id}`);
  return found;
}
