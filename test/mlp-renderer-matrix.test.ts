import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AdapterAssertionResult, AdapterJson } from '../src/mlp/adapters/types.js';
import {
  renderReplaySummary,
  renderViolation,
  type ReplayProfileResult,
  type ViolationRenderModel,
} from '../src/mlp/renderer.js';
import {
  violationModelFromSavedRun,
  type ReplayAssertionEvaluation,
} from '../src/mlp/replay.js';
import type { PublicRunSummary } from '../src/mlp/record.js';
import { PublicRunStore } from '../src/mlp/run-store.js';
import { showRun } from '../src/mlp/show.js';

test('renderer names Postgres row and GitHub label mismatches while preserving unavailable attribution', () => {
  const rendered = renderViolation(domainModel('run_0001'), { color: false, width: 80 });

  assert.match(rendered, /Agent said:\s+claim unavailable/);
  assert.match(rendered, /Tool returned:\s+no uniquely attributable tool result/);
  assert.match(rendered, /Postgres row count is 2, expected 3/);
  assert.match(rendered, /GitHub labels are \["bug"\], expected \["bug","urgent"\]/);
  assert.doesNotMatch(rendered, /\u001b\[/);
  assert.equal(renderViolation(domainModel('run_0001'), { color: false, width: 80 }), rendered);
});

test('summary matrix renders exact-threshold pass, miss by one, and insufficient-valid infrastructure accounting', () => {
  assert.equal(renderReplaySummary({
    requested: 12,
    completed: 12,
    passed: 10,
    failed: 2,
    infrastructure_failed: 0,
    indeterminate: 0,
    threshold: 10,
    status: 'PASS',
  }), `Replay PASS
  Requested runs:        12
  Completed runs:        12
  Behaviorally passed:   10
  Behaviorally failed:   2
  Infrastructure-failed: 0
  Indeterminate:         0
  Required threshold:    10
`);

  assert.equal(renderReplaySummary({
    requested: 12,
    completed: 12,
    passed: 9,
    failed: 3,
    infrastructure_failed: 0,
    indeterminate: 0,
    threshold: 10,
    status: 'FAIL',
  }), `Replay FAIL
  Requested runs:        12
  Completed runs:        12
  Behaviorally passed:   9
  Behaviorally failed:   3
  Infrastructure-failed: 0
  Indeterminate:         0
  Required threshold:    10
`);

  assert.equal(renderReplaySummary({
    requested: 12,
    completed: 12,
    passed: 8,
    failed: 1,
    infrastructure_failed: 2,
    indeterminate: 1,
    threshold: 10,
    status: 'INFRA',
  }), `Replay INFRA
  Requested runs:        12
  Completed runs:        12
  Behaviorally passed:   8
  Behaviorally failed:   1
  Infrastructure-failed: 2
  Indeterminate:         1
  Required threshold:    10
`);
});

test('saved-run model excludes ignored assertions and renders subset descriptions', () => {
  const evaluations: ReplayAssertionEvaluation[] = [
    evaluation({
      id: 'ignored-field',
      selector: { kind: 'field' },
      operator: 'equals',
      expected: 'stable',
      mode: 'ignore',
      observed: 'changed',
      passed: false,
      ignored: true,
      description: 'ignored field should not be rendered',
    }),
    evaluation({
      id: 'required-subset',
      selector: { kind: 'resource_set' },
      operator: 'subset',
      expected: ['bug', 'urgent'],
      mode: 'subset',
      observed: ['bug'],
      passed: false,
      ignored: false,
      description: 'required label subset was missing',
    }),
  ];
  const profiles: ReplayProfileResult[] = [
    { profile: 'subset-profile', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
  ];
  const model = violationModelFromSavedRun(summary('run_0002'), evaluations, { profiles });

  assert.equal(model.assertion_id, 'required-subset');
  assert.equal(model.failures.length, 1);
  assert.equal(model.failures[0]?.result.evaluationMode, 'subset');
  const rendered = renderViolation(model, { color: false, width: 80 });
  assert.match(rendered, /Actual state:\s+required label subset was missing/);
  assert.doesNotMatch(rendered, /ignored field should not be rendered|ignored-field/);
});

test('terminal matrix supports TTY ANSI, NO_COLOR, redirected plain text, 48 columns, and stable profile ordering', () => {
  const model = domainModel('run_0003');
  model.assertion_id = 'domain-state';
  model.failures[0]!.description = 'AReallyLongUnbrokenLocalObservationTokenThatMustSplitWithoutBreakingTheTerminalWidth';
  model.failures[0]!.selector = { kind: 'custom' };
  model.profiles = [
    { profile: 'zeta-infrastructure', status: 'INFRA', passed: 8, requested: 12, threshold: 10 },
    { profile: 'middle-miss', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
    { profile: 'alpha-threshold', status: 'PASS', passed: 10, requested: 12, threshold: 10 },
  ];

  const prior = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    const redirected = renderViolation(model, { color: false, width: 48 });
    assert.doesNotMatch(redirected, /\u001b\[/);
    assert.ok(redirected.split('\n').every((line) => line.length <= 48), redirected);
    assert.equal(renderViolation(structuredClone(model), { color: false, width: 48 }), redirected);
    assert.ok(redirected.indexOf('alpha-threshold') < redirected.indexOf('middle-miss'));
    assert.ok(redirected.indexOf('middle-miss') < redirected.indexOf('zeta-infrastructure'));
    assert.match(redirected, /10\/12 runs/);
    assert.match(redirected, /9\/12 runs passed;\s+threshold 10/);
    assert.match(redirected, /8\/12 behavioral\s+passes; threshold 10/);

    const tty = renderViolation(model, { color: true, width: 48 });
    assert.match(tty, /^\u001b\[31m✗ CONTRACT VIOLATED: domain-state\u001b\[0m/);
    assert.notEqual(tty, redirected);

    process.env.NO_COLOR = '1';
    assert.equal(renderViolation(model, { color: true, width: 48 }), redirected);
  } finally {
    if (prior === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prior;
  }
});

test('persisted JSON view and reconstructed plain violation carry the same assertion matrix', () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-renderer-parity-'));
  const store = new PublicRunStore(join(root, '.oculory', 'runs'));
  try {
    const runId = store.allocateRunId();
    const evaluations = domainEvaluations();
    const profiles = domainModel(runId).profiles;
    store.writeJson(runId, 'summary.json', summary(runId));
    store.writeJson(runId, 'diffs/database.json', { changed: true, rowCount: { before: 1, after: 2 } });
    store.writeJson(runId, 'diffs/github.json', { changed: true, labels: { before: [], after: ['bug'] } });
    store.writeJson(runId, 'assertion-matrix.json', evaluations);
    store.writeJson(runId, 'replay-context.json', { profiles });
    store.finalize(runId);

    const json = showRun(runId, { store, json: true });
    const parsed = JSON.parse(json.output) as typeof json.view;
    assert.deepEqual(parsed, json.view);
    assert.deepEqual(parsed.assertions, evaluations);
    assert.deepEqual(parsed.replay?.profiles, profiles);

    const expectedModel = violationModelFromSavedRun(
      parsed.summary,
      parsed.assertions!,
      parsed.replay!,
    );
    const plain = showRun(runId, { store, diff: true, color: false, width: 80 });
    assert.equal(plain.output, renderViolation(expectedModel, { color: false, width: 80 }));
    assert.match(plain.output, /Postgres row count is 2, expected 3/);
    assert.match(plain.output, /GitHub labels are \["bug"\], expected \["bug","urgent"\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface RendererGoldenCase {
  name: string;
  assertionId: string;
  claim: PublicRunSummary['agent_claim'];
  tool: PublicRunSummary['tool_result'];
  evaluations: ReplayAssertionEvaluation[];
  profiles: ReplayProfileResult[];
  actualWide: string;
  actualNarrow: string[];
  claimNarrow?: string[];
  toolNarrow?: string[];
  forbidden?: RegExp;
}

const availableClaim: PublicRunSummary['agent_claim'] = {
  status: 'available',
  text: 'Agent reported success',
  source: 'stdout-final',
};

const successfulTool: PublicRunSummary['tool_result'] = {
  status: 'success',
  detail: 'success',
};

const rendererGoldenCases: RendererGoldenCase[] = [
  goldenCase({
    name: 'wrong branch base',
    assertionId: 'wrong-branch-base',
    selector: { kind: 'branch_base' },
    expected: 'develop',
    observed: 'main',
    description: 'branch base mismatch',
    profile: { profile: 'git', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
    actualWide: 'branch created from wrong base (main, expected develop)',
    actualNarrow: ['branch created from wrong', 'base (main, expected develop)'],
  }),
  goldenCase({
    name: 'staged but uncommitted files',
    assertionId: 'staged-uncommitted',
    selector: { kind: 'staged_files' },
    operator: 'none',
    expected: [],
    observed: ['config/demo.txt', 'feature.txt'],
    description: 'staged files remained',
    profile: { profile: 'staged', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
    actualWide: '2 files staged, never committed',
    actualNarrow: ['2 files staged, never', 'committed'],
  }),
  goldenCase({
    name: 'Postgres row mismatch',
    assertionId: 'postgres-row-mismatch',
    selector: { kind: 'row_count', table: 'items' },
    expected: 3,
    observed: 2,
    description: 'row count mismatch',
    profile: { profile: 'postgres', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
    actualWide: 'Postgres row count is 2, expected 3',
    actualNarrow: ['Postgres row count is 2,', 'expected 3'],
  }),
  goldenCase({
    name: 'GitHub label mismatch',
    assertionId: 'github-label-mismatch',
    selector: { kind: 'issue_labels', number: 7 },
    operator: 'subset',
    mode: 'subset',
    expected: ['bug', 'urgent'],
    observed: ['bug'],
    description: 'required labels missing',
    profile: { profile: 'github', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
    actualWide: 'GitHub labels are ["bug"], expected ["bug","urgent"]',
    actualNarrow: ['GitHub labels are ["bug"],', 'expected ["bug","urgent"]'],
  }),
  goldenCase({
    name: 'missing claim',
    assertionId: 'missing-claim',
    selector: { kind: 'custom_state' },
    expected: 'expected',
    observed: 'observed',
    description: 'independent state was wrong',
    profile: { profile: 'claim', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
    claim: { status: 'unavailable', text: null, source: 'stdout-final' },
    actualWide: 'independent state was wrong',
    actualNarrow: ['independent state was wrong'],
  }),
  goldenCase({
    name: 'ambiguous attribution',
    assertionId: 'ambiguous-attribution',
    selector: { kind: 'custom_state' },
    expected: 'expected',
    observed: 'observed',
    description: 'independent state was wrong',
    profile: { profile: 'attribution', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
    tool: { status: 'ambiguous', detail: 'multiple local calls' },
    toolNarrow: ['no uniquely attributable tool', 'result'],
    actualWide: 'independent state was wrong',
    actualNarrow: ['independent state was wrong'],
  }),
  goldenCase({
    name: 'infrastructure failure',
    assertionId: 'infrastructure-failure',
    selector: { kind: 'custom_state' },
    expected: 'expected',
    observed: 'observed',
    description: '2 infrastructure runs failed',
    profile: { profile: 'infrastructure', status: 'INFRA', passed: 8, requested: 12, threshold: 10 },
    tool: { status: 'error', detail: 'proxy exited early' },
    actualWide: '2 infrastructure runs failed',
    actualNarrow: ['2 infrastructure runs failed'],
  }),
  goldenCase({
    name: 'insufficient valid runs',
    assertionId: 'insufficient-valid-runs',
    selector: { kind: 'custom_state' },
    expected: 10,
    observed: 9,
    description: 'only 9 valid runs remained',
    profile: { profile: 'valid-runs', status: 'INFRA', passed: 9, requested: 12, threshold: 10 },
    actualWide: 'only 9 valid runs remained',
    actualNarrow: ['only 9 valid runs remained'],
  }),
  goldenCase({
    name: 'exact-threshold pass',
    assertionId: 'exact-threshold-pass',
    selector: { kind: 'custom_state' },
    expected: 'expected',
    observed: 'observed',
    description: 'one observed run failed',
    profile: { profile: 'threshold', status: 'PASS', passed: 10, requested: 12, threshold: 10 },
    actualWide: 'one observed run failed',
    actualNarrow: ['one observed run failed'],
  }),
  goldenCase({
    name: 'threshold miss by one',
    assertionId: 'threshold-miss-by-one',
    selector: { kind: 'custom_state' },
    expected: 10,
    observed: 9,
    description: 'threshold missed by one run',
    profile: { profile: 'threshold', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
    actualWide: 'threshold missed by one run',
    actualNarrow: ['threshold missed by one run'],
  }),
  {
    ...goldenCase({
      name: 'ignored assertion',
      assertionId: 'retained-assertion',
      selector: { kind: 'custom_state' },
      expected: 'expected',
      observed: 'observed',
      description: 'retained assertion failed',
      profile: { profile: 'ignored', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
      actualWide: 'retained assertion failed',
      actualNarrow: ['retained assertion failed'],
    }),
    evaluations: [
      evaluation({
        id: 'ignored-field',
        selector: { kind: 'field' },
        operator: 'equals',
        expected: 'stable',
        mode: 'ignore',
        observed: 'changed',
        passed: false,
        ignored: true,
        description: 'ignored field should not render',
      }),
      evaluation({
        id: 'retained-assertion',
        selector: { kind: 'custom_state' },
        operator: 'equals',
        expected: 'expected',
        mode: 'exact',
        observed: 'observed',
        passed: false,
        ignored: false,
        description: 'retained assertion failed',
      }),
    ],
    forbidden: /ignored field should not render|ignored-field/,
  },
  goldenCase({
    name: 'subset assertion',
    assertionId: 'required-subset',
    selector: { kind: 'resource_set' },
    operator: 'subset',
    mode: 'subset',
    expected: ['bug', 'urgent'],
    observed: ['bug'],
    description: 'required label subset was missing',
    profile: { profile: 'subset', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
    actualWide: 'required label subset was missing',
    actualNarrow: ['required label subset was', 'missing'],
  }),
];

test('all 12 renderer goldens cover TTY ANSI, NO_COLOR, redirected, narrow, and persisted JSON reconstruction', () => {
  assert.equal(rendererGoldenCases.length, 12);
  const root = mkdtempSync(join(tmpdir(), 'oculory-renderer-complete-matrix-'));
  const store = new PublicRunStore(join(root, '.oculory', 'runs'));
  const priorNoColor = process.env.NO_COLOR;
  try {
    for (const rendererCase of rendererGoldenCases) {
      const runId = store.allocateRunId();
      const runSummary = goldenSummary(runId, rendererCase);
      const model = violationModelFromSavedRun(runSummary, rendererCase.evaluations, {
        profiles: rendererCase.profiles,
      });
      const expectedWide = expectedGolden(rendererCase, runId, false);
      const expectedNarrow = expectedGolden(rendererCase, runId, true);

      delete process.env.NO_COLOR;
      const redirected = renderViolation(model, { color: false, width: 80 });
      assert.equal(redirected, expectedWide, `${rendererCase.name}: redirected golden`);
      assert.doesNotMatch(redirected, /\u001b\[/, `${rendererCase.name}: redirected output`);

      const tty = renderViolation(model, { color: true, width: 80 });
      assert.equal(tty, colorizeGolden(expectedWide), `${rendererCase.name}: TTY golden`);
      assert.match(tty, /^\u001b\[31m✗ CONTRACT VIOLATED:/, `${rendererCase.name}: TTY ANSI`);

      process.env.NO_COLOR = '1';
      assert.equal(
        renderViolation(model, { color: true, width: 80 }),
        expectedWide,
        `${rendererCase.name}: NO_COLOR golden`,
      );

      delete process.env.NO_COLOR;
      const narrow = renderViolation(model, { color: false, width: 48 });
      assert.equal(narrow, expectedNarrow, `${rendererCase.name}: narrow redirected golden`);
      assert.ok(
        narrow.split('\n').every((line) => line.length <= 48),
        `${rendererCase.name}: narrow line exceeded 48 columns\n${narrow}`,
      );
      const narrowTty = renderViolation(model, { color: true, width: 48 });
      assert.equal(narrowTty, colorizeGolden(expectedNarrow), `${rendererCase.name}: narrow TTY golden`);
      assert.ok(
        stripAnsi(narrowTty).split('\n').every((line) => line.length <= 48),
        `${rendererCase.name}: narrow ANSI line exceeded 48 columns`,
      );

      store.writeJson(runId, 'summary.json', runSummary);
      store.writeJson(runId, 'diffs/local-target.json', { changed: true });
      store.writeJson(runId, 'assertion-matrix.json', rendererCase.evaluations);
      store.writeJson(runId, 'replay-context.json', { profiles: rendererCase.profiles });
      store.finalize(runId);

      const json = showRun(runId, { store, json: true });
      const parsed = JSON.parse(json.output) as typeof json.view;
      assert.deepEqual(parsed, json.view, `${rendererCase.name}: persisted JSON parity`);
      assert.deepEqual(parsed.assertions, rendererCase.evaluations, `${rendererCase.name}: assertion JSON parity`);
      assert.deepEqual(parsed.replay?.profiles, rendererCase.profiles, `${rendererCase.name}: profile JSON parity`);
      assert.doesNotMatch(json.output, /\u001b\[/, `${rendererCase.name}: JSON ANSI`);

      const parsedModel = violationModelFromSavedRun(parsed.summary, parsed.assertions!, parsed.replay!);
      assert.equal(
        renderViolation(parsedModel, { color: false, width: 80 }),
        expectedWide,
        `${rendererCase.name}: JSON model reconstruction`,
      );
      assert.equal(
        showRun(runId, { store, diff: true, color: false, width: 80 }).output,
        expectedWide,
        `${rendererCase.name}: show reconstruction`,
      );
      assert.equal(
        showRun(runId, { store, diff: true, color: true, width: 80 }).output,
        colorizeGolden(expectedWide),
        `${rendererCase.name}: show TTY reconstruction`,
      );
      assert.doesNotMatch(expectedWide, /\/Users\/|Bearer |payload/i, `${rendererCase.name}: public-safe golden`);
      if (rendererCase.forbidden !== undefined) {
        assert.doesNotMatch(expectedWide, rendererCase.forbidden, `${rendererCase.name}: ignored assertion`);
      }
    }
  } finally {
    if (priorNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = priorNoColor;
    rmSync(root, { recursive: true, force: true });
  }
});

function goldenCase(input: {
  name: string;
  assertionId: string;
  selector: Record<string, AdapterJson>;
  operator?: AdapterAssertionResult['operator'];
  mode?: AdapterAssertionResult['evaluationMode'];
  expected: AdapterJson;
  observed: AdapterJson;
  description: string;
  profile: ReplayProfileResult;
  actualWide: string;
  actualNarrow: string[];
  claim?: PublicRunSummary['agent_claim'];
  tool?: PublicRunSummary['tool_result'];
  claimNarrow?: string[];
  toolNarrow?: string[];
}): RendererGoldenCase {
  return {
    name: input.name,
    assertionId: input.assertionId,
    claim: input.claim ?? availableClaim,
    tool: input.tool ?? successfulTool,
    evaluations: [evaluation({
      id: input.assertionId,
      selector: input.selector,
      operator: input.operator ?? 'equals',
      expected: input.expected,
      mode: input.mode ?? 'exact',
      observed: input.observed,
      passed: false,
      ignored: false,
      description: input.description,
    })],
    profiles: [input.profile],
    actualWide: input.actualWide,
    actualNarrow: input.actualNarrow,
    claimNarrow: input.claimNarrow,
    toolNarrow: input.toolNarrow,
  };
}

function goldenSummary(runId: string, rendererCase: RendererGoldenCase): PublicRunSummary {
  return {
    schema_version: 'oculory-public-run-v1',
    run_id: runId,
    task_id: 'local-renderer-matrix',
    profile: rendererCase.profiles[0]!.profile,
    classification: 'behaviorally-violated',
    agent_claim: rendererCase.claim,
    tool_result: rendererCase.tool,
    observed_state: { status: 'available', changed_targets: ['local-target'] },
    process: {
      exit_code: 0,
      timed_out: false,
      cancelled: false,
      output_limit_exceeded: false,
    },
    cleanup: {
      passed: true,
      process_group_absent: true,
      proxy: true,
      adapters: { 'local-target': true },
      workspace: true,
    },
    infrastructure_error: null,
  };
}

function expectedGolden(rendererCase: RendererGoldenCase, runId: string, narrow: boolean): string {
  const claim = rendererCase.claim.status === 'available'
    ? JSON.stringify(rendererCase.claim.text)
    : 'claim unavailable';
  const tool = rendererCase.tool.status === 'unavailable' || rendererCase.tool.status === 'ambiguous'
    ? 'no uniquely attributable tool result'
    : rendererCase.tool.detail;
  const claimLines = narrow ? rendererCase.claimNarrow ?? [claim] : [claim];
  const toolLines = narrow ? rendererCase.toolNarrow ?? [tool] : [tool];
  const actualLines = narrow ? rendererCase.actualNarrow : [rendererCase.actualWide];
  return [
    `✗ CONTRACT VIOLATED: ${rendererCase.assertionId}`,
    '',
    ...goldenLabeled('Agent said:', claimLines),
    ...goldenLabeled('Tool returned:', toolLines),
    ...goldenLabeled('Actual state:', actualLines),
    '',
    '  Replay results:',
    ...rendererCase.profiles.flatMap((profile) => goldenProfile(profile, narrow)),
    '',
    `  → Diff: oculory show ${runId} --diff`,
    '',
  ].join('\n');
}

function goldenLabeled(label: string, values: string[]): string[] {
  const prefix = `  ${label.padEnd(17)}`;
  const continuation = ' '.repeat(prefix.length);
  return values.map((value, index) => `${index === 0 ? prefix : continuation}${value}`);
}

function goldenProfile(profile: ReplayProfileResult, narrow: boolean): string[] {
  const prefix = `    ${profile.profile.padEnd(19)}${profile.status.padEnd(5)} `;
  if (profile.status === 'PASS') return [`${prefix}(${profile.passed}/${profile.requested} runs)`];
  if (profile.status === 'FAIL') {
    if (!narrow) return [`${prefix}(${profile.passed}/${profile.requested} runs passed; threshold ${profile.threshold})`];
    return [`${prefix}(${profile.passed}/${profile.requested} runs passed;`, `    threshold ${profile.threshold})`];
  }
  if (!narrow) return [`${prefix}(${profile.passed}/${profile.requested} behavioral passes; threshold ${profile.threshold})`];
  return [`${prefix}(${profile.passed}/${profile.requested} behavioral`, `    passes; threshold ${profile.threshold})`];
}

function colorizeGolden(plain: string): string {
  const newline = plain.indexOf('\n');
  return `\u001b[31m${plain.slice(0, newline)}\u001b[0m${plain.slice(newline)}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function domainModel(runId: string): ViolationRenderModel {
  return {
    assertion_id: 'database-and-labels',
    claim: { status: 'unavailable', text: null, source: 'stdout-final' },
    tool: { status: 'ambiguous', detail: 'multiple local calls' },
    failures: domainEvaluations().map((entry) => ({
      selector: entry.assertion.selector,
      result: entry.result!,
      description: entry.description,
    })),
    profiles: [
      { profile: 'github-profile', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
      { profile: 'database-profile', status: 'FAIL', passed: 9, requested: 12, threshold: 10 },
    ],
    run_id: runId,
  };
}

function domainEvaluations(): ReplayAssertionEvaluation[] {
  return [
    evaluation({
      id: 'database-row-count',
      selector: { kind: 'row_count', table: 'items' },
      operator: 'equals',
      expected: 3,
      mode: 'exact',
      observed: 2,
      passed: false,
      ignored: false,
      description: 'row count mismatch',
    }),
    evaluation({
      id: 'github-required-labels',
      selector: { kind: 'issue_labels', number: 7 },
      operator: 'subset',
      expected: ['bug', 'urgent'],
      mode: 'subset',
      observed: ['bug'],
      passed: false,
      ignored: false,
      description: 'required labels missing',
    }),
  ];
}

function evaluation(input: {
  id: string;
  selector: Record<string, AdapterJson>;
  operator: AdapterAssertionResult['operator'];
  expected: AdapterJson;
  mode: AdapterAssertionResult['evaluationMode'];
  observed: AdapterJson;
  passed: boolean;
  ignored: boolean;
  description: string;
}): ReplayAssertionEvaluation {
  return {
    assertion: {
      id: input.id,
      target: 'local-target',
      selector: input.selector,
      operator: input.operator,
      expected: input.expected,
      evaluation: input.mode,
    },
    result: {
      assertionId: input.id,
      passed: input.passed,
      ignored: input.ignored,
      operator: input.operator,
      evaluationMode: input.mode,
      expected: input.expected,
      observed: input.observed,
      detail: input.description,
    },
    description: input.description,
    error: null,
  };
}

function summary(runId: string): PublicRunSummary {
  return {
    schema_version: 'oculory-public-run-v1',
    run_id: runId,
    task_id: 'local-renderer-matrix',
    profile: 'matrix',
    classification: 'behaviorally-violated',
    agent_claim: { status: 'unavailable', text: null, source: 'stdout-final' },
    tool_result: { status: 'ambiguous', detail: 'multiple local calls' },
    observed_state: { status: 'available', changed_targets: ['database', 'github'] },
    process: {
      exit_code: 0,
      timed_out: false,
      cancelled: false,
      output_limit_exceeded: false,
    },
    cleanup: {
      passed: true,
      process_group_absent: true,
      proxy: true,
      adapters: { database: true, github: true },
      workspace: true,
    },
    infrastructure_error: null,
  };
}
