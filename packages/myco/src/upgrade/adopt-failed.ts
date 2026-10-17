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
    throw new Error(`Cannot read ${failedVersionsPath(home)}: ${error instanceof Error ? error.message : String(error)}. Delete or repair this file, then retry.`);
  }
}

/** Failed releases remain ineligible after their staged slots are pruned. */
export function hasAdoptFailed(home: string, platform: NodeJS.Platform, version: string, localAppData?: string): boolean {
  return readFailedVersions(home).includes(version) || fs.existsSync(path.join(versionDir(home, platform, version, localAppData), ADOPT_FAILED_MARKER));
}

/** Record a failed release independently of staged-slot retention. */
export function markAdoptFailed(home: string, platform: NodeJS.Platform, version: string, localAppData?: string, writeFile: typeof atomicWriteFileSync = atomicWriteFileSync): void {
  const file = failedVersionsPath(home);
  withFileLockSync(`${file}.lock`, () => {
    writeFile(file, JSON.stringify([...new Set([...readFailedVersions(home), version])]) + '\n');
  });
  const dir = versionDir(home, platform, version, localAppData);
  if (!fs.existsSync(dir)) return;
  fs.writeFileSync(path.join(dir, ADOPT_FAILED_MARKER), `${new Date().toISOString()}
`);
}

/** A verified adoption clears both durable and staged failure records. */
export function clearAdoptFailed(home: string, platform: NodeJS.Platform, version: string, localAppData?: string, writeFile: typeof atomicWriteFileSync = atomicWriteFileSync): void {
  const file = failedVersionsPath(home);
  const marker = path.join(versionDir(home, platform, version, localAppData), ADOPT_FAILED_MARKER);
  try {
    withFileLockSync(`${file}.lock`, () => {
      writeFile(file, JSON.stringify(readFailedVersions(home).filter(failed => failed !== version)) + '\n');
    });
    fs.rmSync(marker, { force: true });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}. Delete or repair ${file} and remove ${marker}.`);
  }
}
