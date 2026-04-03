/**
 * Stop-event processing pipeline.
 *
 * Extracted from daemon/main.ts. All logic for handling POST /events/stop lives
 * here: session auto-registration, transcript mining, batch reconciliation,
 * attachment capture, and title/summary agent task triggering.
 */

import { z } from 'zod';
import fs from 'node:fs';
import { TranscriptMiner, extractTurnsFromBuffer } from '@myco/capture/transcript-miner.js';
import type { TranscriptTurn } from '@myco/symbionts/adapter.js';
import { extensionForMimeType } from '@myco/symbionts/adapter.js';
import {
  getLatestBatch,
  setResponseSummary,
  populateBatchResponses,
  closeOpenBatches,
  listBatchesBySession,
  findBatchByPromptPrefix,
} from '@myco/db/queries/batches.js';
import { getSession, updateSession } from '@myco/db/queries/sessions.js';
import { insertAttachment } from '@myco/db/queries/attachments.js';
import { detectSkillUsage, SKILL_USAGE_DETECTION_ENABLED } from './skill-usage.js';
import { epochSeconds, LOG_MESSAGE_PREVIEW_CHARS } from '@myco/constants.js';
import { TITLE_PREVIEW_CHARS } from './event-handlers.js';
import { SessionRegistry } from './lifecycle.js';
import { EventBuffer } from '@myco/capture/buffer.js';
import { DaemonLogger } from './logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { EmbeddingManager } from './embedding/index.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { RouteHandler } from './router.js';
import type { RegisteredSession } from './lifecycle.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StopProcessorDeps {
  registry: SessionRegistry;
  sessionBuffers: Map<string, EventBuffer>;
  transcriptMiner: TranscriptMiner;
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
  config: MycoConfig;
  vaultDir: string;
}

// ---------------------------------------------------------------------------
// Exported pure utility
// ---------------------------------------------------------------------------

/** Correlate buffer tool_use events with transcript turns by timestamp to populate toolBreakdown and files. */
export function enrichTurnsWithToolMetadata(turns: TranscriptTurn[], events: Array<Record<string, unknown>>): void {
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStopProcessor(deps: StopProcessorDeps): {
  handleStopRoute: RouteHandler;
  clearSession: (sessionId: string) => void;
  getActiveProcessing: () => Promise<void> | null;
  triggerTitleSummary: (sessionId: string) => Promise<void>;
} {
  const { registry, sessionBuffers, transcriptMiner, embeddingManager, logger, config, vaultDir } = deps;

  // Internal state
  let activeStopProcessing: Promise<void> | null = null;
  const sessionTitleCache = new Map<string, string>();

  // Route body schema
  const StopBody = z.object({
    session_id: z.string(),
    user: z.string().optional(),
    transcript_path: z.string().optional(),
    last_assistant_message: z.string().optional(),
  });

  /**
   * Fire-and-forget trigger for the title-summary agent task.
   * Guards: summary_batch_interval must be > 0 (0 = disabled), no run
   * already in progress. Callers add their own preconditions (e.g. batch
   * threshold, missing title).
   */
  async function triggerTitleSummary(sessionId: string): Promise<void> {
    if (config.agent.summary_batch_interval <= 0) return;
    // No caller-side concurrency guard — the executor's per-task guard
    // handles blocking duplicate title-summary runs.
    try {
      const { runAgent } = await import('../agent/executor.js');
      runAgent(vaultDir, {
        task: 'title-summary',
        instruction: `Process session ${sessionId} only`,
        embeddingManager,
      }).catch(err => logger.warn(LOG_KINDS.AGENT_ERROR, 'Title-summary task failed', { error: String(err) }));
    } catch { /* agent unavailable */ }
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

    // Update session with transcript metadata (no LLM calls).
    // Use MAX of current DB count vs transcript-derived count — the incremental
    // count from handleUserPrompt is authoritative during active sessions; the
    // transcript parse may see fewer turns if the file is incomplete.
    const currentSession = getSession(sessionId);
    const transcriptPromptCount = allTurns.length;
    const transcriptToolCount = allTurns.reduce((sum, t) => sum + t.toolCount, 0);

    const updateFields: Record<string, unknown> = {
      transcript_path: hookTranscriptPath ?? null,
      prompt_count: Math.max(transcriptPromptCount, currentSession?.prompt_count ?? 0),
      tool_count: Math.max(transcriptToolCount, currentSession?.tool_count ?? 0),
    };
    if (user) updateFields.user = user;
    if (!hasTitle && sessionTitleCache.has(sessionId)) {
      updateFields.title = sessionTitleCache.get(sessionId);
    }

    updateSession(sessionId, updateFields as Parameters<typeof updateSession>[1]);

    // Detect skill usage from transcript content (best-effort, non-blocking).
    // Skip transcript I/O entirely when detection is disabled.
    if (SKILL_USAGE_DETECTION_ENABLED) {
      try {
        let transcriptText: string | null = null;
        if (hookTranscriptPath) {
          try { transcriptText = fs.readFileSync(hookTranscriptPath, 'utf-8'); }
          catch { /* file may not exist yet — fall through */ }
        }
        if (!transcriptText && allTurns.length > 0) {
          transcriptText = allTurns
            .map((t) => [t.prompt ?? '', t.aiResponse ?? ''].join(' '))
            .join('\n');
        }
        if (transcriptText) {
          detectSkillUsage(sessionId, transcriptText);
        }
      } catch {
        // Best-effort — don't block reconciliation
      }
    }

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

  const handleStopRoute: RouteHandler = async (req) => {
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
  };

  return {
    handleStopRoute,
    clearSession: (sessionId: string) => { sessionTitleCache.delete(sessionId); },
    getActiveProcessing: () => activeStopProcessing,
    triggerTitleSummary,
  };
}
