import type { IssueSeed } from './server.js';

/**
 * Deterministic issue-tracker fixture (Phase 5, docs/28).
 *
 * Defined here as data so it is reviewable in one place and materialised into a
 * FRESH in-memory server per recording session (recordIssueSession builds a new
 * IssueTrackerServer from this seed every time). The server deep-copies label /
 * comment arrays on load, so this constant is never mutated and every scenario
 * starts from identical state. All content is tiny text so state snapshots stay
 * cheap and reproducible.
 *
 * Deterministic search behaviour the scenarios rely on (title substring, case-insensitive):
 *   - 'login'      → ISSUE-1, ISSUE-2   (two matches — the ambiguous reference)
 *   - 'dark'       → ISSUE-3            (unique)
 *   - 'onboarding' → ISSUE-5            (unique, open — safe to close)
 *   - 'readme'     → ISSUE-4            (unique, closed)
 * Closed issues at seed time: ISSUE-4, ISSUE-6 (targets for reopen / already-closed).
 */
export const ISSUE_FIXTURE_ID = 'issue-tracker-v1';

export const ISSUE_BASE_SEED: IssueSeed[] = [
  { title: 'Login button is broken', body: 'Clicking the login button does nothing on mobile.', status: 'open' },
  { title: 'Login page returns 500', body: 'The server errors out after submitting valid credentials.', status: 'open' },
  { title: 'Add dark mode support', body: 'Users have asked for a dark theme option.', status: 'open' },
  { title: 'Fix typo in README', body: 'There is a small typo in the intro paragraph.', status: 'closed', assignee: 'bob' },
  { title: 'Update onboarding docs', body: 'The onboarding docs are stale and need a refresh.', status: 'open' },
  { title: 'Remove deprecated API', body: 'The old v1 API endpoints should be removed.', status: 'closed', assignee: 'alice' },
];

/** A fresh copy of the base seed (defensive; the server already copies on load). */
export function issueSeed(): IssueSeed[] {
  return ISSUE_BASE_SEED.map((s) => ({ ...s }));
}
