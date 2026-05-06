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
  countTeamSyncRows,
  backfillAll,
  backfillUnsynced,
} from '@myco/db/queries/team-outbox.js';
import { searchLogs, type LogEntryRow } from '@myco/db/queries/logs.js';
import { buildCommandEnv, readJsonConfig, resolveVaultConfigPath } from '@myco-deploy/index.js';
import { getInstalledVersion } from '../update-checker.js';
import { TEAM_PACKAGE_NAME } from '@myco/constants/update.js';
import { TeamSyncClient, type DlqListResponse, type QueueStatsResponse, type TeamRemoteSyncSummaryResponse } from '../team-sync.js';
import { SYNC_PROTOCOL_VERSION, TEAM_API_KEY_SECRET } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { getPluginVersion } from '@myco/version.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
import { loadGroveRecord } from '@myco/grove/registry.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { DaemonLogger } from '../logger.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';

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

interface WranglerWhoamiAccount {
  id?: string;
  name?: string;
}

interface WranglerWhoami {
  loggedIn?: boolean;
  accounts?: WranglerWhoamiAccount[];
}

interface CloudflareQueueCredentials {
  token: string;
  accountId: string;
}

interface TeamQueueNames {
  sync: string;
  dlq: string;
}

interface TeamConnectionContext {
  connection_scope: 'grove' | 'legacy-project';
  grove: {
    id: string;
    name: string;
    slug: string;
    mode: string;
  } | null;
  project: {
    id: string;
    name: string;
    root: string;
  };
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

function readTeamLocalState(vaultDir: string, requestContext?: MycoRequestContext): TeamLocalConfig | null {
  const store = resolveTeamConnectionStore(vaultDir, requestContext);
  const configPath = path.join(store.configDir, TEAM_CONFIG_DIR, TEAM_CONFIG_FILE);
  return readJsonConfig<TeamLocalConfig>(configPath);
}

function resolveTeamQueueNames(vaultDir: string, requestContext?: MycoRequestContext): TeamQueueNames | null {
  const workerName = readTeamLocalState(vaultDir, requestContext)?.worker_name?.trim();
  if (!workerName) return null;
  return {
    sync: `${workerName}-sync`,
    dlq: `${workerName}-sync-dlq`,
  };
}

function readTomlString(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'));
  return match?.[1] ?? null;
}

function wranglerAuthConfigCandidates(): string[] {
  const home = os.homedir();
  const candidates = [
    process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, '.wrangler', 'config', 'default.toml')
      : null,
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Preferences', '.wrangler', 'config', 'default.toml')
      : null,
    path.join(home, '.config', '.wrangler', 'config', 'default.toml'),
    path.join(home, '.wrangler', 'config', 'default.toml'),
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

async function resolveWranglerCloudflareCredentials(): Promise<CloudflareQueueCredentials | null> {
  let whoami: WranglerWhoami | null = null;
  try {
    const result = await execFileAsync('wrangler', ['whoami', '--json'], {
      encoding: 'utf-8',
      env: buildCommandEnv(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    whoami = JSON.parse(result.stdout) as WranglerWhoami;
  } catch {
    return null;
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
    || whoami?.accounts?.find((account) => account.id)?.id?.trim()
    || null;
  if (!accountId) return null;

  for (const candidate of wranglerAuthConfigCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const token = readTomlString(fs.readFileSync(candidate, 'utf-8'), 'oauth_token');
    if (token) return { token, accountId };
  }

  return null;
}

async function resolveQueueId(creds: CloudflareQueueCredentials, queueName: string): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/queues?name=${encodeURIComponent(queueName)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Cloudflare queue lookup failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { result?: Array<{ queue_id?: string }> };
  const id = body.result?.[0]?.queue_id;
  if (!id) throw new Error(`Cloudflare queue not found: ${queueName}`);
  return id;
}

async function fetchQueueStatsForQueue(creds: CloudflareQueueCredentials, queueName: string): Promise<{ depth: null; oldest_msg_age_s: null }> {
  await resolveQueueId(creds, queueName);
  return { depth: null, oldest_msg_age_s: null };
}

async function fetchLocalQueueStats(creds: CloudflareQueueCredentials, queues: TeamQueueNames): Promise<QueueStatsResponse> {
  const [main, dlq] = await Promise.all([
    fetchQueueStatsForQueue(creds, queues.sync),
    fetchQueueStatsForQueue(creds, queues.dlq),
  ]);
  return { main, dlq };
}

async function listLocalDlq(creds: CloudflareQueueCredentials, queueName: string, limit: number): Promise<DlqListResponse> {
  const queueId = await resolveQueueId(creds, queueName);
  const batchSize = Math.min(Math.max(limit, 1), 100);
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/queues/${queueId}/messages/pull`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ batch_size: batchSize, visibility_timeout_ms: 5 * 60 * 1000 }),
  });
  if (!res.ok) {
    throw new Error(`Cloudflare DLQ pull failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as {
    result?: { messages?: Array<{ lease_id?: string; body?: unknown; attempts?: number; metadata?: Record<string, unknown> }> };
  };
  return {
    messages: (body.result?.messages ?? []).map((message) => ({
      msg_id: String(message.lease_id ?? ''),
      body: (message.body ?? {}) as Record<string, unknown>,
      attempts: typeof message.attempts === 'number' ? message.attempts : 0,
      last_failure: typeof message.metadata?.last_failure === 'string' ? message.metadata.last_failure : undefined,
      enqueued_at: typeof message.metadata?.enqueued_at === 'number' ? message.metadata.enqueued_at : undefined,
    })),
    next_cursor: null,
  };
}

async function ackLocalDlq(creds: CloudflareQueueCredentials, queueName: string, leaseIds: string[], action: 'retry' | 'discard'): Promise<void> {
  const queueId = await resolveQueueId(creds, queueName);
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/queues/${queueId}/messages/ack`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      acks: action === 'discard' ? leaseIds.map((id) => ({ lease_id: id })) : [],
      retries: action === 'retry' ? leaseIds.map((id) => ({ lease_id: id, delay_seconds: 0 })) : [],
    }),
  });
  if (!res.ok) {
    throw new Error(`Cloudflare DLQ ${action} failed: ${res.status} ${await res.text()}`);
  }
}

function isCloudflareTokenMissing(value: unknown): value is { error: 'cf_api_token_not_configured' } {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { error?: unknown }).error === 'cf_api_token_not_configured'
  );
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
   * Disables team sync and clears the live client reference.
   */
  async function handleDisconnect(req: RouteRequest): Promise<RouteResponse> {
    updateTeamConnectionConfig(vaultDir, req.requestContext, { enabled: false });
    deps.setTeamClient(null, req.requestContext);

    return { body: { connected: false } };
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
        mcp_token: client?.getMcpToken() ?? null,
        mcp_endpoint: client?.getMcpEndpoint() ?? null,
        mcp_healthy: healthy && workerHasMcpToken,
      },
    };
  }

  /** POST /api/team/backfill — enqueue all unsynced rows to the outbox. */
  async function handleBackfill(req: RouteRequest): Promise<RouteResponse> {
    const body = (req.body ?? {}) as { mode?: unknown };
    const mode = body.mode === 'all' ? 'all' : 'unsynced';
    const count = mode === 'all' ? backfillAll(machineId) : backfillUnsynced(machineId);
    return { body: { enqueued: count, mode } };
  }

  function clientOrError(requestContext?: MycoRequestContext): { ok: true; client: TeamSyncClient } | { ok: false; response: RouteResponse } {
    const client = deps.getTeamClient(requestContext);
    if (!client) return { ok: false, response: { status: 503, body: { error: 'team_not_configured' } } };
    return { ok: true, client };
  }

  /** GET /api/team/queue-stats — proxies CF queue depth + DLQ depth from the worker. */
  async function handleQueueStats(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
    if (!guard.ok) return guard.response;
    const stats = await guard.client.getQueueStats();
    if (isCloudflareTokenMissing(stats)) {
      try {
        const [creds, queues] = await Promise.all([
          resolveWranglerCloudflareCredentials(),
          Promise.resolve(resolveTeamQueueNames(vaultDir, req.requestContext)),
        ]);
        if (creds && queues) {
          return { body: await fetchLocalQueueStats(creds, queues) };
        }
      } catch (err) {
        const detail = errorMessage(err);
        logger.warn('team-sync.queue.local-stats-failed', 'Local Wrangler queue stats unavailable', { error: detail });
      }
    }
    return { body: stats };
  }

  /** GET /api/team/sync-summary — local/remote sync status for the Sync tab. */
  async function handleSyncSummary(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
    if (!guard.ok) return guard.response;

    const localTables = countTeamSyncRows();
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
      remote = await guard.client.getSyncSummary();
    } catch (err) {
      remoteError = errorMessage(err);
      logger.warn('team-sync.summary.remote-failed', 'Remote sync summary unavailable', { error: remoteError });
    }

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
      },
    };
  }

  /** GET /api/team/dlq — list a page of DLQ messages from the worker. */
  async function handleDlqList(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
    if (!guard.ok) return guard.response;
    const limit = Number(req.query.limit ?? '50') || 50;
    const result = await guard.client.listDlq(limit);
    if (isCloudflareTokenMissing(result)) {
      try {
        const [creds, queues] = await Promise.all([
          resolveWranglerCloudflareCredentials(),
          Promise.resolve(resolveTeamQueueNames(vaultDir, req.requestContext)),
        ]);
        if (creds && queues) {
          return { body: await listLocalDlq(creds, queues.dlq, limit) };
        }
      } catch (err) {
        const detail = errorMessage(err);
        logger.warn('team-sync.queue.local-dlq-list-failed', 'Local Wrangler DLQ list unavailable', { error: detail });
      }
    }
    return { body: result };
  }

  /** POST /api/team/dlq/retry — re-publish DLQ messages back to the main queue. */
  async function handleDlqRetry(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
    if (!guard.ok) return guard.response;
    const body = (req.body ?? {}) as { lease_ids?: unknown };
    const leaseIds = Array.isArray(body.lease_ids) ? body.lease_ids.filter((id): id is string => typeof id === 'string') : [];
    if (leaseIds.length === 0) return { status: 400, body: { error: 'lease_ids array is required' } };
    try {
      const result = await guard.client.retryDlq(leaseIds);
      return { body: result };
    } catch (err) {
      const [creds, queues] = await Promise.all([
        resolveWranglerCloudflareCredentials(),
        Promise.resolve(resolveTeamQueueNames(vaultDir, req.requestContext)),
      ]);
      if (!creds || !queues) throw err;
      await ackLocalDlq(creds, queues.dlq, leaseIds, 'retry');
      return { body: { retried: leaseIds.length } };
    }
  }

  /** POST /api/team/dlq/discard — permanently drop DLQ messages. */
  async function handleDlqDiscard(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
    if (!guard.ok) return guard.response;
    const body = (req.body ?? {}) as { lease_ids?: unknown };
    const leaseIds = Array.isArray(body.lease_ids) ? body.lease_ids.filter((id): id is string => typeof id === 'string') : [];
    if (leaseIds.length === 0) return { status: 400, body: { error: 'lease_ids array is required' } };
    try {
      const result = await guard.client.discardDlq(leaseIds);
      return { body: result };
    } catch (err) {
      const [creds, queues] = await Promise.all([
        resolveWranglerCloudflareCredentials(),
        Promise.resolve(resolveTeamQueueNames(vaultDir, req.requestContext)),
      ]);
      if (!creds || !queues) throw err;
      await ackLocalDlq(creds, queues.dlq, leaseIds, 'discard');
      return { body: { discarded: leaseIds.length } };
    }
  }

  /** POST /api/team/cf-api-token — stash a CF API token + account id on the worker. */
  async function handleSetCfApiToken(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
    if (!guard.ok) return guard.response;
    const body = (req.body ?? {}) as { token?: string; account_id?: string };
    if (!body.token || !body.account_id) {
      return { status: 400, body: { error: 'token and account_id are required' } };
    }
    const result = await guard.client.setCfApiToken(body.token, body.account_id);
    return { body: result };
  }

  /** DELETE /api/team/cf-api-token — clear the worker's CF API token. */
  async function handleClearCfApiToken(req: RouteRequest): Promise<RouteResponse> {
    const guard = clientOrError(req.requestContext);
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

    // Re-read myco.yaml (the subprocess updated team.worker_url) and
    // reinitialize the client from the fresh merged config rather than
    // the subprocess's result shape.
    const freshConfig = loadMergedConfig(vaultDir);
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
    handleQueueStats, handleSyncSummary, handleDlqList, handleDlqRetry, handleDlqDiscard, handleSetCfApiToken, handleClearCfApiToken,
  };
}

function resolveTeamConnectionContext(
  requestContext: MycoRequestContext | undefined,
  fallbackVaultDir: string,
): TeamConnectionContext {
  const projectVaultDir = requestContext?.projectVaultDir ?? fallbackVaultDir;
  const manifest = loadProjectManifest(projectVaultDir);
  const projectRoot = requestContext?.projectRoot ?? resolveProjectRoot(projectVaultDir);
  const grove = requestContext?.groveId ? loadGroveRecord(requestContext.groveId) : null;

  return {
    connection_scope: requestContext?.groveId ? 'grove' : 'legacy-project',
    grove: requestContext?.groveId
      ? {
          id: requestContext.groveId,
          name: grove?.name ?? requestContext.groveId,
          slug: grove?.slug ?? manifest?.grove?.slug ?? requestContext.groveId,
          mode: grove?.mode ?? manifest?.grove?.mode ?? 'local',
        }
      : null,
    project: {
      id: requestContext?.projectId ?? manifest?.project.id ?? projectRoot,
      name: manifest?.project.name ?? path.basename(projectRoot),
      root: projectRoot,
    },
  };
}
