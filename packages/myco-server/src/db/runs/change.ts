import { RUN_CONTROL_REFUSAL_WORDS } from '@goondocks/myco-shared/run-control';
import type { PreparedStatement, RelationalStore, RunResult } from '../../core/adapters.js';
import { composedStatements } from '../composed-statements.js';
import { commit, write, type BindValue, type Bound } from '../index.js';
import { prepareBound } from '../kernel/statement.js';
import type { RunErrorCode } from '../../core/reader-codes.js';
import { workerLeaseAuthority } from '../runners/lease-authority.js';
import type { ReadScope } from '../../read/scope.js';
import { contextValue } from '../run-context.js';
import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import { runCallerGuard } from './claim.js';
import type { RunLease } from './leases.js';
import { isTerminalRunStatus, RUN_UPDATE_COLUMNS, type RunCaller, type RunUpdate } from './lifecycle.js';
import { RUN_CONTEXT_OBJECT_SQL } from './queue.js';

const runChanges = composedStatements<{ id: string }, 'write'>('runs.runUpdate');

/** Run changes return their direct row identities, independently of trigger writes. */
function runChangeStatement(sql: string, values: readonly unknown[]): Bound<{ id: string }, 'write'> {
  const text = `${sql} RETURNING id`;
  return runChanges(text, name => write<BindValue[], { id: string }>({ name, sql: text })).bind(...values as BindValue[]);
}

/**
 * Commits the change with its companions and answers how many runs it moved, read from its RETURNING rows. Companions
 * still built outside the kernel commit in the same batch.
 */
export async function commitRunChange(db: RelationalStore, statement: Bound<{ id: string }, 'write'>, after: readonly Bound[] | readonly PreparedStatement[] = []):
Promise<{ changed: number; following: RunResult[] }> {
  const named = after.every(companion => 'kind' in companion);
  const [changed, ...following] = named ? await commit(db, statement, ...after as readonly Bound[])
    : await db.batch([prepareBound(db, statement), ...after as readonly PreparedStatement[]]);
  if (changed === undefined) throw new Error('Run change result is missing');
  return { changed: changed.results.length, following };
}

/** What else a run update carries beyond its columns: the lease and caller it must still hold, and what it records. */
export interface RunUpdateOptions {
  lease?: RunLease & { dispatchedBy: string };
  errorCode?: RunErrorCode;
  context?: Readonly<Record<string, string>>;
  caller?: RunCaller;
  /** The run was replaced: its context records that, whether or not other context is added. */
  replaced?: boolean;
}

/**
 * Apply a partial update to one run, scoped.
 *
 * Returns how many rows moved: 0 means the run is not in this scope, which a
 * caller must not read as success. An update naming no settable column is
 * refused rather than issued as an empty UPDATE.
 *
 * **The first terminal write wins.** An update naming `status` lands only on a
 * run that has not already ended, and the guard is in the WHERE clause where the
 * row's own status decides it. Both sides of a close are in flight at once: the
 * update route releases the container the instant a terminal status lands, and
 * the runtime answers that release with a terminal status of its own. A check
 * read in JavaScript ahead of this write admits the second one, and the row then
 * carries an ending that contradicts the artifact the run left behind.
 *
 * An update naming no `status` is unguarded, and applies to a terminal row: the
 * tokens, the cost and the error detail a close measures ride the same write as
 * that close or a write of their own, and both are the ending being described
 * rather than a change of it.
 */
export function runUpdateStatement(scope: ReadScope, runId: string, update: RunUpdate, options: RunUpdateOptions = {}): Bound<{ id: string }, 'write'> | null {
  const { lease, errorCode = 'run_failed', context, caller, replaced = false } = options;
  if ('status' in update && !isTerminalRunStatus(update.status)) throw new Error('run updates require a terminal status');
  const columns = RUN_UPDATE_COLUMNS.filter((c) => c in update);
  if (columns.length === 0) return null;
  const guarded = 'status' in update;
  const guard = guarded ? ` AND ${IN_FLIGHT_RUN_STATUSES} AND (? <> 'completed' OR status = 'running')` : '';
  const authority = lease === undefined ? null : workerLeaseAuthority(lease.worker, lease.now, lease.dispatchedBy, true);
  const leaseGuard = authority === null ? '' : ` AND ${authority.sql}`;
  // A terminal transition ends the worker's lease and keeps the worker it
  // named: the row goes on saying which worker credential, and so which
  // machine, ran it. Only a live lease has an expiry, and the sweep reads that.
  const release = isTerminalRunStatus(update.status) ? ', lease_expires_at = NULL' : '';
  const coded = 'error' in update;
  const receipt = contextValue('runControlRefusals');
  const usesReceipt = caller?.refusalId !== undefined && update.status === 'failed' && update.error != null;
  const issuedCode = !usesReceipt ? '?' : `COALESCE((SELECT json_extract(value, '$.code')
    FROM json_each(CASE WHEN json_valid(${receipt}) THEN ${receipt} ELSE '{}' END)
    WHERE CASE WHEN type = 'object' THEN json_extract(value, '$.tokenId') END = ?
      AND CASE WHEN type = 'object' THEN json_extract(value, '$.id') END = ?
      AND CASE WHEN type = 'object' THEN json_extract(value, '$.code') END IN (${Object.keys(RUN_CONTROL_REFUSAL_WORDS).map((code) => `'${code}'`).join(', ')}) LIMIT 1), ?)`;
  const codeSet = coded ? `, error_code = ${issuedCode}` : '';
  const callerGuard = runCallerGuard(caller);
  // Context additions retain any non-object source verbatim under unparsedRunContext.
  const hasContext = context !== undefined && Object.keys(context).length > 0;
  const contextJson = !hasContext && !replaced ? null : JSON.stringify({ ...context, ...(replaced ? { replaced: true } : {}) });
  const contextSet = contextJson === null ? '' : replaced && !hasContext
    ? `, run_context = CASE WHEN run_context IS NULL OR json_type(CASE WHEN json_valid(run_context) THEN run_context END) = 'object'
        THEN json_patch(COALESCE(run_context, '{}'), ?) ELSE run_context END`
    : `, run_context = json_patch(${RUN_CONTEXT_OBJECT_SQL}, ?)`;
  return runChangeStatement(`UPDATE agent_runs SET ${columns.map((c) => `${c} = ?`).join(', ')}${codeSet}${contextSet}${release} WHERE project_id = ? AND id = ?${guard}${leaseGuard}${callerGuard.sql}`, [...columns.map((c) => update[c] ?? null), ...(coded ? [...(usesReceipt ? [caller!.tokenId, caller!.refusalId] : []), update.error == null ? null : errorCode] : []), ...(contextJson === null ? [] : [contextJson]), scope.projectId, runId, ...(guarded ? [update.status] : []),
      ...(authority?.params ?? []), ...callerGuard.params]);
}

/** Apply the shared update statement and return how many rows changed. */
export async function applyRunUpdate(
  db: RelationalStore, scope: ReadScope, runId: string, update: RunUpdate,
  lease?: RunLease & { dispatchedBy: string }, errorCode: RunErrorCode = 'run_failed',
  context?: Readonly<Record<string, string>>, caller?: RunCaller,
): Promise<number> {
  const statement = runUpdateStatement(scope, runId, update, { lease, errorCode, context, caller });
  return statement === null ? 0 : (await commitRunChange(db, statement)).changed;
}
