import type { Scenario, StateCondition } from '../schema/types.js';
import { SCHEMA_VERSION } from '../schema/types.js';

/**
 * Scenario catalogue (docs/06).
 *
 * Partitioning rule (leakage-resistant, docs/05 §Dataset split):
 *  - `mining`  : traces the miner may read.
 *  - `holdout` : materially re-worded variants of mined families PLUS two
 *                entire families (`update_priority`, `count_project`) the
 *                miner never sees at all. Nothing in `holdout` shares
 *                near-identical phrasing with `mining`.
 *  - `smoke`   : trivial fast subset for the first debugging run.
 *  - `adversarial` : ambiguity / invalid-input probes; advisory-only mining.
 * The miner receives `mining` traces only; enforcement is in the store
 * (loadTraces(partition)) and audited by a test.
 */

const post = (kind: string, selector: Record<string, unknown>, expected: unknown): StateCondition =>
  ({ kind, selector: selector as never, expected: expected as never });

function s(x: Omit<Scenario, 'schema_version'>): Scenario {
  return { schema_version: SCHEMA_VERSION, ...x };
}

export const SCENARIOS: Scenario[] = [
  /* ---------- family: complete_by_id (direct mutation) ------------------ */
  s({
    scenario_id: 'complete_by_id-m1', family: 'complete_by_id', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: 'Mark task {id} as done', wording_variants: ['Mark task 3 as done'],
    intent: { action: 'complete', id: 3 },
    expected_behaviour: 'Task 3 transitions to done via complete_task (or update_task status=done).',
    acceptable_tool_paths: [['complete_task'], ['update_task'], ['get_task', 'complete_task']],
    prohibited_tools: ['create_task', 'reopen_task'], expect_error: null,
    preconditions: [post('task_status', { id: 3 }, 'open')],
    postconditions: [post('task_status', { id: 3 }, 'done')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Canonical direct mutation with a verifiable state postcondition.',
  }),
  s({
    scenario_id: 'complete_by_id-m2', family: 'complete_by_id', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: 'Please complete task {id}', wording_variants: ['Please complete task 5'],
    intent: { action: 'complete', id: 5 },
    expected_behaviour: 'Task 5 transitions to done.',
    acceptable_tool_paths: [['complete_task'], ['update_task']],
    prohibited_tools: ['create_task', 'reopen_task'], expect_error: null,
    preconditions: [post('task_status', { id: 5 }, 'open')],
    postconditions: [post('task_status', { id: 5 }, 'done')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Second id keeps the miner from binding to one row.',
  }),
  s({
    scenario_id: 'complete_by_id-h1', family: 'complete_by_id', partition: 'holdout', fixture_id: 'seed-v1',
    intent_template: 'Task {id} is finished, close it out', wording_variants: ['Task 6 is finished, close it out'],
    intent: { action: 'complete', id: 6 },
    expected_behaviour: 'Task 6 transitions to done despite indirect phrasing.',
    acceptable_tool_paths: [['complete_task'], ['update_task']],
    prohibited_tools: ['create_task'], expect_error: null,
    preconditions: [post('task_status', { id: 6 }, 'open')],
    postconditions: [post('task_status', { id: 6 }, 'done')],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Materially re-worded holdout variant (no shared phrasing).',
  }),

  /* ---------- family: complete_by_title (search-before-mutation) -------- */
  s({
    scenario_id: 'complete_by_title-m1', family: 'complete_by_title', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: "Complete the task called '{title}'", wording_variants: ["Complete the task called 'Write onboarding docs'"],
    intent: { action: 'complete', title: 'Write onboarding docs' },
    expected_behaviour: 'Resolve the unique title to an id via search, then complete it.',
    acceptable_tool_paths: [['search_tasks', 'complete_task'], ['search_tasks', 'update_task'], ['list_tasks', 'complete_task']],
    prohibited_tools: ['create_task', 'reopen_task'], expect_error: null,
    preconditions: [post('task_status', { title: 'Write onboarding docs' }, 'open')],
    postconditions: [post('task_status', { title: 'Write onboarding docs' }, 'done')],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Search-before-mutation is the core multi-step workflow.',
  }),
  s({
    scenario_id: 'complete_by_title-m2', family: 'complete_by_title', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: "Finish '{title}'", wording_variants: ["Finish 'Update dependency versions'"],
    intent: { action: 'complete', title: 'Update dependency versions' },
    expected_behaviour: 'Resolve unique title, complete it.',
    acceptable_tool_paths: [['search_tasks', 'complete_task'], ['search_tasks', 'update_task']],
    prohibited_tools: ['create_task'], expect_error: null,
    preconditions: [post('task_status', { title: 'Update dependency versions' }, 'open')],
    postconditions: [post('task_status', { title: 'Update dependency versions' }, 'done')],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Variant title prevents binding constraints to one string.',
  }),
  s({
    scenario_id: 'complete_by_title-h1', family: 'complete_by_title', partition: 'holdout', fixture_id: 'seed-v1',
    intent_template: "We shipped it — '{title}' can be marked finished now",
    wording_variants: ["We shipped it — 'Refresh landing page copy' can be marked finished now"],
    intent: { action: 'complete', title: 'Refresh landing page copy' },
    expected_behaviour: 'Resolve unique title, complete it.',
    acceptable_tool_paths: [['search_tasks', 'complete_task'], ['search_tasks', 'update_task']],
    prohibited_tools: ['create_task'], expect_error: null,
    preconditions: [post('task_status', { title: 'Refresh landing page copy' }, 'open')],
    postconditions: [post('task_status', { title: 'Refresh landing page copy' }, 'done')],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Holdout phrasing shares no template with mining variants.',
  }),

  /* ---------- family: create_task ---------------------------------------- */
  s({
    scenario_id: 'create_task-m1', family: 'create_task', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: "Create a task called '{title}'", wording_variants: ["Create a task called 'Order new laptops'"],
    intent: { action: 'create', title: 'Order new laptops' },
    expected_behaviour: 'A new open task with the given title exists.',
    acceptable_tool_paths: [['create_task']], prohibited_tools: ['complete_task', 'update_task'], expect_error: null,
    preconditions: [post('task_absent', { title: 'Order new laptops' }, true)],
    postconditions: [post('task_exists', { title: 'Order new laptops' }, true), post('task_status', { title: 'Order new laptops' }, 'open')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Simplest creation path; title must equal the intent entity.',
  }),
  s({
    scenario_id: 'create_task-m2', family: 'create_task', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: "Add '{title}' with high priority", wording_variants: ["Add 'Prepare board deck' with high priority"],
    intent: { action: 'create', title: 'Prepare board deck', priority: 'high' },
    expected_behaviour: 'New task exists with priority high.',
    acceptable_tool_paths: [['create_task']], prohibited_tools: ['complete_task'], expect_error: null,
    preconditions: [post('task_absent', { title: 'Prepare board deck' }, true)],
    postconditions: [post('task_exists', { title: 'Prepare board deck' }, true), post('task_priority', { title: 'Prepare board deck' }, 'high')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Exercises the enum argument that mutation enum_changed breaks.',
  }),
  s({
    scenario_id: 'create_task-h1', family: 'create_task', partition: 'holdout', fixture_id: 'seed-v1',
    intent_template: "New high priority item: '{title}'", wording_variants: ["New high priority item: 'Rotate API keys'"],
    intent: { action: 'create', title: 'Rotate API keys', priority: 'high' },
    expected_behaviour: 'New task exists with priority high.',
    acceptable_tool_paths: [['create_task']], prohibited_tools: ['complete_task'], expect_error: null,
    preconditions: [post('task_absent', { title: 'Rotate API keys' }, true)],
    postconditions: [post('task_exists', { title: 'Rotate API keys' }, true), post('task_priority', { title: 'Rotate API keys' }, 'high')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout variant with different phrasing and entity values.',
  }),

  /* ---------- family: assign_task ---------------------------------------- */
  s({
    scenario_id: 'assign_task-m1', family: 'assign_task', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: 'Assign task {id} to {assignee}', wording_variants: ['Assign task 5 to dana'],
    intent: { action: 'assign', id: 5, assignee: 'dana' },
    expected_behaviour: 'Task 5 assignee becomes dana.',
    acceptable_tool_paths: [['assign_task'], ['get_task', 'assign_task']],
    prohibited_tools: ['create_task', 'complete_task'], expect_error: null,
    preconditions: [post('task_exists', { id: 5 }, true)],
    postconditions: [post('task_assignee', { id: 5 }, 'dana')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Two-argument mutation; assignee derives from intent.',
  }),
  s({
    scenario_id: 'assign_task-h1', family: 'assign_task', partition: 'holdout', fixture_id: 'seed-v1',
    intent_template: '{assignee} will take task {id}', wording_variants: ['Give task 9 to erin'],
    intent: { action: 'assign', id: 9, assignee: 'erin' },
    expected_behaviour: 'Task 9 assignee becomes erin.',
    acceptable_tool_paths: [['assign_task']], prohibited_tools: ['create_task'], expect_error: null,
    preconditions: [post('task_exists', { id: 9 }, true)],
    postconditions: [post('task_assignee', { id: 9 }, 'erin')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout phrasing variant.',
  }),

  /* ---------- family: reopen (valid + invalid transition) ---------------- */
  s({
    scenario_id: 'reopen_done-m1', family: 'reopen_done', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: 'Reopen task {id}', wording_variants: ['Reopen task 7'],
    intent: { action: 'reopen', id: 7 },
    expected_behaviour: 'Task 7 (done) transitions back to open.',
    acceptable_tool_paths: [['reopen_task'], ['get_task', 'reopen_task']],
    prohibited_tools: ['complete_task', 'create_task'], expect_error: null,
    preconditions: [post('task_status', { id: 7 }, 'done')],
    postconditions: [post('task_status', { id: 7 }, 'open')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'State-dependent operation only valid from done.',
  }),
  s({
    scenario_id: 'reopen_invalid-a1', family: 'reopen_invalid', partition: 'adversarial', fixture_id: 'seed-v1',
    intent_template: 'Reopen task {id}', wording_variants: ['Reopen task 2'],
    intent: { action: 'reopen', id: 2 },
    expected_behaviour: 'Server rejects with INVALID_TRANSITION (task 2 is open); no state change.',
    acceptable_tool_paths: [['reopen_task'], ['get_task', 'reopen_task'], ['get_task']],
    prohibited_tools: ['complete_task'], expect_error: 'INVALID_TRANSITION',
    preconditions: [post('task_status', { id: 2 }, 'open')],
    postconditions: [post('state_unchanged', {}, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Valid rejection: the correct outcome is a structured error.',
  }),

  /* ---------- family: nonexistent entity --------------------------------- */
  s({
    scenario_id: 'complete_nonexistent-a1', family: 'complete_nonexistent', partition: 'adversarial', fixture_id: 'seed-v1',
    intent_template: 'Mark task {id} as done', wording_variants: ['Mark task 999 as done'],
    intent: { action: 'complete', id: 999 },
    expected_behaviour: 'Server rejects with NOT_FOUND; no state change; agent must not fabricate success.',
    acceptable_tool_paths: [['complete_task'], ['get_task', 'complete_task'], ['get_task']],
    prohibited_tools: ['create_task'], expect_error: 'NOT_FOUND',
    preconditions: [post('task_absent', { id: 999 }, true)],
    postconditions: [post('state_unchanged', {}, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Probes wrong_success and error_changed mutations.',
  }),

  /* ---------- family: ambiguous title (multiple matches) ----------------- */
  s({
    scenario_id: 'ambiguous_title-a1', family: 'ambiguous_title', partition: 'adversarial', fixture_id: 'seed-v1',
    intent_template: 'Complete the {word} task', wording_variants: ['Complete the login task'],
    intent: { action: 'complete', title: 'login', ambiguous: true },
    expected_behaviour: "Two tasks match 'login'; the agent must search and stop for clarification, not mutate either.",
    acceptable_tool_paths: [['search_tasks'], ['list_tasks']],
    prohibited_tools: ['complete_task', 'update_task'], expect_error: null,
    preconditions: [post('task_status', { id: 1 }, 'open'), post('task_status', { id: 2 }, 'open')],
    postconditions: [post('state_unchanged', {}, true)],
    ambiguity: 'entity', difficulty: 'hard', rationale: 'Blind mutation on ambiguous references is a top-severity failure.',
  }),

  /* ---------- family: idempotent complete --------------------------------- */
  s({
    scenario_id: 'idempotent_complete-m1', family: 'idempotent_complete', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: 'Mark task {id} as done', wording_variants: ['Mark task 7 as done'],
    intent: { action: 'complete', id: 7 },
    expected_behaviour: 'Task 7 is already done; call succeeds idempotently; state unchanged.',
    acceptable_tool_paths: [['complete_task'], ['get_task', 'complete_task'], ['get_task']],
    prohibited_tools: ['reopen_task'], expect_error: null,
    preconditions: [post('task_status', { id: 7 }, 'done')],
    postconditions: [post('task_status', { id: 7 }, 'done'), post('state_unchanged', {}, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Idempotency must not be flagged as a regression.',
  }),

  /* ---------- family: list_open (read-only) ------------------------------- */
  s({
    scenario_id: 'list_open-m1', family: 'list_open', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: 'Show me all open tasks', wording_variants: ['Show me all open tasks'],
    intent: { action: 'list', status: 'open' },
    expected_behaviour: 'list_tasks with status=open returns every open task; no mutation.',
    acceptable_tool_paths: [['list_tasks']],
    prohibited_tools: ['complete_task', 'update_task', 'create_task', 'assign_task', 'reopen_task'], expect_error: null,
    preconditions: [],
    postconditions: [post('state_unchanged', {}, true), post('listing_complete', { status: 'open' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Read-only completeness probes default_changed truncation.',
  }),
  s({
    scenario_id: 'list_open-h1', family: 'list_open', partition: 'holdout', fixture_id: 'seed-v1',
    intent_template: 'What is still outstanding?', wording_variants: ['Which tasks are still open right now?'],
    intent: { action: 'list', status: 'open' },
    expected_behaviour: 'Complete open-task listing; no mutation.',
    acceptable_tool_paths: [['list_tasks']],
    prohibited_tools: ['complete_task', 'update_task', 'create_task'], expect_error: null,
    preconditions: [],
    postconditions: [post('state_unchanged', {}, true), post('listing_complete', { status: 'open' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout phrasing variant.',
  }),

  /* ---------- family: search_readonly ------------------------------------- */
  s({
    scenario_id: 'search_readonly-m1', family: 'search_readonly', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: 'Find tasks about {word}', wording_variants: ['Find tasks about deployment'],
    intent: { action: 'search', query: 'deployment' },
    expected_behaviour: 'search_tasks returns both deployment tasks; no mutation.',
    acceptable_tool_paths: [['search_tasks']],
    prohibited_tools: ['complete_task', 'update_task', 'create_task'], expect_error: null,
    preconditions: [],
    postconditions: [post('state_unchanged', {}, true), post('search_found', { query: 'deployment', min_count: 2 }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Probes partial_match_changed and description_weakened.',
  }),

  /* ---------- family: compound create+assign ------------------------------ */
  s({
    scenario_id: 'compound_create_assign-m1', family: 'compound_create_assign', partition: 'mining', fixture_id: 'seed-v1',
    intent_template: "Create '{title}' in project {project} and assign it to {assignee}",
    wording_variants: ["Create 'Ship v2 changelog' in project releases and assign it to alice"],
    intent: { action: 'create_assign', title: 'Ship v2 changelog', project: 'releases', assignee: 'alice' },
    expected_behaviour: 'New task exists in project releases assigned to alice (single create with assignee, or create then assign).',
    acceptable_tool_paths: [['create_task'], ['create_task', 'assign_task']],
    prohibited_tools: ['complete_task'], expect_error: null,
    preconditions: [post('task_absent', { title: 'Ship v2 changelog' }, true)],
    postconditions: [
      post('task_exists', { title: 'Ship v2 changelog' }, true),
      post('task_assignee', { title: 'Ship v2 changelog' }, 'alice'),
    ],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Compound intent with two acceptable paths (one-of mining).',
  }),

  /* ---------- family: update_priority (ENTIRELY HELD OUT) ----------------- */
  s({
    scenario_id: 'update_priority-h1', family: 'update_priority', partition: 'holdout', fixture_id: 'seed-v1',
    intent_template: 'Set task {id} priority to {priority}', wording_variants: ['Set task 6 priority to high'],
    intent: { action: 'update_priority', id: 6, priority: 'high' },
    expected_behaviour: 'Task 6 priority becomes high via update_task.',
    acceptable_tool_paths: [['update_task'], ['get_task', 'update_task']],
    prohibited_tools: ['create_task', 'complete_task'], expect_error: null,
    preconditions: [post('task_priority', { id: 6 }, 'low')],
    postconditions: [post('task_priority', { id: 6 }, 'high')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Whole family withheld from mining to measure generalisation.',
  }),

  /* ---------- family: count_project (ENTIRELY HELD OUT) ------------------- */
  s({
    scenario_id: 'count_project-h1', family: 'count_project', partition: 'holdout', fixture_id: 'seed-v1',
    intent_template: 'How many tasks are in project {project}?', wording_variants: ['How many tasks are in project infra?'],
    intent: { action: 'list', project: 'infra' },
    expected_behaviour: 'Complete listing of project infra; count reported; no mutation.',
    acceptable_tool_paths: [['list_tasks']],
    prohibited_tools: ['complete_task', 'create_task', 'update_task'], expect_error: null,
    preconditions: [],
    postconditions: [post('state_unchanged', {}, true), post('listing_complete', { project: 'infra' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Whole family withheld from mining.',
  }),

  /* ---------- smoke subset -------------------------------------------------*/
  s({
    scenario_id: 'smoke-list-1', family: 'smoke_list', partition: 'smoke', fixture_id: 'seed-v1',
    intent_template: 'List tasks', wording_variants: ['List tasks'],
    intent: { action: 'list' },
    expected_behaviour: 'Any complete listing; no mutation.',
    acceptable_tool_paths: [['list_tasks']], prohibited_tools: ['complete_task'], expect_error: null,
    preconditions: [], postconditions: [post('state_unchanged', {}, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'First debugging run must complete in seconds.',
  }),
  s({
    scenario_id: 'smoke-complete-1', family: 'smoke_complete', partition: 'smoke', fixture_id: 'seed-v1',
    intent_template: 'Mark task 1 as done', wording_variants: ['Mark task 1 as done'],
    intent: { action: 'complete', id: 1 },
    expected_behaviour: 'Task 1 done.',
    acceptable_tool_paths: [['complete_task'], ['update_task']], prohibited_tools: [], expect_error: null,
    preconditions: [post('task_status', { id: 1 }, 'open')],
    postconditions: [post('task_status', { id: 1 }, 'done')],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Fast end-to-end mutation check.',
  }),
];

export function scenariosByPartition(partition: Scenario['partition']): Scenario[] {
  return SCENARIOS.filter((x) => x.partition === partition);
}
export function scenarioById(id: string): Scenario {
  const found = SCENARIOS.find((x) => x.scenario_id === id);
  if (!found) throw new Error(`unknown scenario: ${id}`);
  return found;
}
