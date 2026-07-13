import { closeSync, fsyncSync, openSync } from 'node:fs';

/**
 * Flush a renamed directory entry where the platform supports directory
 * handles. Windows does not support opening directories for fsync, so the
 * durable file flush and atomic rename remain the strongest available steps.
 */
export function syncDirectoryEntry(
  directoryPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return false;
  const descriptor = openSync(directoryPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return true;
}
