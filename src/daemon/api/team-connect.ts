/**
 * Team connect/disconnect/status API handlers.
 *
 * Factory pattern: `createTeamHandlers(deps)` returns route handlers that
 * close over the daemon's shared state (vault dir, machine ID, team client).
 */

import { updateTeamConfig, loadConfig } from '@myco/config/loader.js';
import { writeSecret, readSecrets } from '@myco/config/secrets.js';
import { countPending, countDeadLettered, backfillUnsynced, retryDeadLettered } from '@myco/db/queries/team-outbox.js';
import { TeamSyncClient } from '../team-sync.js';
import { SYNC_PROTOCOL_VERSION, TEAM_API_KEY_SECRET } from '@myco/constants.js';
import { getPluginVersion } from '@myco/version.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------


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
    let deadLetterCount = 0;
    try {
      pendingCount = countPending();
      deadLetterCount = countDeadLettered();
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
        dead_letter_count: deadLetterCount,
        machine_id: machineId,
        package_version: getPluginVersion(),
        deployed_worker_version: config.team.deployed_worker_version ?? null,
        worker_update_available: config.team.enabled
          ? config.team.deployed_worker_version !== getPluginVersion()
          : false,
        schema_version: SCHEMA_VERSION,
        sync_protocol_version: SYNC_PROTOCOL_VERSION,
        mcp_token: client?.getMcpToken() ?? null,
        mcp_endpoint: client?.getMcpEndpoint() ?? null,
      },
    };
  }

  /** POST /api/team/backfill — enqueue all unsynced rows to the outbox. */
  async function handleBackfill(_req: RouteRequest): Promise<RouteResponse> {
    const count = backfillUnsynced(machineId);
    return { body: { enqueued: count } };
  }

  /** POST /api/team/retry-failed — move dead-lettered outbox rows back to pending. */
  async function handleRetryFailed(_req: RouteRequest): Promise<RouteResponse> {
    const count = retryDeadLettered();
    return { body: { retried: count } };
  }

  /** POST /api/team/upgrade-worker — deploy latest worker and reinitialize client. */
  async function handleUpgradeWorker(_req: RouteRequest): Promise<RouteResponse> {
    const { upgradeWorker } = await import('@myco/cli/team.js');
    const result = upgradeWorker(vaultDir);
    if (!result.success) {
      return { status: 500, body: { error: result.error } };
    }
    // Reinitialize team client with potentially new URL
    if (result.worker_url && deps.getTeamClient()) {
      const secrets = readSecrets(vaultDir);
      const apiKey = secrets[TEAM_API_KEY_SECRET];
      if (apiKey) {
        deps.setTeamClient(new TeamSyncClient({
          workerUrl: result.worker_url,
          apiKey,
          machineId,
          syncProtocolVersion: SYNC_PROTOCOL_VERSION,
        }));
      }
    }
    return { body: result };
  }

  /** POST /api/team/rotate-mcp-token — rotate the MCP bearer token. */
  async function handleRotateMcpToken(_req: RouteRequest): Promise<RouteResponse> {
    const client = deps.getTeamClient();
    if (!client) {
      return {
        status: 400,
        body: { error: 'Team sync not connected' },
      };
    }
    try {
      const token = await client.rotateMcpToken();
      return { body: { token } };
    } catch (err) {
      return {
        status: 500,
        body: { error: String(err) },
      };
    }
  }

  return { handleConnect, handleDisconnect, handleStatus, handleBackfill, handleRetryFailed, handleUpgradeWorker, handleRotateMcpToken };
}
