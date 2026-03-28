/**
 * Update API handlers — status, manual check, apply, and channel switch.
 *
 * Factory function injects vaultDir, projectRoot, currentVersion, and a
 * scheduleShutdown callback; returns handlers for:
 *   GET  /api/update/status
 *   POST /api/update/check
 *   POST /api/update/apply
 *   PUT  /api/update/channel
 */

import { z } from 'zod';

import {
  isUpdateExempt,
  checkForUpdate,
  statusFromCache,
  readCachedCheck,
  readUpdateConfig,
  writeUpdateConfig,
  clearCachedCheck,
  isCacheStale,
} from '../update-checker.js';
import { spawnUpdateScript } from '../update-installer.js';
import { RELEASE_CHANNELS } from '../../constants/update.js';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected by the daemon when registering update routes. */
export interface UpdateDeps {
  /** Absolute path to the active vault directory. */
  vaultDir: string;
  /** Absolute path to the project root (used by `myco update --project`). */
  projectRoot: string;
  /** The currently running version (from package.json at startup). */
  currentVersion: string;
  /** Callback that schedules a graceful daemon shutdown after the update script spawns. */
  scheduleShutdown: () => void;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const ChannelBodySchema = z.object({
  channel: z.enum(RELEASE_CHANNELS),
});

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create update API handlers with injected dependencies.
 *
 * Returns an object with named handlers for each update endpoint.
 */
export function createUpdateHandlers(deps: UpdateDeps) {
  const { vaultDir, projectRoot, currentVersion, scheduleShutdown } = deps;

  /**
   * GET /api/update/status — returns cached update state.
   *
   * When the cache is stale, kicks off a background registry check
   * (fire-and-forget) and immediately returns the current cached value.
   */
  async function handleUpdateStatus(_req: RouteRequest): Promise<RouteResponse> {
    if (isUpdateExempt()) {
      return { body: { exempt: true, running_version: currentVersion } };
    }

    const config = readUpdateConfig();
    const cache = readCachedCheck();

    if (isCacheStale(cache, config.check_interval_hours)) {
      // Fire-and-forget — don't block the response on the registry fetch.
      checkForUpdate(currentVersion).catch(() => {});
    }

    // Pass pre-read config and cache to avoid reading the files a second time.
    const status = statusFromCache(currentVersion, cache, config);
    if (!status) {
      // No cache yet — return minimal response; background check will populate it.
      return {
        body: {
          exempt: false,
          update_available: false,
          running_version: currentVersion,
          latest_version: currentVersion,
          latest_stable: currentVersion,
          latest_beta: null,
          channel: config.channel,
          check_interval_hours: config.check_interval_hours,
          last_check: '',
          error: null,
        },
      };
    }
    return { body: { exempt: false, ...status } };
  }

  /**
   * POST /api/update/check — forces an immediate registry check (blocking).
   *
   * Intended for user-initiated "Check Now" actions where the caller wants
   * fresh data before rendering.
   */
  async function handleUpdateCheck(_req: RouteRequest): Promise<RouteResponse> {
    if (isUpdateExempt()) {
      return {
        status: 400,
        body: { error: 'update_exempt', message: 'Updates disabled in dev mode' },
      };
    }

    const result = await checkForUpdate(currentVersion);
    return { body: { exempt: false, ...result } };
  }

  /**
   * POST /api/update/apply — spawns the update script and schedules shutdown.
   *
   * Returns 400 when no update is available or when in dev mode.
   */
  async function handleUpdateApply(_req: RouteRequest): Promise<RouteResponse> {
    if (isUpdateExempt()) {
      return { status: 400, body: { error: 'update_exempt' } };
    }

    const status = statusFromCache(currentVersion);
    if (!status || !status.update_available) {
      return { status: 400, body: { error: 'no_update_available' } };
    }

    spawnUpdateScript({ targetVersion: status.latest_version, projectRoot, vaultDir });
    scheduleShutdown();

    return { body: { status: 'applying', version: status.latest_version } };
  }

  /**
   * PUT /api/update/channel — switches the release channel and clears the cache.
   *
   * Returns 400 when the channel value is not in RELEASE_CHANNELS.
   */
  async function handleUpdateChannel(req: RouteRequest): Promise<RouteResponse> {
    const parsed = ChannelBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return { status: 400, body: { error: 'invalid_channel' } };
    }

    const { channel } = parsed.data;
    const config = readUpdateConfig();

    writeUpdateConfig({ ...config, channel });
    clearCachedCheck();

    const channelStatus = statusFromCache(currentVersion);
    if (!channelStatus) {
      return {
        body: {
          exempt: false,
          update_available: false,
          running_version: currentVersion,
          latest_version: currentVersion,
          latest_stable: currentVersion,
          latest_beta: null,
          channel,
          check_interval_hours: config.check_interval_hours,
          last_check: '',
          error: null,
        },
      };
    }
    return { body: { exempt: false, ...channelStatus } };
  }

  return {
    handleUpdateStatus,
    handleUpdateCheck,
    handleUpdateApply,
    handleUpdateChannel,
  };
}
