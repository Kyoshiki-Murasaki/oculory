import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ApprovedSuite,
  CandidateTest,
  DatasetPartition,
  Json,
  NormalizedTrace,
  OutcomeRecord,
  RawTrace,
  SuiteRunResult,
} from '../schema/types.js';

/**
 * Subdirectory (under any store root) that holds isolated live-model run
 * artifacts. A routine `clean()` NEVER deletes it: those runs cost real API
 * spend and are not regenerable offline, so a scripted `experiment` /
 * `fs-experiment` re-run must not destroy them (docs/27). `run-context.ts`
 * builds `DEFAULT_LIVE_RUNS_ROOT` from this constant so the two cannot drift.
 */
export const LIVE_RUNS_SUBDIR = 'runs-live';
export const EXTERNAL_RUNS_SUBDIR = 'runs-external';
export const MODEL_RUNS_SUBDIR = 'runs-model';

/**
 * Local-first artifact store under `.oculory/` (docs/04 §Storage).
 * Append-only JSONL for traces and outcomes; pretty JSON for reviewable
 * artifacts (candidates, suite, runs, reports).
 *
 * Holdout isolation: `loadMiningTraces()` is the ONLY loader the miner may
 * use; it excludes `holdout` and `smoke` partitions. Audited by a unit test.
 */
export class Store {
  constructor(readonly root = '.oculory') {}

  private p(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  init(): void {
    for (const d of ['traces', 'runs', 'reports']) mkdirSync(this.p(d), { recursive: true });
  }

  /**
   * Remove the store's generated contents. By default this PRESERVES the
   * `runs-live/`, `runs-external/`, and `runs-model/` evidence subdirectories; every scripted
   * or derived artifact is still removed.
   * That is what makes `oculory experiment` and `oculory fs-experiment` safe to
   * re-run without destroying evidence. Each root has a distinct destructive
   * option; all three are required before the store root itself may be removed.
   */
  clean(opts: { includeLiveRuns?: boolean; includeExternalRuns?: boolean; includeModelRuns?: boolean } = {}): void {
    if (!existsSync(this.root)) return;
    if (opts.includeLiveRuns && opts.includeExternalRuns && opts.includeModelRuns) {
      rmSync(this.root, { recursive: true, force: true });
      return;
    }
    for (const entry of readdirSync(this.root)) {
      if (entry === LIVE_RUNS_SUBDIR && !opts.includeLiveRuns) continue;
      if (entry === EXTERNAL_RUNS_SUBDIR && !opts.includeExternalRuns) continue;
      if (entry === MODEL_RUNS_SUBDIR && !opts.includeModelRuns) continue;
      rmSync(this.p(entry), { recursive: true, force: true });
    }
    if (readdirSync(this.root).length === 0) rmSync(this.root, { recursive: true, force: true });
  }

  /* ------------------------------ traces -------------------------------- */

  appendRawTrace(trace: RawTrace): void {
    this.init();
    appendFileSync(this.p('traces', 'raw.jsonl'), JSON.stringify(trace) + '\n', 'utf8');
  }

  loadRawTraces(): RawTrace[] {
    return this.readJsonl<RawTrace>(this.p('traces', 'raw.jsonl'));
  }

  appendNormalizedTrace(trace: NormalizedTrace): void {
    this.init();
    appendFileSync(this.p('traces', 'normalized.jsonl'), JSON.stringify(trace) + '\n', 'utf8');
  }

  loadNormalizedTraces(): NormalizedTrace[] {
    return this.readJsonl<NormalizedTrace>(this.p('traces', 'normalized.jsonl'));
  }

  /** The only trace loader mining code is permitted to call. */
  loadMiningTraces(): NormalizedTrace[] {
    const allowed: DatasetPartition[] = ['mining', 'adversarial'];
    return this.loadNormalizedTraces().filter((t) => allowed.includes(t.partition));
  }

  appendOutcome(outcome: OutcomeRecord): void {
    this.init();
    appendFileSync(this.p('outcomes.jsonl'), JSON.stringify(outcome) + '\n', 'utf8');
  }

  loadOutcomes(): OutcomeRecord[] {
    return this.readJsonl<OutcomeRecord>(this.p('outcomes.jsonl'));
  }

  /* --------------------------- reviewable JSON -------------------------- */

  saveCandidates(candidates: CandidateTest[]): void {
    this.init();
    writeFileSync(this.p('candidates.json'), JSON.stringify(candidates, null, 2) + '\n', 'utf8');
  }

  loadCandidates(): CandidateTest[] {
    const path = this.p('candidates.json');
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf8')) as CandidateTest[];
  }

  saveSuite(suite: ApprovedSuite): void {
    this.init();
    writeFileSync(this.p('suite.json'), JSON.stringify(suite, null, 2) + '\n', 'utf8');
  }

  loadSuite(): ApprovedSuite | null {
    const path = this.p('suite.json');
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as ApprovedSuite;
  }

  saveRun(run: SuiteRunResult): void {
    this.init();
    writeFileSync(this.p('runs', `${run.run_id}.json`), JSON.stringify(run, null, 2) + '\n', 'utf8');
  }

  loadRun(runId: string): SuiteRunResult {
    return JSON.parse(readFileSync(this.p('runs', `${runId}.json`), 'utf8')) as SuiteRunResult;
  }

  listRuns(): string[] {
    const dir = this.p('runs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  }

  saveReport(name: string, content: string): string {
    this.init();
    const path = this.p('reports', name);
    writeFileSync(path, content, 'utf8');
    return path;
  }

  saveJsonReport(name: string, value: Json): string {
    return this.saveReport(name, JSON.stringify(value, null, 2) + '\n');
  }

  /* ------------------------------ helpers ------------------------------- */

  private readJsonl<T>(path: string): T[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  }
}
