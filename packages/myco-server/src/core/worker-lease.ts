import { SQL_NOW_MS, runDeadlineSql } from './run-deadline.js';
import { runnerCredentialAuthority } from '../auth/runners.js';

/**
 * The executor the request pipeline authenticated on a worker control route: a legacy worker presenting an
 * administrator's member credential, or a runner presenting its own. Every lease reader and writer branches on it.
 */
export type WorkerPrincipal =
  | { kind: 'member'; tokenId: string; machineId: string }
  | { kind: 'runner'; runnerId: string; credentialId: string; machineId: string | null };

/** What a lease authority is decided on: the member credential a legacy lease names, or a runner and its presenting credential. */
export type LeaseHolder = { kind: 'member'; tokenId: string } | { kind: 'runner'; runnerId: string; credentialId: string };

/** The column pair a lease names for this executor: a member credential in `leased_by`, or a runner and its credential. */
export function leaseOwnerColumns(worker: WorkerPrincipal): { leasedBy: string | null; runnerId: string | null; runnerCredentialId: string | null } {
  return worker.kind === 'member'
    ? { leasedBy: worker.tokenId, runnerId: null, runnerCredentialId: null }
    : { leasedBy: null, runnerId: worker.runnerId, runnerCredentialId: worker.credentialId };
}

/** The key a worker's report is held under in the fleet: its credential for a legacy worker, its stable id for a runner. */
export const workerKey = (worker: WorkerPrincipal): string => (worker.kind === 'member' ? worker.tokenId : worker.runnerId);

/**
 * Authorize the current attempt through its live stored owner and the caller's verified identity. A legacy worker's
 * lease binds the caller's member credential lineage and machine; a runner's binds the runner and a credential of its
 * current epoch, whichever of its rotations presents it.
 */
export function workerLeaseAuthority(worker: LeaseHolder, now: number, attemptId?: string | null, executionTime = false): { sql: string; params: unknown[] } {
  const instant = executionTime ? `MAX(?, ${SQL_NOW_MS})` : '?';
  const attempt = attemptId === undefined ? '' : ' AND dispatched_by = ?';
  const attemptParams = attemptId === undefined ? [] : [attemptId];
  if (worker.kind === 'runner') {
    return {
      sql: `status = 'running' AND lease_expires_at > ${instant} AND leased_by IS NULL
        AND EXISTS (SELECT 1 FROM runner_credentials caller
          WHERE caller.id = ? AND caller.runner_id = agent_runs.leased_runner_id AND ${runnerCredentialAuthority('caller', instant)})${attempt}`,
      params: [now, worker.credentialId, now, ...attemptParams],
    };
  }
  return {
    sql: `status = 'running' AND lease_expires_at > ${instant} AND leased_runner_id IS NULL
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
      )${attempt}`,
    params: [now, worker.tokenId, now, ...attemptParams],
  };
}

/** A renewal requires the current attempt to remain inside its deadline. */
export function renewingLeaseAuthority(worker: LeaseHolder, now: number, dispatchedBy?: string | null, executionTime = false): { sql: string; params: unknown[] } {
  const authority = workerLeaseAuthority(worker, now, dispatchedBy, executionTime);
  const instant = executionTime ? `MAX(?, ${SQL_NOW_MS})` : '?';
  return { sql: `${authority.sql} AND ${runDeadlineSql()} > ${instant}`, params: [...authority.params, now] };
}
