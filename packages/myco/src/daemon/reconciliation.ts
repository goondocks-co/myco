/**
 * Buffer reconciliation factory for the Myco daemon.
 *
 * The buffer is the authoritative event log — JSONL files on disk. The DB
 * (prompt_batches + activities) is a derived view. After a daemon restart,
 * reconciliation replays missed events from buffer files to keep the DB in sync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { listBufferSessionIds, cleanStaleBuffers } from '@myco/capture/buffer.js';
import {
  listBatchesBySession,
  getLatestBatch,
  setResponseSummary,
} from '@myco/db/queries/batches.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { STALE_BUFFER_MAX_AGE_MS, DEFAULT_SYMBIONT_NAME } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { DaemonLogger } from './logger.js';
import { isSystemMessage, handleUserPrompt, handleToolUse, handleToolFailure } from './event-handlers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Event types replayed during buffer reconciliation. */
const REPLAYABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user_prompt',
  'tool_use',
  'tool_failure',
  // `stop` events carry the last assistant message and need to survive daemon
  // downtime so response_summary isn't lost when the TUI fires idle during a
  // restart window. Replay sets the summary on the session's latest batch
  // without re-running full stop processing (which already ran live).
  'stop',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconcilerDeps {
  bufferDir: string;
  logger: DaemonLogger;
  /** Canonical project root — derived from vaultDir, never cwd. */
  projectRoot: string;
}

export interface Reconciler {
  reconcileSession(sessionId: string): void;
  replayEvent(sessionId: string, event: Record<string, unknown>): 'prompt' | 'activity' | null;
  runStartupReconciliation(): void;
  /** Clear reconciliation state for a session (call on unregister). */
  clearSession(sessionId: string): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a reconciler instance bound to the given buffer directory and logger.
 *
 * The returned object exposes `reconcileSession`, `replayEvent`, and
 * `runStartupReconciliation` — all of which share the internal
 * `reconciledSessions` set so that each session is only reconciled once
 * per daemon lifetime.
 */
export function createReconciler({ bufferDir, logger, projectRoot }: ReconcilerDeps): Reconciler {
  // Track sessions already reconciled this daemon lifetime to avoid
  // redundant file reads (startup scan + register + event can all fire).
  const reconciledSessions = new Set<string>();

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
        typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME,
        String(event.tool_name ?? ''),
        event.tool_input,
        typeof event.output_preview === 'string' ? event.output_preview : undefined,
        projectRoot,
      );
      return 'activity';
    }
    if (event.type === 'tool_failure') {
      handleToolFailure(
        sessionId,
        typeof event.agent === 'string' ? event.agent : DEFAULT_SYMBIONT_NAME,
        String(event.tool_name ?? ''),
        event.tool_input,
        typeof event.error === 'string' ? event.error : undefined,
        !!event.is_interrupt,
      );
      return 'activity';
    }
    if (event.type === 'stop') {
      const summary = typeof event.last_assistant_message === 'string'
        ? event.last_assistant_message.trim()
        : '';
      if (!summary) return null;
      const latest = getLatestBatch(sessionId);
      if (latest && !latest.response_summary) {
        setResponseSummary(latest.id, summary);
        return 'activity';
      }
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
    let content: string;
    try {
      content = fs.readFileSync(bufferPath, 'utf-8').trim();
    } catch {
      return; // Buffer file doesn't exist or is unreadable
    }
    if (!content) return;

    // Buffer files outlive session rows — sessions may have been manually
    // deleted or cleaned up by the session cleanup job. Skip reconciliation
    // for sessions that no longer exist rather than resurrecting them.
    if (!getSession(sessionId, ALL_PROJECTS_SCOPE)) {
      logger.debug(LOG_KINDS.LIFECYCLE_RECONCILE, 'Skipping reconciliation for deleted session', { session_id: sessionId });
      return;
    }

    const allEvents: Array<Record<string, unknown>> = content.split('\n').map((line) => JSON.parse(line));

    // Stop events can be dropped independently of prompt divergence — the
    // daemon can accept a prompt live, then go down before that turn's stop
    // arrives. Apply any buffered stops first; it's cheap and idempotent
    // (setResponseSummary only writes when the column is still NULL).
    let summariesRecovered = 0;
    for (const event of allEvents) {
      if (event.type !== 'stop') continue;
      try {
        if (replayEvent(sessionId, event) === 'activity') summariesRecovered++;
      } catch (err) {
        logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Reconciliation: stop replay failed', {
          session_id: sessionId,
          error: String(err),
        });
      }
    }

    // Find the divergence point: how many real prompts does the DB have?
    const existingBatchCount = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }).length;

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

    if (replayStartIndex === -1) {
      if (summariesRecovered > 0) {
        logger.info(LOG_KINDS.LIFECYCLE_RECONCILE, 'Buffer reconciliation recovered stop summaries', {
          session_id: sessionId,
          summaries_recovered: summariesRecovered,
        });
      }
      return;
    }

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

  /**
   * Run startup reconciliation: clean stale buffers, then reconcile all
   * buffer sessions found on disk.
   */
  function runStartupReconciliation(): void {
    // Clean up stale buffer files (>24h) on startup
    const startupCleanedCount = cleanStaleBuffers(bufferDir, STALE_BUFFER_MAX_AGE_MS);
    if (startupCleanedCount > 0) {
      logger.info(LOG_KINDS.CAPTURE_BUFFER, 'Buffer cleanup complete', { stale_removed: startupCleanedCount });
    }

    // Reconcile all remaining buffer files — recover events from sessions
    // that had activity while the daemon was down.
    for (const sessionId of listBufferSessionIds(bufferDir)) {
      try {
        reconcileSession(sessionId);
      } catch (err) {
        logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Startup reconciliation failed', { session_id: sessionId, error: String(err) });
      }
    }
  }

  function clearSession(sessionId: string): void {
    reconciledSessions.delete(sessionId);
  }

  return { reconcileSession, replayEvent, runStartupReconciliation, clearSession };
}
