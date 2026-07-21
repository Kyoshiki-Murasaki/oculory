export type AdapterOperator = 'exists' | 'equals' | 'count' | 'unchanged' | 'none' | 'subset';

export type AdapterEvaluationMode = 'exact' | 'subset' | 'ignore';

export type AdapterJson =
  | null
  | boolean
  | number
  | string
  | AdapterJson[]
  | { [key: string]: AdapterJson };

export interface AdapterAssertion {
  id: string;
  target: string;
  selector: Readonly<Record<string, AdapterJson>>;
  operator: AdapterOperator;
  expected?: AdapterJson;
  evaluationMode: AdapterEvaluationMode;
}

export interface AdapterAssertionResult {
  assertionId: string;
  passed: boolean;
  ignored: boolean;
  operator: AdapterOperator;
  evaluationMode: AdapterEvaluationMode;
  expected: AdapterJson | null;
  observed: AdapterJson | null;
  detail: string;
}

export interface AdapterPrepareContext {
  runId: string;
  workspaceRoot?: string;
  signal?: AbortSignal;
}

export interface AdapterOperationResult {
  passed: boolean;
  detail: string;
}

export interface OculoryAdapter<Configuration, Prepared, Snapshot, NormalizedSnapshot, SnapshotDiff> {
  validateConfiguration(value: unknown): Configuration;
  prepare(configuration: Configuration, context: AdapterPrepareContext): Promise<Prepared>;
  snapshotBefore(prepared: Prepared): Promise<Snapshot>;
  snapshotAfter(prepared: Prepared): Promise<Snapshot>;
  normalizeSnapshot(snapshot: Snapshot): NormalizedSnapshot;
  diff(before: NormalizedSnapshot, after: NormalizedSnapshot): SnapshotDiff;
  evaluateAssertion(
    assertion: AdapterAssertion,
    before: NormalizedSnapshot,
    after: NormalizedSnapshot,
    diff: SnapshotDiff,
  ): AdapterAssertionResult;
  reset(prepared: Prepared, expected: NormalizedSnapshot): Promise<AdapterOperationResult>;
  cleanup(prepared: Prepared): Promise<AdapterOperationResult>;
  describeViolation(assertion: AdapterAssertion, result: AdapterAssertionResult): string;
  redact(value: unknown): AdapterJson;
}

export type AnyOculoryAdapter = OculoryAdapter<unknown, unknown, unknown, unknown, unknown>;

export interface AdapterRegistration<Adapter extends AnyOculoryAdapter = AnyOculoryAdapter> {
  id: string;
  version: string;
  adapter: Adapter;
}
