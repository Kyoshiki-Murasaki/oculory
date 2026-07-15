import { canonicalJson, hashJson } from '../../schema/canonical.js';
import type { Json, JsonObject } from '../../schema/types.js';
import type { GitSpikeFixture } from './fixture.js';
import {
  GIT_SPIKE_SNAPSHOT_LAYERS,
  gitSpikeSemanticLayers,
  type GitSpikeSnapshot,
  type GitSpikeSnapshotLayer,
} from './snapshot.js';

const MISSING = Symbol('missing');
const DEFAULT_MAX_DIFFERENCES_PER_LAYER = 12;
const MAX_DIFFERENCES_PER_LAYER = 50;

type ComparableJson = Json | typeof MISSING;

export type GitSpikeDiagnosticValueType =
  | 'missing'
  | 'null'
  | 'array'
  | 'object'
  | 'string'
  | 'number'
  | 'boolean';

export interface GitSpikeDiagnosticValue {
  type: GitSpikeDiagnosticValueType;
  sha256: string;
}

export interface GitSpikeDifferenceIndicators {
  fixtureSpecificPath: boolean;
  timestamp: boolean;
  timezone: boolean;
  mode: boolean;
  ordering: boolean;
  lineEnding: boolean;
  gitGeneratedMetadata: boolean;
  otherPresentationOnly: boolean;
}

export interface GitSpikeCanonicalDifference {
  pointer: string;
  before: GitSpikeDiagnosticValue;
  after: GitSpikeDiagnosticValue;
  indicators: GitSpikeDifferenceIndicators;
}

export interface GitSpikeLayerDiagnostic {
  layer: GitSpikeSnapshotLayer;
  beforeHash: string;
  afterHash: string;
  differenceCount: number;
  differences: GitSpikeCanonicalDifference[];
  truncated: boolean;
}

export interface GitSpikeSnapshotDiagnostic {
  equal: boolean;
  fixtureRecipeDigestEqual: boolean;
  beforeFixtureRecipeDigest: string;
  afterFixtureRecipeDigest: string;
  beforeStateHash: string;
  afterStateHash: string;
  differingLayers: GitSpikeSnapshotLayer[];
  layers: GitSpikeLayerDiagnostic[];
}

export interface GitSpikeSnapshotDiagnosticOptions {
  beforeFixture?: GitSpikeFixture;
  afterFixture?: GitSpikeFixture;
  maxDifferencesPerLayer?: number;
}

interface DifferenceContext {
  markers: string[];
}

export function explainGitSpikeSnapshotDifference(
  before: GitSpikeSnapshot,
  after: GitSpikeSnapshot,
  options: GitSpikeSnapshotDiagnosticOptions = {},
): GitSpikeSnapshotDiagnostic {
  const beforeLayers = gitSpikeSemanticLayers(before);
  const afterLayers = gitSpikeSemanticLayers(after);
  const limit = boundedLimit(options.maxDifferencesPerLayer);
  const context = {
    markers: fixtureMarkers(options.beforeFixture, options.afterFixture),
  } satisfies DifferenceContext;
  const differingLayers = GIT_SPIKE_SNAPSHOT_LAYERS.filter(
    (layer) => before.layerHashes[layer] !== after.layerHashes[layer],
  );
  const layers = differingLayers.map((layer) => {
    const differences: GitSpikeCanonicalDifference[] = [];
    const differenceCount = collectDifferences(
      beforeLayers[layer],
      afterLayers[layer],
      `/${escapePointer(layer)}`,
      context,
      limit,
      differences,
    );
    return {
      layer,
      beforeHash: before.layerHashes[layer],
      afterHash: after.layerHashes[layer],
      differenceCount,
      differences,
      truncated: differenceCount > differences.length,
    };
  });
  const fixtureRecipeDigestEqual = before.fixtureRecipeDigest === after.fixtureRecipeDigest;
  return {
    equal: fixtureRecipeDigestEqual && before.stateHash === after.stateHash && differingLayers.length === 0,
    fixtureRecipeDigestEqual,
    beforeFixtureRecipeDigest: before.fixtureRecipeDigest,
    afterFixtureRecipeDigest: after.fixtureRecipeDigest,
    beforeStateHash: before.stateHash,
    afterStateHash: after.stateHash,
    differingLayers,
    layers,
  };
}

export function formatGitSpikeSnapshotDiagnostic(value: GitSpikeSnapshotDiagnostic): string {
  return canonicalJson(value as unknown as JsonObject);
}

function collectDifferences(
  before: ComparableJson,
  after: ComparableJson,
  pointer: string,
  context: DifferenceContext,
  limit: number,
  output: GitSpikeCanonicalDifference[],
): number {
  if (valuesEqual(before, after)) return 0;

  if (before !== MISSING && after !== MISSING && Array.isArray(before) && Array.isArray(after)) {
    if (arraysDifferOnlyByOrder(before, after)) {
      appendDifference(before, after, pointer, context, true, limit, output);
      return 1;
    }
    let count = 0;
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      count += collectDifferences(
        index < before.length ? before[index]! : MISSING,
        index < after.length ? after[index]! : MISSING,
        `${pointer}/${index}`,
        context,
        limit,
        output,
      );
    }
    return count;
  }

  if (isJsonObject(before) && isJsonObject(after)) {
    let count = 0;
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareStrings);
    for (const key of keys) {
      count += collectDifferences(
        Object.hasOwn(before, key) ? before[key]! : MISSING,
        Object.hasOwn(after, key) ? after[key]! : MISSING,
        `${pointer}/${escapePointer(key)}`,
        context,
        limit,
        output,
      );
    }
    return count;
  }

  appendDifference(before, after, pointer, context, false, limit, output);
  return 1;
}

function appendDifference(
  before: ComparableJson,
  after: ComparableJson,
  pointer: string,
  context: DifferenceContext,
  ordering: boolean,
  limit: number,
  output: GitSpikeCanonicalDifference[],
): void {
  if (output.length >= limit) return;
  output.push({
    pointer,
    before: describeValue(before),
    after: describeValue(after),
    indicators: differenceIndicators(before, after, pointer, context, ordering),
  });
}

function differenceIndicators(
  before: ComparableJson,
  after: ComparableJson,
  pointer: string,
  context: DifferenceContext,
  ordering: boolean,
): GitSpikeDifferenceIndicators {
  const strings = [...stringsWithin(before), ...stringsWithin(after)];
  const normalizedStrings = strings.map(normalizePathPresentation);
  const fixtureSpecificPath = normalizedStrings.some((value) =>
    context.markers.some((marker) => value.includes(marker))
  ) || strings.some((value) => /<(?:FIXTURE|SIBLING|TRIAL|RUNTIME)_ROOT>/.test(value));
  const lineEnding = typeof before === 'string' && typeof after === 'string' &&
    before !== after && normalizeLineEndings(before) === normalizeLineEndings(after);
  const pathSpelling = typeof before === 'string' && typeof after === 'string' &&
    before !== after && normalizePathPresentation(before) === normalizePathPresentation(after);
  return {
    fixtureSpecificPath,
    timestamp: /(?:^|\/)(?:timestamp|.*_date|.*_time|mtime_nanoseconds)(?:\/|$)/i.test(pointer) ||
      strings.some((value) => /^\d{10,19}$/.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value)),
    timezone: /(?:^|\/)timezone(?:\/|$)/i.test(pointer) || strings.some((value) => /^[+-]\d{4}$/.test(value)),
    mode: /(?:^|\/)mode(?:\/|$)/i.test(pointer),
    ordering,
    lineEnding,
    gitGeneratedMetadata: /^\/(?:head_and_refs|commit_graph|reflogs|objects|isolation)(?:\/|$)/.test(pointer),
    otherPresentationOnly: pathSpelling && !lineEnding,
  };
}

function fixtureMarkers(...fixtures: Array<GitSpikeFixture | undefined>): string[] {
  const values = fixtures.flatMap((fixture) => fixture === undefined ? [] : [
    fixture.id,
    fixture.trialRoot,
    fixture.repositoryRoot,
    fixture.siblingRepositoryRoot,
    fixture.emptyHooksDirectory,
    fixture.environmentPaths.home,
    fixture.environmentPaths.temporaryDirectory,
  ]);
  return [...new Set(values.map(normalizePathPresentation).filter((value) => value.length > 0))]
    .sort((a, b) => b.length - a.length || compareStrings(a, b));
}

function stringsWithin(value: ComparableJson): string[] {
  if (value === MISSING || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsWithin);
  if (isJsonObject(value)) return Object.values(value).flatMap(stringsWithin);
  return [];
}

function describeValue(value: ComparableJson): GitSpikeDiagnosticValue {
  if (value === MISSING) {
    return { type: 'missing', sha256: hashJson({ missing: true }) };
  }
  return { type: valueType(value), sha256: hashJson(value) };
}

function valueType(value: Json): Exclude<GitSpikeDiagnosticValueType, 'missing'> {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  return 'boolean';
}

function valuesEqual(before: ComparableJson, after: ComparableJson): boolean {
  if (before === MISSING || after === MISSING) return before === after;
  return canonicalJson(before) === canonicalJson(after);
}

function arraysDifferOnlyByOrder(before: Json[], after: Json[]): boolean {
  if (before.length !== after.length) return false;
  const left = before.map(canonicalJson).sort(compareStrings);
  const right = after.map(canonicalJson).sort(compareStrings);
  return left.every((value, index) => value === right[index]);
}

function isJsonObject(value: ComparableJson): value is JsonObject {
  return value !== MISSING && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_DIFFERENCES_PER_LAYER;
  if (!Number.isInteger(value) || value < 1) throw new Error('maxDifferencesPerLayer must be a positive integer');
  return Math.min(value, MAX_DIFFERENCES_PER_LAYER);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizePathPresentation(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
