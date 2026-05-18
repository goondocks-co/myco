/**
 * Tests for the update API route handlers.
 *
 * Covers:
 * - handleUpdateStatus: exempt, fresh cache (no background check), stale cache (background check)
 * - handleUpdateCheck: forces registry fetch, 400 when exempt
 * - handleUpdateApply: spawns script + schedules shutdown, 400 when no update, 400 when exempt
 * - handleUpdateChannel: writes config + clears cache, 400 for invalid channel
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports
// ---------------------------------------------------------------------------

// Capture the real modules BEFORE replacing them, so afterAll can put them
// back. bun:test's mock.module() is process-scoped — without this restore,
// the stub modules below leak into every later test file that imports them
// in the same `bun test` invocation (the canonical npm test runner uses
// --isolate, which masks the leak; the restore stays correct regardless).
const realUpdateChecker = await import('@myco/daemon/update-checker.js');
const realUpdateInstaller = await import('@myco/daemon/update-installer.js');

mock.module('@myco/daemon/update-checker.js', () => ({
  isUpdateExempt: vi.fn(() => false),
  checkForUpdate: vi.fn(),
  statusFromCache: vi.fn(),
  readCachedCheck: vi.fn(() => null),
  readUpdateConfig: vi.fn(() => ({ channel: 'stable', check_interval_hours: 6 })),
  readProjectReleaseChannel: vi.fn(() => 'stable'),
  writeProjectReleaseChannel: vi.fn(),
  clearCachedCheck: vi.fn(),
  isCacheStale: vi.fn(() => false),
  getInstalledVersion: vi.fn(() => null),
  resolveMycoBinary: vi.fn(() => 'myco'),
  resolveRuntimeCommand: vi.fn(() => null),
  isManagedMachineRuntime: vi.fn(() => false),
}));

mock.module('@myco/daemon/update-installer.js', () => ({
  spawnUpdateScript: vi.fn(() => '/tmp/myco-update-123.sh'),
  spawnRestartScript: vi.fn(() => '/tmp/myco-restart-123.sh'),
}));

afterAll(() => {
  mock.module('@myco/daemon/update-checker.js', () => realUpdateChecker);
  mock.module('@myco/daemon/update-installer.js', () => realUpdateInstaller);
});

import {
  isUpdateExempt,
  checkForUpdate,
  statusFromCache,
  readCachedCheck,
  readUpdateConfig,
  readProjectReleaseChannel,
  writeProjectReleaseChannel,
  clearCachedCheck,
  isCacheStale,
  getInstalledVersion,
  resolveRuntimeCommand,
  isManagedMachineRuntime,
} from '@myco/daemon/update-checker.js';
import { spawnUpdateScript, spawnRestartScript } from '@myco/daemon/update-installer.js';
import { createUpdateHandlers } from '@myco/daemon/api/update.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import { FakeServiceManager } from '../../helpers/fake-service-manager';

// ---------------------------------------------------------------------------
// Pre-installed service helper. The /update routes look up
// restartShellCommand only when the service is already installed for this
// PID — wire a status snapshot + shell command in one call so each test
// reads as a single intent line.
// ---------------------------------------------------------------------------
function installedServiceManager(label: string, shellCmd: string): FakeServiceManager {
  const mgr = new FakeServiceManager();
  mgr.installed.add(label);
  mgr.statuses.set(label, { installed: true, running: true, pid: process.pid, lastExitCode: 0, unitPath: '/x' });
  mgr.restartShellCommands.set(label, shellCmd);
  return mgr;
}

import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub RouteRequest. */
function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    body: {},
    requestContext: TEST_REQUEST_CONTEXT,
    query: {},
    params: {},
    pathname: '/api/update/status',
    ...overrides,
  };
}

/** A representative CheckResult with update available. */
const UPDATE_AVAILABLE_STATUS = {
  update_available: true,
  running_version: '1.0.0',
  latest_version: '1.1.0',
  latest_stable: '1.1.0',
  latest_beta: null,
  channel: 'stable' as const,
  check_interval_hours: 6,
  last_check: '2026-03-28T00:00:00.000Z',
  error: null,
  packages: [
    {
      id: 'myco',
      display_name: 'Myco',
      package_name: '@goondocks/myco',
      installed: true,
      installed_version: '1.0.0',
      latest_version: '1.1.0',
      latest_stable: '1.1.0',
      latest_beta: null,
      update_available: true,
    },
  ],
};

/** A representative CheckResult with no update available. */
const NO_UPDATE_STATUS = {
  ...UPDATE_AVAILABLE_STATUS,
  update_available: false,
  latest_version: '1.0.0',
  latest_stable: '1.0.0',
  packages: [
    {
      ...UPDATE_AVAILABLE_STATUS.packages[0],
      latest_version: '1.0.0',
      latest_stable: '1.0.0',
      update_available: false,
    },
  ],
};

/** Default deps for tests. */
function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    vaultDir: '/vault',
    projectRoot: '/project',
    currentVersion: '1.0.0',
    daemonPort: 20915,
    scheduleShutdown: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleUpdateStatus
// ---------------------------------------------------------------------------

describe('handleUpdateStatus', () => {
  beforeEach(() => {
    vi.mocked(isUpdateExempt).mockReturnValue(false);
    vi.mocked(readCachedCheck).mockReturnValue(null);
    vi.mocked(readUpdateConfig).mockReturnValue({ channel: 'stable', check_interval_hours: 6 });
    vi.mocked(readProjectReleaseChannel).mockReturnValue('stable');
    vi.mocked(isCacheStale).mockReturnValue(false);
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);
    vi.mocked(checkForUpdate).mockResolvedValue(NO_UPDATE_STATUS);
  });

  it('returns exempt:true when in dev mode', async () => {
    vi.mocked(isUpdateExempt).mockReturnValue(true);
    const { handleUpdateStatus } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateStatus(makeReq());

    expect(result.status).toBeUndefined();
    expect(result.body).toEqual({ exempt: true, running_version: '1.0.0' });
  });

  it('returns status from cache when cache is fresh', async () => {
    const freshCache = {
      checked_at: new Date().toISOString(),
      current_version: '1.0.0',
      latest_stable: '1.0.0',
      latest_beta: null,
      channel: 'stable' as const,
    };
    vi.mocked(readCachedCheck).mockReturnValue(freshCache);
    vi.mocked(isCacheStale).mockReturnValue(false);
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);

    const { handleUpdateStatus } = createUpdateHandlers(makeDeps());
    const result = await handleUpdateStatus(makeReq());

    expect(result.body).toMatchObject({ exempt: false, update_available: false });
    // Should NOT trigger a background check
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('kicks off background check when cache is stale', async () => {
    vi.mocked(isCacheStale).mockReturnValue(true);
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);
    vi.mocked(checkForUpdate).mockResolvedValue(NO_UPDATE_STATUS);

    const { handleUpdateStatus } = createUpdateHandlers(makeDeps());
    const result = await handleUpdateStatus(makeReq());

    // Response returned immediately (does not await checkForUpdate)
    expect(result.body).toMatchObject({ exempt: false });
    // Background check was triggered
    expect(checkForUpdate).toHaveBeenCalledWith('1.0.0', undefined, null, 'stable');
  });

  it('returns exempt:false in body when not exempt', async () => {
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);
    const { handleUpdateStatus } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateStatus(makeReq());

    expect((result.body as Record<string, unknown>).exempt).toBe(false);
  });

  it('returns default status when cache is empty (null)', async () => {
    vi.mocked(statusFromCache).mockReturnValue(null);
    vi.mocked(isCacheStale).mockReturnValue(true);
    vi.mocked(checkForUpdate).mockResolvedValue(NO_UPDATE_STATUS);

    const { handleUpdateStatus } = createUpdateHandlers(makeDeps());
    const result = await handleUpdateStatus(makeReq());
    const body = result.body as Record<string, unknown>;

    expect(body.exempt).toBe(false);
    expect(body.update_available).toBe(false);
    expect(body.running_version).toBe('1.0.0');
    expect(body.channel).toBe('stable');
    expect(body.channel_scope).toBe('project');
    expect(body.runtime_scope).toBe('machine');
    expect(body.last_check).toBe('');
  });
});

// ---------------------------------------------------------------------------
// handleUpdateCheck
// ---------------------------------------------------------------------------

describe('handleUpdateCheck', () => {
  beforeEach(() => {
    vi.mocked(isUpdateExempt).mockReturnValue(false);
    vi.mocked(readProjectReleaseChannel).mockReturnValue('stable');
    vi.mocked(checkForUpdate).mockResolvedValue(UPDATE_AVAILABLE_STATUS);
  });

  it('returns 400 when exempt', async () => {
    vi.mocked(isUpdateExempt).mockReturnValue(true);
    const { handleUpdateCheck } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateCheck(makeReq());

    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>).error).toBe('update_exempt');
  });

  it('awaits checkForUpdate and returns result', async () => {
    const { handleUpdateCheck } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateCheck(makeReq());

    expect(checkForUpdate).toHaveBeenCalledWith('1.0.0', undefined, null, 'stable');
    expect(result.body).toMatchObject({ exempt: false, update_available: true });
  });

  it('propagates update_available:false when already up to date', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue(NO_UPDATE_STATUS);
    const { handleUpdateCheck } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateCheck(makeReq());

    expect((result.body as Record<string, unknown>).update_available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleUpdateApply
// ---------------------------------------------------------------------------

describe('handleUpdateApply', () => {
  beforeEach(() => {
    vi.mocked(isUpdateExempt).mockReturnValue(false);
    vi.mocked(readProjectReleaseChannel).mockReturnValue('stable');
    vi.mocked(statusFromCache).mockReturnValue(UPDATE_AVAILABLE_STATUS);
    vi.mocked(spawnUpdateScript).mockReset();
    vi.mocked(spawnUpdateScript).mockReturnValue('/tmp/myco-update-123.sh');
    vi.mocked(resolveRuntimeCommand).mockReturnValue(null);
    vi.mocked(isManagedMachineRuntime).mockReturnValue(false);
  });

  it('returns 400 when exempt', async () => {
    vi.mocked(isUpdateExempt).mockReturnValue(true);
    const { handleUpdateApply } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateApply(makeReq());

    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>).error).toBe('update_exempt');
  });

  it('returns 400 when no update is available', async () => {
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);
    const { handleUpdateApply } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateApply(makeReq());

    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>).error).toBe('no_update_available');
  });

  it('returns 400 when cache is empty (no status)', async () => {
    vi.mocked(statusFromCache).mockReturnValue(null);
    const { handleUpdateApply } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateApply(makeReq());

    expect(result.status).toBe(400);
  });

  it('spawns update script and schedules shutdown', async () => {
    const scheduleShutdown = vi.fn();
    const { handleUpdateApply } = createUpdateHandlers(makeDeps({ scheduleShutdown }));

    const result = await handleUpdateApply(makeReq());

    expect(spawnUpdateScript).toHaveBeenCalledWith({
      packageSpecs: ['@goondocks/myco@1.1.0'],
      localRuntimeSpec: undefined,
      removeLocalRuntime: false,
      projectRoot: '/project',
      vaultDir: '/vault',
      mycoBinary: 'myco',
      daemonPort: 20915,
      targetVersion: '1.1.0',
    });
    expect(scheduleShutdown).toHaveBeenCalled();
    expect(result.body).toMatchObject({ status: 'applying', version: '1.1.0' });
  });

  it('does not spawn script when update is unavailable', async () => {
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);
    const { handleUpdateApply } = createUpdateHandlers(makeDeps());

    await handleUpdateApply(makeReq());

    expect(spawnUpdateScript).not.toHaveBeenCalled();
  });

  it('includes optional installed packages when they have updates', async () => {
    vi.mocked(statusFromCache).mockReturnValue({
      ...UPDATE_AVAILABLE_STATUS,
      packages: [
        ...UPDATE_AVAILABLE_STATUS.packages,
        {
          id: 'myco-team',
          display_name: 'Myco Team',
          package_name: '@goondocks/myco-team',
          installed: true,
          installed_version: '0.1.0',
          latest_version: '0.1.1',
          latest_stable: '0.1.1',
          latest_beta: null,
          update_available: true,
        },
      ],
    });
    const { handleUpdateApply } = createUpdateHandlers(makeDeps());

    await handleUpdateApply(makeReq());

    expect(spawnUpdateScript).toHaveBeenCalledWith({
      packageSpecs: ['@goondocks/myco@1.1.0', '@goondocks/myco-team@0.1.1'],
      localRuntimeSpec: undefined,
      removeLocalRuntime: false,
      projectRoot: '/project',
      vaultDir: '/vault',
      mycoBinary: 'myco',
      daemonPort: 20915,
      targetVersion: '1.1.0',
    });
  });

  it('removes a managed local runtime when switching back to stable', async () => {
    vi.mocked(statusFromCache).mockReturnValue({
      ...UPDATE_AVAILABLE_STATUS,
      running_version: '1.1.0-beta.1',
      latest_version: '1.0.0',
      latest_stable: '1.0.0',
      update_available: false,
      revert_available: true,
      packages: [
        {
          ...UPDATE_AVAILABLE_STATUS.packages[0],
          installed_version: '1.1.0-beta.1',
          latest_version: '1.0.0',
          latest_stable: '1.0.0',
          update_available: false,
          revert_available: true,
        },
      ],
    });
    vi.mocked(resolveRuntimeCommand).mockReturnValue('/mock-home/.myco/runtime/node_modules/.bin/myco');
    vi.mocked(isManagedMachineRuntime).mockReturnValue(true);

    const { handleUpdateApply } = createUpdateHandlers(makeDeps());

    await handleUpdateApply(makeReq());

    expect(spawnUpdateScript).toHaveBeenCalledWith({
      packageSpecs: ['@goondocks/myco@1.0.0'],
      localRuntimeSpec: undefined,
      removeLocalRuntime: true,
      projectRoot: '/project',
      vaultDir: '/vault',
      mycoBinary: '/mock-home/.myco/runtime/node_modules/.bin/myco',
      daemonPort: 20915,
      targetVersion: '1.0.0',
    });
  });

  // -------------------------------------------------------------------------
  // Service-managed restart routing
  //
  // Mirrors the bug fix in commit 78a2c421 for /restart. When launchd /
  // systemd manages the daemon, the post-install script must NOT spawn
  // `myco daemon` itself — the service supervisor's KeepAlive would race
  // it for the canonical port. Instead, the script invokes the platform
  // restart primitive directly.
  // -------------------------------------------------------------------------
  it('passes a launchctl kickstart command when the daemon is service-managed (prod)', async () => {
    const mgr = installedServiceManager(
      'co.goondocks.myco',
      'launchctl kickstart -k gui/501/co.goondocks.myco',
    );
    const { handleUpdateApply } = createUpdateHandlers(makeDeps({ serviceManager: mgr }));

    await handleUpdateApply(makeReq());

    expect(spawnUpdateScript).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceRestartCommand: 'launchctl kickstart -k gui/501/co.goondocks.myco',
      }),
    );
  });

  it('passes a launchctl kickstart command for the dev service variant', async () => {
    const mgr = installedServiceManager(
      'co.goondocks.myco-dev',
      'launchctl kickstart -k gui/501/co.goondocks.myco-dev',
    );
    const { handleUpdateApply } = createUpdateHandlers(makeDeps({ serviceManager: mgr }));

    await handleUpdateApply(makeReq());

    expect(spawnUpdateScript).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceRestartCommand: 'launchctl kickstart -k gui/501/co.goondocks.myco-dev',
      }),
    );
  });

  it('omits the service-restart command when no service is installed (manual daemon)', async () => {
    const mgr = new FakeServiceManager();
    const { handleUpdateApply } = createUpdateHandlers(makeDeps({ serviceManager: mgr }));

    await handleUpdateApply(makeReq());

    const call = vi.mocked(spawnUpdateScript).mock.calls[0]?.[0];
    expect(call?.serviceRestartCommand).toBeUndefined();
  });

  it('omits the service-restart command when service is installed but a different PID is the daemon', async () => {
    // The supervisor manages SOME process, but not this one. Don't claim
    // service-managed semantics — fall back to the manual daemon spawn.
    const mgr = new FakeServiceManager();
    mgr.installed.add('co.goondocks.myco');
    mgr.statuses.set('co.goondocks.myco', { installed: true, running: true, pid: process.pid + 999, lastExitCode: 0, unitPath: '/x' });
    mgr.restartShellCommands.set('co.goondocks.myco', 'launchctl kickstart -k gui/501/co.goondocks.myco');
    const { handleUpdateApply } = createUpdateHandlers(makeDeps({ serviceManager: mgr }));

    await handleUpdateApply(makeReq());

    const call = vi.mocked(spawnUpdateScript).mock.calls[0]?.[0];
    expect(call?.serviceRestartCommand).toBeUndefined();
  });

  it('omits the service-restart command on unsupported platforms', async () => {
    const mgr = new FakeServiceManager({ supported: false });
    const { handleUpdateApply } = createUpdateHandlers(makeDeps({ serviceManager: mgr }));

    await handleUpdateApply(makeReq());

    const call = vi.mocked(spawnUpdateScript).mock.calls[0]?.[0];
    expect(call?.serviceRestartCommand).toBeUndefined();
  });

  it('installs a managed beta runtime even when the global install matches the target', async () => {
    // User is on stable, opts into beta. Global myco is already at the
    // version the beta channel resolves to — update_available is false but
    // we still need to create the managed runtime under ~/.myco/runtime/.
    vi.mocked(statusFromCache).mockReturnValue({
      ...UPDATE_AVAILABLE_STATUS,
      channel: 'beta',
      update_available: false,
      revert_available: false,
      running_version: '1.0.0',
      latest_version: '1.0.0',
      packages: [
        {
          ...UPDATE_AVAILABLE_STATUS.packages[0],
          installed_version: '1.0.0',
          latest_version: '1.0.0',
          update_available: false,
          revert_available: false,
        },
      ],
    });
    vi.mocked(resolveRuntimeCommand).mockReturnValue(null);
    vi.mocked(isManagedMachineRuntime).mockReturnValue(false);

    const { handleUpdateApply } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateApply(makeReq());

    expect(result.status).toBeUndefined();
    expect(spawnUpdateScript).toHaveBeenCalledWith({
      packageSpecs: [],
      localRuntimeSpec: '@goondocks/myco@1.0.0',
      removeLocalRuntime: false,
      projectRoot: '/project',
      vaultDir: '/vault',
      mycoBinary: 'myco',
      daemonPort: 20915,
      targetVersion: '1.0.0',
    });
  });
});

// ---------------------------------------------------------------------------
// handleUpdateChannel
// ---------------------------------------------------------------------------

describe('handleUpdateChannel', () => {
  beforeEach(() => {
    vi.mocked(isUpdateExempt).mockReturnValue(false);
    vi.mocked(readUpdateConfig).mockReturnValue({ channel: 'stable', check_interval_hours: 6 });
    vi.mocked(readProjectReleaseChannel).mockReturnValue('stable');
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);
    vi.mocked(resolveRuntimeCommand).mockReturnValue(null);
    vi.mocked(isManagedMachineRuntime).mockReturnValue(false);
    vi.mocked(writeProjectReleaseChannel).mockImplementation(() => {});
    vi.mocked(clearCachedCheck).mockImplementation(() => {});
  });

  it('returns 400 for an invalid channel', async () => {
    const { handleUpdateChannel } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateChannel(makeReq({ body: { channel: 'nightly' } }));

    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>).error).toBe('invalid_channel');
  });

  it('returns 400 when channel is missing', async () => {
    const { handleUpdateChannel } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateChannel(makeReq({ body: {} }));

    expect(result.status).toBe(400);
  });

  it('writes updated config and clears cache for valid channel', async () => {
    const { handleUpdateChannel } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateChannel(makeReq({ body: { channel: 'beta' } }));

    expect(writeProjectReleaseChannel).toHaveBeenCalledWith('/vault', 'beta');
    expect(clearCachedCheck).toHaveBeenCalled();
    expect(result.status).toBeUndefined();
  });

  it('returns status from cache with exempt:false after channel change', async () => {
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);
    const { handleUpdateChannel } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateChannel(makeReq({ body: { channel: 'stable' } }));

    expect(result.body).toMatchObject({ exempt: false });
  });

  it('returns default status when cache is empty after channel switch', async () => {
    vi.mocked(statusFromCache).mockReturnValue(null);
    const { handleUpdateChannel } = createUpdateHandlers(makeDeps());

    const result = await handleUpdateChannel(makeReq({ body: { channel: 'beta' } }));
    const body = result.body as Record<string, unknown>;

    expect(body.exempt).toBe(false);
    expect(body.update_available).toBe(false);
    expect(body.channel).toBe('beta');
    expect(body.channel_scope).toBe('project');
    expect(body.runtime_scope).toBe('machine');
    expect(body.last_check).toBe('');
  });

  it('accepts both valid channels: stable and beta', async () => {
    const { handleUpdateChannel } = createUpdateHandlers(makeDeps());

    const stable = await handleUpdateChannel(makeReq({ body: { channel: 'stable' } }));
    const beta = await handleUpdateChannel(makeReq({ body: { channel: 'beta' } }));

    expect(stable.status).toBeUndefined();
    expect(beta.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleUpdateStatus — restart_required detection
// ---------------------------------------------------------------------------

describe('handleUpdateStatus — restart_required', () => {
  beforeEach(() => {
    vi.mocked(isUpdateExempt).mockReturnValue(false);
    vi.mocked(readCachedCheck).mockReturnValue(null);
    vi.mocked(readUpdateConfig).mockReturnValue({ channel: 'stable', check_interval_hours: 6 });
    vi.mocked(readProjectReleaseChannel).mockReturnValue('stable');
    vi.mocked(isCacheStale).mockReturnValue(false);
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);
    vi.mocked(getInstalledVersion).mockReset();
    vi.mocked(getInstalledVersion).mockReturnValue(null);
    vi.mocked(spawnRestartScript).mockReset();
    vi.mocked(spawnRestartScript).mockReturnValue('/tmp/myco-restart-123.sh');
  });

  it('triggers auto-restart when installed version > running version', async () => {
    vi.mocked(getInstalledVersion).mockReturnValue('1.1.0');
    const scheduleShutdown = vi.fn();
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ scheduleShutdown, globalPrefix: '/usr/local' }),
    );

    const result = await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).toHaveBeenCalled();
    expect(scheduleShutdown).toHaveBeenCalled();
    expect(result.body).toMatchObject({ restarting: true, reason: 'version_sync' });
  });

  it('does not trigger restart when installed version matches running version', async () => {
    vi.mocked(getInstalledVersion).mockReturnValue('1.0.0');
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ globalPrefix: '/usr/local' }),
    );

    const result = await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).not.toHaveBeenCalled();
    expect((result.body as Record<string, unknown>).restarting).toBeUndefined();
  });

  it('falls back to normal flow when installed version is null', async () => {
    vi.mocked(getInstalledVersion).mockReturnValue(null);
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ globalPrefix: '/usr/local' }),
    );

    const result = await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({ exempt: false });
  });

  it('skips restart check when exempt (dev mode)', async () => {
    vi.mocked(isUpdateExempt).mockReturnValue(true);
    vi.mocked(getInstalledVersion).mockReturnValue('2.0.0');
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ globalPrefix: '/usr/local' }),
    );

    const result = await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({ exempt: true });
  });

  it('skips restart check when globalPrefix is null', async () => {
    vi.mocked(getInstalledVersion).mockReturnValue('1.1.0');
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ globalPrefix: null }),
    );

    const result = await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).not.toHaveBeenCalled();
    expect(getInstalledVersion).not.toHaveBeenCalled();
  });

  it('does not restart when installed version is lower than running (downgrade)', async () => {
    vi.mocked(getInstalledVersion).mockReturnValue('0.9.0');
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ globalPrefix: '/usr/local' }),
    );

    const result = await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).not.toHaveBeenCalled();
  });

  // Any runtime.command pin isolates the daemon from the global install.
  // The short-circuit must skip whenever a pin is set, regardless of where
  // the pin points. Two representative cases:
  //
  //   1. Pin under `.myco/runtime/` — beta-channel project-local install.
  //   2. Pin outside `.myco/runtime/` — dogfood `~/.local/bin/myco-dev`
  //      symlinked to a locally-built repo binary.
  //
  // Before this fix, only case 1 was gated (via the `runtimeScope`
  // label), leaving dogfood daemons in a restart loop whenever the
  // globally-installed version outran the pinned binary.
  it('does not trigger auto-restart when runtime.command pins a project-local beta runtime', async () => {
    vi.mocked(getInstalledVersion).mockReturnValue('1.1.0');
    vi.mocked(resolveRuntimeCommand).mockReturnValue(
      '/vault/runtime/node_modules/.bin/myco',
    );
    vi.mocked(isManagedMachineRuntime).mockReturnValue(true);
    const scheduleShutdown = vi.fn();
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ scheduleShutdown, globalPrefix: '/usr/local' }),
    );

    const result = await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).not.toHaveBeenCalled();
    expect(scheduleShutdown).not.toHaveBeenCalled();
    expect((result.body as Record<string, unknown>).restarting).toBeUndefined();
    expect(result.body).toMatchObject({ exempt: false });
  });

  it('passes a service-restart command into the auto-restart script when service-managed', async () => {
    // Auto-restart short-circuit (sibling-version-sync) must route through
    // launchd / systemd too — same thundering-herd avoidance as
    // handleUpdateApply. Without this, the sibling daemon spawn + KeepAlive
    // both fight for the port and the system enters the crash loop.
    vi.mocked(getInstalledVersion).mockReturnValue('1.1.0');
    // Reset runtime.command pin pollution from preceding tests in this block.
    vi.mocked(resolveRuntimeCommand).mockReturnValue(null);
    vi.mocked(isManagedMachineRuntime).mockReturnValue(false);
    const mgr = installedServiceManager(
      'co.goondocks.myco',
      'launchctl kickstart -k gui/501/co.goondocks.myco',
    );
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ globalPrefix: '/usr/local', serviceManager: mgr }),
    );

    await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnRestartScript).mock.calls[0][0]).toMatchObject({
      serviceRestartCommand: 'launchctl kickstart -k gui/501/co.goondocks.myco',
    });
  });

  it('does not trigger auto-restart when runtime.command pins a dogfood binary outside .myco/runtime/', async () => {
    vi.mocked(getInstalledVersion).mockReturnValue('1.1.0');
    // Dogfood layout: ~/.local/bin/myco-dev symlinked to the repo's built
    // vendor binary. `isManagedMachineRuntime` returns false (not under
    // `.myco/runtime/node_modules/`), but the daemon is still pinned —
    // restart would respawn the same binary and loop.
    vi.mocked(resolveRuntimeCommand).mockReturnValue('/Users/x/.local/bin/myco-dev');
    vi.mocked(isManagedMachineRuntime).mockReturnValue(false);
    const scheduleShutdown = vi.fn();
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ scheduleShutdown, globalPrefix: '/usr/local' }),
    );

    const result = await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).not.toHaveBeenCalled();
    expect(scheduleShutdown).not.toHaveBeenCalled();
    expect((result.body as Record<string, unknown>).restarting).toBeUndefined();
    expect(result.body).toMatchObject({ exempt: false });
  });
});

// ---------------------------------------------------------------------------
// handleUpdateStatus — runLocalUpdate gating against the stamp file
//
// The stamp file (`<vaultDir>/last-update-version`) records the version that
// last ran `myco update` for THIS project. The version_sync restart path must
// run `myco update --project` whenever the stamp does not already match the
// version we are upgrading TO (the on-disk installed version) — not the
// version we are leaving behind. The earlier predicate compared the stamp to
// `currentVersion` (the running daemon's version), which made sibling daemons
// silently skip the post-install sync of gitignore/symbiont/hook templates
// after another project's daemon installed the global update first.
// ---------------------------------------------------------------------------

describe('handleUpdateStatus — runLocalUpdate stamp gating', () => {
  let tmpVaultDir: string;

  beforeEach(() => {
    tmpVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-stamp-'));
    vi.mocked(isUpdateExempt).mockReturnValue(false);
    vi.mocked(readCachedCheck).mockReturnValue(null);
    vi.mocked(readUpdateConfig).mockReturnValue({ channel: 'stable', check_interval_hours: 6 });
    vi.mocked(readProjectReleaseChannel).mockReturnValue('stable');
    vi.mocked(isCacheStale).mockReturnValue(false);
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);
    vi.mocked(getInstalledVersion).mockReset();
    vi.mocked(resolveRuntimeCommand).mockReturnValue(null);
    vi.mocked(isManagedMachineRuntime).mockReturnValue(false);
    vi.mocked(spawnRestartScript).mockReset();
    vi.mocked(spawnRestartScript).mockReturnValue('/tmp/myco-restart-stamp.sh');
  });

  afterEach(() => {
    fs.rmSync(tmpVaultDir, { recursive: true, force: true });
  });

  function writeStamp(version: string): void {
    fs.writeFileSync(path.join(tmpVaultDir, 'last-update-version'), version, 'utf-8');
  }

  // Regression: pre-fix this returned runLocalUpdate=false because the stamp
  // matched the running version (`currentVersion`), so sibling daemons that
  // had previously synced their stamp to the now-outgoing version would skip
  // `myco update --project` on every subsequent global upgrade.
  it('runs myco update when the stamp matches the running version but not the installed version', async () => {
    writeStamp('1.0.0');
    vi.mocked(getInstalledVersion).mockReturnValue('1.1.0');
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ vaultDir: tmpVaultDir, currentVersion: '1.0.0', globalPrefix: '/usr/local' }),
    );

    await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnRestartScript).mock.calls[0][0]).toMatchObject({
      runLocalUpdate: true,
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
    });
  });

  it('skips myco update when the stamp already matches the installed (target) version', async () => {
    writeStamp('1.1.0');
    vi.mocked(getInstalledVersion).mockReturnValue('1.1.0');
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ vaultDir: tmpVaultDir, currentVersion: '1.0.0', globalPrefix: '/usr/local' }),
    );

    await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnRestartScript).mock.calls[0][0]).toMatchObject({
      runLocalUpdate: false,
    });
  });

  it('runs myco update when the stamp file is missing (fresh install)', async () => {
    vi.mocked(getInstalledVersion).mockReturnValue('1.1.0');
    const { handleUpdateStatus } = createUpdateHandlers(
      makeDeps({ vaultDir: tmpVaultDir, currentVersion: '1.0.0', globalPrefix: '/usr/local' }),
    );

    await handleUpdateStatus(makeReq());

    expect(spawnRestartScript).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnRestartScript).mock.calls[0][0]).toMatchObject({
      runLocalUpdate: true,
    });
  });
});
