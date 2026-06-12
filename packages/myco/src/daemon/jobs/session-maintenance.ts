/**
 * Session maintenance job.
 *
 * Two tasks run in sequence:
 * 1. Complete stale active sessions — active sessions with no new prompts
 *    in more than the configured stale threshold are marked completed.
 * 2. Delete dead sessions — sessions with ≤ DEAD_SESSION_MAX_PROMPTS prompts
 *    are deleted via cascade, including vault file and embedding vector cleanup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { closeSession, deleteSessionCascade } from '@myco/db/queries/sessions.js';
import { SESSION_TOMBSTONE_SOURCE, pruneSessionTombstones } from '@myco/db/queries/session-tombstones.js';
import { removeBufferLockCompanion } from '@myco/capture/buffer.js';
import { resolveBufferDirForProjectId } from '@myco/capture/buffer-location.js';
import {
  epochSeconds,
  MS_PER_SECOND,
  STALE_SESSION_THRESHOLD_MS,
  DEAD_SESSION_MAX_PROMPTS,
  TOMBSTONE_RETENTION_MS,
} from '../../constants.js';
import type { Logger } from '../logger.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import { cleanupAfterSessionCascade } from './session-cleanup.js';
import { LOG_KINDS } from '../../constants/log-kinds.js';

/**
 * Complete active sessions whose last prompt is older than the stale threshold.
 *
 * The freshness predicate considers two timestamp sources:
 *   - prompt_batches.started_at  — when the last user prompt arrived
 *   - activities.timestamp       — when the last tool_use / subagent event was
 *                                  recorded (emitted continuously during long
 *                                  agentic turns even within a single open batch)
 *
 * A session is only swept if BOTH sources are beyond the stale window.
 * The COALESCE falls back to sessions.started_at when neither table has rows.
 *
 * This prevents the bug where a session running many tool calls under a single
 * long prompt batch (opened >60 min ago) was incorrectly swept mid-flight
 * because the sweep saw only prompt_batches.started_at.
 *
 * A previously-registered session that's been idle past the threshold is
 * swept normally — if it later receives a new event, `event-dispatch.ts`
 * upserts it back to `status='active'`, so marking completed is reversible.
 *
 * @param thresholdSeconds window of inactivity before a session is stale
 * @returns number of sessions completed
 */
export function completeStaleActiveSessions(
  thresholdSeconds: number = STALE_SESSION_THRESHOLD_MS / MS_PER_SECOND,
): number {
  const db = getDatabase();
  const now = epochSeconds();
  const cutoff = now - thresholdSeconds;

  // Select first (rather than a bulk UPDATE) so we have the swept session ids
  // and can close each one's still-open batch in the same pass.
  const staleIds = db.prepare(
    `SELECT id FROM sessions
      WHERE status = 'active'
        AND COALESCE(
          (SELECT MAX(touch) FROM (
            SELECT MAX(pb.started_at) AS touch
              FROM prompt_batches pb
             WHERE pb.session_id = sessions.id
            UNION ALL
            SELECT MAX(a.timestamp) AS touch
              FROM activities a
             WHERE a.session_id = sessions.id
          )),
          sessions.started_at
        ) < ?`,
  ).all(cutoff).map((r) => (r as { id: string }).id);

  if (staleIds.length === 0) return 0;

  // closeSession is the completion chokepoint — it flips status, stamps
  // ended_at, closes any still-open batch (so a session swept without a final
  // Stop doesn't keep a perpetually-open turn), and enqueues the session for
  // team sync. Done per-id in one transaction.
  db.transaction(() => {
    for (const id of staleIds) closeSession(id, now);
  })();

  return staleIds.length;
}

/**
 * Find session IDs eligible for dead-session cleanup.
 *
 * "Dead" requires both:
 *   1. status != 'active' (avoids racing currently-running sessions; the
 *      stale-session step handles those when truly idle).
 *   2. actual prompt_batches count <= DEAD_SESSION_MAX_PROMPTS (default 0).
 *
 * Counts come from prompt_batches directly, not `sessions.prompt_count` —
 * the cached column can drift low and falsely qualify a session that has
 * batches. Uses NOT EXISTS for the default zero-threshold path (fast,
 * short-circuits on first hit per session) and a correlated COUNT for
 * any non-default threshold.
 *
 * `registeredSessionIds` are excluded as defense-in-depth against TOCTOU
 * between the status check and the delete.
 */
export function findDeadSessionIds(registeredSessionIds: string[]): string[] {
  const db = getDatabase();

  const excludePlaceholders = registeredSessionIds.length > 0
    ? `AND s.id NOT IN (${registeredSessionIds.map(() => '?').join(', ')})`
    : '';

  const fastPath = DEAD_SESSION_MAX_PROMPTS === 0;
  const countPredicate = fastPath
    ? `NOT EXISTS (SELECT 1 FROM prompt_batches pb WHERE pb.session_id = s.id)`
    : `(SELECT COUNT(*) FROM prompt_batches pb WHERE pb.session_id = s.id) <= ?`;

  const params: unknown[] = fastPath
    ? [...registeredSessionIds]
    : [DEAD_SESSION_MAX_PROMPTS, ...registeredSessionIds];

  const rows = db.prepare(
    `SELECT s.id FROM sessions s
     WHERE ${countPredicate}
       AND s.status != 'active'
       ${excludePlaceholders}`,
  ).all(...params) as { id: string }[];

  return rows.map((r) => r.id);
}

export interface SessionMaintenanceDeps {
  logger: Logger;
  registeredSessionIds: () => string[];
  embeddingManager: EmbeddingManager;
  /**
   * Resolve the on-disk vault dir for a session's project so per-project
   * markdown and attachment cleanup targets the right tree. The argument
   * is the deleted session's `project_id`. Returning `null` skips the
   * filesystem cleanup pass for that session — DB rows are still removed.
   *
   * In multi-Grove fan-out the resolver is built per Grove from the
   * Grove's registered projects; in legacy single-vault mode it returns
   * the boot vaultDir for any project id.
   */
  resolveProjectVaultDir: (projectId: string | null) => string | null;
  /**
   * Inactivity window (ms) after which an active session is marked completed.
   * When omitted, falls back to `STALE_SESSION_THRESHOLD_MS`.
   */
  staleThresholdMs?: number;
  /**
   * The reconciler's convergence probe (`Reconciler.hasUnconvergedBuffer`).
   * A zero-batch session whose buffer has NOT been converged this daemon
   * lifetime is deferred for one sweep cycle — the next reconcile trigger
   * either replays it (the session then has batches and stops qualifying
   * as dead) or proves it genuinely empty. Optional: when absent, the
   * sweep behaves as before (tests, legacy callers).
   */
  hasUnconvergedBuffer?: (sessionId: string) => boolean;
}

/**
 * Run both maintenance tasks in sequence:
 * 1. Complete stale active sessions
 * 2. Delete dead sessions (cascade)
 */
export async function runSessionMaintenance(deps: SessionMaintenanceDeps): Promise<void> {
  const { logger, registeredSessionIds, embeddingManager, resolveProjectVaultDir, staleThresholdMs } = deps;
  const registered = registeredSessionIds();

  // Reclaim tombstones older than the retention window. Retention outlives
  // every buffer-retention window, so by the time a tombstone is pruned no
  // buffer file for that session can still exist to resurrect it.
  const prunedTombstones = pruneSessionTombstones(TOMBSTONE_RETENTION_MS);
  if (prunedTombstones > 0) {
    logger.info(LOG_KINDS.MAINTENANCE_SESSION, 'Pruned expired session tombstones', { count: prunedTombstones });
  }

  // Task 1: Complete stale sessions
  const thresholdSeconds = (staleThresholdMs ?? STALE_SESSION_THRESHOLD_MS) / MS_PER_SECOND;
  const completed = completeStaleActiveSessions(thresholdSeconds);
  if (completed > 0) {
    logger.info(LOG_KINDS.MAINTENANCE_SESSION, 'Completed stale sessions', { count: completed });
  }

  // Task 2: Delete dead sessions
  const deadIds = findDeadSessionIds(registered);
  if (deadIds.length === 0) return;

  let deletedCount = 0;
  for (const sessionId of deadIds) {
    // A zero-batch session with an unconverged buffer may only LOOK dead —
    // its prompts could still be sitting unreplayed on disk. Defer this
    // cycle; the next reconcile trigger converges the buffer, after which
    // the session either has batches (no longer dead) or is genuinely empty
    // and sweeps normally.
    if (deps.hasUnconvergedBuffer?.(sessionId)) {
      logger.debug(LOG_KINDS.MAINTENANCE_SESSION, 'Deferred dead-session sweep — unconverged buffer present', {
        session_id: sessionId,
      });
      continue;
    }

    const result = deleteSessionCascade(sessionId, SESSION_TOMBSTONE_SOURCE.MAINTENANCE_SWEEP);
    if (!result.deleted) continue;

    // Buffer journal lives under the GROVE project dir; resolve from the
    // deleted row's project id. Unresolvable → skip the buffer file (the
    // tombstone keeps it inert), never guess a path.
    const bufferDir = resolveBufferDirForProjectId(result.projectId);
    const vaultDir = resolveProjectVaultDir(result.projectId);
    if (vaultDir) {
      await cleanupAfterSessionCascade(sessionId, result, embeddingManager, vaultDir, bufferDir);
    } else {
      // No registered project — vector cleanup still runs; vault files
      // (if any) are unreachable without a project root, so skip the
      // filesystem pass rather than guess. The buffer journal is still
      // removed when its Grove dir resolved.
      for (const sporeId of result.deletedSporeIds) {
        try { embeddingManager.onRemoved('spores', sporeId); } catch { /* best-effort */ }
      }
      try { embeddingManager.onRemoved('sessions', sessionId); } catch { /* best-effort */ }
      if (bufferDir) {
        try { fs.unlinkSync(path.join(bufferDir, `${sessionId}.jsonl`)); } catch { /* best-effort */ }
        removeBufferLockCompanion(bufferDir, sessionId);
      }
    }

    deletedCount++;
    logger.info(LOG_KINDS.MAINTENANCE_SESSION, 'Deleted dead session', {
      session_id: sessionId,
      project_id: result.projectId,
      counts: result.counts,
    });
  }

  if (deletedCount > 0) {
    logger.info(LOG_KINDS.MAINTENANCE_SESSION, 'Dead session cleanup complete', { deleted: deletedCount });
  }
}
