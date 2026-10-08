/**
 * Install-marker helpers, plus a re-export of the canonical managed-binary path
 * layout.
 *
 * Path layout and marker publication live in shared plain-ESM modules under
 * scripts/, used by both the compiled binary and npm postinstall. Callers
 * pass the resolved myco-home to the path helpers.
 *
 * Note: the *running* binary is resolved elsewhere via the existing
 * `resolveManagedBinaryPath()` in `symbionts/installer.ts`; this module only
 * computes the canonical managed path + marker.
 */

import { RELEASE_CHANNELS, type ReleaseChannel } from '@myco/constants/update';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { writeInstallMarker as publishInstallMarker } from '../../scripts/install-marker.mjs';

export {
  managedBinDir,
  managedBinaryPath,
  versionsDir,
  versionDir,
  versionBinaryPath,
  managedSkillsDir,
} from '../../scripts/managed-paths.mjs';

/** Shape of the install marker written to `<myco-home>/install.json`. */
export interface InstallMarker {
  channel: ReleaseChannel;
  source: 'curl' | 'npm';
  bin: string;
  /** Whether the build installed is a prerelease, as the installer found it; absent from older markers. */
  prerelease?: boolean;
}

/**
 * Writes the install marker to `<dir>/install.json`.
 *
 * `dir` is the `.myco` home directory (e.g. `~/.myco`).
 */
export function writeInstallMarker(dir: string, marker: InstallMarker): void {
  publishInstallMarker(dir, marker, (file, text) => atomicWriteFileSync(file, text, 'utf8'));
}

/** Read the install marker; strict callers refuse damaged or inaccessible authority. */
export function readInstallMarker(dir: string, strict = false): InstallMarker | null {
  const markerPath = path.join(dir, 'install.json');
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as InstallMarker;
    if (strict && (!marker || !RELEASE_CHANNELS.includes(marker.channel) ||
      !['curl', 'npm'].includes(marker.source) || typeof marker.bin !== 'string' || !path.isAbsolute(marker.bin))) {
      throw new Error(`Invalid install marker at ${markerPath}; reinstall to record the channel and binary destination.`);
    }
    return marker;
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}
