/**
 * Myco daemon — SQLite capture engine.
 *
 * All data goes to a local SQLite database (better-sqlite3). The intelligence
 * pipeline (extraction, embedding, consolidation, digest) is removed — it
 * moves to Phase 2 Agent SDK. What remains is the capture layer: session
 * lifecycle, prompt batch tracking, activity recording, and transcript mining.
 */

import { DaemonServer } from './server.js';
import type { RouteRequest } from './router.js';
import { SessionRegistry } from './lifecycle.js';
import { DaemonLogger } from './logger.js';
import { loadMergedConfig } from '../config/loader.js';
import { TranscriptMiner } from '../capture/transcript-miner.js';
import { createPerProjectAdapter } from '../symbionts/adapter.js';
import { claudeCodeAdapter } from '../symbionts/claude-code.js';
import { findPackageRoot } from '../utils/find-package-root.js';
import { resolveVaultDir, resolveProjectRoot } from '../vault/resolve.js';
import { EventBuffer } from '../capture/buffer.js';
import { loadManifests } from '../symbionts/detect.js';
import type { PlanWatchConfig } from './plan-capture.js';
import {
  handleGetConfig,
  handleGetMergedConfig,
  handleGetLocalConfig,
  handlePutScopedConfig,
  createPlanDirHandlers,
} from './api/config.js';
import { handleLogSearch, handleLogStream, handleLogDetail, createLogIngestionHandler } from './api/log-explorer.js';
import { handleRestart } from './api/restart.js';
import { createUpdateHandlers } from './api/update.js';
import { reconcileConfiguredSymbionts } from '../symbionts/reconcile.js';
import { resolveGlobalPrefix, detectDevBuild, setDevBuildCliEntry } from './update-checker.js';
import { getMachineId } from './machine-id.js';
import { createBackupHandlers, createBackupConfigHandlers } from './api/backup.js';
import { createTeamHandlers } from './api/team-connect.js';
import { createCollectiveHandlers } from './api/collective.js';
import { createSessionLifecycleHandlers } from './api/session-lifecycle.js';
import {
  handleListCandidates,
  handleGetCandidate,
  handleUpdateCandidate,
  handleListSkillRecords,
  handleGetSkillRecord,
  handleDeleteCandidate,
  createSkillRecordDeleteHandler,
} from './api/skills.js';
import { initTeamContext } from './team-context.js';
import { initTeamSync } from './team-sync-init.js';
import { ProgressTracker, handleGetProgress } from './api/progress.js';
import { handleGetModels } from './api/models.js';
import { computeConfigHash, createLiveStatsHandler } from './api/stats.js';
import { createListGroveProjectsHandler, createListGrovesHandler } from './api/groves.js';
import {
  handleListSessions,
  createGetSessionHandler,
  handleGetSessionBatches,
  handleGetBatchActivities,
  handleGetSessionAttachments,
  handleGetSessionPlans,
  createSessionMutationHandlers,
} from './api/sessions.js';
import {
  handleListSpores,
  createGetSporeHandler,
  handleListEntities,
  handleGetGraphSeeds,
  handleGetGraph,
  handleGetFullGraph,
  handleGetDigest,
} from './api/mycelium.js';
import { createSearchHandler } from './api/search.js';
import { createSessionContextHandler, createPromptContextHandler, createResumeContextHandler } from './api/context.js';
import { createCortexHandlers } from './api/cortex.js';
import { createCanopyInjectHandler } from './api/canopy-inject.js';
import { handleGetFeed } from './api/feed.js';
import { handleListSymbionts } from './api/symbionts.js';
import { registerCanopyReadRoutes } from './api/canopy-read.js';
import {
  handleGetEmbeddingStatus,
  handleEmbeddingDetails,
  handleEmbeddingRebuild,
  handleEmbeddingReconcile,
  handleEmbeddingCleanOrphans,
  handleEmbeddingReembedStale,
} from './api/embedding.js';
import {
  handleDatabaseDetails,
  handleDatabaseOptimize,
  handleDatabaseVacuum,
  handleDatabaseReindex,
  handleDatabaseIntegrityCheck,
} from './api/database.js';
import { EmbeddingManager, SqliteVecVectorStore, EmbeddingProviderAdapter, SqliteRecordSource } from './embedding/index.js';
import { DatabaseMaintenanceManager } from './database/manager.js';
import { registerBuiltinDomains } from '../notifications/domains.js';
import {
  handleListNotifications,
  handleCreateNotification,
  handleUpdateNotification,
  handleDismissAll,
  handleMarkAllRead,
  handleGetRegistry,
  handleUnreadCount,
} from './api/notifications.js';
import { createEmbeddingProvider } from '../intelligence/llm.js';
import {
  handleListTasks,
  handleGetTask,
  handleGetTaskYaml,
  handleUpdateTask,
  handleCreateTask,
  handleCopyTask,
  handleDeleteTask,
  handleGetTaskConfig,
  handleUpdateTaskConfig,
} from './api/agent-tasks.js';
import { handleGetProviders, handleTestProvider } from './api/providers.js';
import {
  handleDeleteProviderSecret,
  handleGetProviderSecrets,
  handlePutProviderSecret,
} from './api/provider-secrets.js';
import { registerScheduledTasks } from './task-scheduling.js';
import { initDatabase, closeDatabase, getDatabase, openDatabase, type Database } from '../db/client.js';
import { createSchema } from '../db/schema.js';
import { insertLogEntry, getMaxTimestamp } from '../db/queries/logs.js';
import { createStreamableMcpHttpHandler } from '../mcp/http.js';
import { createAgentRunHandlers } from './api/agent-runs.js';
import { createDigestRevisionHandlers } from './api/digest-revisions.js';
import { createAttachmentHandler } from './api/attachments.js';
import { reconcileLogBuffer } from './log-reconcile.js';
import { markRunningRunsInterrupted } from '../db/queries/runs.js';
import {
  POWER_IDLE_THRESHOLD_MS,
  POWER_SLEEP_THRESHOLD_MS,
  POWER_DEEP_SLEEP_THRESHOLD_MS,
  POWER_ACTIVE_INTERVAL_MS,
  POWER_SLEEP_INTERVAL_MS,
  RESTART_RESPONSE_FLUSH_MS,
  epochSeconds,
} from '../constants.js';
import { RESTART_REASON_FILENAME } from '../constants/update.js';
import { buildScopedConfigSaveNotification } from '../config/focus.js';
import { notify } from '../notifications/notify.js';
import { PowerManager } from './power.js';
import { InflightRunRegistry } from './inflight-runs.js';
import { registerPowerJobs } from './power-jobs.js';
import {
  handleUserPrompt, handleToolUse, handleStopBatches, handleToolFailure,
  handleSubagentStart, handleSubagentStop, handleStopFailure,
  handleTaskCompleted, handleCompact,
} from './event-handlers.js';
import { createReconciler } from './reconciliation.js';
import { runPendingMigrationTasks } from './migration-tasks.js';
import { createStopProcessor } from './stop-processing.js';
import { createEventDispatcher } from './event-dispatch.js';
import { createConfigReactionRegistry, computeTouchedPaths, loadReactionContext } from './config-reactions/index.js';
import { createPlanWatchReaction } from './plan-watch-reaction.js';
import { resolveDaemonDataPaths } from './data-paths.js';
import { GROVE_VECTORS_FILENAME, resolveGroveVectorsPath } from '../grove/paths.js';
import { rowProjectIdFromRequestContext, type MycoRequestContext } from '../tools/request-context.js';
import {
  daemonStateMtimeMs,
  readDaemonState,
  removeDaemonState,
  resolveDaemonServiceState,
  type DaemonServiceState,
} from './service-state.js';
export {
  handleUserPrompt, handleToolUse, handleStopBatches, handleToolFailure,
  handleSubagentStart, handleSubagentStop, handleStopFailure,
  handleTaskCompleted, handleCompact,
} from './event-handlers.js';
import { loadSecrets } from '../config/secrets.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import {
  DAEMON_HEALTH_CHECK_TIMEOUT_MS,
  DAEMON_STALE_GRACE_PERIOD_MS,
} from '../constants.js';
import { getPluginVersion } from '../version.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Sibling probe
// ---------------------------------------------------------------------------

/**
 * True when `127.0.0.1:<port>/health` responds with a myco daemon heartbeat.
 * Used during startup to distinguish a concurrent sibling (step-aside
 * candidate) from an unrelated port squatter.
 */
export async function isHealthyMycoSibling(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data = await res.json() as { myco?: boolean };
    return data.myco === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stale daemon cleanup
// ---------------------------------------------------------------------------

/**
 * Reconcile with any existing daemon for this vault before starting a new one.
 *
 * - If no daemon.json or the recorded pid is dead → 'ok' (take over).
 * - If the recorded daemon is recent, healthy, and running the same plugin
 *   version → 'step-aside' (a sibling just started; don't kill it). The caller
 *   exits cleanly. This is what stops the concurrent-spawn cascade where each
 *   new process SIGTERMs the last one standing.
 * - Otherwise (stale, unhealthy, or version-mismatch) → SIGTERM the old
 *   daemon, unlink daemon.json, return 'ok' to proceed.
 */
export async function reconcileExistingDaemon(
  daemonService: DaemonServiceState,
  logger: DaemonLogger,
): Promise<'ok' | 'step-aside'> {
  const daemonJsonPath = daemonService.statePath;
  let info: { pid?: number; port?: number; command?: string | null };
  let mtimeMs: number;
  try {
    const current = readDaemonState(daemonJsonPath);
    if (!current) return 'ok';
    mtimeMs = daemonStateMtimeMs(daemonJsonPath) ?? 0;
    info = current;
  } catch {
    // Unreadable daemon state — treat as absent.
    return 'ok';
  }

  if (!info.pid) return 'ok';
  if (info.pid === process.pid) return 'ok';

  // Is the recorded process actually alive?
  try {
    process.kill(info.pid, 0);
  } catch {
    // Dead — clean up and take over.
    removeDaemonState(daemonJsonPath);
    return 'ok';
  }

  // Alive. If it's recent AND healthy AND the same version AND on the
  // canonical port, step aside rather than racing it. Without this guard,
  // two concurrent spawns kill each other in sequence and the surviving PID
  // is whichever one ran last.
  //
  // The canonical-port check is load-bearing: if the sibling fell back to
  // `canonical+1` because an orphan was squatting the canonical port, we
  // must NOT step aside — we need to proceed through eviction, kill the
  // orphan, and bind the canonical port ourselves.
  const recent = Date.now() - mtimeMs < DAEMON_STALE_GRACE_PERIOD_MS;
  const canonicalPort = daemonService.canonicalPort;
  if (recent && typeof info.port === 'number' && info.port === canonicalPort) {
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
        signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = await res.json() as { myco?: boolean; version?: string };
        const existingCommand = info.command ?? null;
        // Use process.execPath, not process.argv[1]: under the bun-compiled
        // standalone, argv[1] is a virtual /$bunfs/... path that never
        // matches what daemon.json stores (the on-disk binary path).
        const currentCommand = process.execPath ?? null;
        const runtimeMismatch = Boolean(existingCommand && currentCommand && existingCommand !== currentCommand);
        if (data.myco && (data.version === getPluginVersion() || runtimeMismatch)) {
          logger.info(LOG_KINDS.DAEMON_START, 'Sibling daemon already healthy — stepping aside', {
            existing_pid: info.pid,
            existing_port: info.port,
            existing_command: existingCommand,
            current_command: currentCommand,
            runtime_mismatch: runtimeMismatch,
          });
          return 'step-aside';
        }
      }
    } catch { /* health probe failed — fall through and replace */ }
  }

  // Stale, unhealthy, or version mismatch: take over.
  try {
    process.kill(info.pid, 'SIGTERM');
    logger.info(LOG_KINDS.DAEMON_START, 'Killed stale daemon', { pid: info.pid });
  } catch { /* already dead */ }
  removeDaemonState(daemonJsonPath);
  return 'ok';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  // The vault always lives at `<projectRoot>/.myco/`. The daemon spawns
  // with cwd = projectRoot; resolveVaultDir walks up (worktree-aware) to
  // find the enclosing `.myco/`. There is no escape hatch — vaults are
  // project-local.
  const vaultDir = resolveVaultDir();

  // Load API keys from secrets.env into process.env before any provider init
  loadSecrets(vaultDir);

  // Merged = project (myco.yaml) + personal overlay (local.yaml). Any gate
  // downstream of this needs to see personal overrides, so the daemon loads
  // the merged view and never the raw project config.
  const config = loadMergedConfig(vaultDir);
  // Mutable holder that reactions update after each scoped-config write, so
  // runtime gates (scheduled-task registration, event triggers) observe the
  // flipped value without a daemon restart.
  const liveConfig: { current: typeof config } = { current: config };

  const manifests = loadManifests();
  const symbiontPlanDirs = manifests.flatMap((m) => m.capture?.planDirs ?? []);
  const symbiontPlanTags = [...new Set(manifests.flatMap((m) => m.capture?.planTags ?? []))];
  const projectRoot = resolveProjectRoot(vaultDir);
  const planWatchConfig: PlanWatchConfig = {
    watchDirs: [...new Set([...symbiontPlanDirs, ...(config.capture.plan_dirs ?? [])])],
    projectRoot,
    extensions: config.capture.artifact_extensions,
  };

  const logger = new DaemonLogger(path.join(vaultDir, 'logs'), {
    level: config.daemon.log_level,
  });

  // When debug logging is on, surface per-turn tool_use / tool_result detail
  // from the agent executor. The executor reads this env var directly because
  // it has no logger handle. Used to diagnose turn-budget exhaustion (e.g.
  // local-model rejection loops in skill-generate).
  if (config.daemon.log_level === 'debug') {
    process.env.MYCO_AGENT_DEBUG = '1';
  }

  // --- Machine identity ---
  const machineId = getMachineId(vaultDir);
  logger.info(LOG_KINDS.DAEMON_START, 'Machine ID resolved', { machine_id: machineId });
  const dataPaths = resolveDaemonDataPaths(vaultDir, {
    ...process.env,
    MYCO_MACHINE_ID: machineId,
  });
  const daemonService = resolveDaemonServiceState(vaultDir, {
    requestContext: dataPaths.requestContext,
    env: process.env,
  });

  // Reconcile with any existing daemon for the resolved service. Grove-bound
  // projects use the per-user global daemon state; legacy projects keep the
  // historical project-local state file.
  const reconcileResult = await reconcileExistingDaemon(daemonService, logger);
  if (reconcileResult === 'step-aside') {
    process.exit(0);
  }

  logger.info(LOG_KINDS.DAEMON_CONFIG, 'Config loaded', {
    vault: vaultDir,
    daemon_scope: daemonService.scope,
    daemon_state: daemonService.statePath,
    embedding_provider: config.embedding.provider,
  });
  logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan watch directories', { dirs: planWatchConfig.watchDirs });
  if (symbiontPlanTags.length > 0) {
    logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan transcript tags', { tags: symbiontPlanTags });
  }

  // --- Resolve npm global prefix + detect dev build ---
  // globalPrefix is used both for installed-version detection (in the status
  // handler) and for dev-build auto-detection via detectDevBuild().
  let globalPrefix: string | null = null;
  try {
    globalPrefix = resolveGlobalPrefix();
    logger.debug(LOG_KINDS.DAEMON_START, 'npm global prefix resolved', { prefix: globalPrefix });
  } catch (err) {
    logger.warn(LOG_KINDS.DAEMON_START, 'Failed to resolve npm global prefix', {
      error: (err as Error).message,
    });
  }

  // Auto-detect dev builds: if the running binary isn't under the global
  // prefix, record the CLI entry via setDevBuildCliEntry() so update checks
  // are exempted and any restart/update shell script uses the dev binary
  // as its restart target (baked in at script-generation time — no env var
  // propagation required).
  //
  // Use process.execPath, not process.argv[1]: under the bun-compiled
  // standalone binary, argv[1] is a virtual /$bunfs/... path (the embedded
  // entry script), not the on-disk binary path. realpath() throws on it,
  // detectDevBuild silently returns null, and dogfood/symlink installs
  // stop being recognised — re-introducing the "Update available" banner
  // on every dev daemon. process.execPath always points at the real
  // standalone binary on disk regardless of compile mode.
  const devCliEntry = detectDevBuild(
    globalPrefix,
    process.execPath,
    fs.realpathSync,
  );
  if (devCliEntry) {
    setDevBuildCliEntry(devCliEntry);
    globalPrefix = null;
    logger.info(LOG_KINDS.DAEMON_START, 'Dev build detected; update checks exempted', {
      cli_entry: devCliEntry,
    });
  }

  // --- SQLite initialization ---
  const db = initDatabase(dataPaths.databasePath);
  createSchema(db, machineId);
  registerBuiltinDomains();
  const interruptedRuns = markRunningRunsInterrupted('Daemon restarted before the run completed');
  if (interruptedRuns > 0) {
    logger.warn(LOG_KINDS.AGENT_RUN, 'Marked stale running runs as resumable after daemon restart', {
      count: interruptedRuns,
    });
  }

  logger.info(LOG_KINDS.DAEMON_START, 'SQLite initialized', {
    vault: vaultDir,
    database_path: dataPaths.databasePath,
    grove_id: dataPaths.requestContext.groveId,
  });

  // --- Check for restart-reason signal file (left by version sync restart script) ---
  {
    const reasonPath = path.join(vaultDir, RESTART_REASON_FILENAME);
    try {
      if (fs.existsSync(reasonPath)) {
        const raw = JSON.parse(fs.readFileSync(reasonPath, 'utf-8')) as {
          reason?: string;
          from_version?: string;
          to_version?: string;
          local_update_ran?: boolean;
        };
        fs.unlinkSync(reasonPath);

        if (raw.reason === 'version_sync' && raw.to_version) {
          const message = raw.local_update_ran
            ? 'Restarted and updated local project hooks.'
            : 'Restarted to pick up the latest version.';

          notify(vaultDir, {
            domain: 'daemon',
            type: 'daemon.version_sync',
            title: `Updated to v${raw.to_version}`,
            message,
            metadata: {
              from_version: raw.from_version ?? 'unknown',
              to_version: raw.to_version,
              local_update_ran: raw.local_update_ran ?? false,
            },
          });

          logger.info(LOG_KINDS.DAEMON_START, 'Version sync restart detected', {
            from: raw.from_version,
            to: raw.to_version,
            local_update: raw.local_update_ran,
          });
        }
      }
    } catch (err) {
      logger.warn(LOG_KINDS.DAEMON_START, 'Failed to read restart-reason file', {
        error: (err as Error).message,
      });
    }
  }

  // --- Team context ---
  initTeamContext(config.team.enabled, machineId);

  // Wire logger to SQLite persistence. Every log row is scoped to the
  // daemon's resolved Grove project id — there is no NULL fallback.
  const daemonProjectId = dataPaths.requestContext.projectId;
  logger.setPersistFn((entry) => {
    const { timestamp, level, kind, component, message, ...rest } = entry;
    insertLogEntry({
      timestamp,
      level,
      kind,
      component,
      message,
      data: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null,
      session_id: (rest.session_id as string) ?? null,
      project_id: daemonProjectId,
    });
  });

  // Reconcile log entries missed while daemon was down
  const lastLogTimestamp = getMaxTimestamp();
  if (lastLogTimestamp) {
    const logDir = path.join(vaultDir, 'logs');
    const replayedCount = reconcileLogBuffer(logDir, lastLogTimestamp, daemonProjectId);
    if (replayedCount > 0) {
      logger.info(LOG_KINDS.DAEMON_RECONCILE, `Replayed ${replayedCount} log entries from buffer`, { replayed: replayedCount });
    }
  }

  // --- Embedding lifecycle manager ---
  const vectorsDbPath = dataPaths.vectorsPath;
  const vectorStore = new SqliteVecVectorStore(vectorsDbPath);
  const llmProvider = createEmbeddingProvider(config.embedding);
  const embeddingProvider = new EmbeddingProviderAdapter(llmProvider, config.embedding);
  const recordSource = new SqliteRecordSource();
  const embeddingManager = new EmbeddingManager(vectorStore, embeddingProvider, recordSource, logger);
  logger.info(LOG_KINDS.EMBEDDING_EMBED, 'EmbeddingManager initialized', { vectors_db: vectorsDbPath });
  const databaseManager = new DatabaseMaintenanceManager(dataPaths.databasePath, vaultDir, logger);
  const scopedEmbeddingManagers = new Map<string, {
    manager: EmbeddingManager;
    db: Database;
    vectorStore: SqliteVecVectorStore;
  }>();
  const getEmbeddingRuntime = (requestContext?: MycoRequestContext): { manager: EmbeddingManager; db?: Database } => {
    if (!requestContext) return { manager: embeddingManager };
    const scopedVectorsPath = requestContext.groveId
      ? resolveGroveVectorsPath(requestContext.groveId)
      : path.join(requestContext.projectVaultDir, GROVE_VECTORS_FILENAME);
    if (requestContext.databasePath === dataPaths.databasePath && scopedVectorsPath === dataPaths.vectorsPath) {
      return { manager: embeddingManager };
    }
    const key = `${requestContext.databasePath}\n${scopedVectorsPath}`;
    const cached = scopedEmbeddingManagers.get(key);
    if (cached) return { manager: cached.manager, db: cached.db };

    const scopedDb = openDatabase(requestContext.databasePath);
    const scopedVectorStore = new SqliteVecVectorStore(scopedVectorsPath);
    const scopedManager = new EmbeddingManager(
      scopedVectorStore,
      embeddingProvider,
      new SqliteRecordSource(scopedDb),
      logger,
    );
    scopedEmbeddingManagers.set(key, {
      manager: scopedManager,
      db: scopedDb,
      vectorStore: scopedVectorStore,
    });
    return { manager: scopedManager, db: scopedDb };
  };

  // --- Register built-in agents and tasks ---
  let definitionsDir: string | undefined;
  try {
    const { registerBuiltInAgentsAndTasks, resolveDefinitionsDir } = await import('../agent/loader.js');
    definitionsDir = resolveDefinitionsDir();
    await registerBuiltInAgentsAndTasks(definitionsDir, vaultDir);
    logger.info(LOG_KINDS.AGENT_TASK, 'Built-in agents and tasks registered');
  } catch (err) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Failed to register built-in agents/tasks', { error: (err as Error).message });
  }

  // Clean up stale "running" agent runs from previous daemon — they'll never complete
  try {
    const staleDb = getDatabase();
    // SQLite doesn't support RETURNING — query first, then update
    const staleRows = staleDb.prepare(
      `SELECT id, task FROM agent_runs WHERE status = 'running'`,
    ).all() as Array<{ id: string; task: string | null }>;

    if (staleRows.length > 0) {
      const completedAt = epochSeconds();
      staleDb.prepare(
        `UPDATE agent_runs SET status = 'failed', completed_at = ?, error = 'Daemon restarted while run was in progress' WHERE status = 'running'`,
      ).run(completedAt);
      for (const row of staleRows) {
        notify(vaultDir, {
          domain: 'agents',
          type: 'agent.task.failure',
          title: `Task failed: ${row.task ?? 'agent run'}`,
          message: 'Daemon restarted while run was in progress',
          link: `/agent?run=${row.id}`,
          metadata: { taskName: row.task, runId: row.id, reason: 'daemon_restart' },
        }, liveConfig.current);
      }
      logger.info(LOG_KINDS.AGENT_RUN, 'Cleaned stale running agent runs', {
        count: staleRows.length,
        ids: staleRows.map((r) => r.id),
      });
    }
  } catch (err) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Failed to clean stale runs', { error: (err as Error).message });
  }

  // Resolve dist/ui/ from the package root. Two candidate origins:
  //   1. `import.meta.url` — works under dev mode (tsx/bun run) and the
  //      old tsup build where each JS lives under the package root.
  //   2. `process.execPath` — needed in the Bun-compiled binary because
  //      `import.meta.url` there is a `/$bunfs/` virtual path that
  //      findPackageRoot can't walk. The binary sits at
  //      `<pkg-root>/vendor/<target>/myco`, so walking up from its real
  //      path lands on the package root where `dist/ui/` lives.
  let uiDir: string | null = null;
  const uiDevProxyTarget = process.env.MYCO_UI_DEV_PROXY_TARGET || null;
  {
    const origins: string[] = [];
    try {
      origins.push(path.dirname(new URL(import.meta.url).pathname));
    } catch { /* bunfs URL — fall through to execPath */ }
    try {
      origins.push(path.dirname(fs.realpathSync(process.execPath)));
    } catch { /* no real path — ignore */ }

    for (const origin of origins) {
      const root = findPackageRoot(origin);
      if (!root) continue;
      const candidate = path.join(root, 'dist', 'ui');
      if (fs.existsSync(candidate)) { uiDir = candidate; break; }
    }
  }
  if (uiDevProxyTarget) {
    logger.info(LOG_KINDS.DAEMON_START, 'UI dev proxy enabled', { target: uiDevProxyTarget });
  }
  if (uiDir) {
    logger.debug(LOG_KINDS.DAEMON_START, 'Static UI directory found', { path: uiDir });
  }

  const powerManager = new PowerManager({
    idleThresholdMs: POWER_IDLE_THRESHOLD_MS,
    sleepThresholdMs: POWER_SLEEP_THRESHOLD_MS,
    deepSleepThresholdMs: POWER_DEEP_SLEEP_THRESHOLD_MS,
    activeIntervalMs: POWER_ACTIVE_INTERVAL_MS,
    sleepIntervalMs: POWER_SLEEP_INTERVAL_MS,
    logger,
  });

  // Tracks fire-and-forget Cortex runs so daemon shutdown can await them
  // before exiting. Without this, SIGTERM orphans in-flight runs — leaving
  // non-terminal agent_runs rows and costing real money on reasoning-heavy
  // providers.
  const inflightRuns = new InflightRunRegistry();

  const server = new DaemonServer({
    vaultDir,
    logger,
    daemonStatePath: daemonService.statePath,
    uiDir: uiDir ?? undefined,
    uiDevProxyTarget: uiDevProxyTarget ?? undefined,
    // Don't record activity on every HTTP request — UI polling (every 3-10s)
    // would prevent the PowerManager from ever reaching 'idle' state, blocking
    // all idle-only scheduled tasks (skill-survey, skill-generate, skill-evolve).
    // Activity is recorded on meaningful events below (session register, prompt capture, etc.).
  });

  // The daemon serves the dashboard UI and must stay running regardless of
  // active sessions. No auto-shutdown — runs until explicitly killed.
  const registry = new SessionRegistry({
    gracePeriod: 0,
    onEmpty: () => {},
  });

  const transcriptMiner = new TranscriptMiner({
    additionalAdapters: config.capture.transcript_paths.map((p) =>
      createPerProjectAdapter(p, claudeCodeAdapter.parseTurns),
    ),
  });

  const bufferDir = path.join(vaultDir, 'buffer');
  const sessionBuffers = new Map<string, EventBuffer>();

  const reconciler = createReconciler({ bufferDir, logger, projectRoot });
  reconciler.runStartupReconciliation();

  // Runtime migration tasks (vector reindex, file rewrites, etc.) — idempotent,
  // gated by the migration_tasks ledger in the DB so each task runs once per
  // vault regardless of how many times the daemon starts.
  await runPendingMigrationTasks({ db: getDatabase(), embeddingManager, logger });

  // --- Stop processor (created early so triggerTitleSummary is available to /events route) ---
  const stopProcessor = createStopProcessor({
    registry,
    sessionBuffers,
    transcriptMiner,
    embeddingManager,
    logger,
    liveConfig,
    vaultDir,
    projectId: dataPaths.requestContext.projectId,
    planTags: symbiontPlanTags,
    planWatchConfig,
  });

  // --- Session routes ---
  // The deps object is mutated after registerPowerJobs so the canopy delta
  // runner becomes visible to SessionStart triggers.
  const sessionLifecycleDeps = {
    registry, sessionBuffers, reconciler, stopProcessor,
    server, powerManager, machineId, logger, liveConfig, vaultDir,
  };
  const sessionLifecycle = createSessionLifecycleHandlers(sessionLifecycleDeps);
  server.registerRoute('POST', '/sessions/register', sessionLifecycle.handleRegister);
  server.registerRoute('POST', '/sessions/unregister', sessionLifecycle.handleUnregister);

  // --- Event routes ---

  const eventDispatcher = createEventDispatcher({
    registry,
    sessionBuffers,
    powerManager,
    logger,
    machineId,
    liveConfig,
    vaultDir,
    reconcileSession: reconciler.reconcileSession,
    planWatchConfig,
    triggerTitleSummary: stopProcessor.triggerTitleSummary,
  });
  server.registerRoute('POST', '/events', eventDispatcher);

  // --- Stop route ---

  server.registerRoute('POST', '/events/stop', stopProcessor.handleStopRoute);

  // --- Context injection (cortex brief + semantic spore search) ---
  let teamSync!: ReturnType<typeof initTeamSync>;
  const contextDeps = {
    vaultDir,
    embeddingManager,
    liveConfig,
    logger,
    getTeamClient: () => teamSync.getTeamClient(),
  };
  server.registerRoute('POST', '/context', createSessionContextHandler(contextDeps));
  server.registerRoute('POST', '/context/resume', createResumeContextHandler(contextDeps));
  server.registerRoute('POST', '/context/prompt', createPromptContextHandler(contextDeps));

  // --- Canopy injection (PreToolUse/Read hook-bridge endpoint) ---
  server.registerRoute('POST', '/canopy/inject', createCanopyInjectHandler({
    liveConfig,
    vaultDir,
    getDatabase,
  }));

  // --- Dashboard API routes ---
  const progressTracker = new ProgressTracker();
  let configHash = computeConfigHash(vaultDir);
  const cortexHandlers = createCortexHandlers(vaultDir, {
    liveConfig,
    embeddingManager,
    logger,
    getTeamClient: () => teamSync.getTeamClient(),
    registerInflightRun: (p) => inflightRuns.register(p),
  });

  server.registerRoute('GET', '/api/config', async () => handleGetConfig(vaultDir));
  server.registerRoute('GET', '/api/symbionts', async () => handleListSymbionts(vaultDir));
  server.registerRoute('GET', '/api/cortex/instructions', cortexHandlers.handleGetInstructions);
  server.registerRoute('POST', '/api/cortex/instructions/refresh', cortexHandlers.handleRefreshInstructions);
  server.registerRoute('POST', '/api/cortex/prompt-builder', cortexHandlers.handleBuildPrompt);
  server.registerRoute('GET', '/api/cortex/prompt-builder/:runId', cortexHandlers.handleGetPromptResult);

  server.registerRoute('GET', '/api/config/merged', async () => handleGetMergedConfig(vaultDir));
  server.registerRoute('GET', '/api/config/local', async () => handleGetLocalConfig(vaultDir));

  // Pre-compute symbiont plan dirs for the config endpoint (manifests don't change at runtime)
  const symbiontPlanDirsByAgent: Record<string, string[]> = {};
  for (const m of manifests) {
    const dirs = m.capture?.planDirs ?? [];
    if (dirs.length > 0) symbiontPlanDirsByAgent[m.displayName] = dirs;
  }

  // --- Config-change reaction registry ---
  // Reactions register once at daemon startup. `fire(touchedPaths, ctx)` runs
  // every matching reaction after a successful scoped-config write, passing
  // the freshly merged config so reactions don't reload it themselves. See
  // packages/myco/src/daemon/config-reactions/registry.ts for the contract.
  const reactions = createConfigReactionRegistry(logger);

  // Refresh the live-stats configHash on every write.
  reactions.on([], () => { configHash = computeConfigHash(vaultDir); });

  // Keep liveConfig pointed at the latest merged config so runtime gates
  // (agent.scheduled_tasks_enabled, agent.event_tasks_enabled) pick up
  // toggle flips immediately.
  reactions.on([], (ctx) => { liveConfig.current = ctx; });

  // Reinstall symbiont artefacts (agent hooks, .gitignore) when capture dirs
  // or symbiont enablement change. The reconcile has no other config inputs.
  reactions.on(['capture', 'symbionts'], (ctx) => {
    reconcileConfiguredSymbionts(resolveProjectRoot(vaultDir), vaultDir, ctx);
  });

  // Refresh the in-memory plan-watch list on capture changes.
  reactions.on(['capture'], createPlanWatchReaction({
    symbiontPlanDirs,
    planWatchConfig,
  }));

  // Live-reconfigure the logger on daemon.log_level change.
  reactions.on(['daemon.log_level'], (ctx) => {
    logger.setLevel(ctx.daemon.log_level);
    if (ctx.daemon.log_level === 'debug') {
      process.env.MYCO_AGENT_DEBUG = '1';
    } else {
      delete process.env.MYCO_AGENT_DEBUG;
    }
  });

  let scheduledTaskKicker: { kick: (taskName: string) => void } = { kick: () => {} };

  async function syncScheduledTasks() {
    scheduledTaskKicker = await registerScheduledTasks(powerManager, {
      definitionsDir,
      vaultDir,
      embeddingManager,
      logger,
      liveConfig,
      getTeamClient: () => teamSync.getTeamClient(),
    });
  }

  reactions.on(['agent.tasks'], async () => {
    await syncScheduledTasks();
  });

  async function applyConfigWriteReactions(touchedPaths: string[]) {
    const reactionContext = loadReactionContext(vaultDir, logger);
    if (!reactionContext) {
      configHash = computeConfigHash(vaultDir);
      return null;
    }
    await reactions.fire(touchedPaths, reactionContext);
    return reactionContext;
  }

  server.registerRoute('PUT', '/api/config/scoped', async (req) => {
    const result = await handlePutScopedConfig(vaultDir, req.body);
    if (!result.status || result.status < 400) {
      const body = req.body as { scope: 'project' | 'local'; patch?: unknown; clear?: string[] };
      const touchedPaths = computeTouchedPaths(body.patch, body.clear);
      const reactionContext = await applyConfigWriteReactions(touchedPaths);
      if (reactionContext) {
        const summary = buildScopedConfigSaveNotification(body.scope, touchedPaths);
        notify(vaultDir, {
          domain: 'settings',
          type: 'settings.saved',
          title: summary.title,
          message: summary.message,
          link: summary.link ?? undefined,
          metadata: summary.metadata,
        }, reactionContext);
      } else {
        configHash = computeConfigHash(vaultDir);
      }
    }
    return result;
  });

  const planDirHandlers = createPlanDirHandlers({
    symbiontPlanDirsByAgent,
  });
  server.registerRoute('GET', '/api/config/plan-dirs', planDirHandlers.handleGetPlanDirs);

  // V2 stats — vault counts, embedding coverage, agent status, digest freshness
  const configHashRef = { get: () => configHash };
  server.registerRoute('GET', '/api/stats', createLiveStatsHandler({
    vaultDir,
    registry,
    server,
    configHash: configHashRef,
  }));
  // Single-Grove mode: this daemon was launched against a specific
  // project context (dev daemon, dogfood). Advertise only the bound
  // Grove so the project switcher and `/groves` list don't surface
  // Groves served by a different daemon. When the daemon is launched
  // without a Grove pin (future production LaunchAgent path), the
  // `groveId` is null and the API returns the full registry.
  const groveScope = {
    groveIds: dataPaths.requestContext.groveId ? [dataPaths.requestContext.groveId] : null,
  };
  server.registerRoute('GET', '/api/groves', createListGrovesHandler(groveScope));
  server.registerRoute('GET', '/api/groves/:id/projects', createListGroveProjectsHandler(groveScope));

  server.registerRoute('GET', '/api/logs', handleLogStream);
  server.registerRoute('GET', '/api/logs/search', handleLogSearch);
  server.registerRoute('GET', '/api/logs/stream', handleLogStream);
  server.registerRoute('GET', '/api/logs/:id', handleLogDetail);

  // External log ingestion: allows MCP server (separate process) to write through the daemon logger
  server.registerRoute('POST', '/api/log', createLogIngestionHandler(logger));

  server.registerRoute('GET', '/api/models', async (req) => handleGetModels(req, logger));
  server.registerRoute('POST', '/api/restart', async (req) => handleRestart({ vaultDir, progressTracker }, req.body));

  // --- Update routes ---
  const updateProjectRoot = resolveProjectRoot(vaultDir);
  const updateHandlers = createUpdateHandlers({
    vaultDir,
    projectRoot: updateProjectRoot,
    currentVersion: server.version,
    globalPrefix,
    scheduleShutdown: () => {
      setTimeout(() => {
        process.kill(process.pid, 'SIGTERM');
      }, RESTART_RESPONSE_FLUSH_MS);
    },
  });

  server.registerRoute('GET', '/api/update/status', async (req) => updateHandlers.handleUpdateStatus(req));
  server.registerRoute('POST', '/api/update/check', async (req) => updateHandlers.handleUpdateCheck(req));
  server.registerRoute('POST', '/api/update/apply', async (req) => updateHandlers.handleUpdateApply(req));
  server.registerRoute('PUT', '/api/update/channel', async (req) => updateHandlers.handleUpdateChannel(req));

  server.registerRoute('GET', '/api/progress/:token', async (req) => handleGetProgress(progressTracker, req.params.token));

  server.registerRoute('GET', '/api/sessions', handleListSessions);

  const teamFallbackDeps = { getTeamClient: () => teamSync.getTeamClient(), machineId };
  server.registerRoute('GET', '/api/sessions/:id', createGetSessionHandler(teamFallbackDeps));
  const sessionMutations = createSessionMutationHandlers({ embeddingManager, vaultDir, logger, liveConfig });
  server.registerRoute('GET', '/api/sessions/:id/impact', sessionMutations.handleGetSessionImpact);
  server.registerRoute('POST', '/api/sessions/:id/complete', sessionMutations.handleCompleteSession);
  server.registerRoute('DELETE', '/api/sessions/:id', sessionMutations.handleDeleteSession);
  server.registerRoute('DELETE', '/api/plans/:id', sessionMutations.handleDeletePlan);
  server.registerRoute('GET', '/api/sessions/:id/batches', handleGetSessionBatches);
  server.registerRoute('GET', '/api/batches/:id/activities', handleGetBatchActivities);
  server.registerRoute('GET', '/api/sessions/:id/attachments', handleGetSessionAttachments);
  server.registerRoute('GET', '/api/sessions/:id/plans', handleGetSessionPlans);

  // --- Canopy read-side API routes ---
  registerCanopyReadRoutes(server, {
    resolveProjectId: () => dataPaths.requestContext.projectId,
    resolveMachineId: () => getMachineId(vaultDir),
    runCanopyMapTask: async ({ task, params }) => {
      // Mirror the dispatch shape used by /api/agent/run (see
      // createAgentRunHandlers.handleRun): build the instruction, fire
      // runAgent, then look up the run id that runAgent inserted
      // synchronously before its first await. This matches how the
      // scheduler enqueues canopy-map and keeps a single source of truth
      // for instruction assembly.
      //
      // Use the *detailed* builder so we keep the skip reason: the
      // /api/agent/run dispatcher path collapses skips to undefined and
      // short-circuits via isInstructionRequiredTask, but this regenerate
      // route has no such guard — running the agent without instruction
      // or runContext makes the render phase succeed (default YAML prompt
      // + fs_read) and then finalizeCanopyMap crashes because
      // runContext.canopy_map_inputs_hash is unset.
      const { buildCanopyMapInstructionDetailed } = await import('../agent/instruction-builders.js');
      const { runAgent } = await import('../agent/executor.js');
      const { getLatestRunId } = await import('../db/queries/runs.js');
      const { DEFAULT_AGENT_ID } = await import('../constants.js');

      const mycoConfig = liveConfig.current;
      const projectRoot = dataPaths.requestContext.projectRoot;
      const requestContext = dataPaths.requestContext;
      const built = await buildCanopyMapInstructionDetailed(params, projectRoot, mycoConfig);

      if (built.kind === 'skip') {
        return { skipped: true, reason: built.reason };
      }

      const resultPromise = runAgent(vaultDir, {
        task,
        instruction: built.instruction,
        runContext: built.context,
        taskParams: params,
        agentId: DEFAULT_AGENT_ID,
        embeddingManager,
        requestContext,
        logger,
      });

      // runAgent inserts the agent_runs row synchronously before its first
      // await. Capture the id before letting the promise run unsupervised.
      const runId = getLatestRunId(DEFAULT_AGENT_ID, task);

      // Fire-and-forget — caller already has the run id; we don't block
      // the HTTP response on the LLM round-trip. Errors are logged so
      // they don't vanish.
      resultPromise.catch((err) => {
        logger.error(LOG_KINDS.AGENT_ERROR, 'canopy-map regenerate threw', {
          error: (err as Error).message ?? String(err),
        });
      });

      return { run_id: runId ?? '' };
    },
    runCanopyDescribeTask: async ({ task, params }) => {
      // Single-row canopy-describe dispatch — same shape as
      // runCanopyMapTask above. Map-phase source.args uses
      // params.canopy_entry_path to filter to that one entry.
      const { buildTaskInstruction } = await import('../agent/instruction-builders.js');
      const { runAgent } = await import('../agent/executor.js');
      const { getLatestRunId } = await import('../db/queries/runs.js');
      const { DEFAULT_AGENT_ID } = await import('../constants.js');

      const mycoConfig = liveConfig.current;
      const projectRoot = dataPaths.requestContext.projectRoot;
      const requestContext = dataPaths.requestContext;
      const built = await buildTaskInstruction(
        task,
        params,
        DEFAULT_AGENT_ID,
        projectRoot,
        embeddingManager,
        mycoConfig,
        () => teamSync.getTeamClient(),
        requestContext,
      );

      const resultPromise = runAgent(vaultDir, {
        task,
        instruction: built?.instruction,
        runContext: built?.context,
        taskParams: params,
        agentId: DEFAULT_AGENT_ID,
        embeddingManager,
        requestContext,
        logger,
      });

      const runId = getLatestRunId(DEFAULT_AGENT_ID, task);

      resultPromise.catch((err) => {
        logger.error(LOG_KINDS.AGENT_ERROR, 'canopy-describe redescribe threw', {
          error: (err as Error).message ?? String(err),
        });
      });

      return { run_id: runId ?? '' };
    },
  });

  // --- Skill lifecycle API routes ---
  server.registerRoute('GET', '/api/skill-candidates', handleListCandidates);
  server.registerRoute('GET', '/api/skill-candidates/:id', handleGetCandidate);
  server.registerRoute('PUT', '/api/skill-candidates/:id', handleUpdateCandidate);
  server.registerRoute('GET', '/api/skill-records', handleListSkillRecords);
  server.registerRoute('GET', '/api/skill-records/:id', handleGetSkillRecord);
  server.registerRoute('DELETE', '/api/skill-candidates/:id', handleDeleteCandidate);
  server.registerRoute('DELETE', '/api/skill-records/:id', createSkillRecordDeleteHandler({ vaultDir, logger }));

  // --- Mycelium API routes ---
  server.registerRoute('GET', '/api/spores', handleListSpores);
  server.registerRoute('GET', '/api/spores/:id', createGetSporeHandler(teamFallbackDeps));
  server.registerRoute('GET', '/api/entities', handleListEntities);
  server.registerRoute('GET', '/api/graph/seeds', handleGetGraphSeeds);
  server.registerRoute('GET', '/api/graph', handleGetFullGraph);
  server.registerRoute('GET', '/api/graph/:id', handleGetGraph);
  server.registerRoute('GET', '/api/digest', handleGetDigest);

  const attachments = createAttachmentHandler({ vaultDir });
  server.registerRoute('GET', '/api/attachments/:filename', attachments.handleGetAttachment);

  // --- Agent API routes ---
  const agentRunHandlers = createAgentRunHandlers({
    vaultDir,
    embeddingManager,
    logger,
    getTeamClient: () => teamSync.getTeamClient(),
  });
  server.registerRoute('POST', '/api/agent/run', agentRunHandlers.handleRun);
  server.registerRoute('GET', '/api/agent/runs', agentRunHandlers.handleListRuns);
  server.registerRoute('GET', '/api/agent/runs/:id', agentRunHandlers.handleGetRun);
  server.registerRoute('POST', '/api/agent/runs/:id/resume', agentRunHandlers.handleResumeRun);
  server.registerRoute('GET', '/api/agent/runs/:id/reports', agentRunHandlers.handleGetRunReports);
  server.registerRoute('GET', '/api/agent/runs/:id/turns', agentRunHandlers.handleGetRunTurns);
  server.registerRoute('GET', '/api/agent/runs/:id/write-intents', agentRunHandlers.handleGetRunWriteIntents);
  server.registerRoute('GET', '/api/agent/runs/:id/audit', agentRunHandlers.handleGetRunAudit);

  const digestRevisionHandlers = createDigestRevisionHandlers({ vaultDir, logger });
  server.registerRoute('GET', '/api/digest/revisions', digestRevisionHandlers.handleList);
  server.registerRoute('POST', '/api/digest/revisions/:id/restore', digestRevisionHandlers.handleRestore);

  server.registerRoute('GET', '/api/agent/tasks', async (req) => handleListTasks(req, vaultDir));
  server.registerRoute('GET', '/api/agent/tasks/:id', async (req) => handleGetTask(req, vaultDir));
  server.registerRoute('GET', '/api/agent/tasks/:id/yaml', async (req) => handleGetTaskYaml(req, vaultDir));
  server.registerRoute('PUT', '/api/agent/tasks/:id', async (req) => {
    const result = await handleUpdateTask(req, vaultDir);
    if (!result.status || result.status < 400) {
      await syncScheduledTasks();
    }
    return result;
  });
  server.registerRoute('POST', '/api/agent/tasks', async (req) => {
    const result = await handleCreateTask(req, vaultDir);
    if (!result.status || result.status < 400) {
      await syncScheduledTasks();
    }
    return result;
  });
  server.registerRoute('POST', '/api/agent/tasks/:id/copy', async (req) => {
    const result = await handleCopyTask(req, vaultDir);
    if (!result.status || result.status < 400) {
      await syncScheduledTasks();
    }
    return result;
  });
  server.registerRoute('DELETE', '/api/agent/tasks/:id', async (req) => {
    const result = await handleDeleteTask(req, vaultDir);
    if (!result.status || result.status < 400) {
      await syncScheduledTasks();
    }
    return result;
  });
  server.registerRoute('GET', '/api/agent/tasks/:id/config', async (req) => handleGetTaskConfig(req, vaultDir));
  server.registerRoute('PUT', '/api/agent/tasks/:id/config', async (req) => {
    const result = await handleUpdateTaskConfig(req, vaultDir);
    if (!result.status || result.status < 400) {
      await applyConfigWriteReactions([`agent.tasks.${req.params.id}`]);
    }
    return result;
  });

  // --- Provider detection & testing ---
  server.registerRoute('GET', '/api/providers', async () => handleGetProviders(logger));
  server.registerRoute('POST', '/api/providers/test', async (req) => handleTestProvider(req));
  server.registerRoute('GET', '/api/providers/secrets', async () => handleGetProviderSecrets(vaultDir));
  server.registerRoute('PUT', '/api/providers/secrets/:provider', async (req) => handlePutProviderSecret(vaultDir, req));
  server.registerRoute('DELETE', '/api/providers/secrets/:provider', async (req) => handleDeleteProviderSecret(vaultDir, req));

  // --- In-process MCP server (streamable HTTP) ---
  // Stdio agents are bridged to this endpoint by `myco-run mcp`; HTTP-native
  // agents (codex) connect to it directly. Tool execution happens in-process
  // via the shared tool runtime — no internal HTTP RPC layer.
  server.registerRawRoute('/mcp', createStreamableMcpHttpHandler(vaultDir));

  // --- Backup routes ---
  const backupHandlers = createBackupHandlers({ db, machineId, vaultDir, liveConfig });
  server.registerRoute('POST', '/api/backup', backupHandlers.handleCreateBackup);
  server.registerRoute('GET', '/api/backups', backupHandlers.handleListBackups);
  server.registerRoute('POST', '/api/restore/preview', backupHandlers.handleRestorePreview);
  server.registerRoute('POST', '/api/restore', backupHandlers.handleRestore);

  const backupConfigHandlers = createBackupConfigHandlers({ vaultDir });
  server.registerRoute('GET', '/api/backup/config', backupConfigHandlers.handleGetBackupConfig);
  server.registerRoute('PUT', '/api/backup/config', async (req) => {
    const result = await backupConfigHandlers.handlePutBackupConfig(req);
    if (!result.status || result.status < 400) {
      await applyConfigWriteReactions(['backup.dir']);
    }
    return result;
  });

  // --- Team sync ---
  teamSync = initTeamSync({
    liveConfig,
    machineId,
    logger,
    vaultDir,
    serverVersion: server.version,
    requestContext: dataPaths.requestContext,
  });
  reactions.on(['team'], async () => {
    await teamSync.reconcileClient();
  });
  await teamSync.reconcileClient();

  const teamHandlers = createTeamHandlers({
    vaultDir,
    machineId,
    logger,
    getTeamClient: (requestContext) => teamSync.getTeamClient(requestContext),
    setTeamClient: teamSync.setTeamClient,
    globalPrefix,
  });
  async function reconcileTeamRoute(req: RouteRequest): Promise<void> {
    await teamSync.reconcileClient(req.requestContext);
  }
  server.registerRoute('POST', '/api/team/connect', async (req) => {
    const result = await teamHandlers.handleConnect(req);
    if (!result.status || result.status < 400) {
      await applyConfigWriteReactions(['team.enabled', 'team.worker_url']);
      await teamSync.reconcileClient(req.requestContext);
    }
    return result;
  });
  server.registerRoute('POST', '/api/team/disconnect', async (req) => {
    const result = await teamHandlers.handleDisconnect(req);
    if (!result.status || result.status < 400) {
      await applyConfigWriteReactions(['team.enabled', 'team.worker_url']);
      await teamSync.reconcileClient(req.requestContext);
    }
    return result;
  });
  server.registerRoute('GET', '/api/team/status', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleStatus(req);
  });
  server.registerRoute('POST', '/api/team/backfill', async (req) => {
    const startedAt = Date.now();
    await reconcileTeamRoute(req);
    const result = await teamHandlers.handleBackfill(req);
    if (result.status && result.status >= 400) return result;
    const flush = await teamSync.flushPending(req.requestContext);
    const durationMs = Date.now() - startedAt;
    const resultBody = result.body as Record<string, unknown>;
    logger.info(LOG_KINDS.TEAM_SYNC_HANDOFF, 'Team sync handoff complete', {
      mode: typeof resultBody.mode === 'string' ? resultBody.mode : null,
      enqueued: typeof resultBody.enqueued === 'number' ? resultBody.enqueued : null,
      flushed: flush.handedOff,
      rejected: flush.rejected,
      batches: flush.batches,
      duration_ms: durationMs,
      error: flush.error ?? null,
    });
    return {
      ...result,
      body: {
        ...resultBody,
        flushed: flush.handedOff,
        rejected: flush.rejected,
        batches: flush.batches,
        duration_ms: durationMs,
        flush_error: flush.error ?? null,
      },
    };
  });
  server.registerRoute('POST', '/api/team/upgrade-worker', teamHandlers.handleUpgradeWorker);
  server.registerRoute('POST', '/api/team/rotate-mcp-token', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleRotateMcpToken(req);
  });
  server.registerRoute('GET', '/api/team/queue-stats', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleQueueStats(req);
  });
  server.registerRoute('GET', '/api/team/sync-summary', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleSyncSummary(req);
  });
  server.registerRoute('GET', '/api/team/dlq', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleDlqList(req);
  });
  server.registerRoute('POST', '/api/team/dlq/retry', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleDlqRetry(req);
  });
  server.registerRoute('POST', '/api/team/dlq/discard', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleDlqDiscard(req);
  });
  server.registerRoute('POST', '/api/team/cf-api-token', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleSetCfApiToken(req);
  });
  server.registerRoute('DELETE', '/api/team/cf-api-token', async (req) => {
    await reconcileTeamRoute(req);
    return teamHandlers.handleClearCfApiToken(req);
  });

  const collectiveHandlers = createCollectiveHandlers({
    getTeamClient: () => teamSync.getTeamClient(),
  });
  server.registerRoute('GET', '/api/collective/status', collectiveHandlers.handleStatus);
  server.registerRoute('GET', '/api/collective/search', collectiveHandlers.handleSearch);
  server.registerRoute('GET', '/api/collective/projects', collectiveHandlers.handleProjects);
  server.registerRoute('GET', '/api/collective/project', collectiveHandlers.handleProject);
  server.registerRoute('GET', '/api/collective/settings', collectiveHandlers.handleSettings);

  // --- Search, activity feed, and embedding status ---

  server.registerRoute('GET', '/api/search', createSearchHandler({
    embeddingManager,
    resolveEmbeddingManager: (requestContext) => getEmbeddingRuntime(requestContext).manager,
    getTeamClient: (requestContext) => teamSync.getTeamClient(requestContext),
    machineId,
  }));
  server.registerRoute('GET', '/api/activity', handleGetFeed);
  server.registerRoute('GET', '/api/embedding/status', async (req) => {
    const runtime = getEmbeddingRuntime(req.requestContext);
    return handleGetEmbeddingStatus(req.requestContext?.projectVaultDir ?? vaultDir, {
      db: runtime.db,
      project_id: rowProjectIdFromRequestContext(req.requestContext),
    });
  });
  server.registerRoute('GET', '/api/embedding/details', async (req) => {
    const runtime = getEmbeddingRuntime(req.requestContext);
    return handleEmbeddingDetails(runtime.manager);
  });
  server.registerRoute('POST', '/api/embedding/rebuild', async (req) => {
    const runtime = getEmbeddingRuntime(req.requestContext);
    return handleEmbeddingRebuild(runtime.manager, {
      async: req.query.async === 'true',
      db: runtime.db,
      project_id: rowProjectIdFromRequestContext(req.requestContext),
    });
  });
  server.registerRoute('POST', '/api/embedding/reconcile', async (req) => {
    const runtime = getEmbeddingRuntime(req.requestContext);
    return handleEmbeddingReconcile(runtime.manager);
  });
  server.registerRoute('POST', '/api/embedding/clean-orphans', async (req) => {
    const runtime = getEmbeddingRuntime(req.requestContext);
    return handleEmbeddingCleanOrphans(runtime.manager);
  });
  server.registerRoute('POST', '/api/embedding/reembed-stale', async (req) => {
    const runtime = getEmbeddingRuntime(req.requestContext);
    return handleEmbeddingReembedStale(runtime.manager);
  });
  server.registerRoute('GET', '/api/database/details', async () => handleDatabaseDetails(databaseManager));
  server.registerRoute('POST', '/api/database/optimize', async () => handleDatabaseOptimize(databaseManager));
  server.registerRoute('POST', '/api/database/vacuum', async () => handleDatabaseVacuum(databaseManager));
  server.registerRoute('POST', '/api/database/reindex', async () => handleDatabaseReindex(databaseManager));
  server.registerRoute('POST', '/api/database/integrity-check', async () => handleDatabaseIntegrityCheck(databaseManager));

  // --- Notification API routes ---
  server.registerRoute('GET', '/api/notifications', async (req) => handleListNotifications(vaultDir, req.query, req.requestContext));
  server.registerRoute('POST', '/api/notifications', async (req) => handleCreateNotification(vaultDir, req.body, req.requestContext));
  server.registerRoute('PATCH', '/api/notifications/:id', async (req) => handleUpdateNotification(vaultDir, req.params.id, req.body, req.requestContext));
  server.registerRoute('POST', '/api/notifications/dismiss-all', async (req) => handleDismissAll(vaultDir, req.body, req.requestContext));
  server.registerRoute('POST', '/api/notifications/mark-all-read', async (req) => handleMarkAllRead(vaultDir, req.body, req.requestContext));
  server.registerRoute('GET', '/api/notifications/registry', async () => handleGetRegistry());
  server.registerRoute('GET', '/api/notifications/unread-count', async (req) => handleUnreadCount(req.requestContext));

  // --- Start server ---
  //
  // The port is authoritative: Grove-bound projects use the per-user global
  // service port; legacy projects keep the explicit `daemon.port` override in
  // myco.yaml or the deterministic hash of the vault path.
  // No silent fallback — if the port is unavailable after eviction, either a
  // concurrent sibling won the race (step aside) or something unrelated is
  // squatting (fail loudly). Ghost daemons on surprise ports come from
  // silent fallback, so we don't do that.

  await server.evictExistingDaemon();
  const canonicalPort = dataPaths.usingGrove
    ? daemonService.canonicalPort
    : config.daemon.port ?? daemonService.canonicalPort;

  try {
    await server.start(canonicalPort);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EADDRINUSE') throw err;

    if (await isHealthyMycoSibling(canonicalPort)) {
      logger.info(LOG_KINDS.DAEMON_START, 'Sibling claimed canonical port during startup — stepping aside', {
        port: canonicalPort,
      });
      process.exit(0);
    }

    logger.error(LOG_KINDS.DAEMON_PORT, 'Canonical port is held by another process — cannot start', {
      port: canonicalPort,
      hint: `Run \`lsof -iTCP:${canonicalPort}\` to identify the owner, then either kill it or override daemon.port in myco.yaml`,
    });
    process.stderr.write(
      `Myco daemon cannot bind port ${canonicalPort} (held by another process). ` +
        `Run \`lsof -iTCP:${canonicalPort}\` to investigate.\n`,
    );
    process.exit(1);
  }
  logger.info(LOG_KINDS.DAEMON_READY, 'Daemon ready', { vault: vaultDir, port: server.port });

  // Pre-warm modules that are dynamically imported from daemon hot paths.
  // tsup compiles `await import('@myco/...')` into a chunk filename with a
  // content hash baked in (e.g. `./executor-ABC123.js`). When the bundle is
  // rebuilt during dev, chunk hashes churn — but the running daemon still
  // has the OLD filename baked into its code. The first late dynamic import
  // at that path then fails with `Cannot find module './executor-<OLD>.js'`.
  // Warming the imports now puts the resolved URLs into Node's ES module
  // cache; every subsequent `import()` at those call sites returns the cached
  // module without touching disk, so disk churn no longer matters.
  void Promise.all([
    import('../agent/executor.js'),
    import('../agent/registry.js'),
    import('../agent/tools/skill-staging.js'),
    import('../db/queries/turns.js'),
    import('../symbionts/installer.js'),
  ]).catch((err) => {
    logger.warn(LOG_KINDS.DAEMON_START, 'Pre-warm of dynamic imports failed', {
      error: (err as Error).message,
    });
  });

  // -- Dynamic task scheduling --
  // Registered first so its kicker is available as a normal dep when
  // power jobs register below.
  await syncScheduledTasks();

  // --- Register power-managed jobs ---
  // The canopy mass-add callback feeds the scheduler kicker so a fresh
  // populate or recovery scan drains immediately on the next compatible
  // tick instead of waiting one full canopy-describe interval.
  const powerJobs = registerPowerJobs(powerManager, {
    embeddingManager,
    registry,
    logger,
    liveConfig,
    db,
    machineId,
    vaultDir,
    projectRoot,
    projectId: dataPaths.requestContext.projectId,
    databaseManager,
    onCanopyMassAdd: () => scheduledTaskKicker.kick('canopy-describe'),
  });
  teamSync.registerFlushJob(powerManager);

  // Wire the canopy delta runner into the session-register path so each
  // SessionStart triggers a fire-and-forget refresh. The runner debounces.
  (sessionLifecycleDeps as { canopyDelta?: { run: () => Promise<void> } }).canopyDelta = powerJobs.canopy.delta;

  // Initial canopy populate runs in the background only when the table is
  // empty. On a fresh vault the scan adds every file (well above the
  // mass-add threshold), so onCanopyMassAdd kicks canopy-describe and
  // descriptions start draining on the next tick.
  powerJobs.canopy.runInitialPopulate().catch((err) => {
    logger.warn(LOG_KINDS.CANOPY_ERROR, 'Initial canopy populate failed', {
      error: (err as Error).message,
    });
  });

  powerManager.start();

  // --- Shutdown ---

  const shutdown = async (signal: string) => {
    logger.info(LOG_KINDS.DAEMON_START, `${signal} received`);
    powerManager.stop();
    // Wait for any active stop processing to finish before shutting down
    const activeStopProcessing = stopProcessor.getActiveProcessing();
    if (activeStopProcessing) {
      logger.info(LOG_KINDS.DAEMON_START, 'Waiting for active stop processing to complete...');
      await activeStopProcessing;
    }
    // Drain fire-and-forget Cortex runs so we don't orphan non-terminal
    // agent_runs rows or abandon reasoning-token spend. Bounded by a 30s
    // default — longer runs continue in the background but we still exit.
    if (inflightRuns.size > 0) {
      logger.info(LOG_KINDS.DAEMON_START, 'Draining in-flight agent runs before shutdown...', {
        inflight_count: inflightRuns.size,
      });
      const outcome = await inflightRuns.drain();
      if (!outcome.settled) {
        logger.warn(LOG_KINDS.DAEMON_START, 'Some in-flight runs did not settle before shutdown timeout', {
          remaining: outcome.remaining,
        });
      }
    }
    registry.destroy();
    await server.stop();
    for (const runtime of scopedEmbeddingManagers.values()) {
      runtime.vectorStore.close();
      runtime.db.close();
    }
    scopedEmbeddingManagers.clear();
    vectorStore.close();
    closeDatabase();
    logger.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
