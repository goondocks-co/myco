/**
 * Tests for the update API route handlers.
 *
 * Covers:
 * - handleUpdateStatus: exempt, fresh cache (no background check), stale cache (background check)
 * - handleUpdateCheck: forces registry fetch, 400 when exempt
 * - handleUpdateApply: spawns script + schedules shutdown, 400 when no update, 400 when exempt
 * - handleUpdateChannel: writes config + clears cache, 400 for invalid channel
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('../../../src/daemon/update-checker.js', () => ({
  isUpdateExempt: vi.fn(() => false),
  checkForUpdate: vi.fn(),
  statusFromCache: vi.fn(),
  readCachedCheck: vi.fn(() => null),
  readUpdateConfig: vi.fn(() => ({ channel: 'stable', check_interval_hours: 6 })),
  writeUpdateConfig: vi.fn(),
  clearCachedCheck: vi.fn(),
  isCacheStale: vi.fn(() => false),
}));

vi.mock('../../../src/daemon/update-installer.js', () => ({
  spawnUpdateScript: vi.fn(() => '/tmp/myco-update-123.sh'),
}));

import {
  isUpdateExempt,
  checkForUpdate,
  statusFromCache,
  readCachedCheck,
  readUpdateConfig,
  writeUpdateConfig,
  clearCachedCheck,
  isCacheStale,
} from '../../../src/daemon/update-checker.js';
import { spawnUpdateScript } from '../../../src/daemon/update-installer.js';
import { createUpdateHandlers } from '../../../src/daemon/api/update.js';
import type { RouteRequest } from '../../../src/daemon/router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub RouteRequest. */
function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    body: {},
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
};

/** A representative CheckResult with no update available. */
const NO_UPDATE_STATUS = {
  ...UPDATE_AVAILABLE_STATUS,
  update_available: false,
  latest_version: '1.0.0',
  latest_stable: '1.0.0',
};

/** Default deps for tests. */
function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    vaultDir: '/vault',
    projectRoot: '/project',
    currentVersion: '1.0.0',
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
    expect(checkForUpdate).toHaveBeenCalledWith('1.0.0');
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
    expect(body.last_check).toBe('');
  });
});

// ---------------------------------------------------------------------------
// handleUpdateCheck
// ---------------------------------------------------------------------------

describe('handleUpdateCheck', () => {
  beforeEach(() => {
    vi.mocked(isUpdateExempt).mockReturnValue(false);
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

    expect(checkForUpdate).toHaveBeenCalledWith('1.0.0');
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
    vi.mocked(statusFromCache).mockReturnValue(UPDATE_AVAILABLE_STATUS);
    vi.mocked(spawnUpdateScript).mockReset();
    vi.mocked(spawnUpdateScript).mockReturnValue('/tmp/myco-update-123.sh');
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
      targetVersion: '1.1.0',
      projectRoot: '/project',
      vaultDir: '/vault',
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
});

// ---------------------------------------------------------------------------
// handleUpdateChannel
// ---------------------------------------------------------------------------

describe('handleUpdateChannel', () => {
  beforeEach(() => {
    vi.mocked(isUpdateExempt).mockReturnValue(false);
    vi.mocked(readUpdateConfig).mockReturnValue({ channel: 'stable', check_interval_hours: 6 });
    vi.mocked(statusFromCache).mockReturnValue(NO_UPDATE_STATUS);
    vi.mocked(writeUpdateConfig).mockImplementation(() => {});
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

    expect(writeUpdateConfig).toHaveBeenCalledWith({ channel: 'beta', check_interval_hours: 6 });
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
