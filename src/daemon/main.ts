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
import { loadConfig, saveConfig } from '../config/loader.js';
import { resolvePort } from './port.js';
import { TranscriptMiner, extractTurnsFromBuffer } from '../capture/transcript-miner.js';
import { createPerProjectAdapter, extensionForMimeType, type TranscriptTurn } from '../symbionts/adapter.js';
import { claudeCodeAdapter } from '../symbionts/claude-code.js';
import { findPackageRoot } from '../utils/find-package-root.js';
import { EventBuffer } from '../capture/buffer.js';
import { PlanWatcher } from './watcher.js';
import type { RegisteredSession } from './lifecycle.js';
import { handleGetConfig, handlePutConfig } from './api/config.js';
import { handleGetLogs } from './api/logs.js';
import { handleRestart } from './api/restart.js';
import { ProgressTracker, handleGetProgress } from './api/progress.js';
import { handleGetModels } from './api/models.js';
import { computeConfigHash } from './api/stats.js';
import {
  handleGetSession,
  handleGetSessionBatches,
  handleGetBatchActivities,
  handleGetSessionAttachments,
} from './api/sessions.js';
import {
  handleListSpores,
  handleGetSpore,
  handleListEntities,
  handleGetGraph,
  handleGetDigest,
} from './api/mycelium.js';
import { createSearchHandler } from './api/search.js';
import { handleGetFeed } from './api/feed.js';
import { handleGetEmbeddingStatus } from './api/embedding.js';
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
} from './api/agent-tasks.js';
import { listTurnsByRun } from '../db/queries/turns.js';
import { gatherStats } from '../services/stats.js';
import { initDatabase, vaultDbPath, closeDatabase, getDatabase } from '../db/client.js';
import { createSchema } from '../db/schema.js';
import { upsertSession, closeSession, updateSession, listSessions, getSession, deleteSession } from '../db/queries/sessions.js';
import { incrementActivityCount, populateBatchResponses, getBatchIdByPromptNumber, closeOpenBatches, insertBatchStateless, getLatestBatch, setResponseSummary } from '../db/queries/batches.js';
import { insertActivityWithBatch } from '../db/queries/activities.js';
import { insertAttachment } from '../db/queries/attachments.js';
import { listRuns, getRun, getRunningRun } from '../db/queries/runs.js';
import { listReports } from '../db/queries/reports.js';
import { insertSpore, updateSporeStatus } from '../db/queries/spores.js';
import { listPlans } from '../db/queries/plans.js';
import { registerAgent } from '../db/queries/agents.js';
import {
  DEFAULT_AGENT_ID,
  STALE_BUFFER_MAX_AGE_MS,
  LOG_PROMPT_PREVIEW_CHARS,
  LOG_MESSAGE_PREVIEW_CHARS,
  USER_AGENT_ID,
  USER_AGENT_NAME,
  EMBEDDING_INTERVAL_MS,
  EMBEDDING_BATCH_SIZE,
  epochSeconds,
} from '../constants.js';
import { createBatchLineage } from '../db/queries/lineage.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Seconds-to-milliseconds multiplier for config intervals. */
const SECONDS_TO_MS = 1000;

/** Default limit for listing agent runs in the API. */
const AGENT_RUNS_DEFAULT_LIMIT = 50;

/** Max chars of tool input stored in the activity row. */
const TOOL_INPUT_STORE_LIMIT = 4000;

/** Max chars of tool output summary stored in the activity row. */
const TOOL_OUTPUT_STORE_LIMIT = 2000;

/** Max chars for deriving a title from the first user prompt. */
const TITLE_PREVIEW_CHARS = 80;

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
 * Handle session stop: close all open batches, close session.
 *
 * Fully stateless — uses `closeOpenBatches` (blind UPDATE) instead of
 * reading from an in-memory map.
 */
export function handleSessionStop(
  sessionId: string,
): void {
  const now = epochSeconds();

  // Close all open batches for this session — blind UPDATE, no prior read
  closeOpenBatches(sessionId, now);

  // Close session
  closeSession(sessionId, now);
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
      logger.info('daemon', 'Killed stale daemon', { pid: info.pid });
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
  const config = loadConfig(vaultDir);

  const logger = new DaemonLogger(path.join(vaultDir, 'logs'), {
    level: config.daemon.log_level,
  });

  // Kill any stale daemon for this vault before starting
  killStaleDaemon(vaultDir, logger);

  logger.info('daemon', 'Config loaded', {
    vault: vaultDir,
    embedding_provider: config.embedding.provider,
  });

  // --- SQLite initialization ---
  const db = initDatabase(vaultDbPath(vaultDir));
  createSchema(db);
  logger.info('daemon', 'SQLite initialized', { vault: vaultDir });

  // --- Embedding lifecycle manager ---
  const vectorsDbPath = path.join(vaultDir, 'vectors.db');
  const vectorStore = new SqliteVecVectorStore(vectorsDbPath);
  const llmProvider = createEmbeddingProvider(config.embedding);
  const embeddingProvider = new EmbeddingProviderAdapter(llmProvider, config.embedding);
  const recordSource = new SqliteRecordSource();
  const embeddingManager = new EmbeddingManager(vectorStore, embeddingProvider, recordSource, logger);
  logger.info('embedding', 'EmbeddingManager initialized', { vectors_db: vectorsDbPath });

  // --- Register built-in agents and tasks ---
  try {
    const { registerBuiltInAgentsAndTasks, resolveDefinitionsDir } = await import('../agent/loader.js');
    const definitionsDir = resolveDefinitionsDir();
    registerBuiltInAgentsAndTasks(definitionsDir);
    logger.info('agent', 'Built-in agents and tasks registered');
  } catch (err) {
    logger.warn('agent', 'Failed to register built-in agents/tasks', { error: (err as Error).message });
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
        `UPDATE agent_runs SET status = 'failed', completed_at = ? WHERE status = 'running'`,
      ).run(epochSeconds());
      logger.info('agent', 'Cleaned stale running agent runs', {
        count: staleRows.length,
        ids: staleRows.map((r) => r.id),
      });
    }
  } catch (err) {
    logger.warn('agent', 'Failed to clean stale runs', { error: (err as Error).message });
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
    logger.debug('daemon', 'Static UI directory found', { path: uiDir });
  }

  const server = new DaemonServer({ vaultDir, logger, uiDir: uiDir ?? undefined });

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

  const bufferDir = path.join(vaultDir, 'buffer');
  const sessionBuffers = new Map<string, EventBuffer>();

  // Clean up stale buffer files (>24h) on startup
  let startupCleanedCount = 0;
  if (fs.existsSync(bufferDir)) {
    const cutoff = Date.now() - STALE_BUFFER_MAX_AGE_MS;
    for (const file of fs.readdirSync(bufferDir)) {
      const filePath = path.join(bufferDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        startupCleanedCount++;
        logger.debug('daemon', 'Cleaned stale buffer', { file });
      }
    }
  }
  if (startupCleanedCount > 0) {
    logger.info('daemon', 'Buffer cleanup complete', {
      stale_removed: startupCleanedCount,
    });
  }

  // Route body schemas
  const RegisterBody = z.object({
    session_id: z.string(),
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
  const ContextBody = z.object({
    session_id: z.string().optional(),
    branch: z.string().optional(),
    files: z.array(z.string()).optional(),
  });

  const planWatcher = new PlanWatcher({
    projectRoot: process.cwd(),
    watchPaths: config.capture.artifact_watch,
    onPlan: (event) => {
      logger.info('watcher', 'Plan detected', { source: event.source, file: event.filePath });
      // Plan indexing deferred to Phase 2 (SQLite plans table + Agent SDK)
    },
  });
  planWatcher.startFileWatcher();

  // --- Session routes ---

  server.registerRoute('POST', '/sessions/register', async (req) => {
    const { session_id, branch, started_at } = RegisterBody.parse(req.body);
    const resolvedStartedAt = started_at ?? new Date().toISOString();
    registry.register(session_id, { started_at: resolvedStartedAt, branch });
    server.updateDaemonJsonSessions(registry.sessions);

    // Upsert session in SQLite — always reset to active on register
    const now = epochSeconds();
    const startedEpoch = Math.floor(new Date(resolvedStartedAt).getTime() / 1000);
    upsertSession({
      id: session_id,
      agent: 'claude-code',
      user: null,
      project_root: process.cwd(),
      branch: branch ?? null,
      started_at: startedEpoch,
      created_at: now,
      status: 'active',
    });
    // Clear ended_at if session was previously completed (reload scenario)
    updateSession(session_id, { ended_at: null, status: 'active' });

    logger.info('lifecycle', 'Session registered', { session_id, branch, started_at: started_at ?? null });
    return { body: { ok: true, sessions: registry.sessions } };
  });

  server.registerRoute('POST', '/sessions/unregister', async (req) => {
    const { session_id } = UnregisterBody.parse(req.body);
    registry.unregister(session_id);
    // Note: we do NOT delete the buffer FILE for THIS session. Session reload
    // (SessionEnd → SessionStart) reuses the same session_id, and deleting
    // would wipe all prior events.
    // We DO opportunistically clean stale buffers for OTHER sessions (>24h).
    try {
      const cutoff = Date.now() - STALE_BUFFER_MAX_AGE_MS;
      for (const file of fs.readdirSync(bufferDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const bufferSessionId = file.replace('.jsonl', '');
        if (bufferSessionId === session_id) continue; // skip current session
        const filePath = path.join(bufferDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          logger.debug('daemon', 'Cleaned stale buffer', { file });
        }
      }
    } catch { /* buffer dir may not exist */ }
    // Prune in-memory state
    sessionBuffers.delete(session_id);
    server.updateDaemonJsonSessions(registry.sessions);
    logger.info('lifecycle', 'Session unregistered', { session_id });
    return { body: { ok: true, sessions: registry.sessions } };
  });

  // --- Event routes ---

  server.registerRoute('POST', '/events', async (req) => {
    const validated = EventBody.parse(req.body);
    const event = { ...validated, timestamp: validated.timestamp ?? new Date().toISOString() } as Record<string, unknown> & { type: string; session_id: string; timestamp: string };
    logger.debug('hooks', 'Event received', { type: event.type, session_id: event.session_id });

    // Ensure session is registered (idempotent — handles daemon restarts mid-session)
    if (!registry.getSession(event.session_id)) {
      registry.register(event.session_id, { started_at: event.timestamp });
      logger.debug('lifecycle', 'Auto-registered session from event', { session_id: event.session_id });

      // Ensure SQLite session exists — explicitly set status='active' so
      // resumed sessions (previously 'completed') get reopened.
      const now = epochSeconds();
      const startedEpoch = Math.floor(new Date(event.timestamp).getTime() / 1000);
      upsertSession({
        id: event.session_id,
        agent: 'claude-code',
        status: 'active',
        started_at: startedEpoch,
        created_at: now,
      });
    }

    // Persist to disk so events survive daemon restarts
    if (!sessionBuffers.has(event.session_id)) {
      sessionBuffers.set(event.session_id, new EventBuffer(bufferDir, event.session_id));
    }
    sessionBuffers.get(event.session_id)!.append(event);

    // --- Prompt batch tracking ---
    if (event.type === 'user_prompt') {
      const promptText = String(event.prompt ?? '');
      logger.info('hooks', 'User prompt received', {
        session_id: event.session_id,
        prompt_preview: promptText.slice(0, LOG_PROMPT_PREVIEW_CHARS),
        prompt_length: promptText.length,
      });
      try {
        const { batchId, promptNumber } = handleUserPrompt(event.session_id, promptText || undefined);
        logger.debug('capture', 'Batch opened', { session_id: event.session_id, batch_id: batchId, prompt_number: promptNumber });

        // Batch-threshold summary trigger
        const batchCount = promptNumber;
        const summaryInterval = config.agent.summary_batch_interval;
        if (summaryInterval > 0 && batchCount > 0 && batchCount % summaryInterval === 0) {
          try {
            const running = getRunningRun(DEFAULT_AGENT_ID);
            if (!running) {
              const { runAgent } = await import('../agent/executor.js');
              runAgent(vaultDir, {
                task: 'title-summary',
                instruction: `Process session ${event.session_id} only`,
              }).catch(err => logger.warn('agent', 'Batch-threshold summary failed', { error: String(err) }));
            }
          } catch { /* agent unavailable */ }
        }
      } catch (err) {
        logger.warn('capture', 'Failed to open batch', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'tool_use') {
      const toolName = String(event.tool_name ?? '');
      logger.debug('hooks', 'Tool use event', {
        session_id: event.session_id,
        tool_name: toolName,
      });
      planWatcher.checkToolEvent({ tool_name: toolName, tool_input: event.tool_input, session_id: event.session_id });
      try {
        handleToolUse(
          event.session_id,
          toolName,
          event.tool_input,
          typeof event.output_preview === 'string' ? event.output_preview : undefined,
        );
      } catch (err) {
        logger.warn('capture', 'Failed to record activity', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'tool_failure') {
      const toolName = String(event.tool_name ?? '');
      logger.info('hooks', 'Tool failure event', {
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
        logger.warn('capture', 'Failed to record tool failure', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'subagent_start') {
      logger.info('hooks', 'Subagent start event', {
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
        logger.warn('capture', 'Failed to record subagent start', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'subagent_stop') {
      logger.info('hooks', 'Subagent stop event', {
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
        logger.warn('capture', 'Failed to record subagent stop', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'stop_failure') {
      logger.warn('hooks', 'Stop failure event', {
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
        logger.warn('capture', 'Failed to record stop failure', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'task_completed') {
      logger.info('hooks', 'Task completed event', {
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
        logger.warn('capture', 'Failed to record task completion', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'pre_compact') {
      logger.info('hooks', 'Pre-compact event', { session_id: event.session_id });
      try {
        handleCompact(
          event.session_id,
          'pre',
          typeof event.trigger === 'string' ? event.trigger : undefined,
          undefined,
        );
      } catch (err) {
        logger.warn('capture', 'Failed to record pre-compact', { session_id: event.session_id, error: (err as Error).message });
      }
    }

    if (event.type === 'post_compact') {
      logger.info('hooks', 'Post-compact event', { session_id: event.session_id });
      try {
        handleCompact(
          event.session_id,
          'post',
          typeof event.trigger === 'string' ? event.trigger : undefined,
          typeof event.compact_summary === 'string' ? event.compact_summary : undefined,
        );
      } catch (err) {
        logger.warn('capture', 'Failed to record post-compact', { session_id: event.session_id, error: (err as Error).message });
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
      logger.debug('lifecycle', 'Auto-registered session from stop event', { session_id: sessionId });
    }
    const sessionMeta = registry.getSession(sessionId);
    logger.info('hooks', 'Stop received', {
      session_id: sessionId,
      has_transcript_path: !!hookTranscriptPath,
      has_response: !!lastAssistantMessage,
    });
    logger.debug('hooks', 'Stop event detail', {
      session_id: sessionId,
      transcript_path: hookTranscriptPath ?? null,
      last_message_preview: lastAssistantMessage?.slice(0, LOG_MESSAGE_PREVIEW_CHARS) ?? null,
    });

    // Respond immediately — the hook should not block on processing.
    const run = () => processStopEvent(sessionId, user, sessionMeta, hookTranscriptPath, lastAssistantMessage).catch((err) => {
      logger.error('processor', 'Stop processing failed', { session_id: sessionId, error: (err as Error).message });
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
          logger.info('processor', 'Appended buffer turns missing from transcript', {
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
    logger.debug('processor', 'Transcript parsed', {
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
      catch (err) { logger.warn('processor', 'Failed to set response_summary on latest batch', { error: String(err) }); }
    }

    handleSessionStop(sessionId);

    // Derive a simple title from the first prompt (no LLM — that's Phase 2)
    let title: string | null = null;
    if (allTurns.length > 0 && allTurns[0].prompt) {
      title = allTurns[0].prompt.slice(0, TITLE_PREVIEW_CHARS);
      if (allTurns[0].prompt.length > TITLE_PREVIEW_CHARS) {
        title += '...';
      }
    }

    // Update session with transcript metadata (no LLM calls)
    const updateFields: Record<string, unknown> = {
      transcript_path: hookTranscriptPath ?? null,
      prompt_count: allTurns.length,
      tool_count: allTurns.reduce((sum, t) => sum + t.toolCount, 0),
    };
    if (user) updateFields.user = user;
    if (title) updateFields.title = title;

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
      catch (err) { logger.warn('processor', 'Failed to populate batch responses', { error: String(err) }); }
    }

    // Fire-and-forget: trigger title/summary generation via agent task
    try {
      const { runAgent } = await import('../agent/executor.js');
      runAgent(vaultDir, {
        task: 'title-summary',
        instruction: `Process session ${sessionId} only`,
      }).catch(err => logger.warn('agent', 'Title-summary task failed', { error: String(err) }));
    } catch { /* agent unavailable */ }

    // Write images to attachments (keep this — images are binary, not in SQLite)
    // Link images to the latest batch directly (primary capture) rather than
    // relying on positional turn-to-batch mapping (which breaks when the parser
    // drops empty-text turns).
    const attachmentsDir = path.join(vaultDir, 'attachments');
    const hasImages = allTurns.some((t) => t.images?.length);
    if (hasImages) {
      fs.mkdirSync(attachmentsDir, { recursive: true });
    }
    for (let i = 0; i < allTurns.length; i++) {
      const turn = allTurns[i];
      if (!turn.images?.length) continue;
      const promptNumber = i + 1;
      // For the last turn, use latestBatch directly (reliable).
      // For earlier turns, fall back to positional lookup (best-effort).
      const isLastTurn = i === allTurns.length - 1;
      let resolvedBatchId: number | null = null;
      if (isLastTurn && latestBatch) {
        resolvedBatchId = latestBatch.id;
      } else {
        try { resolvedBatchId = getBatchIdByPromptNumber(sessionId, promptNumber); }
        catch { resolvedBatchId = null; }
      }
      for (let j = 0; j < turn.images.length; j++) {
        const img = turn.images[j];
        const ext = extensionForMimeType(img.mediaType);
        const sessionShort = sessionId.slice(-6);
        const filename = `${sessionShort}-t${promptNumber}-${j + 1}.${ext}`;
        const filePath = path.join(attachmentsDir, filename);
        try {
          fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'), { flag: 'wx' });
          logger.debug('processor', 'Image saved', { filename, turn: promptNumber });
          try {
            insertAttachment({
              id: `${sessionShort}-t${promptNumber}-${j + 1}`,
              session_id: sessionId,
              prompt_batch_id: resolvedBatchId ?? undefined,
              file_path: filename,
              media_type: img.mediaType,
              created_at: epochSeconds(),
            });
          } catch (err) { logger.warn('processor', 'Failed to record attachment', { error: String(err) }); }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
    }

    logger.info('processor', 'Session captured', {
      session_id: sessionId,
      turns: allTurns.length,
      source: turnSource,
      title: title ?? '(untitled)',
    });
  }

  // --- Session-start context (simplified — no digest, no vault search) ---
  server.registerRoute('POST', '/context', async (req) => {
    const { session_id, branch } = ContextBody.parse(req.body);
    logger.debug('hooks', 'Session context query', { session_id });
    try {
      const parts: string[] = [];

      // Branch info for awareness
      if (branch) {
        parts.push(`Branch:: \`${branch}\``);
      }

      // Always include the session ID
      parts.push(`Session:: \`${session_id}\``);

      if (parts.length > 0) {
        const contextText = parts.join('\n\n');
        logger.info('context', 'Session context injected', {
          session_id,
          source: 'basic',
          parts: parts.length,
        });
        logger.debug('context', 'Injected context content', {
          session_id,
          text: contextText,
        });
        return { body: { text: contextText } };
      }
      return { body: { text: '' } };
    } catch (error) {
      logger.error('daemon', 'Session context failed', { error: (error as Error).message });
      return { body: { text: '' } };
    }
  });

  // Per-prompt context: deferred to Phase 2 (Agent SDK)
  const PromptContextBody = z.object({
    prompt: z.string(),
    session_id: z.string().optional(),
  });

  server.registerRoute('POST', '/context/prompt', async (req) => {
    PromptContextBody.parse(req.body);
    // Per-prompt semantic search deferred to Phase 2
    return { body: { text: '' } };
  });

  // --- Dashboard API routes ---
  const progressTracker = new ProgressTracker();
  let configHash = computeConfigHash(vaultDir);

  server.registerRoute('GET', '/api/config', async () => handleGetConfig(vaultDir));
  server.registerRoute('PUT', '/api/config', async (req) => {
    const result = await handlePutConfig(vaultDir, req.body);
    if (!result.status || result.status < 400) {
      configHash = computeConfigHash(vaultDir);
    }
    return result;
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

  server.registerRoute('GET', '/api/logs', async (req) => handleGetLogs(logger.getRingBuffer(), req.query));

  // External log ingestion: allows MCP server (separate process) to write through the daemon logger
  const ExternalLogBody = z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    component: z.string(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  });

  server.registerRoute('POST', '/api/log', async (req) => {
    const { level, component, message, data } = ExternalLogBody.parse(req.body);
    logger.log(level, component, message, data);
    return { body: { ok: true } };
  });

  server.registerRoute('GET', '/api/models', async (req) => handleGetModels(req));
  server.registerRoute('POST', '/api/restart', async (req) => handleRestart({ vaultDir, progressTracker }, req.body));
  server.registerRoute('GET', '/api/progress/:token', async (req) => handleGetProgress(progressTracker, req.params.token));

  // Simplified sessions endpoint — SQLite based
  server.registerRoute('GET', '/api/sessions', async () => {
    const sessions = listSessions({ limit: 100 });
    return {
      body: {
        sessions: sessions.map((s) => ({
          id: s.id,
          date: new Date(s.started_at * 1000).toISOString().slice(0, 10),
          title: s.title || s.id.slice(0, 8),
          status: s.status,
        })),
      },
    };
  });

  server.registerRoute('GET', '/api/sessions/:id', handleGetSession);
  server.registerRoute('DELETE', '/api/sessions/:id', async (req) => {
    const sessionId = req.params.id;
    const deleted = deleteSession(sessionId);
    if (!deleted) return { status: 404, body: { error: 'Session not found' } };
    try { embeddingManager.onRemoved('sessions', sessionId); } catch { /* best-effort */ }
    logger.info('api', 'Session deleted', { session_id: sessionId });
    return { body: { ok: true } };
  });
  server.registerRoute('GET', '/api/sessions/:id/batches', handleGetSessionBatches);
  server.registerRoute('GET', '/api/batches/:id/activities', handleGetBatchActivities);
  server.registerRoute('GET', '/api/sessions/:id/attachments', handleGetSessionAttachments);

  // --- Mycelium API routes ---
  server.registerRoute('GET', '/api/spores', handleListSpores);
  server.registerRoute('GET', '/api/spores/:id', handleGetSpore);
  server.registerRoute('GET', '/api/entities', handleListEntities);
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
    const filePath = path.join(vaultDir, 'attachments', filename);
    if (!fs.existsSync(filePath)) return { status: 404, body: { error: 'not_found' } };
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filename).slice(1).toLowerCase();
    const contentType = ATTACHMENT_MEDIA_TYPES[ext] ?? 'application/octet-stream';
    return { status: 200, headers: { 'Content-Type': contentType }, body: data };
  });

  // --- Agent API routes ---

  const AgentRunBody = z.object({
    task: z.string().optional(),
    instruction: z.string().optional(),
    agentId: z.string().optional(),
  });

  server.registerRoute('POST', '/api/agent/run', async (req) => {
    const { task, instruction, agentId } = AgentRunBody.parse(req.body);

    // Fire-and-forget: respond immediately with a runId placeholder, agent runs in background
    const { runAgent } = await import('../agent/executor.js');
    const resultPromise = runAgent(vaultDir, { task, instruction, agentId });

    // We need the runId from the executor, but the executor creates it synchronously
    // before the async SDK call. Wait for the result since it's fast to start.
    resultPromise
      .then((result) => {
        if (result.status === 'failed') {
          logger.error('agent', 'Agent run failed', {
            runId: result.runId,
            error: result.error ?? 'No error message',
            phases: result.phases?.map(p => `${p.name}:${p.status}`) ?? [],
          });
        } else {
          logger.info('agent', 'Agent run completed', {
            runId: result.runId,
            status: result.status,
            phases: result.phases?.map(p => `${p.name}:${p.status}`) ?? [],
          });
        }
      })
      .catch((err) => {
        logger.error('agent', 'Agent run threw unhandled error', {
          error: (err as Error).message ?? String(err),
          stack: (err as Error).stack?.split('\n').slice(0, 3).join(' | '),
        });
      });

    // Return immediately — the caller can poll /api/agent/runs for status
    return { body: { ok: true, message: 'Agent started' } };
  });

  server.registerRoute('GET', '/api/agent/runs', async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : AGENT_RUNS_DEFAULT_LIMIT;
    const agentId = req.query.agentId || undefined;
    const runs = listRuns({ limit, agent_id: agentId });
    return { body: { runs } };
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

  // --- Search, activity feed, and embedding status ---

  server.registerRoute('GET', '/api/search', createSearchHandler({ embeddingManager, vectorStore }));
  server.registerRoute('GET', '/api/activity', handleGetFeed);
  server.registerRoute('GET', '/api/embedding/status', async () => handleGetEmbeddingStatus(vaultDir));

  // --- Start server ---

  await server.evictExistingDaemon();
  const resolvedPort = await resolvePort(config.daemon.port, vaultDir);
  if (resolvedPort === 0) {
    logger.warn('daemon', 'All preferred ports occupied, using ephemeral port');
  }
  await server.start(resolvedPort);
  logger.info('daemon', 'Daemon ready', { vault: vaultDir, port: server.port });

  // Persist the resolved port to config if it was auto-derived
  if (config.daemon.port === null && resolvedPort !== 0) {
    try {
      config.daemon.port = resolvedPort;
      saveConfig(vaultDir, config);
      logger.info('daemon', 'Persisted auto-derived port to myco.yaml', { port: resolvedPort });
    } catch (err) {
      logger.warn('daemon', 'Failed to persist auto-derived port', { error: (err as Error).message });
    }
  }

  // --- Agent timer ---

  const agentTimer = config.agent.auto_run
    ? setInterval(async () => {
        try {
          // Pre-check: only spawn agent if there's unprocessed work
          const agentDb = getDatabase();
          const checkRow = agentDb.prepare('SELECT COUNT(*) as count FROM prompt_batches WHERE processed = 0').get() as { count: number };
          const count = Number(checkRow.count);
          if (count === 0) {
            logger.debug('agent', 'No unprocessed batches, skipping cycle');
            return;
          }

          logger.info('agent', 'Unprocessed batches found, starting agent', { count });
          const { runAgent } = await import('../agent/executor.js');
          const runResult = await runAgent(vaultDir);
          logger.info('agent', 'Agent run completed', { status: runResult.status, runId: runResult.runId });
        } catch (err) {
          logger.error('agent', 'Agent timer failed', { error: (err as Error).message });
        }
      }, config.agent.interval_seconds * SECONDS_TO_MS)
    : null;

  if (!config.agent.auto_run) {
    logger.info('agent', 'Auto-agent disabled (agent.auto_run = false)');
  }

  // --- Embedding reconcile worker ---
  // Delegates to EmbeddingManager.reconcile() which handles: finding unembedded
  // rows, embedding via provider, upserting vectors, marking embedded flags,
  // and running orphan sweeps.

  let reconcileRunning = false;
  const reconcileTimer = setInterval(async () => {
    if (reconcileRunning) return;
    reconcileRunning = true;
    try {
      await embeddingManager.reconcile(EMBEDDING_BATCH_SIZE);
    } catch (err) {
      logger.error('embedding', 'Reconcile worker failed', { error: (err as Error).message });
    } finally {
      reconcileRunning = false;
    }
  }, EMBEDDING_INTERVAL_MS);

  logger.info('embedding', 'Reconcile worker started', {
    interval_ms: EMBEDDING_INTERVAL_MS,
    batch_size: EMBEDDING_BATCH_SIZE,
  });

  // --- Shutdown ---

  const shutdown = async (signal: string) => {
    logger.info('daemon', `${signal} received`);
    if (agentTimer) clearInterval(agentTimer);
    clearInterval(reconcileTimer);
    // Wait for any active stop processing to finish before shutting down
    if (activeStopProcessing) {
      logger.info('daemon', 'Waiting for active stop processing to complete...');
      await activeStopProcessing;
    }
    planWatcher.stopFileWatcher();
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
