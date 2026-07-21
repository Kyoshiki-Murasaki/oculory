import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { AdapterRegistry } from '../src/mlp/adapters/registry.js';
import type {
  AdapterAssertion,
  AdapterAssertionResult,
  AdapterJson,
  AdapterOperationResult,
  OculoryAdapter,
} from '../src/mlp/adapters/types.js';
import { runBoundedProcess } from '../src/mlp/process.js';
import { executeTaskRun, type PublicRunSummary } from '../src/mlp/record.js';
import { replayContract } from '../src/mlp/replay.js';
import { PublicRunStore } from '../src/mlp/run-store.js';
import type { ContractAssertion, OculoryContractConfig, OculoryTaskConfig } from '../src/mlp/types.js';

interface StateConfiguration {
  location: string;
}

interface StateSnapshot {
  left: string;
  right: string;
}

interface StateDiff {
  changed: boolean;
  fields: string[];
}

interface Harness {
  root: string;
  taskPath: string;
  taskSource: string;
  task: OculoryTaskConfig;
  registry: AdapterRegistry;
  store: PublicRunStore;
  close(): void;
}

const SUPPORT_ROOT = resolve(process.cwd(), 'test', 'support');
const AGENT = join(SUPPORT_ROOT, 'mlp-fault-agent.mjs');
const SERVER = join(SUPPORT_ROOT, 'mlp-fault-server.mjs');
const FIXTURE = join(SUPPORT_ROOT, 'mlp-fault-fixture.mjs');

test('bounded process execution records timeout and AbortSignal cancellation, then proves process-group absence', {
  timeout: 15_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'oculory-mlp-fault-process-'));
  try {
    const timeout = await runBoundedProcess({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: root,
      env: {},
      timeoutMs: 80,
    });
    assert.equal(timeout.timed_out, true);
    assert.equal(timeout.cancelled, false);
    assert.equal(timeout.cleanup.child_exited, true);
    assert.equal(timeout.cleanup.process_group_absent, process.platform !== 'win32');
    assert.deepEqual(timeout.events.filter((event) => event.kind === 'timeout').map((event) => event.detail), [
      'deadline 80ms exceeded',
    ]);

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 80);
    const cancelled = await runBoundedProcess({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: root,
      env: {},
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    clearTimeout(abortTimer);
    assert.equal(cancelled.timed_out, false);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.cleanup.child_exited, true);
    assert.equal(cancelled.cleanup.process_group_absent, process.platform !== 'win32');
    assert.deepEqual(cancelled.events.filter((event) => event.kind === 'cancellation').map((event) => event.detail), [
      'execution cancelled',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('record classifies timed-out and cancelled agents as infrastructure failures without inventing tool evidence', {
  skip: process.platform === 'win32',
  timeout: 30_000,
}, async () => {
  const harness = createHarness();
  try {
    const timedOut = await executeTaskRun(harness.task, {
      taskPath: harness.taskPath,
      taskSource: harness.taskSource,
      profile: 'hang',
      registry: harness.registry,
      store: harness.store,
      timeoutMs: 100,
    });
    assert.equal(timedOut.summary.classification, 'infrastructure-failed');
    assert.equal(timedOut.summary.process?.timed_out, true);
    assert.equal(timedOut.summary.process?.cancelled, false);
    assert.deepEqual(timedOut.summary.tool_result, {
      status: 'unavailable',
      detail: 'no uniquely attributable tool result',
    });
    assert.equal(timedOut.summary.infrastructure_error, 'agent execution timed out');
    assert.equal(timedOut.summary.cleanup.passed, false);

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 100);
    const cancelled = await executeTaskRun(harness.task, {
      taskPath: harness.taskPath,
      taskSource: harness.taskSource,
      profile: 'hang',
      registry: harness.registry,
      store: harness.store,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    clearTimeout(abortTimer);
    assert.equal(cancelled.summary.classification, 'infrastructure-failed');
    assert.equal(cancelled.summary.process?.timed_out, false);
    assert.equal(cancelled.summary.process?.cancelled, true);
    assert.equal(cancelled.summary.infrastructure_error, 'agent execution was cancelled');
    assert.equal(cancelled.summary.cleanup.passed, false);
    harness.store.verify(timedOut.summary.run_id);
    harness.store.verify(cancelled.summary.run_id);
  } finally {
    harness.close();
  }
});

test('replay keeps malformed, partial, wrong-state, unavailable-claim, and ambiguous-attribution witnesses separate', {
  skip: process.platform === 'win32',
  timeout: 120_000,
}, async () => {
  const harness = createHarness();
  try {
    const malformed = await replayContract(contract([stateAssertion('right', 'done')]), {
      ...replayOptions(harness, 'malformed'),
    });
    assert.equal(malformed.report.status, 'FAIL');
    assert.equal(malformed.report.exit_code, 2);
    assert.deepEqual(malformed.report.totals, totals({ failed: 1 }));
    assert.equal(malformed.report.iterations[0]?.classification, 'behaviorally-violated');
    assert.equal(malformed.report.iterations[0]?.tool_result.status, 'error');
    assert.equal(malformed.report.iterations[0]?.agent_claim.status, 'available');
    assert.equal(malformed.report.iterations[0]?.assertions[0]?.result?.observed, 'initial');
    assert.equal(summary(harness, malformed.report.iterations[0]!.run_id).cleanup.passed, true);

    const partial = await replayContract(contract([
      stateAssertion('left', 'done'),
      stateAssertion('right', 'done'),
    ]), {
      ...replayOptions(harness, 'partial'),
    });
    assert.equal(partial.report.status, 'FAIL');
    assert.equal(partial.report.exit_code, 2);
    assert.equal(partial.report.iterations[0]?.tool_result.status, 'success');
    assert.deepEqual(
      partial.report.iterations[0]?.assertions.map((entry) => [entry.assertion.id, entry.result?.passed]),
      [['left-is-done', true], ['right-is-done', false]],
    );

    const wrong = await replayContract(contract([stateAssertion('right', 'done')]), {
      ...replayOptions(harness, 'wrong'),
    });
    assert.equal(wrong.report.status, 'FAIL');
    assert.equal(wrong.report.exit_code, 2);
    assert.equal(wrong.report.iterations[0]?.tool_result.status, 'success');
    assert.equal(wrong.report.iterations[0]?.assertions[0]?.result?.observed, 'wrong');
    assert.equal(wrong.report.iterations[0]?.classification, 'behaviorally-violated');

    const missingClaim = await replayContract(contract([stateAssertion('right', 'done')]), {
      ...replayOptions(harness, 'unavailable-claim'),
    });
    assert.equal(missingClaim.report.status, 'PASS');
    assert.equal(missingClaim.report.exit_code, 0);
    assert.deepEqual(missingClaim.report.iterations[0]?.agent_claim, {
      status: 'unavailable',
      text: null,
      source: 'line-prefix',
    });
    assert.equal(missingClaim.report.iterations[0]?.tool_result.status, 'success');

    const ambiguous = await replayContract(contract([stateAssertion('right', 'done')]), {
      ...replayOptions(harness, 'ambiguous'),
    });
    assert.equal(ambiguous.report.status, 'PASS');
    assert.equal(ambiguous.report.exit_code, 0);
    assert.deepEqual(ambiguous.report.iterations[0]?.tool_result, {
      status: 'ambiguous',
      detail: 'no uniquely attributable tool result',
    });
    assert.equal(ambiguous.report.iterations[0]?.agent_claim.status, 'available');
  } finally {
    harness.close();
  }
});

test('record fails closed on workspace reset, adapter cleanup, and workspace cleanup faults', {
  skip: process.platform === 'win32',
  timeout: 60_000,
}, async () => {
  const resetHarness = createHarness({ workspaceFault: 'reset-fail' });
  try {
    const reset = await executeTaskRun(resetHarness.task, {
      taskPath: resetHarness.taskPath,
      taskSource: resetHarness.taskSource,
      profile: 'good',
      registry: resetHarness.registry,
      store: resetHarness.store,
    });
    assert.equal(reset.summary.classification, 'infrastructure-failed');
    assert.equal(reset.summary.process, null);
    assert.equal(reset.summary.observed_state.status, 'unavailable');
    assert.match(reset.summary.infrastructure_error ?? '', /^workspace reset verification failed:/);
    assert.equal(reset.summary.cleanup.workspace, true);
    assert.equal(reset.summary.cleanup.proxy, false);
  } finally {
    resetHarness.close();
  }

  const prepareHarness = createHarness({ adapterPreparePass: false });
  try {
    const prepare = await executeTaskRun(prepareHarness.task, {
      taskPath: prepareHarness.taskPath,
      taskSource: prepareHarness.taskSource,
      profile: 'good',
      registry: prepareHarness.registry,
      store: prepareHarness.store,
    });
    assert.equal(prepare.summary.classification, 'infrastructure-failed');
    assert.equal(prepare.summary.process, null);
    assert.equal(prepare.summary.cleanup.adapters.state, false);
    assert.equal(prepare.summary.cleanup.workspace, true);
    assert.match(prepare.summary.infrastructure_error ?? '', /synthetic adapter preparation failure/);
  } finally {
    prepareHarness.close();
  }

  const adapterHarness = createHarness({ adapterCleanupPass: false });
  try {
    const adapter = await executeTaskRun(adapterHarness.task, {
      taskPath: adapterHarness.taskPath,
      taskSource: adapterHarness.taskSource,
      profile: 'good',
      registry: adapterHarness.registry,
      store: adapterHarness.store,
    });
    assert.equal(adapter.summary.classification, 'infrastructure-failed');
    assert.equal(adapter.summary.process?.exit_code, 0);
    assert.equal(adapter.summary.observed_state.status, 'available');
    assert.equal(adapter.summary.cleanup.adapters.state, false);
    assert.equal(adapter.summary.cleanup.workspace, true);
    assert.match(adapter.summary.infrastructure_error ?? '', /^adapter cleanup failed for state:/);
  } finally {
    adapterHarness.close();
  }

  const workspaceHarness = createHarness({ workspaceFault: 'cleanup-fail' });
  try {
    const workspace = await executeTaskRun(workspaceHarness.task, {
      taskPath: workspaceHarness.taskPath,
      taskSource: workspaceHarness.taskSource,
      profile: 'good',
      registry: workspaceHarness.registry,
      store: workspaceHarness.store,
    });
    assert.equal(workspace.summary.classification, 'infrastructure-failed');
    assert.equal(workspace.summary.process?.exit_code, 0);
    assert.equal(workspace.summary.observed_state.status, 'available');
    assert.equal(workspace.summary.cleanup.adapters.state, true);
    assert.equal(workspace.summary.cleanup.workspace, false);
    assert.match(workspace.summary.infrastructure_error ?? '', /^workspace cleanup failed:/);
  } finally {
    workspaceHarness.close();
  }
});

test('replay distinguishes infrastructure from indeterminate runs and reports fail-closed exit accounting', {
  skip: process.platform === 'win32',
  timeout: 180_000,
}, async () => {
  const indeterminateHarness = createHarness();
  try {
    const indeterminate = await replayContract(contract([stateAssertion('right', 'done')]), {
      ...replayOptions(indeterminateHarness, 'indeterminate'),
    });
    assert.equal(indeterminate.report.status, 'INFRA');
    assert.equal(indeterminate.report.exit_code, 3);
    assert.deepEqual(indeterminate.report.totals, totals({ indeterminate: 1 }));
    assert.equal(indeterminate.report.iterations[0]?.classification, 'indeterminate');
    assert.equal(indeterminate.report.iterations[0]?.infrastructure_error, null);
    assert.match(indeterminate.report.iterations[0]?.assertions[0]?.error ?? '', /synthetic indeterminate observation/);
  } finally {
    indeterminateHarness.close();
  }

  const infrastructureHarness = createHarness({ adapterCleanupPass: false });
  try {
    const infrastructure = await replayContract(contract([stateAssertion('right', 'done')]), {
      ...replayOptions(infrastructureHarness, 'good'),
    });
    assert.equal(infrastructure.report.status, 'INFRA');
    assert.equal(infrastructure.report.exit_code, 3);
    assert.deepEqual(infrastructure.report.totals, totals({ infrastructure: 1 }));
    assert.equal(infrastructure.report.iterations[0]?.classification, 'infrastructure-failed');
    assert.match(infrastructure.report.iterations[0]?.infrastructure_error ?? '', /adapter cleanup failed/);
  } finally {
    infrastructureHarness.close();
  }

  const insufficientHarness = createHarness();
  try {
    const insufficient = await replayContract(contract([stateAssertion('right', 'done')], 2, 2), {
      ...replayOptions(insufficientHarness, 'mixed-infra'),
    });
    assert.equal(insufficient.report.status, 'INFRA');
    assert.equal(insufficient.report.exit_code, 3);
    assert.deepEqual(insufficient.report.totals, {
      requested: 2,
      completed: 2,
      behaviorally_passed: 1,
      behaviorally_failed: 0,
      infrastructure_failed: 1,
      indeterminate: 0,
      required_threshold: 2,
    });
    assert.deepEqual(
      insufficient.report.iterations.map((iteration) => iteration.classification),
      ['behaviorally-passed', 'infrastructure-failed'],
    );
  } finally {
    insufficientHarness.close();
  }

  const thresholdHarness = createHarness();
  try {
    const thresholdMiss = await replayContract(contract([stateAssertion('right', 'done')], 12, 10), {
      ...replayOptions(thresholdHarness, 'threshold-nine'),
    });
    assert.equal(thresholdMiss.report.status, 'FAIL');
    assert.equal(thresholdMiss.report.exit_code, 2);
    assert.deepEqual(thresholdMiss.report.totals, {
      requested: 12,
      completed: 12,
      behaviorally_passed: 9,
      behaviorally_failed: 3,
      infrastructure_failed: 0,
      indeterminate: 0,
      required_threshold: 10,
    });
    assert.deepEqual(
      thresholdMiss.report.iterations.map((iteration) => iteration.classification),
      [
        'behaviorally-passed',
        'behaviorally-passed',
        'behaviorally-passed',
        'behaviorally-passed',
        'behaviorally-passed',
        'behaviorally-passed',
        'behaviorally-passed',
        'behaviorally-passed',
        'behaviorally-passed',
        'behaviorally-violated',
        'behaviorally-violated',
        'behaviorally-violated',
      ],
    );
  } finally {
    thresholdHarness.close();
  }
});

function createHarness(options: {
  workspaceFault?: string;
  adapterPreparePass?: boolean;
  adapterCleanupPass?: boolean;
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'oculory-mlp-fault-harness-'));
  const taskPath = join(root, 'task.yaml');
  const profiles = [
    'ambiguous',
    'good',
    'hang',
    'indeterminate',
    'malformed',
    'mixed-infra',
    'partial',
    'threshold-nine',
    'unavailable-claim',
    'wrong',
  ];
  const task: OculoryTaskConfig = {
    version: 'oculory-task-v1',
    task_id: 'fault-injection-state',
    prompt: 'Set both fields in the disposable state to done.',
    agent_profiles: Object.fromEntries(profiles.map((mode) => [mode, {
      argv: [process.execPath, AGENT, '--mcp-config', '{mcp_config}', '--mode', '{model}', '--run-id', '{run_id}'],
      env_allowlist: safeEnvironmentNames(),
      model: mode,
    }])),
    mcp_server: {
      command: process.execPath,
      arguments: [SERVER, '--workspace', '{workspace}', '--mode', '{model}', '--run-id', '{run_id}'],
      env_allowlist: safeEnvironmentNames(),
    },
    workspace: {
      strategy: 'command',
      setup: [process.execPath, FIXTURE, 'setup', options.workspaceFault ?? 'none', '{workspace}'],
      reset: [process.execPath, FIXTURE, 'reset', options.workspaceFault ?? 'none', '{workspace}'],
      cleanup: [process.execPath, FIXTURE, 'cleanup', options.workspaceFault ?? 'none', '{workspace}'],
    },
    targets: [{
      id: 'state',
      adapter: 'fault-state-observer',
      configuration: { location: '{workspace}/state.json' },
      watch: { fields: ['left', 'right'] },
    }],
    claim_extraction: { type: 'line-prefix', prefix: 'CLAIM: ' },
  };
  const taskSource = stringify(task, { lineWidth: 100, indent: 2 });
  writeFileSync(taskPath, taskSource, { encoding: 'utf8', mode: 0o600 });
  const registry = new AdapterRegistry();
  registry.register({
    id: 'fault-state-observer',
    version: '1.0.0',
    adapter: createStateAdapter(options.adapterPreparePass ?? true, options.adapterCleanupPass ?? true),
  });
  return {
    root,
    taskPath,
    taskSource,
    task,
    registry,
    store: new PublicRunStore(join(root, '.oculory', 'runs')),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createStateAdapter(preparePass: boolean, cleanupPass: boolean): OculoryAdapter<
  StateConfiguration,
  StateConfiguration,
  StateSnapshot,
  StateSnapshot,
  StateDiff
> {
  return {
    validateConfiguration(value: unknown): StateConfiguration {
      const config = object(value);
      if (typeof config.location !== 'string') throw new Error('state location is required');
      return { location: config.location };
    },
    async prepare(configuration): Promise<StateConfiguration> {
      if (!preparePass) throw new Error('synthetic adapter preparation failure');
      return configuration;
    },
    async snapshotBefore(prepared): Promise<StateSnapshot> {
      return readState(prepared.location);
    },
    async snapshotAfter(prepared): Promise<StateSnapshot> {
      return readState(prepared.location);
    },
    normalizeSnapshot(snapshot): StateSnapshot {
      return { left: snapshot.left, right: snapshot.right };
    },
    diff(before, after): StateDiff {
      const fields = (['left', 'right'] as const).filter((field) => before[field] !== after[field]);
      return { changed: fields.length > 0, fields };
    },
    evaluateAssertion(assertion, _before, after): AdapterAssertionResult {
      const field = assertion.selector.field;
      if (field !== 'left' && field !== 'right') throw new Error('unsupported state selector');
      if (after[field] === 'indeterminate') throw new Error('synthetic indeterminate observation');
      if (assertion.operator !== 'equals') throw new Error('unsupported state operator');
      const ignored = assertion.evaluationMode === 'ignore';
      const expected = assertion.expected ?? null;
      const passed = ignored || after[field] === expected;
      return {
        assertionId: assertion.id,
        passed,
        ignored,
        operator: assertion.operator,
        evaluationMode: assertion.evaluationMode,
        expected,
        observed: after[field],
        detail: passed ? `${field} matched` : `${field} was ${after[field]}`,
      };
    },
    async reset(): Promise<AdapterOperationResult> {
      return { passed: true, detail: 'workspace strategy owns reset' };
    },
    async cleanup(): Promise<AdapterOperationResult> {
      return cleanupPass
        ? { passed: true, detail: 'adapter holds no external resources' }
        : { passed: false, detail: 'synthetic adapter cleanup failure' };
    },
    describeViolation(_assertion: AdapterAssertion, result: AdapterAssertionResult): string {
      return `state violated: ${result.detail}`;
    },
    redact(value: unknown): AdapterJson {
      return JSON.parse(JSON.stringify(value)) as AdapterJson;
    },
  };
}

function replayOptions(harness: Harness, profile: string) {
  return {
    taskPath: harness.taskPath,
    taskSource: harness.taskSource,
    profile,
    registry: harness.registry,
    store: harness.store,
    color: false,
    width: 80,
  };
}

function contract(assertions: ContractAssertion[], runs = 1, minPass = 1): OculoryContractConfig {
  return {
    version: 'oculory-contract-v1',
    task: 'fault-injection-state',
    tolerance: { runs, min_pass: minPass },
    assertions,
  };
}

function stateAssertion(field: 'left' | 'right', expected: string): ContractAssertion {
  return {
    id: `${field}-is-${expected}`,
    target: 'state',
    selector: { field },
    operator: 'equals',
    expected,
    evaluation: 'exact',
  };
}

function totals(options: { passed?: number; failed?: number; infrastructure?: number; indeterminate?: number }) {
  return {
    requested: 1,
    completed: 1,
    behaviorally_passed: options.passed ?? 0,
    behaviorally_failed: options.failed ?? 0,
    infrastructure_failed: options.infrastructure ?? 0,
    indeterminate: options.indeterminate ?? 0,
    required_threshold: 1,
  };
}

function summary(harness: Harness, runId: string): PublicRunSummary {
  return harness.store.readJson<PublicRunSummary>(runId, 'summary.json');
}

function readState(path: string): StateSnapshot {
  const state = object(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (typeof state.left !== 'string' || typeof state.right !== 'string') throw new Error('invalid disposable state');
  return { left: state.left, right: state.right };
}

function safeEnvironmentNames(): string[] {
  return ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'].filter((name) => process.env[name] !== undefined);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
