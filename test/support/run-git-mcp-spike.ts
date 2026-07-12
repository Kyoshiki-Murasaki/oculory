import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalJson, hashJson } from '../../src/schema/canonical.js';
import type { Json, JsonObject } from '../../src/schema/types.js';
import {
  EXPECTED_GIT_TOOL_ORDER,
  GIT_SPIKE_TARGET,
  inspectGitSpikeRuntime,
  type GitSpikeRuntimeInspection,
} from '../../src/targets/git-spike/config.js';
import {
  applyFixtureEdit,
  cleanupGitSpikeFixture,
  createGitSpikeFixture,
  stageFixturePath,
  type GitSpikeFixture,
} from '../../src/targets/git-spike/fixture.js';
import {
  classifyStateDiff,
  runGitSpikeTrial,
  type GitSpikeCallSpec,
  type GitSpikeTrialExecution,
  type GitSpikeTrialPlan,
} from '../../src/targets/git-spike/direct-harness.js';
import {
  captureGitSpikeSnapshot,
  changedIndexPaths,
  changedRefNames,
  snapshotIndexMatchesCommit,
  snapshotWorktreeMatchesCommit,
  type GitSpikeSnapshot,
  type GitSpikeSnapshotLayer,
} from '../../src/targets/git-spike/snapshot.js';

interface Arguments {
  pythonExecutable: string;
  targetExecutable: string;
  gitExecutable: string;
  lockPath: string;
  outputPath: string;
  trials: number;
}

interface TrialAssessment {
  passed: boolean;
  reasons: string[];
  semanticSignature: string;
}

interface AssessedExecution {
  execution: GitSpikeTrialExecution;
  assessment: TrialAssessment;
}

interface GroupStability {
  planName: string;
  trialCount: number;
  semanticStable: boolean;
  semanticSignature: string | null;
  tokenizedTranscriptStable: boolean;
  rawTranscriptStable: boolean;
  differenceClassification: Array<{
    field: string;
    classification: 'semantic' | 'presentation-only' | 'environment-derived' | 'unexplained';
    detail: string;
  }>;
}

interface SpikeReport {
  schema: 'oculory-git-gate-ab-temporary-spike-v1';
  generatedAt: string;
  oculorySource: { head: string; dirty: boolean };
  host: {
    os: string;
    osRelease: string;
    architecture: string;
    nodeVersion: string;
  };
  runtime: GitSpikeRuntimeInspection & {
    lockPath: string;
    lockFileSha256: string;
  };
  target: typeof GIT_SPIKE_TARGET;
  expectedToolOrder: readonly string[];
  trialCountPerPlan: number;
  planCount: number;
  executions: AssessedExecution[];
  stability: GroupStability[];
  witness: {
    expectedStateHash: string;
    observedStateHash: string;
    reproducible: boolean;
    cleanupPassed: boolean;
  } | null;
  parentClean: boolean;
  gateBSpikePassed: boolean;
  reportSha256?: string;
}

const PLANS: readonly GitSpikeTrialPlan[] = [
  {
    name: 'read_only',
    calls: (fixture): readonly GitSpikeCallSpec[] => [
      { tool: 'git_status' },
      { tool: 'git_log', arguments: { max_count: 2 } },
      { tool: 'git_show', arguments: { revision: fixture.mainHead } },
    ],
  },
  {
    name: 'stage',
    prepare: (fixture) => applyFixtureEdit(
      fixture,
      'README.md',
      '# Oculory Git spike\n\nDeterministic staged Gate B edit.\n',
    ),
    calls: (): readonly GitSpikeCallSpec[] => [
      { tool: 'git_diff_unstaged' },
      { tool: 'git_add', arguments: { files: ['README.md'] } },
      { tool: 'git_diff_staged' },
    ],
  },
  {
    name: 'reset',
    prepare: (fixture) => {
      applyFixtureEdit(fixture, 'docs/rollback.md', 'Rollback procedure with staged Gate B edit.\n');
      stageFixturePath(fixture, 'docs/rollback.md');
    },
    calls: (): readonly GitSpikeCallSpec[] => [
      { tool: 'git_diff_staged' },
      { tool: 'git_reset' },
      { tool: 'git_diff_unstaged' },
    ],
  },
  {
    name: 'branch_create',
    calls: (): readonly GitSpikeCallSpec[] => [
      { tool: 'git_branch', arguments: { branch_type: 'local' } },
      { tool: 'git_create_branch', arguments: { branch_name: 'feature/parser', base_branch: 'main' } },
    ],
  },
  {
    name: 'checkout',
    calls: (): readonly GitSpikeCallSpec[] => [
      { tool: 'git_branch', arguments: { branch_type: 'local' } },
      { tool: 'git_checkout', arguments: { branch_name: 'feature/seed' } },
    ],
  },
  rejectionPlan('reject_missing_revision', (fixture) => ({
    tool: 'git_show',
    arguments: { revision: 'ghost-revision' },
  })),
  rejectionPlan('reject_malformed_add', () => ({
    tool: 'git_add',
    arguments: { files: 'README.md' },
  })),
  rejectionPlan('reject_existing_branch', () => ({
    tool: 'git_create_branch',
    arguments: { branch_name: 'feature/seed', base_branch: 'main' },
  })),
  rejectionPlan('reject_add_traversal', () => ({
    tool: 'git_add',
    arguments: { files: ['../sibling/sentinel.txt'] },
  })),
  rejectionPlan('reject_nonfixture_repo_path', (fixture) => ({
    tool: 'git_status',
    arguments: { repo_path: fixture.siblingRepositoryRoot },
    reviewedNonFixtureRepositoryPath: true,
    reviewedBoundaryReason: 'nonfixture_repo_path_probe',
  })),
];

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const lockFileSha256 = sha256File(args.lockPath);
  if (lockFileSha256 !== GIT_SPIKE_TARGET.lockSha256) {
    throw new Error(
      `lock file digest mismatch: expected ${GIT_SPIKE_TARGET.lockSha256}, observed ${lockFileSha256}`,
    );
  }
  const runtime = inspectGitSpikeRuntime({
    pythonExecutable: args.pythonExecutable,
    targetExecutable: args.targetExecutable,
    gitExecutable: args.gitExecutable,
    lockSha256: lockFileSha256,
  });
  const source = readOculorySourceState(runtime.gitExecutable);
  const baseDirectory = mkdtempSync(join(tmpdir(), 'oculory-git-gate-ab-'));
  const executions: AssessedExecution[] = [];
  let witness: SpikeReport['witness'] = null;
  let parentClean = false;

  try {
    for (const plan of PLANS) {
      for (let trial = 1; trial <= args.trials; trial += 1) {
        const trialId = `${plan.name}-${String(trial).padStart(2, '0')}`;
        const execution = await runGitSpikeTrial({
          baseDirectory,
          trialId,
          runtime,
          plan,
        });
        executions.push({ execution, assessment: assessExecution(execution) });
      }
    }

    const expectedStateHash = executions
      .find((entry) => entry.execution.planName === 'read_only')
      ?.execution.journal.find((entry) => entry.stage === 'fixture_created')
      ?.snapshot.stateHash;
    if (expectedStateHash === undefined) throw new Error('read-only fixture state was not retained for witness comparison');
    witness = runWitness(baseDirectory, runtime.gitExecutable, expectedStateHash);
    parentClean = readdirSync(baseDirectory).length === 0;

    const stability = PLANS.map((plan) => assessGroupStability(
      plan.name,
      executions.filter((entry) => entry.execution.planName === plan.name),
    ));
    const gateBSpikePassed =
      executions.length === PLANS.length * args.trials &&
      executions.every((entry) => entry.assessment.passed) &&
      stability.every((entry) => entry.semanticStable && entry.tokenizedTranscriptStable) &&
      witness.reproducible &&
      witness.cleanupPassed &&
      parentClean;

    const report: SpikeReport = {
      schema: 'oculory-git-gate-ab-temporary-spike-v1',
      generatedAt: new Date().toISOString(),
      oculorySource: source,
      host: {
        os: platform(),
        osRelease: release(),
        architecture: arch(),
        nodeVersion: process.version,
      },
      runtime: { ...runtime, lockPath: args.lockPath, lockFileSha256 },
      target: GIT_SPIKE_TARGET,
      expectedToolOrder: EXPECTED_GIT_TOOL_ORDER,
      trialCountPerPlan: args.trials,
      planCount: PLANS.length,
      executions,
      stability,
      witness,
      parentClean,
      gateBSpikePassed,
    };
    const withoutDigest = JSON.stringify(report, null, 2);
    report.reportSha256 = createHash('sha256').update(withoutDigest, 'utf8').digest('hex');
    writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'w',
    });
    process.stdout.write(`${JSON.stringify({
      gate_b_spike_passed: gateBSpikePassed,
      plans: PLANS.length,
      trials_per_plan: args.trials,
      sessions: executions.length,
      output: args.outputPath,
      report_sha256: report.reportSha256,
    })}\n`);
    if (!gateBSpikePassed) process.exitCode = 1;
  } finally {
    rmSync(baseDirectory, { recursive: true, force: true });
  }
}

function rejectionPlan(
  name: string,
  call: (fixture: GitSpikeFixture) => GitSpikeCallSpec,
): GitSpikeTrialPlan {
  return { name, calls: (fixture) => [call(fixture)] };
}

function assessExecution(execution: GitSpikeTrialExecution): TrialAssessment {
  const reasons = baseReasons(execution);
  const calls = execution.calls;
  const beforeStart = snapshot(execution, 'before_server_start');
  const final = snapshot(execution, 'after_final_response');
  const afterShutdown = snapshot(execution, 'after_server_shutdown');

  if (beforeStart !== null && afterShutdown !== null && execution.planName !== 'checkout' && execution.planName !== 'branch_create' && execution.planName !== 'stage' && execution.planName !== 'reset') {
    requireCondition(beforeStart.stateHash === afterShutdown.stateHash, 'final state differs for an unchanged-state plan', reasons);
  }

  switch (execution.planName) {
    case 'read_only':
      requireTools(calls, ['git_status', 'git_log', 'git_show'], reasons);
      requireCallClasses(calls, ['tool_success', 'tool_success', 'tool_success'], reasons);
      requireCallLayers(calls, ['unchanged', 'unchanged', 'unchanged'], reasons);
      break;
    case 'stage':
      assessStage(execution, reasons);
      break;
    case 'reset':
      assessReset(execution, reasons);
      break;
    case 'branch_create':
      assessBranchCreate(execution, reasons);
      break;
    case 'checkout':
      assessCheckout(execution, reasons);
      break;
    default:
      if (execution.planName.startsWith('reject_')) assessRejection(execution, reasons);
      else reasons.push(`unknown plan assessment: ${execution.planName}`);
  }

  if (beforeStart !== null && final !== null) {
    requireCondition(
      beforeStart.siblingBoundary.sentinel.sha256 === final.siblingBoundary.sentinel.sha256,
      'sibling sentinel bytes changed',
      reasons,
    );
    requireCondition(
      canonicalJson(beforeStart.siblingBoundary as unknown as Json) ===
        canonicalJson(final.siblingBoundary as unknown as Json),
      'sibling repository boundary state changed',
      reasons,
    );
  }

  const semanticSignature = hashJson(buildSemanticSignature(execution));
  return { passed: reasons.length === 0, reasons, semanticSignature };
}

function baseReasons(execution: GitSpikeTrialExecution): string[] {
  const reasons: string[] = [];
  requireCondition(execution.errors.length === 0, `harness errors: ${execution.errors.join('; ')}`, reasons);
  requireCondition(execution.initialization !== null, 'initialization evidence is absent', reasons);
  requireCondition(execution.discovery !== null, 'discovery evidence is absent', reasons);
  requireCondition(execution.discovery?.pageCount === 1, 'discovery was not the expected single page', reasons);
  requireCondition(
    canonicalJson(execution.discovery?.toolNames ?? []) === canonicalJson([...EXPECTED_GIT_TOOL_ORDER]),
    'discovered tool inventory/order differs from the pinned expectation',
    reasons,
  );
  requireCondition(execution.transcript.unexpectedStdout === false, 'protocol stdout contained invalid data', reasons);
  requireCondition(execution.shutdown.observed, 'shutdown was not observed', reasons);
  requireCondition(execution.shutdown.graceful, 'shutdown was not graceful', reasons);
  requireCondition(execution.shutdown.escalation === 'none', 'shutdown escalated', reasons);
  requireCondition(execution.shutdown.exitCode === 0, 'target did not exit with code 0', reasons);
  requireCondition(execution.shutdown.signal === null, 'target exited by signal', reasons);
  requireCondition(!execution.shutdown.childAlive, 'target child remained alive', reasons);
  requireCondition(execution.shutdown.managedProcessGroupAlive !== true, 'managed process group remained alive', reasons);
  requireCondition(execution.shutdown.allRequestsSettled, 'request remained unsettled at shutdown', reasons);
  requireCondition(!execution.shutdown.emergencyCleanupUsed, 'emergency cleanup was required', reasons);
  requireCondition(execution.cleanup.passed, 'cleanup proof failed', reasons);
  requireCondition(execution.transcript.stderrByteCount <= 1024 * 1024, 'stderr exceeded its cap', reasons);

  const beforeStart = journalEntry(execution, 'before_server_start');
  const afterInitialize = journalEntry(execution, 'after_server_start_and_initialize');
  const afterDiscovery = journalEntry(execution, 'after_tool_discovery');
  const afterFinal = journalEntry(execution, 'after_final_response');
  const afterShutdown = journalEntry(execution, 'after_server_shutdown');
  const beforeCleanup = journalEntry(execution, 'before_cleanup');
  for (const [label, entry] of [
    ['before_server_start', beforeStart],
    ['after_server_start_and_initialize', afterInitialize],
    ['after_tool_discovery', afterDiscovery],
    ['after_final_response', afterFinal],
    ['after_server_shutdown', afterShutdown],
    ['before_cleanup', beforeCleanup],
  ] as const) {
    requireCondition(entry !== null, `journal stage missing: ${label}`, reasons);
  }
  if (beforeStart !== null && afterInitialize !== null) {
    requireCondition(
      beforeStart.snapshot.stateHash === afterInitialize.snapshot.stateHash,
      'server startup/initialize changed repository state',
      reasons,
    );
  }
  if (afterInitialize !== null && afterDiscovery !== null) {
    requireCondition(
      afterInitialize.snapshot.stateHash === afterDiscovery.snapshot.stateHash,
      'tool discovery changed repository state',
      reasons,
    );
  }
  if (afterFinal !== null && afterShutdown !== null) {
    requireCondition(
      afterFinal.snapshot.stateHash === afterShutdown.snapshot.stateHash,
      'server shutdown changed repository state',
      reasons,
    );
  }
  if (afterShutdown !== null && beforeCleanup !== null) {
    requireCondition(
      afterShutdown.snapshot.stateHash === beforeCleanup.snapshot.stateHash,
      'state changed between shutdown and cleanup',
      reasons,
    );
  }
  return reasons;
}

function assessStage(execution: GitSpikeTrialExecution, reasons: string[]): void {
  const calls = execution.calls;
  requireTools(calls, ['git_diff_unstaged', 'git_add', 'git_diff_staged'], reasons);
  requireCallClasses(calls, ['tool_success', 'tool_success', 'tool_success'], reasons);
  requireCallLayers(calls, ['unchanged', ['status', 'index', 'objects'], 'unchanged'], reasons);
  const add = calls[1];
  if (add !== undefined) {
    const before = execution.journal[add.beforeSnapshotIndex]?.snapshot;
    const after = execution.journal[add.afterSnapshotIndex]?.snapshot;
    if (before !== undefined && after !== undefined) {
      requireCondition(
        canonicalJson(changedIndexPaths(before, after)) === canonicalJson(['README.md']),
        'git_add changed an unexpected index path',
        reasons,
      );
      requireCondition(fileDigest(before, 'README.md') === fileDigest(after, 'README.md'), 'git_add changed worktree bytes', reasons);
      const index = after.index.find((entry) => entry.path === 'README.md' && entry.stage === 0);
      requireCondition(index?.blobSha256 === fileDigest(after, 'README.md'), 'staged README blob does not match worktree bytes', reasons);
      requireCondition(before.headObjectId === after.headObjectId, 'git_add changed HEAD', reasons);
      requireCondition(changedRefNames(before, after).length === 0, 'git_add changed a ref', reasons);
    }
  }
}

function assessReset(execution: GitSpikeTrialExecution, reasons: string[]): void {
  const calls = execution.calls;
  requireTools(calls, ['git_diff_staged', 'git_reset', 'git_diff_unstaged'], reasons);
  requireCallClasses(calls, ['tool_success', 'tool_success', 'tool_success'], reasons);
  requireCallLayers(calls, ['unchanged', ['status', 'index'], 'unchanged'], reasons);
  const reset = calls[1];
  if (reset !== undefined) {
    const before = execution.journal[reset.beforeSnapshotIndex]?.snapshot;
    const after = execution.journal[reset.afterSnapshotIndex]?.snapshot;
    if (before !== undefined && after !== undefined) {
      requireCondition(
        canonicalJson(changedIndexPaths(before, after)) === canonicalJson(['docs/rollback.md']),
        'git_reset changed an unexpected index path',
        reasons,
      );
      requireCondition(after.indexMatchesHead, 'git_reset did not restore index to HEAD', reasons);
      requireCondition(snapshotIndexMatchesCommit(after, after.headObjectId), 'post-reset index does not match HEAD tree', reasons);
      requireCondition(
        fileDigest(before, 'docs/rollback.md') === fileDigest(after, 'docs/rollback.md'),
        'git_reset changed edited worktree bytes',
        reasons,
      );
    }
  }
}

function assessBranchCreate(execution: GitSpikeTrialExecution, reasons: string[]): void {
  const calls = execution.calls;
  requireTools(calls, ['git_branch', 'git_create_branch'], reasons);
  requireCallClasses(calls, ['tool_success', 'tool_success'], reasons);
  requireCallLayers(calls, ['unchanged', ['head_and_refs']], reasons);
  const final = snapshot(execution, 'after_final_response');
  const before = snapshot(execution, 'before_server_start');
  if (before !== null && final !== null) {
    requireCondition(
      canonicalJson(changedRefNames(before, final)) === canonicalJson(['refs/heads/feature/parser']),
      'branch creation changed an unexpected ref set',
      reasons,
    );
    requireCondition(
      final.refs.find((entry) => entry.name === 'refs/heads/feature/parser')?.objectId === execution.fixture.mainHead,
      'new branch does not target the expected main HEAD',
      reasons,
    );
    requireCondition(final.symbolicBranch === 'main', 'branch creation switched symbolic HEAD', reasons);
    requireCondition(final.headObjectId === execution.fixture.mainHead, 'branch creation changed HEAD commit', reasons);
    requireCondition(before.layerHashes.worktree === final.layerHashes.worktree, 'branch creation changed worktree', reasons);
    requireCondition(before.layerHashes.index === final.layerHashes.index, 'branch creation changed index', reasons);
  }
}

function assessCheckout(execution: GitSpikeTrialExecution, reasons: string[]): void {
  const calls = execution.calls;
  requireTools(calls, ['git_branch', 'git_checkout'], reasons);
  requireCallClasses(calls, ['tool_success', 'tool_success'], reasons);
  requireCallLayers(calls, ['unchanged', ['worktree', 'status', 'index', 'head_and_refs', 'reflogs', 'isolation']], reasons);
  const final = snapshot(execution, 'after_final_response');
  const before = snapshot(execution, 'before_server_start');
  if (before !== null && final !== null) {
    requireCondition(changedRefNames(before, final).length === 0, 'checkout changed ref targets', reasons);
    requireCondition(final.symbolicBranch === 'feature/seed', 'checkout did not select feature/seed', reasons);
    requireCondition(final.headObjectId === execution.fixture.featureSeedHead, 'checkout selected unexpected commit', reasons);
    requireCondition(snapshotIndexMatchesCommit(final, execution.fixture.featureSeedHead), 'checkout index does not match feature tree', reasons);
    requireCondition(snapshotWorktreeMatchesCommit(final, execution.fixture.featureSeedHead), 'checkout worktree does not match feature tree', reasons);
    requireCondition(before.layerHashes.objects === final.layerHashes.objects, 'checkout changed object inventory', reasons);
    requireCondition(canonicalJson(before.config as unknown as Json) === canonicalJson(final.config as unknown as Json), 'checkout changed local Git config', reasons);
    requireCondition(canonicalJson(before.remotes) === canonicalJson(final.remotes), 'checkout changed remotes', reasons);
    requireCondition(before.hooksPath === final.hooksPath, 'checkout changed hooks path', reasons);
    requireCondition(canonicalJson(before.hooks as unknown as Json) === canonicalJson(final.hooks as unknown as Json), 'checkout changed hooks', reasons);
    requireCondition(canonicalJson(before.submodules) === canonicalJson(final.submodules), 'checkout changed submodules', reasons);
    requireCondition(before.alternates === final.alternates, 'checkout changed alternates', reasons);
    requireCondition(
      canonicalJson(final.worktrees) === canonicalJson([
        'worktree <FIXTURE_ROOT>',
        `HEAD ${execution.fixture.featureSeedHead}`,
        'branch refs/heads/feature/seed',
      ]),
      'checkout worktree-list evidence differs from the selected branch',
      reasons,
    );
  }
}

function assessRejection(execution: GitSpikeTrialExecution, reasons: string[]): void {
  requireCondition(execution.calls.length === 1, 'rejection probe did not issue exactly one call', reasons);
  const call = execution.calls[0];
  if (call === undefined) return;
  requireCondition(
    call.outcomeClass === 'tool_error' || call.outcomeClass === 'json_rpc_error',
    `rejection probe returned ${call.outcomeClass}`,
    reasons,
  );
  requireCondition(classifyStateDiff(call.stateDiff, 'unchanged') === 'unchanged', 'rejection probe changed state', reasons);
  requireCondition(call.rawResponseDigest !== null, 'rejection probe lost raw response digest', reasons);
  requireCondition(call.responseRawLineDigest !== null, 'rejection probe lost raw wire-frame digest', reasons);
  requireCondition(Object.keys(call.rawOutcome).length > 0, 'rejection probe lost raw structured outcome', reasons);
}

function assessGroupStability(planName: string, entries: AssessedExecution[]): GroupStability {
  const semanticSignatures = new Set(entries.map((entry) => entry.assessment.semanticSignature));
  const semanticTranscriptDigests = new Set(entries.map((entry) => entry.execution.transcript.semanticDigest));
  const rawTranscriptDigests = new Set(entries.map((entry) => entry.execution.transcript.digest));
  const differences: GroupStability['differenceClassification'] = [];
  if (rawTranscriptDigests.size > 1) {
    differences.push({
      field: 'raw_transcript_digest',
      classification: 'environment-derived',
      detail: 'Raw request/response lines retain each fresh absolute fixture root; tokenized evidence is compared separately.',
    });
  }
  if (semanticTranscriptDigests.size > 1) {
    differences.push({
      field: 'tokenized_transcript_digest',
      classification: 'unexplained',
      detail: 'Transcript ordering or tokenized protocol content differed across cold trials.',
    });
  }
  if (semanticSignatures.size > 1) {
    differences.push({
      field: 'semantic_trial_signature',
      classification: 'semantic',
      detail: 'Protocol, discovery, outcome, state, stderr, shutdown, or cleanup evidence differed.',
    });
  }
  return {
    planName,
    trialCount: entries.length,
    semanticStable: semanticSignatures.size === 1 && entries.every((entry) => entry.assessment.passed),
    semanticSignature: semanticSignatures.size === 1 ? [...semanticSignatures][0]! : null,
    tokenizedTranscriptStable: semanticTranscriptDigests.size === 1,
    rawTranscriptStable: rawTranscriptDigests.size === 1,
    differenceClassification: differences,
  };
}

function buildSemanticSignature(execution: GitSpikeTrialExecution): JsonObject {
  return {
    requested_protocol: execution.initialization?.requestedProtocolVersion ?? null,
    negotiated_protocol: execution.initialization?.negotiatedProtocolVersion ?? null,
    server_info: execution.initialization?.serverInfo ?? null,
    capabilities: execution.initialization?.capabilities ?? null,
    discovery_digest: execution.discovery?.semanticDiscoveryDigest ?? null,
    tool_schema_digests:
      execution.discovery?.tools.map((tool) => ({ name: tool.name, digest: tool.semanticDigest })) ?? [],
    calls: execution.calls.map((call) => ({
      tool: call.tool,
      arguments: call.arguments,
      outcome_class: call.outcomeClass,
      is_error: call.isError,
      semantic_outcome_digest: call.semanticOutcomeDigest,
      input_schema_digest: call.inputSchemaDigest,
      changed_layers: call.stateDiff.changedLayers,
      before_state_hash: call.stateDiff.beforeStateHash,
      after_state_hash: call.stateDiff.afterStateHash,
    })),
    stderr: {
      byte_count: execution.transcript.stderrByteCount,
      digest_count: execution.transcript.stderrDigests.length,
    },
    shutdown: {
      graceful: execution.shutdown.graceful,
      escalation: execution.shutdown.escalation,
      exit_code: execution.shutdown.exitCode,
      signal: execution.shutdown.signal,
      child_alive: execution.shutdown.childAlive,
      group_alive: execution.shutdown.managedProcessGroupAlive,
      requests_settled: execution.shutdown.allRequestsSettled,
    },
    cleanup: execution.cleanup.passed,
  };
}

function runWitness(
  baseDirectory: string,
  gitExecutable: string,
  expectedStateHash: string,
): NonNullable<SpikeReport['witness']> {
  const fixture = createGitSpikeFixture({ baseDirectory, trialId: 'final-witness-01', gitExecutable });
  const snapshotValue = captureGitSpikeSnapshot(fixture);
  const cleanup = cleanupGitSpikeFixture(fixture, {
    closeObserved: true,
    allRequestsSettled: true,
    childAlive: false,
    managedProcessGroupAlive: false,
    emergencyCleanupUsed: false,
  });
  return {
    expectedStateHash,
    observedStateHash: snapshotValue.stateHash,
    reproducible: snapshotValue.stateHash === expectedStateHash,
    cleanupPassed: cleanup.passed,
  };
}

function requireTools(
  calls: GitSpikeTrialExecution['calls'],
  expected: readonly string[],
  reasons: string[],
): void {
  requireCondition(
    canonicalJson(calls.map((call) => call.tool)) === canonicalJson([...expected]),
    `tool sequence differs: expected ${expected.join(' -> ')}, observed ${calls.map((call) => call.tool).join(' -> ')}`,
    reasons,
  );
}

function requireCallClasses(
  calls: GitSpikeTrialExecution['calls'],
  expected: readonly string[],
  reasons: string[],
): void {
  requireCondition(
    canonicalJson(calls.map((call) => call.outcomeClass)) === canonicalJson([...expected]),
    `call classes differ: expected ${expected.join(', ')}, observed ${calls.map((call) => call.outcomeClass).join(', ')}`,
    reasons,
  );
}

function requireCallLayers(
  calls: GitSpikeTrialExecution['calls'],
  expected: readonly ('unchanged' | readonly GitSpikeSnapshotLayer[])[],
  reasons: string[],
): void {
  if (calls.length !== expected.length) return;
  calls.forEach((call, index) => {
    const expectedValue = expected[index]!;
    const classification = classifyStateDiff(call.stateDiff, expectedValue);
    const expectedClass = expectedValue === 'unchanged' ? 'unchanged' : 'expected_delta';
    requireCondition(
      classification === expectedClass &&
        (expectedValue === 'unchanged' || sameSet(call.stateDiff.changedLayers, expectedValue)),
      `call ${index} ${call.tool} changed layers ${call.stateDiff.changedLayers.join(', ') || '<none>'}`,
      reasons,
    );
  });
}

function snapshot(execution: GitSpikeTrialExecution, stage: string): GitSpikeSnapshot | null {
  return journalEntry(execution, stage)?.snapshot ?? null;
}

function journalEntry(
  execution: GitSpikeTrialExecution,
  stage: string,
): GitSpikeTrialExecution['journal'][number] | null {
  return execution.journal.find((entry) => entry.stage === stage) ?? null;
}

function fileDigest(snapshotValue: GitSpikeSnapshot, path: string): string | null {
  return snapshotValue.worktree.find((entry) => entry.path === path && entry.type === 'file')?.sha256 ?? null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return canonicalJson([...a].sort()) === canonicalJson([...b].sort());
}

function requireCondition(condition: boolean, reason: string, reasons: string[]): void {
  if (!condition) reasons.push(reason);
}

function readOculorySourceState(gitExecutable: string): { head: string; dirty: boolean } {
  const cwd = process.cwd();
  const env = { PATH: [dirname(gitExecutable), '/usr/bin', '/bin'].join(':'), LC_ALL: 'C' };
  const head = execFileSync(gitExecutable, ['rev-parse', 'HEAD'], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  }).trim();
  const status = execFileSync(gitExecutable, ['status', '--porcelain=v1'], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  });
  return { head, dirty: status.length > 0 };
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (!name.startsWith('--')) throw new Error(`unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`);
    values.set(name, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined) throw new Error(`required argument ${name} is missing`);
    if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
    return resolve(value);
  };
  const trialsRaw = values.get('--trials') ?? '3';
  const trials = Number(trialsRaw);
  if (!Number.isInteger(trials) || trials < 3 || trials > 10) {
    throw new Error('--trials must be an integer from 3 through 10');
  }
  return {
    pythonExecutable: required('--python'),
    targetExecutable: required('--executable'),
    gitExecutable: required('--git'),
    lockPath: required('--lock'),
    outputPath: required('--output'),
    trials,
  };
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

void main().catch((error: unknown) => {
  process.stderr.write(`external Git MCP spike failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
