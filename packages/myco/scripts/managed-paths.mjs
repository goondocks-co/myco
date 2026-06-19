// SINGLE SOURCE OF TRUTH for the managed-binary path layout.
//
// Imported by BOTH:
//   - the npm postinstall (`select-binary.mjs`) at install time, straight from
//     the published tarball (plain ESM, no build step), and
//   - `src/install/managed-binary.ts`, which re-exports these and is compiled
//     into the bun binary.
//
// Keeping the layout in ONE plain-ESM module is what makes the JS (postinstall)
// and TS (binary) copies structurally unable to drift — the doubled-path bug
// (`~/.myco/.myco/bin`) shipped precisely because the logic was duplicated and
// the two copies disagreed on what `home` meant.
//
// CONVENTION: callers pass the resolved MYCO-HOME — `resolveMycoHome()` in TS
// (`~/.myco` or `$MYCO_HOME`). On POSIX the bin dir is `<mycoHome>/bin`. On
// win32 the managed bin lives at `%LOCALAPPDATA%\Myco\bin`, which is NOT under
// the myco-home: the `mycoHome` argument is unused there. When `localAppData`
// is absent (rare — real callers pass `process.env.LOCALAPPDATA`), the fallback
// derives the OS home via `os.homedir()` independently, so a custom `$MYCO_HOME`
// can never relocate the Windows bin and no doubling can occur on any platform.

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
