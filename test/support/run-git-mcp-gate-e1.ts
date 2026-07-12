import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Json, JsonObject } from '../../src/schema/types.js';
import { ExternalRunStore } from '../../src/external/run-store.js';
import {
  EXTERNAL_RUN_MANIFEST_VERSION,
  EXTERNAL_TRACE_SCHEMA_VERSION,
  type ExternalOutcome,
  type ExternalPartition,
  type ExternalRunManifest,
  type ExternalTrialEnvelope,
} from '../../src/external/schema-v3.js';
import {
  GIT_SPIKE_TARGET,
  inspectGitSpikeRuntime,
} from '../../src/targets/git-spike/config.js';
import {
  GIT_GATE_E1_ADAPTER_VERSION,
  GIT_GATE_E1_CATALOGUE_DIGEST,
  GIT_GATE_E1_CATALOGUE_VERSION,
  GIT_GATE_E1_SCENARIOS,
  gitGateE1CatalogueSnapshot,
} from '../../src/targets/git/catalogue.js';
import { executeGitScriptedScenario } from '../../src/targets/git/scripted-driver.js';
import {
  GIT_GATE_E1_NORMALIZATION_RULES,
  persistGitExternalTrial,
} from '../../src/targets/git/external-record.js';
import {
  GIT_MINER_VERSION,
  GitMiningLoader,
  mineGitAssertions,
  renderGitCandidateReview,
} from '../../src/targets/git/mining.js';
import { GIT_VERIFIER_VERSION } from '../../src/targets/git/verifier-types.js';

interface Arguments {
  pythonExecutable: string;
  targetExecutable: string;
  gitExecutable: string;
  lockPath: string;
  runRoot: string;
  runId: string;
  trials: 3;
}

async function main(): Promise<void> {
  const started = process.hrtime.bigint();
  const args = parseArguments(process.argv.slice(2));
  const sourceState = sourceIdentity(process.cwd());
  if (sourceState.dirty) throw new Error('authoritative Gate E1 refuses a dirty source tree');
  const source = { ...sourceState, dirty: false as const };
  const lockSha256 = sha256(readFileSync(args.lockPath));
  if (lockSha256 !== GIT_SPIKE_TARGET.lockSha256) throw new Error(`incorrect dependency lock digest: ${lockSha256}`);
  const runtime = inspectGitSpikeRuntime({
    pythonExecutable: args.pythonExecutable,
    targetExecutable: args.targetExecutable,
    gitExecutable: args.gitExecutable,
    lockSha256,
  });
  const lockDistributions = parseLockedDistributions(readFileSync(args.lockPath, 'utf8'));
  const installedDistributions = canonicalizeInstalledDistributions(runtime.distributions);
  if (lockDistributions.size !== 33) throw new Error(`expected 33 locked distributions, observed ${lockDistributions.size}`);
  for (const [name, version] of lockDistributions) {
    const installed = installedDistributions.get(canonicalPackageName(name));
    if (installed !== version) throw new Error(`runtime lock drift for ${name}: expected ${version}, observed ${String(installed)}`);
  }
  if (installedDistributions.size !== 33) throw new Error(`expected 33 installed distributions, observed ${installedDistributions.size}`);

  const executableSha256 = sha256(readFileSync(runtime.targetExecutable));
  const store = ExternalRunStore.create(args.runRoot, args.runId);
  const workingBase = mkdtempSync(join(tmpdir(), 'oculory-git-gate-e1-'));
  const records: ExternalTrialEnvelope[] = [];
  let miningComputed = false;
  let candidateResult: ReturnType<typeof mineGitAssertions> | null = null;

  store.writeJson('catalogue.json', gitGateE1CatalogueSnapshot());
  store.writeText('catalogue.sha256', `${GIT_GATE_E1_CATALOGUE_DIGEST}\n`);
  store.writeJson('runtime-provenance.json', {
    target: GIT_SPIKE_TARGET,
    runtime,
    executableSha256,
    lockPath: 'test/external/pylock.git-mcp-2026.7.10-py312-macos-arm64.toml',
    lockSha256,
    lockedDistributionCount: lockDistributions.size,
  } as unknown as Json);

  try {
    for (const partition of ['smoke', 'mining', 'holdout', 'adversarial'] as const) {
      if (partition === 'holdout' && !miningComputed) {
        candidateResult = computeAndPersistMining(store);
        miningComputed = true;
      }
      for (const scenario of GIT_GATE_E1_SCENARIOS.filter((entry) => entry.partition === partition)) {
        for (let trialIndex = 1; trialIndex <= args.trials; trialIndex += 1) {
          const trialId = `${scenario.id}-t${String(trialIndex).padStart(2, '0')}`;
          const result = await executeGitScriptedScenario({
            baseDirectory: workingBase,
            trialId,
            runtime,
            scenario,
          });
          records.push(persistGitExternalTrial({
            store, scenario, trialIndex, trialId, result,
            provenance: {
              runId: args.runId,
              source,
              runtime,
              executableSha256,
              os: `${platform()} ${release()}`,
              architecture: arch(),
            },
          }));
        }
      }
    }
    if (!miningComputed) {
      candidateResult = computeAndPersistMining(store);
      miningComputed = true;
    }

    const partitionManifest = Object.fromEntries((['smoke', 'mining', 'holdout', 'adversarial'] as const).map((partition) => [
      partition,
      records.filter((entry) => entry.record.trace.partition === partition).map((entry) => entry.record.trace.traceId).sort(),
    ]));
    store.writeJson('partition-manifest.json', partitionManifest as unknown as Json);
    const goldenSummary = buildGoldenSummary(records);
    const instability = buildInstabilitySummary(records);
    store.writeJson('golden-outcomes.json', goldenSummary as unknown as Json);
    store.writeJson('instability-summary.json', instability as unknown as Json);

    const outcomeCounts = emptyOutcomeCounts();
    for (const record of records) outcomeCounts[record.record.goldenObserved] += 1;
    const partitionCounts: Record<ExternalPartition, number> = { smoke: 0, mining: 0, holdout: 0, adversarial: 0 };
    for (const record of records) partitionCounts[record.record.trace.partition] += 1;
    const allPassed = records.length === 60 && records.every((entry) => entry.record.terminalStatus === 'passed') &&
      instability.unstableScenarioIds.length === 0 && candidateResult !== null &&
      candidateResult.miningTraceIds.length === 18 && candidateResult.miningScenarioIds.length === 6 &&
      candidateResult.candidates.length === 10 &&
      candidateResult.candidates.every((candidate) =>
        candidate.approvalStatus === 'unapproved' && candidate.constantLeakagePassed &&
        candidate.distinctScenarioSupport >= 3 && candidate.trialSupport === 9 &&
        candidate.leaveOneOut.length === 3 && candidate.leaveOneOut.every((entry) => entry.predicateSurvived && entry.distinctScenarioSupport === 2 && entry.trialSupport === 6));
    const manifest: ExternalRunManifest = {
      schemaVersion: EXTERNAL_RUN_MANIFEST_VERSION,
      externalTraceSchema: EXTERNAL_TRACE_SCHEMA_VERSION,
      runId: args.runId,
      finalized: true,
      implementationCommit: source.commit,
      dirty: false,
      sourceTreeDigest: source.sourceTreeDigest,
      target: {
        id: GIT_SPIKE_TARGET.packageName, version: GIT_SPIKE_TARGET.packageVersion,
        wheelSha256: GIT_SPIKE_TARGET.wheelSha256, installedSourceSha256: runtime.targetServerSha256,
        executableSha256, dependencyLockSha256: lockSha256,
      },
      runtime: {
        python: runtime.pythonVersion, uv: '0.11.23', git: runtime.gitVersion, node: runtime.nodeVersion,
        os: `${platform()} ${release()}`, architecture: arch(), distributions: Object.keys(runtime.distributions).length,
      },
      adapterVersion: GIT_GATE_E1_ADAPTER_VERSION,
      verifierVersion: GIT_VERIFIER_VERSION,
      fixtureRecipeVersion: 'git-spike-seed-v1',
      fixtureRecipeDigest: records[0]!.record.trace.fixtureRecipe.digest,
      catalogueVersion: GIT_GATE_E1_CATALOGUE_VERSION,
      catalogueDigest: GIT_GATE_E1_CATALOGUE_DIGEST,
      minerVersion: GIT_MINER_VERSION,
      normalizationRules: [...GIT_GATE_E1_NORMALIZATION_RULES],
      partitionCounts,
      trialCount: records.length,
      outcomeCounts,
      decision: allPassed ? 'completed' : records.some((entry) => entry.record.goldenObserved === 'unknown') ? 'inconclusive' : 'failed',
    };
    store.finalize(manifest);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    process.stdout.write(`${JSON.stringify({
      gate_e1: manifest.decision,
      run_id: args.runId,
      run_directory: store.root,
      sessions: records.length,
      outcomes: outcomeCounts,
      unstable_scenarios: instability.unstableScenarioIds,
      candidates: candidateResult?.candidates.length ?? 0,
      elapsed_ms: elapsedMs,
    })}\n`);
    if (!allPassed) process.exitCode = 1;
  } finally {
    if (readdirSync(workingBase).length !== 0) process.stderr.write(`Gate E1 working base retained residue: ${workingBase}\n`);
    else rmSync(workingBase, { recursive: true, force: false });
  }
}

function computeAndPersistMining(store: ExternalRunStore) {
  const loader = new GitMiningLoader(store);
  const traceIds = loader.traceIds();
  const traces = loader.loadAll();
  const result = mineGitAssertions(traces);
  store.writeJson('mining/input-manifest.json', {
    schema: 'git-mining-input-v1', partition: 'mining', traceIds,
    scenarioIds: result.miningScenarioIds, distinctScenarioSupport: 'scenario_id',
    computedBeforeHoldoutEvaluation: true,
  });
  store.writeJson('candidates.json', result as unknown as Json);
  store.writeJson('mining/candidates.json', result as unknown as Json);
  store.writeText('reports/candidate-review.md', renderGitCandidateReview(result));
  return result;
}

function buildGoldenSummary(records: ExternalTrialEnvelope[]) {
  return GIT_GATE_E1_SCENARIOS.map((scenario) => {
    const trials = records.filter((entry) => entry.record.trace.scenarioId === scenario.id);
    return {
      scenarioId: scenario.id, partition: scenario.partition, family: scenario.family,
      expected: scenario.goldenOutcome, requested: 3, completed: trials.length,
      observed: trials.map((entry) => entry.record.goldenObserved),
      callPaths: trials.map((entry) => entry.record.trace.orderedCalls.map((call) => call.tool)),
      unexpectedLayers: trials.map((entry) => entry.record.unexpectedLayers),
      cleanup: trials.map((entry) => entry.record.cleanupPassed),
      sentinel: trials.map((entry) => entry.record.siblingSentinelPassed),
      evidenceComplete: trials.map((entry) => entry.record.trace.evidenceCompleteness.complete),
    };
  });
}

function buildInstabilitySummary(records: ExternalTrialEnvelope[]) {
  const findings = GIT_GATE_E1_SCENARIOS.map((scenario) => {
    const trials = records.filter((entry) => entry.record.trace.scenarioId === scenario.id);
    const signatures = new Set(trials.map((entry) => JSON.stringify({
      outcome: entry.record.goldenObserved,
      subtype: entry.record.verifierSubtype,
      path: entry.record.trace.orderedCalls.map((call) => call.tool),
      discovery: entry.record.trace.discoveryDigest,
      unexpectedLayers: entry.record.unexpectedLayers,
      finalHash: ((entry.record.trace.verifierResult as JsonObject).state as JsonObject | undefined)?.finalHash ?? null,
    })));
    return { scenarioId: scenario.id, trialCount: trials.length, stable: trials.length === 3 && signatures.size === 1 };
  });
  return { findings, unstableScenarioIds: findings.filter((entry) => !entry.stable).map((entry) => entry.scenarioId) };
}

function emptyOutcomeCounts(): Record<ExternalOutcome, number> {
  return { verified_success: 0, valid_rejection: 0, verified_failure: 0, partial_success: 0, invalid_acceptance: 0, unknown: 0 };
}

function sourceIdentity(root: string): { commit: string; dirty: boolean; sourceTreeDigest: string } {
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.length > 0) return { commit, dirty: true, sourceTreeDigest: sourceTreeDigest(root) };
  return { commit, dirty: false, sourceTreeDigest: sourceTreeDigest(root) };
}

function sourceTreeDigest(root: string): string {
  const paths = gitBuffer(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8').split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of paths) { hash.update(path); hash.update('\0'); hash.update(readFileSync(resolve(root, path))); hash.update('\0'); }
  return hash.digest('hex');
}

function parseLockedDistributions(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const blocks = text.split('[[packages]]').slice(1);
  for (const block of blocks) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name === undefined || version === undefined) throw new Error('invalid package block in committed pylock');
    values.set(canonicalPackageName(name), version);
  }
  return values;
}

function canonicalPackageName(value: string): string { return value.toLowerCase().replace(/[-_.]+/g, '-'); }
function canonicalizeInstalledDistributions(distributions: Readonly<Record<string, string>>): Map<string, string> {
  const canonical = new Map<string, string>();
  for (const [name, version] of Object.entries(distributions)) {
    const key = canonicalPackageName(name);
    if (canonical.has(key)) throw new Error(`duplicate installed distribution after canonicalization: ${key}`);
    canonical.set(key, version);
  }
  return canonical;
}
function git(cwd: string, args: string[]): string { return gitBuffer(cwd, args).toString('utf8'); }
function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024, timeout: 5_000 });
}
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

function parseArguments(argv: readonly string[]): Arguments {
  const value = (name: string): string => {
    const index = argv.indexOf(name);
    const result = index < 0 ? undefined : argv[index + 1];
    if (result === undefined || result.length === 0) throw new Error(`${name} is required`);
    return result;
  };
  const trials = Number(value('--trials'));
  if (trials !== 3) throw new Error('Gate E1 requires exactly --trials 3');
  const lockPath = resolve(value('--lock'));
  const runRoot = resolve(value('--run-root'));
  if (!isAbsolute(lockPath) || !isAbsolute(runRoot)) throw new Error('lock and run root must be absolute');
  return {
    pythonExecutable: resolve(value('--python')),
    targetExecutable: resolve(value('--executable')),
    gitExecutable: resolve(value('--git')),
    lockPath,
    runRoot,
    runId: value('--run-id'),
    trials: 3,
  };
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
