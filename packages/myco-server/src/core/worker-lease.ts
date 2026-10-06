import { SQL_NOW_MS, runDeadlineSql } from './run-deadline.js';

/** A worker credential already authenticated by the request pipeline. */
export interface AuthenticatedWorkerLease { tokenId: string; now: number }

/** Authorize the current attempt through its live stored owner and the caller's verified credential lineage. */
export function workerLeaseAuthority(lease: AuthenticatedWorkerLease, attemptId?: string | null, executionTime = false): { sql: string; params: unknown[] } {
  const instant = executionTime ? `MAX(?, ${SQL_NOW_MS})` : '?';
  return {
    sql: `status = 'running' AND lease_expires_at > ${instant}
      AND EXISTS (
        SELECT 1 FROM member_credentials caller
        JOIN member_credentials holder ON holder.id = agent_runs.leased_by
          AND holder.member_id = caller.member_id
          AND holder.machine_id IS caller.machine_id
          AND holder.lineage_root = caller.lineage_root
        JOIN members member ON member.id = holder.member_id AND member.revoked_at IS NULL
        WHERE caller.id = ? AND holder.revoked_at IS NULL AND holder.expires_at > ${instant}
          AND (caller.revoked_at IS NULL OR (caller.revoked_by IS NULL AND EXISTS (
            SELECT 1 FROM member_credentials successor
            WHERE successor.predecessor_id = caller.id AND successor.first_used_at IS NOT NULL
              AND successor.member_id = caller.member_id
              AND successor.machine_id IS caller.machine_id
              AND successor.lineage_root = caller.lineage_root
          )))
      )${attemptId === undefined ? '' : ' AND dispatched_by = ?'}`,
    params: [lease.now, lease.tokenId, lease.now, ...(attemptId === undefined ? [] : [attemptId])],
  };
}

/** A renewal requires the current attempt to remain inside its deadline. */
export function renewingLeaseAuthority(tokenId: string, now: number, dispatchedBy?: string | null, executionTime = false): { sql: string; params: unknown[] } {
  const authority = workerLeaseAuthority({ tokenId, now }, dispatchedBy, executionTime);
  const instant = executionTime ? `MAX(?, ${SQL_NOW_MS})` : '?';
  return { sql: `${authority.sql} AND ${runDeadlineSql()} > ${instant}`, params: [...authority.params, now] };
}
