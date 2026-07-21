import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { executeTaskRun } from '../src/mlp/record.js';
import { replayContract, type ReplayReport } from '../src/mlp/replay.js';
import { PublicRunStore } from '../src/mlp/run-store.js';
import type { OculoryContractConfig, OculoryTaskConfig } from '../src/mlp/types.js';

interface StateConfiguration {
  location: string;
}

interface StateSnapshot {
  value: string;
}

interface StateDiff {
  changed: boolean;
  before: string;
  after: string;
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

test('public record persists the claim, tool, and observed-state witnesses with verified cleanup and checksums', {
  skip: process.platform === 'win32',
  timeout: 30_000,
}, async () => {
  const harness = createHarness();
  try {
    const executed = await executeTaskRun(harness.task, {
      taskPath: harness.taskPath,
      taskSource: harness.taskSource,
      profile: 'pass',
      registry: harness.registry,
      store: harness.store,
      timeoutMs: 15_000,
      registerTask: true,
    });

    assert.equal(executed.summary.classification, 'behaviorally-passed');
    assert.deepEqual(executed.summary.agent_claim, {
      status: 'available',
      text: 'completed pass',
      source: 'line-prefix',
    });
    assert.deepEqual(executed.summary.tool_result, { status: 'success', detail: 'success' });
    assert.deepEqual(executed.summary.observed_state, {
      status: 'available',
      changed_targets: ['state'],
    });
    assert.deepEqual(executed.targets, [{
      id: 'state',
      adapter: 'state-observer',
      before: { value: 'initial' },
      after: { value: 'good' },
      diff: { after: 'good', before: 'initial', changed: true },
      error: null,
    }]);
    assert.equal(executed.summary.cleanup.passed, true);
    assert.equal(executed.summary.cleanup.process_group_absent, true);
    assert.equal(executed.summary.cleanup.proxy, true);
    assert.equal(executed.summary.cleanup.adapters.state, true);
    assert.equal(executed.summary.cleanup.workspace, true);
    assert.ok(executed.proxyEvents.some((event) => object(event).kind === 'proxy_cleanup'));

    harness.store.verify(executed.summary.run_id);
    const runRoot = harness.store.runPath(executed.summary.run_id);
    assert.equal(readFileSync(join(runRoot, 'task.yaml'), 'utf8'), harness.taskSource);
    assert.equal(existsSync(join(runRoot, 'checksums.sha256')), true);
    const checksums = readFileSync(join(runRoot, 'checksums.sha256'), 'utf8');
    for (const path of [
      'cleanup.json',
      'diffs/state.json',
      'evidence/agent.json',
      'evidence/proxy.json',
      'snapshots/state-after.json',
      'snapshots/state-before.json',
      'summary.json',
      'task.yaml',
      'target-index.json',
    ]) assert.match(checksums, new RegExp(`  ${path.replaceAll('.', '\\.')}(?:\\n|$)`));
  } finally {
    harness.close();
  }
});

test('replay classifies pass, behavioral violation, indeterminate evaluation, and infrastructure failure separately', {
  skip: process.platform === 'win32',
  timeout: 60_000,
}, async () => {
  const cases = [
    {
      profile: 'pass',
      status: 'PASS',
      exitCode: 0,
      classification: 'behaviorally-passed',
      counts: [1, 0, 0, 0],
    },
    {
      profile: 'violate',
      status: 'FAIL',
      exitCode: 2,
      classification: 'behaviorally-violated',
      counts: [0, 1, 0, 0],
    },
    {
      profile: 'indeterminate',
      status: 'INFRA',
      exitCode: 3,
      classification: 'indeterminate',
      counts: [0, 0, 0, 1],
    },
    {
      profile: 'infra',
      status: 'INFRA',
      exitCode: 3,
      classification: 'infrastructure-failed',
      counts: [0, 0, 1, 0],
    },
  ] as const;

  for (const expected of cases) {
    const harness = createHarness();
    try {
      const outcome = await replayContract(contract(1, 1), {
        taskPath: harness.taskPath,
        taskSource: harness.taskSource,
        profile: expected.profile,
        registry: harness.registry,
        store: harness.store,
        color: false,
        width: 80,
      });
      assert.equal(outcome.report.status, expected.status, expected.profile);
      assert.equal(outcome.report.exit_code, expected.exitCode, expected.profile);
      assert.equal(outcome.report.iterations[0]?.classification, expected.classification, expected.profile);
      assert.deepEqual([
        outcome.report.totals.behaviorally_passed,
        outcome.report.totals.behaviorally_failed,
        outcome.report.totals.infrastructure_failed,
        outcome.report.totals.indeterminate,
      ], expected.counts, expected.profile);
      assert.deepEqual({
        requested: outcome.report.totals.requested,
        completed: outcome.report.totals.completed,
        required_threshold: outcome.report.totals.required_threshold,
      }, { requested: 1, completed: 1, required_threshold: 1 });
      harness.store.verify(outcome.report.iterations[0]!.run_id);
    } finally {
      harness.close();
    }
  }
});

test('replay accounts for the exact 12-run, 10-pass tolerance boundary', {
  skip: process.platform === 'win32',
  timeout: 120_000,
}, async () => {
  const harness = createHarness();
  try {
    const outcome = await replayContract(contract(12, 10), {
      taskPath: harness.taskPath,
      taskSource: harness.taskSource,
      profile: 'edge',
      registry: harness.registry,
      store: harness.store,
      color: false,
      width: 80,
    });

    assert.equal(outcome.report.status, 'PASS');
    assert.equal(outcome.report.exit_code, 0);
    assert.deepEqual(outcome.report.totals, {
      requested: 12,
      completed: 12,
      behaviorally_passed: 10,
      behaviorally_failed: 2,
      infrastructure_failed: 0,
      indeterminate: 0,
      required_threshold: 10,
    });
    assert.deepEqual(
      outcome.report.iterations.map((iteration) => iteration.classification),
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
        'behaviorally-passed',
        'behaviorally-violated',
        'behaviorally-violated',
      ],
    );
    assert.match(outcome.human, /Requested runs:\s+12/);
    assert.match(outcome.human, /Behaviorally passed:\s+10/);
    assert.match(outcome.human, /Behaviorally failed:\s+2/);
    assert.match(outcome.human, /Required threshold:\s+10/);
    for (const iteration of outcome.report.iterations) harness.store.verify(iteration.run_id);
  } finally {
    harness.close();
  }
});

test('record registers a live task while replay preserves edited source and aggregates compatible profiles', {
  skip: process.platform === 'win32',
  timeout: 60_000,
}, async () => {
  const harness = createHarness();
  try {
    const passProfile = harness.task.agent_profiles.pass!;
    const initialTask: OculoryTaskConfig = {
      ...harness.task,
      agent_profiles: { pass: passProfile },
    };
    const initialSource = `# Initial task source retained by record.\n${stringify(initialTask, { lineWidth: 100, indent: 2 })}`;
    writeFileSync(harness.taskPath, initialSource, 'utf8');
    const recorded = await executeTaskRun(initialTask, {
      taskPath: harness.taskPath,
      taskSource: initialSource,
      profile: 'pass',
      registry: harness.registry,
      store: harness.store,
      timeoutMs: 15_000,
      registerTask: true,
    });
    const registrationPath = join(harness.store.taskRoot, `${initialTask.task_id}.json`);
    const registrationBeforeEdit = readFileSync(registrationPath, 'utf8');
    assert.equal(registrationBeforeEdit.includes(harness.root), false);
    assert.equal(readFileSync(join(harness.store.runPath(recorded.summary.run_id), 'task.yaml'), 'utf8'), initialSource);

    const baseline = await replayContract(contract(1, 1), {
      profile: 'pass',
      registry: harness.registry,
      store: harness.store,
      color: false,
      width: 80,
    });
    assert.deepEqual(baseline.report.profiles, [
      { profile: 'pass', status: 'PASS', passed: 1, requested: 1, threshold: 1 },
    ]);
    assert.equal(
      readFileSync(join(harness.store.runPath(baseline.report.iterations[0]!.run_id), 'task.yaml'), 'utf8'),
      initialSource,
    );

    const editedTask: OculoryTaskConfig = {
      ...initialTask,
      agent_profiles: {
        pass: passProfile,
        violate: harness.task.agent_profiles.violate!,
      },
    };
    const editedSource = `# Edited in place under the same task_id.\n${stringify(editedTask, { lineWidth: 100, indent: 2 })}`;
    writeFileSync(harness.taskPath, editedSource, 'utf8');
    const changed = await replayContract(contract(1, 1), {
      profile: 'violate',
      registry: harness.registry,
      store: harness.store,
      color: false,
      width: 80,
    });
    assert.equal(changed.report.status, 'FAIL');
    assert.deepEqual(changed.report.profiles, [
      { profile: 'pass', status: 'PASS', passed: 1, requested: 1, threshold: 1 },
      { profile: 'violate', status: 'FAIL', passed: 0, requested: 1, threshold: 1 },
    ]);
    assert.match(changed.human, /pass\s+PASS\s+\(1\/1 runs\)/);
    assert.match(changed.human, /violate\s+FAIL\s+\(0\/1 runs passed; threshold 1\)/);
    assert.equal(readFileSync(registrationPath, 'utf8'), registrationBeforeEdit);
    const changedRunId = changed.report.iterations[0]!.run_id;
    assert.equal(readFileSync(join(harness.store.runPath(changedRunId), 'task.yaml'), 'utf8'), editedSource);
    assert.deepEqual(
      harness.store.readJson<{ profiles: unknown }>(changedRunId, 'replay-context.json').profiles,
      changed.report.profiles,
    );
    const savedReportPath = join(
      harness.root,
      '.oculory',
      'replays',
      `replay_${changedRunId}_${changedRunId}_violate`,
      'report.json',
    );
    assert.deepEqual(JSON.parse(readFileSync(savedReportPath, 'utf8')), changed.report);
    for (const runId of [recorded.summary.run_id, baseline.report.iterations[0]!.run_id, changedRunId]) {
      harness.store.verify(runId);
    }
  } finally {
    harness.close();
  }
});

test('replay validates compatible report counts, iteration cardinality, and unique run IDs before allocating', {
  skip: process.platform === 'win32',
  timeout: 90_000,
}, async () => {
  const cases: Array<{
    label: string;
    runs: number;
    pattern: RegExp;
    mutate(report: ReplayReport): void;
  }> = [
    {
      label: 'contradictory totals',
      runs: 1,
      pattern: /invalid compatible replay report totals/,
      mutate: (report) => { report.totals.behaviorally_passed = 0; },
    },
    {
      label: 'contradictory status',
      runs: 1,
      pattern: /invalid compatible replay report status/,
      mutate: (report) => { report.status = 'FAIL'; },
    },
    {
      label: 'missing requested iteration',
      runs: 1,
      pattern: /invalid compatible replay report totals/,
      mutate: (report) => { report.iterations = []; },
    },
    {
      label: 'duplicate run IDs',
      runs: 2,
      pattern: /duplicate run ID/,
      mutate: (report) => { report.iterations[1]!.run_id = report.iterations[0]!.run_id; },
    },
  ];

  for (const entry of cases) {
    const harness = createHarness();
    try {
      const baseline = await replayContract(contract(entry.runs, entry.runs), {
        taskPath: harness.taskPath,
        taskSource: harness.taskSource,
        profile: 'pass',
        registry: harness.registry,
        store: harness.store,
      });
      const reportPath = savedReplayReportPath(harness, baseline.report);
      const allocatedBefore = publicRunIds(harness.store);
      entry.mutate(baseline.report);
      writeFileSync(reportPath, `${JSON.stringify(baseline.report, null, 2)}\n`, 'utf8');
      await assert.rejects(
        replayContract(contract(entry.runs, entry.runs), {
          taskPath: harness.taskPath,
          taskSource: harness.taskSource,
          profile: 'pass',
          registry: harness.registry,
          store: harness.store,
        }),
        entry.pattern,
        entry.label,
      );
      assert.deepEqual(publicRunIds(harness.store), allocatedBefore, entry.label);
    } finally {
      harness.close();
    }
  }
});

test('replay rejects mutable or unfinalized compatible reports before allocating', {
  skip: process.platform === 'win32',
  timeout: 60_000,
}, async () => {
  for (const mode of ['digest', 'path', 'unfinalized'] as const) {
    const harness = createHarness();
    try {
      const baseline = await replayContract(contract(1, 1), {
        taskPath: harness.taskPath,
        taskSource: harness.taskSource,
        profile: 'pass',
        registry: harness.registry,
        store: harness.store,
      });
      const allocatedBefore = publicRunIds(harness.store);
      if (mode === 'digest' || mode === 'path') {
        const reportPath = savedReplayReportPath(harness, baseline.report);
        const altered = mode === 'digest'
          ? { ...baseline.report, audit_note: 'unanchored mutation' }
          : { ...baseline.report, report_path: 'elsewhere/report.json' };
        writeFileSync(reportPath, `${JSON.stringify(altered, null, 2)}\n`, 'utf8');
      } else {
        rmSync(join(harness.store.runPath(baseline.report.iterations[0]!.run_id), 'checksums.sha256'));
      }
      await assert.rejects(
        replayContract(contract(1, 1), {
          taskPath: harness.taskPath,
          taskSource: harness.taskSource,
          profile: 'pass',
          registry: harness.registry,
          store: harness.store,
        }),
        mode === 'digest'
          ? /reference integrity failed/
          : mode === 'path'
            ? /paths do not match its saved files/
            : /references unfinalized run/,
      );
      assert.deepEqual(publicRunIds(harness.store), allocatedBefore);
    } finally {
      harness.close();
    }
  }
});

test('replay compatibility includes adapter IDs and versions', {
  skip: process.platform === 'win32',
  timeout: 60_000,
}, async () => {
  const harness = createHarness();
  try {
    const baseline = await replayContract(contract(1, 1), {
      taskPath: harness.taskPath,
      taskSource: harness.taskSource,
      profile: 'pass',
      registry: harness.registry,
      store: harness.store,
    });
    const upgradedRegistry = new AdapterRegistry();
    upgradedRegistry.register({ id: 'state-observer', version: '2.0.0', adapter: createStateAdapter() });
    const upgraded = await replayContract(contract(1, 1), {
      taskPath: harness.taskPath,
      taskSource: harness.taskSource,
      profile: 'violate',
      registry: upgradedRegistry,
      store: harness.store,
    });
    assert.notEqual(upgraded.report.compatibility_id, baseline.report.compatibility_id);
    assert.deepEqual(upgraded.report.profiles, [
      { profile: 'violate', status: 'FAIL', passed: 0, requested: 1, threshold: 1 },
    ]);
  } finally {
    harness.close();
  }
});

test('replay reuses unchanged profile results but rejects stale history for a changed profile definition', {
  skip: process.platform === 'win32',
  timeout: 60_000,
}, async () => {
  const harness = createHarness();
  try {
    const baseline = await replayContract(contract(1, 1), {
      taskPath: harness.taskPath,
      taskSource: harness.taskSource,
      profile: 'pass',
      registry: harness.registry,
      store: harness.store,
    });
    const editedTask: OculoryTaskConfig = {
      ...harness.task,
      agent_profiles: {
        ...harness.task.agent_profiles,
        pass: {
          ...harness.task.agent_profiles.pass!,
          argv: [...harness.task.agent_profiles.pass!.argv, '--changed-profile-definition'],
        },
      },
    };
    const editedSource = stringify(editedTask, { lineWidth: 100, indent: 2 });
    writeFileSync(harness.taskPath, editedSource, 'utf8');
    const changed = await replayContract(contract(1, 1), {
      taskPath: harness.taskPath,
      taskSource: editedSource,
      profile: 'violate',
      registry: harness.registry,
      store: harness.store,
    });
    assert.equal(changed.report.compatibility_id, baseline.report.compatibility_id);
    assert.deepEqual(changed.report.profiles, [
      { profile: 'violate', status: 'FAIL', passed: 0, requested: 1, threshold: 1 },
    ]);
    assert.notEqual(changed.report.profile_definition_id, baseline.report.profile_definition_id);
  } finally {
    harness.close();
  }
});

test('replay refuses a symlinked history directory before allocating a run', {
  skip: process.platform === 'win32',
  timeout: 30_000,
}, async () => {
  const harness = createHarness();
  const external = join(harness.root, 'external-replay-history');
  try {
    mkdirSync(external);
    const replayRoot = join(harness.root, '.oculory', 'replays');
    symlinkSync(external, replayRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const before = publicRunIds(harness.store);
    await assert.rejects(
      replayContract(contract(1, 1), {
        taskPath: harness.taskPath,
        taskSource: harness.taskSource,
        profile: 'pass',
        registry: harness.registry,
        store: harness.store,
      }),
      /replay history must be a real directory inside the public Oculory root/,
    );
    assert.deepEqual(publicRunIds(harness.store), before);
    assert.deepEqual(readdirSync(external), []);
  } finally {
    harness.close();
  }
});

test('replay history inspection is bounded before run allocation', {
  skip: process.platform === 'win32',
  timeout: 30_000,
}, async () => {
  const harness = createHarness();
  try {
    const root = join(harness.root, '.oculory', 'replays');
    for (let index = 0; index < 257; index++) {
      const directory = join(root, `replay_history_${String(index).padStart(4, '0')}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'report.json'), '{}\n', 'utf8');
    }
    await assert.rejects(
      replayContract(contract(1, 1), {
        taskPath: harness.taskPath,
        taskSource: harness.taskSource,
        profile: 'pass',
        registry: harness.registry,
        store: harness.store,
      }),
      /256-report inspection limit/,
    );
    assert.equal(existsSync(harness.store.root), false);
  } finally {
    harness.close();
  }
});

test('replay rejects missing profiles and contract targets before allocating a run', {
  skip: process.platform === 'win32',
}, async () => {
  const harness = createHarness();
  try {
    harness.store.registerTask(harness.task.task_id, harness.taskPath, harness.taskSource);
    await assert.rejects(
      replayContract(contract(1, 1), {
        profile: 'missing-profile',
        registry: harness.registry,
        store: harness.store,
      }),
      /task has no agent profile 'missing-profile'/,
    );
    const missingTarget = contract(1, 1);
    missingTarget.assertions = [{ ...missingTarget.assertions[0]!, target: 'missing-target' }];
    await assert.rejects(
      replayContract(missingTarget, {
        profile: 'pass',
        registry: harness.registry,
        store: harness.store,
      }),
      /contract references missing task target: 'missing-target'/,
    );
    assert.equal(existsSync(harness.store.root), false);
  } finally {
    harness.close();
  }
});

test('replay evaluates subset mode and excludes ignore mode from behavioral failure accounting', {
  skip: process.platform === 'win32',
  timeout: 60_000,
}, async () => {
  const subsetHarness = createHarness();
  try {
    const subsetContract = contract(1, 1);
    subsetContract.assertions = [{
      ...subsetContract.assertions[0]!,
      selector: { kind: 'value_tokens' },
      operator: 'subset',
      expected: ['good'],
      evaluation: 'subset',
    }];
    const subset = await replayContract(subsetContract, {
      taskPath: subsetHarness.taskPath,
      taskSource: subsetHarness.taskSource,
      profile: 'pass',
      registry: subsetHarness.registry,
      store: subsetHarness.store,
      color: false,
      width: 80,
    });
    assert.equal(subset.report.status, 'PASS');
    assert.equal(subset.report.iterations[0]?.assertions[0]?.result?.evaluationMode, 'subset');
    assert.deepEqual(subset.report.iterations[0]?.assertions[0]?.result?.observed, ['good', 'stable']);
  } finally {
    subsetHarness.close();
  }

  const ignoreHarness = createHarness();
  try {
    const ignoreContract = contract(1, 1);
    ignoreContract.assertions = [{ ...ignoreContract.assertions[0]!, evaluation: 'ignore' }];
    const ignored = await replayContract(ignoreContract, {
      taskPath: ignoreHarness.taskPath,
      taskSource: ignoreHarness.taskSource,
      profile: 'violate',
      registry: ignoreHarness.registry,
      store: ignoreHarness.store,
      color: false,
      width: 80,
    });
    assert.equal(ignored.report.status, 'PASS');
    assert.equal(ignored.report.totals.behaviorally_failed, 0);
    assert.equal(ignored.report.iterations[0]?.assertions[0]?.result?.ignored, true);
  } finally {
    ignoreHarness.close();
  }
});

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'oculory-mlp-harness-'));
  const fixturePath = join(root, 'fixture.mjs');
  const serverPath = join(root, 'server.mjs');
  const agentPath = join(root, 'agent.mjs');
  const taskPath = join(root, 'task.yaml');
  mkdirSync(join(root, '.oculory'), { recursive: true });
  writeFileSync(fixturePath, fixtureSource(), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(serverPath, serverSource(), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(agentPath, agentSource(), { encoding: 'utf8', mode: 0o600 });

  const profile = (mode: string): OculoryTaskConfig['agent_profiles'][string] => ({
    argv: [process.execPath, agentPath, '--mcp-config', '{mcp_config}', '--mode', mode, '--run-id', '{run_id}'],
    env_allowlist: safeEnvironmentNames(),
  });
  const task: OculoryTaskConfig = {
    version: 'oculory-task-v1',
    task_id: 'local-state-transition',
    prompt: 'Set the disposable state to good.',
    agent_profiles: {
      edge: profile('edge'),
      indeterminate: profile('indeterminate'),
      infra: profile('infra'),
      pass: profile('pass'),
      violate: profile('violate'),
    },
    mcp_server: {
      command: process.execPath,
      arguments: [serverPath, '--workspace', '{workspace}'],
      env_allowlist: safeEnvironmentNames(),
    },
    workspace: {
      strategy: 'command',
      setup: [process.execPath, fixturePath, 'setup', '{workspace}'],
      reset: [process.execPath, fixturePath, 'reset', '{workspace}'],
      cleanup: [process.execPath, fixturePath, 'cleanup', '{workspace}'],
    },
    targets: [{
      id: 'state',
      adapter: 'state-observer',
      configuration: { location: '{workspace}/state.json' },
      watch: { field: 'value' },
    }],
    claim_extraction: { type: 'line-prefix', prefix: 'CLAIM: ' },
  };
  const taskSource = stringify(task, { lineWidth: 100, indent: 2 });
  writeFileSync(taskPath, taskSource, { encoding: 'utf8', mode: 0o600 });
  const registry = new AdapterRegistry();
  registry.register({ id: 'state-observer', version: '1.0.0', adapter: createStateAdapter() });
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

function contract(runs: number, minPass: number): OculoryContractConfig {
  return {
    version: 'oculory-contract-v1',
    task: 'local-state-transition',
    tolerance: { runs, min_pass: minPass },
    assertions: [{
      id: 'state-is-good',
      target: 'state',
      selector: { kind: 'value' },
      operator: 'equals',
      expected: 'good',
      evaluation: 'exact',
    }],
  };
}

function savedReplayReportPath(harness: Harness, report: ReplayReport): string {
  const first = report.iterations[0]!.run_id;
  const last = report.iterations.at(-1)!.run_id;
  return join(harness.root, '.oculory', 'replays', `replay_${first}_${last}_${report.profile}`, 'report.json');
}

function publicRunIds(store: PublicRunStore): string[] {
  return existsSync(store.root) ? readdirSync(store.root).filter((name) => /^run_[0-9]{4,}$/.test(name)).sort() : [];
}

function createStateAdapter(): OculoryAdapter<
  StateConfiguration,
  StateConfiguration,
  StateSnapshot,
  StateSnapshot,
  StateDiff
> {
  return {
    validateConfiguration(value: unknown): StateConfiguration {
      const input = object(value);
      if (typeof input.location !== 'string') throw new Error('state location is required');
      return { location: input.location };
    },
    async prepare(configuration): Promise<StateConfiguration> {
      return configuration;
    },
    async snapshotBefore(prepared): Promise<StateSnapshot> {
      return readState(prepared.location);
    },
    async snapshotAfter(prepared): Promise<StateSnapshot> {
      return readState(prepared.location);
    },
    normalizeSnapshot(snapshot): StateSnapshot {
      return { value: snapshot.value };
    },
    diff(before, after): StateDiff {
      return { changed: before.value !== after.value, before: before.value, after: after.value };
    },
    evaluateAssertion(assertion, _before, after): AdapterAssertionResult {
      if (after.value === 'indeterminate') throw new Error('synthetic local observation is indeterminate');
      const expected = assertion.expected ?? null;
      const ignored = assertion.evaluationMode === 'ignore';
      const valueTokens = assertion.selector.kind === 'value_tokens' && assertion.operator === 'subset';
      const exactValue = assertion.selector.kind === 'value' && assertion.operator === 'equals';
      if (!valueTokens && !exactValue) throw new Error('unsupported state assertion');
      const observed = valueTokens ? [after.value, 'stable'] : after.value;
      const passed = ignored || (valueTokens
        ? Array.isArray(expected) && expected.every((entry) => observed.includes(entry as string))
        : expected === after.value);
      return {
        assertionId: assertion.id,
        passed,
        ignored,
        operator: assertion.operator,
        evaluationMode: assertion.evaluationMode,
        expected,
        observed,
        detail: passed ? 'state matched' : `state was ${after.value}`,
      };
    },
    async reset(): Promise<AdapterOperationResult> {
      return { passed: true, detail: 'disposable state reset by workspace strategy' };
    },
    async cleanup(): Promise<AdapterOperationResult> {
      return { passed: true, detail: 'state adapter holds no external resources' };
    },
    describeViolation(_assertion: AdapterAssertion, result: AdapterAssertionResult): string {
      return `value violated: ${result.detail}`;
    },
    redact(value: unknown): AdapterJson {
      return JSON.parse(JSON.stringify(value)) as AdapterJson;
    },
  };
}

function readState(path: string): StateSnapshot {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const state = object(value);
  if (typeof state.value !== 'string') throw new Error('invalid disposable state');
  return { value: state.value };
}

function safeEnvironmentNames(): string[] {
  return ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'].filter((name) => process.env[name] !== undefined);
}

function fixtureSource(): string {
  return `
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [mode, workspace] = process.argv.slice(2);
if (!['setup', 'reset', 'cleanup'].includes(mode) || workspace === undefined) throw new Error('invalid fixture argv');
if (mode !== 'cleanup') writeFileSync(resolve(workspace, 'state.json'), '{"value":"initial"}\\n', 'utf8');
`;
}

function serverSource(): string {
  return `
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
const index = process.argv.indexOf('--workspace');
const workspace = index >= 0 ? process.argv[index + 1] : undefined;
if (workspace === undefined) throw new Error('workspace is required');
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: '2024-11-05', capabilities: { tools: {} },
    serverInfo: { name: 'local-state-server', version: '1.0.0' },
  };
  else if (request.method === 'tools/list') result = { tools: [{
    name: 'set_state', description: 'Set disposable local state.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } },
  }] };
  else if (request.method === 'tools/call') {
    const value = request.params?.arguments?.value;
    if (request.params?.name !== 'set_state' || typeof value !== 'string') throw new Error('invalid tool call');
    writeFileSync(resolve(workspace, 'state.json'), JSON.stringify({ value }) + '\\n', 'utf8');
    result = { content: [{ type: 'text', text: 'state set' }], isError: false };
  } else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
}
`;
}

function agentSource(): string {
  return `
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(name + ' is required');
  return process.argv[index + 1];
};
const mode = option('--mode');
const runId = option('--run-id');
if (mode === 'infra') {
  process.stderr.write('synthetic local infrastructure failure\\n');
  process.exitCode = 7;
} else {
  const parsed = JSON.parse(readFileSync(option('--mcp-config'), 'utf8'));
  const server = parsed.mcpServers.oculory;
  const child = spawn(server.command, server.args, { cwd: process.cwd(), env: process.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const pending = new Map();
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter !== undefined) {
      pending.delete(response.id);
      clearTimeout(waiter.timer);
      if (response.error !== undefined) waiter.reject(new Error(response.error.message));
      else waiter.resolve(response.result);
    }
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 8000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'local-agent', version: '1.0.0' } });
  await rpc('tools/list', {});
  const number = Number(/^run_(\\d+)$/.exec(runId)?.[1] ?? NaN);
  const value = mode === 'pass' || mode === 'edge' && number <= 10 ? 'good' : mode === 'indeterminate' ? 'indeterminate' : 'bad';
  await rpc('tools/call', { name: 'set_state', arguments: { value } });
  child.stdin.end();
  const outcome = await exit;
  if (outcome.code !== 0) throw new Error('proxy exited abnormally: ' + stderr);
  process.stdout.write('CLAIM: completed ' + mode + '\\n');
}
`;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
