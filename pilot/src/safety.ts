import {
  constants,
  accessSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PROVIDER_CONFIGURATION_NAMES, PROTECTED_EVIDENCE_ROOTS } from './constants.js';

export type PilotPathSafetyCode =
  | 'output_inside_protected_evidence'
  | 'output_inside_git_metadata'
  | 'output_inside_repository'
  | 'output_parent_unwritable';

export class PilotPathSafetyError extends Error {
  constructor(readonly code: PilotPathSafetyCode, message: string) {
    super(message);
    this.name = 'PilotPathSafetyError';
  }
}

export function providerConfigurationPresent(environmentNames: readonly string[]): boolean {
  const names = new Set(environmentNames.map((name) => name.toUpperCase()));
  if (PROVIDER_CONFIGURATION_NAMES.some((name) => names.has(name))) return true;
  return [...names].some((name) => /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|CREDENTIALS?)$/.test(name));
}

export function validatePilotOutputPath(repositoryRoot: string, outputPath: string): string {
  if (!isAbsolute(repositoryRoot)) throw new Error('repository root must be absolute');
  const repository = realpathSync(repositoryRoot);
  const candidate = physicalCandidate(resolve(outputPath));

  for (const protectedRoot of PROTECTED_EVIDENCE_ROOTS) {
    const protectedPath = resolve(repository, ...protectedRoot.split('/'));
    if (within(candidate, protectedPath)) {
      throw new PilotPathSafetyError(
        'output_inside_protected_evidence',
        'pilot output must not be inside protected evidence',
      );
    }
  }

  if (within(candidate, resolve(repository, '.git'))) {
    throw new PilotPathSafetyError(
      'output_inside_git_metadata',
      'pilot output must not be inside Git metadata',
    );
  }

  if (within(candidate, repository)) {
    throw new PilotPathSafetyError(
      'output_inside_repository',
      'pilot output must be outside the current repository',
    );
  }

  const parent = closestExistingAncestor(candidate);
  try {
    accessSync(parent, constants.W_OK);
    const probe = mkdtempSync(join(parent, '.oculory-pilot-write-probe-'));
    writeFileSync(join(probe, 'probe.txt'), 'provider-free pilot write probe\n', { encoding: 'utf8', flag: 'wx' });
    rmSync(probe, { recursive: true, force: false });
  } catch {
    throw new PilotPathSafetyError(
      'output_parent_unwritable',
      'pilot output parent is not writable',
    );
  }
  return candidate;
}

function physicalCandidate(candidate: string): string {
  if (existsSync(candidate)) return realpathSync(candidate);
  const ancestor = closestExistingAncestor(candidate);
  const suffix = relative(ancestor, candidate);
  return resolve(realpathSync(ancestor), suffix);
}

function closestExistingAncestor(candidate: string): string {
  let current = resolve(candidate);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error('pilot output has no existing ancestor');
    current = parent;
  }
  return current;
}

function within(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  const normalized = process.platform === 'win32' ? rel.toLowerCase() : rel;
  return normalized === '' || (!normalized.startsWith(`..${sep}`) && normalized !== '..' && !isAbsolute(normalized));
}
