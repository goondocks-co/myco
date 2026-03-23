/**
 * Myco daemon — PGlite capture engine.
 *
 * This is the v2 rewrite: all data goes to PGlite instead of markdown vault +
 * SQLite. The intelligence pipeline (extraction, embedding, consolidation,
 * digest) is removed — it moves to Phase 2 Agent SDK. What remains is the
 * capture layer: session lifecycle, prompt batch tracking, activity recording,
 * and transcript mining.
 */

import { DaemonServer } from './server.js';
import { SessionRegistry } from './lifecycle.js';
import { DaemonLogger } from './logger.js';
import { loadConfig, saveConfig } from '../config/loader.js';
import { resolvePort } from './port.js';
import { TranscriptMiner, extractTurnsFromBuffer } from '../capture/transcript-miner.js';
import { createPerProjectAdapter, extensionForMimeType, type TranscriptTurn } from '../agents/adapter.js';
import { claudeCodeAdapter } from '../agents/claude-code.js';
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
import { handleSearch } from './api/search.js';
import { handleGetFeed } from './api/feed.js';
import { handleGetEmbeddingStatus } from './api/embedding.js';
import { listTurnsByRun } from '../db/queries/turns.js';
import { listTasksByCurator } from '../db/queries/tasks.js';
import { gatherStats } from '../services/stats.js';
import { initDatabaseForVault, closeDatabase, getDatabase } from '../db/client.js';
import { upsertSession, closeSession, updateSession, listSessions } from '../db/queries/sessions.js';
import { insertBatch, closeBatch, incrementActivityCount } from '../db/queries/batches.js';
import { insertActivity } from '../db/queries/activities.js';
import { insertAttachment } from '../db/queries/attachments.js';
import { listRuns, getRun } from '../db/queries/runs.js';
import { listReports } from '../db/queries/reports.js';
import {
  DEFAULT_CURATOR_ID,
  STALE_BUFFER_MAX_AGE_MS,
  LOG_PROMPT_PREVIEW_CHARS,
  LOG_MESSAGE_PREVIEW_CHARS,
  epochSeconds,
} from '../constants.js';
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

/** Prompt count tracking key prefix for in-memory session state. */
const INITIAL_PROMPT_NUMBER = 1;

/** Max chars of tool input stored in the activity row. */
const TOOL_INPUT_STORE_LIMIT = 4000;

/** Max chars of tool output summary stored in the activity row. */
const TOOL_OUTPUT_STORE_LIMIT = 2000;

/** Max chars for deriving a title from the first user prompt. */
const TITLE_PREVIEW_CHARS = 80;

// ---------------------------------------------------------------------------
// Event handling helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Per-session state for prompt batch tracking. */
export interface SessionBatchState {
  currentBatchId: number | null;
  promptNumber: number;
}

/** In-memory map of session_id → current batch state. */
export type BatchStateMap = Map<string, SessionBatchState>;

/**
 * Handle a UserPromptSubmit event: close previous batch, open new one.
 *
 * @returns the new batch ID
 */
export async function handleUserPrompt(
  sessionId: string,
  prompt: string | undefined,
  batchState: BatchStateMap,
): Promise<number> {
  const now = epochSeconds();
  const state = batchState.get(sessionId) ?? { currentBatchId: null, promptNumber: INITIAL_PROMPT_NUMBER };

  // Close previous batch if open
  if (state.currentBatchId !== null) {
    await closeBatch(state.currentBatchId, now);
  }

  // Insert new batch
  const batch = await insertBatch({
    session_id: sessionId,
    prompt_number: state.promptNumber,
    user_prompt: prompt ?? null,
    started_at: now,
    created_at: now,
  });

  // Update state
  state.currentBatchId = batch.id;
  state.promptNumber++;
  batchState.set(sessionId, state);

  // Increment session prompt count
  await updateSession(sessionId, { prompt_count: state.promptNumber - 1 });

  return batch.id;
}

/**
 * Handle a PostToolUse event: insert activity, increment batch count.
 */
export async function handleToolUse(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  toolOutput: string | undefined,
  batchState: BatchStateMap,
): Promise<void> {
  const now = epochSeconds();
  const state = batchState.get(sessionId);
  const batchId = state?.currentBatchId ?? null;

  // Extract file_path from tool input if present
  const inputObj = toolInput as Record<string, unknown> | undefined;
  const filePath = typeof inputObj?.file_path === 'string' ? inputObj.file_path : null;

  const activityPromise = insertActivity({
    session_id: sessionId,
    prompt_batch_id: batchId,
    tool_name: toolName,
    tool_input: toolInput ? JSON.stringify(toolInput).slice(0, TOOL_INPUT_STORE_LIMIT) : null,
    tool_output_summary: toolOutput?.slice(0, TOOL_OUTPUT_STORE_LIMIT) ?? null,
    file_path: filePath,
    timestamp: now,
    created_at: now,
  });

  if (batchId !== null) {
    await Promise.all([activityPromise, incrementActivityCount(batchId)]);
  } else {
    await activityPromise;
  }
  // Session-level tool_count is updated at stop time from transcript data.
}

/**
 * Handle session stop: close batch, close session, mine transcript for title.
 */
export async function handleSessionStop(
  sessionId: string,
  batchState: BatchStateMap,
): Promise<void> {
  const now = epochSeconds();
  const state = batchState.get(sessionId);

  // Close current batch if open
  if (state?.currentBatchId !== null && state?.currentBatchId !== undefined) {
    await closeBatch(state.currentBatchId, now);
    state.currentBatchId = null;
    batchState.set(sessionId, state);
  }

  // Close session
  await closeSession(sessionId, now);
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

  logger.info('daemon', 'Config loaded', {
    vault: vaultDir,
    embedding_provider: config.embedding.provider,
  });

  // --- PGlite initialization ---
  await initDatabaseForVault(vaultDir);
  logger.info('daemon', 'PGlite initialized', { vault: vaultDir });

  // --- Register built-in curators and tasks ---
  try {
    const { registerBuiltInCuratorsAndTasks, resolveDefinitionsDir } = await import('../agent/loader.js');
    const definitionsDir = resolveDefinitionsDir();
    await registerBuiltInCuratorsAndTasks(definitionsDir);
    logger.info('agent', 'Built-in curators and tasks registered');
  } catch (err) {
    logger.warn('agent', 'Failed to register built-in curators/tasks', { error: (err as Error).message });
  }

  // Resolve dist/ui/ — walk up to find package.json (same strategy as prompts loader)
  let uiDir: string | null = null;
  {
    let dir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'dist', 'ui');
      if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(candidate)) {
        uiDir = candidate;
        break;
      }
      dir = path.dirname(dir);
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

  // Prompt batch state tracking: session_id → current batch state
  const batchState: BatchStateMap = new Map();

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
      // Plan indexing deferred to Phase 2 (PGlite plans table + Agent SDK)
    },
  });
  planWatcher.startFileWatcher();

  // --- Session routes ---

  server.registerRoute('POST', '/sessions/register', async (req) => {
    const { session_id, branch, started_at } = RegisterBody.parse(req.body);
    const resolvedStartedAt = started_at ?? new Date().toISOString();
    registry.register(session_id, { started_at: resolvedStartedAt, branch });
    server.updateDaemonJsonSessions(registry.sessions);

    // Upsert session in PGlite
    const now = epochSeconds();
    const startedEpoch = Math.floor(new Date(resolvedStartedAt).getTime() / 1000);
    await upsertSession({
      id: session_id,
      agent: 'claude-code',
      user: null,
      project_root: process.cwd(),
      branch: branch ?? null,
      started_at: startedEpoch,
      created_at: now,
    });

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
    batchState.delete(session_id);
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

      // Ensure PGlite session exists
      const now = epochSeconds();
      const startedEpoch = Math.floor(new Date(event.timestamp).getTime() / 1000);
      await upsertSession({
        id: event.session_id,
        agent: 'claude-code',
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
        const batchId = await handleUserPrompt(event.session_id, promptText || undefined, batchState);
        logger.debug('capture', 'Batch opened', { session_id: event.session_id, batch_id: batchId });
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
        await handleToolUse(
          event.session_id,
          toolName,
          event.tool_input,
          typeof event.output_preview === 'string' ? event.output_preview : undefined,
          batchState,
        );
      } catch (err) {
        logger.warn('capture', 'Failed to record activity', { session_id: event.session_id, error: (err as Error).message });
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

    // --- Phase 2: Close session in PGlite ---

    await handleSessionStop(sessionId, batchState);

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

    await updateSession(sessionId, updateFields as Parameters<typeof updateSession>[1]);

    // Write images to attachments (keep this — images are binary, not in PGlite)
    const attachmentsDir = path.join(vaultDir, 'attachments');
    const hasImages = allTurns.some((t) => t.images?.length);
    if (hasImages) {
      fs.mkdirSync(attachmentsDir, { recursive: true });
    }
    for (let i = 0; i < allTurns.length; i++) {
      const turn = allTurns[i];
      if (!turn.images?.length) continue;
      for (let j = 0; j < turn.images.length; j++) {
        const img = turn.images[j];
        const ext = extensionForMimeType(img.mediaType);
        const sessionShort = sessionId.slice(-6);
        const filename = `${sessionShort}-t${i + 1}-${j + 1}.${ext}`;
        const filePath = path.join(attachmentsDir, filename);
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'));
          logger.debug('processor', 'Image saved', { filename, turn: i + 1 });
          insertAttachment({
            id: `${sessionShort}-t${i + 1}-${j + 1}`,
            session_id: sessionId,
            file_path: filename,
            media_type: img.mediaType,
            created_at: epochSeconds(),
          }).catch(err => logger.warn('processor', 'Failed to record attachment', { error: String(err) }));
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
        logger.info('context', 'Session context injected', {
          session_id,
          source: 'basic',
          parts: parts.length,
        });
        return { body: { text: parts.join('\n\n') } };
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

  // V2 stats — vault counts, embedding coverage, curator status, digest freshness
  server.registerRoute('GET', '/api/stats', async () => {
    const stats = await gatherStats(vaultDir, { active_sessions: registry.sessions });
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

  // Simplified sessions endpoint — PGlite based
  server.registerRoute('GET', '/api/sessions', async () => {
    const sessions = await listSessions({ limit: 100 });
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
    curatorId: z.string().optional(),
  });

  server.registerRoute('POST', '/api/agent/run', async (req) => {
    const { task, instruction, curatorId } = AgentRunBody.parse(req.body);

    // Fire-and-forget: respond immediately with a runId placeholder, agent runs in background
    const { runCurationAgent } = await import('../agent/executor.js');
    const resultPromise = runCurationAgent(vaultDir, { task, instruction, curatorId });

    // We need the runId from the executor, but the executor creates it synchronously
    // before the async SDK call. Wait for the result since it's fast to start.
    resultPromise
      .then((result) => {
        logger.info('curation', 'Agent run completed', { runId: result.runId, status: result.status });
      })
      .catch((err) => {
        logger.error('curation', 'Agent run failed', { error: (err as Error).message });
      });

    // Return immediately — the caller can poll /api/agent/runs for status
    return { body: { ok: true, message: 'Curation agent started' } };
  });

  server.registerRoute('GET', '/api/agent/runs', async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : AGENT_RUNS_DEFAULT_LIMIT;
    const curatorId = req.query.curatorId || undefined;
    const runs = await listRuns({ limit, curator_id: curatorId });
    return { body: { runs } };
  });

  server.registerRoute('GET', '/api/agent/runs/:id', async (req) => {
    const run = await getRun(req.params.id);
    if (!run) {
      return { status: 404, body: { error: 'Run not found' } };
    }
    return { body: { run } };
  });

  server.registerRoute('GET', '/api/agent/runs/:id/reports', async (req) => {
    const reports = await listReports(req.params.id);
    return { body: { reports } };
  });

  server.registerRoute('GET', '/api/agent/runs/:id/turns', async (req) => {
    const turns = await listTurnsByRun(req.params.id);
    return { body: turns };
  });

  server.registerRoute('GET', '/api/agent/tasks', async (req) => {
    const curatorId = req.query.curator_id ?? DEFAULT_CURATOR_ID;
    const tasks = await listTasksByCurator(curatorId);
    return { body: tasks };
  });

  // --- Search, activity feed, and embedding status ---

  server.registerRoute('GET', '/api/search', handleSearch);
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

  // --- Curation timer ---

  const curationTimer = config.curation.auto_run
    ? setInterval(async () => {
        try {
          // Pre-check: only spawn agent if there's unprocessed work
          const db = getDatabase();
          const checkResult = await db.query('SELECT COUNT(*) as count FROM prompt_batches WHERE processed = 0');
          const count = Number((checkResult.rows[0] as Record<string, unknown>).count);
          if (count === 0) return;

          logger.info('curation', 'Unprocessed batches found, starting curation', { count });
          const { runCurationAgent } = await import('../agent/executor.js');
          const runResult = await runCurationAgent(vaultDir);
          logger.info('curation', 'Curation run completed', { status: runResult.status, runId: runResult.runId });
        } catch (err) {
          logger.error('curation', 'Curation timer failed', { error: (err as Error).message });
        }
      }, config.curation.interval_seconds * SECONDS_TO_MS)
    : null;

  if (!config.curation.auto_run) {
    logger.info('curation', 'Auto-curation disabled (curation.auto_run = false)');
  }

  // --- Shutdown ---

  const shutdown = async (signal: string) => {
    logger.info('daemon', `${signal} received`);
    if (curationTimer) clearInterval(curationTimer);
    // Wait for any active stop processing to finish before shutting down
    if (activeStopProcessing) {
      logger.info('daemon', 'Waiting for active stop processing to complete...');
      await activeStopProcessing;
    }
    planWatcher.stopFileWatcher();
    registry.destroy();
    await server.stop();
    await closeDatabase();
    logger.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
