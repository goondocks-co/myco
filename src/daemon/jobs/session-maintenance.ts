/**
 * Session maintenance job.
 *
 * Two tasks run in sequence:
 * 1. Complete stale active sessions — active sessions with no new prompts
 *    in more than STALE_SESSION_THRESHOLD_MS are marked completed.
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

const LOG_CATEGORY = 'session-maintenance';

/** Stale threshold in epoch seconds (derived from the ms constant). */
const STALE_SESSION_THRESHOLD_S = STALE_SESSION_THRESHOLD_MS / MS_PER_SECOND;

/**
 * Complete active sessions whose last prompt is older than the stale threshold.
 *
 * Uses COALESCE to fall back to the session's started_at when no prompt
 * batches exist (session was registered but never received a prompt).
 *
 * @returns number of sessions completed
 */
export function completeStaleActiveSessions(registeredSessionIds: string[]): number {
  const db = getDatabase();
  const cutoff = epochSeconds() - STALE_SESSION_THRESHOLD_S;

  // Build exclusion clause for registered sessions
  const excludePlaceholders = registeredSessionIds.length > 0
    ? `AND id NOT IN (${registeredSessionIds.map(() => '?').join(', ')})`
    : '';

  const params: unknown[] = [cutoff, ...registeredSessionIds];

  const info = db.prepare(
    `UPDATE sessions
     SET status = 'completed'
     WHERE status = 'active'
       AND COALESCE(
         (SELECT MAX(pb.started_at) FROM prompt_batches pb WHERE pb.session_id = sessions.id),
         sessions.started_at
       ) < ?
       ${excludePlaceholders}`,
  ).run(...params);

  return info.changes;
}

/**
 * Find session IDs with prompt_count <= DEAD_SESSION_MAX_PROMPTS.
 *
 * Excludes currently registered sessions.
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
       ${excludePlaceholders}`,
  ).all(...params) as { id: string }[];

  return rows.map((r) => r.id);
}

export interface SessionMaintenanceDeps {
  logger: DaemonLogger;
  registeredSessionIds: () => string[];
  embeddingManager: EmbeddingManager;
  vaultDir: string;
}

/**
 * Run both maintenance tasks in sequence:
 * 1. Complete stale active sessions
 * 2. Delete dead sessions (cascade)
 */
export async function runSessionMaintenance(deps: SessionMaintenanceDeps): Promise<void> {
  const { logger, registeredSessionIds, embeddingManager, vaultDir } = deps;
  const registered = registeredSessionIds();

  // Task 1: Complete stale sessions
  const completed = completeStaleActiveSessions(registered);
  if (completed > 0) {
    logger.info(LOG_CATEGORY, 'Completed stale sessions', { count: completed });
  }

  // Task 2: Delete dead sessions
  const deadIds = findDeadSessionIds(registered);
  if (deadIds.length === 0) return;

  let deletedCount = 0;
  for (const sessionId of deadIds) {
    const result = deleteSessionCascade(sessionId);
    if (!result.deleted) continue;

    // Post-transaction cleanup: embedding vectors
    try { embeddingManager.onRemoved('sessions', sessionId); } catch { /* best-effort */ }
    for (const sporeId of result.deletedSporeIds) {
      try { embeddingManager.onRemoved('spores', sporeId); } catch { /* best-effort */ }
    }

    // Post-transaction cleanup: vault files (fire-and-forget)
    try {
      const { unlink, glob } = await import('node:fs/promises');
      try {
        for await (const f of glob(`sessions/**/session-${sessionId}.md`, { cwd: vaultDir })) {
          await unlink(`${vaultDir}/${f}`).catch(() => {});
        }
      } catch { /* best-effort */ }

      for (const sporeId of result.deletedSporeIds) {
        try {
          for await (const f of glob(`spores/**/${sporeId}*.md`, { cwd: vaultDir })) {
            await unlink(`${vaultDir}/${f}`).catch(() => {});
          }
        } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }

    deletedCount++;
    logger.info(LOG_CATEGORY, 'Deleted dead session', {
      session_id: sessionId,
      counts: result.counts,
    });
  }

  if (deletedCount > 0) {
    logger.info(LOG_CATEGORY, 'Dead session cleanup complete', { deleted: deletedCount });
  }
}
