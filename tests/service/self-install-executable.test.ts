/**
 * Tests for managed-binary executable resolution in ensureSelfInstalledAsService.
 *
 * Covers `defaultServiceExecutable`: the DEFAULT home (`~/.myco`) prefers
 * `~/.myco/bin/myco` when present; a non-default (dogfood) home always uses
 * `process.execPath` (dogfood guard — it must never re-point at the default
 * home's managed binary).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultServiceExecutable, ensureSelfInstalledAsService } from '../../packages/myco/src/service/self-install';
import { managedBinaryPath } from '../../packages/myco/src/install/managed-binary';
import { FakeServiceManager } from '../helpers/fake-service-manager';

const DEFAULT_HOME = path.join(os.homedir(), '.myco');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp OS-home with the managed binary present at `<home>/.myco/bin/myco`,
 * and return both the OS-home and the MYCO-HOME (`<home>/.myco`). Callers of
 * `defaultServiceExecutable` pass the myco-home (the resolved `resolveMycoHome()`
 * value the daemon supplies), not the OS-home.
 */
function makeTempHomeWithManagedBinary(): { home: string; mycoHome: string; binPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-managed-'));
  const mycoHome = path.join(home, '.myco');
  const binDir = path.join(mycoHome, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'myco');
  fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { home, mycoHome, binPath };
}

/** Create a temp home dir WITHOUT any managed binary. */
function makeTempHomeEmpty(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-empty-'));
}

/** Create a real temp file to act as a standalone managed binary for integration tests. */
function makeTempBinary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bin-'));
  const bin = path.join(dir, 'myco');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}

class CapturingLogger {
  debugs: Array<{ kind: string; message: string; meta?: Record<string, unknown> }> = [];
  infos: Array<{ kind: string; message: string; meta?: Record<string, unknown> }> = [];
  warns: Array<{ kind: string; message: string; meta?: Record<string, unknown> }> = [];
  debug(kind: string, message: string, meta?: Record<string, unknown>): void { this.debugs.push({ kind, message, meta }); }
  info(kind: string, message: string, meta?: Record<string, unknown>): void { this.infos.push({ kind, message, meta }); }
  warn(kind: string, message: string, meta?: Record<string, unknown>): void { this.warns.push({ kind, message, meta }); }
}

// ---------------------------------------------------------------------------
// Unit tests — defaultServiceExecutable selection logic
// ---------------------------------------------------------------------------

describe('defaultServiceExecutable', () => {
  // The managed-binary preference is keyed on the DEFAULT home now (not a
  // prod/dev variant). A non-default (dogfood) home ALWAYS returns
  // process.execPath — even when a managed binary exists in that home — so a
  // dogfood unit is never re-pointed at the default home's managed binary.

  test('non-default (dogfood) home + managed binary present → returns process.execPath (dogfood guard)', () => {
    const { mycoHome } = makeTempHomeWithManagedBinary();
    // Even though a managed binary exists under this home, a non-default home
    // must NOT use it — the daemon runs the binary it was launched as.
    expect(defaultServiceExecutable(mycoHome, 'darwin')).toBe(process.execPath);
  });

  test('non-default (dogfood) home + managed binary absent → returns process.execPath', () => {
    const home = makeTempHomeEmpty();
    expect(defaultServiceExecutable(home, 'darwin')).toBe(process.execPath);
  });

  test('default home prefers the managed binary at <home>/bin when it exists, else process.execPath', () => {
    // Keyed on the default home — pin the branch logic against the real
    // managed-binary path without writing into the user's ~/.myco/bin.
    const managed = managedBinaryPath(DEFAULT_HOME, 'darwin', process.env.LOCALAPPDATA);
    const expected = fs.existsSync(managed) ? managed : process.execPath;
    expect(defaultServiceExecutable(DEFAULT_HOME, 'darwin')).toBe(expected);
  });

  test('default home managed-binary preference also applies on linux', () => {
    const managed = managedBinaryPath(DEFAULT_HOME, 'linux', process.env.LOCALAPPDATA);
    const expected = fs.existsSync(managed) ? managed : process.execPath;
    expect(defaultServiceExecutable(DEFAULT_HOME, 'linux')).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Threading integration — explicit override wires through to spec.executable
// ---------------------------------------------------------------------------

describe('ensureSelfInstalledAsService executable threading', () => {
  test('explicit executable override is passed through to the installed spec', async () => {
    const managedBin = makeTempBinary();
    const logger = new CapturingLogger();
    const mgr = new FakeServiceManager();

    // We need MYCO_HOME set so buildServiceSpec resolves the log dir.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-threading-'));
    const origHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = tmpHome;

    try {
      await ensureSelfInstalledAsService(logger, {
        executable: managedBin,
        manager: mgr,
        mycoHome: tmpHome,
      });

      expect(mgr.installCalls).toHaveLength(1);
      expect(mgr.installCalls[0].executable).toBe(managedBin);
    } finally {
      if (origHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = origHome;
    }
  });

  test('explicit `executable` override threads through to the service spec', async () => {
    const { home, binPath } = makeTempHomeWithManagedBinary();
    const logger = new CapturingLogger();
    const mgr = new FakeServiceManager();
    const mycoHome = path.join(home, '.myco');

    await ensureSelfInstalledAsService(logger, {
      executable: binPath,
      manager: mgr,
      mycoHome,
    });

    expect(mgr.installCalls).toHaveLength(1);
    expect(mgr.installCalls[0].executable).toBe(binPath);
    expect(logger.warns).toHaveLength(0);
  });

  test('without an explicit override the executable resolves via defaultServiceExecutable for the home', async () => {
    const { mycoHome } = makeTempHomeWithManagedBinary();
    const logger = new CapturingLogger();
    const mgr = new FakeServiceManager();

    // No `executable` override — the default wiring resolves it from the home
    // via defaultServiceExecutable(mycoHome). For a non-default (dogfood) home
    // that is process.execPath — under the test runner that's the `bun` wrapper,
    // which buildServiceSpec rejects (script-runner guard), so the install is
    // skipped with a warn rather than installing a wrapper as the daemon.
    expect(defaultServiceExecutable(mycoHome)).toBe(process.execPath);
    await ensureSelfInstalledAsService(logger, {
      manager: mgr,
      mycoHome,
    });

    expect(mgr.installCalls).toHaveLength(0);
    expect(logger.warns).toHaveLength(1);
    expect(String(logger.warns[0].meta?.error)).toMatch(/script-runner|standalone daemon binary|executable not found/);
  });
});

// Restore any lingering spy in case a test throws before its finally block.
afterEach(() => {
  // No-op sentinel — spies are restored in finally blocks above.
  // Kept here so the suite has a visible afterEach for future per-test cleanup.
});
