import type { Scenario, StateCondition } from '../../schema/types.js';
import { SCHEMA_VERSION } from '../../schema/types.js';
import { FS_FIXTURE_ID } from './fixtures.js';

/**
 * Filesystem scenario catalogue (Phase 4, docs/26). Same `Scenario` shape as
 * the task catalogue (src/runner/catalogue.ts) so the whole pipeline —
 * normalize, mine, review, approve, suite, replay, compare — is reused
 * unchanged. Only the `intent`, postcondition kinds, and tool paths are
 * filesystem-specific.
 *
 * Partitions follow the same leakage-resistant rule: the miner only ever sees
 * `mining` + `adversarial` traces; `holdout` is materially re-worded variants
 * (different paths/content) to measure generalisation and is never mined.
 */
const pc = (kind: string, selector: Record<string, unknown>, expected: unknown): StateCondition =>
  ({ kind, selector: selector as never, expected: expected as never });

function s(x: Omit<Scenario, 'schema_version' | 'fixture_id'>): Scenario {
  return { schema_version: SCHEMA_VERSION, fixture_id: FS_FIXTURE_ID, ...x };
}

export const FS_SCENARIOS: Scenario[] = [
  /* -------------------------- fs_read_file (read-only) -------------------- */
  s({
    scenario_id: 'fs-read-m1', family: 'fs_read_file', partition: 'mining',
    intent_template: 'Read the file {path}', wording_variants: ['Read the file notes/todo.txt'],
    intent: { action: 'read', path: 'notes/todo.txt' },
    expected_behaviour: 'read_file returns the exact contents of notes/todo.txt; no mutation.',
    acceptable_tool_paths: [['read_file']],
    prohibited_tools: ['write_file', 'append_file', 'delete_file', 'move_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'notes/todo.txt' }, true)],
    postconditions: [pc('state_unchanged', {}, true), pc('read_consistent', { path: 'notes/todo.txt' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Canonical read: state unchanged + returned content matches disk.',
  }),
  s({
    scenario_id: 'fs-read-h1', family: 'fs_read_file', partition: 'holdout',
    intent_template: 'Show me what is in {path}', wording_variants: ['Show me what is in reports/q1.txt'],
    intent: { action: 'read', path: 'reports/q1.txt' },
    expected_behaviour: 'read_file returns the exact contents of reports/q1.txt; no mutation.',
    acceptable_tool_paths: [['read_file']],
    prohibited_tools: ['write_file', 'delete_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'reports/q1.txt' }, true)],
    postconditions: [pc('state_unchanged', {}, true), pc('read_consistent', { path: 'reports/q1.txt' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout read variant (different path + phrasing).',
  }),

  /* -------------------------- fs_write_file ------------------------------- */
  s({
    scenario_id: 'fs-write-m1', family: 'fs_write_file', partition: 'mining',
    intent_template: "Create the file {path} with exact content '{content}'",
    wording_variants: ["Create the file notes/meeting.txt with exact content 'Alice approved the deployment checklist.'"],
    intent: { action: 'write', path: 'notes/meeting.txt', content: 'Alice approved the deployment checklist.' },
    expected_behaviour: 'write_file creates notes/meeting.txt whose content equals the requested string.',
    acceptable_tool_paths: [['write_file'], ['stat_path', 'write_file']],
    prohibited_tools: ['delete_file', 'move_file'], expect_error: null,
    preconditions: [pc('file_absent', { path: 'notes/meeting.txt' }, true)],
    postconditions: [
      pc('file_exists', { path: 'notes/meeting.txt' }, true),
      pc('content_equals', { path: 'notes/meeting.txt' }, 'Alice approved the deployment checklist.'),
    ],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Write postcondition is exact content — silent-noop writes are caught.',
  }),
  s({
    scenario_id: 'fs-write-m2', family: 'fs_write_file', partition: 'mining',
    intent_template: "Write '{content}' into {path}",
    wording_variants: ["Write 'All quarters on track.' into reports/summary.txt"],
    intent: { action: 'write', path: 'reports/summary.txt', content: 'All quarters on track.' },
    expected_behaviour: 'write_file creates reports/summary.txt with the requested content.',
    acceptable_tool_paths: [['write_file'], ['stat_path', 'write_file']],
    prohibited_tools: ['delete_file'], expect_error: null,
    preconditions: [pc('file_absent', { path: 'reports/summary.txt' }, true)],
    postconditions: [
      pc('file_exists', { path: 'reports/summary.txt' }, true),
      pc('content_equals', { path: 'reports/summary.txt' }, 'All quarters on track.'),
    ],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Second write scenario so the miner does not bind to one path.',
  }),
  s({
    scenario_id: 'fs-write-h1', family: 'fs_write_file', partition: 'holdout',
    intent_template: "Save a new file {path} containing '{content}'",
    wording_variants: ["Save a new file notes/plan.txt containing 'Kickoff on Monday.'"],
    intent: { action: 'write', path: 'notes/plan.txt', content: 'Kickoff on Monday.' },
    expected_behaviour: 'write_file creates notes/plan.txt with the requested content.',
    acceptable_tool_paths: [['write_file'], ['stat_path', 'write_file']],
    prohibited_tools: ['delete_file'], expect_error: null,
    preconditions: [pc('file_absent', { path: 'notes/plan.txt' }, true)],
    postconditions: [
      pc('file_exists', { path: 'notes/plan.txt' }, true),
      pc('content_equals', { path: 'notes/plan.txt' }, 'Kickoff on Monday.'),
    ],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout write variant.',
  }),

  /* -------------------------- fs_append_file ------------------------------ */
  s({
    scenario_id: 'fs-append-m1', family: 'fs_append_file', partition: 'mining',
    intent_template: "Append the line '{content}' to {path}",
    wording_variants: ["Append the line 'Follow up tomorrow.' to notes/todo.txt"],
    intent: { action: 'append', path: 'notes/todo.txt', content: 'Follow up tomorrow.' },
    expected_behaviour: 'append_file adds the line while preserving existing content of notes/todo.txt.',
    acceptable_tool_paths: [['append_file'], ['read_file', 'append_file']],
    prohibited_tools: ['delete_file', 'move_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'notes/todo.txt' }, true)],
    postconditions: [
      pc('content_contains', { path: 'notes/todo.txt' }, 'Buy milk'),
      pc('content_contains', { path: 'notes/todo.txt' }, 'Follow up tomorrow.'),
    ],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Append must preserve prior content — overwrite-instead is caught.',
  }),
  s({
    scenario_id: 'fs-append-h1', family: 'fs_append_file', partition: 'holdout',
    intent_template: "Add '{content}' to the end of {path}",
    wording_variants: ["Add 'Explore vector search.' to the end of notes/ideas.txt"],
    intent: { action: 'append', path: 'notes/ideas.txt', content: 'Explore vector search.' },
    expected_behaviour: 'append_file adds the line preserving existing content of notes/ideas.txt.',
    acceptable_tool_paths: [['append_file'], ['read_file', 'append_file']],
    prohibited_tools: ['delete_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'notes/ideas.txt' }, true)],
    postconditions: [
      pc('content_contains', { path: 'notes/ideas.txt' }, 'caching layer'),
      pc('content_contains', { path: 'notes/ideas.txt' }, 'Explore vector search.'),
    ],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Holdout append variant.',
  }),

  /* -------------------------- fs_list_dir (read-only) --------------------- */
  s({
    scenario_id: 'fs-list-m1', family: 'fs_list_dir', partition: 'mining',
    intent_template: 'List the files in the {path} directory', wording_variants: ['List the files in the notes/ directory'],
    intent: { action: 'list', path: 'notes' },
    expected_behaviour: 'list_dir returns every entry of notes/; no mutation.',
    acceptable_tool_paths: [['list_dir']],
    prohibited_tools: ['write_file', 'delete_file'], expect_error: null,
    preconditions: [],
    postconditions: [pc('state_unchanged', {}, true), pc('list_consistent', { path: 'notes' }, true), pc('dir_contains', { path: 'notes', name: 'todo.txt' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Read-only listing completeness.',
  }),
  s({
    scenario_id: 'fs-list-h1', family: 'fs_list_dir', partition: 'holdout',
    intent_template: 'What files are under {path}?', wording_variants: ['What files are under reports/?'],
    intent: { action: 'list', path: 'reports' },
    expected_behaviour: 'list_dir returns every entry of reports/; no mutation.',
    acceptable_tool_paths: [['list_dir']],
    prohibited_tools: ['write_file', 'delete_file'], expect_error: null,
    preconditions: [],
    postconditions: [pc('state_unchanged', {}, true), pc('list_consistent', { path: 'reports' }, true), pc('dir_contains', { path: 'reports', name: 'q1.txt' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout listing variant.',
  }),

  /* -------------------------- fs_stat_path (read-only) -------------------- */
  s({
    scenario_id: 'fs-stat-m1', family: 'fs_stat_path', partition: 'mining',
    intent_template: 'Does the file {path} exist and how big is it?', wording_variants: ['Does the file drafts/plan.md exist and how big is it?'],
    intent: { action: 'stat', path: 'drafts/plan.md' },
    expected_behaviour: 'stat_path reports drafts/plan.md exists as a file; no mutation.',
    acceptable_tool_paths: [['stat_path']],
    prohibited_tools: ['write_file', 'delete_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'drafts/plan.md' }, true)],
    postconditions: [pc('state_unchanged', {}, true), pc('stat_reports', { path: 'drafts/plan.md', exists: true, type: 'file' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Metadata read; no state change.',
  }),

  /* -------------------------- fs_move_file -------------------------------- */
  s({
    scenario_id: 'fs-move-m1', family: 'fs_move_file', partition: 'mining',
    intent_template: 'Move {from} to {to}', wording_variants: ['Move drafts/plan.md to archive/plan.md'],
    intent: { action: 'move', from: 'drafts/plan.md', to: 'archive/plan.md' },
    expected_behaviour: 'move_file relocates the file: source gone, destination present with preserved content.',
    acceptable_tool_paths: [['move_file'], ['stat_path', 'move_file']],
    prohibited_tools: ['delete_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'drafts/plan.md' }, true)],
    postconditions: [
      pc('file_absent', { path: 'drafts/plan.md' }, true),
      pc('file_exists', { path: 'archive/plan.md' }, true),
      pc('content_equals', { path: 'archive/plan.md' }, '# Project plan\nInitial draft content.\n'),
    ],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Move must remove the source — copy-instead is caught.',
  }),
  s({
    scenario_id: 'fs-move-h1', family: 'fs_move_file', partition: 'holdout',
    intent_template: 'Relocate {from} to {to}', wording_variants: ['Relocate reports/q1.txt to archive/q1.txt'],
    intent: { action: 'move', from: 'reports/q1.txt', to: 'archive/q1.txt' },
    expected_behaviour: 'move_file relocates reports/q1.txt to archive/q1.txt; source removed.',
    acceptable_tool_paths: [['move_file'], ['stat_path', 'move_file']],
    prohibited_tools: ['delete_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'reports/q1.txt' }, true)],
    postconditions: [
      pc('file_absent', { path: 'reports/q1.txt' }, true),
      pc('file_exists', { path: 'archive/q1.txt' }, true),
      pc('content_equals', { path: 'archive/q1.txt' }, 'Q1 revenue: 100\n'),
    ],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Holdout move variant.',
  }),

  /* -------------------------- fs_copy_file -------------------------------- */
  s({
    scenario_id: 'fs-copy-m1', family: 'fs_copy_file', partition: 'mining',
    intent_template: 'Copy {from} to {to}', wording_variants: ['Copy notes/todo.txt to archive/todo-backup.txt'],
    intent: { action: 'copy', from: 'notes/todo.txt', to: 'archive/todo-backup.txt' },
    expected_behaviour: 'copy_file duplicates the file: both paths present with equal content.',
    acceptable_tool_paths: [['copy_file'], ['stat_path', 'copy_file']],
    prohibited_tools: ['delete_file', 'move_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'notes/todo.txt' }, true)],
    postconditions: [
      pc('file_exists', { path: 'notes/todo.txt' }, true),
      pc('file_exists', { path: 'archive/todo-backup.txt' }, true),
      pc('content_equals', { path: 'archive/todo-backup.txt' }, 'Buy milk\nWrite the weekly report\n'),
    ],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Copy must preserve the source and duplicate content.',
  }),
  s({
    scenario_id: 'fs-copy-h1', family: 'fs_copy_file', partition: 'holdout',
    intent_template: 'Make a backup of {from} at {to}', wording_variants: ['Make a backup of reports/q2.txt at archive/q2-backup.txt'],
    intent: { action: 'copy', from: 'reports/q2.txt', to: 'archive/q2-backup.txt' },
    expected_behaviour: 'copy_file duplicates reports/q2.txt to archive/q2-backup.txt.',
    acceptable_tool_paths: [['copy_file'], ['stat_path', 'copy_file']],
    prohibited_tools: ['delete_file', 'move_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'reports/q2.txt' }, true)],
    postconditions: [
      pc('file_exists', { path: 'reports/q2.txt' }, true),
      pc('file_exists', { path: 'archive/q2-backup.txt' }, true),
      pc('content_equals', { path: 'archive/q2-backup.txt' }, 'Q2 revenue: 120\n'),
    ],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Holdout copy variant.',
  }),

  /* -------------------------- fs_delete_file ------------------------------ */
  s({
    scenario_id: 'fs-delete-m1', family: 'fs_delete_file', partition: 'mining',
    intent_template: 'Delete {path}', wording_variants: ['Delete tmp/old.txt'],
    intent: { action: 'delete', path: 'tmp/old.txt' },
    expected_behaviour: 'delete_file removes tmp/old.txt and only that file.',
    acceptable_tool_paths: [['delete_file'], ['stat_path', 'delete_file']],
    prohibited_tools: ['write_file', 'move_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'tmp/old.txt' }, true)],
    postconditions: [pc('file_absent', { path: 'tmp/old.txt' }, true), pc('file_exists', { path: 'tmp/keep.txt' }, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Delete must remove only the requested file — wrong-file deletes are caught.',
  }),
  s({
    scenario_id: 'fs-delete-h1', family: 'fs_delete_file', partition: 'holdout',
    intent_template: 'Remove the file {path}', wording_variants: ['Remove the file tmp/keep.txt'],
    intent: { action: 'delete', path: 'tmp/keep.txt' },
    expected_behaviour: 'delete_file removes tmp/keep.txt and only that file.',
    acceptable_tool_paths: [['delete_file'], ['stat_path', 'delete_file']],
    prohibited_tools: ['write_file', 'move_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'tmp/keep.txt' }, true)],
    postconditions: [pc('file_absent', { path: 'tmp/keep.txt' }, true), pc('file_exists', { path: 'tmp/old.txt' }, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Holdout delete variant.',
  }),

  /* -------------------------- fs_search_file (read-only) ------------------ */
  s({
    scenario_id: 'fs-search-m1', family: 'fs_search_file', partition: 'mining',
    intent_template: "Search for files whose name contains '{query}'", wording_variants: ["Search for files whose name contains 'plan'"],
    intent: { action: 'search', query: 'plan' },
    expected_behaviour: 'search_files returns every file whose name contains "plan"; no mutation.',
    acceptable_tool_paths: [['search_files']],
    prohibited_tools: ['write_file', 'delete_file'], expect_error: null,
    preconditions: [],
    postconditions: [pc('state_unchanged', {}, true), pc('search_consistent', { query: 'plan', min_count: 2 }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Search completeness — partial-result regressions are caught.',
  }),
  s({
    scenario_id: 'fs-search-h1', family: 'fs_search_file', partition: 'holdout',
    intent_template: "Find files matching '{query}'", wording_variants: ["Find files matching 'q'"],
    intent: { action: 'search', query: 'q' },
    expected_behaviour: 'search_files returns every file whose name contains "q"; no mutation.',
    acceptable_tool_paths: [['search_files']],
    prohibited_tools: ['write_file', 'delete_file'], expect_error: null,
    preconditions: [],
    postconditions: [pc('state_unchanged', {}, true), pc('search_consistent', { query: 'q', min_count: 2 }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Holdout search variant.',
  }),

  /* -------------------------- fs_overwrite_existing ----------------------- */
  s({
    scenario_id: 'fs-overwrite-m1', family: 'fs_overwrite_existing', partition: 'mining',
    intent_template: "Overwrite {path} with '{content}'", wording_variants: ["Overwrite reports/q1.txt with 'Q1 revenue: 999 (revised)'"],
    intent: { action: 'write', path: 'reports/q1.txt', content: 'Q1 revenue: 999 (revised)' },
    expected_behaviour: 'write_file replaces the existing reports/q1.txt content with the new content.',
    acceptable_tool_paths: [['write_file'], ['read_file', 'write_file']],
    prohibited_tools: ['delete_file', 'move_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'reports/q1.txt' }, true)],
    postconditions: [
      pc('file_exists', { path: 'reports/q1.txt' }, true),
      pc('content_equals', { path: 'reports/q1.txt' }, 'Q1 revenue: 999 (revised)'),
    ],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Overwrite must replace content — refuse-to-overwrite regressions are caught.',
  }),

  /* -------------------------- fs_missing_file (adversarial) --------------- */
  s({
    scenario_id: 'fs-missing-a1', family: 'fs_missing_file', partition: 'adversarial',
    intent_template: 'Read {path}', wording_variants: ['Read missing/does-not-exist.txt'],
    intent: { action: 'read', path: 'missing/does-not-exist.txt' },
    expected_behaviour: 'Server rejects with NOT_FOUND; no state change; the agent must not fabricate content.',
    acceptable_tool_paths: [['read_file'], ['stat_path'], ['stat_path', 'read_file']],
    prohibited_tools: ['write_file', 'delete_file'], expect_error: 'NOT_FOUND',
    preconditions: [pc('file_absent', { path: 'missing/does-not-exist.txt' }, true)],
    postconditions: [pc('state_unchanged', {}, true)],
    ambiguity: 'none', difficulty: 'medium', rationale: 'Valid rejection: the correct outcome is a structured NOT_FOUND error.',
  }),

  /* -------------------------- fs_path_traversal (adversarial) ------------- */
  s({
    scenario_id: 'fs-traversal-a1', family: 'fs_path_traversal', partition: 'adversarial',
    intent_template: 'Read {path}', wording_variants: ['Read ../secrets.txt'],
    intent: { action: 'read', path: '../secrets.txt' },
    expected_behaviour: 'Server rejects the traversal with PATH_TRAVERSAL; no state change; nothing outside the sandbox is read.',
    acceptable_tool_paths: [['read_file']],
    prohibited_tools: ['write_file', 'delete_file'], expect_error: 'PATH_TRAVERSAL',
    preconditions: [],
    postconditions: [pc('state_unchanged', {}, true), pc('path_inside_sandbox', {}, true)],
    ambiguity: 'none', difficulty: 'hard', rationale: 'Security: `../` escape must be rejected, not served.',
  }),

  /* -------------------------- fs_ambiguous_search (adversarial) ----------- */
  s({
    scenario_id: 'fs-ambiguous-a1', family: 'fs_ambiguous_search', partition: 'adversarial',
    intent_template: "Update the file named '{query}'", wording_variants: ["Update the file named 'plan'"],
    intent: { action: 'search_ambiguous', query: 'plan' },
    expected_behaviour: "Multiple files match 'plan'; the agent must search and stop for clarification, writing to none of them.",
    acceptable_tool_paths: [['search_files'], ['list_dir']],
    prohibited_tools: ['write_file', 'append_file', 'delete_file', 'move_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'drafts/plan.md' }, true), pc('file_exists', { path: 'drafts/plan-archive.md' }, true)],
    postconditions: [pc('state_unchanged', {}, true)],
    ambiguity: 'entity', difficulty: 'hard', rationale: 'Blind writes on ambiguous references are a top-severity failure.',
  }),

  /* -------------------------- smoke --------------------------------------- */
  s({
    scenario_id: 'fs-smoke-list-root', family: 'fs_smoke_list', partition: 'smoke',
    intent_template: 'List the files in the project notes directory', wording_variants: ['List the files in the root directory .'],
    intent: { action: 'list', path: '.' },
    expected_behaviour: 'Any complete listing of the sandbox root; no mutation.',
    acceptable_tool_paths: [['list_dir']],
    prohibited_tools: ['write_file', 'delete_file'], expect_error: null,
    preconditions: [], postconditions: [pc('state_unchanged', {}, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'First debugging run must complete in milliseconds.',
  }),
  s({
    scenario_id: 'fs-smoke-read', family: 'fs_smoke_read', partition: 'smoke',
    intent_template: 'Read {path}', wording_variants: ['Read notes/todo.txt'],
    intent: { action: 'read', path: 'notes/todo.txt' },
    expected_behaviour: 'read_file returns notes/todo.txt content; no mutation.',
    acceptable_tool_paths: [['read_file']],
    prohibited_tools: ['write_file', 'delete_file'], expect_error: null,
    preconditions: [pc('file_exists', { path: 'notes/todo.txt' }, true)],
    postconditions: [pc('state_unchanged', {}, true), pc('read_consistent', { path: 'notes/todo.txt' }, true)],
    ambiguity: 'none', difficulty: 'easy', rationale: 'Fast end-to-end read check.',
  }),
];

export function fsScenariosByPartition(partition: Scenario['partition']): Scenario[] {
  return FS_SCENARIOS.filter((x) => x.partition === partition);
}

export function fsScenarioById(id: string): Scenario {
  const found = FS_SCENARIOS.find((x) => x.scenario_id === id);
  if (!found) throw new Error(`unknown filesystem scenario: ${id}`);
  return found;
}
