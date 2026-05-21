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
import { eventDedupKey, eventTimestampMs, EVENT_DEDUP_WINDOW_MS } from '@myco/capture/dedup.js';

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
  /**
   * Every buffer directory the reconciler should scan. One per registered
   * project under the global install at
   * `~/.myco/groves/<groveId>/projects/<projectId>/buffer/`. There is NO
   * legacy fallback — `capture/buffer-location.ts` enforces the
   * no-divergent-location invariant structurally, and the reconciler
   * trusts that contract. Derived from `listAllProjectBufferDirs()`.
   *
   * Order matters only for log determinism; per-session lookup tries each
   * directory in order and uses the first match (a session's events live
   * in exactly one dir).
   */
  bufferDirs: string[];
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
export function createReconciler({ bufferDirs, logger, projectRoot }: ReconcilerDeps): Reconciler {
  // Track sessions already reconciled this daemon lifetime to avoid
  // redundant file reads (startup scan + register + event can all fire).
  const reconciledSessions = new Set<string>();

  /**
   * Locate the buffer file for a session across all known buffer dirs.
   * Returns `{ dir, path, content }` for the first dir whose buffer file
   * exists and is non-empty, or `null` when no buffer holds this session.
   * The PR #346 invariant — "don't mark reconciled if buffer absent" —
   * lifts cleanly across multiple dirs: a session whose buffer hasn't
   * surfaced in any of them is genuinely absent, and the caller returns
   * without marking it.
   */
  function locateBufferContent(sessionId: string): { dir: string; content: string } | null {
    for (const dir of bufferDirs) {
      const bufferPath = path.join(dir, `${sessionId}.jsonl`);
      let raw: string;
      try {
        raw = fs.readFileSync(bufferPath, 'utf-8').trim();
      } catch {
        continue;
      }
      if (raw) return { dir, content: raw };
    }
    return null;
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

    // Locate the session's buffer across every known dir. Buffer file
    // absent in every dir → return WITHOUT marking reconciled so a later
    // call (after the buffer appears) can replay it.
    const located = locateBufferContent(sessionId);
    if (!located) return;
    const content = located.content;

    // Session row absent (deleted, or not yet created by an /events
    // POST). Return WITHOUT marking reconciled — if the row later
    // appears, the next call must be free to replay.
    if (!getSession(sessionId, ALL_PROJECTS_SCOPE)) {
      logger.debug(LOG_KINDS.LIFECYCLE_RECONCILE, 'Skipping reconciliation — session row absent', { session_id: sessionId });
      return;
    }

    // Both preconditions hold; mark reconciled so the startup loop and
    // a later /events auto-register don't replay it twice.
    reconciledSessions.add(sessionId);

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

    // Replay full event stream from the divergence point. Two guards apply
    // before each event hits replayEvent:
    //
    //   1. Type filter (REPLAYABLE_EVENT_TYPES).
    //   2. Content+window dedup that mirrors the live dispatcher
    //      (`event-dispatch.ts`). The hook CLI writes to the buffer file
    //      whenever the daemon returns `ignored: 'duplicate'` (see
    //      `hooks/send-event.ts`), so without this guard the replay path
    //      re-inserts events the live path already rejected. Both paths
    //      now use the same key from `@myco/capture/dedup.js`.
    const eventsToReplay = allEvents.slice(replayStartIndex).filter(
      (e) => REPLAYABLE_EVENT_TYPES.has(String(e.type)),
    );

    let promptsRecovered = 0;
    let activitiesRecovered = 0;
    let duplicatesSuppressed = 0;
    const seenKeys = new Map<string, number>();

    for (const event of eventsToReplay) {
      const eventWithSession = {
        ...event,
        type: String(event.type),
        session_id: sessionId,
      } as Record<string, unknown> & { type: string; session_id: string };
      const key = eventDedupKey(eventWithSession);
      const ts = eventTimestampMs(event) ?? Date.now();
      const lastSeen = seenKeys.get(key);
      if (lastSeen !== undefined && ts - lastSeen < EVENT_DEDUP_WINDOW_MS) {
        duplicatesSuppressed++;
        continue;
      }
      seenKeys.set(key, ts);

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

    if (promptsRecovered > 0 || activitiesRecovered > 0 || duplicatesSuppressed > 0) {
      logger.info(LOG_KINDS.LIFECYCLE_RECONCILE, 'Buffer reconciliation complete', {
        session_id: sessionId,
        prompts_recovered: promptsRecovered,
        activities_recovered: activitiesRecovered,
        duplicates_suppressed: duplicatesSuppressed,
      });
    }
  }

  /**
   * Run startup reconciliation: clean stale buffers, then reconcile all
   * buffer sessions found on disk.
   */
  function runStartupReconciliation(): void {
    // Clean up stale buffer files (>24h) on startup across every known dir.
    let totalCleaned = 0;
    for (const dir of bufferDirs) {
      totalCleaned += cleanStaleBuffers(dir, STALE_BUFFER_MAX_AGE_MS);
    }
    if (totalCleaned > 0) {
      logger.info(LOG_KINDS.CAPTURE_BUFFER, 'Buffer cleanup complete', { stale_removed: totalCleaned });
    }

    // Reconcile every remaining buffer file across all known dirs. A
    // session shows up at most once even if its buffer lives in only one
    // dir — `reconcileSession` is idempotent across multiple invocations
    // via the `reconciledSessions` set.
    const seen = new Set<string>();
    for (const dir of bufferDirs) {
      for (const sessionId of listBufferSessionIds(dir)) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        try {
          reconcileSession(sessionId);
        } catch (err) {
          logger.warn(LOG_KINDS.LIFECYCLE_RECONCILE, 'Startup reconciliation failed', { session_id: sessionId, error: String(err) });
        }
      }
    }
  }

  function clearSession(sessionId: string): void {
    reconciledSessions.delete(sessionId);
  }

  return { reconcileSession, replayEvent, runStartupReconciliation, clearSession };
}
