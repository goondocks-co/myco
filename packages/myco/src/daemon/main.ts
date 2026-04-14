/**
 * Myco daemon — SQLite capture engine.
 *
 * All data goes to a local SQLite database (better-sqlite3). The intelligence
 * pipeline (extraction, embedding, consolidation, digest) is removed — it
 * moves to Phase 2 Agent SDK. What remains is the capture layer: session
 * lifecycle, prompt batch tracking, activity recording, and transcript mining.
 */

import { DaemonServer } from './server.js';
import { SessionRegistry } from './lifecycle.js';
import { DaemonLogger } from './logger.js';
import { loadConfig, updateConfig } from '../config/loader.js';
import { resolvePort } from './port.js';
import { TranscriptMiner } from '../capture/transcript-miner.js';
import { createPerProjectAdapter } from '../symbionts/adapter.js';
import { claudeCodeAdapter } from '../symbionts/claude-code.js';
import { findPackageRoot } from '../utils/find-package-root.js';
import { EventBuffer } from '../capture/buffer.js';
import { loadManifests } from '../symbionts/detect.js';
import type { PlanWatchConfig } from './plan-capture.js';
import { handleGetConfig, handlePutConfig, createPlanDirHandlers } from './api/config.js';
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
import {
  handleListSessions,
  handleGetSession,
  handleGetSessionBatches,
  handleGetBatchActivities,
  handleGetSessionAttachments,
  handleGetSessionPlans,
  createSessionMutationHandlers,
} from './api/sessions.js';
import {
  handleListSpores,
  handleGetSpore,
  handleListEntities,
  handleGetGraph,
  handleGetFullGraph,
  handleGetDigest,
} from './api/mycelium.js';
import { createSearchHandler } from './api/search.js';
import { createSessionContextHandler, createPromptContextHandler, createResumeContextHandler } from './api/context.js';
import { handleGetFeed } from './api/feed.js';
import { handleListSymbionts } from './api/symbionts.js';
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
import { registerScheduledTasks } from './task-scheduling.js';
import { initDatabase, vaultDbPath, closeDatabase, getDatabase } from '../db/client.js';
import { createSchema } from '../db/schema.js';
import { insertLogEntry, getMaxTimestamp } from '../db/queries/logs.js';
import { createMcpProxyHandlers } from './api/mcp-proxy.js';
import { createAgentRunHandlers } from './api/agent-runs.js';
import { createAttachmentHandler } from './api/attachments.js';
import { reconcileLogBuffer } from './log-reconcile.js';
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
import { notify } from '../notifications/notify.js';
import { PowerManager } from './power.js';
import { registerPowerJobs } from './power-jobs.js';
import {
  handleUserPrompt, handleToolUse, handleStopBatches, handleToolFailure,
  handleSubagentStart, handleSubagentStop, handleStopFailure,
  handleTaskCompleted, handleCompact,
} from './event-handlers.js';
import { createReconciler } from './reconciliation.js';
import { createStopProcessor } from './stop-processing.js';
import { createEventDispatcher } from './event-dispatch.js';
export {
  handleUserPrompt, handleToolUse, handleStopBatches, handleToolFailure,
  handleSubagentStart, handleSubagentStop, handleStopFailure,
  handleTaskCompleted, handleCompact,
} from './event-handlers.js';
import { loadSecrets } from '../config/secrets.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Stale daemon cleanup
// ---------------------------------------------------------------------------

/**
 * Kill any stale daemon process for this vault before starting a new one.
 * Reads daemon.json — if a live process exists with that PID, kill it.
 * This prevents orphaned daemons from accumulating across restarts.
 */
function killStaleDaemon(vaultDir: string, logger: DaemonLogger): void {
  const daemonJsonPath = path.join(vaultDir, 'daemon.json');
  try {
    if (!fs.existsSync(daemonJsonPath)) return;
    const info = JSON.parse(fs.readFileSync(daemonJsonPath, 'utf-8')) as { pid?: number };
    if (!info.pid) return;

    // Don't kill ourselves
    if (info.pid === process.pid) return;

    try {
      process.kill(info.pid, 0);
      process.kill(info.pid, 'SIGTERM');
      logger.info(LOG_KINDS.DAEMON_START, 'Killed stale daemon', { pid: info.pid });
    } catch { /* already dead */ }

    fs.unlinkSync(daemonJsonPath);
  } catch { /* daemon.json unreadable — ignore */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const vaultArg = process.argv.find((_, i) => process.argv[i - 1] === '--vault');
  if (!vaultArg) {
    process.stderr.write('Usage: mycod --vault <path>\n');
    process.exit(1);
  }

  const vaultDir = path.resolve(vaultArg);

  // Load API keys from secrets.env into process.env before any provider init
  loadSecrets(vaultDir);

  const config = loadConfig(vaultDir);

  const manifests = loadManifests();
  const symbiontPlanDirs = manifests.flatMap((m) => m.capture?.planDirs ?? []);
  const symbiontPlanTags = [...new Set(manifests.flatMap((m) => m.capture?.planTags ?? []))];
  const projectRoot = process.cwd();
  let planWatchConfig: PlanWatchConfig = {
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

  // Kill any stale daemon for this vault before starting
  killStaleDaemon(vaultDir, logger);

  logger.info(LOG_KINDS.DAEMON_CONFIG, 'Config loaded', {
    vault: vaultDir,
    embedding_provider: config.embedding.provider,
  });
  logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan watch directories', { dirs: planWatchConfig.watchDirs });
  if (symbiontPlanTags.length > 0) {
    logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan transcript tags', { tags: symbiontPlanTags });
  }

  // --- Machine identity ---
  const machineId = getMachineId(vaultDir);
  logger.info(LOG_KINDS.DAEMON_START, 'Machine ID resolved', { machine_id: machineId });

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
  const devCliEntry = detectDevBuild(
    globalPrefix,
    process.argv[1],
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
  const db = initDatabase(vaultDbPath(vaultDir));
  createSchema(db, machineId);
  registerBuiltinDomains();

  logger.info(LOG_KINDS.DAEMON_START, 'SQLite initialized', { vault: vaultDir });

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

  // Wire logger to SQLite persistence
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
    });
  });

  // Reconcile log entries missed while daemon was down
  const lastLogTimestamp = getMaxTimestamp();
  if (lastLogTimestamp) {
    const logDir = path.join(vaultDir, 'logs');
    const replayedCount = reconcileLogBuffer(logDir, lastLogTimestamp);
    if (replayedCount > 0) {
      logger.info(LOG_KINDS.DAEMON_RECONCILE, `Replayed ${replayedCount} log entries from buffer`, { replayed: replayedCount });
    }
  }

  // --- Embedding lifecycle manager ---
  const vectorsDbPath = path.join(vaultDir, 'vectors.db');
  const vectorStore = new SqliteVecVectorStore(vectorsDbPath);
  const llmProvider = createEmbeddingProvider(config.embedding);
  const embeddingProvider = new EmbeddingProviderAdapter(llmProvider, config.embedding);
  const recordSource = new SqliteRecordSource();
  const embeddingManager = new EmbeddingManager(vectorStore, embeddingProvider, recordSource, logger);
  logger.info(LOG_KINDS.EMBEDDING_EMBED, 'EmbeddingManager initialized', { vectors_db: vectorsDbPath });
  const databaseManager = new DatabaseMaintenanceManager(vaultDbPath(vaultDir), vaultDir, logger);

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
        }, config);
      }
      logger.info(LOG_KINDS.AGENT_RUN, 'Cleaned stale running agent runs', {
        count: staleRows.length,
        ids: staleRows.map((r) => r.id),
      });
    }
  } catch (err) {
    logger.warn(LOG_KINDS.AGENT_ERROR, 'Failed to clean stale runs', { error: (err as Error).message });
  }

  // Resolve dist/ui/ from the package root
  let uiDir: string | null = null;
  {
    const root = findPackageRoot(path.dirname(new URL(import.meta.url).pathname));
    if (root) {
      const candidate = path.join(root, 'dist', 'ui');
      if (fs.existsSync(candidate)) uiDir = candidate;
    }
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

  const server = new DaemonServer({
    vaultDir,
    logger,
    uiDir: uiDir ?? undefined,
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

  const reconciler = createReconciler({ bufferDir, logger });
  reconciler.runStartupReconciliation();

  // --- Stop processor (created early so triggerTitleSummary is available to /events route) ---
  const stopProcessor = createStopProcessor({
    registry,
    sessionBuffers,
    transcriptMiner,
    embeddingManager,
    logger,
    config,
    vaultDir,
    planTags: symbiontPlanTags,
  });

  // --- Session routes ---
  const sessionLifecycle = createSessionLifecycleHandlers({
    registry, sessionBuffers, reconciler, stopProcessor,
    server, powerManager, machineId, logger, config, vaultDir,
  });
  server.registerRoute('POST', '/sessions/register', sessionLifecycle.handleRegister);
  server.registerRoute('POST', '/sessions/unregister', sessionLifecycle.handleUnregister);

  // --- Event routes ---

  const eventDispatcher = createEventDispatcher({
    registry,
    sessionBuffers,
    powerManager,
    logger,
    machineId,
    config,
    vaultDir,
    reconcileSession: reconciler.reconcileSession,
    planWatchConfig,
    triggerTitleSummary: stopProcessor.triggerTitleSummary,
  });
  server.registerRoute('POST', '/events', eventDispatcher);

  // --- Stop route ---

  server.registerRoute('POST', '/events/stop', stopProcessor.handleStopRoute);

  // --- Context injection (digest + semantic spore search) ---
  const contextDeps = { embeddingManager, config, logger };
  server.registerRoute('POST', '/context', createSessionContextHandler(contextDeps));
  server.registerRoute('POST', '/context/resume', createResumeContextHandler(contextDeps));
  server.registerRoute('POST', '/context/prompt', createPromptContextHandler(contextDeps));

  // --- Dashboard API routes ---
  const progressTracker = new ProgressTracker();
  let configHash = computeConfigHash(vaultDir);

  server.registerRoute('GET', '/api/config', async () => handleGetConfig(vaultDir));
  server.registerRoute('GET', '/api/symbionts', async () => handleListSymbionts(vaultDir));
  server.registerRoute('PUT', '/api/config', async (req) => {
    const result = await handlePutConfig(vaultDir, req.body);
    if (!result.status || result.status < 400) {
      reconcileConfiguredSymbionts(path.dirname(vaultDir), vaultDir);
      configHash = computeConfigHash(vaultDir);
    }
    return result;
  });

  // Pre-compute symbiont plan dirs for the config endpoint (manifests don't change at runtime)
  const symbiontPlanDirsByAgent: Record<string, string[]> = {};
  for (const m of manifests) {
    const dirs = m.capture?.planDirs ?? [];
    if (dirs.length > 0) symbiontPlanDirsByAgent[m.displayName] = dirs;
  }

  const planDirHandlers = createPlanDirHandlers({
    vaultDir,
    symbiontPlanDirsByAgent,
    symbiontPlanDirs,
    planWatchConfig,
    setPlanWatchConfig: (cfg) => { planWatchConfig = cfg; },
    reconcileProjectFiles: () => { reconcileConfiguredSymbionts(path.dirname(vaultDir), vaultDir); },
  });
  server.registerRoute('GET', '/api/config/plan-dirs', planDirHandlers.handleGetPlanDirs);
  server.registerRoute('POST', '/api/config/plan-dirs', async (req) => {
    const result = await planDirHandlers.handleUpdatePlanDirs(req);
    if (!result.status || result.status < 400) {
      configHash = computeConfigHash(vaultDir);
    }
    return result;
  });

  // V2 stats — vault counts, embedding coverage, agent status, digest freshness
  const configHashRef = { get: () => configHash };
  server.registerRoute('GET', '/api/stats', createLiveStatsHandler({
    vaultDir,
    registry,
    server,
    configHash: configHashRef,
  }));

  server.registerRoute('GET', '/api/logs', handleLogStream);
  server.registerRoute('GET', '/api/logs/search', handleLogSearch);
  server.registerRoute('GET', '/api/logs/stream', handleLogStream);
  server.registerRoute('GET', '/api/logs/:id', handleLogDetail);

  // External log ingestion: allows MCP server (separate process) to write through the daemon logger
  server.registerRoute('POST', '/api/log', createLogIngestionHandler(logger));

  server.registerRoute('GET', '/api/models', async (req) => handleGetModels(req));
  server.registerRoute('POST', '/api/restart', async (req) => handleRestart({ vaultDir, progressTracker }, req.body));

  // --- Update routes ---
  const updateProjectRoot = path.dirname(vaultDir);
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

  server.registerRoute('GET', '/api/sessions/:id', handleGetSession);
  const sessionMutations = createSessionMutationHandlers({ embeddingManager, vaultDir, logger, config });
  server.registerRoute('GET', '/api/sessions/:id/impact', sessionMutations.handleGetSessionImpact);
  server.registerRoute('POST', '/api/sessions/:id/complete', sessionMutations.handleCompleteSession);
  server.registerRoute('DELETE', '/api/sessions/:id', sessionMutations.handleDeleteSession);
  server.registerRoute('GET', '/api/sessions/:id/batches', handleGetSessionBatches);
  server.registerRoute('GET', '/api/batches/:id/activities', handleGetBatchActivities);
  server.registerRoute('GET', '/api/sessions/:id/attachments', handleGetSessionAttachments);
  server.registerRoute('GET', '/api/sessions/:id/plans', handleGetSessionPlans);

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
  server.registerRoute('GET', '/api/spores/:id', handleGetSpore);
  server.registerRoute('GET', '/api/entities', handleListEntities);
  server.registerRoute('GET', '/api/graph', handleGetFullGraph);
  server.registerRoute('GET', '/api/graph/:id', handleGetGraph);
  server.registerRoute('GET', '/api/digest', handleGetDigest);

  const attachments = createAttachmentHandler({ vaultDir });
  server.registerRoute('GET', '/api/attachments/:filename', attachments.handleGetAttachment);

  // --- Agent API routes ---
  const agentRunHandlers = createAgentRunHandlers({ vaultDir, embeddingManager, logger });
  server.registerRoute('POST', '/api/agent/run', agentRunHandlers.handleRun);
  server.registerRoute('GET', '/api/agent/runs', agentRunHandlers.handleListRuns);
  server.registerRoute('GET', '/api/agent/runs/:id', agentRunHandlers.handleGetRun);
  server.registerRoute('GET', '/api/agent/runs/:id/reports', agentRunHandlers.handleGetRunReports);
  server.registerRoute('GET', '/api/agent/runs/:id/turns', agentRunHandlers.handleGetRunTurns);

  server.registerRoute('GET', '/api/agent/tasks', async (req) => handleListTasks(req, vaultDir));
  server.registerRoute('GET', '/api/agent/tasks/:id', async (req) => handleGetTask(req, vaultDir));
  server.registerRoute('GET', '/api/agent/tasks/:id/yaml', async (req) => handleGetTaskYaml(req, vaultDir));
  server.registerRoute('PUT', '/api/agent/tasks/:id', async (req) => handleUpdateTask(req, vaultDir));
  server.registerRoute('POST', '/api/agent/tasks', async (req) => handleCreateTask(req, vaultDir));
  server.registerRoute('POST', '/api/agent/tasks/:id/copy', async (req) => handleCopyTask(req, vaultDir));
  server.registerRoute('DELETE', '/api/agent/tasks/:id', async (req) => handleDeleteTask(req, vaultDir));
  server.registerRoute('GET', '/api/agent/tasks/:id/config', async (req) => handleGetTaskConfig(req, vaultDir));
  server.registerRoute('PUT', '/api/agent/tasks/:id/config', async (req) => handleUpdateTaskConfig(req, vaultDir));

  // --- Provider detection & testing ---
  server.registerRoute('GET', '/api/providers', async () => handleGetProviders());
  server.registerRoute('POST', '/api/providers/test', async (req) => handleTestProvider(req));

  // --- MCP proxy routes ---
  // These routes exist so the MCP server can proxy tool calls through the
  // daemon instead of opening its own SQLite connection.
  const mcpProxy = createMcpProxyHandlers({ machineId, embeddingManager });
  server.registerRoute('POST', '/api/mcp/remember', mcpProxy.handleRemember);
  server.registerRoute('POST', '/api/mcp/supersede', mcpProxy.handleSupersede);
  server.registerRoute('GET', '/api/mcp/plans', mcpProxy.handlePlans);
  server.registerRoute('GET', '/api/mcp/sessions', mcpProxy.handleSessions);
  server.registerRoute('GET', '/api/mcp/team', mcpProxy.handleTeam);

  // --- Backup routes ---
  const rawBackupDir = config.backup.dir;
  const backupDir = rawBackupDir
    ? path.resolve(rawBackupDir.startsWith('~/') ? path.join(os.homedir(), rawBackupDir.slice(2)) : rawBackupDir)
    : path.resolve(vaultDir, 'backups');
  const backupHandlers = createBackupHandlers({ db, backupDir, machineId });
  server.registerRoute('POST', '/api/backup', backupHandlers.handleCreateBackup);
  server.registerRoute('GET', '/api/backups', backupHandlers.handleListBackups);
  server.registerRoute('POST', '/api/restore/preview', backupHandlers.handleRestorePreview);
  server.registerRoute('POST', '/api/restore', backupHandlers.handleRestore);

  const backupConfigHandlers = createBackupConfigHandlers({ vaultDir });
  server.registerRoute('GET', '/api/backup/config', backupConfigHandlers.handleGetBackupConfig);
  server.registerRoute('PUT', '/api/backup/config', backupConfigHandlers.handlePutBackupConfig);

  // --- Team sync ---
  const teamSync = initTeamSync({ config, machineId, logger, vaultDir, serverVersion: server.version });

  const teamHandlers = createTeamHandlers({
    vaultDir,
    machineId,
    logger,
    getTeamClient: teamSync.getTeamClient,
    setTeamClient: teamSync.setTeamClient,
  });
  server.registerRoute('POST', '/api/team/connect', teamHandlers.handleConnect);
  server.registerRoute('POST', '/api/team/disconnect', teamHandlers.handleDisconnect);
  server.registerRoute('GET', '/api/team/status', teamHandlers.handleStatus);
  server.registerRoute('POST', '/api/team/backfill', teamHandlers.handleBackfill);
  server.registerRoute('POST', '/api/team/retry-failed', teamHandlers.handleRetryFailed);
  server.registerRoute('POST', '/api/team/upgrade-worker', teamHandlers.handleUpgradeWorker);
  server.registerRoute('POST', '/api/team/rotate-mcp-token', teamHandlers.handleRotateMcpToken);

  const collectiveHandlers = createCollectiveHandlers({
    getTeamClient: teamSync.getTeamClient,
  });
  server.registerRoute('GET', '/api/collective/status', collectiveHandlers.handleStatus);
  server.registerRoute('GET', '/api/collective/search', collectiveHandlers.handleSearch);
  server.registerRoute('GET', '/api/collective/projects', collectiveHandlers.handleProjects);
  server.registerRoute('GET', '/api/collective/project', collectiveHandlers.handleProject);
  server.registerRoute('GET', '/api/collective/settings', collectiveHandlers.handleSettings);

  // --- Search, activity feed, and embedding status ---

  server.registerRoute('GET', '/api/search', createSearchHandler({ embeddingManager, getTeamClient: teamSync.getTeamClient, machineId }));
  server.registerRoute('GET', '/api/activity', handleGetFeed);
  server.registerRoute('GET', '/api/embedding/status', async () => handleGetEmbeddingStatus(vaultDir));
  server.registerRoute('GET', '/api/embedding/details', async () => handleEmbeddingDetails(embeddingManager));
  server.registerRoute('POST', '/api/embedding/rebuild', async () => handleEmbeddingRebuild(embeddingManager));
  server.registerRoute('POST', '/api/embedding/reconcile', async () => handleEmbeddingReconcile(embeddingManager));
  server.registerRoute('POST', '/api/embedding/clean-orphans', async () => handleEmbeddingCleanOrphans(embeddingManager));
  server.registerRoute('POST', '/api/embedding/reembed-stale', async () => handleEmbeddingReembedStale(embeddingManager));
  server.registerRoute('GET', '/api/database/details', async () => handleDatabaseDetails(databaseManager));
  server.registerRoute('POST', '/api/database/optimize', async () => handleDatabaseOptimize(databaseManager));
  server.registerRoute('POST', '/api/database/vacuum', async () => handleDatabaseVacuum(databaseManager));
  server.registerRoute('POST', '/api/database/reindex', async () => handleDatabaseReindex(databaseManager));
  server.registerRoute('POST', '/api/database/integrity-check', async () => handleDatabaseIntegrityCheck(databaseManager));

  // --- Notification API routes ---
  server.registerRoute('GET', '/api/notifications', async (req) => handleListNotifications(vaultDir, req.query));
  server.registerRoute('POST', '/api/notifications', async (req) => handleCreateNotification(vaultDir, req.body));
  server.registerRoute('PATCH', '/api/notifications/:id', async (req) => handleUpdateNotification(vaultDir, req.params.id, req.body));
  server.registerRoute('POST', '/api/notifications/dismiss-all', async (req) => handleDismissAll(vaultDir, req.body));
  server.registerRoute('POST', '/api/notifications/mark-all-read', async (req) => handleMarkAllRead(vaultDir, req.body));
  server.registerRoute('GET', '/api/notifications/registry', async () => handleGetRegistry());
  server.registerRoute('GET', '/api/notifications/unread-count', async () => handleUnreadCount());

  // --- Start server ---

  await server.evictExistingDaemon();
  const resolvedPort = await resolvePort(config.daemon.port, vaultDir);
  if (resolvedPort === 0) {
    logger.warn(LOG_KINDS.DAEMON_PORT, 'All preferred ports occupied, using ephemeral port');
  }
  await server.start(resolvedPort);
  logger.info(LOG_KINDS.DAEMON_READY, 'Daemon ready', { vault: vaultDir, port: server.port });

  // Persist the resolved port to config if it was auto-derived
  if (config.daemon.port === null && resolvedPort !== 0) {
    try {
      updateConfig(vaultDir, (c) => ({
        ...c,
        daemon: { ...c.daemon, port: resolvedPort },
      }));
      logger.info(LOG_KINDS.DAEMON_CONFIG, 'Persisted auto-derived port to myco.yaml', { port: resolvedPort });
    } catch (err) {
      logger.warn(LOG_KINDS.DAEMON_CONFIG, 'Failed to persist auto-derived port', { error: (err as Error).message });
    }
  }

  // --- Register power-managed jobs ---
  registerPowerJobs(powerManager, { embeddingManager, registry, logger, config, db, backupDir, machineId, vaultDir, databaseManager });
  teamSync.registerFlushJob(powerManager);

  // -- Dynamic task scheduling --
  await registerScheduledTasks(powerManager, { definitionsDir, vaultDir, embeddingManager, logger, config });

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
    registry.destroy();
    await server.stop();
    vectorStore.close();
    closeDatabase();
    logger.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
