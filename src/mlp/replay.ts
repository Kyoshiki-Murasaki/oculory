import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson } from '../schema/canonical.js';
import { assertAdapterAssertionPreflight } from './adapters/assertion-preflight.js';
import type { AdapterAssertion, AdapterAssertionResult, AdapterJson } from './adapters/types.js';
import type { AdapterRegistry } from './adapters/registry.js';
import { loadTaskConfig, parseTaskConfig } from './config.js';
import { assertTaskRunPreflight, executeTaskRun, type PublicRunClassification, type PublicRunSummary } from './record.js';
import { renderReplaySummary, renderViolation, type ReplayProfileResult, type ViolationRenderModel } from './renderer.js';
import { assertPublicWritablePath } from './path-policy.js';
import { assertPublicMlpExecutionSupported } from './process.js';
import { PublicRunStore } from './run-store.js';
import type { ContractAssertion, OculoryContractConfig, OculoryTaskConfig } from './types.js';

const MAX_REPLAY_DIRECTORY_ENTRIES = 4096;
const MAX_REPLAY_REPORTS = 256;
const MAX_REPLAY_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_REPLAY_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_REPLAY_PROFILES = 64;
const MAX_REPLAY_ITERATIONS = 1000;

export interface ReplayOptions {
  taskPath?: string;
  taskSource?: string;
  profile: string;
  registry: AdapterRegistry;
  store?: PublicRunStore;
  signal?: AbortSignal;
  reportPath?: string;
  color?: boolean;
  width?: number;
}

export interface ReplayAssertionEvaluation {
  assertion: ContractAssertion;
  result: AdapterAssertionResult | null;
  description: string;
  error: string | null;
}

export interface ReplayIteration {
  run_id: string;
  classification: PublicRunClassification;
  agent_claim: PublicRunSummary['agent_claim'];
  tool_result: PublicRunSummary['tool_result'];
  assertions: ReplayAssertionEvaluation[];
  infrastructure_error: string | null;
}

export interface ReplayReport {
  schema_version: 'oculory-replay-report-v1';
  compatibility_id: string;
  profile_definition_id: string;
  task_id: string;
  profile: string;
  profiles: ReplayProfileResult[];
  contract: {
    runs: number;
    min_pass: number;
    assertions: number;
  };
  totals: {
    requested: number;
    completed: number;
    behaviorally_passed: number;
    behaviorally_failed: number;
    infrastructure_failed: number;
    indeterminate: number;
    required_threshold: number;
  };
  status: 'PASS' | 'FAIL' | 'INFRA';
  exit_code: 0 | 2 | 3;
  iterations: ReplayIteration[];
  report_path: string;
  human_report_path: string;
}

export interface ReplayOutcome {
  report: ReplayReport;
  human: string;
}

interface CompatibleReplayCandidate {
  result: ReplayProfileResult;
  sequence: number;
  report: ReplayReport;
  reportPath: string;
  reportSource: string;
}

export async function replayContract(contract: OculoryContractConfig, options: ReplayOptions): Promise<ReplayOutcome> {
  assertPublicMlpExecutionSupported();
  const store = options.store ?? new PublicRunStore();
  const taskPath = options.taskPath ?? store.registeredTaskPath(contract.task);
  const loadedTask = options.taskSource === undefined ? loadTaskConfig(taskPath) : parseTaskConfig(options.taskSource);
  const taskSource = loadedTask.source;
  const task = loadedTask.value;
  assertTaskRunPreflight(task, options.registry, store.projectRoot);
  assertReplayPreflight(contract, task, options.profile, options.registry);
  const compatibilityId = replayCompatibilityId(contract, task, options.registry);
  const profileDefinitionId = replayProfileDefinitionId(task, options.profile);
  const priorProfiles = loadCompatibleReplayProfiles(store, compatibilityId, task);

  const iterations: ReplayIteration[] = [];
  for (let index = 0; index < contract.tolerance.runs; index++) {
    const executed = await executeTaskRun(task, {
      taskPath,
      taskSource,
      profile: options.profile,
      registry: options.registry,
      store,
      signal: options.signal,
      finalize: false,
      registerTask: false,
    });
    const evaluation = evaluateAssertions(contract.assertions, executed.runtimeTargets, options.registry);
    let classification = executed.summary.classification;
    if (classification !== 'infrastructure-failed') {
      if (evaluation.some((entry) => entry.error !== null || entry.result === null)) classification = 'indeterminate';
      else if (evaluation.some((entry) => entry.result?.ignored !== true && entry.result?.passed !== true)) classification = 'behaviorally-violated';
      else classification = 'behaviorally-passed';
    }
    executed.summary.classification = classification;
    store.replaceJsonBeforeFinalize(executed.summary.run_id, 'summary.json', executed.summary);
    const iteration: ReplayIteration = {
      run_id: executed.summary.run_id,
      classification,
      agent_claim: executed.summary.agent_claim,
      tool_result: executed.summary.tool_result,
      assertions: evaluation,
      infrastructure_error: executed.summary.infrastructure_error,
    };
    store.writeJson(iteration.run_id, 'assertion-matrix.json', evaluation);
    iterations.push(iteration);
  }

  const totals = aggregate(iterations, contract.tolerance.runs, contract.tolerance.min_pass);
  const status: ReplayReport['status'] = totals.behaviorally_passed >= contract.tolerance.min_pass
    ? 'PASS'
    : totals.behaviorally_passed + totals.behaviorally_failed < contract.tolerance.min_pass
      ? 'INFRA'
      : 'FAIL';
  const exitCode = status === 'PASS' ? 0 : status === 'FAIL' ? 2 : 3;
  const replayRoot = ensureReplayDirectory(store, iterations, options.profile);
  const reportPath = resolve(replayRoot, 'report.json');
  const humanReportPath = resolve(replayRoot, 'report.txt');
  const currentProfile: ReplayProfileResult = {
    profile: options.profile,
    status,
    passed: totals.behaviorally_passed,
    requested: totals.requested,
    threshold: totals.required_threshold,
  };
  const profiles = mergeReplayProfiles(priorProfiles, currentProfile);
  const report: ReplayReport = {
    schema_version: 'oculory-replay-report-v1',
    compatibility_id: compatibilityId,
    profile_definition_id: profileDefinitionId,
    task_id: task.task_id,
    profile: options.profile,
    profiles,
    contract: {
      runs: contract.tolerance.runs,
      min_pass: contract.tolerance.min_pass,
      assertions: contract.assertions.length,
    },
    totals,
    status,
    exit_code: exitCode,
    iterations,
    report_path: relativePath(store.projectRoot, reportPath),
    human_report_path: relativePath(store.projectRoot, humanReportPath),
  };
  const human = renderReport(report, options);
  const reportSource = `${JSON.stringify(report, null, 2)}\n`;
  writeExclusive(reportPath, reportSource);
  writeExclusive(humanReportPath, human);
  if (options.reportPath !== undefined) writeExternalReport(options.reportPath, report);

  const reportReference = {
    path: publicReportReference(store, reportPath),
    sha256: sha256(reportSource),
  };
  for (const iteration of iterations) {
    store.writeJson(iteration.run_id, 'replay-context.json', {
      schema_version: 'oculory-replay-context-v1',
      compatibility_id: compatibilityId,
      profile_definition_id: profileDefinitionId,
      totals,
      status,
      profiles,
      report: reportReference,
    });
    store.finalize(iteration.run_id);
  }
  return { report, human };
}

export function assertReplayPreflight(
  contract: OculoryContractConfig,
  task: OculoryTaskConfig,
  profile: string,
  registry?: AdapterRegistry,
): void {
  if (task.task_id !== contract.task) {
    throw new Error(`contract references task '${contract.task}', but task file declares '${task.task_id}'`);
  }
  if (task.agent_profiles[profile] === undefined) throw new Error(`task has no agent profile '${profile}'`);
  const taskTargets = new Set(task.targets.map((target) => target.id));
  const missingTargets = [...new Set(
    contract.assertions.filter((assertion) => !taskTargets.has(assertion.target)).map((assertion) => assertion.target),
  )].sort();
  if (missingTargets.length > 0) {
    throw new Error(`contract references missing task target${missingTargets.length === 1 ? '' : 's'}: ${missingTargets.map((target) => `'${target}'`).join(', ')}`);
  }
  if (registry !== undefined) {
    for (const target of [...task.targets].sort((left, right) => left.id.localeCompare(right.id))) {
      try {
        registry.resolve(target.adapter);
      } catch {
        throw new Error(`task target '${target.id}' uses unregistered adapter '${target.adapter}'`);
      }
    }
  }
  const targets = new Map(task.targets.map((target) => [target.id, target]));
  for (const assertion of [...contract.assertions].sort((left, right) => left.id.localeCompare(right.id))) {
    assertAdapterAssertionPreflight(targets.get(assertion.target)!, assertion);
  }
}

function evaluateAssertions(
  assertions: readonly ContractAssertion[],
  targets: Array<{ id: string; adapter: string; before: unknown; after: unknown | null; diff: unknown | null }>,
  registry: AdapterRegistry,
): ReplayAssertionEvaluation[] {
  return [...assertions].sort((left, right) => left.id.localeCompare(right.id)).map((assertion) => {
    const target = targets.find((entry) => entry.id === assertion.target);
    if (target === undefined || target.after === null || target.diff === null) {
      return { assertion, result: null, description: 'independently observed target state unavailable', error: 'target evidence unavailable' };
    }
    try {
      const adapter = registry.resolve(target.adapter).adapter;
      const adapted: AdapterAssertion = {
        id: assertion.id,
        target: assertion.target,
        selector: assertion.selector,
        operator: assertion.operator,
        expected: assertion.expected,
        evaluationMode: assertion.evaluation,
      };
      const result = adapter.evaluateAssertion(adapted, target.before, target.after, target.diff);
      return {
        assertion,
        result,
        description: result.passed || result.ignored ? result.detail : adapter.describeViolation(adapted, result),
        error: null,
      };
    } catch (error) {
      return { assertion, result: null, description: 'assertion evaluation was indeterminate', error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function aggregate(iterations: readonly ReplayIteration[], requested: number, threshold: number): ReplayReport['totals'] {
  const count = (classification: PublicRunClassification): number => iterations.filter((entry) => entry.classification === classification).length;
  return {
    requested,
    completed: iterations.length,
    behaviorally_passed: count('behaviorally-passed'),
    behaviorally_failed: count('behaviorally-violated'),
    infrastructure_failed: count('infrastructure-failed'),
    indeterminate: count('indeterminate'),
    required_threshold: threshold,
  };
}

function replayCompatibilityId(
  contract: OculoryContractConfig,
  task: OculoryTaskConfig,
  registry: AdapterRegistry,
): string {
  const taskBoundary = {
    version: task.version,
    task_id: task.task_id,
    prompt: task.prompt,
    mcp_server: task.mcp_server,
    workspace: task.workspace,
    targets: task.targets,
    claim_extraction: task.claim_extraction,
  };
  const adapters = [...new Set(task.targets.map((target) => target.adapter))]
    .sort()
    .map((id) => {
      const registration = registry.resolve(id);
      return `${registration.id}@${registration.version}`;
    });
  return createHash('sha256').update(canonicalJson({ adapters, contract, task: taskBoundary } as never)).digest('hex');
}

function replayProfileDefinitionId(task: OculoryTaskConfig, profile: string): string {
  const definition = task.agent_profiles[profile];
  if (definition === undefined) throw new Error(`task has no agent profile '${profile}'`);
  return createHash('sha256').update(canonicalJson({ profile, definition } as never)).digest('hex');
}

function loadCompatibleReplayProfiles(
  store: PublicRunStore,
  compatibilityId: string,
  task: OculoryTaskConfig,
): ReplayProfileResult[] {
  const replayRoot = replayHistoryRoot(store);
  const byProfile = new Map<string, CompatibleReplayCandidate>();
  if (existsSync(replayRoot)) {
    const entries = readdirSync(replayRoot).sort();
    if (entries.length > MAX_REPLAY_DIRECTORY_ENTRIES) {
      throw new Error(`replay history exceeds the ${MAX_REPLAY_DIRECTORY_ENTRIES}-entry inspection limit`);
    }
    let reportCount = 0;
    let totalBytes = 0;
    for (const name of entries) {
      const directory = resolve(replayRoot, name);
      if (!inside(replayRoot, directory) || !lstatSync(directory).isDirectory()) continue;
      const path = resolve(directory, 'report.json');
      if (!existsSync(path) || !lstatSync(path).isFile()) continue;
      reportCount += 1;
      if (reportCount > MAX_REPLAY_REPORTS) {
        throw new Error(`replay history exceeds the ${MAX_REPLAY_REPORTS}-report inspection limit`);
      }
      const bytes = statSync(path).size;
      if (bytes > MAX_REPLAY_REPORT_BYTES) throw new Error(`compatible replay report is too large: ${name}`);
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL_REPLAY_REPORT_BYTES) {
        throw new Error(`replay history exceeds the ${MAX_TOTAL_REPLAY_REPORT_BYTES}-byte inspection limit`);
      }
      let source: string;
      let value: unknown;
      try {
        source = readFileSync(path, 'utf8');
        value = JSON.parse(source) as unknown;
      } catch {
        throw new Error(`invalid replay report: ${name}`);
      }
      const candidate = replayProfileCandidate(value, compatibilityId, task, path, source!);
      if (candidate === null) continue;
      const prior = byProfile.get(candidate.result.profile);
      if (prior === undefined || candidate.sequence > prior.sequence) byProfile.set(candidate.result.profile, candidate);
    }
  }
  for (const candidate of byProfile.values()) validateReplayReportProvenance(store, candidate);
  return [...byProfile.values()]
    .map((entry) => entry.result)
    .sort((left, right) => left.profile.localeCompare(right.profile));
}

function replayProfileCandidate(
  value: unknown,
  compatibilityId: string,
  task: OculoryTaskConfig,
  reportPath: string,
  reportSource: string,
): CompatibleReplayCandidate | null {
  const report = object(value);
  if (report.schema_version !== 'oculory-replay-report-v1' || report.compatibility_id !== compatibilityId) return null;
  const totals = object(report.totals);
  const contract = object(report.contract);
  const profile = report.profile;
  const status = report.status;
  const passed = totals.behaviorally_passed;
  const requested = totals.requested;
  const threshold = totals.required_threshold;
  const iterations = report.iterations;
  if (typeof profile === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(profile)) {
    if (task.agent_profiles[profile] === undefined) return null;
    if (typeof report.profile_definition_id !== 'string' || !/^[a-f0-9]{64}$/.test(report.profile_definition_id)) {
      throw new Error(`invalid compatible replay profile definition for '${profile}'`);
    }
    if (report.profile_definition_id !== replayProfileDefinitionId(task, profile)) return null;
  }
  if (
    typeof profile !== 'string'
    || !/^[a-z][a-z0-9-]{0,63}$/.test(profile)
    || (status !== 'PASS' && status !== 'FAIL' && status !== 'INFRA')
    || !nonnegativeInteger(passed)
    || !positiveInteger(requested)
    || requested > MAX_REPLAY_ITERATIONS
    || !positiveInteger(threshold)
    || threshold > requested
    || passed > requested
    || !Array.isArray(iterations)
  ) throw new Error(`invalid compatible replay report for profile '${typeof profile === 'string' ? profile : '<unknown>'}'`);
  const completed = totals.completed;
  const behaviorallyFailed = totals.behaviorally_failed;
  const infrastructureFailed = totals.infrastructure_failed;
  const indeterminate = totals.indeterminate;
  if (
    !nonnegativeInteger(completed)
    || !nonnegativeInteger(behaviorallyFailed)
    || !nonnegativeInteger(infrastructureFailed)
    || !nonnegativeInteger(indeterminate)
    || completed !== requested
    || passed + behaviorallyFailed + infrastructureFailed + indeterminate !== requested
    || iterations.length !== requested
    || contract.runs !== requested
    || contract.min_pass !== threshold
    || !positiveInteger(contract.assertions)
    || contract.assertions > 1000
  ) throw new Error(`invalid compatible replay report totals for profile '${profile}'`);

  const classifications: PublicRunClassification[] = [];
  const runIds = new Set<string>();
  const sequences = iterations.map((iteration) => {
    const entry = object(iteration);
    const runId = entry.run_id;
    const match = typeof runId === 'string' ? /^run_(\d{4,})$/.exec(runId) : null;
    const classification = entry.classification;
    if (!isPublicRunClassification(classification)) throw new Error(`invalid compatible replay report iteration for profile '${profile}'`);
    if (!Array.isArray(entry.assertions) || entry.assertions.length !== contract.assertions) {
      throw new Error(`invalid compatible replay report assertion count for profile '${profile}'`);
    }
    if (runId === undefined || runIds.has(String(runId))) {
      throw new Error(`invalid compatible replay report duplicate run ID for profile '${profile}'`);
    }
    runIds.add(String(runId));
    classifications.push(classification);
    return match === null ? null : Number(match[1]);
  });
  if (sequences.length === 0 || sequences.some((sequence) => sequence === null || !Number.isSafeInteger(sequence))) {
    throw new Error(`invalid compatible replay report for profile '${profile}'`);
  }
  if (
    countClassification(classifications, 'behaviorally-passed') !== passed
    || countClassification(classifications, 'behaviorally-violated') !== behaviorallyFailed
    || countClassification(classifications, 'infrastructure-failed') !== infrastructureFailed
    || countClassification(classifications, 'indeterminate') !== indeterminate
  ) throw new Error(`invalid compatible replay report classification totals for profile '${profile}'`);
  const expectedStatus = replayStatus(passed, behaviorallyFailed, threshold);
  const expectedExitCode = expectedStatus === 'PASS' ? 0 : expectedStatus === 'FAIL' ? 2 : 3;
  if (status !== expectedStatus || report.exit_code !== expectedExitCode) {
    throw new Error(`invalid compatible replay report status for profile '${profile}'`);
  }
  if (typeof report.task_id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(report.task_id)) {
    throw new Error(`invalid compatible replay report task for profile '${profile}'`);
  }
  if (typeof report.report_path !== 'string' || typeof report.human_report_path !== 'string') {
    throw new Error(`invalid compatible replay report paths for profile '${profile}'`);
  }
  const profiles = replayProfiles(report.profiles, profile);
  const result: ReplayProfileResult = { profile, status, passed, requested, threshold };
  if (!profiles.some((entry) => isDeepStrictEqual(entry, result))) {
    throw new Error(`invalid compatible replay report profile summary for '${profile}'`);
  }
  return {
    result,
    sequence: Math.max(...sequences as number[]),
    report: value as ReplayReport,
    reportPath,
    reportSource,
  };
}

function validateReplayReportProvenance(store: PublicRunStore, candidate: CompatibleReplayCandidate): void {
  const report = candidate.report;
  const expectedDirectory = replayDirectory(store, report.iterations, candidate.result.profile);
  if (resolve(dirname(candidate.reportPath)) !== expectedDirectory) {
    throw new Error(`compatible replay report directory does not match its run references for profile '${candidate.result.profile}'`);
  }
  if (
    report.report_path !== relativePath(store.projectRoot, candidate.reportPath)
    || report.human_report_path !== relativePath(store.projectRoot, resolve(dirname(candidate.reportPath), 'report.txt'))
  ) throw new Error(`compatible replay report paths do not match its saved files for profile '${candidate.result.profile}'`);
  const reference = {
    path: publicReportReference(store, candidate.reportPath),
    sha256: sha256(candidate.reportSource),
  };
  for (const iteration of report.iterations) {
    const runId = iteration.run_id;
    const checksumPath = resolve(store.runPath(runId), 'checksums.sha256');
    if (!existsSync(checksumPath) || !lstatSync(checksumPath).isFile()) {
      throw new Error(`compatible replay report references unfinalized run ${runId}`);
    }
    try {
      store.verify(runId);
    } catch (error) {
      throw new Error(`compatible replay report references invalid finalized run ${runId}: ${errorMessage(error)}`);
    }
    let summary: PublicRunSummary;
    let assertions: ReplayAssertionEvaluation[];
    let context: unknown;
    try {
      summary = store.readJson<PublicRunSummary>(runId, 'summary.json');
      assertions = store.readJson<ReplayAssertionEvaluation[]>(runId, 'assertion-matrix.json');
      context = store.readJson<unknown>(runId, 'replay-context.json');
    } catch (error) {
      throw new Error(`compatible replay report has unreadable finalized evidence for ${runId}: ${errorMessage(error)}`);
    }
    if (
      summary.schema_version !== 'oculory-public-run-v1'
      || summary.run_id !== runId
      || summary.task_id !== report.task_id
      || summary.profile !== report.profile
      || summary.classification !== iteration.classification
      || !isDeepStrictEqual(summary.agent_claim, iteration.agent_claim)
      || !isDeepStrictEqual(summary.tool_result, iteration.tool_result)
      || summary.infrastructure_error !== iteration.infrastructure_error
      || !isDeepStrictEqual(assertions, iteration.assertions)
    ) throw new Error(`compatible replay report contradicts finalized run evidence for ${runId}`);

    const saved = object(context);
    if (
      saved.schema_version !== 'oculory-replay-context-v1'
      || saved.compatibility_id !== report.compatibility_id
      || saved.profile_definition_id !== report.profile_definition_id
      || saved.status !== report.status
      || !isDeepStrictEqual(saved.totals, report.totals)
      || !isDeepStrictEqual(saved.profiles, report.profiles)
      || !isDeepStrictEqual(saved.report, reference)
    ) throw new Error(`compatible replay report reference integrity failed for ${runId}`);
  }
}

function mergeReplayProfiles(prior: readonly ReplayProfileResult[], current: ReplayProfileResult): ReplayProfileResult[] {
  const byProfile = new Map(prior.map((entry) => [entry.profile, entry]));
  byProfile.set(current.profile, current);
  return [...byProfile.values()].sort((left, right) => left.profile.localeCompare(right.profile));
}

function replayProfiles(value: unknown, currentProfile: string): ReplayProfileResult[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REPLAY_PROFILES) {
    throw new Error(`invalid compatible replay report profiles for '${currentProfile}'`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const profile = object(entry);
    if (
      typeof profile.profile !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/.test(profile.profile)
      || seen.has(profile.profile)
      || (profile.status !== 'PASS' && profile.status !== 'FAIL' && profile.status !== 'INFRA')
      || !nonnegativeInteger(profile.passed)
      || !positiveInteger(profile.requested)
      || profile.requested > MAX_REPLAY_ITERATIONS
      || !positiveInteger(profile.threshold)
      || profile.threshold > profile.requested
      || profile.passed > profile.requested
      || (profile.status === 'PASS') !== (profile.passed >= profile.threshold)
    ) throw new Error(`invalid compatible replay report profiles for '${currentProfile}'`);
    seen.add(profile.profile);
    return {
      profile: profile.profile,
      status: profile.status,
      passed: profile.passed,
      requested: profile.requested,
      threshold: profile.threshold,
    };
  });
}

function replayStatus(passed: number, behaviorallyFailed: number, threshold: number): ReplayReport['status'] {
  return passed >= threshold ? 'PASS' : passed + behaviorallyFailed < threshold ? 'INFRA' : 'FAIL';
}

function countClassification(classifications: readonly PublicRunClassification[], expected: PublicRunClassification): number {
  return classifications.filter((classification) => classification === expected).length;
}

function isPublicRunClassification(value: unknown): value is PublicRunClassification {
  return value === 'behaviorally-passed'
    || value === 'behaviorally-violated'
    || value === 'infrastructure-failed'
    || value === 'indeterminate';
}

function renderReport(report: ReplayReport, options: ReplayOptions): string {
  const summary = renderReplaySummary({
    requested: report.totals.requested,
    completed: report.totals.completed,
    passed: report.totals.behaviorally_passed,
    failed: report.totals.behaviorally_failed,
    infrastructure_failed: report.totals.infrastructure_failed,
    indeterminate: report.totals.indeterminate,
    threshold: report.totals.required_threshold,
    status: report.status,
  });
  if (report.status !== 'FAIL') return summary;
  const iteration = report.iterations.find((entry) => entry.classification === 'behaviorally-violated');
  if (iteration === undefined) return summary;
  const failures = iteration.assertions.filter((entry) => entry.result !== null && !entry.result.passed && !entry.result.ignored);
  if (failures.length === 0) return summary;
  const model: ViolationRenderModel = {
    assertion_id: failures[0]!.assertion.id,
    claim: iteration.agent_claim,
    tool: iteration.tool_result,
    failures: failures.map((entry) => ({
      selector: entry.assertion.selector,
      result: entry.result!,
      description: entry.description,
    })),
    profiles: report.profiles,
    run_id: iteration.run_id,
  };
  return `${renderViolation(model, { color: options.color, width: options.width })}\n${summary}`;
}

export function violationModelFromSavedRun(
  summary: PublicRunSummary,
  evaluations: ReplayAssertionEvaluation[],
  context: { profiles: ReplayProfileResult[] },
): ViolationRenderModel {
  const failures = evaluations.filter((entry) => entry.result !== null && !entry.result.passed && !entry.result.ignored);
  if (failures.length === 0) throw new Error(`run ${summary.run_id} has no behavioral contract violation`);
  return {
    assertion_id: failures[0]!.assertion.id,
    claim: summary.agent_claim,
    tool: summary.tool_result,
    failures: failures.map((entry) => ({ selector: entry.assertion.selector, result: entry.result!, description: entry.description })),
    profiles: context.profiles,
    run_id: summary.run_id,
  };
}

function replayDirectory(store: PublicRunStore, iterations: readonly ReplayIteration[], profile: string): string {
  const first = iterations[0]?.run_id ?? 'none';
  const last = iterations.at(-1)?.run_id ?? 'none';
  const safeProfile = profile.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64);
  return resolve(replayHistoryRoot(store), `replay_${first}_${last}_${safeProfile}`);
}

function replayHistoryRoot(store: PublicRunStore): string {
  const root = assertPublicWritablePath(resolve(dirname(store.root), 'replays'), 'replay history');
  if (existsSync(root) && !lstatSync(root).isDirectory()) {
    throw new Error('replay history must be a real directory inside the public Oculory root');
  }
  return root;
}

function ensureReplayDirectory(
  store: PublicRunStore,
  iterations: readonly ReplayIteration[],
  profile: string,
): string {
  const historyRoot = replayHistoryRoot(store);
  if (!existsSync(historyRoot)) mkdirSync(historyRoot, { recursive: false, mode: 0o700 });
  if (!lstatSync(historyRoot).isDirectory()) {
    throw new Error('replay history must be a real directory inside the public Oculory root');
  }
  const directory = replayDirectory(store, iterations, profile);
  if (existsSync(directory) && !lstatSync(directory).isDirectory()) {
    throw new Error('replay report directory must be a real directory');
  }
  if (!existsSync(directory)) mkdirSync(directory, { recursive: false, mode: 0o700 });
  return directory;
}

function publicReportReference(store: PublicRunStore, reportPath: string): string {
  const publicRoot = resolve(dirname(store.root));
  const rel = relative(publicRoot, resolve(reportPath));
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('replay report reference escapes the public Oculory root');
  }
  return rel.split(sep).join('/');
}

function writeExternalReport(path: string, report: ReplayReport): void {
  const resolved = assertPublicWritablePath(path, 'replay report');
  if (!isAbsolute(resolved)) throw new Error('report path must resolve absolutely');
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  writeExclusive(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

function writeExclusive(path: string, source: string): void {
  if (existsSync(path)) throw new Error(`refusing to overwrite report: ${relativePath(process.cwd(), path)}`);
  writeFileSync(path, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function relativePath(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target));
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? '<external-report>' : rel.split(sep).join('/');
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonnegativeInteger(value) && value > 0;
}

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
