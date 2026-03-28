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
import { loadConfig, updateConfig, updateBackupConfig } from '../config/loader.js';
import { resolvePort } from './port.js';
import { TranscriptMiner, extractTurnsFromBuffer } from '../capture/transcript-miner.js';
import { createPerProjectAdapter, extensionForMimeType, type TranscriptTurn } from '../symbionts/adapter.js';
import { claudeCodeAdapter } from '../symbionts/claude-code.js';
import { findPackageRoot } from '../utils/find-package-root.js';
import { EventBuffer, listBufferSessionIds, cleanStaleBuffers } from '../capture/buffer.js';
import { loadManifests } from '../symbionts/detect.js';
import { isPlanWriteEvent, capturePlan, type PlanWatchConfig } from './plan-capture.js';
import type { RegisteredSession } from './lifecycle.js';
import { handleGetConfig, handlePutConfig } from './api/config.js';
import { handleLogSearch, handleLogStream, handleLogDetail } from './api/log-explorer.js';
import { handleRestart } from './api/restart.js';
import { getMachineId } from './machine-id.js';
import { createBackupHandlers } from './api/backup.js';
import { createTeamHandlers } from './api/team-connect.js';
import { TeamSyncClient } from './team-sync.js';
import { initTeamContext } from './team-context.js';
import { createBackup } from './backup.js';
import { listPending, markSent, pruneOld, backfillUnsynced } from '../db/queries/team-outbox.js';
import { readSecrets } from '../config/secrets.js';
import { ProgressTracker, handleGetProgress } from './api/progress.js';
import { handleGetModels } from './api/models.js';
import { computeConfigHash } from './api/stats.js';
import {
  handleListSessions,
  handleGetSession,
  handleGetSessionBatches,
  handleGetBatchActivities,
  handleGetSessionAttachments,
  handleGetSessionPlans,
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
import { createSessionContextHandler, createPromptContextHandler } from './api/context.js';
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
import { EmbeddingManager, SqliteVecVectorStore, EmbeddingProviderAdapter, SqliteRecordSource } from './embedding/index.js';
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
import { listTurnsByRun } from '../db/queries/turns.js';
import { gatherStats } from '../services/stats.js';
import { initDatabase, vaultDbPath, closeDatabase, getDatabase } from '../db/client.js';
import { createSchema } from '../db/schema.js';
import { upsertSession, closeSession, updateSession, listSessions, getSession, deleteSessionCascade, getSessionImpact } from '../db/queries/sessions.js';
import { incrementActivityCount, populateBatchResponses, getBatchIdByPromptNumber, findBatchByPromptPrefix, closeOpenBatches, insertBatchStateless, getLatestBatch, setResponseSummary, listBatchesBySession } from '../db/queries/batches.js';
import { insertActivityWithBatch } from '../db/queries/activities.js';
import { insertAttachment, getAttachmentByFilePath } from '../db/queries/attachments.js';
import { listRuns, countRuns, getRun, getRunningRun } from '../db/queries/runs.js';
import { listReports } from '../db/queries/reports.js';
import { insertSpore, updateSporeStatus } from '../db/queries/spores.js';
import { listPlans } from '../db/queries/plans.js';
import { registerAgent } from '../db/queries/agents.js';
import { insertLogEntry, deleteOldLogs, getMaxTimestamp } from '../db/queries/logs.js';
import { reconcileLogBuffer } from './log-reconcile.js';
import {
  DEFAULT_AGENT_ID,
  STALE_BUFFER_MAX_AGE_MS,
  LOG_PROMPT_PREVIEW_CHARS,
  LOG_MESSAGE_PREVIEW_CHARS,
  USER_AGENT_ID,
  USER_AGENT_NAME,
  EMBEDDING_BATCH_SIZE,
  POWER_IDLE_THRESHOLD_MS,
  POWER_SLEEP_THRESHOLD_MS,
  POWER_DEEP_SLEEP_THRESHOLD_MS,
  POWER_ACTIVE_INTERVAL_MS,
  POWER_SLEEP_INTERVAL_MS,
  SYNC_PROTOCOL_VERSION,
  epochSeconds,
  MS_PER_SECOND,
  MS_PER_DAY,
} from '../constants.js';
import { PowerManager } from './power.js';
import { runSessionMaintenance } from './jobs/session-maintenance.js';
import { cleanupAfterSessionCascade } from './jobs/session-cleanup.js';
import { createBatchLineage } from '../db/queries/lineage.js';
import { loadSecrets } from '../config/secrets.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------


/** Default limit for listing agent runs in the API. */
const AGENT_RUNS_DEFAULT_LIMIT = 50;

/** Max chars of tool input stored in the activity row. */
const TOOL_INPUT_STORE_LIMIT = 4000;

/** Max chars of tool output summary stored in the activity row. */
const TOOL_OUTPUT_STORE_LIMIT = 2000;

/** Max chars for deriving a title from the first user prompt. */
const TITLE_PREVIEW_CHARS = 80;

/** Prefixes that identify system-injected messages (not real user prompts). */
const SYSTEM_MESSAGE_PREFIXES = [
  '<task-notification>',
  '<system-reminder>',
] as const;

/** Returns true if the prompt is a system-injected message, not a real user prompt. */
function isSystemMessage(prompt: string): boolean {
  const trimmed = prompt.trimStart();
  return SYSTEM_MESSAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Event types replayed during buffer reconciliation. */
const REPLAYABLE_EVENT_TYPES: ReadonlySet<string> = new Set(['user_prompt', 'tool_use', 'tool_failure']);

// ---------------------------------------------------------------------------
// Event handling helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Handle a UserPromptSubmit event: close previous batch, open new one.
 *
 * Fully stateless — prompt_number is derived from an inline DB subquery,
 * and open batches are closed with a blind UPDATE (no prior SELECT).
 *
 * @returns the new batch ID and prompt number
 */
export function handleUserPrompt(
  sessionId: string,
  prompt: string | undefined,
): { batchId: number; promptNumber: number } {
  const now = epochSeconds();

  // Close any open batches for this session — blind UPDATE, no prior read
  closeOpenBatches(sessionId, now);

  // Insert new batch with prompt_number derived from DB
  const batch = insertBatchStateless({
    session_id: sessionId,
    user_prompt: prompt ?? null,
    started_at: now,
    created_at: now,
  });

  // insertBatchStateless guarantees non-null prompt_number via COALESCE subquery
  const promptNumber = batch.prompt_number!;

  // Create HAS_BATCH lineage edge (best-effort)
  try { createBatchLineage(DEFAULT_AGENT_ID, sessionId, batch.id, now); } catch { /* lineage best-effort */ }

  // Update session prompt count
  updateSession(sessionId, { prompt_count: promptNumber });

  return { batchId: batch.id, promptNumber };
}

/**
 * Handle a PostToolUse event: insert activity with inline batch linkage.
 *
 * Fully stateless — the batch ID is resolved via an inline subquery in
 * `insertActivityWithBatch`, so no in-memory state is needed.
 */
export function handleToolUse(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  toolOutput: string | undefined,
): void {
  const now = epochSeconds();

  // Extract file_path from tool input if present
  const inputObj = toolInput as Record<string, unknown> | undefined;
  const filePath = typeof inputObj?.file_path === 'string' ? inputObj.file_path : null;

  const activity = insertActivityWithBatch({
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput ? JSON.stringify(toolInput).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: toolOutput?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    file_path: filePath,
    timestamp: now,
    created_at: now,
  });

  // Increment batch activity count if linked to a batch
  if (activity.prompt_batch_id !== null) {
    incrementActivityCount(activity.prompt_batch_id);
  }
  // Session-level tool_count is updated at stop time from transcript data.
}

/**
 * Handle stop event: close all open batches for this session.
 *
 * Does NOT close the session — the Stop hook fires after every assistant
 * turn, not just session end. Session closure happens in /sessions/unregister
 * (SessionEnd hook).
 *
 * Fully stateless — uses `closeOpenBatches` (blind UPDATE) instead of
 * reading from an in-memory map.
 */
export function handleStopBatches(
  sessionId: string,
): void {
  closeOpenBatches(sessionId, epochSeconds());
}

/**
 * Handle a tool failure event: insert activity with success=0.
 */
export function handleToolFailure(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  error: string | undefined,
  isInterrupt: boolean | undefined,
): void {
  const now = epochSeconds();
  const inputObj = toolInput as Record<string, unknown> | undefined;
  const filePath = typeof inputObj?.file_path === 'string' ? inputObj.file_path : null;

  const activity = insertActivityWithBatch({
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput ? JSON.stringify(toolInput).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: error?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    file_path: filePath,
    success: 0,
    error_message: error?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? (isInterrupt ? 'interrupted' : null),
    timestamp: now,
    created_at: now,
  });

  if (activity.prompt_batch_id !== null) {
    incrementActivityCount(activity.prompt_batch_id);
  }
}

/**
 * Handle a subagent start event: record that a subagent was spawned.
 */
export function handleSubagentStart(
  sessionId: string,
  agentId: string | undefined,
  agentType: string | undefined,
): void {
  const now = epochSeconds();
  insertActivityWithBatch({
    session_id: sessionId,
    tool_name: 'subagent_start',
    tool_input: JSON.stringify({ agent_id: agentId, agent_type: agentType }).slice(0, TOOL_INPUT_STORE_LIMIT),
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a subagent stop event: record that a subagent completed.
 */
export function handleSubagentStop(
  sessionId: string,
  agentId: string | undefined,
  agentType: string | undefined,
  lastAssistantMessage: string | undefined,
): void {
  const now = epochSeconds();
  insertActivityWithBatch({
    session_id: sessionId,
    tool_name: 'subagent_stop',
    tool_input: JSON.stringify({ agent_id: agentId, agent_type: agentType }).slice(0, TOOL_INPUT_STORE_LIMIT),
    tool_output_summary: lastAssistantMessage?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a stop failure event: record that the stop hook encountered an error.
 */
export function handleStopFailure(
  sessionId: string,
  error: string | undefined,
  errorDetails: string | undefined,
): void {
  const now = epochSeconds();
  insertActivityWithBatch({
    session_id: sessionId,
    tool_name: 'stop_failure',
    tool_output_summary: errorDetails?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    success: 0,
    error_message: error?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a task completed event: record task completion as an activity.
 */
export function handleTaskCompleted(
  sessionId: string,
  taskId: string | undefined,
  taskSubject: string | undefined,
  taskDescription: string | undefined,
): void {
  const now = epochSeconds();
  insertActivityWithBatch({
    session_id: sessionId,
    tool_name: 'task_completed',
    tool_input: JSON.stringify({ task_id: taskId, task_subject: taskSubject, task_description: taskDescription }).slice(0, TOOL_INPUT_STORE_LIMIT),
    tool_output_summary: taskSubject?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}

/**
 * Handle a compact event (pre or post): record compaction in the activity stream.
 */
export function handleCompact(
  sessionId: string,
  phase: 'pre' | 'post',
  trigger: string | undefined,
  compactSummary: string | undefined,
): void {
  const now = epochSeconds();
  insertActivityWithBatch({
    session_id: sessionId,
    tool_name: `${phase}_compact`,
    tool_input: trigger ? JSON.stringify({ trigger }).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: compactSummary?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    timestamp: now,
    created_at: now,
  });
}

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
  const projectRoot = process.cwd();
  let planWatchConfig: PlanWatchConfig = {
    watchDirs: [...new Set([...symbiontPlanDirs, ...(config.capture.plan_dirs ?? [])])],
    projectRoot,
    extensions: config.capture.artifact_extensions,
  };

  const logger = new DaemonLogger(path.join(vaultDir, 'logs'), {
    level: config.daemon.log_level,
  });

  // Kill any stale daemon for this vault before starting
  killStaleDaemon(vaultDir, logger);

  logger.info(LOG_KINDS.DAEMON_CONFIG, 'Config loaded', {
    vault: vaultDir,
    embedding_provider: config.embedding.provider,
  });
  logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan watch directories', { dirs: planWatchConfig.watchDirs });

  // --- Machine identity ---
  const machineId = getMachineId(vaultDir);
  logger.info(LOG_KINDS.DAEMON_START, 'Machine ID resolved', { machine_id: machineId });

  // --- SQLite initialization ---
  const db = initDatabase(vaultDbPath(vaultDir));
  createSchema(db, machineId);
  logger.info(LOG_KINDS.DAEMON_START, 'SQLite initialized', { vault: vaultDir });

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

  // --- Register built-in agents and tasks ---
  try {
    const { registerBuiltInAgentsAndTasks, resolveDefinitionsDir } = await import('../agent/loader.js');
    const definitionsDir = resolveDefinitionsDir();
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
      `SELECT id FROM agent_runs WHERE status = 'running'`,
    ).all() as Array<{ id: string }>;

    if (staleRows.length > 0) {
      staleDb.prepare(
        `UPDATE agent_runs SET status = 'failed', completed_at = ?, error = 'Daemon restarted while run was in progress' WHERE status = 'running'`,
      ).run(epochSeconds());
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
    onRequest: () => powerManager.recordActivity(),
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

  let activeStopProcessing: Promise<void> | null = null;

  // Cache derived titles per session — the title comes from the first prompt
  // and never changes, so we only need to query the DB once.
  const sessionTitleCache = new Map<string, string>();

  /**
   * Fire-and-forget trigger for the title-summary agent task.
   * Guards: summary_batch_interval must be > 0 (0 = disabled), no run
   * already in progress. Callers add their own preconditions (e.g. batch
   * threshold, missing title).
   */
  async function triggerTitleSummary(sessionId: string): Promise<void> {
    if (config.agent.summary_batch_interval <= 0) return;
    const running = getRunningRun(DEFAULT_AGENT_ID);
    if (running) return;
    try {
      const { runAgent } = await import('../agent/executor.js');
      runAgent(vaultDir, {
        task: 'title-summary',
        instruction: `Process session ${sessionId} only`,
        embeddingManager,
      }).catch(err => logger.warn(LOG_KINDS.AGENT_ERROR, 'Title-summary task failed', { error: String(err) }));
    } catch { /* agent unavailable */ }
  }

  const bufferDir = path.join(vaultDir, 'buffer');
  const sessionBuffers = new Map<string, EventBuffer>();

  // Clean up stale buffer files (>24h) on startup
  const startupCleanedCount = cleanStaleBuffers(bufferDir, STALE_BUFFER_MAX_AGE_MS);
  if (startupCleanedCount > 0) {
    logger.info(LOG_KINDS.CAPTURE_BUFFER, 'Buffer cleanup complete', { stale_removed: startupCleanedCount });
  }

  // Track sessions already reconciled this daemon lifetime to avoid
  // redundant file reads (startup scan + register + event can all fire).
  const reconciledSessions = new Set<string>();

  // Reconcile all remaining buffer files on startup — recover events from
  // sessions that had activity while the daemon was down.
  for (const sessionId of listBufferSessionIds(bufferDir)) {
    try {
      reconcileSession(sessionId);
    } catch (err) {
      logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Startup reconciliation failed', { session_id: sessionId, error: String(err) });
    }
  }

  /**
   * Replay a single buffer event into the DB via the appropriate handler.
   *
   * Shared between reconcileSession (buffer replay) and the live /events
   * route to eliminate dispatch duplication.
   *
   * @returns 'prompt' | 'activity' | null indicating what was created.
   */
  function replayEvent(sessionId: string, event: Record<string, unknown>): 'prompt' | 'activity' | null {
    if (event.type === 'user_prompt') {
      if (isSystemMessage(String(event.prompt ?? ''))) return null;
      handleUserPrompt(sessionId, String(event.prompt ?? ''));
      return 'prompt';
    }
    if (event.type === 'tool_use') {
      handleToolUse(
        sessionId,
        String(event.tool_name ?? ''),
        event.tool_input,
        typeof event.output_preview === 'string' ? event.output_preview : undefined,
      );
      return 'activity';
    }
    if (event.type === 'tool_failure') {
      handleToolFailure(
        sessionId,
        String(event.tool_name ?? ''),
        event.tool_input,
        typeof event.error === 'string' ? event.error : undefined,
        !!event.is_interrupt,
      );
      return 'activity';
    }
    return null;
  }

  /**
   * Reconcile buffer events against DB state for a session.
   *
   * The buffer is the authoritative event log. The DB (prompt_batches +
   * activities) is a derived view. After a daemon restart, the DB may be
   * missing events the daemon didn't process while it was down.
   *
   * Activities belong to batches — they're linked via the latest open batch
   * at insertion time. So we can't reconcile them separately. Instead, we
   * find where the DB diverges from the buffer (by prompt count) and replay
   * the FULL event stream from that point: prompts open batches, tool events
   * attach to the open batch — exactly the normal flow.
   */
  function reconcileSession(sessionId: string): void {
    if (reconciledSessions.has(sessionId)) return;
    reconciledSessions.add(sessionId);

    // Read buffer file directly — avoid EventBuffer constructor which reads
    // the file to compute a count we don't need.
    const bufferPath = path.join(bufferDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(bufferPath)) return;
    const content = fs.readFileSync(bufferPath, 'utf-8').trim();
    if (!content) return;

    // Buffer files outlive session rows — sessions may have been manually
    // deleted or cleaned up by the session cleanup job. Skip reconciliation
    // for sessions that no longer exist rather than resurrecting them.
    if (!getSession(sessionId)) {
      logger.debug(LOG_KINDS.LIFECYCLE_RECONCILE, 'Skipping reconciliation for deleted session', { session_id: sessionId });
      return;
    }

    const allEvents: Array<Record<string, unknown>> = content.split('\n').map((line) => JSON.parse(line));

    // Find the divergence point: how many real prompts does the DB have?
    const existingBatchCount = listBatchesBySession(sessionId).length;

    let promptsSeen = 0;
    let replayStartIndex = -1;

    for (let i = 0; i < allEvents.length; i++) {
      const e = allEvents[i];
      if (e.type === 'user_prompt' && !isSystemMessage(String(e.prompt ?? ''))) {
        promptsSeen++;
        if (promptsSeen === existingBatchCount + 1) {
          replayStartIndex = i;
          break;
        }
      }
    }

    if (replayStartIndex === -1) return;

    // Replay full event stream from the divergence point
    const eventsToReplay = allEvents.slice(replayStartIndex).filter(
      (e) => REPLAYABLE_EVENT_TYPES.has(String(e.type)),
    );

    let promptsRecovered = 0;
    let activitiesRecovered = 0;

    for (const event of eventsToReplay) {
      try {
        const result = replayEvent(sessionId, event);
        if (result === 'prompt') promptsRecovered++;
        else if (result === 'activity') activitiesRecovered++;
      } catch (err) {
        logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: failed to replay event', {
          type: String(event.type),
          error: String(err),
        });
      }
    }

    if (promptsRecovered > 0 || activitiesRecovered > 0) {
      logger.info(LOG_KINDS.LIFECYCLE_RECONCILE, 'Buffer reconciliation complete', {
        session_id: sessionId,
        prompts_recovered: promptsRecovered,
        activities_recovered: activitiesRecovered,
      });
    }
  }

  // Route body schemas
  const RegisterBody = z.object({
    session_id: z.string(),
    agent: z.string().optional(),
    branch: z.string().optional(),
    started_at: z.string().optional(),
  });
  const UnregisterBody = z.object({ session_id: z.string() });
  const EventBody = z.object({ type: z.string(), session_id: z.string() }).passthrough();
  const StopBody = z.object({
    session_id: z.string(),
    user: z.string().optional(),
    transcript_path: z.string().optional(),
    last_assistant_message: z.string().optional(),
  });
  // --- Session routes ---

  server.registerRoute('POST', '/sessions/register', async (req) => {
    const { session_id, agent, branch, started_at } = RegisterBody.parse(req.body);
    const resolvedStartedAt = started_at ?? new Date().toISOString();
    registry.register(session_id, { started_at: resolvedStartedAt, branch });
    server.updateDaemonJsonSessions(registry.sessions);

    // Upsert session in SQLite — always reset to active on register
    const now = epochSeconds();
    const startedEpoch = Math.floor(new Date(resolvedStartedAt).getTime() / 1000);
    upsertSession({
      id: session_id,
      agent: agent ?? 'claude-code',
      user: null,
      project_root: process.cwd(),
      branch: branch ?? null,
      started_at: startedEpoch,
      created_at: now,
      status: 'active',
    });
    // Clear ended_at if session was previously completed (reload scenario)
    updateSession(session_id, { ended_at: null, status: 'active' });

    // Reconcile buffer against DB — recover prompts lost if daemon was down mid-session.
    reconcileSession(session_id);

    logger.info(LOG_KINDS.LIFECYCLE_REGISTER, 'Session registered', { session_id, branch, started_at: started_at ?? null });
    return { body: { ok: true, sessions: registry.sessions } };
  });

  server.registerRoute('POST', '/sessions/unregister', async (req) => {
    const { session_id } = UnregisterBody.parse(req.body);
    registry.unregister(session_id);
    // Opportunistically clean stale buffers for OTHER sessions (>24h).
    // We do NOT delete THIS session's buffer — session reload reuses the same ID.
    cleanStaleBuffers(bufferDir, STALE_BUFFER_MAX_AGE_MS, session_id);
    // Close the session in SQLite — this is the authoritative end-of-session.
    // The Stop hook fires per-turn and does NOT close the session.
    closeSession(session_id, epochSeconds());

    // Prune in-memory state
    sessionBuffers.delete(session_id);
    sessionTitleCache.delete(session_id);
    reconciledSessions.delete(session_id);
    server.updateDaemonJsonSessions(registry.sessions);
    logger.info(LOG_KINDS.LIFECYCLE_UNREGISTER, 'Session unregistered', { session_id });
    return { body: { ok: true, sessions: registry.sessions } };
  });

  // --- Event routes ---

  server.registerRoute('POST', '/events', async (req) => {
    const validated = EventBody.parse(req.body);
    const event = { ...validated, timestamp: validated.timestamp ?? new Date().toISOString() } as Record<string, unknown> & { type: string; session_id: string; timestamp: string };
    logger.debug(LOG_KINDS.HOOKS_EVENT, 'Event received', { type: event.type, session_id: event.session_id });

    // Ensure session is registered (idempotent — handles daemon restarts mid-session)
    if (!registry.getSession(event.session_id)) {
      registry.register(event.session_id, { started_at: event.timestamp });
      logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Auto-registered session from event', { session_id: event.session_id });

      // Ensure SQLite session exists — explicitly set status='active' so
      // resumed sessions (previously 'completed') get reopened.
      const now = epochSeconds();
      const startedEpoch = Math.floor(new Date(event.timestamp).getTime() / 1000);
      upsertSession({
        id: event.session_id,
        agent: (event as Record<string, unknown>).agent as string ?? 'claude-code',
        status: 'active',
        started_at: startedEpoch,
        created_at: now,
      });

      // Reconcile buffer against DB — recover any prompts lost during downtime.
      reconcileSession(event.session_id);
    }

    // Persist to disk so events survive daemon restarts
    if (!sessionBuffers.has(event.session_id)) {
      sessionBuffers.set(event.session_id, new EventBuffer(bufferDir, event.session_id));
    }
    sessionBuffers.get(event.session_id)!.append(event);

    // --- Prompt batch tracking ---
    if (event.type === 'user_prompt') {
      const promptText = String(event.prompt ?? '');

      // Skip system-injected messages (task notifications, system reminders) —
      // they trigger UserPromptSubmit but are not real user prompts.
      if (isSystemMessage(promptText)) {
        logger.debug(LOG_KINDS.HOOKS_PROMPT, 'Skipped system-injected message', {
          session_id: event.session_id,
          prefix: promptText.trimStart().slice(0, LOG_PROMPT_PREVIEW_CHARS),
        });
      } else {
        logger.info(LOG_KINDS.HOOKS_PROMPT, 'User prompt received', {
          session_id: event.session_id,
          prompt_preview: promptText.slice(0, LOG_PROMPT_PREVIEW_CHARS),
          prompt_length: promptText.length,
        });
        try {
          const { batchId, promptNumber } = handleUserPrompt(event.session_id, promptText || undefined);
          logger.debug(LOG_KINDS.CAPTURE_BATCH, 'Batch opened', { session_id: event.session_id, batch_id: batchId, prompt_number: promptNumber });

          // Batch-threshold summary trigger
          const batchCount = promptNumber;
          const summaryInterval = config.agent.summary_batch_interval;
          if (summaryInterval > 0 && batchCount > 0 && batchCount % summaryInterval === 0) {
            triggerTitleSummary(event.session_id);
          }
        } catch (err) {
          logger.warn(LOG_KINDS.CAPTURE_BATCH, 'Failed to open batch', { session_id: event.session_id, error: (err as Error).message });
        }
      }
    }

    if (event.type === 'tool_use') {
      const toolName = String(event.tool_name ?? '');
      logger.debug(LOG_KINDS.HOOKS_TOOL, 'Tool use event', {
        session_id: event.session_id,
        tool_name: toolName,
      });
      // Plan capture — detect writes to watched directories (async, non-blocking)
      const planFilePath = isPlanWriteEvent(
        toolName,
        event.tool_input as Record<string, unknown> | undefined,
        planWatchConfig,
      );
      if (planFilePath) {
        const captureSessionId = event.session_id;
        fs.promises.readFile(planFilePath, 'utf-8').then((planContent) => {
          const latestBatch = getLatestBatch(captureSessionId);
          capturePlan({
            sourcePath: path.relative(projectRoot, planFilePath),
            content: planContent,
            sessionId: captureSessionId,
            promptBatchId: latestBatch?.id ?? null,
          });
          logger.info(LOG_KINDS.CAPTURE_PLAN, 'Plan captured', {
            session_id: captureSessionId,
            source_path: planFilePath,
          });
        }).catch((err) => {
          logger.warn(LOG_KINDS.CAPTURE_PLAN, 'Failed to capture plan', {
            error: (err as Error).message,
            path: planFilePath,
          });
        });
      }
      try {
        handleToolUse(
          event.session_id,
          toolName,
          event.tool_input,
          typeof event.output_preview === 'string' ? event.output_preview : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record activity', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'tool_failure') {
      const toolName = String(event.tool_name ?? '');
      logger.info(LOG_KINDS.HOOKS_TOOL, 'Tool failure event', {
        session_id: event.session_id,
        tool_name: toolName,
        is_interrupt: !!event.is_interrupt,
      });
      try {
        handleToolFailure(
          event.session_id,
          toolName,
          event.tool_input,
          typeof event.error === 'string' ? event.error : undefined,
          !!event.is_interrupt,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record tool failure', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'subagent_start') {
      logger.info(LOG_KINDS.HOOKS_SUBAGENT, 'Subagent start event', {
        session_id: event.session_id,
        agent_id: event.agent_id,
        agent_type: event.agent_type,
      });
      try {
        handleSubagentStart(
          event.session_id,
          typeof event.agent_id === 'string' ? event.agent_id : undefined,
          typeof event.agent_type === 'string' ? event.agent_type : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record subagent start', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'subagent_stop') {
      logger.info(LOG_KINDS.HOOKS_SUBAGENT, 'Subagent stop event', {
        session_id: event.session_id,
        agent_id: event.agent_id,
        agent_type: event.agent_type,
      });
      try {
        handleSubagentStop(
          event.session_id,
          typeof event.agent_id === 'string' ? event.agent_id : undefined,
          typeof event.agent_type === 'string' ? event.agent_type : undefined,
          typeof event.last_assistant_message === 'string' ? event.last_assistant_message : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record subagent stop', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'stop_failure') {
      logger.warn(LOG_KINDS.HOOKS_STOP, 'Stop failure event', {
        session_id: event.session_id,
        error: event.error,
      });
      try {
        handleStopFailure(
          event.session_id,
          typeof event.error === 'string' ? event.error : undefined,
          typeof event.error_details === 'string' ? event.error_details : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record stop failure', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'task_completed') {
      logger.info(LOG_KINDS.HOOKS_EVENT, 'Task completed event', {
        session_id: event.session_id,
        task_id: event.task_id,
        task_subject: event.task_subject,
      });
      try {
        handleTaskCompleted(
          event.session_id,
          typeof event.task_id === 'string' ? event.task_id : undefined,
          typeof event.task_subject === 'string' ? event.task_subject : undefined,
          typeof event.task_description === 'string' ? event.task_description : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record task completion', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'pre_compact') {
      logger.info(LOG_KINDS.HOOKS_EVENT, 'Pre-compact event', { session_id: event.session_id });
      try {
        handleCompact(
          event.session_id,
          'pre',
          typeof event.trigger === 'string' ? event.trigger : undefined,
          undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record pre-compact', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'post_compact') {
      logger.info(LOG_KINDS.HOOKS_EVENT, 'Post-compact event', { session_id: event.session_id });
      try {
        handleCompact(
          event.session_id,
          'post',
          typeof event.trigger === 'string' ? event.trigger : undefined,
          typeof event.compact_summary === 'string' ? event.compact_summary : undefined,
        );
      } catch (err) {
        logger.warn(LOG_KINDS.CAPTURE_ACTIVITY, 'Failed to record post-compact', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    return { body: { ok: true } };
  });

  // --- Stop route ---

  server.registerRoute('POST', '/events/stop', async (req) => {
    const { session_id: sessionId, user, transcript_path: hookTranscriptPath, last_assistant_message: lastAssistantMessage } = StopBody.parse(req.body);
    // Ensure session is registered (handles daemon restarts mid-session)
    if (!registry.getSession(sessionId)) {
      registry.register(sessionId, { started_at: new Date().toISOString() });
      logger.debug(LOG_KINDS.LIFECYCLE_AUTO_REGISTER, 'Auto-registered session from stop event', { session_id: sessionId });
    }
    const sessionMeta = registry.getSession(sessionId);
    logger.info(LOG_KINDS.HOOKS_STOP, 'Stop received', {
      session_id: sessionId,
      has_transcript_path: !!hookTranscriptPath,
      has_response: !!lastAssistantMessage,
    });
    logger.debug(LOG_KINDS.HOOKS_STOP, 'Stop event detail', {
      session_id: sessionId,
      transcript_path: hookTranscriptPath ?? null,
      last_message_preview: lastAssistantMessage?.slice(0, LOG_MESSAGE_PREVIEW_CHARS) ?? null,
    });

    // Respond immediately — the hook should not block on processing.
    const run = () => processStopEvent(sessionId, user, sessionMeta, hookTranscriptPath, lastAssistantMessage).catch((err) => {
      logger.error(LOG_KINDS.PROCESSOR_SESSION, 'Stop processing failed', { session_id: sessionId, error: (err as Error).message });
    });

    const prev = activeStopProcessing ?? Promise.resolve();
    activeStopProcessing = prev.then(run).finally(() => { activeStopProcessing = null; });

    return { body: { ok: true } };
  });

  /** Correlate buffer tool_use events with transcript turns by timestamp to populate toolBreakdown and files. */
  function enrichTurnsWithToolMetadata(turns: TranscriptTurn[], events: Array<Record<string, unknown>>): void {
    if (events.length === 0 || turns.length === 0) return;

    const toolEvents = events.filter((e) => e.type === 'tool_use');
    if (toolEvents.length === 0) return;

    let cursor = 0;
    for (let i = 0; i < turns.length; i++) {
      const turnEnd = i + 1 < turns.length ? turns[i + 1].timestamp : null;
      const breakdown: Record<string, number> = {};
      const files = new Set<string>();

      while (cursor < toolEvents.length) {
        const ts = String(toolEvents[cursor].timestamp ?? '');
        if (turnEnd !== null && ts >= turnEnd) break;
        const evt = toolEvents[cursor];
        const toolName = String(evt.tool_name ?? evt.tool ?? 'unknown');
        breakdown[toolName] = (breakdown[toolName] ?? 0) + 1;
        const input = evt.tool_input as Record<string, unknown> | undefined;
        const filePath = input?.file_path ?? input?.path;
        if (typeof filePath === 'string') files.add(filePath);
        cursor++;
      }

      if (Object.keys(breakdown).length > 0) {
        turns[i].toolBreakdown = breakdown;
        if (files.size > 0) turns[i].files = [...files];
      }
    }
  }

  async function processStopEvent(
    sessionId: string,
    user: string | undefined,
    sessionMeta: RegisteredSession | undefined,
    hookTranscriptPath?: string,
    lastAssistantMessage?: string,
  ): Promise<void> {

    // --- Phase 1: Gather transcript data ---

    const transcriptResult = transcriptMiner.getAllTurnsWithSource(sessionId, hookTranscriptPath);
    let allTurns = transcriptResult.turns;
    let turnSource = transcriptResult.source;

    const bufferEvents = sessionBuffers.get(sessionId)?.readAll() ?? [];

    if (allTurns.length === 0) {
      allTurns = extractTurnsFromBuffer(bufferEvents);
      turnSource = 'buffer';
    } else if (bufferEvents.length > 0) {
      const lastTranscriptTs = allTurns[allTurns.length - 1].timestamp;
      if (lastTranscriptTs) {
        const newerEvents = bufferEvents.filter((e) =>
          String(e.timestamp ?? '') > lastTranscriptTs,
        );
        if (newerEvents.length > 0) {
          const bufferTurns = extractTurnsFromBuffer(newerEvents);
          allTurns = [...allTurns, ...bufferTurns];
          turnSource = `${transcriptResult.source}+buffer`;
          logger.info(LOG_KINDS.PROCESSOR_TRANSCRIPT, 'Appended buffer turns missing from transcript', {
            session_id: sessionId, transcriptTurns: transcriptResult.turns.length, bufferTurns: bufferTurns.length,
          });
        }
      }
    }

    // Attach the last assistant message from the hook to the most recent turn
    if (lastAssistantMessage && allTurns.length > 0) {
      const lastTurn = allTurns[allTurns.length - 1];
      if (!lastTurn.aiResponse) {
        lastTurn.aiResponse = lastAssistantMessage;
      }
    }

    enrichTurnsWithToolMetadata(allTurns, bufferEvents);

    const imageCount = allTurns.reduce((sum, t) => sum + (t.images?.length ?? 0), 0);
    logger.debug(LOG_KINDS.PROCESSOR_TRANSCRIPT, 'Transcript parsed', {
      session_id: sessionId,
      turn_count: allTurns.length,
      image_count: imageCount,
    });

    // --- Phase 2: Capture response + close session ---

    // Get the latest batch BEFORE closing — this is the batch for the current turn.
    const latestBatch = getLatestBatch(sessionId);

    // Primary capture: put last_assistant_message directly on the latest batch.
    // No positional mapping needed — the hook gives us the response directly.
    if (lastAssistantMessage && latestBatch && !latestBatch.response_summary) {
      try { setResponseSummary(latestBatch.id, lastAssistantMessage); }
      catch (err) { logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Failed to set response_summary on latest batch', { error: String(err) }); }
    }

    // Close open batches but do NOT close the session — the Stop hook fires
    // after every assistant turn, not just session end. The session is closed
    // when the SessionEnd hook fires (via /sessions/unregister).
    closeOpenBatches(sessionId, epochSeconds());

    // Derive a simple title from the first user prompt — but only if the
    // session has no title yet. Once the LLM (or anything else) sets a title,
    // stop overwriting it with the fallback.
    const existingSession = getSession(sessionId);
    const hasTitle = existingSession?.title !== null && existingSession?.title !== undefined;

    if (!hasTitle) {
      let title = sessionTitleCache.get(sessionId) ?? null;
      if (!title) {
        const firstBatch = listBatchesBySession(sessionId, { limit: 1 })[0];
        if (firstBatch?.user_prompt) {
          title = firstBatch.user_prompt.slice(0, TITLE_PREVIEW_CHARS);
          if (firstBatch.user_prompt.length > TITLE_PREVIEW_CHARS) {
            title += '...';
          }
          sessionTitleCache.set(sessionId, title);
        }
      }
    }

    // Update session with transcript metadata (no LLM calls)
    const updateFields: Record<string, unknown> = {
      transcript_path: hookTranscriptPath ?? null,
      prompt_count: allTurns.length,
      tool_count: allTurns.reduce((sum, t) => sum + t.toolCount, 0),
    };
    if (user) updateFields.user = user;
    if (!hasTitle && sessionTitleCache.has(sessionId)) {
      updateFields.title = sessionTitleCache.get(sessionId);
    }

    updateSession(sessionId, updateFields as Parameters<typeof updateSession>[1]);

    // Enhanced capture: populate response_summary on earlier batches from transcript.
    // Maps by batch insertion order (id ASC) to transcript turn position.
    // This is best-effort — the parser may skip empty-text turns, causing misalignment.
    // The primary capture (above) handles the current turn reliably.
    const responses: Array<{ turnIndex: number; response: string }> = [];
    for (let i = 0; i < allTurns.length; i++) {
      if (allTurns[i].aiResponse) {
        responses.push({ turnIndex: i + 1, response: allTurns[i].aiResponse! });
      }
    }
    if (responses.length > 0) {
      try { populateBatchResponses(sessionId, responses); }
      catch (err) { logger.warn(LOG_KINDS.PROCESSOR_BATCH, 'Failed to populate batch responses', { error: String(err) }); }
    }

    // Trigger title/summary if the session still needs one.
    if (!hasTitle) {
      triggerTitleSummary(sessionId);
    }

    // Write images to attachments — decoupled from transcript turn indices.
    // After context compaction, transcript turn indices no longer match batch prompt_numbers.
    // Instead, match each turn to its batch by prompt text (content-based, not position-based).
    // Binary data is stored in the DB BLOB column; DB uses ON CONFLICT DO NOTHING → idempotent.
    const sessionShort = sessionId.slice(-6);
    for (let i = 0; i < allTurns.length; i++) {
      const turn = allTurns[i];
      if (!turn.images?.length) continue;

      // Resolve which batch this turn belongs to:
      // 1. Last turn → use latestBatch (always correct, comes from the current stop event)
      // 2. Earlier turns → match by prompt text prefix against DB
      // 3. Fallback → null batch_id (still saved, UI matches by filename pattern)
      const isLastTurn = i === allTurns.length - 1;
      let resolvedBatchId: number | null = null;
      let resolvedPromptNumber: number = i + 1; // default to turn index (pre-compaction compatible)

      if (isLastTurn && latestBatch) {
        resolvedBatchId = latestBatch.id;
        resolvedPromptNumber = latestBatch.prompt_number ?? resolvedPromptNumber;
      } else if (turn.prompt) {
        try {
          const match = findBatchByPromptPrefix(sessionId, turn.prompt);
          if (match) {
            resolvedBatchId = match.id;
            resolvedPromptNumber = match.prompt_number;
          }
        } catch { /* fallback to index-based */ }
      }

      for (let j = 0; j < turn.images.length; j++) {
        const img = turn.images[j];
        const ext = extensionForMimeType(img.mediaType);
        const filename = `${sessionShort}-t${resolvedPromptNumber}-${j + 1}.${ext}`;
        const imageBuffer = Buffer.from(img.data, 'base64');
        try {
          insertAttachment({
            id: `${sessionShort}-b${resolvedPromptNumber}-${j + 1}`,
            session_id: sessionId,
            prompt_batch_id: resolvedBatchId ?? undefined,
            file_path: filename,
            media_type: img.mediaType,
            data: imageBuffer,
            created_at: epochSeconds(),
          });
          logger.debug(LOG_KINDS.CAPTURE_ATTACHMENT, 'Image stored in DB', { filename, batch: resolvedPromptNumber });
        } catch (err) {
          logger.warn(LOG_KINDS.CAPTURE_ATTACHMENT, 'Failed to record attachment', { error: String(err) });
        }
      }
    }

    logger.info(LOG_KINDS.PROCESSOR_SESSION, 'Session captured', {
      session_id: sessionId,
      turns: allTurns.length,
      source: turnSource,
      title: existingSession?.title ?? sessionTitleCache.get(sessionId) ?? '(untitled)',
    });
  }

  // --- Context injection (digest + semantic spore search) ---
  const contextDeps = { embeddingManager, config, logger };
  server.registerRoute('POST', '/context', createSessionContextHandler(contextDeps));
  server.registerRoute('POST', '/context/prompt', createPromptContextHandler(contextDeps));

  // --- Dashboard API routes ---
  const progressTracker = new ProgressTracker();
  let configHash = computeConfigHash(vaultDir);

  server.registerRoute('GET', '/api/config', async () => handleGetConfig(vaultDir));
  server.registerRoute('GET', '/api/symbionts', handleListSymbionts);
  server.registerRoute('PUT', '/api/config', async (req) => {
    const result = await handlePutConfig(vaultDir, req.body);
    if (!result.status || result.status < 400) {
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

  server.registerRoute('GET', '/api/config/plan-dirs', async () => {
    return { body: { symbiont: symbiontPlanDirsByAgent, custom: planWatchConfig.watchDirs.filter((d) => !symbiontPlanDirs.includes(d)) } };
  });

  server.registerRoute('POST', '/api/config/plan-dirs', async (req) => {
    const body = req.body as { plan_dirs: string[] };
    if (!Array.isArray(body.plan_dirs)) {
      return { status: 400, body: { error: 'plan_dirs must be an array' } };
    }
    const updated = updateConfig(vaultDir, (cfg) => ({
      ...cfg,
      capture: { ...cfg.capture, plan_dirs: body.plan_dirs },
    }));
    // Refresh in-memory config so plan capture picks up new dirs immediately
    planWatchConfig = { ...planWatchConfig, watchDirs: [...new Set([...symbiontPlanDirs, ...body.plan_dirs])] };
    return { body: { custom: updated.capture.plan_dirs } };
  });

  // V2 stats — vault counts, embedding coverage, agent status, digest freshness
  server.registerRoute('GET', '/api/stats', async () => {
    const stats = gatherStats(vaultDir, { active_sessions: registry.sessions });
    // Overlay live daemon fields from the running process (more accurate than daemon.json)
    stats.daemon.pid = process.pid;
    stats.daemon.port = server.port;
    stats.daemon.version = server.version;
    stats.daemon.uptime_seconds = Math.floor(process.uptime());
    return { body: { ...stats, config_hash: configHash } };
  });

  server.registerRoute('GET', '/api/logs/search', handleLogSearch);
  server.registerRoute('GET', '/api/logs/stream', handleLogStream);
  server.registerRoute('GET', '/api/logs/:id', handleLogDetail);

  // External log ingestion: allows MCP server (separate process) to write through the daemon logger
  const ExternalLogBody = z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    component: z.string(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  });

  server.registerRoute('POST', '/api/log', async (req) => {
    const { level, component, message, data } = ExternalLogBody.parse(req.body);
    logger.log(level, LOG_KINDS.MCP_EVENT, message, { ...data, mcp_component: component });
    return { body: { ok: true } };
  });

  server.registerRoute('GET', '/api/models', async (req) => handleGetModels(req));
  server.registerRoute('POST', '/api/restart', async (req) => handleRestart({ vaultDir, progressTracker }, req.body));
  server.registerRoute('GET', '/api/progress/:token', async (req) => handleGetProgress(progressTracker, req.params.token));

  server.registerRoute('GET', '/api/sessions', handleListSessions);

  server.registerRoute('GET', '/api/sessions/:id', handleGetSession);
  server.registerRoute('GET', '/api/sessions/:id/impact', async (req) => {
    const sessionId = req.params.id;
    const session = getSession(sessionId);
    if (!session) return { status: 404, body: { error: 'Session not found' } };
    const impact = getSessionImpact(sessionId);
    return { body: impact };
  });

  server.registerRoute('DELETE', '/api/sessions/:id', async (req) => {
    const sessionId = req.params.id;
    const result = deleteSessionCascade(sessionId);
    if (!result.deleted) return { status: 404, body: { error: 'Session not found' } };

    // Post-transaction cleanup (fire-and-forget)
    cleanupAfterSessionCascade(sessionId, result, embeddingManager, vaultDir).catch(() => {});

    logger.info(LOG_KINDS.API_SESSION_DELETE, 'Session cascade deleted', {
      session_id: sessionId,
      counts: result.counts,
    });
    return { body: { ok: true, counts: result.counts } };
  });
  server.registerRoute('GET', '/api/sessions/:id/batches', handleGetSessionBatches);
  server.registerRoute('GET', '/api/batches/:id/activities', handleGetBatchActivities);
  server.registerRoute('GET', '/api/sessions/:id/attachments', handleGetSessionAttachments);
  server.registerRoute('GET', '/api/sessions/:id/plans', handleGetSessionPlans);

  // --- Mycelium API routes ---
  server.registerRoute('GET', '/api/spores', handleListSpores);
  server.registerRoute('GET', '/api/spores/:id', handleGetSpore);
  server.registerRoute('GET', '/api/entities', handleListEntities);
  server.registerRoute('GET', '/api/graph', handleGetFullGraph);
  server.registerRoute('GET', '/api/graph/:id', handleGetGraph);
  server.registerRoute('GET', '/api/digest', handleGetDigest);

  /** Media type lookup for attachment file serving. */
  const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };

  server.registerRoute('GET', '/api/attachments/:filename', async (req) => {
    const filename = req.params.filename;
    // Prevent path traversal
    if (filename.includes('..') || filename.includes('/')) {
      return { status: 400, body: { error: 'invalid_filename' } };
    }

    // Try DB first (new path)
    const att = getAttachmentByFilePath(filename);
    if (att?.data) {
      const contentType = att.media_type ?? 'application/octet-stream';
      return { status: 200, headers: { 'Content-Type': contentType }, body: att.data };
    }

    // Fallback to disk for pre-migration attachments
    const filePath = path.join(vaultDir, 'attachments', filename);
    let diskData: Buffer;
    try {
      diskData = fs.readFileSync(filePath);
    } catch {
      return { status: 404, body: { error: 'not_found' } };
    }
    const ext = path.extname(filename).slice(1).toLowerCase();
    const contentType = ATTACHMENT_MEDIA_TYPES[ext] ?? 'application/octet-stream';
    return { status: 200, headers: { 'Content-Type': contentType }, body: diskData };
  });

  // --- Agent API routes ---

  const AgentRunBody = z.object({
    task: z.string().optional(),
    instruction: z.string().optional(),
    agentId: z.string().optional(),
  });

  server.registerRoute('POST', '/api/agent/run', async (req) => {
    const { task, instruction, agentId } = AgentRunBody.parse(req.body);

    const { runAgent } = await import('../agent/executor.js');
    const resultPromise = runAgent(vaultDir, { task, instruction, agentId, embeddingManager });

    // runAgent inserts the run synchronously before the first await,
    // so by the time it yields, the run is already in the DB.
    const effectiveAgentId = agentId ?? 'myco-agent';
    const latestRun = getRunningRun(effectiveAgentId);
    const runId = latestRun?.id;

    resultPromise
      .then((result) => {
        if (result.status === 'failed') {
          logger.error(LOG_KINDS.AGENT_ERROR, 'Agent run failed', {
            runId: result.runId,
            error: result.error ?? 'No error message',
            phases: result.phases?.map(p => `${p.name}:${p.status}`) ?? [],
          });
        } else {
          logger.info(LOG_KINDS.AGENT_RUN, 'Agent run completed', {
            runId: result.runId,
            status: result.status,
            phases: result.phases?.map(p => `${p.name}:${p.status}`) ?? [],
          });
        }
      })
      .catch((err) => {
        logger.error(LOG_KINDS.AGENT_ERROR, 'Agent run threw unhandled error', {
          error: (err as Error).message ?? String(err),
          stack: (err as Error).stack?.split('\n').slice(0, 3).join(' | '),
        });
      });

    return { body: { ok: true, message: 'Agent started', runId } };
  });

  server.registerRoute('GET', '/api/agent/runs', async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : AGENT_RUNS_DEFAULT_LIMIT;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const agentId = req.query.agentId || undefined;
    const status = req.query.status || undefined;
    const task = req.query.task || undefined;
    const search = req.query.search || undefined;

    const filterOpts = { agent_id: agentId, status, task, search };
    const runs = listRuns({ ...filterOpts, limit, offset });
    const total = countRuns(filterOpts);

    return { body: { runs, total, offset, limit } };
  });

  server.registerRoute('GET', '/api/agent/runs/:id', async (req) => {
    const run = getRun(req.params.id);
    if (!run) {
      return { status: 404, body: { error: 'Run not found' } };
    }
    return { body: { run } };
  });

  server.registerRoute('GET', '/api/agent/runs/:id/reports', async (req) => {
    const reports = listReports(req.params.id);
    return { body: { reports } };
  });

  server.registerRoute('GET', '/api/agent/runs/:id/turns', async (req) => {
    const turns = listTurnsByRun(req.params.id);
    return { body: turns };
  });

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

  const SPORE_ID_RANDOM_BYTES = 4;
  const RESOLUTION_ID_RANDOM_BYTES = 8;

  const RememberBody = z.object({
    content: z.string(),
    type: z.string().optional(),
    tags: z.array(z.string()).optional(),
  });

  server.registerRoute('POST', '/api/mcp/remember', async (req) => {
    const { content, type, tags } = RememberBody.parse(req.body);
    const { randomBytes } = await import('node:crypto');

    const observationType = type ?? 'discovery';
    const id = `${observationType}-${randomBytes(SPORE_ID_RANDOM_BYTES).toString('hex')}`;
    const now = epochSeconds();

    // Ensure the user agent exists (idempotent upsert)
    registerAgent({
      id: USER_AGENT_ID,
      name: USER_AGENT_NAME,
      created_at: now,
    });

    const spore = insertSpore({
      id,
      agent_id: USER_AGENT_ID,
      observation_type: observationType,
      content,
      tags: tags ? tags.join(', ') : null,
      created_at: now,
    });

    embeddingManager.onContentWritten('spores', spore.id, content, {
      status: 'active',
      observation_type: observationType,
    }).catch(() => {});

    return {
      body: {
        id: spore.id,
        observation_type: spore.observation_type,
        status: spore.status,
        created_at: spore.created_at,
      },
    };
  });

  server.registerRoute('GET', '/api/mcp/plans', async (req) => {
    const statusFilter = req.query.status === 'all' ? undefined : req.query.status;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const rows = listPlans({ status: statusFilter, limit });

    const plans = rows.map((row) => {
      const content = row.content ?? '';
      const checked = (content.match(/- \[x\]/gi) ?? []).length;
      const unchecked = (content.match(/- \[ \]/g) ?? []).length;
      const total = checked + unchecked;
      const progress = total === 0 ? 'N/A' : `${checked}/${total}`;

      return {
        id: row.id,
        title: row.title,
        status: row.status,
        progress,
        tags: row.tags ? row.tags.split(',').map((t) => t.trim()) : [],
        created_at: row.created_at,
      };
    });

    return { body: { plans } };
  });

  server.registerRoute('GET', '/api/mcp/sessions', async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const status = req.query.status;

    const rows = listSessions({ limit, status });
    const sessions = rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      user: row.user,
      branch: row.branch,
      started_at: row.started_at,
      ended_at: row.ended_at,
      status: row.status,
      title: row.title,
      summary: (row.summary ?? '').slice(0, 300),
      prompt_count: row.prompt_count,
      tool_count: row.tool_count,
      parent_session_id: row.parent_session_id,
    }));

    return { body: { sessions } };
  });

  server.registerRoute('GET', '/api/mcp/team', async () => {
    const teamDb = getDatabase();
    const rows = teamDb.prepare(
      `SELECT id, "user", role, joined, tags
       FROM team_members
       ORDER BY id ASC`,
    ).all() as Array<Record<string, unknown>>;

    const members = rows.map((row) => ({
      id: row.id as string,
      user: row.user as string,
      role: (row.role as string) ?? null,
      joined: (row.joined as string) ?? null,
      tags: row.tags ? (row.tags as string).split(',').map((t) => t.trim()) : [],
    }));

    return { body: { members } };
  });

  const SupersedeBody = z.object({
    old_spore_id: z.string(),
    new_spore_id: z.string(),
    reason: z.string().optional(),
  });

  server.registerRoute('POST', '/api/mcp/supersede', async (req) => {
    const { old_spore_id, new_spore_id, reason } = SupersedeBody.parse(req.body);
    const { randomBytes } = await import('node:crypto');
    const now = epochSeconds();

    // Update status to superseded
    updateSporeStatus(old_spore_id, 'superseded', now);
    try { embeddingManager.onStatusChanged('spores', old_spore_id, 'superseded'); } catch { /* best-effort */ }

    // Ensure user agent exists (idempotent)
    registerAgent({
      id: USER_AGENT_ID,
      name: USER_AGENT_NAME,
      created_at: now,
    });

    // Record resolution event for audit trail
    const { insertResolutionEvent } = await import('../db/queries/resolution-events.js');
    const resolutionId = `res-${randomBytes(RESOLUTION_ID_RANDOM_BYTES).toString('hex')}`;

    insertResolutionEvent({
      id: resolutionId,
      agent_id: USER_AGENT_ID,
      spore_id: old_spore_id,
      action: 'supersede',
      new_spore_id,
      reason: reason ?? null,
      created_at: now,
    });

    return {
      body: {
        old_spore: old_spore_id,
        new_spore: new_spore_id,
        status: 'superseded' as const,
      },
    };
  });

  // --- Backup routes ---
  const backupDir = config.backup.dir
    ? path.resolve(config.backup.dir)
    : path.resolve(vaultDir, 'backups');
  const backupHandlers = createBackupHandlers({ db, backupDir, machineId });
  server.registerRoute('POST', '/api/backup', backupHandlers.handleCreateBackup);
  server.registerRoute('GET', '/api/backups', backupHandlers.handleListBackups);
  server.registerRoute('POST', '/api/restore/preview', backupHandlers.handleRestorePreview);
  server.registerRoute('POST', '/api/restore', backupHandlers.handleRestore);

  server.registerRoute('GET', '/api/backup/config', async () => {
    const cfg = loadConfig(vaultDir);
    return { body: { dir: cfg.backup.dir ?? null, default_dir: path.resolve(vaultDir, 'backups') } };
  });

  server.registerRoute('PUT', '/api/backup/config', async (req) => {
    const { dir } = req.body as { dir?: string | null };
    updateBackupConfig(vaultDir, { dir: dir || undefined });
    return { body: { dir: dir || null } };
  });

  // --- Team sync routes ---
  let teamClient: TeamSyncClient | null = null;

  // Initialize team client from saved config if team sync is enabled
  if (config.team.enabled && config.team.worker_url) {
    const secrets = readSecrets(vaultDir);
    const teamApiKey = secrets['MYCO_TEAM_API_KEY'];
    if (teamApiKey) {
      teamClient = new TeamSyncClient({
        workerUrl: config.team.worker_url,
        apiKey: teamApiKey,
        machineId,
        syncProtocolVersion: SYNC_PROTOCOL_VERSION,
      });
      logger.info(LOG_KINDS.TEAM_SYNC_START, 'Team sync client initialized', { worker_url: config.team.worker_url });

      // Register this node with the team worker (fire-and-forget)
      teamClient.connect({
        machine_id: machineId,
        version: server.version,
      }).then(() => {
        logger.info(LOG_KINDS.TEAM_SYNC_START, 'Node registered with team worker');
      }).catch((err) => {
        logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, 'Node registration failed (will retry on next flush)', { error: (err as Error).message });
      });

      // Backfill unsynced records into outbox (fire-and-forget — can be large)
      setTimeout(() => {
        try {
          const backfilled = backfillUnsynced(machineId);
          if (backfilled > 0) {
            logger.info(LOG_KINDS.TEAM_SYNC_START, `Backfilled ${backfilled} unsynced records into outbox`);
          }
        } catch (err) {
          logger.error(LOG_KINDS.TEAM_SYNC_ERROR, 'Backfill failed', { error: (err as Error).message });
        }
      }, 0);
    }
  }

  const teamHandlers = createTeamHandlers({
    vaultDir,
    machineId,
    getTeamClient: () => teamClient,
    setTeamClient: (c) => { teamClient = c; },
  });
  server.registerRoute('POST', '/api/team/connect', teamHandlers.handleConnect);
  server.registerRoute('POST', '/api/team/disconnect', teamHandlers.handleDisconnect);
  server.registerRoute('GET', '/api/team/status', teamHandlers.handleStatus);

  server.registerRoute('POST', '/api/team/backfill', async () => {
    const count = backfillUnsynced(machineId);
    return { body: { enqueued: count } };
  });

  // --- Search, activity feed, and embedding status ---

  server.registerRoute('GET', '/api/search', createSearchHandler({ embeddingManager, getTeamClient: () => teamClient, machineId }));
  server.registerRoute('GET', '/api/activity', handleGetFeed);
  server.registerRoute('GET', '/api/embedding/status', async () => handleGetEmbeddingStatus(vaultDir));
  server.registerRoute('GET', '/api/embedding/details', async () => handleEmbeddingDetails(embeddingManager));
  server.registerRoute('POST', '/api/embedding/rebuild', async () => handleEmbeddingRebuild(embeddingManager));
  server.registerRoute('POST', '/api/embedding/reconcile', async () => handleEmbeddingReconcile(embeddingManager));
  server.registerRoute('POST', '/api/embedding/clean-orphans', async () => handleEmbeddingCleanOrphans(embeddingManager));
  server.registerRoute('POST', '/api/embedding/reembed-stale', async () => handleEmbeddingReembedStale(embeddingManager));

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

  let reconcileRunning = false;
  powerManager.register({
    name: 'embedding-reconcile',
    runIn: ['active', 'idle'],
    fn: async () => {
      if (reconcileRunning) return;
      reconcileRunning = true;
      try {
        await embeddingManager.reconcile(EMBEDDING_BATCH_SIZE);
      } finally {
        reconcileRunning = false;
      }
    },
  });

  powerManager.register({
    name: 'session-maintenance',
    runIn: ['active', 'idle', 'sleep'],
    fn: () => runSessionMaintenance({
      logger,
      registeredSessionIds: () => registry.sessions,
      embeddingManager,
      vaultDir,
    }),
  });

  // Agent auto-run: only when enabled, with its own interval guard.
  // Runs on the PowerManager tick but skips unless enough time has elapsed
  // since the last run (config.agent.interval_seconds).
  if (config.agent.auto_run) {
    let agentRunning = false;
    const agentIntervalMs = config.agent.interval_seconds * MS_PER_SECOND;

    // Seed lastAgentRun from the most recent completed/failed run so daemon
    // restarts don't immediately re-trigger the agent.
    const lastRunRow = getDatabase().prepare(
      `SELECT started_at FROM agent_runs WHERE agent_id = ? AND status IN ('completed', 'failed') ORDER BY started_at DESC LIMIT 1`,
    ).get(DEFAULT_AGENT_ID) as { started_at: number } | undefined;
    let lastAgentRun = lastRunRow ? lastRunRow.started_at * MS_PER_SECOND : 0;

    powerManager.register({
      name: 'agent-auto-run',
      runIn: ['active', 'idle'],
      fn: async () => {
        if (agentRunning) return;
        if (Date.now() - lastAgentRun < agentIntervalMs) return;

        // Pre-check: only spawn agent if there's unprocessed work
        const agentDb = getDatabase();
        const checkRow = agentDb.prepare('SELECT COUNT(*) as count FROM prompt_batches WHERE processed = 0').get() as { count: number };
        const count = Number(checkRow.count);
        if (count === 0) {
          logger.debug(LOG_KINDS.AGENT_AUTO_RUN, 'No unprocessed batches, skipping cycle');
          return;
        }

        agentRunning = true;
        lastAgentRun = Date.now();
        try {
          logger.info(LOG_KINDS.AGENT_AUTO_RUN, 'Unprocessed batches found, starting agent', { count });
          const { runAgent } = await import('../agent/executor.js');
          const runResult = await runAgent(vaultDir, { embeddingManager });
          logger.info(LOG_KINDS.AGENT_RUN, 'Agent run completed', { status: runResult.status, runId: runResult.runId });
        } catch (err) {
          logger.error(LOG_KINDS.AGENT_ERROR, 'Agent auto-run failed', { error: (err as Error).message });
        } finally {
          agentRunning = false;
        }
      },
    });
  } else {
    logger.info(LOG_KINDS.AGENT_AUTO_RUN, 'Auto-agent disabled (agent.auto_run = false)');
  }

  powerManager.register({
    name: 'log-retention',
    runIn: ['idle', 'sleep'],
    fn: async () => {
      const retentionDays = config.daemon.log_retention_days;
      const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY).toISOString();
      const deleted = deleteOldLogs(cutoff);
      if (deleted > 0) {
        logger.info(LOG_KINDS.LOG_RETENTION, `Deleted ${deleted} log entries older than ${retentionDays} days`, { deleted, retention_days: retentionDays });
      }
    },
  });

  // Auto-backup: create a local SQL dump during idle/sleep cycles
  powerManager.register({
    name: 'auto-backup',
    runIn: ['idle', 'sleep'],
    fn: async () => {
      try {
        logger.info(LOG_KINDS.BACKUP_START, 'Auto-backup starting');
        const filePath = createBackup(db, backupDir, machineId);
        logger.info(LOG_KINDS.BACKUP_COMPLETE, 'Auto-backup complete', { file_path: filePath });
      } catch (err) {
        logger.error(LOG_KINDS.BACKUP_ERROR, 'Auto-backup failed', { error: (err as Error).message });
      }
    },
  });

  // Team outbox flush: push pending records to the team worker
  if (config.team.enabled) {
    powerManager.register({
      name: 'team-sync-flush',
      runIn: ['active', 'idle'],
      fn: async () => {
        const client = teamClient;
        if (!client) return;

        try {
          const pending = listPending();
          if (pending.length === 0) return;

          logger.info(LOG_KINDS.TEAM_SYNC_START, 'Flushing outbox', { count: pending.length });
          const result = await client.pushBatch(pending);

          // Mark successfully synced records as sent
          if (result.synced > 0 || result.skipped > 0) {
            // Identify which records failed so we only mark the successes
            const failedIds = new Set(result.errors.map((e) => e.id));
            const sentIds = pending.filter((r) => !failedIds.has(String(r.row_id))).map((r) => r.id);
            if (sentIds.length > 0) {
              markSent(sentIds, epochSeconds());
            }
          }

          if (result.errors.length > 0) {
            logger.warn(LOG_KINDS.TEAM_SYNC_ERROR, `Sync errors: ${result.errors.length}`, {
              errors: result.errors.slice(0, 5),
            });
          }

          pruneOld();
          logger.info(LOG_KINDS.TEAM_SYNC_COMPLETE, 'Outbox flush complete', {
            synced: result.synced, skipped: result.skipped, errors: result.errors.length, total: pending.length,
          });
        } catch (err) {
          logger.error(LOG_KINDS.TEAM_SYNC_ERROR, 'Outbox flush failed', { error: (err as Error).message });
        }
      },
    });
  }

  powerManager.start();

  // --- Shutdown ---

  const shutdown = async (signal: string) => {
    logger.info(LOG_KINDS.DAEMON_START, `${signal} received`);
    powerManager.stop();
    // Wait for any active stop processing to finish before shutting down
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
