/**
 * Attempt cost settlement and the restore of attempt and estimator rows.
 *
 * A restored row lists exactly the columns its artifact line carries, so each column list is its own statement shape.
 */
import type { LeaseHolder } from '../../core/worker-lease.js';
import { write, type BindValue, type Bound, type Statement } from '../index.js';
import { restoredColumnStatements, restoredValues } from '../recovery/restored-columns.js';
import { workerLeaseAuthority } from '../runners/lease-authority.js';
import { TERMINAL_RUN_STATUSES } from './lifecycle.js';
import { leaseShape, shapedStatements } from './statement-shapes.js';

/** Restored attempt columns a destination may fill where its own row holds nothing. */
export const RESTORE_CLAIM_FIELDS: ReadonlySet<string> = new Set(['claimed_at', 'leased_by', 'machine_id', 'owner_kind', 'runner_id', 'estimate_usd', 'cost_usd', 'cost_source', 'profile_json']);

const settlements = shapedStatements<Statement<BindValue[], never, 'write'>>();

/** Cost can settle only while this exact attempt remains under the authenticated live lease. */
export function settleAttemptCost(
  projectId: string, runId: string, attemptId: string, worker: LeaseHolder, now: number, cost: number | null, source: string | null,
): Bound<never, 'write'> {
  const authority = workerLeaseAuthority(worker, now, attemptId, true);
  const definition = settlements(leaseShape(worker, attemptId), shape => write<BindValue[]>({ name: `runs.settleAttemptCost${shape}`, sql:
    `UPDATE agent_run_attempts SET cost_usd=?,cost_source=? WHERE project_id=? AND run_id=? AND attempt_id=?
    AND EXISTS(SELECT 1 FROM agent_runs WHERE project_id=? AND id=? AND ${authority.sql})` }));
  return definition.bind(cost, source, projectId, runId, attemptId, projectId, runId, ...(authority.params as BindValue[]));
}

const agentStateRestores = restoredColumnStatements<{ rowid: number }, 'write'>('runs.restoreAgentState');

/** An estimator or agent state row, added where the destination holds none under its key. */
export function restoreAgentStateRow(row: Readonly<Record<string, unknown>>, columns: readonly string[]): Bound<{ rowid: number }, 'write'> {
  const definition = agentStateRestores(columns, (name, list) => write<BindValue[], { rowid: number }>({ name, sql:
    `INSERT OR IGNORE INTO agent_state(${list.join(',')}) VALUES(${list.map(() => '?').join(',')}) RETURNING rowid` }));
  return definition.bind(...restoredValues(row, columns));
}

const attemptRestores = restoredColumnStatements<{ rowid: number }, 'write'>('runs.restoreAttempt');

/** An attempt row, added, or filling the claim fields the destination's copy of it holds nothing in. */
export function restoreAttemptRow(row: Readonly<Record<string, unknown>>, columns: readonly string[]): Bound<{ rowid: number }, 'write'> {
  const definition = attemptRestores(columns, (name, list) => {
    const updates = list.filter(column => RESTORE_CLAIM_FIELDS.has(column));
    const desired = (column: string) => column === 'cost_source'
      ? 'CASE WHEN excluded.cost_usd IS NULL THEN agent_run_attempts.cost_source ELSE COALESCE(excluded.cost_source,agent_run_attempts.cost_source) END'
      : `COALESCE(excluded.${column},agent_run_attempts.${column})`;
    return write<BindValue[], { rowid: number }>({ name, sql: `INSERT INTO agent_run_attempts(${list.join(',')}) VALUES(${list.map(() => '?').join(',')})
    ON CONFLICT(project_id,run_id,attempt_id) DO UPDATE SET ${updates.map(column => `${column}=${desired(column)}`).join(',')}
    WHERE ${updates.map(column => `${desired(column)} IS NOT agent_run_attempts.${column}`).join(' OR ')} RETURNING rowid` });
  });
  return definition.bind(...restoredValues(row, columns));
}

/** Holds while the run has ended under the attempt `dispatchedBy` names: the condition an ended attempt's credential is retired under. */
export function endedUnderAttempt(projectId: string, runId: string, dispatchedBy: string): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ? AND dispatched_by = ? AND status IN (${TERMINAL_RUN_STATUSES.map(() => '?').join(', ')}))`,
    params: [projectId, runId, dispatchedBy, ...TERMINAL_RUN_STATUSES],
  };
}
