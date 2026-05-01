/**
 * Team connect/disconnect/status API handlers.
 *
 * Factory pattern: `createTeamHandlers(deps)` returns route handlers that
 * close over the daemon's shared state (vault dir, machine ID, team client).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateTeamConfig, loadMergedConfig } from '@myco/config/loader.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { writeSecret, readSecrets } from '@myco/config/secrets.js';
import {
  countPending,
  backfillUnsynced,
  LOCAL_ONLY_OUTBOX_TABLES,
  LOCAL_ONLY_SYNC_COLUMNS,
  LOCAL_ONLY_RATIONALES,
} from '@myco/db/queries/team-outbox.js';
import { readJsonConfig, resolveVaultConfigPath } from '@myco-deploy/index.js';
import { getInstalledVersion } from '../update-checker.js';
import { TEAM_PACKAGE_NAME } from '@myco/constants/update.js';
import { TeamSyncClient } from '../team-sync.js';
import { SYNC_PROTOCOL_VERSION, TEAM_API_KEY_SECRET } from '@myco/constants.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { getPluginVersion } from '@myco/version.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { DaemonLogger } from '../logger.js';

const execFileAsync = promisify(execFile);

/** Upper bound for the subprocess — wrangler deploys can take 30-60s on cold cache. */
const UPGRADE_SUBPROCESS_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum stdout+stderr the subprocess can produce before we truncate. */
const UPGRADE_SUBPROCESS_MAX_BUFFER = 4 * 1024 * 1024;

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
  /**
   * npm global prefix — used to locate the installed `@goondocks/myco-team`
   * package for the Worker upgrade subprocess and for reporting the local
   * team package version in `handleStatus`. Null when npm prefix resolution
   * failed; Worker upgrades return a typed error in that case.
   */
  globalPrefix: string | null;
}

/**
 * Absolute path to the installed `@goondocks/myco-team` CLI entry, or null
 * if the package isn't present under the npm global prefix.
 */
function resolveMycoTeamEntry(globalPrefix: string | null): string | null {
  if (!globalPrefix) return null;
  const entry = path.join(
    globalPrefix, 'lib', 'node_modules',
    '@goondocks', 'myco-team', 'dist', 'main.js',
  );
  return fs.existsSync(entry) ? entry : null;
}

/**
 * Resolve a node binary that can execute myco-team's `main.js`.
 *
 * `process.execPath` is not usable here: when the daemon is the Bun-
 * compiled single-file binary, execPath points at that binary, which
 * treats its first argv as a myco subcommand rather than a JS file to
 * run. We need an actual Node (or Bun) runtime.
 *
 * Priority:
 *   1. `<globalPrefix>/bin/node` — the node that installed myco-team;
 *      always present when the package is (Homebrew, nvm per-version).
 *   2. Common macOS/Linux locations — catches GUI-launched daemons
 *      under launchd's minimal PATH, which typically have /opt/homebrew
 *      or /usr/local/bin even when shell dotfiles haven't loaded.
 *   3. Bare `node` — relies on PATH, last resort.
 */
function resolveNodeBinary(globalPrefix: string | null): string {
  if (globalPrefix) {
    const colocatedNode = path.join(globalPrefix, 'bin', 'node');
    if (fs.existsSync(colocatedNode)) return colocatedNode;
  }
  for (const candidate of [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'node';
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
    const localTeamPackageVersion = deps.globalPrefix
      ? getInstalledVersion(deps.globalPrefix, TEAM_PACKAGE_NAME)
      : null;
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
    try {
      pendingCount = countPending();
    } catch (err) {
      // DB may not have the table yet — log so we don't silently report
      // "0 pending" when the team-outbox queries are actually broken.
      const detail = errorMessage(err);
      logger.warn('team-sync.outbox.count-failed', 'team-outbox count unavailable', { error: detail });
    }

    let collectiveStatus: Awaited<ReturnType<TeamSyncClient['getCollectiveStatus']>> | null = null;
    let teamConfig: Awaited<ReturnType<TeamSyncClient['getConfig']>> | null = null;
    if (client && config.team.enabled) {
      try {
        collectiveStatus = await client.getCollectiveStatus();
      } catch (err) {
        const detail = errorMessage(err);
        logger.warn('team-sync.collective.status-failed', 'Collective status unavailable', { error: detail });
        collectiveStatus = null;
      }

      try {
        teamConfig = await client.getConfig();
      } catch (err) {
        const detail = errorMessage(err);
        logger.warn('team-sync.config.status-failed', 'Team config unavailable', { error: detail });
        teamConfig = null;
      }
    }

    const remoteConfig = (teamConfig?.config ?? {}) as Record<string, unknown>;
    const vectorReindexLastRun = typeof remoteConfig.vector_reindex_last_run_at === 'string'
      ? Number(remoteConfig.vector_reindex_last_run_at)
      : null;
    const vectorReindexLastProcessed = typeof remoteConfig.vector_reindex_last_processed === 'string'
      ? Number(remoteConfig.vector_reindex_last_processed)
      : null;
    const vectorReindexLastReindexed = typeof remoteConfig.vector_reindex_last_reindexed === 'string'
      ? Number(remoteConfig.vector_reindex_last_reindexed)
      : null;
    const vectorReindexLastDeleted = typeof remoteConfig.vector_reindex_last_deleted === 'string'
      ? Number(remoteConfig.vector_reindex_last_deleted)
      : null;

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
        vector_reindex_status: typeof remoteConfig.vector_reindex_status === 'string' ? remoteConfig.vector_reindex_status : null,
        vector_reindex_last_table: typeof remoteConfig.vector_reindex_last_table === 'string' ? remoteConfig.vector_reindex_last_table : null,
        vector_reindex_last_error: typeof remoteConfig.vector_reindex_last_error === 'string' && remoteConfig.vector_reindex_last_error.length > 0 ? remoteConfig.vector_reindex_last_error : null,
        vector_reindex_last_run_at: Number.isFinite(vectorReindexLastRun) ? vectorReindexLastRun : null,
        vector_reindex_last_processed: Number.isFinite(vectorReindexLastProcessed) ? vectorReindexLastProcessed : null,
        vector_reindex_last_reindexed: Number.isFinite(vectorReindexLastReindexed) ? vectorReindexLastReindexed : null,
        vector_reindex_last_deleted: Number.isFinite(vectorReindexLastDeleted) ? vectorReindexLastDeleted : null,
        schema_version: SCHEMA_VERSION,
        sync_protocol_version: SYNC_PROTOCOL_VERSION,
        mcp_token: client?.getMcpToken() ?? null,
        mcp_endpoint: client?.getMcpEndpoint() ?? null,
        local_only_disclosures: buildLocalOnlyDisclosures(),
      },
    };
  }

  /**
   * Snapshot the local-only sync policy for the UI's "What stays local"
   * disclosure on the Synced data tab. Derived from the canonical
   * LOCAL_ONLY_OUTBOX_TABLES + LOCAL_ONLY_SYNC_COLUMNS + LOCAL_ONLY_RATIONALES
   * exports so the UI can never drift from the enforcement.
   */
  function buildLocalOnlyDisclosures(): Array<{ table: string; columns: string[]; rationale: string }> {
    const disclosures: Array<{ table: string; columns: string[]; rationale: string }> = [];
    for (const table of LOCAL_ONLY_OUTBOX_TABLES) {
      disclosures.push({
        table,
        columns: ['(entire table)'],
        rationale: LOCAL_ONLY_RATIONALES[table] ?? 'Local-only by policy.',
      });
    }
    for (const [table, columns] of Object.entries(LOCAL_ONLY_SYNC_COLUMNS)) {
      disclosures.push({
        table,
        columns: [...columns],
        rationale: LOCAL_ONLY_RATIONALES[table] ?? 'Local-only columns by policy.',
      });
    }
    return disclosures;
  }

  /** POST /api/team/backfill — enqueue all unsynced rows to the outbox. */
  async function handleBackfill(_req: RouteRequest): Promise<RouteResponse> {
    const count = backfillUnsynced(machineId);
    return { body: { enqueued: count } };
  }

  function clientOrError(): { ok: true; client: TeamSyncClient } | { ok: false; response: RouteResponse } {
    const client = deps.getTeamClient();
    if (!client) return { ok: false, response: { status: 503, body: { error: 'team_not_configured' } } };
    return { ok: true, client };
  }

  /** GET /api/team/queue-stats — proxies CF queue depth + DLQ depth from the worker. */
  async function handleQueueStats(_req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError();
    if (!guard.ok) return guard.response;
    const stats = await guard.client.getQueueStats();
    return { body: stats };
  }

  /** GET /api/team/dlq — list a page of DLQ messages from the worker. */
  async function handleDlqList(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError();
    if (!guard.ok) return guard.response;
    const limit = Number(req.query.limit ?? '50') || 50;
    const result = await guard.client.listDlq(limit);
    return { body: result };
  }

  /** POST /api/team/dlq/retry — re-publish DLQ messages back to the main queue. */
  async function handleDlqRetry(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError();
    if (!guard.ok) return guard.response;
    const body = (req.body ?? {}) as { lease_ids?: unknown };
    const leaseIds = Array.isArray(body.lease_ids) ? body.lease_ids.filter((id): id is string => typeof id === 'string') : [];
    if (leaseIds.length === 0) return { status: 400, body: { error: 'lease_ids array is required' } };
    const result = await guard.client.retryDlq(leaseIds);
    return { body: result };
  }

  /** POST /api/team/dlq/discard — permanently drop DLQ messages. */
  async function handleDlqDiscard(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError();
    if (!guard.ok) return guard.response;
    const body = (req.body ?? {}) as { lease_ids?: unknown };
    const leaseIds = Array.isArray(body.lease_ids) ? body.lease_ids.filter((id): id is string => typeof id === 'string') : [];
    if (leaseIds.length === 0) return { status: 400, body: { error: 'lease_ids array is required' } };
    const result = await guard.client.discardDlq(leaseIds);
    return { body: result };
  }

  /** POST /api/team/cf-api-token — stash a CF API token + account id on the worker. */
  async function handleSetCfApiToken(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError();
    if (!guard.ok) return guard.response;
    const body = (req.body ?? {}) as { token?: string; account_id?: string };
    if (!body.token || !body.account_id) {
      return { status: 400, body: { error: 'token and account_id are required' } };
    }
    const result = await guard.client.setCfApiToken(body.token, body.account_id);
    return { body: result };
  }

  /** DELETE /api/team/cf-api-token — clear the worker's CF API token. */
  async function handleClearCfApiToken(_req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError();
    if (!guard.ok) return guard.response;
    const result = await guard.client.clearCfApiToken();
    return { body: result };
  }

  /**
   * POST /api/team/upgrade-worker — spawn `myco-team upgrade --json` and
   * reinitialize the team client against the post-upgrade config.
   *
   * Requires `@goondocks/myco-team` to be globally installed. Returns a
   * typed `myco_team_not_installed` error when it isn't so the UI can
   * surface an install prompt instead of a generic 500.
   */
  async function handleUpgradeWorker(_req: RouteRequest): Promise<RouteResponse> {
    const teamEntry = resolveMycoTeamEntry(deps.globalPrefix);
    if (!teamEntry) {
      return {
        status: 400,
        body: {
          error: 'myco_team_not_installed',
          message: 'The @goondocks/myco-team package is required for Worker upgrades. Install it with `npm install -g @goondocks/myco-team` and try again.',
        },
      };
    }

    const nodeBinary = resolveNodeBinary(deps.globalPrefix);
    // myco-team's `upgrade` subcommand takes a project root and re-resolves
    // the vault from there — passing vaultDir directly would double-append
    // `.myco` in non-git-repo projects (resolveVaultDir's fallback path).
    const projectRoot = resolveProjectRoot(vaultDir);
    logger.info('team-sync.upgrade.start', 'Starting worker upgrade subprocess', {
      entry: teamEntry,
      node: nodeBinary,
      project_root: projectRoot,
    });

    let stdout = '';
    let stderr = '';
    let subprocessFailed = false;
    try {
      const result = await execFileAsync(
        nodeBinary,
        [teamEntry, 'upgrade', projectRoot, '--json'],
        {
          encoding: 'utf-8',
          timeout: UPGRADE_SUBPROCESS_TIMEOUT_MS,
          maxBuffer: UPGRADE_SUBPROCESS_MAX_BUFFER,
          // Subprocess exits 1 on upgrade failure but still emits a valid
          // JSON result on stdout — we parse that below instead of treating
          // the exit code as a fatal error.
        },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      // execFile throws on non-zero exit, but also populates stdout/stderr.
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
      subprocessFailed = true;
      // Timeout / signal / missing binary — no JSON payload to parse.
      if (!stdout.trim()) {
        logger.error('team-sync.upgrade.failed', 'Worker upgrade subprocess failed with no output', {
          error: e.message,
          code: e.code,
          stderr: stderr.slice(-2048),
        });
        return {
          status: 500,
          body: { error: 'upgrade_subprocess_failed', message: e.message, stderr },
        };
      }
    }

    type UpgradeResult = { success: boolean; worker_url?: string; version?: string; error?: string };
    let result: UpgradeResult;
    try {
      result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as UpgradeResult;
    } catch (err) {
      logger.error('team-sync.upgrade.failed', 'Could not parse upgrade subprocess output', {
        error: (err as Error).message,
        stdout: stdout.slice(-2048),
        stderr: stderr.slice(-2048),
      });
      return {
        status: 500,
        body: { error: 'upgrade_output_invalid', message: 'myco-team upgrade did not return a valid JSON result', stdout, stderr },
      };
    }

    if (!result.success) {
      logger.error('team-sync.upgrade.failed', 'Worker upgrade failed', {
        error: result.error,
        stderr: stderr.slice(-2048),
      });
      return { status: 500, body: { ...result, stderr } };
    }

    if (subprocessFailed) {
      // Defensive: subprocess exited non-zero but claimed success. Treat as failure.
      logger.error('team-sync.upgrade.failed', 'Subprocess exited non-zero despite success=true', { stderr: stderr.slice(-2048) });
      return { status: 500, body: { error: 'upgrade_inconsistent_result', stderr } };
    }

    logger.info('team-sync.upgrade.complete', 'Worker upgrade complete', {
      worker_url: result.worker_url,
      version: result.version,
    });

    // Re-read myco.yaml (the subprocess updated team.worker_url) and
    // reinitialize the client from the fresh merged config rather than
    // the subprocess's result shape.
    const freshConfig = loadMergedConfig(vaultDir);
    const secrets = readSecrets(vaultDir);
    const apiKey = secrets[TEAM_API_KEY_SECRET];
    if (freshConfig.team.enabled && freshConfig.team.worker_url && apiKey && deps.getTeamClient()) {
      deps.setTeamClient(new TeamSyncClient({
        workerUrl: freshConfig.team.worker_url,
        apiKey,
        machineId,
        syncProtocolVersion: SYNC_PROTOCOL_VERSION,
      }));
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

  return {
    handleConnect, handleDisconnect, handleStatus, handleBackfill, handleUpgradeWorker, handleRotateMcpToken,
    handleQueueStats, handleDlqList, handleDlqRetry, handleDlqDiscard, handleSetCfApiToken, handleClearCfApiToken,
  };
}
