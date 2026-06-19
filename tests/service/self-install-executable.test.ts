/**
 * Tests for managed-binary executable resolution in ensureSelfInstalledAsService.
 *
 * Covers `defaultServiceExecutable`: prod variant prefers `~/.myco/bin/myco` when present;
 * dev variant always uses `process.execPath` (dogfood guard).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultServiceExecutable, ensureSelfInstalledAsService } from '../../packages/myco/src/service/self-install';
import { FakeServiceManager } from '../helpers/fake-service-manager';

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
  test('prod + managed binary present → returns the managed binary path', () => {
    const { mycoHome, binPath } = makeTempHomeWithManagedBinary();
    const result = defaultServiceExecutable('prod', mycoHome, 'darwin');
    expect(result).toBe(binPath);
  });

  test('prod + managed binary absent → returns process.execPath', () => {
    const home = makeTempHomeEmpty();
    const result = defaultServiceExecutable('prod', home, 'darwin');
    expect(result).toBe(process.execPath);
  });

  test('dev + managed binary present → returns process.execPath (dogfood guard)', () => {
    const { home } = makeTempHomeWithManagedBinary();
    // Even though managed binary exists, dev variant must NOT use it.
    const result = defaultServiceExecutable('dev', home, 'darwin');
    expect(result).toBe(process.execPath);
  });

  test('dev + managed binary absent → returns process.execPath', () => {
    const home = makeTempHomeEmpty();
    const result = defaultServiceExecutable('dev', home, 'darwin');
    expect(result).toBe(process.execPath);
  });

  test('works on linux platform (uses <mycoHome>/bin path)', () => {
    const { mycoHome, binPath } = makeTempHomeWithManagedBinary();
    const result = defaultServiceExecutable('prod', mycoHome, 'linux');
    expect(result).toBe(binPath);
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
        variant: 'prod',
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

    const origHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(home, '.myco');

    try {
      await ensureSelfInstalledAsService(logger, {
        executable: binPath,
        manager: mgr,
        variant: 'prod',
      });

      expect(mgr.installCalls).toHaveLength(1);
      expect(mgr.installCalls[0].executable).toBe(binPath);
      expect(logger.warns).toHaveLength(0);
    } finally {
      if (origHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = origHome;
    }
  });

  test('prod without explicit override resolves the managed binary via resolveMycoHome (default wiring)', async () => {
    const { mycoHome, binPath } = makeTempHomeWithManagedBinary();
    const logger = new CapturingLogger();
    const mgr = new FakeServiceManager();

    const origHome = process.env.MYCO_HOME;
    // The default wiring uses resolveMycoHome(), which honors $MYCO_HOME — no
    // os.homedir() mock needed (the old default read os.homedir() directly).
    process.env.MYCO_HOME = mycoHome;

    try {
      // No `executable` override — the default wiring must resolve it.
      await ensureSelfInstalledAsService(logger, {
        manager: mgr,
        variant: 'prod',
      });

      expect(mgr.installCalls).toHaveLength(1);
      expect(mgr.installCalls[0].executable).toBe(binPath);
      expect(logger.warns).toHaveLength(0);
    } finally {
      if (origHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = origHome;
    }
  });
});

// Restore any lingering spy in case a test throws before its finally block.
afterEach(() => {
  // No-op sentinel — spies are restored in finally blocks above.
  // Kept here so the suite has a visible afterEach for future per-test cleanup.
});
