import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';
import type { LeaseOwner } from '@myco-server-worker/core/runs.js';

export async function oldRequeueLapsedLease(db: RelationalStore, scope: ReadScope, runId: string, owner: LeaseOwner | null, now: number): Promise<boolean> {
  const named = owner === null ? 'leased_by IS NULL AND leased_runner_id IS NULL'
    : owner.kind === 'member' ? 'leased_by = ? AND leased_runner_id IS NULL' : 'leased_by IS NULL AND leased_runner_id = ? AND leased_runner_credential_id = ?';
  const params = owner === null ? [] : owner.kind === 'member' ? [owner.leasedBy] : [owner.runnerId, owner.credentialId];
  const result = await db.prepare(
    `UPDATE agent_runs SET status = 'queued', leased_by = NULL, leased_runner_id = NULL, leased_runner_credential_id = NULL,
        lease_expires_at = NULL, dispatched_by = NULL, started_at = NULL, held_by = 'worker'
      WHERE project_id = ? AND id = ? AND status = 'running' AND ${named} AND lease_expires_at <= ?`,
  ).bind(scope.projectId, runId, ...params, now).run();
  return result.meta.changes === 1;
}
