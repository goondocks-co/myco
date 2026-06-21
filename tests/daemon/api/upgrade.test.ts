/**
 * Tests for the upgrade API route handlers (daemon/api/upgrade.ts).
 *
 * Covers:
 * - handleUpgradeStatus: exempt, version-sync self-restart (restarting/reason),
 *   union assembly from cache, stale cache triggers background fetch, null cache fallback
 * - handleUpgradeCheck: live resolveMycoPackageCheck + checkOperatorCliVersions,
 *   union CheckResult assembly, partial failure, 400 when exempt
 * - handleUpgradeApply: myco → initiateAdopt on staged version; operator CLIs →
 *   spawnUpdateScript; 400/409/422 error cases; beta→stable revert; service label routing
 * - handleUpgradeChannel: writes config + clears cache, 400 for invalid channel
 *
 * Route: /api/upgrade/{status,check,apply,channel}
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports
// ---------------------------------------------------------------------------

// Capture real modules so afterAll can restore them. bun:test's mock.module()
// is process-scoped — without the restore, stubs leak into later test files.
const realUpdateChecker = await import('@myco/daemon/update-checker.js');
const realSpawn = await import('@myco/upgrade/spawn.js');
const realAdopt = await import('@myco/upgrade/adopt.js');
const realAutoCheck = await import('@myco/upgrade/auto-check.js');
const realMycoChecker = await import('@myco/upgrade/checker.js');
const realOperatorCli = await import('@myco/daemon/operator-cli-versions.js');

mock.module('@myco/daemon/update-checker.js', () => ({
  releaseChannelIsManual: vi.fn(() => false),
  readCachedCheck: vi.fn(() => null),
  readUpdateConfig: vi.fn(() => ({ channel: 'stable', check_interval_hours: 6 })),
  readProjectReleaseChannel: vi.fn(() => 'stable'),
  writeProjectReleaseChannel: vi.fn(),
  clearCachedCheck: vi.fn(),
  isCacheStale: vi.fn(() => false),
  getInstalledVersion: vi.fn(() => null),
  resolveMycoBinary: vi.fn(() => 'myco'),
  resolveRuntimeCommand: vi.fn(() => null),
}));

mock.module('@myco/upgrade/spawn.js', () => ({
  spawnUpdateScript: vi.fn(() => '/tmp/myco-update-123.sh'),
  spawnRestartScript: vi.fn(() => '/tmp/myco-restart-123.sh'),
}));

mock.module('@myco/upgrade/adopt.js', () => ({
  initiateAdopt: vi.fn(() => Promise.resolve()),
}));

mock.module('@myco/upgrade/auto-check.js', () => ({
  resolveNewestStagedVersion: vi.fn(() => null),
  checkAndStage: vi.fn(),
  buildAdoptJobFn: vi.fn(),
}));

mock.module('@myco/upgrade/checker.js', () => ({
  resolveMycoPackageCheck: vi.fn(),
}));

mock.module('@myco/daemon/operator-cli-versions.js', () => ({
  checkOperatorCliVersions: vi.fn(() => Promise.resolve([])),
}));

afterAll(() => {
  mock.module('@myco/daemon/update-checker.js', () => realUpdateChecker);
  mock.module('@myco/upgrade/spawn.js', () => realSpawn);
  mock.module('@myco/upgrade/adopt.js', () => realAdopt);
  mock.module('@myco/upgrade/auto-check.js', () => realAutoCheck);
  mock.module('@myco/upgrade/checker.js', () => realMycoChecker);
  mock.module('@myco/daemon/operator-cli-versions.js', () => realOperatorCli);
});

import {
  releaseChannelIsManual,
  readCachedCheck,
  readUpdateConfig,
  readProjectReleaseChannel,
  writeProjectReleaseChannel,
  clearCachedCheck,
  isCacheStale,
  getInstalledVersion,
  resolveRuntimeCommand,
} from '@myco/daemon/update-checker.js';
import { spawnUpdateScript, spawnRestartScript } from '@myco/upgrade/spawn.js';
import { initiateAdopt } from '@myco/upgrade/adopt.js';
import { resolveNewestStagedVersion } from '@myco/upgrade/auto-check.js';
import { resolveMycoPackageCheck } from '@myco/upgrade/checker.js';
import { checkOperatorCliVersions } from '@myco/daemon/operator-cli-versions.js';
import { createUpgradeHandlers } from '@myco/daemon/api/upgrade.js';
import { serviceLabel } from '@myco/service/labels.js';
import { resolveMycoHome } from '@myco/grove/paths.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import { FakeServiceManager } from '../../helpers/fake-service-manager.js';
import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context.js';

// ---------------------------------------------------------------------------
// Type alias for the mock() shape so .mockReturnValue / .mockResolvedValue
// are visible to TypeScript. The vi.mocked() shim is an identity fn and adds
// no type information; cast directly via this alias.
// ---------------------------------------------------------------------------
type AnyMock = ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Pre-installed service helper
// ---------------------------------------------------------------------------

// The runner sets a hermetic sandbox MYCO_HOME, so the daemon's service label
// is the home-derived label for that sandbox — resolve it the same way the
// production code does so detectServiceManagedLabel(mgr) finds the seeded fake.
const HOME_LABEL = serviceLabel(resolveMycoHome());

function installedServiceManager(shellCmd: string, label: string = HOME_LABEL): FakeServiceManager {
  const mgr = new FakeServiceManager();
  mgr.installed.add(label);
  mgr.statuses.set(label, { installed: true, running: true, pid: process.pid, lastExitCode: 0, unitPath: '/x' });
  mgr.restartShellCommands.set(label, shellCmd);
  return mgr;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    body: {},
    requestContext: TEST_REQUEST_CONTEXT,
    query: {},
    params: {},
    pathname: '/api/upgrade/status',
    ...overrides,
  };
}

/** Default CachedCheck for a myco-only cache with an update available. */
function makeUpdateCache() {
  return {
    checked_at: new Date().toISOString(),
    channel: 'stable' as const,
    packages: {
      myco: {
        package_name: '@goondocks/myco',
        latest_stable: '1.1.0',
        latest_beta: null,
      },
    },
  };
}

/** Default CachedCheck for a myco-only cache where we are already up to date. */
function makeNoUpdateCache() {
  return {
    checked_at: new Date().toISOString(),
    channel: 'stable' as const,
    packages: {
      myco: {
        package_name: '@goondocks/myco',
        latest_stable: '1.0.0',
        latest_beta: null,
      },
    },
  };
}

/** A representative live PackageCheckResult with update available (as returned by resolveMycoPackageCheck). */
const MYCO_PKG_UPDATE = {
  id: 'myco',
  display_name: 'Myco',
  package_name: '@goondocks/myco',
  installed: true,
  installed_version: '1.0.0',
  latest_version: '1.1.0',
  latest_stable: '1.1.0',
  latest_beta: null,
  update_available: true,
  revert_available: false,
};

/** Default deps for tests. Each call gets a fresh tmpdir for the sentinel. */
function makeDeps(overrides: Record<string, unknown> = {}) {
  const daemonStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-upgrade-test-'));
  return {
    vaultDir: '/vault',
    projectRoot: '/project',
    currentVersion: '1.0.0',
    daemonPort: 20915,
    daemonStateDir,
    home: '/home/user/.myco',
    platform: 'darwin' as NodeJS.Platform,
    localAppData: undefined,
    scheduleShutdown: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleUpgradeStatus
// ---------------------------------------------------------------------------

describe('handleUpgradeStatus', () => {
  beforeEach(() => {
    mock.clearAllMocks();
    (releaseChannelIsManual as AnyMock).mockReturnValue(false);
    (readCachedCheck as AnyMock).mockReturnValue(null);
    (readUpdateConfig as AnyMock).mockReturnValue({ channel: 'stable', check_interval_hours: 6 });
    (readProjectReleaseChannel as AnyMock).mockReturnValue('stable');
    (isCacheStale as AnyMock).mockReturnValue(false);
    (resolveRuntimeCommand as AnyMock).mockReturnValue(null);
    (getInstalledVersion as AnyMock).mockReturnValue(null);
  });

  it('returns status from cache when cache has data', async () => {
    (readCachedCheck as AnyMock).mockReturnValue(makeNoUpdateCache());
    (isCacheStale as AnyMock).mockReturnValue(false);

    const { handleUpgradeStatus } = createUpgradeHandlers(makeDeps());
    const result = await handleUpgradeStatus(makeReq());
    const body = result.body as Record<string, unknown>;

    expect(body.exempt).toBe(false);
    expect(body.update_available).toBe(false);
    // Fresh cache — no background live check needed
    expect(resolveMycoPackageCheck).not.toHaveBeenCalled();
  });

  it('kicks off background check when cache is stale', async () => {
    (readCachedCheck as AnyMock).mockReturnValue(makeNoUpdateCache());
    (isCacheStale as AnyMock).mockReturnValue(true);
    (resolveMycoPackageCheck as AnyMock).mockResolvedValue(MYCO_PKG_UPDATE);
    (checkOperatorCliVersions as AnyMock).mockResolvedValue([]);

    const { handleUpgradeStatus } = createUpgradeHandlers(makeDeps());
    const result = await handleUpgradeStatus(makeReq());

    // Handler returns immediately with cached data; fire-and-forget refresh kicks off
    expect(result.body).toMatchObject({ exempt: false });
  });

  it('returns default status body when no cache exists', async () => {
    (readCachedCheck as AnyMock).mockReturnValue(null);
    (isCacheStale as AnyMock).mockReturnValue(true);

    const { handleUpgradeStatus } = createUpgradeHandlers(makeDeps());
    const result = await handleUpgradeStatus(makeReq());
    const body = result.body as Record<string, unknown>;

    expect(body.exempt).toBe(false);
    expect(body.update_available).toBe(false);
    expect(body.running_version).toBe('1.0.0');
    expect(body.channel).toBe('stable');
    expect(body.channel_scope).toBe('machine');
    expect(body.runtime_scope).toBe('machine');
    expect(body.last_check).toBe('');
  });

  it('union packages[] has myco as first row', async () => {
    (readCachedCheck as AnyMock).mockReturnValue(makeUpdateCache());
    (getInstalledVersion as AnyMock).mockReturnValue('1.0.0');

    const { handleUpgradeStatus } = createUpgradeHandlers(makeDeps({ globalPrefix: '/usr/local' }));
    const result = await handleUpgradeStatus(makeReq());
    const body = result.body as Record<string, unknown>;
    const packages = body.packages as Array<{ id: string }>;

    expect(packages).toBeDefined();
    expect(packages[0]?.id).toBe('myco');
  });

  it('top-level update_available is true when myco package has update', async () => {
    (readCachedCheck as AnyMock).mockReturnValue(makeUpdateCache());
    (getInstalledVersion as AnyMock).mockReturnValue('1.0.0');

    const { handleUpgradeStatus } = createUpgradeHandlers(makeDeps({ globalPrefix: '/usr/local' }));
    const result = await handleUpgradeStatus(makeReq());
    const body = result.body as Record<string, unknown>;

    expect(body.update_available).toBe(true);
  });

  it('top-level update_available is false when already at latest', async () => {
    (readCachedCheck as AnyMock).mockReturnValue(makeNoUpdateCache());
    (getInstalledVersion as AnyMock).mockReturnValue('1.0.0');

    const { handleUpgradeStatus } = createUpgradeHandlers(makeDeps({ globalPrefix: '/usr/local' }));
    const result = await handleUpgradeStatus(makeReq());
    const body = result.body as Record<string, unknown>;

    expect(body.update_available).toBe(false);
  });

  // T7 — combined GitHub (myco) + npm (operator CLI) routing in a single status call
  it('packages[] union contains myco (GitHub) row first then operator (npm) rows; update_available aggregates correctly (T7)', async () => {
    // Cache with both myco AND an operator CLI (myco-team) having updates.
    (readCachedCheck as AnyMock).mockReturnValue({
      checked_at: new Date().toISOString(),
      channel: 'stable' as const,
      packages: {
        myco: {
          package_name: '@goondocks/myco',
          latest_stable: '1.1.0',
          latest_beta: null,
        },
        'myco-team': {
          package_name: '@goondocks/myco-team',
          latest_stable: '0.2.0',
          latest_beta: null,
        },
      },
    });
    // myco: installed 1.0.0 (update to 1.1.0); myco-team: installed 0.1.0 (update to 0.2.0).
    (getInstalledVersion as AnyMock).mockImplementation(
      (_globalPrefix: unknown, pkg?: unknown) => {
        if (!pkg || pkg === '@goondocks/myco') return '1.0.0';
        if (pkg === '@goondocks/myco-team') return '0.1.0';
        return null;
      },
    );
    (isCacheStale as AnyMock).mockReturnValue(false);

    const { handleUpgradeStatus } = createUpgradeHandlers(makeDeps({ globalPrefix: '/usr/local' }));
    const result = await handleUpgradeStatus(makeReq());
    const body = result.body as Record<string, unknown>;
    const packages = body.packages as Array<{ id: string; update_available: boolean; installed: boolean }>;

    // myco (GitHub resolver) must be first.
    expect(packages[0]?.id).toBe('myco');
    // Operator row (npm resolver) must also be present.
    const operatorRow = packages.find((p) => p.id === 'myco-team');
    expect(operatorRow).toBeDefined();
    expect(operatorRow?.update_available).toBe(true);

    // Top-level aggregate must be true because at least one installed package has an update.
    expect(body.update_available).toBe(true);
    // revert_available must be false (running stable, not a prerelease).
    expect(body.revert_available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleUpgradeStatus — version-sync self-restart branch
// ---------------------------------------------------------------------------

describe('handleUpgradeStatus — version-sync restart', () => {
  beforeEach(() => {
    mock.clearAllMocks();
    (readCachedCheck as AnyMock).mockReturnValue(null);
    (readUpdateConfig as AnyMock).mockReturnValue({ channel: 'stable', check_interval_hours: 6 });
    (readProjectReleaseChannel as AnyMock).mockReturnValue('stable');
    (isCacheStale as AnyMock).mockReturnValue(false);
    (getInstalledVersion as AnyMock).mockReturnValue(null);
    (resolveRuntimeCommand as AnyMock).mockReturnValue(null);
    (spawnRestartScript as AnyMock).mockReturnValue('/tmp/myco-restart-123.sh');
  });
  afterEach(() => {
    mock.clearAllMocks();
  });

  it('triggers auto-restart and returns restarting:true when installed > running', async () => {
    (getInstalledVersion as AnyMock).mockReturnValue('1.1.0');
    const scheduleShutdown = vi.fn();
    const { handleUpgradeStatus } = createUpgradeHandlers(
      makeDeps({ scheduleShutdown, globalPrefix: '/usr/local' }),
    );

    const result = await handleUpgradeStatus(makeReq());

    expect(spawnRestartScript).toHaveBeenCalled();
    expect(scheduleShutdown).toHaveBeenCalled();
    expect(result.body).toMatchObject({ restarting: true, reason: 'version_sync' });
  });

  it('does not trigger restart when installed version matches running', async () => {
    (getInstalledVersion as AnyMock).mockReturnValue('1.0.0');
    const { handleUpgradeStatus } = createUpgradeHandlers(
      makeDeps({ globalPrefix: '/usr/local' }),
    );

    const result = await handleUpgradeStatus(makeReq());

    expect(spawnRestartScript).not.toHaveBeenCalled();
    expect((result.body as Record<string, unknown>).restarting).toBeUndefined();
  });

  it('skips restart check when globalPrefix is null', async () => {
    (getInstalledVersion as AnyMock).mockReturnValue('1.1.0');
    const { handleUpgradeStatus } = createUpgradeHandlers(makeDeps({ globalPrefix: null }));

    await handleUpgradeStatus(makeReq());

    // getInstalledVersion never called when globalPrefix is null
    expect(spawnRestartScript).not.toHaveBeenCalled();
    expect(getInstalledVersion).not.toHaveBeenCalled();
  });

  it('does not trigger restart when runtime.command pin is set', async () => {
    (getInstalledVersion as AnyMock).mockReturnValue('1.1.0');
    (resolveRuntimeCommand as AnyMock).mockReturnValue('/vault/runtime/node_modules/.bin/myco');
    const scheduleShutdown = vi.fn();
    const { handleUpgradeStatus } = createUpgradeHandlers(
      makeDeps({ scheduleShutdown, globalPrefix: '/usr/local' }),
    );

    const result = await handleUpgradeStatus(makeReq());

    expect(spawnRestartScript).not.toHaveBeenCalled();
    expect(scheduleShutdown).not.toHaveBeenCalled();
    expect((result.body as Record<string, unknown>).restarting).toBeUndefined();
  });

  it('passes the service label into spawnRestartScript when service-managed', async () => {
    (getInstalledVersion as AnyMock).mockReturnValue('1.1.0');
    (resolveRuntimeCommand as AnyMock).mockReturnValue(null);
    const mgr = installedServiceManager(`launchctl kickstart -k gui/501/${HOME_LABEL}`);
    const { handleUpgradeStatus } = createUpgradeHandlers(
      makeDeps({ globalPrefix: '/usr/local', serviceManager: mgr }),
    );

    await handleUpgradeStatus(makeReq());

    expect(spawnRestartScript).toHaveBeenCalledTimes(1);
    const call = (spawnRestartScript as AnyMock).mock.calls[0][0] as Record<string, unknown>;
    expect(call.serviceManagedLabel).toBe(HOME_LABEL);
  });

  it('passes runLocalUpdate:true when stamp does not match installed version', async () => {
    (getInstalledVersion as AnyMock).mockReturnValue('1.1.0');
    (resolveRuntimeCommand as AnyMock).mockReturnValue(null);

    // No stamp file → runLocalUpdate = true
    const { handleUpgradeStatus } = createUpgradeHandlers(
      makeDeps({ globalPrefix: '/usr/local', currentVersion: '1.0.0' }),
    );

    await handleUpgradeStatus(makeReq());

    expect(spawnRestartScript).toHaveBeenCalledTimes(1);
    const call = (spawnRestartScript as AnyMock).mock.calls[0][0] as Record<string, unknown>;
    expect(call.runLocalUpdate).toBe(true);
    expect(call.fromVersion).toBe('1.0.0');
    expect(call.toVersion).toBe('1.1.0');
  });
});

// ---------------------------------------------------------------------------
// handleUpgradeCheck
// ---------------------------------------------------------------------------

describe('handleUpgradeCheck', () => {
  beforeEach(() => {
    mock.clearAllMocks();
    (readProjectReleaseChannel as AnyMock).mockReturnValue('stable');
    (readUpdateConfig as AnyMock).mockReturnValue({ channel: 'stable', check_interval_hours: 6 });
    (resolveMycoPackageCheck as AnyMock).mockResolvedValue(MYCO_PKG_UPDATE);
    (checkOperatorCliVersions as AnyMock).mockResolvedValue([]);
    (getInstalledVersion as AnyMock).mockReturnValue(null);
    (resolveRuntimeCommand as AnyMock).mockReturnValue(null);
  });

  it('calls resolveMycoPackageCheck + checkOperatorCliVersions and returns union', async () => {
    const { handleUpgradeCheck } = createUpgradeHandlers(makeDeps());

    const result = await handleUpgradeCheck(makeReq());

    expect(resolveMycoPackageCheck).toHaveBeenCalledWith('1.0.0', 'stable', '1.0.0');
    expect(checkOperatorCliVersions).toHaveBeenCalled();
    expect(result.body).toMatchObject({ exempt: false, update_available: true });
  });

  it('union packages[] has myco first', async () => {
    const operatorPkg = {
      id: 'myco-team',
      display_name: 'Myco Team',
      package_name: '@goondocks/myco-team',
      installed: true,
      installed_version: '0.1.0',
      latest_version: '0.1.1',
      latest_stable: '0.1.1',
      latest_beta: null,
      update_available: true,
      revert_available: false,
    };
    (checkOperatorCliVersions as AnyMock).mockResolvedValue([operatorPkg]);

    const { handleUpgradeCheck } = createUpgradeHandlers(makeDeps());
    const result = await handleUpgradeCheck(makeReq());
    const body = result.body as Record<string, unknown>;
    const packages = body.packages as Array<{ id: string }>;

    expect(packages[0]?.id).toBe('myco');
    expect(packages[1]?.id).toBe('myco-team');
    expect(body.update_available).toBe(true);
  });

  it('propagates update_available:false when nothing to update', async () => {
    (resolveMycoPackageCheck as AnyMock).mockResolvedValue({
      ...MYCO_PKG_UPDATE,
      latest_version: '1.0.0',
      latest_stable: '1.0.0',
      update_available: false,
    });
    const { handleUpgradeCheck } = createUpgradeHandlers(makeDeps());

    const result = await handleUpgradeCheck(makeReq());

    expect((result.body as Record<string, unknown>).update_available).toBe(false);
  });

  it('partial failure: returns what succeeded with non-null error field', async () => {
    (resolveMycoPackageCheck as AnyMock).mockRejectedValue(new Error('GitHub 503'));
    (checkOperatorCliVersions as AnyMock).mockResolvedValue([]);

    const { handleUpgradeCheck } = createUpgradeHandlers(makeDeps());
    const result = await handleUpgradeCheck(makeReq());
    const body = result.body as Record<string, unknown>;

    expect(body.exempt).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error as string).toContain('GitHub 503');
    expect((body.packages as unknown[]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleUpgradeApply
// ---------------------------------------------------------------------------

describe('handleUpgradeApply', () => {
  beforeEach(() => {
    mock.clearAllMocks();
    (readProjectReleaseChannel as AnyMock).mockReturnValue('stable');
    (readCachedCheck as AnyMock).mockReturnValue(makeUpdateCache());
    (readUpdateConfig as AnyMock).mockReturnValue({ channel: 'stable', check_interval_hours: 6 });
    (getInstalledVersion as AnyMock).mockReturnValue('1.0.0');
    (resolveRuntimeCommand as AnyMock).mockReturnValue(null);
    (spawnUpdateScript as AnyMock).mockReturnValue('/tmp/myco-update-123.sh');
    (initiateAdopt as AnyMock).mockResolvedValue(undefined);
    (resolveNewestStagedVersion as AnyMock).mockReturnValue('1.1.0');
  });

  it('returns 400 when no cache exists (no status)', async () => {
    (readCachedCheck as AnyMock).mockReturnValue(null);
    const { handleUpgradeApply } = createUpgradeHandlers(makeDeps());

    const result = await handleUpgradeApply(makeReq());

    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>).error).toBe('no_update_available');
  });

  it('returns 422 when no staged version is found for myco', async () => {
    (resolveNewestStagedVersion as AnyMock).mockReturnValue(null);
    const { handleUpgradeApply } = createUpgradeHandlers(makeDeps());

    const result = await handleUpgradeApply(makeReq());

    expect(result.status).toBe(422);
    expect((result.body as Record<string, unknown>).error).toBe('no_staged_version');
  });

  it('myco update → calls initiateAdopt (not spawnUpdateScript) with staged version', async () => {
    const deps = makeDeps();
    const { handleUpgradeApply } = createUpgradeHandlers(deps);

    const result = await handleUpgradeApply(makeReq());

    expect(initiateAdopt).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'daemon',
        targetVersion: '1.1.0',
        prevVersion: '1.0.0',
        home: '/home/user/.myco',
        platform: 'darwin',
        daemonPort: 20915,
      }),
    );
    expect(spawnUpdateScript).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({ status: 'applying', version: '1.1.0' });
  });

  it('returns 409 when update sentinel is already in flight', async () => {
    const deps = makeDeps();
    // Write in-progress sentinel to simulate an ongoing update
    const sentinelPath = path.join(deps.daemonStateDir as string, 'update.in-progress');
    fs.writeFileSync(sentinelPath, JSON.stringify({
      targetVersion: '1.1.0',
      startedAt: Date.now(),
      initiator: 'api/update/apply',
    }));

    const { handleUpgradeApply } = createUpgradeHandlers(deps);
    const result = await handleUpgradeApply(makeReq());

    expect(result.status).toBe(409);
    expect((result.body as Record<string, unknown>).error).toBe('update_in_progress');
  });

  it('operator CLI update → spawnUpdateScript, myco → initiateAdopt', async () => {
    // Cache contains both myco and myco-team with updates available
    (readCachedCheck as AnyMock).mockReturnValue({
      checked_at: new Date().toISOString(),
      channel: 'stable',
      packages: {
        myco: { package_name: '@goondocks/myco', latest_stable: '1.1.0', latest_beta: null },
        'myco-team': { package_name: '@goondocks/myco-team', latest_stable: '0.1.1', latest_beta: null },
      },
    });
    // getInstalledVersion returns the old version for both packages
    (getInstalledVersion as AnyMock).mockImplementation((_globalPrefix: unknown, pkg: unknown) => {
      if (!pkg || pkg === '@goondocks/myco') return '1.0.0';
      if (pkg === '@goondocks/myco-team') return '0.1.0';
      return null;
    });

    const deps = makeDeps({ globalPrefix: '/usr/local' });
    const { handleUpgradeApply } = createUpgradeHandlers(deps);

    await handleUpgradeApply(makeReq());

    // Operator CLI → spawnUpdateScript
    expect(spawnUpdateScript).toHaveBeenCalledWith(
      expect.objectContaining({
        packageSpecs: ['@goondocks/myco-team@0.1.1'],
      }),
    );
    // Myco → initiateAdopt
    expect(initiateAdopt).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'daemon', targetVersion: '1.1.0' }),
    );
  });

  it('beta→stable revert: resolves+stages+adopts the LOWER stable version (not a 422)', async () => {
    // Running beta 1.1.0-beta.1; the stable target (1.0.0) is LOWER than the
    // running prerelease. The forward staged scan (resolveNewestStagedVersion)
    // can NEVER find a version below current, so the revert path must resolve
    // the stable refs DIRECTLY and stage them — mirroring the CLI. Returning a
    // null staged scan here proves the revert path does not depend on it.
    (readCachedCheck as AnyMock).mockReturnValue({
      checked_at: new Date().toISOString(),
      channel: 'stable',
      packages: {
        myco: { package_name: '@goondocks/myco', latest_stable: '1.0.0', latest_beta: null },
      },
    });
    (resolveNewestStagedVersion as AnyMock).mockReturnValue(null);
    (resolveRuntimeCommand as AnyMock).mockReturnValue(null);

    const stableRefs = {
      assetUrl: 'https://example/myco-darwin-arm64',
      sha256sumsUrl: 'https://example/SHA256SUMS',
      assetName: 'myco-darwin-arm64',
      targetVersion: '1.0.0',
    };
    const resolveRevertRefs = vi.fn(async () => stableRefs);
    const stageBinary = vi.fn(async () => ({ versionDir: '/home/user/.myco/bin/versions/1.0.0', version: '1.0.0' }));

    const deps = makeDeps({
      currentVersion: '1.1.0-beta.1',
      resolveRevertRefs,
      stageBinary,
    });
    const { handleUpgradeApply } = createUpgradeHandlers(deps);

    const result = await handleUpgradeApply(makeReq());

    expect(result.status).toBeUndefined();
    // Resolved the stable channel directly, then staged it (no pre-staged binary).
    expect(resolveRevertRefs).toHaveBeenCalledWith('stable');
    expect(stageBinary).toHaveBeenCalledWith(
      expect.objectContaining({ refs: stableRefs }),
      expect.anything(),
    );
    // The forward staged scan must NOT decide the revert target.
    expect(initiateAdopt).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'daemon',
        targetVersion: '1.0.0',
        prevVersion: '1.1.0-beta.1',
      }),
    );
    expect(result.body).toMatchObject({ status: 'applying', version: '1.0.0' });
  });

  it('beta→stable revert: skips staging when the stable version is already on disk', async () => {
    (readCachedCheck as AnyMock).mockReturnValue({
      checked_at: new Date().toISOString(),
      channel: 'stable',
      packages: {
        myco: { package_name: '@goondocks/myco', latest_stable: '1.0.0', latest_beta: null },
      },
    });
    (resolveNewestStagedVersion as AnyMock).mockReturnValue(null);
    (resolveRuntimeCommand as AnyMock).mockReturnValue(null);

    // Point the myco-home at a tmpdir and pre-create the versioned binary so the
    // already-staged guard short-circuits the stage step. The deps `home` IS the
    // resolved myco-home (`resolveMycoHome()`), so the managed layout is
    // `<mycoHome>/bin/versions/<v>/myco` on POSIX (see managed-paths.mjs).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-revert-home-'));
    const vBinDir = path.join(home, 'bin', 'versions', '1.0.0');
    fs.mkdirSync(vBinDir, { recursive: true });
    fs.writeFileSync(path.join(vBinDir, 'myco'), '#!/bin/sh\n');

    const stableRefs = {
      assetUrl: 'https://example/myco-darwin-arm64',
      sha256sumsUrl: 'https://example/SHA256SUMS',
      assetName: 'myco-darwin-arm64',
      targetVersion: '1.0.0',
    };
    const resolveRevertRefs = vi.fn(async () => stableRefs);
    const stageBinary = vi.fn(async () => ({ versionDir: vBinDir, version: '1.0.0' }));

    const deps = makeDeps({
      currentVersion: '1.1.0-beta.1',
      home,
      resolveRevertRefs,
      stageBinary,
    });
    const { handleUpgradeApply } = createUpgradeHandlers(deps);

    const result = await handleUpgradeApply(makeReq());

    expect(resolveRevertRefs).toHaveBeenCalledWith('stable');
    expect(stageBinary).not.toHaveBeenCalled();
    expect(initiateAdopt).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'daemon', targetVersion: '1.0.0' }),
    );
    expect(result.status).toBeUndefined();

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('passes service label to initiateAdopt when service-managed', async () => {
    const mgr = installedServiceManager(`launchctl kickstart -k gui/501/${HOME_LABEL}`);
    const { handleUpgradeApply } = createUpgradeHandlers(makeDeps({ serviceManager: mgr }));

    await handleUpgradeApply(makeReq());

    expect(initiateAdopt).toHaveBeenCalledWith(
      expect.objectContaining({ serviceManagedLabel: HOME_LABEL }),
    );
  });

  it('calls scheduleShutdown for operator-only update when not service-managed', async () => {
    // Only myco-team needs update, myco is up to date
    (readCachedCheck as AnyMock).mockReturnValue({
      checked_at: new Date().toISOString(),
      channel: 'stable',
      packages: {
        myco: { package_name: '@goondocks/myco', latest_stable: '1.0.0', latest_beta: null },
        'myco-team': { package_name: '@goondocks/myco-team', latest_stable: '0.1.1', latest_beta: null },
      },
    });
    (getInstalledVersion as AnyMock).mockImplementation((_globalPrefix: unknown, pkg: unknown) => {
      if (!pkg || pkg === '@goondocks/myco') return '1.0.0';
      if (pkg === '@goondocks/myco-team') return '0.1.0';
      return null;
    });

    const scheduleShutdown = vi.fn();
    const mgr = new FakeServiceManager();
    const deps = makeDeps({ scheduleShutdown, serviceManager: mgr, globalPrefix: '/usr/local' });
    const { handleUpgradeApply } = createUpgradeHandlers(deps);

    await handleUpgradeApply(makeReq());

    expect(spawnUpdateScript).toHaveBeenCalledWith(
      expect.objectContaining({ serviceManagedLabel: null }),
    );
    expect(scheduleShutdown).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleUpgradeChannel
// ---------------------------------------------------------------------------

describe('handleUpgradeChannel', () => {
  beforeEach(() => {
    mock.clearAllMocks();
    (readUpdateConfig as AnyMock).mockReturnValue({ channel: 'stable', check_interval_hours: 6 });
    (readProjectReleaseChannel as AnyMock).mockReturnValue('stable');
    (readCachedCheck as AnyMock).mockReturnValue(null);
    (resolveRuntimeCommand as AnyMock).mockReturnValue(null);
    (writeProjectReleaseChannel as AnyMock).mockImplementation(() => {});
    (clearCachedCheck as AnyMock).mockImplementation(() => {});
  });

  it('returns 400 for an invalid channel value', async () => {
    const { handleUpgradeChannel } = createUpgradeHandlers(makeDeps());

    const result = await handleUpgradeChannel(makeReq({ body: { channel: 'nightly' } }));

    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>).error).toBe('invalid_channel');
  });

  it('returns 400 when channel is missing from body', async () => {
    const { handleUpgradeChannel } = createUpgradeHandlers(makeDeps());

    const result = await handleUpgradeChannel(makeReq({ body: {} }));

    expect(result.status).toBe(400);
  });

  it('writes updated channel config and clears cache for valid channel', async () => {
    const { handleUpgradeChannel } = createUpgradeHandlers(makeDeps());

    const result = await handleUpgradeChannel(makeReq({ body: { channel: 'beta' } }));

    expect(writeProjectReleaseChannel).toHaveBeenCalledWith('/vault', 'beta');
    expect(clearCachedCheck).toHaveBeenCalled();
    expect(result.status).toBeUndefined();
  });

  it('returns default status when cache is empty after channel switch', async () => {
    (readCachedCheck as AnyMock).mockReturnValue(null);
    const { handleUpgradeChannel } = createUpgradeHandlers(makeDeps());

    const result = await handleUpgradeChannel(makeReq({ body: { channel: 'beta' } }));
    const body = result.body as Record<string, unknown>;

    expect(body.exempt).toBe(false);
    expect(body.update_available).toBe(false);
    expect(body.channel).toBe('beta');
    expect(body.channel_scope).toBe('machine');
    expect(body.runtime_scope).toBe('machine');
    expect(body.last_check).toBe('');
  });

  it('returns cached status with exempt:false after channel change', async () => {
    (readCachedCheck as AnyMock).mockReturnValue(makeNoUpdateCache());
    (getInstalledVersion as AnyMock).mockReturnValue('1.0.0');
    const { handleUpgradeChannel } = createUpgradeHandlers(makeDeps({ globalPrefix: '/usr/local' }));

    const result = await handleUpgradeChannel(makeReq({ body: { channel: 'stable' } }));

    expect((result.body as Record<string, unknown>).exempt).toBe(false);
    expect((result.body as Record<string, unknown>).update_available).toBe(false);
  });

  it('accepts both valid channels: stable and beta', async () => {
    const { handleUpgradeChannel } = createUpgradeHandlers(makeDeps());

    const stable = await handleUpgradeChannel(makeReq({ body: { channel: 'stable' } }));
    const beta = await handleUpgradeChannel(makeReq({ body: { channel: 'beta' } }));

    expect(stable.status).toBeUndefined();
    expect(beta.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// manual channel — automatic gate (T1)
// ---------------------------------------------------------------------------

describe('manual channel: automatic paths no-op, operator paths proceed', () => {
  beforeEach(() => {
    mock.clearAllMocks();
    (releaseChannelIsManual as AnyMock).mockReturnValue(true);
    (readCachedCheck as AnyMock).mockReturnValue(makeNoUpdateCache());
    (readUpdateConfig as AnyMock).mockReturnValue({ channel: 'stable', check_interval_hours: 6 });
    (readProjectReleaseChannel as AnyMock).mockReturnValue('stable');
    (isCacheStale as AnyMock).mockReturnValue(true); // would trigger background refresh if not gated
    (resolveRuntimeCommand as AnyMock).mockReturnValue(null);
    (getInstalledVersion as AnyMock).mockReturnValue('1.0.0');
    (resolveMycoPackageCheck as AnyMock).mockResolvedValue(MYCO_PKG_UPDATE);
    (checkOperatorCliVersions as AnyMock).mockResolvedValue([]);
    (resolveNewestStagedVersion as AnyMock).mockReturnValue('1.1.0');
    (spawnUpdateScript as AnyMock).mockReturnValue('/tmp/myco-update-123.sh');
    (initiateAdopt as AnyMock).mockResolvedValue(undefined);
  });

  it('status: skips background refresh and reports auto_eligible:false', async () => {
    const { handleUpgradeStatus } = createUpgradeHandlers(makeDeps());
    const result = await handleUpgradeStatus(makeReq());
    const body = result.body as Record<string, unknown>;

    // No background registry call made even though cache is stale.
    expect(resolveMycoPackageCheck).not.toHaveBeenCalled();
    expect(body.exempt).toBe(false);
    expect(body.auto_eligible).toBe(false);
  });

  it('status: auto_eligible:true on non-manual channel', async () => {
    (releaseChannelIsManual as AnyMock).mockReturnValue(false);
    (isCacheStale as AnyMock).mockReturnValue(false);
    const { handleUpgradeStatus } = createUpgradeHandlers(makeDeps());
    const result = await handleUpgradeStatus(makeReq());
    const body = result.body as Record<string, unknown>;

    expect(body.auto_eligible).toBe(true);
  });

  it('operator POST /api/upgrade/check proceeds under manual channel', async () => {
    const { handleUpgradeCheck } = createUpgradeHandlers(makeDeps());
    const result = await handleUpgradeCheck(makeReq());

    // Must reach the live check — not gated out.
    expect(resolveMycoPackageCheck).toHaveBeenCalled();
    expect(result.status).toBeUndefined(); // 200 OK
  });

  it('operator POST /api/upgrade/apply proceeds under manual channel', async () => {
    // Give the apply path a staged version and a cache with update available.
    (readCachedCheck as AnyMock).mockReturnValue(makeUpdateCache());
    const { handleUpgradeApply } = createUpgradeHandlers(makeDeps({ globalPrefix: '/usr/local' }));
    const result = await handleUpgradeApply(makeReq());

    // Must reach initiateAdopt — not gated out.
    expect(initiateAdopt).toHaveBeenCalled();
    expect(result.status).toBeUndefined(); // 200 OK
  });
});
