import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import type { RunManifest } from '../schema/run-manifest.js';
import type { RecordingInstabilityResult } from './instability.js';

/**
 * Store scoped to a single ISOLATED run directory (Phase 3.1).
 *
 * Reuses everything `Store` already knows about the on-disk layout
 * (traces/, outcomes.jsonl, candidates.json, suite.json, runs/, reports/) and
 * adds: the run `manifest.json`, a `logs/` directory, and the --force helper
 * that truncates only this run's own append-only outputs. Every write still
 * goes through `this.root`, so all artifacts stay inside the run directory.
 */
export class RunStore extends Store {
  override init(): void {
    super.init();
    mkdirSync(join(this.root, 'logs'), { recursive: true });
  }

  manifestPath(): string {
    return join(this.root, 'manifest.json');
  }

  writeManifest(manifest: RunManifest): void {
    this.init();
    writeFileSync(this.manifestPath(), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  readManifest(): RunManifest | null {
    if (!existsSync(this.manifestPath())) return null;
    try {
      return JSON.parse(readFileSync(this.manifestPath(), 'utf8')) as RunManifest;
    } catch {
      return null;
    }
  }

  logsDir(): string {
    this.init();
    return join(this.root, 'logs');
  }

  appendLog(name: string, line: string): void {
    this.init();
    appendFileSync(join(this.root, 'logs', name), line.endsWith('\n') ? line : line + '\n', 'utf8');
  }

  saveInstability(groups: RecordingInstabilityResult[]): string {
    return this.saveJsonReport('recording-instability.json', { groups } as never);
  }

  loadInstability(): RecordingInstabilityResult[] {
    const path = join(this.root, 'reports', 'recording-instability.json');
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { groups?: RecordingInstabilityResult[] };
      return parsed.groups ?? [];
    } catch {
      return [];
    }
  }

  /** --force: remove this run's append-only outputs so a re-run does not duplicate rows. */
  resetTraceOutputs(): void {
    for (const rel of [join('traces', 'raw.jsonl'), join('traces', 'normalized.jsonl'), 'outcomes.jsonl']) {
      const p = join(this.root, rel);
      if (existsSync(p)) unlinkSync(p);
    }
  }
}
