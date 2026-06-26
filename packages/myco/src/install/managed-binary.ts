/**
 * Install-marker helpers, plus a re-export of the canonical managed-binary path
 * layout.
 *
 * The PATH layout itself lives in ONE plain-ESM module — `scripts/managed-paths.mjs`
 * — which is imported BOTH here (compiled into the bun binary) AND by the npm
 * postinstall (`scripts/select-binary.mjs`). Sharing one module is what keeps
 * the JS and TS copies from drifting; the historical duplication is what let
 * the doubled-path (`~/.myco/.myco/bin`) bug ship. See that module for the
 * `home` → `mycoHome` convention (callers pass the resolved myco-home).
 *
 * Note: the *running* binary is resolved elsewhere via the existing
 * `resolveManagedBinaryPath()` in `symbionts/installer.ts`; this module only
 * computes the canonical managed path + marker.
 */

import type { ReleaseChannel } from '@myco/constants/update';
import fs from 'node:fs';
import path from 'node:path';

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
}

/**
 * Writes the install marker to `<dir>/install.json`.
 *
 * `dir` is the `.myco` home directory (e.g. `~/.myco`).
 */
export function writeInstallMarker(dir: string, marker: InstallMarker): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'install.json'), JSON.stringify(marker, null, 2), 'utf8');
}

/**
 * Reads and parses the install marker from `<dir>/install.json`.
 *
 * Returns `null` if the file is absent or unparseable — does not throw.
 */
export function readInstallMarker(dir: string): InstallMarker | null {
  const markerPath = path.join(dir, 'install.json');
  try {
    const raw = fs.readFileSync(markerPath, 'utf8');
    return JSON.parse(raw) as InstallMarker;
  } catch {
    return null;
  }
}
