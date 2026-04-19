/**
 * Team connect/disconnect/status API handlers.
 *
 * Factory pattern: `createTeamHandlers(deps)` returns route handlers that
 * close over the daemon's shared state (vault dir, machine ID, team client).
 */

import { updateTeamConfig, loadMergedConfig } from '@myco/config/loader.js';
import { writeSecret, readSecrets } from '@myco/config/secrets.js';
import { countPending, countDeadLettered, backfillUnsynced, retryDeadLettered } from '@myco/db/queries/team-outbox.js';
import { readJsonConfig, resolveVaultConfigPath } from '@myco-deploy/index.js';
import { getTeamPackageVersion } from '@myco/cli/team.js';
import { TeamSyncClient } from '../team-sync.js';
import { SYNC_PROTOCOL_VERSION, TEAM_API_KEY_SECRET } from '@myco/constants.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { getPluginVersion } from '@myco/version.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { DaemonLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_CONFIG_DIR = 'team';
const TEAM_CONFIG_FILE = 'config.json';

interface TeamLocalConfig {
  package_version?: string;
}

function readCachedTeamPackageVersion(vaultDir: string): string | null {
  const config = readJsonConfig<TeamLocalConfig>(resolveVaultConfigPath(vaultDir, TEAM_CONFIG_DIR, TEAM_CONFIG_FILE));
  return config?.package_version?.trim() || null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamHandlerDeps {
  vaultDir: string;
  machineId: string;
  logger: DaemonLogger;
  getTeamClient: () => TeamSyncClient | null;
  setTeamClient: (client: TeamSyncClient | null) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTeamHandlers(deps: TeamHandlerDeps) {
  const { vaultDir, machineId, logger } = deps;

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

    const config = loadMergedConfig(vaultDir);
    return { body: { connected: true, team: config.team } };
  }

  /**
   * POST /api/team/disconnect
   *
   * Disables team sync and clears the live client reference.
   */
  async function handleDisconnect(_req: RouteRequest): Promise<RouteResponse> {
    updateTeamConfig(vaultDir, { enabled: false });

    return { body: { connected: false } };
  }

  /**
   * GET /api/team/status
   *
   * Returns connection status, health check result, pending sync count, and machine_id.
   */
  async function handleStatus(_req: RouteRequest): Promise<RouteResponse> {
    const config = loadMergedConfig(vaultDir);
    const client = deps.getTeamClient();
    const secrets = readSecrets(vaultDir);
    const hasApiKey = Boolean(secrets[TEAM_API_KEY_SECRET]);
    const localTeamPackageVersion = getTeamPackageVersion();
    const cachedTeamPackageVersion = readCachedTeamPackageVersion(vaultDir);
    let deployedWorkerVersion: string | null = null;

    let healthy = false;
    let healthError: string | undefined;

    if (client && config.team.enabled) {
      try {
        const health = await client.health();
        healthy = true;
        deployedWorkerVersion = health.package_version?.trim() || null;
      } catch (err) {
        healthError = (err as Error).message;
      }
    }

    let pendingCount = 0;
    let deadLetterCount = 0;
    try {
      pendingCount = countPending();
      deadLetterCount = countDeadLettered();
    } catch (err) {
      // DB may not have the table yet — log so we don't silently report
      // "0 pending" when the team-outbox queries are actually broken.
      const detail = errorMessage(err);
      logger.warn('team-sync.outbox.count-failed', 'team-outbox counts unavailable', { error: detail });
    }

    let collectiveStatus: Awaited<ReturnType<TeamSyncClient['getCollectiveStatus']>> | null = null;
    if (client && config.team.enabled) {
      try {
        collectiveStatus = await client.getCollectiveStatus();
      } catch (err) {
        const detail = errorMessage(err);
        logger.warn('team-sync.collective.status-failed', 'Collective status unavailable', { error: detail });
        collectiveStatus = null;
      }
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
        local_team_package_version: localTeamPackageVersion,
        cached_team_package_version: cachedTeamPackageVersion,
        deployed_worker_version: deployedWorkerVersion,
        worker_update_available:
          config.team.enabled &&
          Boolean(localTeamPackageVersion) &&
          Boolean(deployedWorkerVersion) &&
          deployedWorkerVersion !== localTeamPackageVersion,
        collective_connected: collectiveStatus?.connected ?? false,
        collective_url: collectiveStatus?.collective_url ?? null,
        collective_project_id: collectiveStatus?.project_id ?? null,
        collective_last_settings_sync: collectiveStatus?.last_settings_sync ?? null,
        collective_last_heartbeat: collectiveStatus?.last_heartbeat ?? null,
        collective_capabilities: collectiveStatus?.capabilities ?? [],
        collective_settings: collectiveStatus?.settings ?? {},
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
    logger.info('team-sync.upgrade.start', 'Starting worker upgrade');
    const result = upgradeWorker(vaultDir);
    if (!result.success) {
      logger.error('team-sync.upgrade.failed', 'Worker upgrade failed', { error: result.error });
      return { status: 500, body: { error: result.error } };
    }
    logger.info('team-sync.upgrade.complete', 'Worker upgrade complete', {
      worker_url: result.worker_url,
      version: result.version,
    });
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
      logger.info('team-sync.mcp-token.rotated', 'MCP access token rotated');
      return { body: { token } };
    } catch (err) {
      const message = errorMessage(err);
      logger.error('team-sync.mcp-token.rotate-failed', 'MCP token rotation failed', { error: message });
      return {
        status: 500,
        body: { error: message },
      };
    }
  }

  return { handleConnect, handleDisconnect, handleStatus, handleBackfill, handleRetryFailed, handleUpgradeWorker, handleRotateMcpToken };
}
