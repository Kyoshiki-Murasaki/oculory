import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const PROTECTED_RUN_ROOTS = new Set(['runs-live', 'runs-external', 'runs-model']);
const OPERATIONS_ROOTS = new Set(['oculory-pilot-operations', 'oculory-pilot-sessions']);

export function assertPublicWritablePath(candidate: string, label: string): string {
  if (candidate.includes('\0') || /[\r\n]/.test(candidate)) throw new Error(`${label} contains control characters`);
  const resolved = resolve(candidate);
  for (const path of [resolved, canonicalPotentialPath(resolved)]) assertAllowedSegments(path, label);
  return resolved;
}

function canonicalPotentialPath(path: string): string {
  let existing = path;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function assertAllowedSegments(path: string, label: string): void {
  const segments = path.replaceAll('\\', '/').split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!.toLowerCase();
    if (OPERATIONS_ROOTS.has(segment)) throw new Error(`${label} must not target an operations workspace`);
    if (segment === '.oculory' && PROTECTED_RUN_ROOTS.has(segments[index + 1]?.toLowerCase() ?? '')) {
      throw new Error(`${label} must not target protected evidence`);
    }
  }
}
