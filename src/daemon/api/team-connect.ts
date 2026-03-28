/**
 * Team connect/disconnect/status API handlers.
 *
 * Factory pattern: `createTeamHandlers(deps)` returns route handlers that
 * close over the daemon's shared state (vault dir, machine ID, team client).
 */

import { updateTeamConfig, loadConfig } from '@myco/config/loader.js';
import { writeSecret, readSecrets } from '@myco/config/secrets.js';
import { countPending } from '@myco/db/queries/team-outbox.js';
import { TeamSyncClient } from '../team-sync.js';
import { SYNC_PROTOCOL_VERSION } from '@myco/constants.js';
import { getPluginVersion } from '@myco/version.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Secrets key for the team API key. */
const TEAM_API_KEY_SECRET = 'MYCO_TEAM_API_KEY';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamHandlerDeps {
  vaultDir: string;
  machineId: string;
  getTeamClient: () => TeamSyncClient | null;
  setTeamClient: (client: TeamSyncClient | null) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTeamHandlers(deps: TeamHandlerDeps) {
  const { vaultDir, machineId } = deps;

  /**
   * POST /api/team/connect
   * Body: { url: string, api_key: string }
   *
   * Creates a TeamSyncClient, tests the connection, saves config + secrets.
   */
  async function handleConnect(req: RouteRequest): Promise<RouteResponse> {
    const { url, api_key } = req.body as { url?: string; api_key?: string };

    if (!url || !api_key) {
      return {
        status: 400,
        body: { error: 'missing_fields', message: 'Both url and api_key are required' },
      };
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return {
        status: 400,
        body: { error: 'invalid_url', message: 'Invalid worker URL' },
      };
    }

    // Create client and test connection
    const client = new TeamSyncClient({
      workerUrl: url,
      apiKey: api_key,
      machineId,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    });

    try {
      await client.health();
    } catch (err) {
      return {
        status: 502,
        body: {
          error: 'connection_failed',
          message: `Could not connect to team worker: ${(err as Error).message}`,
        },
      };
    }

    // Save config and secret
    updateTeamConfig(vaultDir, {
      enabled: true,
      worker_url: url,
    });
    writeSecret(vaultDir, TEAM_API_KEY_SECRET, api_key);

    // Set the live client
    deps.setTeamClient(client);

    const config = loadConfig(vaultDir);
    return { body: { connected: true, team: config.team } };
  }

  /**
   * POST /api/team/disconnect
   *
   * Disables team sync and clears the live client reference.
   */
  async function handleDisconnect(_req: RouteRequest): Promise<RouteResponse> {
    updateTeamConfig(vaultDir, { enabled: false });
    deps.setTeamClient(null);

    return { body: { connected: false } };
  }

  /**
   * GET /api/team/status
   *
   * Returns connection status, health check result, pending sync count, and machine_id.
   */
  async function handleStatus(_req: RouteRequest): Promise<RouteResponse> {
    const config = loadConfig(vaultDir);
    const client = deps.getTeamClient();
    const secrets = readSecrets(vaultDir);
    const hasApiKey = Boolean(secrets[TEAM_API_KEY_SECRET]);

    let healthy = false;
    let healthError: string | undefined;

    if (client && config.team.enabled) {
      try {
        await client.health();
        healthy = true;
      } catch (err) {
        healthError = (err as Error).message;
      }
    }

    let pendingCount = 0;
    try {
      pendingCount = countPending();
    } catch {
      // DB may not have the table yet
    }

    return {
      body: {
        enabled: config.team.enabled,
        worker_url: config.team.worker_url ?? null,
        has_api_key: hasApiKey,
        api_key: secrets[TEAM_API_KEY_SECRET] ?? null,
        healthy,
        health_error: healthError,
        pending_sync_count: pendingCount,
        machine_id: machineId,
        package_version: getPluginVersion(),
        schema_version: SCHEMA_VERSION,
        sync_protocol_version: SYNC_PROTOCOL_VERSION,
      },
    };
  }

  return { handleConnect, handleDisconnect, handleStatus };
}
