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
  markAdoptFailed,
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
// checkAndStage: manual-channel no-op (T1)
// ---------------------------------------------------------------------------

describe('checkAndStage: manual-channel no-op', () => {
  it('returns noop/manual-channel when isManualChannel() is true, even with a newer version', async () => {
    const stageBinaryMock = mock(async () => ({ error: 'should-not-be-called' }));
    const result = await checkAndStage(
      CURRENT_VERSION,
      makeOpts(),
      {
        isDevBuild: () => false,
        isManualChannel: () => true,
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
    expect((result as { reason: string }).reason).toBe('manual-channel');
    expect(stageBinaryMock).not.toHaveBeenCalled();
  });

  it('proceeds normally when isManualChannel() is false (stable channel)', async () => {
    const stageBinaryMock = mock(async (_params: unknown, _deps: unknown) =>
      ({ versionDir: `/fake/versions/${NEWER_VERSION}`, version: NEWER_VERSION }),
    );
    const result = await checkAndStage(
      CURRENT_VERSION,
      makeOpts('stable'),
      {
        isDevBuild: () => false,
        isManualChannel: () => false,
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
    expect(stageBinaryMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// buildAdoptJobFn: manual-channel no-op (T1)
// ---------------------------------------------------------------------------

describe('buildAdoptJobFn: manual-channel no-op', () => {
  it('returns immediately (no-op) when isManualChannel() is true', async () => {
    const { buildAdoptJobFn } = await import('@myco/upgrade/auto-check.js');
    const initiateAdoptMock = mock(async () => {});

    const jobFn = buildAdoptJobFn({
      currentVersion: CURRENT_VERSION,
      home: tmpHome,
      platform: PLATFORM,
      stateDir: tmpHome,
      daemonPort: 20915,
      projectRoot: '/project',
      logger: silentLogger(),
      isDevBuild: () => false,
      isManualChannel: () => true,
      initiateAdopt: initiateAdoptMock as typeof import('@myco/upgrade/adopt.js').initiateAdopt,
      resolveServiceLabel: async () => null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await jobFn({} as any);

    expect(initiateAdoptMock).not.toHaveBeenCalled();
  });

  it('proceeds to initiateAdopt when isManualChannel() is false and a staged version exists', async () => {
    const { buildAdoptJobFn } = await import('@myco/upgrade/auto-check.js');
    const initiateAdoptMock = mock(async () => {});

    // Stage a fake newer binary so resolveNewestStagedVersion finds something.
    const { versionsDir: getVersionsDir, versionBinaryPath: getVersionBinaryPath } = await import('@myco/install/managed-binary.js');
    const vDir = getVersionsDir(tmpHome, PLATFORM);
    const binPath = getVersionBinaryPath(tmpHome, PLATFORM, NEWER_VERSION);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, '#!/bin/sh\necho myco', { mode: 0o755 });

    const jobFn = buildAdoptJobFn({
      currentVersion: CURRENT_VERSION,
      home: tmpHome,
      platform: PLATFORM,
      stateDir: tmpHome,
      daemonPort: 20915,
      projectRoot: '/project',
      logger: silentLogger(),
      isDevBuild: () => false,
      isManualChannel: () => false,
      initiateAdopt: initiateAdoptMock as typeof import('@myco/upgrade/adopt.js').initiateAdopt,
      resolveServiceLabel: async () => null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await jobFn({} as any);

    expect(initiateAdoptMock).toHaveBeenCalledTimes(1);

    // Clean up staged binary.
    fs.rmSync(vDir, { recursive: true, force: true });
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

  it('skips a version whose adopt already failed (marker present), returning the next-newest', () => {
    const vDir = versionsDir(tmpHome, PLATFORM);
    const failedMarker = path.join(vDir, '1.3.0', '.adopt-failed');
    const result = resolveNewestStagedVersion(
      tmpHome,
      PLATFORM,
      CURRENT_VERSION,
      undefined,
      // versions dir exists; 1.3.0 carries the failed marker, 1.2.0 does not.
      (p: string) => p === vDir || p === failedMarker,
      () => ['1.2.0', '1.3.0'],
    );
    expect(result).toBe('1.2.0');
  });

  it('returns null when the ONLY newer staged version is marked failed', () => {
    const vDir = versionsDir(tmpHome, PLATFORM);
    const failedMarker = path.join(vDir, '1.3.0', '.adopt-failed');
    const result = resolveNewestStagedVersion(
      tmpHome,
      PLATFORM,
      CURRENT_VERSION,
      undefined,
      (p: string) => p === vDir || p === failedMarker,
      () => ['1.3.0'],
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// markAdoptFailed
// ---------------------------------------------------------------------------

describe('markAdoptFailed', () => {
  it('writes the .adopt-failed marker into an existing version slot', () => {
    const dir = path.join(versionsDir(tmpHome, PLATFORM), '1.3.0');
    fs.mkdirSync(dir, { recursive: true });
    markAdoptFailed(tmpHome, PLATFORM, '1.3.0');
    expect(fs.existsSync(path.join(dir, '.adopt-failed'))).toBe(true);
  });

  it('no-ops (no throw) when the version slot does not exist', () => {
    expect(() => markAdoptFailed(tmpHome, PLATFORM, '9.9.9')).not.toThrow();
    expect(fs.existsSync(path.join(versionsDir(tmpHome, PLATFORM), '9.9.9'))).toBe(false);
  });
});
