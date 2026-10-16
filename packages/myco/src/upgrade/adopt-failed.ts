import fs from 'node:fs';
import path from 'node:path';
import { versionDir } from '@myco/install/managed-binary.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';

export const ADOPT_FAILED_MARKER = '.adopt-failed';

const failedVersionsPath = (home: string): string => path.join(home, 'bin', 'adopt-failed.json');

function readFailedVersions(home: string): string[] {
  try {
    const versions: unknown = JSON.parse(fs.readFileSync(failedVersionsPath(home), 'utf8'));
    if (!Array.isArray(versions) || !versions.every(version => typeof version === 'string')) throw new Error('Invalid failed-version record');
    return versions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Failed releases remain ineligible after their staged slots are pruned. */
export function hasAdoptFailed(home: string, platform: NodeJS.Platform, version: string, localAppData?: string): boolean {
  return readFailedVersions(home).includes(version) || fs.existsSync(path.join(versionDir(home, platform, version, localAppData), ADOPT_FAILED_MARKER));
}

/** Record a failed release independently of staged-slot retention. */
export function markAdoptFailed(home: string, platform: NodeJS.Platform, version: string, localAppData?: string): void {
  const file = failedVersionsPath(home);
  withFileLockSync(`${file}.lock`, () => {
    atomicWriteFileSync(file, JSON.stringify([...new Set([...readFailedVersions(home), version])]) + '\n');
  });
  const dir = versionDir(home, platform, version, localAppData);
  if (!fs.existsSync(dir)) return;
  fs.writeFileSync(path.join(dir, ADOPT_FAILED_MARKER), `${new Date().toISOString()}
`);
}
