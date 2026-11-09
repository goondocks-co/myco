import { RUN_CONTROL_REFUSAL_WORDS, type RunControlRefusalCode } from '@goondocks/myco-shared/run-control';
import { requestedProfile, type ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import type { MaterialRead } from '../../core/material-pages.js';
import type { RunErrorCode } from '../../core/reader-codes.js';
import type { ReadScope } from '../../read/scope.js';
import { renewingLeaseAuthority, workerLeaseAuthority, type WorkerPrincipal } from '../../core/worker-lease.js';
import { runParentLive } from './run-parent.js';
import { RUN_COLUMNS } from './run-columns.js';
import { runDeadlineSql, SQL_NOW_MS } from '../../core/run-deadline.js';
import { contextValue, DISPATCH_ACTOR_SQL } from '../run-context.js';
import { LIVE_RUN_STATUSES, IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import { runCallerGuard } from './claim.js';
import { runChangeStatement, commitRunChange } from './change.js';
import { RUN_CONTEXT_OBJECT_SQL } from './queue.js';
import { commit, read, readSet, write } from '../index.js';
import { runNotRetiring } from './evidence-schema.js';
import type { RunLease } from './leases.js';

/** Where a run's context keeps how far its attempt has read its paged material. */
export const RUN_MATERIAL_READ_KEY = 'materialRead';

const materialReadWrite = write<[read: string, project: string, run: string, token: string]>({ name: 'runs.materialRead', sql:
  `UPDATE agent_runs SET run_context = json_set(${RUN_CONTEXT_OBJECT_SQL}, '$.${RUN_MATERIAL_READ_KEY}', json(?1))
   WHERE project_id = ?2 AND id = ?3 AND dispatched_by = ?4` });

/** Record how far the attempt has read, in the one place the run keeps it; a later read replaces it, so it stays one small value. */
export async function recordMaterialRead(db: RelationalStore, projectId: string, runId: string, read: MaterialRead): Promise<void> {
  await commit(db, materialReadWrite.bind(JSON.stringify(read), projectId, runId, read.tokenId));
}

/** The statuses after which a run does no further work; the update surface releases run-scoped resources when one lands. */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'skipped'] as const;

/** Whether a run carrying this status has already ended. */
export function isTerminalRunStatus(status: unknown): boolean {
  return typeof status === 'string' && (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export const RUN_UPDATE_COLUMNS = [
  'status', 'task', 'instruction', 'harness', 'provider', 'model', 'session_ref',
  'resumable', 'resume_status', 'resume_mode', 'resumed_at', 'resume_attempts',
  'checkpoints', 'usage_data', 'completed_at', 'tokens_used', 'cost_usd',
  'actual_cost_usd', 'estimated_cost_usd', 'cost_source', 'cost_data',
  'actions_taken', 'error', 'run_context', 'dry_run', 'reasoning_level',
  'execution_overrides',
] as const;
type RunUpdateColumn = (typeof RUN_UPDATE_COLUMNS)[number];

/** Columns a run update may never set, named so the gate reads the same list the code does. */
export const RUN_IMMUTABLE_COLUMNS = ['project_id', 'id', 'agent_id', 'dispatched_by'] as const;

export type RunUpdate = Partial<Record<RunUpdateColumn, string | number | null>>;

export interface RunRow {
  harness: string | null;
  id: string;
  agentId: string;
  task: string | null;
  status: string;
  /** The parameters the run's dispatch named, as the runtime's claim recorded them; the run routes that serve one task read the session it names from here. */
  runContext: string | null;
  startedAt: number | null;
  resumedAt: number | null;
  completedAt: number | null;
  error: string | null;
  checkpoints: string | null;
  resumable: number;
  resumeStatus: string | null;
  resumeAttempts: number;
  dryRun: number;
  /** The model the run's claim named, or null. */
  model: string | null;
  dispatchedBy: string | null;
  /** When the worker holding this run stops holding it, or null for a run no worker claimed. */
  leaseExpiresAt: number | null;
}

const RUN_SELECT = `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE project_id = ?1 AND id = ?2 AND ${runNotRetiring('?1', '?2')}`;

const runRead = read<[project: string, run: string], RunRow>({ name: 'runs.getRun', sql: RUN_SELECT });

/** One run a reader may reach: a run being retired is not found. */
export async function getRun(db: RelationalStore, scope: ReadScope, runId: string): Promise<RunRow | null> {
  const [rows] = await readSet(db, runRead.bind(scope.projectId, runId));
  return rows[0] ?? null;
}

const requestedProfileRead = read<[project: string, run: string, attempt: string], { execution_overrides: string | null }>({ name: 'runs.requestedProfile', sql:
  `SELECT execution_overrides FROM agent_runs WHERE project_id = ?1 AND id = ?2 AND status = 'running' AND dispatched_by = ?3` });

/** Read the requested profile only for the dispatched attempt ending its lease. */
export async function getRequestedWorkerProfile(db: RelationalStore, scope: ReadScope, runId: string, dispatchedBy: string): Promise<ExecutionProfile | null> {
  const [[row]] = await readSet(db, requestedProfileRead.bind(scope.projectId, runId, dispatchedBy));
  return requestedProfile(row?.execution_overrides);
}

/** A run row with the Project it belongs to: what a read keyed by credential answers; a credential spans every Project of its Deployment. */
export type HeldRun = RunRow & { projectId: string };

const credentialRuns = read<[token: string], HeldRun>({ name: 'runs.ofCredential', sql: `SELECT project_id AS projectId, ${RUN_COLUMNS} FROM agent_runs WHERE dispatched_by = ?1 AND ${runParentLive()}` });
const credentialLiveRuns = read<[token: string], HeldRun>({ name: 'runs.liveOfCredential', sql: `SELECT project_id AS projectId, ${RUN_COLUMNS} FROM agent_runs WHERE dispatched_by = ?1 AND status = 'running' AND ${runParentLive()}` });

/** Every row bound to a dispatch credential whose runner parent keeps its authority, including its pending claim and terminal acknowledgement. */
export async function runsOfCredential(db: RelationalStore, tokenId: string): Promise<HeldRun[]> {
  const [rows] = await readSet(db, credentialRuns.bind(tokenId));
  return rows;
}

/** Every `running` row this credential dispatched whose runner parent keeps its authority, in any Project — read by the credential alone, which `idx_agent_runs_credential` serves. */
export async function liveRunsOfCredential(db: RelationalStore, tokenId: string): Promise<HeldRun[]> {
  const [rows] = await readSet(db, credentialLiveRuns.bind(tokenId));
  return rows;
}

const openCredentialRuns = read<[token: string], { projectId: string; id: string }>({ name: 'runs.openOfCredential', sql: `SELECT project_id AS projectId, id FROM agent_runs WHERE dispatched_by = ?1 AND ${LIVE_RUN_STATUSES}` });

/** Record a server refusal receipt for the unique open run dispatched under this credential. */
export async function recordRunControlRefusal(db: RelationalStore, tokenId: string, code: RunControlRefusalCode, caller?: RunCaller): Promise<string | null> {
  const [open] = await readSet(db, openCredentialRuns.bind(tokenId));
  if (open.length !== 1) return null;
  const run = open[0]!;
  const guard = runCallerGuard(caller);
  const key = `runControlRefusals.${code}`;
  // A non-object context is retained verbatim under unparsedRunContext.
  // One receipt per code bounds the record; repeated refusals of that code share it.
  const row = await db.prepare(`UPDATE agent_runs SET run_context = json_set(${RUN_CONTEXT_OBJECT_SQL}, '$.${key}',
      CASE WHEN ${contextValue(`${key}.tokenId`)} = ? THEN ${contextValue(key)} ELSE json(?) END)
    WHERE project_id = ? AND id = ? AND dispatched_by = ? AND ${LIVE_RUN_STATUSES}${guard.sql}
      AND (SELECT COUNT(*) FROM agent_runs WHERE dispatched_by = ? AND ${LIVE_RUN_STATUSES}) = 1
    RETURNING ${contextValue(`${key}.id`)} AS refusalId`)
    .bind(tokenId, JSON.stringify({ tokenId, code, id: crypto.randomUUID() }), run.projectId, run.id, tokenId, ...guard.params, tokenId).first<{ refusalId: string }>();
  return row?.refusalId ?? null;
}

/** The session a run's recorded context names, or null when it names none. */
export function sessionNamedByRun(run: RunRow): string | null {
  if (run.runContext === null) return null;
  try {
    const parsed: unknown = JSON.parse(run.runContext);
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as { session_id?: unknown }).session_id : undefined;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** The dispatch credential and admission clock carried into an atomic runtime write. */
export interface RunCaller { tokenId: string; now: number; deadline: number; clock?: () => number; refusalId?: string }

const remainingRead = read<[project: string, run: string], { remaining: number }>({ name: 'runs.remainingMs', sql: `SELECT MAX(0, ${runDeadlineSql()} - ${SQL_NOW_MS}) AS remaining FROM agent_runs WHERE project_id = ?1 AND id = ?2` });

/** The current attempt's remaining authority, measured by the database clock. */
export async function runRemainingMs(db: RelationalStore, scope: ReadScope, runId: string): Promise<number> {
  const [[row]] = await readSet(db, remainingRead.bind(scope.projectId, runId));
  if (row === undefined) throw new Error('launch holds no run');
  return row.remaining;
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
export function runUpdateStatement(
  db: RelationalStore,
  scope: ReadScope,
  runId: string,
  update: RunUpdate,
  lease?: RunLease & { dispatchedBy: string },
  errorCode: RunErrorCode = 'run_failed',
  context?: Readonly<Record<string, string>>,
  caller?: RunCaller,
  replaced = false,
): PreparedStatement | null {
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
  return runChangeStatement(db, `UPDATE agent_runs SET ${columns.map((c) => `${c} = ?`).join(', ')}${codeSet}${contextSet}${release} WHERE project_id = ? AND id = ?${guard}${leaseGuard}${callerGuard.sql}`, [...columns.map((c) => update[c] ?? null), ...(coded ? [...(usesReceipt ? [caller!.tokenId, caller!.refusalId] : []), update.error == null ? null : errorCode] : []), ...(contextJson === null ? [] : [contextJson]), scope.projectId, runId, ...(guarded ? [update.status] : []),
      ...(authority?.params ?? []), ...callerGuard.params]);
}

/** Apply the shared update statement and return how many rows changed. */
export async function applyRunUpdate(
  db: RelationalStore, scope: ReadScope, runId: string, update: RunUpdate,
  lease?: RunLease & { dispatchedBy: string }, errorCode: RunErrorCode = 'run_failed',
  context?: Readonly<Record<string, string>>, caller?: RunCaller,
): Promise<number> {
  const statement = runUpdateStatement(db, scope, runId, update, lease, errorCode, context, caller);
  return statement === null ? 0 : (await commitRunChange(db, statement)).changed;
}

interface LiveRunRef {
  projectId: string;
  id: string;
  task: string | null;
  status: string;
  startedAt: number | null;
  runContext: string | null;
  dispatchedBy: string | null;
}

const liveRuns = read<[limit: number], LiveRunRef>({ name: 'runs.liveAcrossProjects', sql: `SELECT project_id AS projectId, id, task, status, started_at AS startedAt,
    run_context AS runContext, dispatched_by AS dispatchedBy
  FROM agent_runs WHERE ${LIVE_RUN_STATUSES}
  ORDER BY started_at ASC, id ASC LIMIT ?1` });

export async function listLiveRunsAcrossProjects(db: RelationalStore, limit: number): Promise<LiveRunRef[]> {
  const [rows] = await readSet(db, liveRuns.bind(limit));
  return rows;
}

/** A live run whose runtime went away is failed exactly once; a run that landed terminal on its own in the meantime is left as it landed. */
const failStale = write<[now: number, error: string, code: string, project: string, run: string], { id: string }>({ name: 'runs.failStale', sql:
  `UPDATE agent_runs SET status = 'failed', completed_at = ?1, error = ?2, error_code = ?3
   WHERE project_id = ?4 AND id = ?5 AND ${LIVE_RUN_STATUSES} RETURNING id` });

export async function failStaleRun(db: RelationalStore, scope: ReadScope, runId: string, now: number, error: string, errorCode: RunErrorCode): Promise<boolean> {
  const [result] = await commit(db, failStale.bind(now, error, errorCode, scope.projectId, runId));
  return result.results.length === 1;
}

/** The code and message on a run stopped by a signed-in member. */
export const RUN_CANCELLED = 'run_cancelled';

const cancelWrite = write<[now: number, error: string, code: string, project: string, run: string, member: string, admin: number], { displaced: string | null }>({ name: 'runs.cancel', sql:
  `UPDATE agent_runs SET status = 'failed', completed_at = ?1, error = ?2, error_code = ?3, lease_expires_at = NULL, held_by = NULL
   WHERE project_id = ?4 AND id = ?5 AND ${IN_FLIGHT_RUN_STATUSES}
     AND EXISTS (SELECT 1 FROM members m WHERE m.id = ?6 AND m.revoked_at IS NULL)
     AND (${DISPATCH_ACTOR_SQL} = ?6 OR (?7 = 1 AND EXISTS (SELECT 1 FROM members m WHERE m.id = ?6 AND m.role = 'admin' AND m.revoked_at IS NULL)))
   RETURNING dispatched_by AS displaced` });

/**
 * End one in-flight run at the writer. A member may end only a request whose
 * persisted dispatch names them; an administrator may end any request. The
 * actor, live membership, Project and live status are checked by the update.
 */
export async function cancelRun(
  db: RelationalStore, scope: ReadScope, runId: string,
  actor: { memberId: string; admin: boolean }, now: number,
): Promise<{ displaced: string | null } | null> {
  const [result] = await commit(db, cancelWrite.bind(now, 'Cancelled by a member', RUN_CANCELLED, scope.projectId, runId, actor.memberId, actor.admin ? 1 : 0));
  return result.results[0] ?? null;
}
