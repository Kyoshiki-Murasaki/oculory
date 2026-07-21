import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderViolation } from './renderer.js';
import { violationModelFromSavedRun, type ReplayAssertionEvaluation } from './replay.js';
import type { PublicRunSummary } from './record.js';
import { PublicRunStore } from './run-store.js';

export interface ShowRunOptions {
  store?: PublicRunStore;
  diff?: boolean;
  json?: boolean;
  color?: boolean;
  width?: number;
}

export interface SavedRunView {
  summary: PublicRunSummary;
  diffs: Record<string, unknown>;
  assertions: ReplayAssertionEvaluation[] | null;
  replay: { profiles: Array<{ profile: string; status: 'PASS' | 'FAIL' | 'INFRA'; passed: number; requested: number; threshold: number }> } | null;
}

export function showRun(runId: string, options: ShowRunOptions = {}): { view: SavedRunView; output: string } {
  const store = options.store ?? new PublicRunStore();
  store.verify(runId);
  const root = store.runPath(runId);
  const summary = store.readJson<PublicRunSummary>(runId, 'summary.json');
  const diffs = Object.fromEntries(
    store.listJsonFiles(runId, 'diffs').map((name) => [name.slice(0, -5), store.readJson(runId, `diffs/${name}`)]),
  );
  const assertions = existsSync(join(root, 'assertion-matrix.json'))
    ? store.readJson<ReplayAssertionEvaluation[]>(runId, 'assertion-matrix.json')
    : null;
  const replay = existsSync(join(root, 'replay-context.json'))
    ? store.readJson<SavedRunView['replay']>(runId, 'replay-context.json')
    : null;
  const view: SavedRunView = { summary, diffs, assertions, replay };
  if (options.json === true) return { view, output: `${JSON.stringify(view, null, 2)}\n` };
  if (options.diff === true && summary.classification === 'behaviorally-violated' && assertions !== null && replay !== null) {
    return {
      view,
      output: renderViolation(violationModelFromSavedRun(summary, assertions, replay), {
        color: options.color,
        width: options.width,
      }),
    };
  }
  const lines = [
    `${summary.run_id}  ${summary.classification}`,
    `  Task:           ${summary.task_id}`,
    `  Profile:        ${summary.profile}`,
    `  Agent claim:    ${summary.agent_claim.status === 'available' ? JSON.stringify(summary.agent_claim.text) : 'claim unavailable'}`,
    `  Tool result:    ${summary.tool_result.status === 'success' || summary.tool_result.status === 'error' ? summary.tool_result.detail : 'no uniquely attributable tool result'}`,
    `  Observed state: ${summary.observed_state.status}`,
  ];
  if (options.diff === true) {
    for (const [target, value] of Object.entries(diffs).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`  ${target}: ${boundedJson(value)}`);
    }
  }
  if (summary.infrastructure_error !== null) lines.push(`  Infrastructure:  ${summary.infrastructure_error}`);
  return { view, output: `${lines.join('\n')}\n` };
}

function boundedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= 500 ? serialized : `${serialized.slice(0, 497)}...`;
}
