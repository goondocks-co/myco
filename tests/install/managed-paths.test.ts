/**
 * Path-layout regression tests for the shared managed-paths module.
 *
 * The doubled-path bug (`~/.myco/.myco/bin`) that broke the daemon auto-adopt
 * AND manual `myco upgrade` shipped because these helpers had ZERO coverage and
 * an ambiguous `home` param: install/service/doctor callers passed the os-home
 * (and the helper appended `.myco/bin`), while the upgrade domain passed the
 * myco-home (`~/.myco`) — which then doubled. The single shared module now
 * takes the resolved MYCO-HOME and appends `bin` on POSIX; these tests lock
 * that in and assert the doubled `.myco/.myco` segment can never reappear for
 * any caller's home value, default or custom `$MYCO_HOME`. (Imported via the TS
 * re-export so we also cover the binary-facing surface.)
 */

import { describe, expect, test } from 'bun:test';
import {
  managedBinDir,
  managedBinaryPath,
  versionsDir,
  versionDir,
  versionBinaryPath,
} from '@myco/install/managed-binary.js';

describe('managed-paths: POSIX roots at the myco-home + bin (never .myco/bin)', () => {
  const mycoHome = '/Users/alice/.myco';

  test('managedBinDir', () => {
    expect(managedBinDir(mycoHome, 'darwin')).toBe('/Users/alice/.myco/bin');
  });

  test('managedBinaryPath (darwin + linux)', () => {
    expect(managedBinaryPath(mycoHome, 'darwin')).toBe('/Users/alice/.myco/bin/myco');
    expect(managedBinaryPath(mycoHome, 'linux')).toBe('/Users/alice/.myco/bin/myco');
  });

  test('versionsDir / versionDir / versionBinaryPath', () => {
    expect(versionsDir(mycoHome, 'linux')).toBe('/Users/alice/.myco/bin/versions');
    expect(versionDir(mycoHome, 'linux', '1.2.0-beta.3')).toBe('/Users/alice/.myco/bin/versions/1.2.0-beta.3');
    expect(versionBinaryPath(mycoHome, 'linux', '1.2.0-beta.3')).toBe(
      '/Users/alice/.myco/bin/versions/1.2.0-beta.3/myco',
    );
  });

  test('NO doubled .myco/.myco for any helper (the shipped bug)', () => {
    const paths = [
      managedBinDir(mycoHome, 'darwin'),
      managedBinaryPath(mycoHome, 'linux'),
      versionsDir(mycoHome, 'linux'),
      versionDir(mycoHome, 'darwin', '9.9.9'),
      versionBinaryPath(mycoHome, 'darwin', '9.9.9'),
    ];
    for (const p of paths) expect(p).not.toContain('.myco/.myco');
  });
});

describe('managed-paths: honors a custom $MYCO_HOME (the os-home convention silently ignored it)', () => {
  const customHome = '/opt/myco-home';

  test('rooted at the custom home; no extra .myco appended', () => {
    expect(managedBinaryPath(customHome, 'linux')).toBe('/opt/myco-home/bin/myco');
    expect(versionBinaryPath(customHome, 'linux', '1.2.0')).toBe('/opt/myco-home/bin/versions/1.2.0/myco');
    expect(managedBinaryPath(customHome, 'linux')).not.toContain('.myco');
  });
});

describe('managed-paths: win32 roots at %LOCALAPPDATA%, NOT the myco-home', () => {
  const localAppData = 'C:\\Users\\Alice\\AppData\\Local';

  test('uses localAppData; the myco-home arg is ignored', () => {
    expect(managedBinaryPath('C:\\Users\\Alice\\.myco', 'win32', localAppData)).toBe(
      'C:\\Users\\Alice\\AppData\\Local\\Myco\\bin\\myco.exe',
    );
    // A custom $MYCO_HOME must NOT relocate the win32 bin dir.
    expect(managedBinaryPath('D:\\custom\\myco', 'win32', localAppData)).toBe(
      'C:\\Users\\Alice\\AppData\\Local\\Myco\\bin\\myco.exe',
    );
  });

  test('versioned path under localAppData', () => {
    expect(versionBinaryPath('C:\\Users\\Alice\\.myco', 'win32', '1.2.0', localAppData)).toBe(
      'C:\\Users\\Alice\\AppData\\Local\\Myco\\bin\\versions\\1.2.0\\myco.exe',
    );
  });
});
