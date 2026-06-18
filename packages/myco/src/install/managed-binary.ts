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
 * On win32, pass the real `%LOCALAPPDATA%` value as `localAppData` to avoid
 * divergence under Known-Folder redirection or roaming profiles. When omitted,
 * falls back to `<home>/AppData/Local` (the historical default). On non-win32
 * platforms `localAppData` is ignored.
 *
 * This module remains pure — it does NOT read `process.env`. Callers that
 * need the real env value pass `process.env.LOCALAPPDATA` at the call site.
 */
export function managedBinDir(
  home: string,
  platform: NodeJS.Platform | string,
  localAppData?: string,
): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    // Prefer the injected %LOCALAPPDATA% (real env value, honors KF redirection
    // and roaming profiles). Fall back to the computed default when absent.
    const appDataLocal = localAppData ?? p.join(home, 'AppData', 'Local');
    return p.join(appDataLocal, 'Myco', 'bin');
  }
  return p.join(home, '.myco', 'bin');
}

/** Returns the full path to the managed binary for the given home and platform.
 *
 * Pass `localAppData` on win32 to honor the real `%LOCALAPPDATA%` env var
 * (see `managedBinDir`). Ignored on non-win32 platforms.
 */
export function managedBinaryPath(
  home: string,
  platform: NodeJS.Platform | string,
  localAppData?: string,
): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const binaryName = platform === 'win32' ? 'myco.exe' : 'myco';
  return p.join(managedBinDir(home, platform, localAppData), binaryName);
}

/**
 * Returns the versions directory (`<bindir>/versions`) for the managed binary.
 *
 * Pass `localAppData` on win32 — see `managedBinDir` for details.
 */
export function versionsDir(
  home: string,
  platform: NodeJS.Platform | string,
  localAppData?: string,
): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(managedBinDir(home, platform, localAppData), 'versions');
}

/**
 * Returns the directory for a specific version (`<bindir>/versions/<version>`).
 *
 * Pass `localAppData` on win32 — see `managedBinDir` for details.
 */
export function versionDir(
  home: string,
  platform: NodeJS.Platform | string,
  version: string,
  localAppData?: string,
): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(versionsDir(home, platform, localAppData), version);
}

/**
 * Returns the full path to the versioned binary (`<versionDir>/myco[.exe]`).
 *
 * Pass `localAppData` on win32 — see `managedBinDir` for details.
 */
export function versionBinaryPath(
  home: string,
  platform: NodeJS.Platform | string,
  version: string,
  localAppData?: string,
): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const binaryName = platform === 'win32' ? 'myco.exe' : 'myco';
  return p.join(versionDir(home, platform, version, localAppData), binaryName);
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
