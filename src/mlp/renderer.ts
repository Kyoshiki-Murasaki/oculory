import type { AdapterAssertionResult, AdapterJson } from './adapters/types.js';
import type { ExtractedClaim } from './claim.js';
import type { ToolWitness } from './record.js';

export interface ReplayProfileResult {
  profile: string;
  status: 'PASS' | 'FAIL' | 'INFRA';
  passed: number;
  requested: number;
  threshold: number;
}

export interface ViolationRenderModel {
  assertion_id: string;
  claim: ExtractedClaim;
  tool: ToolWitness;
  failures: Array<{
    selector: Record<string, AdapterJson>;
    result: AdapterAssertionResult;
    description: string;
  }>;
  profiles: ReplayProfileResult[];
  run_id: string;
}

export interface RenderOptions {
  color?: boolean;
  width?: number;
}

const MAX_RENDERED_FAILURES = 4;

export function renderViolation(model: ViolationRenderModel, options: RenderOptions = {}): string {
  const width = Math.max(48, Math.min(options.width ?? 80, 120));
  const color = options.color === true && process.env.NO_COLOR === undefined;
  const red = (value: string): string => color ? `\u001b[31m${value}\u001b[0m` : value;
  const lines: string[] = [red(`✗ CONTRACT VIOLATED: ${model.assertion_id}`), ''];
  const claim = model.claim.status === 'available' ? quote(model.claim.text!) : 'claim unavailable';
  appendLabeled(lines, 'Agent said:', claim, width);
  appendLabeled(lines, 'Tool returned:', toolText(model.tool), width);
  const visibleFailures = model.failures.slice(0, MAX_RENDERED_FAILURES);
  const actual = visibleFailures.length > 0
    ? visibleFailures.flatMap(actualStateLines)
    : ['observed state unavailable'];
  const omitted = model.failures.length - visibleFailures.length;
  if (omitted > 0) actual.push(`${omitted} additional observed ${omitted === 1 ? 'failure' : 'failures'} omitted; see JSON report`);
  appendLabeled(lines, 'Actual state:', actual, width);
  lines.push('', '  Replay results:');
  for (const profile of [...model.profiles].sort((left, right) => left.profile.localeCompare(right.profile))) {
    const label = profile.profile.padEnd(19);
    const status = profile.status.padEnd(5);
    const detail = profile.status === 'PASS'
      ? `(${profile.passed}/${profile.requested} runs)`
      : profile.status === 'FAIL'
        ? `(${profile.passed}/${profile.requested} runs passed; threshold ${profile.threshold})`
        : `(${profile.passed}/${profile.requested} behavioral passes; threshold ${profile.threshold})`;
    lines.push(...wrap(`    ${label}${status} ${detail}`, width, '    '));
  }
  lines.push('', `  → Diff: oculory show ${model.run_id} --diff`);
  return `${lines.join('\n')}\n`;
}

export function renderReplaySummary(input: {
  requested: number;
  completed: number;
  passed: number;
  failed: number;
  infrastructure_failed: number;
  indeterminate: number;
  threshold: number;
  status: 'PASS' | 'FAIL' | 'INFRA';
}): string {
  return [
    `Replay ${input.status}`,
    `  Requested runs:        ${input.requested}`,
    `  Completed runs:        ${input.completed}`,
    `  Behaviorally passed:   ${input.passed}`,
    `  Behaviorally failed:   ${input.failed}`,
    `  Infrastructure-failed: ${input.infrastructure_failed}`,
    `  Indeterminate:         ${input.indeterminate}`,
    `  Required threshold:    ${input.threshold}`,
  ].join('\n') + '\n';
}

function actualStateLines(failure: ViolationRenderModel['failures'][number]): string[] {
  const kind = typeof failure.selector.kind === 'string' ? failure.selector.kind : '';
  const expected = failure.result.expected;
  const observed = failure.result.observed;
  if (kind === 'branch_base') return [`branch created from wrong base (${plain(observed)}, expected ${plain(expected)})`];
  if (kind === 'staged_files' && Array.isArray(observed)) {
    return [`${observed.length} ${observed.length === 1 ? 'file' : 'files'} staged, never committed`];
  }
  if (kind === 'clean_tree' && observed === false) return ['working tree is not clean'];
  if (kind === 'row_count') return [`Postgres row count is ${plain(observed)}, expected ${plain(expected)}`];
  if (kind.includes('label')) return [`GitHub labels are ${plain(observed)}, expected ${plain(expected)}`];
  return [failure.description];
}

function appendLabeled(lines: string[], label: string, value: string | string[], width: number): void {
  const prefix = `  ${label.padEnd(17)}`;
  const continuation = ' '.repeat(prefix.length);
  const values = Array.isArray(value) ? value : [value];
  values.forEach((entry, index) => {
    const wrapped = wrap(`${index === 0 ? prefix : continuation}${entry}`, width, continuation);
    lines.push(...wrapped);
  });
}

function wrap(value: string, width: number, continuation: string): string[] {
  const output: string[] = [];
  let remaining = value;
  let first = true;
  while (true) {
    const prefix = first ? '' : continuation;
    const available = width - prefix.length;
    if (remaining.length <= available) {
      output.push(`${prefix}${remaining}`);
      return output;
    }
    const boundary = remaining.slice(0, available + 1).lastIndexOf(' ');
    const at = boundary > 0 ? boundary : available;
    output.push(`${prefix}${remaining.slice(0, at).trimEnd()}`);
    remaining = remaining.slice(at).trimStart();
    first = false;
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function toolText(tool: ToolWitness): string {
  if (tool.status === 'unavailable' || tool.status === 'ambiguous') return 'no uniquely attributable tool result';
  return tool.detail;
}

function plain(value: AdapterJson | null): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
