/**
 * Team connect/disconnect/status API handlers.
 *
 * Factory pattern: `createTeamHandlers(deps)` returns route handlers that
 * close over the daemon's shared state (vault dir, machine ID, team client).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectManifest } from '@myco/config/project-manifest.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { resolveGroveDir } from '@myco/grove/paths.js';
import {
  countPending,
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
import { TeamSyncClient, type DlqListResponse, type QueueStatsResponse, type TeamRemoteSyncSummaryResponse, type VersionCompat } from '../team-sync.js';
import { MIN_COMPAT_CLIENT_VERSION, SYNC_PROTOCOL_VERSION, TEAM_API_KEY_SECRET, TEAM_MCP_TOKEN_SECRET } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { getPluginVersion } from '@myco/version.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
import { loadGroveRecord } from '@myco/grove/registry.js';
import { teamRegistry, withProjectRemoved } from '@myco/team/registry.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { DaemonLogger } from '../logger.js';
import { isGroveScoped, type MycoRequestContext } from '@myco/tools/request-context.js';

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
  /**
   * npm global prefix — used to locate the installed `@goondocks/myco-team`
   * package for the Worker upgrade subprocess and for reporting the local
   * team package version in `handleStatus`. Null when npm prefix resolution
   * failed; Worker upgrades return a typed error in that case.
   */
  globalPrefix: string | null;
  /**
   * Builds a transient client for the join handshake from raw URL + key
   * (the team is not in the registry yet, so getTeamClient can't resolve it).
   * Defaults to a real TeamSyncClient; injected as a stub in tests.
   */
  makeJoinClient?: (opts: { workerUrl: string; apiKey: string }) => Pick<TeamSyncClient, 'connect'>;
  /** Resolve a client directly by team_id (used by the team-scoped read paths). */
  getTeamClientForId?: (teamId: string) => TeamSyncClient | null;
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
 * `api_key` (the legacy project-level alias) stays removed. `team_key`
 * is surfaced again for the Grove team-credentials card: teammates need
 * to copy the reusable key to join, so it ships to the localhost daemon
 * UI exactly like `mcp_token` — full value over the local socket, redacted
 * and reveal-on-demand in the client.
 */
const DEPRECATED_STATUS_FIELDS: Record<string, { since: string; reason: string; replacement: string }> = {
  api_key: {
    since: 'protocol-v2',
    reason: 'Legacy project-level team key removed from status responses for security.',
    replacement: 'has_api_key',
  },
};

export function createTeamHandlers(deps: TeamHandlerDeps) {
  const { vaultDir, machineId, logger } = deps;

  const makeJoinClient = deps.makeJoinClient ?? ((opts: { workerUrl: string; apiKey: string }) =>
    new TeamSyncClient({
      workerUrl: opts.workerUrl,
      apiKey: opts.apiKey,
      machineId,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    }));

  /**
   * POST /api/team/connect
   *
   * Retired legacy endpoint. Team setup is registry-owned by `myco-team
   * install` plus the Team selection API; keeping this as a writer would
   * reintroduce split-brain state between grove config and the registry.
   */
  async function handleConnect(_req: RouteRequest): Promise<RouteResponse> {
    return {
      status: 410,
      body: {
        error: 'legacy_team_connect_removed',
        message: 'Team sync is configured through myco-team install and the Team selection tab.',
      },
    };
  }

  /**
   * POST /api/team/disconnect
   *
   * Removes the current project from its registry Team. This replaces the
   * legacy config toggle; outbox cleanup is handled by the registry-aware
   * reconcile/flush path so we don't purge other projects' pending rows.
   */
  async function handleDisconnect(req: RouteRequest): Promise<RouteResponse> {
    const projectId = req.requestContext?.projectId;
    if (!projectId) {
      return { status: 400, body: { error: 'missing_project_context' } };
    }

    const teamId = teamRegistry.membershipByProject().get(projectId);
    if (!teamId) {
      return { body: { connected: false, removed_project: false } };
    }

    const team = teamRegistry.get(teamId);
    if (!team) return { body: { connected: false, removed_project: false } };

    teamRegistry.save(withProjectRemoved(team, projectId));
    logger.info('team-sync.registry.disconnected', 'Removed project from Team registry membership', {
      team_id: teamId,
      project_id: projectId,
    });
    return { body: { connected: false, removed_project: true, team_id: teamId } };
  }

  /**
   * GET /api/team/status
   *
   * Returns connection status, health check result, pending sync count, and machine_id.
   */
  async function handleStatus(req: RouteRequest): Promise<RouteResponse> {
    const client = deps.getTeamClient(req.requestContext);
    const localTeamPackage = resolveLocalTeamPackageVersion(deps.globalPrefix);
    const cachedTeamPackageVersion = readCachedTeamPackageVersion(resolveTeamStateDir(vaultDir, req.requestContext));
    let deployedWorkerVersion: string | null = null;

    // Registry participation — not the legacy grove-config flag — is the
    // source of truth for whether this Grove syncs (one team per project,
    // per-team drain). `enabled` reflects participation; the resolved team's
    // worker_url / MCP token come from the registry-aware client + record.
    const groveId = req.requestContext?.groveId ?? null;
    const participates = groveId != null && teamRegistry
      .list()
      .some((t) => t.projects.some((p) => p.grove_id === groveId));
    // The team that owns this request's project, when resolvable — its
    // registry record supplies the worker_url surfaced below.
    const resolvedTeamId = req.requestContext?.projectId
      ? teamRegistry.membershipByProject().get(req.requestContext.projectId) ?? null
      : null;
    const resolvedTeam = resolvedTeamId ? teamRegistry.get(resolvedTeamId) : null;
    const registrySecrets = resolvedTeamId ? teamRegistry.readSecrets(resolvedTeamId) : {};
    const teamKey = registrySecrets[TEAM_API_KEY_SECRET]?.trim() || null;
    const hasTeamKey = Boolean(teamKey);

    let healthy = false;
    let healthError: string | undefined;
    let workerHasMcpToken = false;

    if (client && participates) {
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

    // Sync-protocol compatibility. health() above populates the client's
    // advertised worker bounds; getVersionCompat() reports 'unknown' until a
    // probe succeeds (so a failed health() naturally yields 'unknown'). The UI
    // surfaces 'client_too_old' as an actionable "run myco update" prompt.
    const versionStatus: VersionCompat = client && participates
      ? client.getVersionCompat()
      : 'unknown';

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
    if (client && participates) {
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
        enabled: participates,
        team_id: resolvedTeamId,
        worker_url: resolvedTeam?.worker_url ?? null,
        has_team_key: hasTeamKey,
        team_key: teamKey,
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
          participates &&
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
        version_status: versionStatus,
        daemon_protocol_version: SYNC_PROTOCOL_VERSION,
        worker_protocol_version: client?.getWorkerProtocolVersion() ?? null,
        worker_min_client_version: client?.getWorkerMinClientVersion() ?? null,
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

    // This-machine cloud total, derived from the machine-scoped counts. The raw
    // `remote.total_records` is ALL-machine, so comparing it against the
    // this-machine `localTotal` in the summary card produced a phantom delta
    // whenever the cloud held rows under other (or legacy 'local') machine_ids.
    // Null when the worker is too old to scope (cloudTables == null) so the UI
    // renders '—' instead of a misleading number — mirrors the drift guard.
    const remote_machine_total = cloudTables != null
      ? Object.values(cloudTables).reduce((sum, count) => sum + count, 0)
      : null;

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
        remote_machine_total,
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
      const teamId = req.requestContext?.projectId
        ? teamRegistry.membershipByProject().get(req.requestContext.projectId) ?? null
        : null;
      if (teamId) teamRegistry.writeSecret(teamId, TEAM_MCP_TOKEN_SECRET, token);
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

  /**
   * POST /api/team/join — register an existing team on this machine from a
   * shared Worker URL + Team key. Does the /connect handshake (no infra
   * provisioning), then writes the registry record + secrets. Idempotent:
   * re-joining upserts by the worker-authoritative team_id and preserves
   * existing project membership.
   */
  async function handleJoin(req: RouteRequest): Promise<RouteResponse> {
    const body = (req.body ?? {}) as { worker_url?: unknown; team_key?: unknown };
    const workerUrl = typeof body.worker_url === 'string' ? body.worker_url.trim().replace(/\/+$/, '') : '';
    const teamKey = typeof body.team_key === 'string' ? body.team_key.trim() : '';
    if (!workerUrl || !teamKey) {
      return { status: 400, body: { error: 'missing_fields', message: 'worker_url and team_key are required' } };
    }

    let config: Awaited<ReturnType<TeamSyncClient['connect']>>;
    try {
      config = await makeJoinClient({ workerUrl, apiKey: teamKey }).connect({ machine_id: machineId });
    } catch (err) {
      const message = errorMessage(err);
      logger.warn('team-sync.join.connect-failed', 'Team join handshake failed', { error: message });
      return { status: 502, body: { error: 'join_connect_failed', message } };
    }

    const cfg = (config.config ?? {}) as Record<string, unknown>;
    const teamId = typeof cfg.team_id === 'string' ? cfg.team_id.trim() : '';
    if (!teamId) {
      return {
        status: 409,
        body: {
          error: 'worker_missing_team_id',
          message: "This team's worker predates the join feature. Ask the team operator to run `myco-team update --team-id <id>` and reconnect, then try again.",
        },
      };
    }
    const teamName = typeof cfg.team_name === 'string' ? cfg.team_name : '';
    const existing = teamRegistry.get(teamId);

    teamRegistry.save({
      team_id: teamId,
      name: teamName || existing?.name || teamId,
      worker_url: workerUrl,
      domain: null,
      mcp_endpoint: `${workerUrl}/mcp`,
      created_at: existing?.created_at ?? new Date().toISOString(),
      projects: existing?.projects ?? [],
    });
    teamRegistry.writeSecret(teamId, TEAM_API_KEY_SECRET, teamKey);
    if (config.mcp_token) teamRegistry.writeSecret(teamId, TEAM_MCP_TOKEN_SECRET, config.mcp_token);

    logger.info('team-sync.join.registered', 'Joined team via shared credentials', { team_id: teamId });
    return { body: { team: teamRegistry.get(teamId) } };
  }

  return {
    handleConnect, handleJoin, handleDisconnect, handleStatus, handleBackfill, handleRotateMcpToken,
    handleQueueStats, handleSyncSummary, handleDlqList, handleDlqRetry, handleDlqDiscard,
  };
}

function resolveTeamStateDir(fallbackVaultDir: string, requestContext?: MycoRequestContext): string {
  return requestContext?.groveId ? resolveGroveDir(requestContext.groveId) : fallbackVaultDir;
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
