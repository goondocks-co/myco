/**
 * Session deletion retains its identity and tombstone, clears its title and summary, and removes captured projections, the
 * context served to it and the record of which runs read or were served it. A spore kept from it names no prompt of it.
 * Saved knowledge, the runs themselves and other sessions remain. Reads exclude tombstones; ingestion refuses subsequent
 * capture and import for the same session ID.
 *
 * Deletion is one accepted job: acceptance commits the tombstone at once, and a durable job removes the rest in bounded
 * pages, each page recording its blob release candidates in the commit that removes its rows.
 */
import type { ServerEnv } from './adapters.js';
import { acceptSessionDeletion, type DeletionProgress } from '../db/sessions/deletion.js';
import type { ReadScope } from '../read/scope.js';
import { emit } from '../telemetry.js';

/** Accepts a session's deletion and hands back its job's progress; null when the Project holds no such session. Accepting it again changes nothing. */
export async function tombstoneSession(
  env: Pick<ServerEnv, 'db'>, scope: ReadScope, sessionId: string, by: string, nowMs: number, reason?: string,
): Promise<DeletionProgress | null> {
  const progress = await acceptSessionDeletion(env.db, { projectId: scope.projectId, sessionId, by, ...(reason === undefined ? {} : { reason }), now: nowMs });
  if (progress !== null) emit({ kind: 'session_tombstoned', projectId: scope.projectId, sessionId, phase: progress.phase, state: progress.state });
  return progress;
}
