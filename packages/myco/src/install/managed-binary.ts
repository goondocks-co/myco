/**
 * Canonical managed-binary path + install-marker helpers.
 *
 * This module is the single owner of the path computation for the managed
 * binary (`~/.myco/bin/myco` / `%LOCALAPPDATA%\Myco\bin\myco.exe`) and the
 * `~/.myco/install.json` marker that records how the binary was installed.
 *
 * Note: the *running* binary is resolved elsewhere via the existing
 * `resolveManagedBinaryPath()` in `symbionts/installer.ts`; this module only
 * computes the canonical managed path + marker.
 */

import type { ReleaseChannel } from '@myco/constants/update';
import fs from 'node:fs';
import path from 'node:path';

/** Shape of the install marker written to `<myco-home>/install.json`. */
export interface InstallMarker {
  channel: ReleaseChannel;
  source: 'curl' | 'npm';
  bin: string;
}

/**
 * Returns the managed binary directory for the given home directory and
 * platform.
 *
 * Win32 assumption: `%LOCALAPPDATA%` defaults to `<home>/AppData/Local`.
 * Task 7's install.ps1 uses the real `%LOCALAPPDATA%` env var directly.
 * This module remains pure — it does NOT read `process.env`.
 */
export function managedBinDir(home: string, platform: NodeJS.Platform | string): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    // <home>/AppData/Local/Myco/bin (mirrors default %LOCALAPPDATA%\Myco\bin)
    return p.join(home, 'AppData', 'Local', 'Myco', 'bin');
  }
  return p.join(home, '.myco', 'bin');
}

/** Returns the full path to the managed binary for the given home and platform. */
export function managedBinaryPath(home: string, platform: NodeJS.Platform | string): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const binaryName = platform === 'win32' ? 'myco.exe' : 'myco';
  return p.join(managedBinDir(home, platform), binaryName);
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
