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

import type { InstallMarker } from '@myco/install/marker-reader.js';
export { readInstallMarker, type InstallMarker } from '@myco/install/marker-reader.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { writeInstallMarker as publishInstallMarker, writeAutomaticUpdatePreference as publishAutomaticUpdatePreference } from '../../scripts/install-marker.mjs';

export {
  managedBinDir,
  managedBinaryPath,
  versionsDir,
  versionDir,
  versionBinaryPath,
  managedSkillsDir,
} from '../../scripts/managed-paths.mjs';

/**
 * Writes the install marker to `<dir>/install.json`.
 *
 * `dir` is the `.myco` home directory (e.g. `~/.myco`).
 */
export function writeInstallMarker(dir: string, marker: InstallMarker): void {
  publishInstallMarker(dir, marker, (file, text) => atomicWriteFileSync(file, text, 'utf8'));
}

export function writeAutomaticUpdatePreference(dir: string, enabled: boolean): void {
  publishAutomaticUpdatePreference(dir, enabled, (file, text) => atomicWriteFileSync(file, text, 'utf8'));
}
