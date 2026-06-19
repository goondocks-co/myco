/**
 * Tests for the coexistence fix: resolveManagedBinaryPath() resolve order.
 *
 * Incident context (2026-06-17): a dogfood `service-dev` daemon holding the
 * `symbiont-config` claim was writing its own `process.execPath` (the dev-repo
 * binary) into the GLOBAL `~/.claude/settings.json` hooks. That binary refuses
 * prod-owned Groves → silent capture failure for every non-dogfood project.
 *
 * The fix inserts the converged managed binary (`~/.myco/bin/myco`) as the
 * PREFERRED path when it exists on disk: pin → managed (on disk) → execPath.
 */

import { describe, it, expect, afterAll, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any import that resolves update-checker
// ---------------------------------------------------------------------------

const realUpdateChecker = await import('@myco/daemon/update-checker.js');

let mockResolveRuntimeCommand: () => string | null = () => null;

mock.module('@myco/daemon/update-checker.js', () => ({
  ...realUpdateChecker,
  resolveRuntimeCommand: () => mockResolveRuntimeCommand(),
}));

afterAll(() => {
  mock.module('@myco/daemon/update-checker.js', () => realUpdateChecker);
});

// Import AFTER mocking so the stub is in place when installer.ts loads
import { resolveManagedBinaryPath } from '@myco/symbionts/installer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp home with a managed binary on disk at `<mycoHome>/bin/myco`. */
function makeTempHomeWithManagedBinary(): { home: string; mycoHome: string; managedPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mbp-test-'));
  // The temp dir is the OS-home; the myco-home is `<home>/.myco` (what the
  // daemon passes as `resolveMycoHome()`). The managed binary lives under it.
  const mycoHome = path.join(home, '.myco');
  const binDir = path.join(mycoHome, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const managedPath = path.join(binDir, 'myco');
  fs.writeFileSync(managedPath, '#!/bin/sh\nexec myco "$@"', 'utf8');
  return { home, mycoHome, managedPath };
}

/** Create a temp home directory WITHOUT a managed binary on disk. */
function makeTempHomeWithoutManagedBinary(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mbp-nobin-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveManagedBinaryPath', () => {
  describe('pin wins (machine runtime.command)', () => {
    it('returns the pin path when resolveRuntimeCommand returns a value, ignoring managed binary existence', () => {
      const { home, managedPath } = makeTempHomeWithManagedBinary();
      const pin = '/opt/special/bin/myco';
      mockResolveRuntimeCommand = () => pin;

      try {
        const result = resolveManagedBinaryPath(home, 'linux');
        expect(result).toBe(pin);
        expect(result).not.toBe(managedPath.replaceAll('\\', '/'));
        expect(result).not.toBe(process.execPath.replaceAll('\\', '/'));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
        mockResolveRuntimeCommand = () => null;
      }
    });

    it('forward-slashes the pin path', () => {
      const home = makeTempHomeWithoutManagedBinary();
      const pin = 'C:\\Users\\test\\AppData\\Local\\Myco\\bin\\myco.exe';
      mockResolveRuntimeCommand = () => pin;

      try {
        const result = resolveManagedBinaryPath(home, 'win32');
        expect(result).toBe('C:/Users/test/AppData/Local/Myco/bin/myco.exe');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
        mockResolveRuntimeCommand = () => null;
      }
    });
  });

  describe('managed binary preferred over execPath (coexistence fix)', () => {
    it('returns the managed binary when no pin AND managed binary exists on disk', () => {
      const { home, mycoHome, managedPath } = makeTempHomeWithManagedBinary();
      mockResolveRuntimeCommand = () => null;

      try {
        const result = resolveManagedBinaryPath(mycoHome, 'linux');
        // KEY ASSERTION: the managed path wins over process.execPath
        expect(result).toBe(managedPath.replaceAll('\\', '/'));
        expect(result).not.toBe(process.execPath.replaceAll('\\', '/'));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('returns the managed binary regardless of what process.execPath is (dev daemon scenario)', () => {
      // Simulates the exact incident: a dev daemon (execPath = dev-repo binary)
      // owns the symbiont-config claim and writes global hook config. With a
      // converged ~/.myco/bin/myco on disk, the hook MUST embed that managed path,
      // not the writing daemon's own execPath.
      const { home, mycoHome, managedPath } = makeTempHomeWithManagedBinary();
      mockResolveRuntimeCommand = () => null;

      // The dev daemon's execPath is something like
      // packages/myco-darwin-arm64/bin/myco — but we only need to verify
      // that the result is the managed path, not process.execPath.
      try {
        const result = resolveManagedBinaryPath(mycoHome, 'linux');
        expect(result).toBe(managedPath.replaceAll('\\', '/'));
        // This is the incident fix: the writer's own binary must not appear
        expect(result).not.toContain(process.execPath.replaceAll('\\', '/'));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    // Win32 managed path uses win32.join (backslash-separated) which is only
    // resolvable by fs.existsSync on an actual Windows host. Skip on other platforms.
    const itOnWindows = process.platform === 'win32' ? it : it.skip;
    itOnWindows('returns win32 managed binary path when on disk and no pin', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mbp-win-test-'));
      // Windows managed path: <home>/AppData/Local/Myco/bin/myco.exe
      const binDir = path.join(home, 'AppData', 'Local', 'Myco', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const managedPath = path.join(binDir, 'myco.exe');
      fs.writeFileSync(managedPath, 'placeholder', 'utf8');
      mockResolveRuntimeCommand = () => null;

      try {
        const result = resolveManagedBinaryPath(home, 'win32');
        // Forward-slashed windows path
        expect(result).toBe(managedPath.replaceAll('\\', '/'));
        expect(result).not.toBe(process.execPath.replaceAll('\\', '/'));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
        mockResolveRuntimeCommand = () => null;
      }
    });
  });

  describe('execPath fallback (pre-convergence, no managed binary on disk)', () => {
    it('returns process.execPath when no pin AND no managed binary exists', () => {
      const home = makeTempHomeWithoutManagedBinary();
      mockResolveRuntimeCommand = () => null;

      try {
        const result = resolveManagedBinaryPath(home, 'linux');
        expect(result).toBe(process.execPath.replaceAll('\\', '/'));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('forward-slashes the execPath fallback', () => {
      const home = makeTempHomeWithoutManagedBinary();
      mockResolveRuntimeCommand = () => null;

      try {
        const result = resolveManagedBinaryPath(home, process.platform);
        // Result must have no backslashes
        expect(result).not.toContain('\\');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe('resolve order invariants', () => {
    it('pin beats managed binary when both exist', () => {
      const { home } = makeTempHomeWithManagedBinary();
      const pin = '/pinned/bin/myco';
      mockResolveRuntimeCommand = () => pin;

      try {
        const result = resolveManagedBinaryPath(home, 'linux');
        expect(result).toBe(pin);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
        mockResolveRuntimeCommand = () => null;
      }
    });

    it('managed binary beats execPath when managed exists but no pin', () => {
      const { home, mycoHome, managedPath } = makeTempHomeWithManagedBinary();
      mockResolveRuntimeCommand = () => null;

      try {
        const result = resolveManagedBinaryPath(mycoHome, 'linux');
        expect(result).toBe(managedPath.replaceAll('\\', '/'));
        // execPath must not appear unless it happens to equal the managed path
        if (process.execPath.replaceAll('\\', '/') !== managedPath.replaceAll('\\', '/')) {
          expect(result).not.toBe(process.execPath.replaceAll('\\', '/'));
        }
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
