import { deletionProgress, advanceSessionDeletions } from '@myco-server-worker/db/sessions/deletion.js';
import { tombstoneSession as acceptSessionDeletion } from '@myco-server-worker/core/tombstones.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';

/** Runs every deletion job forward until none has work a wake would take. */
export async function drainSessionDeletions(env: Pick<ServerEnv, 'db'>, now: number): Promise<void> {
  for (let wake = 0; wake < 10_000; wake += 1) {
    if (!(await advanceSessionDeletions(env.db, now)).more) return;
  }
  throw new Error('session deletion did not settle');
}

/** Accepts a deletion and runs its job to the end: the outcome a caller reads off the finished job. */
export async function tombstoneSession(env: Pick<ServerEnv, 'db'>, scope: ReadScope, sessionId: string, by: string, nowMs: number, reason?: string) {
  const accepted = await acceptSessionDeletion(env, scope, sessionId, by, nowMs, reason);
  if (accepted === null) return { applied: false, removed: 0, blobsFreed: 0, blobsLeft: 0 };
  await drainSessionDeletions(env, nowMs);
  const finished = await deletionProgress(env.db, scope.projectId, sessionId, nowMs);
  return { applied: true, removed: finished?.removed ?? 0, blobsFreed: finished?.blobsReleased ?? 0, blobsLeft: 0 };
}
