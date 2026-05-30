/**
 * Team connect/disconnect/status API handlers.
 *
 * Factory pattern: `createTeamHandlers(deps)` returns route handlers that
 * close over the daemon's shared state (vault dir, machine ID, team client).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadMergedConfig } from '@myco/config/loader.js';
import { loadProjectManifest } from '@myco/config/project-manifest.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import {
  loadTeamConnectionConfig,
  readTeamConnectionSecrets,
  resolveTeamConnectionStore,
  updateTeamConnectionConfig,
  writeTeamConnectionSecret,
} from '@myco/grove/team-connection.js';
import {
  countPending,
  countPendingByTable,
  purgePendingOutbox,
  countTeamSyncRows,
  backfillAll,
  backfillUnsynced,
  LOCAL_ONLY_OUTBOX_TABLES,
  LOCAL_ONLY_SYNC_COLUMNS,
  LOCAL_ONLY_RATIONALES,
} from '@myco/db/queries/team-outbox.js';
import { searchLogs, type LogEntryRow } from '@myco/db/queries/logs.js';
import { readJsonConfig, resolveVaultConfigPath } from '@myco-deploy/index.js';
import { getInstalledVersion } from '../update-checker.js';
import { TEAM_PACKAGE_NAME } from '@myco/constants/update.js';
import { TeamSyncClient, type DlqListResponse, type QueueStatsResponse, type TeamRemoteSyncSummaryResponse } from '../team-sync.js';
import { MIN_COMPAT_CLIENT_VERSION, SYNC_PROTOCOL_VERSION, TEAM_API_KEY_SECRET } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { getPluginVersion } from '@myco/version.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
import { loadGroveRecord } from '@myco/grove/registry.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { DaemonLogger } from '../logger.js';
import { isGroveScoped, type MycoRequestContext } from '@myco/tools/request-context.js';

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
const HANDOFF_BURST_GAP_MS = 10_000;
const HANDOFF_LOG_PAGE_SIZE = 500;

interface TeamLocalConfig {
  package_version?: string;
  worker_name?: string;
  worker_url?: string;
}

interface TeamConnectionContext {
  connection_scope: 'grove' | 'legacy-project';
  grove: {
    id: string;
    name: string;
    slug: string;
    mode: string;
  } | null;
  /**
   * Null when neither the request context nor the vault's `project.toml`
   * supplies a project identity. Pre-Grove status pings hit this state
   * legitimately. Connect/backfill paths must reject null explicitly
   * rather than the previous behavior of silently using the project root
   * filesystem path as a `proj_*` brand.
   */
  project: {
    id: string;
    name: string;
    root: string;
  } | null;
}

interface TeamHandoffSummary {
  completed_at: string;
  started_at: string | null;
  duration_ms: number | null;
  enqueued: number | null;
  accepted: number;
  rejected: number;
  batches: number;
  error: string | null;
  mode: string | null;
  source: 'handoff_log' | 'flush_logs';
}

type LocalTeamPackageSource = 'installed' | 'dev-linked' | 'path';

interface LocalTeamPackageVersion {
  version: string;
  source: LocalTeamPackageSource;
}

function readCachedTeamPackageVersion(vaultDir: string): string | null {
  const config = readJsonConfig<TeamLocalConfig>(resolveVaultConfigPath(vaultDir, TEAM_CONFIG_DIR, TEAM_CONFIG_FILE));
  return config?.package_version?.trim() || null;
}

function numberFromLogData(data: Record<string, unknown>, key: string): number | null {
  const value = Number(data[key]);
  return Number.isFinite(value) ? value : null;
}

function parseLogData(row: LogEntryRow): Record<string, unknown> {
  if (!row.data) return {};
  try {
    const parsed = JSON.parse(row.data) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function explicitHandoffSummary(row: LogEntryRow): TeamHandoffSummary {
  const data = parseLogData(row);
  const durationMs = numberFromLogData(data, 'duration_ms');
  const completedAt = row.timestamp;
  const completedMs = Date.parse(completedAt);
  const startedAt = durationMs !== null && Number.isFinite(completedMs)
    ? new Date(completedMs - durationMs).toISOString()
    : null;

  return {
    completed_at: completedAt,
    started_at: startedAt,
    duration_ms: durationMs,
    enqueued: numberFromLogData(data, 'enqueued'),
    accepted: numberFromLogData(data, 'flushed') ?? 0,
    rejected: numberFromLogData(data, 'rejected') ?? 0,
    batches: numberFromLogData(data, 'batches') ?? 0,
    error: typeof data.error === 'string' && data.error.length > 0 ? data.error : null,
    mode: typeof data.mode === 'string' ? data.mode : null,
    source: 'handoff_log',
  };
}

function latestFlushBurstSummary(): TeamHandoffSummary | null {
  const entries = searchLogs({
    kind: LOG_KINDS.TEAM_SYNC_COMPLETE,
    page_size: HANDOFF_LOG_PAGE_SIZE,
  }).entries;
  if (entries.length === 0) return null;

  const burst: LogEntryRow[] = [];
  let previousTimestampMs = 0;
  for (const entry of entries) {
    const timestampMs = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    if (burst.length > 0 && previousTimestampMs - timestampMs > HANDOFF_BURST_GAP_MS) break;
    burst.push(entry);
    previousTimestampMs = timestampMs;
  }
  if (burst.length === 0) return null;

  let accepted = 0;
  let rejected = 0;
  let enqueued = 0;
  for (const entry of burst) {
    const data = parseLogData(entry);
    accepted += numberFromLogData(data, 'accepted') ?? 0;
    rejected += numberFromLogData(data, 'rejected') ?? 0;
    enqueued += numberFromLogData(data, 'total') ?? 0;
  }

  const completedAt = burst[0].timestamp;
  const startedAt = burst[burst.length - 1].timestamp;
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));

  return {
    completed_at: completedAt,
    started_at: startedAt,
    duration_ms: Number.isFinite(durationMs) ? durationMs : null,
    enqueued,
    accepted,
    rejected,
    batches: burst.length,
    error: null,
    mode: null,
    source: 'flush_logs',
  };
}

function latestHandoffSummary(): TeamHandoffSummary | null {
  const handoff = searchLogs({
    kind: LOG_KINDS.TEAM_SYNC_HANDOFF,
    page_size: 1,
  }).entries[0];
  if (handoff) return explicitHandoffSummary(handoff);
  return latestFlushBurstSummary();
}

function packageVersionNearExecutable(entryPath: string): string | null {
  let realPath: string;
  try {
    realPath = fs.realpathSync(entryPath);
  } catch {
    return null;
  }

  let dir = fs.statSync(realPath).isDirectory() ? realPath : path.dirname(realPath);
  for (let depth = 0; depth < 5; depth++) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string };
      if (pkg.name === TEAM_PACKAGE_NAME && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // Keep walking toward the package root.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function executableSearchDirs(): string[] {
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return Array.from(new Set([...fromPath, path.join(os.homedir(), '.local', 'bin')]));
}

function resolveExecutableFromPath(binaryName: string): string | null {
  const suffixes = process.platform === 'win32'
    ? ['', '.cmd', '.exe', '.bat']
    : [''];

  for (const dir of executableSearchDirs()) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${binaryName}${suffix}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function resolvePathPackageVersion(binaryName: string, source: LocalTeamPackageSource): LocalTeamPackageVersion | null {
  const entry = resolveExecutableFromPath(binaryName);
  if (!entry) return null;
  const version = packageVersionNearExecutable(entry);
  return version ? { version, source } : null;
}

function resolveLocalTeamPackageVersion(globalPrefix: string | null): LocalTeamPackageVersion | null {
  if (globalPrefix) {
    const installedVersion = getInstalledVersion(globalPrefix, TEAM_PACKAGE_NAME);
    if (installedVersion) return { version: installedVersion, source: 'installed' };
  }

  return (
    resolvePathPackageVersion('myco-team-dev', 'dev-linked')
    ?? resolvePathPackageVersion('myco-team', 'path')
  );
}

// ---------------------------------------------------------------------------
// Drift helpers
// ---------------------------------------------------------------------------

export interface TableDrift {
  table: string;
  local: number;
  cloud: number;
  delta: number;
}

/**
 * Tables that appear in TEAM_SYNC_OBSERVED_TABLES and the worker's SYNCED_TABLES
 * but are NEVER actually pushed to D1, so their D1 copy is always empty.
 * Including them in drift would produce a permanent false-positive delta that a
 * Rebuild can never resolve (Rebuild can't re-push them either).
 *
 * entity_mentions: has no single `id` column → no _team_ad trigger → excluded
 * from all backfill paths. Post semantic-graph retirement the table is empty, but
 * the exclusion is structural so it stays correct if rows ever reappear.
 */
const DRIFT_EXCLUDED_TABLES: ReadonlySet<string> = new Set(['entity_mentions']);

/**
 * Compare per-table local row counts against per-table cloud row counts
 * (both scoped to THIS machine). Returns one entry per table, sorted by
 * table name. `delta` is `cloud - local`; negative means cloud is behind.
 *
 * Tables listed in `exclude` (default: `DRIFT_EXCLUDED_TABLES`) are omitted
 * from the union before comparison so they never contribute a false-positive
 * delta.
 */
export function computeDrift(
  local: Record<string, number>,
  cloud: Record<string, number>,
  exclude: ReadonlySet<string> = DRIFT_EXCLUDED_TABLES,
): TableDrift[] {
  const tables = new Set([...Object.keys(local), ...Object.keys(cloud)]);
  for (const t of exclude) tables.delete(t);
  return [...tables].sort().map((table) => {
    const l = local[table] ?? 0;
    const c = cloud[table] ?? 0;
    return { table, local: l, cloud: c, delta: c - l };
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamHandlerDeps {
  vaultDir: string;
  machineId: string;
  logger: DaemonLogger;
  getTeamClient: (requestContext?: MycoRequestContext) => TeamSyncClient | null;
  setTeamClient: (client: TeamSyncClient | null, requestContext?: MycoRequestContext) => void;
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

/**
 * Documentation for fields the `/api/team/status` response keeps in
 * its envelope but no longer populates. The fields are always null
 * in the current protocol and exist only for envelope compatibility
 * with older daemon UIs that still read them. The descriptive map
 * is exposed under `deprecated_fields` so consumers can render a
 * one-line "field X was removed for security; use Y instead"
 * disclosure rather than silently ignoring the now-empty value.
 *
 * The api_key/team_key removal was intentional (commits ad2e549e
 * and 9572a683 — "Redact reusable Team keys from status responses")
 * and is not reverted by C6; this map only documents the change.
 */
const DEPRECATED_STATUS_FIELDS: Record<string, { since: string; reason: string; replacement: string }> = {
  api_key: {
    since: 'protocol-v2',
    reason: 'Reusable team keys removed from status responses for security.',
    replacement: 'has_api_key',
  },
  team_key: {
    since: 'protocol-v2',
    reason: 'Reusable team keys removed from status responses for security.',
    replacement: 'has_team_key',
  },
};

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

    // Save config and secret to the selected Grove when request context is
    // Grove-era; legacy callers keep the historical project-local storage.
    updateTeamConnectionConfig(vaultDir, req.requestContext, {
      enabled: true,
      worker_url: url,
    });
    writeTeamConnectionSecret(vaultDir, req.requestContext, TEAM_API_KEY_SECRET, api_key);
    deps.setTeamClient(client, req.requestContext);

    const team = loadTeamConnectionConfig(vaultDir, req.requestContext);
    return { body: { connected: true, team } };
  }

  /**
   * POST /api/team/disconnect
   *
   * Disables team sync, clears the live client reference, and purges any
   * pending outbox rows. Without the purge, every prior enqueue sits
   * forever as `pending_sync_count` on the status endpoint — surfacing in
   * the Team page UI as "N failures in the queue" against a sync that
   * will never run. The source records (sessions, spores, etc.) are
   * untouched; if team sync is later re-enabled, `handleBackfill`
   * re-enqueues them from current state.
   */
  async function handleDisconnect(req: RouteRequest): Promise<RouteResponse> {
    updateTeamConnectionConfig(vaultDir, req.requestContext, { enabled: false });
    deps.setTeamClient(null, req.requestContext);

    let purged = 0;
    let purgedByTable: Record<string, number> = {};
    try {
      purgedByTable = countPendingByTable();
      purged = purgePendingOutbox();
    } catch (err) {
      logger.warn('team-sync.outbox.purge-failed', 'Failed to purge pending outbox on disconnect', {
        error: errorMessage(err),
      });
    }
    if (purged > 0) {
      logger.info('team-sync.outbox.purged', 'Purged pending outbox rows after team-sync disconnect', {
        purged,
        by_table: purgedByTable,
      });
    }

    return { body: { connected: false, purged_pending: purged } };
  }

  /**
   * GET /api/team/status
   *
   * Returns connection status, health check result, pending sync count, and machine_id.
   */
  async function handleStatus(req: RouteRequest): Promise<RouteResponse> {
    const config = loadTeamConnectionConfig(vaultDir, req.requestContext);
    const client = deps.getTeamClient(req.requestContext);
    const secrets = readTeamConnectionSecrets(vaultDir, req.requestContext);
    const store = resolveTeamConnectionStore(vaultDir, req.requestContext);
    const teamKey = secrets[TEAM_API_KEY_SECRET]?.trim() || null;
    const hasTeamKey = Boolean(teamKey);
    const localTeamPackage = resolveLocalTeamPackageVersion(deps.globalPrefix);
    const cachedTeamPackageVersion = readCachedTeamPackageVersion(store.configDir);
    let deployedWorkerVersion: string | null = null;

    let healthy = false;
    let healthError: string | undefined;
    let workerHasMcpToken = false;

    if (client && config.enabled) {
      try {
        const health = await client.health();
        healthy = true;
        deployedWorkerVersion = health.package_version?.trim() || null;
        // The worker's `/health` returns `mcp_token_hash` only when the
        // Cloud MCP token is provisioned in the worker's KV. Treat
        // worker-up + token-provisioned as the MCP health signal — same
        // process hosts both, so this avoids a separate authenticated
        // probe round-trip.
        workerHasMcpToken = Boolean(health.mcp_token_hash);
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
    if (client && config.enabled) {
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
        ...resolveTeamConnectionContext(req.requestContext, vaultDir),
        enabled: config.enabled,
        worker_url: config.worker_url ?? null,
        has_team_key: hasTeamKey,
        team_key: null,
        has_api_key: hasTeamKey,
        api_key: null,
        healthy,
        health_error: healthError,
        pending_sync_count: pendingCount,
        machine_id: machineId,
        package_version: getPluginVersion(),
        local_team_package_version: localTeamPackage?.version ?? null,
        local_team_package_source: localTeamPackage?.source ?? null,
        cached_team_package_version: cachedTeamPackageVersion,
        deployed_worker_version: deployedWorkerVersion,
        worker_update_available:
          config.enabled &&
          Boolean(localTeamPackage?.version) &&
          Boolean(deployedWorkerVersion) &&
          deployedWorkerVersion !== localTeamPackage?.version,
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
        min_compat_client_version: MIN_COMPAT_CLIENT_VERSION,
        mcp_token: client?.getMcpToken() ?? null,
        mcp_endpoint: client?.getMcpEndpoint() ?? null,
        mcp_healthy: healthy && workerHasMcpToken,
        local_only_disclosures: buildLocalOnlyDisclosures(),
        deprecated_fields: DEPRECATED_STATUS_FIELDS,
      },
    };
  }

  /**
   * Snapshot the local-only sync policy for the UI's "What stays
   * local" disclosure on the Synced data tab. Derived from the
   * canonical LOCAL_ONLY_OUTBOX_TABLES + LOCAL_ONLY_SYNC_COLUMNS +
   * LOCAL_ONLY_RATIONALES exports so the UI can never drift from
   * the enforcement. Restored here after the Grove-scope refactor
   * removed it; pre-Grove UIs treat the field as additive.
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

  /**
   * POST /api/team/backfill — single-button reconcile.
   *   1. Enqueue local unsynced rows onto the outbox so the daemon
   *      flushes them up the queue (existing behavior).
   *   2. Tell the worker to enqueue `embed` jobs for every embeddable
   *      row already in D1, so vectors get rebuilt for rows that
   *      were synced before embedding worked. Failure here doesn't
   *      fail the request — local backfill already succeeded and the
   *      remote enqueue can be retried.
   */
  async function handleBackfill(req: RouteRequest): Promise<RouteResponse> {
    const body = (req.body ?? {}) as { mode?: unknown };
    const mode = body.mode === 'all' ? 'all' : 'unsynced';
    const count = mode === 'all' ? backfillAll(machineId) : backfillUnsynced(machineId);

    let vectorEnqueued: number | null = null;
    let vectorError: string | null = null;
    const client = deps.getTeamClient(req.requestContext);
    if (client) {
      try {
        const result = await client.enqueueVectorReindex();
        vectorEnqueued = result.enqueued;
      } catch (err) {
        vectorError = err instanceof Error ? err.message : String(err);
        logger.warn('team-sync.backfill.reindex-failed', 'Remote vector reindex enqueue failed', { error: vectorError });
      }
    }

    return { body: { enqueued: count, mode, vector_enqueued: vectorEnqueued, vector_error: vectorError } };
  }

  function clientOrError(requestContext?: MycoRequestContext): { ok: true; client: TeamSyncClient } | { ok: false; response: RouteResponse } {
    const client = deps.getTeamClient(requestContext);
    if (!client) return { ok: false, response: { status: 503, body: { error: 'team_not_configured' } } };
    return { ok: true, client };
  }

  /** GET /api/team/queue-stats — proxies D1-backed queue processing stats from the worker. */
  async function handleQueueStats(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
    if (!guard.ok) return guard.response;
    const stats = await guard.client.getQueueStats();
    return { body: stats };
  }

  /** GET /api/team/sync-summary — local/remote sync status for the Sync tab. */
  async function handleSyncSummary(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
    if (!guard.ok) return guard.response;

    const localTables = countTeamSyncRows(machineId);
    const localTotal = Object.values(localTables).reduce((sum, count) => sum + count, 0);
    let pendingCount = 0;
    try {
      pendingCount = countPending();
    } catch {
      pendingCount = 0;
    }

    let remote: TeamRemoteSyncSummaryResponse | null = null;
    let remoteError: string | null = null;
    try {
      remote = await guard.client.getSyncSummary(machineId);
    } catch (err) {
      remoteError = errorMessage(err);
      logger.warn('team-sync.summary.remote-failed', 'Remote sync summary unavailable', { error: remoteError });
    }

    // Only compute drift when the worker actually returned machine-scoped
    // counts. A 200 without `machine_tables` (daemon newer than worker during
    // a rolling upgrade) or a remote failure must NOT be treated as cloud-0 —
    // that would inflate total_delta and misfire the destructive Rebuild.
    const cloudTables = remote?.machine_tables ?? null;
    const drift = cloudTables != null
      ? computeDrift(localTables as Record<string, number>, cloudTables)
      : [];
    const total_delta = drift.reduce((s, d) => s + Math.abs(d.delta), 0);

    return {
      body: {
        generated_at: Math.floor(Date.now() / 1000),
        local: {
          total_records: localTotal,
          pending_sync_count: pendingCount,
          tables: localTables,
          schema_version: SCHEMA_VERSION,
        },
        remote,
        remote_error: remoteError,
        last_handoff: latestHandoffSummary(),
        drift,
        total_delta,
      },
    };
  }

  /** GET /api/team/dlq — list a page of DLQ messages from the worker's D1-backed endpoint. */
  async function handleDlqList(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
    if (!guard.ok) return guard.response;
    const limit = Number(req.query.limit ?? '50') || 50;
    const result = await guard.client.listDlq(limit);
    return { body: result };
  }

  /** POST /api/team/dlq/retry — re-publish DLQ messages back to the main queue. */
  async function handleDlqRetry(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
    if (!guard.ok) return guard.response;
    const body = (req.body ?? {}) as { lease_ids?: unknown };
    const leaseIds = Array.isArray(body.lease_ids) ? body.lease_ids.filter((id): id is string => typeof id === 'string') : [];
    if (leaseIds.length === 0) return { status: 400, body: { error: 'lease_ids array is required' } };
    const result = await guard.client.retryDlq(leaseIds);
    return { body: result };
  }

  /** POST /api/team/dlq/discard — permanently drop DLQ messages. */
  async function handleDlqDiscard(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
    if (!guard.ok) return guard.response;
    const body = (req.body ?? {}) as { lease_ids?: unknown };
    const leaseIds = Array.isArray(body.lease_ids) ? body.lease_ids.filter((id): id is string => typeof id === 'string') : [];
    if (leaseIds.length === 0) return { status: 400, body: { error: 'lease_ids array is required' } };
    const result = await guard.client.discardDlq(leaseIds);
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
  async function handleUpgradeWorker(req: RouteRequest): Promise<RouteResponse> {
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

    // Re-read merged config (the subprocess updated team.worker_url in
    // the Grove-tier config) and reinitialize the client from the fresh
    // merged config rather than the subprocess's result shape. Passing
    // `groveId` ensures the Grove-tier `team` block is included.
    const freshConfig = loadMergedConfig(vaultDir, {
      groveId: req.requestContext?.groveId ?? null,
    });
    const workerUrl = result.worker_url ?? freshConfig.team.worker_url;
    if (workerUrl) {
      updateTeamConnectionConfig(vaultDir, req.requestContext, {
        enabled: true,
        worker_url: workerUrl,
      });
    }
    const teamConfig = loadTeamConnectionConfig(vaultDir, req.requestContext);
    const secrets = readTeamConnectionSecrets(vaultDir, req.requestContext);
    const apiKey = secrets[TEAM_API_KEY_SECRET];
    if (teamConfig.enabled && teamConfig.worker_url && apiKey && deps.getTeamClient(req.requestContext)) {
      deps.setTeamClient(new TeamSyncClient({
        workerUrl: teamConfig.worker_url,
        apiKey,
        machineId,
        syncProtocolVersion: SYNC_PROTOCOL_VERSION,
      }), req.requestContext);
    }

    return { body: result };
  }

  /** POST /api/team/rotate-mcp-token — rotate the MCP bearer token. */
  async function handleRotateMcpToken(req: RouteRequest): Promise<RouteResponse> {
    const client = deps.getTeamClient(req.requestContext);
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
    handleQueueStats, handleSyncSummary, handleDlqList, handleDlqRetry, handleDlqDiscard,
  };
}

function resolveTeamConnectionContext(
  requestContext: MycoRequestContext | undefined,
  fallbackVaultDir: string,
): TeamConnectionContext {
  const projectVaultDir = requestContext?.projectVaultDir ?? fallbackVaultDir;
  const manifest = loadProjectManifest(projectVaultDir);
  const projectRoot = requestContext?.projectRoot ?? resolveProjectRoot(projectVaultDir);
  const groveScoped = isGroveScoped(requestContext);
  const grove = groveScoped ? loadGroveRecord(requestContext!.groveId!) : null;

  // Project id must be a `proj_<32hex>` brand. Returning the project root
  // path as the id (the previous behavior) silently corrupted the API
  // surface — every typed consumer rejected the path-shaped string. Now
  // we return `project: null` so callers branch explicitly on missing
  // identity rather than misinterpreting a path as an id.
  const projectId = requestContext?.projectId ?? manifest?.project.id;
  return {
    connection_scope: groveScoped ? 'grove' : 'legacy-project',
    grove: groveScoped
      ? {
          id: requestContext!.groveId!,
          name: grove?.name ?? requestContext!.groveId!,
          slug: grove?.slug ?? manifest?.grove?.slug ?? requestContext!.groveId!,
          mode: grove?.mode ?? manifest?.grove?.mode ?? 'local',
        }
      : null,
    project: projectId
      ? {
          id: projectId,
          name: manifest?.project.name ?? path.basename(projectRoot),
          root: projectRoot,
        }
      : null,
  };
}
