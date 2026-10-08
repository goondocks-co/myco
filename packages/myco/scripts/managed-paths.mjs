// Managed binary paths shared by the npm postinstall, install helpers and runtime resolver.
// Callers pass the resolved Myco home. POSIX binaries live under that home;
// Windows binaries live under LOCALAPPDATA independently of the Myco home.

import os from 'node:os';
import path from 'node:path';

/** Managed binary directory: `<mycoHome>/bin` (POSIX) / `%LOCALAPPDATA%\Myco\bin` (win32). */
export function managedBinDir(mycoHome, platform, localAppData) {
  if (platform === 'win32') {
    const appDataLocal = localAppData ?? path.win32.join(os.homedir(), 'AppData', 'Local');
    return path.win32.join(appDataLocal, 'Myco', 'bin');
  }
  return path.posix.join(mycoHome, 'bin');
}

/** Full path to the managed binary: `<binDir>/myco[.exe]`. */
export function managedBinaryPath(mycoHome, platform, localAppData) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const binaryName = platform === 'win32' ? 'myco.exe' : 'myco';
  return p.join(managedBinDir(mycoHome, platform, localAppData), binaryName);
}

/** Versions directory: `<binDir>/versions`. */
export function versionsDir(mycoHome, platform, localAppData) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(managedBinDir(mycoHome, platform, localAppData), 'versions');
}

/** Directory for a specific version: `<binDir>/versions/<version>`. */
export function versionDir(mycoHome, platform, version, localAppData) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(versionsDir(mycoHome, platform, localAppData), version);
}

/** Full path to a versioned binary: `<versionDir>/myco[.exe]`. */
export function versionBinaryPath(mycoHome, platform, version, localAppData) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const binaryName = platform === 'win32' ? 'myco.exe' : 'myco';
  return p.join(versionDir(mycoHome, platform, version, localAppData), binaryName);
}

/**
 * Managed skills directory: `<mycoHome>/skills` (all platforms).
 *
 * Unlike the managed bin (which lives outside myco-home on Windows), skills sit
 * directly under myco-home everywhere — the daemon seeds them here from the
 * binary-embedded bundle, and global skill symlinks resolve here. A stable
 * managed target divorced from any checkout is what lets global skills survive a
 * worktree/checkout deletion and self-heal on the detection tick. The bin layout
 * is unused for skills, so no `localAppData` argument is needed.
 */
export function managedSkillsDir(mycoHome, platform = process.platform) {
  return (platform === 'win32' ? path.win32 : path.posix).join(mycoHome, 'skills');
}
