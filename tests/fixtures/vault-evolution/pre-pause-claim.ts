import type { RelationalStore } from '@myco-server-worker/core/adapters.js';

/** A selected queued row's pre-pause write has no schema marker condition. */
export async function oldClaim(db: RelationalStore, projectId: string, id: string, now: number): Promise<boolean> {
  const result=await db.prepare(`UPDATE agent_runs SET status='running',started_at=?
    WHERE project_id=? AND id=? AND status='queued' AND dispatched_by IS NULL`).bind(now,projectId,id).run();
  return result.meta.changes===1;
}
