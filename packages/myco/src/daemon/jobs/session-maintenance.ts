/**
 * Session maintenance job.
 *
 * Two tasks run in sequence:
 * 1. Complete stale active sessions — active sessions with no new prompts
 *    in more than the configured stale threshold are marked completed.
 * 2. Delete dead sessions — sessions with ≤ DEAD_SESSION_MAX_PROMPTS prompts
 *    are deleted via cascade, including vault file and embedding vector cleanup.
 */

import { getDatabase } from '@myco/db/client.js';
import { deleteSessionCascade } from '@myco/db/queries/sessions.js';
import {
  epochSeconds,
  MS_PER_SECOND,
  STALE_SESSION_THRESHOLD_MS,
  DEAD_SESSION_MAX_PROMPTS,
} from '../../constants.js';
import type { DaemonLogger } from '../logger.js';
import type { EmbeddingManager } from '../embedding/manager.js';
import { cleanupAfterSessionCascade } from './session-cleanup.js';
import { LOG_KINDS } from '../../constants/log-kinds.js';

/**
 * Complete active sessions whose last prompt is older than the stale threshold.
 *
 * Uses COALESCE to fall back to the session's started_at when no prompt
 * batches exist (session was registered but never received a prompt).
 *
 * The activity-timestamp predicate itself is the only protection: sessions
 * with recent work fall outside the stale window and won't be swept. A
 * previously-registered session that's been idle past the threshold is
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
  const cutoff = epochSeconds() - thresholdSeconds;

  const info = db.prepare(
    `UPDATE sessions
     SET status = 'completed', ended_at = COALESCE(ended_at, ?)
     WHERE status = 'active'
       AND COALESCE(
         (SELECT MAX(pb.started_at) FROM prompt_batches pb WHERE pb.session_id = sessions.id),
         sessions.started_at
       ) < ?`,
  ).run(epochSeconds(), cutoff);

  return info.changes;
}

/**
 * Find session IDs eligible for dead-session cleanup.
 *
 * A session is "dead" only if BOTH:
 *   1. Its status is NOT 'active' (prevents racing with a session that's
 *      currently running — active sessions get swept by the stale-session
 *      step first when truly idle).
 *   2. Its prompt_count is at most DEAD_SESSION_MAX_PROMPTS (default 0,
 *      meaning only empty "registered but never used" sessions qualify).
 *
 * Also excludes currently-registered in-memory sessions as a defense-in-depth
 * guard against TOCTOU between the status check and the delete.
 */
export function findDeadSessionIds(registeredSessionIds: string[]): string[] {
  const db = getDatabase();

  const excludePlaceholders = registeredSessionIds.length > 0
    ? `AND id NOT IN (${registeredSessionIds.map(() => '?').join(', ')})`
    : '';

  const params: unknown[] = [DEAD_SESSION_MAX_PROMPTS, ...registeredSessionIds];

  const rows = db.prepare(
    `SELECT id FROM sessions
     WHERE prompt_count <= ?
       AND status != 'active'
       ${excludePlaceholders}`,
  ).all(...params) as { id: string }[];

  return rows.map((r) => r.id);
}

export interface SessionMaintenanceDeps {
  logger: DaemonLogger;
  registeredSessionIds: () => string[];
  embeddingManager: EmbeddingManager;
  vaultDir: string;
  /**
   * Inactivity window (ms) after which an active session is marked completed.
   * When omitted, falls back to `STALE_SESSION_THRESHOLD_MS`.
   */
  staleThresholdMs?: number;
}

/**
 * Run both maintenance tasks in sequence:
 * 1. Complete stale active sessions
 * 2. Delete dead sessions (cascade)
 */
export async function runSessionMaintenance(deps: SessionMaintenanceDeps): Promise<void> {
  const { logger, registeredSessionIds, embeddingManager, vaultDir, staleThresholdMs } = deps;
  const registered = registeredSessionIds();

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
    const result = deleteSessionCascade(sessionId);
    if (!result.deleted) continue;

    await cleanupAfterSessionCascade(sessionId, result, embeddingManager, vaultDir);

    deletedCount++;
    logger.info(LOG_KINDS.MAINTENANCE_SESSION, 'Deleted dead session', {
      session_id: sessionId,
      counts: result.counts,
    });
  }

  if (deletedCount > 0) {
    logger.info(LOG_KINDS.MAINTENANCE_SESSION, 'Dead session cleanup complete', { deleted: deletedCount });
  }
}
