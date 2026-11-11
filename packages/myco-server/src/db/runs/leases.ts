import type { RelationalStore } from '../../core/adapters.js';
import type { ReadScope } from '../../read/scope.js';
import { renewingLeaseAuthority } from '../runners/lease-authority.js';
import type { WorkerPrincipal } from '../../core/worker-lease.js';
import { runDeadlineSql } from '../../core/run-deadline.js';
import { commit, first, read, readSet, write, type BindValue, type Bound, type Statement } from '../index.js';
import { leaseShape, shapedStatements } from './statement-shapes.js';

/** Worker identity and the instant its preparation write is admitted. */
export interface RunLease { worker: WorkerPrincipal; now: number }

const leaseRenewal = shapedStatements<Statement<BindValue[], { expiresAt: number }, 'write'>>();
const leaseExpiry = shapedStatements<Statement<BindValue[], { expiresAt: number }, 'read'>>();

/** Extend a lease the caller still holds, recording when it was last renewed. Null says the lease is gone: swept, or the run ended. */
export async function renewRunLeaseExpiry(
  db: RelationalStore, scope: ReadScope, runId: string, worker: WorkerPrincipal, expiresAt: number, now: number, dispatchedBy?: string, contact?: Bound | null,
): Promise<number | null> {
  const authority = renewingLeaseAuthority(worker, now, dispatchedBy, true);
  const deadline = runDeadlineSql();
  const renewal = leaseRenewal(leaseShape(worker, dispatchedBy), shape => write<BindValue[], { expiresAt: number }>({ name: `runs.renewLease${shape}`, sql:
    `UPDATE agent_runs SET lease_expires_at = MIN(${deadline}, MAX(lease_expires_at, ?)), last_renewed_at = MAX(COALESCE(last_renewed_at, 0), ?)
      WHERE project_id = ? AND id = ? AND ${authority.sql} RETURNING lease_expires_at AS expiresAt` }));
  const [result] = await commit(db, renewal.bind(expiresAt, now, scope.projectId, runId, ...authority.params as BindValue[]), ...(contact == null ? [] : [contact]));
  return result.results[0]?.expiresAt ?? null;
}

/** Extend a held lease through the shared renewal and report whether it landed. */
export async function renewRunLease(
  db: RelationalStore, scope: ReadScope, runId: string, worker: WorkerPrincipal, expiresAt: number, now: number, dispatchedBy?: string,
): Promise<boolean> {
  return await renewRunLeaseExpiry(db, scope, runId, worker, expiresAt, now, dispatchedBy) !== null;
}

/** Read the expiry only while the authenticated worker still holds this attempt. */
export async function workerRunLeaseExpiry(
  db: RelationalStore, scope: ReadScope, runId: string, worker: WorkerPrincipal, now: number, dispatchedBy?: string,
): Promise<number | null> {
  const authority = renewingLeaseAuthority(worker, now, dispatchedBy, true);
  const definition = leaseExpiry(leaseShape(worker, dispatchedBy), shape => read<BindValue[], { expiresAt: number }>({ name: `runs.leaseExpiry${shape}`, sql:
    `SELECT lease_expires_at AS expiresAt FROM agent_runs
    WHERE project_id = ? AND id = ? AND ${authority.sql}` }));
  const row = await first(db, definition.bind(scope.projectId, runId, ...authority.params as BindValue[]));
  return row?.expiresAt ?? null;
}

/**
 * Every run whose lease has lapsed, with the credential each still names, so the
 * release can retire what the row held. Unordered on purpose: expiry is not a
 * queue and every row read here is requeued, so an order would buy a sort over
 * the running rows and change nothing.
 */
export type LeaseOwner = { kind: 'member'; leasedBy: string } | { kind: 'runner'; runnerId: string; credentialId: string };

/** The owner a stored lease names, or null for a row that names none. */
function leaseOwnerOf(row: { leasedBy: string | null; leasedRunnerId: string | null; leasedRunnerCredentialId: string | null }): LeaseOwner | null {
  if (row.leasedRunnerId !== null && row.leasedRunnerCredentialId !== null) return { kind: 'runner', runnerId: row.leasedRunnerId, credentialId: row.leasedRunnerCredentialId };
  return row.leasedBy === null ? null : { kind: 'member', leasedBy: row.leasedBy };
}

const lapsed = read<[now: number, limit: number], { projectId: string; id: string; leasedBy: string | null; leasedRunnerId: string | null; leasedRunnerCredentialId: string | null; dispatchedBy: string | null }>({ name: 'runs.lapsedLeases', sql:
  `SELECT project_id AS projectId, id, leased_by AS leasedBy, leased_runner_id AS leasedRunnerId, leased_runner_credential_id AS leasedRunnerCredentialId,
          dispatched_by AS dispatchedBy FROM agent_runs
   WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1 LIMIT ?2` });

export async function lapsedLeases(db: RelationalStore, now: number, limit: number): Promise<Array<{ projectId: string; id: string; owner: LeaseOwner | null; dispatchedBy: string | null }>> {
  const [rows] = await readSet(db, lapsed.bind(now, limit));
  return rows.map(({ leasedBy, leasedRunnerId, leasedRunnerCredentialId, ...row }) => ({ ...row, owner: leaseOwnerOf({ leasedBy, leasedRunnerId, leasedRunnerCredentialId }) }));
}

/** A run with a single-flight subject ends when its lease lapses: its work stays due and a later claim pulls it again. */
const LEASE_LAPSED = 'lease_lapsed';

const settleSet = (named: string, attempt: number, at: number) => `UPDATE agent_runs SET status = CASE WHEN subject IS NOT NULL THEN 'failed' ELSE 'queued' END,
    completed_at = CASE WHEN subject IS NOT NULL THEN ?1 ELSE completed_at END,
    error_code = CASE WHEN subject IS NOT NULL THEN '${LEASE_LAPSED}' ELSE error_code END,
    error = CASE WHEN subject IS NOT NULL THEN 'The lease lapsed; the work stays due and is pulled again' ELSE error END,
    dispatched_by = CASE WHEN subject IS NOT NULL THEN dispatched_by ELSE NULL END,
    started_at = CASE WHEN subject IS NOT NULL THEN started_at ELSE NULL END,
    held_by = CASE WHEN subject IS NOT NULL THEN NULL ELSE 'worker' END,
    leased_by = NULL, leased_runner_id = NULL, leased_runner_credential_id = NULL, lease_expires_at = NULL
  WHERE project_id = ?2 AND id = ?3 AND status = 'running' AND ${named} AND dispatched_by IS ?${attempt} AND lease_expires_at <= ?${at} RETURNING id`;
type SettleBase = [now: number, project: string, run: string];
const settleNoOwner = write<[...SettleBase, attempt: string | null, at: number], { id: string }>({ name: 'runs.settleLapsedNoOwner', sql: settleSet('leased_by IS NULL AND leased_runner_id IS NULL', 4, 5) });
const settleMember = write<[...SettleBase, leasedBy: string, attempt: string | null, at: number], { id: string }>({ name: 'runs.settleLapsedMember', sql: settleSet('leased_by = ?4 AND leased_runner_id IS NULL', 5, 6) });
const settleRunner = write<[...SettleBase, runner: string, credential: string, attempt: string | null, at: number], { id: string }>({ name: 'runs.settleLapsedRunner', sql: settleSet('leased_by IS NULL AND leased_runner_id = ?4 AND leased_runner_credential_id = ?5', 6, 7) });

/** Settle an expired attempt under its exact owner and attempt identity; subject runs end instead of requeuing. */
export async function settleLapsedLease(db: RelationalStore, scope: ReadScope, runId: string, owner: LeaseOwner | null, attemptId: string | null, now: number): Promise<boolean> {
  const [result] = await commit(db, owner === null ? settleNoOwner.bind(now, scope.projectId, runId, attemptId, now)
    : owner.kind === 'member' ? settleMember.bind(now, scope.projectId, runId, owner.leasedBy, attemptId, now)
      : settleRunner.bind(now, scope.projectId, runId, owner.runnerId, owner.credentialId, attemptId, now));
  return result.results.length === 1;
}
