import fs from 'node:fs';
import path from 'node:path';
import { versionDir } from '@myco/install/managed-binary.js';

export const ADOPT_FAILED_MARKER = '.adopt-failed';

/** Mark an existing staged slot as ineligible for automatic adoption. */
export function markAdoptFailed(home: string, platform: NodeJS.Platform, version: string, localAppData?: string): void {
  const dir = versionDir(home, platform, version, localAppData);
  if (!fs.existsSync(dir)) return;
  try {
    fs.writeFileSync(path.join(dir, ADOPT_FAILED_MARKER), `${new Date().toISOString()}
`);
  } catch (error) {
    console.error(`Could not mark staged Myco ${version} as failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
