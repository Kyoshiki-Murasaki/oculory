import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { canonicalJson, sha256 } from '../../src/schema/canonical.js';
import type { JsonObject } from '../../src/schema/types.js';
import {
  cleanupGitSpikeFixture,
  createGitSpikeFixture,
  runFixtureGit,
  type GitSpikeFixture,
  type GitSpikeProcessCleanupEvidence,
} from '../../src/targets/git-spike/fixture.js';
import {
  explainGitSpikeSnapshotDifference,
  type GitSpikeSnapshotDiagnostic,
} from '../../src/targets/git-spike/snapshot-diagnostic.js';
import {
  captureGitSpikeSnapshot,
  GIT_SPIKE_SNAPSHOT_LAYERS,
  type GitSpikeSnapshot,
} from '../../src/targets/git-spike/snapshot.js';

const PAIR_COUNT = 10;
const GIT = findExecutable('git');
const CLEAN_PROCESS: GitSpikeProcessCleanupEvidence = {
  closeObserved: true,
  allRequestsSettled: true,
  childAlive: false,
  managedProcessGroupAlive: false,
  emergencyCleanupUsed: false,
};

interface Materialization {
  fixture: GitSpikeFixture;
  snapshot: GitSpikeSnapshot;
  gitVersion: string;
}

interface CommitIdComparison {
  equal: boolean;
  before: string;
  after: string;
}

interface DiagnosticResult {
  diagnostic: 'git_fixture_determinism';
  status: 'passed' | 'mismatch';
  [key: string]: unknown;
}

export function runGitFixtureDeterminismDiagnostic(): DiagnosticResult {
  const base = mkdtempSync(join(tmpdir(), 'oculory-git-fixture-diagnostic-'));
  try {
    for (let pair = 1; pair <= PAIR_COUNT; pair += 1) {
      const label = String(pair).padStart(2, '0');
      const first = materialize(base, `diagnostic-${label}-left`);
      const second = materialize(base, `diagnostic-${label}-right`);
      const comparison = explainGitSpikeSnapshotDifference(first.snapshot, second.snapshot, {
        beforeFixture: first.fixture,
        afterFixture: second.fixture,
      });
      const commitIds = {
        main: compareCommitId(first.fixture.mainHead, second.fixture.mainHead),
        featureSeed: compareCommitId(first.fixture.featureSeedHead, second.fixture.featureSeedHead),
        sibling: compareCommitId(first.fixture.siblingHead, second.fixture.siblingHead),
      };
      const commitIdsEqual = Object.values(commitIds).every((entry) => entry.equal);
      const everyLayerCompared = GIT_SPIKE_SNAPSHOT_LAYERS.every(
        (layer) => first.snapshot.layerHashes[layer] === second.snapshot.layerHashes[layer],
      );
      if (!commitIdsEqual || !comparison.equal || !everyLayerCompared) {
        return {
          diagnostic: 'git_fixture_determinism',
          status: 'mismatch',
          pair,
          platform: process.platform,
          nodeVersion: process.version,
          gitVersion: first.gitVersion,
          commitIds,
          comparison: comparison as unknown as JsonObject,
        };
      }
    }
    return {
      diagnostic: 'git_fixture_determinism',
      status: 'passed',
      pairs: PAIR_COUNT,
      uniqueTrialIds: PAIR_COUNT * 2,
      comparisonsPerPair: 3 + 1 + GIT_SPIKE_SNAPSHOT_LAYERS.length + 1,
      platform: process.platform,
      nodeVersion: process.version,
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function materialize(base: string, trialId: string): Materialization {
  const fixture = createGitSpikeFixture({
    baseDirectory: base,
    trialId,
    gitExecutable: GIT,
  });
  let snapshot: GitSpikeSnapshot | null = null;
  let gitVersion = '';
  let bodyError: unknown = null;
  try {
    snapshot = captureGitSpikeSnapshot(fixture);
    gitVersion = runFixtureGit(fixture, ['--version']).toString('utf8').trim();
  } catch (error) {
    bodyError = error;
  }

  const cleanup = cleanupGitSpikeFixture(fixture, CLEAN_PROCESS);
  if (!cleanup.passed) {
    const cleanupError = new Error(
      `Git fixture diagnostic cleanup failed at ${cleanup.failures.map((failure) => failure.step).join(',') || 'proof'}`,
    );
    if (bodyError !== null) throw new AggregateError([bodyError, cleanupError], 'materialization and cleanup failed');
    throw cleanupError;
  }
  if (bodyError !== null) throw bodyError;
  if (snapshot === null) throw new Error('Git fixture diagnostic snapshot was not captured');
  return { fixture, snapshot, gitVersion };
}

function compareCommitId(before: string, after: string): CommitIdComparison {
  return { equal: before === after, before, after };
}

function findExecutable(name: string): string {
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
    : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return resolve(candidate);
    }
  }
  throw new Error(`${name} was not found on PATH`);
}

try {
  const result = runGitFixtureDeterminismDiagnostic();
  process.stdout.write(`${canonicalJson(result as unknown as JsonObject)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
} catch (error) {
  const value = error instanceof Error ? error : new Error(String(error));
  process.stderr.write(`${canonicalJson({
    diagnostic: 'git_fixture_determinism',
    status: 'error',
    errorType: value.constructor.name,
    errorDigest: sha256(value.message),
  })}\n`);
  process.exitCode = 1;
}
