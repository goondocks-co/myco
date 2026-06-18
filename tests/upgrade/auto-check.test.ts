/**
 * Tests for `upgrade/auto-check.ts`:
 *
 *   checkAndStage — stages when newer / no-ops when up-to-date /
 *                   already-staged / dev-build
 *   resolveNewestStagedVersion — semver sort + filter
 *
 * All I/O is hermetic (no network, no real fs writes for the noop paths).
 * The stageBinary dep is mocked so only the guard logic is exercised here;
 * the full download+verify flow is tested in apply-binary.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkAndStage,
  resolveNewestStagedVersion,
  type CheckAndStageDeps,
} from '@myco/upgrade/auto-check.js';
import * as updateChecker from '@myco/daemon/update-checker.js';
import { versionBinaryPath, versionsDir } from '@myco/install/managed-binary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLATFORM: NodeJS.Platform = 'linux';
const CURRENT_VERSION = '1.0.0';
const NEWER_VERSION = '1.1.0';
const OLDER_VERSION = '0.9.0';

function silentLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function mockStageBinaryOk(version: string) {
  return mock(async (_params: unknown, _deps: unknown) =>
    ({ versionDir: `/fake/versions/${version}`, version }),
  );
}

function mockStageBinaryError() {
  return mock(async (_params: unknown, _deps: unknown) =>
    ({ error: 'download failed' }),
  );
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-check-test-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  // Restore the isUpdateExempt shim if it was patched.
  mock.restore();
});

// ---------------------------------------------------------------------------
// Helper to build default checkAndStage opts
// ---------------------------------------------------------------------------

function makeOpts(channel: 'stable' | 'beta' = 'stable') {
  return {
    home: tmpHome,
    platform: PLATFORM,
    logger: silentLogger(),
    channel,
  };
}

// ---------------------------------------------------------------------------
// checkAndStage: dev-build no-op
// ---------------------------------------------------------------------------

describe('checkAndStage: dev-build no-op', () => {
  it('returns noop/dev-build when isDevBuild() is true, even with a newer version', async () => {
    const stageBinaryMock = mock(async () => ({ error: 'should-not-be-called' }));
    const result = await checkAndStage(
      CURRENT_VERSION,
      makeOpts(),
      {
        isDevBuild: () => true, // simulate dev build
        resolveRefs: async () => ({
          assetUrl: 'http://example.com/asset',
          sha256sumsUrl: 'http://example.com/sums',
          assetName: 'myco-linux-x64',
          targetVersion: NEWER_VERSION,
        }),
        stageBinary: stageBinaryMock as typeof import('@myco/upgrade/apply-binary.js').stageBinary,
        existsSync: () => false,
      },
    );
    expect(result.status).toBe('noop');
    expect((result as { reason: string }).reason).toBe('dev-build');
    // stageBinary must not have been called.
    expect(stageBinaryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkAndStage: up-to-date no-op
// ---------------------------------------------------------------------------

describe('checkAndStage: up-to-date no-op', () => {
  it('no-ops when resolved version equals current', async () => {
    const result = await checkAndStage(
      CURRENT_VERSION,
      makeOpts(),
      {
        isDevBuild: () => false,
        resolveRefs: async () => ({
          assetUrl: 'http://x',
          sha256sumsUrl: 'http://y',
          assetName: 'myco-linux-x64',
          targetVersion: CURRENT_VERSION, // same version
        }),
        stageBinary: mock(async () => ({ error: 'should-not-reach' })) as typeof import('@myco/upgrade/apply-binary.js').stageBinary,
        existsSync: () => false,
      },
    );
    expect(result.status).toBe('noop');
    expect((result as { reason: string }).reason).toBe('up-to-date');
  });

  it('no-ops when resolved version is OLDER than current', async () => {
    const result = await checkAndStage(
      CURRENT_VERSION,
      makeOpts(),
      {
        isDevBuild: () => false,
        resolveRefs: async () => ({
          assetUrl: 'http://x',
          sha256sumsUrl: 'http://y',
          assetName: 'myco-linux-x64',
          targetVersion: OLDER_VERSION,
        }),
        stageBinary: mock(async () => ({ error: 'should-not-reach' })) as typeof import('@myco/upgrade/apply-binary.js').stageBinary,
        existsSync: () => false,
      },
    );
    expect(result.status).toBe('noop');
    expect((result as { reason: string }).reason).toBe('up-to-date');
  });

  it('no-ops when resolver returns null (no release for channel)', async () => {
    const result = await checkAndStage(
      CURRENT_VERSION,
      makeOpts(),
      {
        isDevBuild: () => false,
        resolveRefs: async () => null,
        stageBinary: mock(async () => ({ error: 'should-not-reach' })) as typeof import('@myco/upgrade/apply-binary.js').stageBinary,
        existsSync: () => false,
      },
    );
    expect(result.status).toBe('noop');
    expect((result as { reason: string }).reason).toBe('up-to-date');
  });
});

// ---------------------------------------------------------------------------
// checkAndStage: already-staged no-op
// ---------------------------------------------------------------------------

describe('checkAndStage: already-staged no-op', () => {
  it('no-ops when the versioned binary already exists on disk', async () => {
    const existsMap = new Map<string, boolean>();
    const binPath = versionBinaryPath(tmpHome, PLATFORM, NEWER_VERSION);
    existsMap.set(binPath, true);

    const result = await checkAndStage(
      CURRENT_VERSION,
      makeOpts(),
      {
        isDevBuild: () => false,
        resolveRefs: async () => ({
          assetUrl: 'http://x',
          sha256sumsUrl: 'http://y',
          assetName: 'myco-linux-x64',
          targetVersion: NEWER_VERSION,
        }),
        stageBinary: mock(async () => ({ error: 'should-not-reach' })) as typeof import('@myco/upgrade/apply-binary.js').stageBinary,
        existsSync: (p: string) => existsMap.get(p) ?? false,
      },
    );
    expect(result.status).toBe('noop');
    expect((result as { reason: string }).reason).toBe('already-staged');
  });
});

// ---------------------------------------------------------------------------
// checkAndStage: successful staging
// ---------------------------------------------------------------------------

describe('checkAndStage: successful staging', () => {
  it('returns staged when a newer version is resolved and not yet staged', async () => {
    const stageBinaryMock = mockStageBinaryOk(NEWER_VERSION);
    const result = await checkAndStage(
      CURRENT_VERSION,
      makeOpts(),
      {
        isDevBuild: () => false,
        resolveRefs: async () => ({
          assetUrl: 'http://x',
          sha256sumsUrl: 'http://y',
          assetName: 'myco-linux-x64',
          targetVersion: NEWER_VERSION,
        }),
        stageBinary: stageBinaryMock as typeof import('@myco/upgrade/apply-binary.js').stageBinary,
        existsSync: () => false,
      },
    );
    expect(result.status).toBe('staged');
    expect((result as { version: string }).version).toBe(NEWER_VERSION);
    expect(stageBinaryMock).toHaveBeenCalledTimes(1);
  });

  it('returns error when stageBinary fails', async () => {
    const stageBinaryMock = mockStageBinaryError();
    const result = await checkAndStage(
      CURRENT_VERSION,
      makeOpts(),
      {
        isDevBuild: () => false,
        resolveRefs: async () => ({
          assetUrl: 'http://x',
          sha256sumsUrl: 'http://y',
          assetName: 'myco-linux-x64',
          targetVersion: NEWER_VERSION,
        }),
        stageBinary: stageBinaryMock as typeof import('@myco/upgrade/apply-binary.js').stageBinary,
        existsSync: () => false,
      },
    );
    expect(result.status).toBe('error');
    expect((result as { error: string }).error).toBe('download failed');
  });

  it('returns error when resolveRefs throws', async () => {
    const result = await checkAndStage(
      CURRENT_VERSION,
      makeOpts(),
      {
        isDevBuild: () => false,
        resolveRefs: async () => { throw new Error('network down'); },
        existsSync: () => false,
      },
    );
    expect(result.status).toBe('error');
    expect((result as { error: string }).error).toContain('network down');
  });
});

// ---------------------------------------------------------------------------
// resolveNewestStagedVersion
// ---------------------------------------------------------------------------

describe('resolveNewestStagedVersion', () => {
  it('returns null when versions dir does not exist', () => {
    const result = resolveNewestStagedVersion(
      tmpHome,
      PLATFORM,
      CURRENT_VERSION,
      undefined,
      () => false, // existsSync returns false
      () => [],
    );
    expect(result).toBeNull();
  });

  it('returns null when no staged version is strictly newer than current', () => {
    const vDir = versionsDir(tmpHome, PLATFORM);
    const result = resolveNewestStagedVersion(
      tmpHome,
      PLATFORM,
      CURRENT_VERSION,
      undefined,
      (p: string) => p === vDir,
      () => [CURRENT_VERSION, OLDER_VERSION],
    );
    expect(result).toBeNull();
  });

  it('returns the newest staged version when one exists', () => {
    const vDir = versionsDir(tmpHome, PLATFORM);
    const result = resolveNewestStagedVersion(
      tmpHome,
      PLATFORM,
      CURRENT_VERSION,
      undefined,
      (p: string) => p === vDir,
      () => ['1.1.0', '1.2.0', '0.9.0'],
    );
    expect(result).toBe('1.2.0');
  });

  it('filters out non-semver entries', () => {
    const vDir = versionsDir(tmpHome, PLATFORM);
    const result = resolveNewestStagedVersion(
      tmpHome,
      PLATFORM,
      CURRENT_VERSION,
      undefined,
      (p: string) => p === vDir,
      () => ['not-a-version', '1.1.0', 'also-bad'],
    );
    expect(result).toBe('1.1.0');
  });

  it('returns null when readdir throws', () => {
    const vDir = versionsDir(tmpHome, PLATFORM);
    const result = resolveNewestStagedVersion(
      tmpHome,
      PLATFORM,
      CURRENT_VERSION,
      undefined,
      (p: string) => p === vDir,
      () => { throw new Error('EACCES'); },
    );
    expect(result).toBeNull();
  });
});
