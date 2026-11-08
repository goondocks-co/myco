import { knowledgeUnavailable } from '../db/runs/attributed-writes.js';

import type { Bound } from '../db/index.js';
import { ensureAgentStatement, runCallerGuard, lastTaskEntryQueries, taskEntriesSql } from '../db/runs/claim.js';
export { NOT_THE_RUN_ADMITTED, NO_LIMITS, recordDispatch, claimRun, getRunningRunForTask, ensureAgentStatement, runCallerGuard, hasRunInsideBound, recordQueued, launchQueued, returnToQueue, restoreDispatchCredential, skipQueued, pulledClaimPredicate, workerClaimPredicate, workerClaimAdmission, runnerClaimGate, claimedInputStatement, markRecordedLaunch, getDispatchActor, lastTaskEntryAt, lastTaskEntryQueries, deploymentTaskEntriesSince, deploymentTaskCeilingWindow, deploymentLastTaskEntryAt, deploymentLatestTaskRun, deploymentTaskRunTally, taskEntriesSince, markRunReplaced, hasSuccessorOf, successorsSince, hasLiveTaskRunAnywhere, hasLiveTaskRun, recordSkipped } from '../db/runs/claim.js';
import { RUN_CONTEXT_OBJECT_SQL } from '../db/runs/queue.js';
export { limitPassesSql } from '../db/runs/claim.js';
export { dispatchLoad } from '../db/runs/live.js';
export { recordTaskHolder, recordQueueHolder } from '../db/runs/queue.js';
import { runChangeStatement, commitRunChange } from '../db/runs/change.js';
export { commitRunChange } from '../db/runs/change.js';
import { KNOWLEDGE_REPOSITORY_TASKS, knowledgeOnlyInstruction, type RepositoryFailure } from '@goondocks/myco-shared/repository';

import { LIVE_RUN_STATUSES, IN_FLIGHT_RUN_STATUSES } from '../db/run-statuses.js';
export { LIVE_RUN_STATUSES, IN_FLIGHT_RUN_STATUSES, UNCLAIMED_RUN_STATUSES } from '../db/run-statuses.js';

import { type ClaimBudget } from './run-budget.js';

export { titleRunInFlightSql } from '../db/session-read-model.js';
import { type MemberWriteActor } from '../auth/member-write-store.js';
import { RUN_CONTROL_REFUSAL_WORDS, type RunControlRefusalCode } from '@goondocks/myco-shared/run-control';
/**
 * The agent run control plane, server-side.
 *
 * The agent does not reach this store. It runs as a process inside a container,
 * which is not a Worker and holds no bindings, so it calls the routes in
 * `api/runs.ts` and this module is what those routes call. That arrangement is
 * the point: atomicity lives with the single writer instead of once per client.
 *
 * Three operations here are atomic in SQL rather than in JavaScript, and each is
 * atomic in the WHERE clause rather than by batching. A batch cannot supply any
 * of them: its statements are fixed before it executes, so any decision taken
 * between a read and a write still happens in the caller, across an await, where
 * two concurrent phases interleave.
 *
 * - `claimRun` is one `INSERT ... SELECT ... WHERE NOT EXISTS`. A separate check
 *   followed by a separate insert admits a run twice under one id.
 * - `mutateState` is compare-and-swap. The caller's callback is arbitrary code
 *   and cannot move into SQL, so the prior value becomes the guard and a refused
 *   update is retried FROM THE READ. Retrying from anywhere else re-applies a
 *   decision taken against a value that is no longer there.
 * - `applyRunUpdate` guards a status change on the row not already being
 *   terminal. A run closing releases the container that ran it, and that release
 *   is what makes the container post an ending of its own, so the two writes
 *   overlap by construction and only the WHERE clause can settle which lands.
 */
import { REPOSITORY_COMMIT_PATTERN, parseRepositoryCheckoutSpec, type RepositoryCheckoutSpec, type RepositoryPin } from '@goondocks/myco-shared/repository';
import { parseMapSourcePin, type MapSourcePin } from '@goondocks/myco-shared/canopy';
import { requestedProfile, type ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import type { DispatchLimits } from './limits.js';
import type { RunErrorCode } from './reader-codes.js';
import { storedAudit, type RunAudit } from './run-audit.js';


import type { PreparedStatement, RelationalStore } from './adapters.js';
import type { MaterialRead } from './material-pages.js';
import { emit } from '../telemetry.js';
import { inListChunks, type ReadScope } from '../read/scope.js';

import { type ProjectCapability } from './settings.js';

import { NOT_TOMBSTONED_PARAMS } from './tombstones.js';
import { contextValue, DISPATCH_ACTOR_SQL } from '../db/run-context.js';
import { renewingLeaseAuthority, workerLeaseAuthority, type WorkerPrincipal } from './worker-lease.js';
import { runParentLive } from '../auth/runners.js';
import { runDeadlineSql, SQL_NOW_MS } from './run-deadline.js';

/** An object context with any non-object source retained verbatim. */
/** Where a run's context keeps how far its attempt has read its paged material. */
export const RUN_MATERIAL_READ_KEY = 'materialRead';

/** Record how far the attempt has read, in the one place the run keeps it; a later read replaces it, so it stays one small value. */
export async function recordMaterialRead(db: RelationalStore, projectId: string, runId: string, read: MaterialRead): Promise<void> {
  await db.prepare(`UPDATE agent_runs SET run_context = json_set(${RUN_CONTEXT_OBJECT_SQL}, '$.${RUN_MATERIAL_READ_KEY}', json(?))
    WHERE project_id = ? AND id = ? AND dispatched_by = ?`).bind(JSON.stringify(read), projectId, runId, read.tokenId).run();
}

export { RUN_CONTEXT_OBJECT_SQL } from '../db/runs/queue.js';

/** The name a dispatch is left alone under when the Project has not moved past the artifact its task already wrote. */
export { INPUT_UNCHANGED } from '../db/schedule-entry.js';

/** The context a skipped run carries: one shape, written by both skip paths and matched exactly by the interval clock. */
export const skipContext = (reason: string): string => JSON.stringify({ reason });

/** How many times a refused compare-and-swap is recomputed before the write is reported as contended. */
export const MUTATE_ATTEMPTS = 5;

export interface RunInsert {
  id: string;
  agentId: string;
  task: string | null;
  instruction: string | null;
  harness: string | null;
  provider: string | null;
  model: string | null;
  dryRun: boolean;
  startedAt: number;
  runContext: string | null;
  /** The credential that dispatched this run, or null when a schedule did. Supplies member and runtime attribution through `member_credentials`. */
  dispatchedBy: string | null;
}

/** A live run of a task, as much of it as a caller refused a claim needs. */
export interface RunningRunRef {
  id: string;
  task: string | null;
  startedAt: number | null;
  /** When the current attempt began, distinct from `startedAt` on a resumed run. */
  resumedAt: number | null;
}

/**
 * What must hold before a task may run.
 *
 * Capability-gated work requires Project admission; embedding work requires a
 * bound provider. Capture-driven title work carries no provider-setting gate:
 * worker selection and execution profiles resolve at the worker claim.
 */
export type RunAdmissionGate =
  | { kind: 'capability'; capability: ProjectCapability }
  | { kind: 'embedding' }
  | { kind: 'capture' };

/**
 * Why a claim did not take.
 *
 * `running` names the run already recorded under this id. `notAdmitted` names a
 * Project that does not hold the capability the task needs, and `noProvider` a
 * Deployment with no embedding provider — settled answers a caller must not retry into.
 */
export type ClaimOutcome =
  | { claimed: true }
  | { claimed: false; running: RunningRunRef | null; notAdmitted?: undefined; noProvider?: undefined }
  | { claimed: false; running?: undefined; notAdmitted: ProjectCapability; noProvider?: undefined }
  | { claimed: false; running?: undefined; notAdmitted?: undefined; noProvider: true };

/** The state row a read returns, or null when the key is unset. */
export interface StateRow {
  key: string;
  value: string;
  updatedAt: number;
}

/**
 * Which runs are in flight.
 *
 * A `pending` row counts as one: the dispatcher writes the row before the
 * runtime starts. Every reader of the fleet shares this predicate — the sweep,
 * the drain's load, and the read a deploy makes before it recreates the
 * container — and each projects the columns it needs from it.
 */



/** The actor a dispatch spec names, and null for a spec that names none. A spec the store did not write is not read as JSON at all. */
export { DISPATCH_ACTOR_SQL };

/**
 * A ceiling on the entries one actor may make of a task in a window,
 * across the Deployment or within one Project: the write that records the run refuses once the
 * window holds that many, in the same statement that counts them.
 */
export interface ActorCeiling {
  actor: string;
  task: string;
  perDay: number;
  sinceMs: number;
  /** Restrict this ceiling to one Project; absent spans the Deployment. */
  projectId?: string;
}

/**
 * What a write is admitted against, or none: an unguarded write is a claim the
 * dispatcher already decided elsewhere. `singleFlight` names a task that runs
 * once at a time in a Project: the write refuses while another run of it is
 * live, in the same statement, so two wakes deciding at once write one row.
 * `ceiling` names an actor's window the write refuses past. `capability` names one the Project must
 * have turned on.
 */
export interface WriteAdmission {
  limits: DispatchLimits;
  now: number;
  budget?: ClaimBudget;
  settingsGuard?: Readonly<Record<string,number>>;
  singleFlight?: boolean;
  ceiling?: ActorCeiling;
  actor?: MemberWriteActor;
  setup?: Bound[];
  /** A capability the Project must have turned on for the write to land. */
  capability?: string;
}

export interface DispatchRecord {
  id: string;
  agentId: string;
  task: string;
  provider: string | null;
  model: string | null;
  /** The prompt the server built for this run, or null for a task the server builds no input for. The run reads it back over `/runs/instruction`. */
  instruction?: string | null;
  /** A run that does the work and writes nothing; its write routes answer `written: false`. */
  dryRun?: boolean;
  /** The dispatch's parameters, which the run routes that serve one task read back; written here, by the server, and never by the runtime. */
  runContext: string | null;
  /** The credential the dispatch minted for this run. */
  dispatchedBy: string | null;
  startedAt: number;
  dispatchSpec?: string;
}

const STATE_READ_SQL = `SELECT key, value, updated_at AS updatedAt FROM agent_state
   WHERE project_id = ? AND agent_id = ? AND key = ?`;

/** First write for a key. A row another writer inserted between the read and here makes this change nothing, which the caller reads as contention. */
const STATE_INSERT_SQL = `INSERT INTO agent_state (project_id, agent_id, key, value, updated_at)
  VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`;

/**
 * Subsequent writes, guarded by the value the caller computed against.
 *
 * `value IS ?` rather than `=`: comparing to NULL with `=` yields NULL, never
 * true, so `=` cannot match a key whose prior value is absent.
 */
const STATE_UPDATE_SQL = `UPDATE agent_state SET value = ?, updated_at = ?
   WHERE project_id = ? AND agent_id = ? AND key = ? AND value IS ?`;

/** An admitted owner publishes state only while its coordinating write still names its revision. */
export function guardedStateStatement(db:RelationalStore,scope:ReadScope,agentId:string,key:string,value:string,now:number,guard:{sql:string;params:unknown[]}):PreparedStatement {
  return db.prepare(`INSERT INTO agent_state(project_id,agent_id,key,value,updated_at) SELECT ?,?,?,?,? WHERE ${guard.sql}
    ON CONFLICT(project_id,agent_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(scope.projectId,agentId,key,value,now,...guard.params);
}

export async function getState(db: RelationalStore, scope: ReadScope, agentId: string, key: string): Promise<StateRow | null> {
  return db.prepare(STATE_READ_SQL).bind(scope.projectId, agentId, key).first<StateRow>();
}

/**
 * Atomic read-modify-write over one state key.
 *
 * Returns false when every attempt is refused, which reports contention rather than
 * failure: the value another writer left stands, and the caller is told the
 * mutation did not land rather than being allowed to believe it did.
 */
export async function mutateState(
  db: RelationalStore,
  scope: ReadScope,
  agentId: string,
  key: string,
  mutate: (current: string | null) => string | null,
  now: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt += 1) {
    const row = await getState(db, scope, agentId, key);
    const current = row?.value ?? null;
    const next = mutate(current);
    if (next === null) return true;

    const result = current === null
      ? await db.prepare(STATE_INSERT_SQL).bind(scope.projectId, agentId, key, next, now).run()
      : await db.prepare(STATE_UPDATE_SQL).bind(next, now, scope.projectId, agentId, key, current).run();

    if (result.meta.changes === 1) return true;
  }
  return false;
}

export interface AgentIdentity {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  enabled: boolean;
}

/**
 * Declare an agent identity, idempotently.
 *
 * Deployment-scoped: one agent configuration serves every Project the Deployment
 * holds, so this takes no scope. `created_at` is preserved on a re-declaration —
 * the row's identity outlives any one edit of its configuration.
 */
export async function upsertAgent(db: RelationalStore, agent: AgentIdentity, now: number): Promise<void> {
  await db.prepare(`INSERT INTO agents (id, name, provider, model, source, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'built-in', ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, provider = excluded.provider, model = excluded.model,
        enabled = excluded.enabled, updated_at = excluded.updated_at`)
    .bind(agent.id, agent.name, agent.provider, agent.model, agent.enabled ? 1 : 0, now, now).run();
}

export async function ensureAgent(db: RelationalStore, agent: AgentIdentity, now: number): Promise<void> {
  await ensureAgentStatement(db, agent, now).run();
}

export async function listAgents(db: RelationalStore): Promise<AgentIdentity[]> {
  const { results } = await db.prepare(`SELECT id, name, provider, model, enabled FROM agents ORDER BY id`)
    .all<{ id: string; name: string; provider: string | null; model: string | null; enabled: number }>();
  return results.map((r) => ({ ...r, enabled: r.enabled === 1 }));
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/**
 * The columns a run update may set.
 *
 * A FIXED list, never the caller's keys. Locally this reads as tidiness; on a
 * Deployment holding many Projects for many members it is the boundary itself.
 * `project_id`, `id`, `agent_id` and `dispatched_by` are absent on purpose: an
 * update that could set them would let a caller move a run to another Project,
 * change which agent ran it, or reattribute it to another member — the last
 * undoing the claim route's rule that the dispatcher comes from the credential
 * and never from the body.
 */
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
export type RunUpdateColumn = (typeof RUN_UPDATE_COLUMNS)[number];

/** Columns a run update may never set, named so the gate reads the same list the code does. */
export const RUN_IMMUTABLE_COLUMNS = ['project_id', 'id', 'agent_id', 'dispatched_by'] as const;

/**
 * Columns the DISPATCHER owns on a run it recorded.
 *
 * A local run writes both itself, so they stay settable in general. On a run the
 * server dispatched they are the server's own word about what it decided: the
 * context carries the hash the artifact is filed under and the parameters the
 * task routes read back, and `dry_run` says whether the run may write at all. A
 * runtime that could move either would file its own hash as current, or turn the
 * dispatch's dry run into a real one — and both read as the server's decision
 * afterwards.
 */
export const DISPATCHER_OWNED_COLUMNS = ['run_context', 'dry_run'] as const;

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

const RUN_COLUMNS = `id, harness, agent_id AS agentId, task, status, run_context AS runContext, started_at AS startedAt,
    resumed_at AS resumedAt, completed_at AS completedAt, error, checkpoints,
    resumable, resume_status AS resumeStatus, resume_attempts AS resumeAttempts,
    dry_run AS dryRun, model, dispatched_by AS dispatchedBy, lease_expires_at AS leaseExpiresAt`;

const RUN_SELECT = `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE project_id = ? AND id = ?`;

export async function getRun(db: RelationalStore, scope: ReadScope, runId: string): Promise<RunRow | null> {
  return db.prepare(RUN_SELECT).bind(scope.projectId, runId).first<RunRow>();
}

/** Read the requested profile only for the dispatched attempt ending its lease. */
export async function getRequestedWorkerProfile(db: RelationalStore, scope: ReadScope, runId: string, dispatchedBy: string): Promise<ExecutionProfile | null> {
  const row = await db.prepare(`SELECT execution_overrides FROM agent_runs
    WHERE project_id = ? AND id = ? AND status = 'running' AND dispatched_by = ?`)
    .bind(scope.projectId, runId, dispatchedBy).first<{ execution_overrides: string | null }>();
  return requestedProfile(row?.execution_overrides);
}

/** A run row with the Project it belongs to: what a read keyed by credential answers; a credential spans every Project of its Deployment. */
export type HeldRun = RunRow & { projectId: string };

/** Every row bound to a dispatch credential whose runner parent keeps its authority, including its pending claim and terminal acknowledgement. */
export async function runsOfCredential(db: RelationalStore, tokenId: string): Promise<HeldRun[]> {
  const { results } = await db.prepare(`SELECT project_id AS projectId, ${RUN_COLUMNS} FROM agent_runs WHERE dispatched_by = ? AND ${runParentLive()}`)
    .bind(tokenId).all<HeldRun>();
  return results;
}

/** Every `running` row this credential dispatched whose runner parent keeps its authority, in any Project — read by the credential alone, which `idx_agent_runs_credential` serves. */
export async function liveRunsOfCredential(db: RelationalStore, tokenId: string): Promise<HeldRun[]> {
  const { results } = await db
    .prepare(`SELECT project_id AS projectId, ${RUN_COLUMNS} FROM agent_runs WHERE dispatched_by = ? AND status = 'running' AND ${runParentLive()}`)
    .bind(tokenId)
    .all<HeldRun>();
  return results;
}

/** Record a server refusal receipt for the unique open run dispatched under this credential. */
export async function recordRunControlRefusal(db: RelationalStore, tokenId: string, code: RunControlRefusalCode, caller?: RunCaller): Promise<string | null> {
  const { results } = await db.prepare(`SELECT project_id AS projectId, id FROM agent_runs
    WHERE dispatched_by = ? AND ${LIVE_RUN_STATUSES}`).bind(tokenId).all<{ projectId: string; id: string }>();
  if (results.length !== 1) return null;
  const run = results[0]!;
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

/** The current attempt's remaining authority, measured by the database clock. */
export async function runRemainingMs(db: RelationalStore, scope: ReadScope, runId: string): Promise<number> {
  const row = await db.prepare(`SELECT MAX(0, ${runDeadlineSql()} - ${SQL_NOW_MS}) AS remaining FROM agent_runs WHERE project_id = ? AND id = ?`)
    .bind(scope.projectId, runId).first<{ remaining: number }>();
  if (row === null) throw new Error('launch holds no run');
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

export interface ReportRow {
  id: number;
  runId: string;
  agentId: string;
  action: string;
  summary: string;
  details: string | null;
  /** The agent's account of the pass the report closes (`core/run-audit.ts`); null where the report carries none. */
  audit: RunAudit | null;
  createdAt: number;
}

export async function listReports(db: RelationalStore, scope: ReadScope, runId: string): Promise<ReportRow[]> {
  const { results } = await db
    .prepare(`SELECT id, run_id AS runId, agent_id AS agentId, action, summary, details, audit, created_at AS createdAt
       FROM agent_reports WHERE project_id = ? AND run_id = ? ORDER BY id ASC`)
    .bind(scope.projectId, runId)
    .all<Omit<ReportRow, 'audit'> & { audit: string | null }>();
  return results.map((row) => ({ ...row, audit: storedAudit(row.audit) }));
}

export interface ReportInsert {
  runId: string;
  agentId: string;
  action: string;
  summary: string;
  details: string | null;
  /** The validated audit, serialized; null for a report that carries none. */
  audit: string | null;
  createdAt: number;
}

/** Record one report against a run this Project holds; an unknown run or an unregistered agent writes nothing and answers false — a foreign-key throw would read as retryable, and neither condition is. */
export async function insertReport(db: RelationalStore, scope: ReadScope, report: ReportInsert, caller?: RunCaller): Promise<boolean> {
  const guard = runCallerGuard(caller);
  const result = await db
    .prepare(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, details, audit, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?${guard.sql})
          AND EXISTS (SELECT 1 FROM agents WHERE id = ?)`)
    .bind(scope.projectId, report.runId, report.agentId, report.action, report.summary, report.details, report.audit, report.createdAt,
          scope.projectId, report.runId, ...guard.params, report.agentId)
    .run();
  return result.meta.changes === 1;
}

/**
 * The event type a run's own tool call is recorded under.
 *
 * A run's turns happen inside a harness the Deployment cannot see; the calls it
 * makes back are the only part of a run the Deployment observes directly. A run
 * that ended its turn without ever calling is the case this record exists to
 * make legible — an empty list against a closed run is the evidence.
 */
export const RUN_TOOL_EVENT = 'run_tool';

/** The outcome a run's call is recorded under when the Deployment answered it with a failure. */
export const RUN_CALL_FAILED = 'failed';

/** The longest failure message a recorded call keeps. */
export const RUN_CALL_FAILURE_CHARS = 300;

/** Why the Deployment answered a run's call with a failure: the error's code, and what it said. */
export interface RunCallFailure {
  code: string;
  message: string;
}

/**
 * Record one call a run made back to the Deployment, whichever door it came
 * through: an MCP tool the harness child called, or a run route a container
 * drove itself. One list holds both, so an empty one means the run reached this
 * Deployment not at all rather than reached it another way.
 *
 * A call answered with a failure is recorded with what the failure said, so a
 * run that ended without its work reads as the call that failed it.
 *
 * A store that refuses the row is named in telemetry rather than failing the
 * call the caller already has an answer to.
 */
export async function recordRunCall(
  db: RelationalStore,
  scope: ReadScope,
  call: { runId: string; toolName: string; op: string | null; durationMs: number | null; recordedAt: number; failure?: RunCallFailure },
): Promise<void> {
  const failure = call.failure === undefined ? undefined : { code: call.failure.code, message: call.failure.message.slice(0, RUN_CALL_FAILURE_CHARS) };
  const payload = { ...(call.op === null ? {} : { op: call.op }), ...(failure === undefined ? {} : { failure }) };
  try {
    await recordRunEvents(db, scope, [{
      runId: call.runId, phaseName: null, eventType: RUN_TOOL_EVENT, toolName: call.toolName,
      outcome: failure === undefined ? 'success' : RUN_CALL_FAILED, durationMs: call.durationMs,
      payload: Object.keys(payload).length === 0 ? null : JSON.stringify(payload), recordedAt: call.recordedAt,
    }]);
  } catch {
    emit({ kind: 'run_tool_unrecorded', runId: call.runId, tool: call.toolName, op: call.op });
  }
}

/**
 * The event type a run's LANDED write of its task's artifact is recorded under.
 *
 * A tool call says the run asked; this says the write took. The two differ
 * wherever a write is conditional — a titling run in `claim` mode writes only
 * where no title stands — and a postcondition that read the call alone would
 * pass a run whose write did nothing.
 *
 * It is the run key for an artifact whose own row carries none. Where the
 * artifact table names the run itself (`canopy_maps.source_run_id`) the rule
 * reads that instead.
 */
export const RUN_WRITE_EVENT = 'run_write';

/** Whether this run recorded a landed write through the named tool. */
export async function runRecordedWrite(db: RelationalStore, scope: ReadScope, runId: string, toolName: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS one FROM agent_run_events
       WHERE project_id = ? AND run_id = ? AND event_type = ? AND tool_name = ? LIMIT 1`)
    .bind(scope.projectId, runId, RUN_WRITE_EVENT, toolName)
    .first<{ one: number }>();
  return row !== null;
}

export interface RunWrite {
  runId: string;
  toolName: string;
  op: string;
  recordedAt: number;
  detail?: Record<string, unknown>;
}

/** Record attribution for a write whose domain row already names its run. */
export async function recordRunWrite(db: RelationalStore, scope: ReadScope, write: RunWrite): Promise<void> {
  await recordRunEvents(db, scope, [{
    runId: write.runId, phaseName: null, eventType: RUN_WRITE_EVENT, toolName: write.toolName,
    outcome: 'written', durationMs: null,
    payload: JSON.stringify({ op: write.op, ...(write.detail ?? {}) }), recordedAt: write.recordedAt,
  }]);
}

export { commitAttributedWrite } from '../db/runs/attribution.js';
import { commitAttributedWrite } from '../db/runs/attribution.js';

/**
 * The most sessions one run's reads are recorded for. A run past it still reads; the sessions after the bound are
 * served and not recorded, so a run's record stays a bounded number of rows whatever it reads.
 */
export const MAX_RUN_READS = 200;

/**
 * Record the sessions served to a run's call, against the run, over the run's own credential.
 *
 * One row per run and session: a session read again keeps the row, and the instant of its first read. Each row lands
 * only while the Project holds the run and the session, the session carries no tombstone — a record landing after
 * the session's deletion writes nothing — and the run holds fewer than `MAX_RUN_READS` rows; the statements run in one batch, in order, so the bound counts the rows the batch itself adds. Answers how
 * many rows landed.
 */
export async function recordRunReads(
  db: RelationalStore,
  scope: ReadScope,
  read: { runId: string; tokenId: string; sessionIds: readonly string[]; receivedAt: number },
): Promise<number> {
  const sessionIds = [...new Set(read.sessionIds)].slice(0, MAX_RUN_READS);
  if (sessionIds.length === 0) return 0;
  const statements = sessionIds.map((sessionId) => db
    .prepare(`INSERT INTO run_reads (project_id, run_id, session_id, token_id, received_at)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)
          AND EXISTS (SELECT 1 FROM sessions WHERE project_id = ? AND session_id = ?)
          AND ${NOT_TOMBSTONED_PARAMS}
          AND (SELECT COUNT(*) FROM run_reads WHERE project_id = ? AND run_id = ?) < ?
       ON CONFLICT (project_id, run_id, session_id) DO NOTHING`)
    .bind(scope.projectId, read.runId, sessionId, read.tokenId, read.receivedAt,
          scope.projectId, read.runId, scope.projectId, sessionId, scope.projectId, sessionId, scope.projectId, read.runId, MAX_RUN_READS));
  const results = await db.batch(statements);
  return results.reduce((landed, result) => landed + result.meta.changes, 0);
}

export interface RunEventRowInsert {
  runId: string;
  phaseName: string | null;
  eventType: string;
  toolName: string | null;
  outcome: string | null;
  durationMs: number | null;
  payload: string | null;
  recordedAt: number;
}

/** Record a burst of run events in one batch; each row lands independently through its own EXISTS guard, and a row naming a run this Project does not hold writes nothing. Answers how many landed. */
export async function recordRunEvents(db: RelationalStore, scope: ReadScope, events: readonly RunEventRowInsert[]): Promise<number> {
  const statements = events.map((event) => db
    .prepare(`INSERT INTO agent_run_events (project_id, run_id, phase_name, event_type, tool_name, outcome, duration_ms, payload, recorded_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)`)
    .bind(scope.projectId, event.runId, event.phaseName, event.eventType, event.toolName, event.outcome, event.durationMs, event.payload, event.recordedAt,
          scope.projectId, event.runId));
  const results = await db.batch(statements);
  return results.reduce((landed, result) => landed + result.meta.changes, 0);
}

// ---------------------------------------------------------------------------
// Deployment-scoped reads and writes for the tick's jobs
// ---------------------------------------------------------------------------

/**
 * A live run anywhere on the Deployment. The sweep and the drain read across
 * Projects — the first reads here without a scope: the runtime that went
 * away, and the capacity that came back, are the Deployment's, not one
 * Project's.
 */
export interface LiveRunRef {
  projectId: string;
  id: string;
  task: string | null;
  status: string;
  startedAt: number | null;
  runContext: string | null;
  dispatchedBy: string | null;
}


const LIVE_RUNS_SQL = `SELECT project_id AS projectId, id, task, status, started_at AS startedAt,
    run_context AS runContext, dispatched_by AS dispatchedBy
  FROM agent_runs WHERE ${LIVE_RUN_STATUSES}
  ORDER BY started_at ASC, id ASC LIMIT ?`;

export async function listLiveRunsAcrossProjects(db: RelationalStore, limit: number): Promise<LiveRunRef[]> {
  const { results } = await db.prepare(LIVE_RUNS_SQL).bind(limit).all<LiveRunRef>();
  return results;
}

/** A live run whose runtime went away is failed exactly once; a run that landed terminal on its own in the meantime is left as it landed. */
const FAIL_STALE_SQL = `UPDATE agent_runs SET status = 'failed', completed_at = ?, error = ?, error_code = ?
  WHERE project_id = ? AND id = ? AND ${LIVE_RUN_STATUSES}`;

export async function failStaleRun(db: RelationalStore, scope: ReadScope, runId: string, now: number, error: string, errorCode: RunErrorCode): Promise<boolean> {
  const result = await commitRunChange(db, runChangeStatement(db, FAIL_STALE_SQL, [now, error, errorCode, scope.projectId, runId]));
  return result.changed === 1;
}

export const RETENTION_CANDIDATES_SQL = `SELECT project_id AS projectId, id FROM agent_runs
  WHERE status IN ('completed', 'failed', 'skipped') AND resumable = 0 AND COALESCE(completed_at, started_at) < ?
  ORDER BY COALESCE(completed_at, started_at) ASC, id ASC LIMIT ?`;

/** The most step-log rows one retention pass deletes, so no statement of it outlives the hosted store's query bound. */
export const RETENTION_STEP_ROWS = 10_000;

/** Holds a run-keyed delete to the runs whose step logs are already gone. */
const NO_STEPS_LEFT = (table: string, runColumn: string) =>
  `NOT EXISTS (SELECT 1 FROM agent_run_steps s WHERE s.project_id = ${table}.project_id AND s.run_id = ${table}.${runColumn})`;

/**
 * Remove terminal, non-resumable runs older than the cutoff, up to `limit`
 * of them, each with its turns and reports. Those two tables reference a run
 * without a cascade, so they are deleted in the same batch ahead of the run, and
 * so are its attempts; events, write intents and the record of the sessions it read cascade, and a
 * digest revision keeps its row with the run reference cleared. A run's step
 * log is deleted first, at most `stepRows` rows in a pass, and a run whose log
 * is not yet gone keeps its row and its turns and reports for a later pass.
 * Answers how many runs went.
 */
export async function pruneTerminalRuns(db: RelationalStore, cutoffMs: number, limit: number, stepRows = RETENTION_STEP_ROWS): Promise<number> {
  const { results } = await db.prepare(RETENTION_CANDIDATES_SQL).bind(cutoffMs, limit).all<{ projectId: string; id: string }>();
  if (results.length === 0) return 0;
  const byProject = new Map<string, string[]>();
  for (const row of results) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row.id]);
  let removed = 0;
  let budget = stepRows;
  for (const [projectId, ids] of byProject) {
    for (const chunk of inListChunks(ids)) {
      const marks = chunk.map(() => '?').join(', ');
      const statements = [
        db.prepare(`DELETE FROM agent_run_steps WHERE rowid IN (SELECT rowid FROM agent_run_steps WHERE project_id = ? AND run_id IN (${marks}) LIMIT ?)`).bind(projectId, ...chunk, budget),
        db.prepare(`DELETE FROM agent_turns WHERE project_id = ? AND run_id IN (${marks}) AND ${NO_STEPS_LEFT('agent_turns', 'run_id')}`).bind(projectId, ...chunk),
        db.prepare(`DELETE FROM agent_reports WHERE project_id = ? AND run_id IN (${marks}) AND ${NO_STEPS_LEFT('agent_reports', 'run_id')}`).bind(projectId, ...chunk),
        db.prepare(`DELETE FROM agent_run_attempts WHERE project_id = ? AND run_id IN (${marks}) AND ${NO_STEPS_LEFT('agent_run_attempts', 'run_id')}`).bind(projectId, ...chunk),
        db.prepare(`DELETE FROM agent_runs WHERE project_id = ? AND id IN (${marks}) AND ${NO_STEPS_LEFT('agent_runs', 'id')} RETURNING id`).bind(projectId, ...chunk),
      ];
      const outcomes = await db.batch(statements);
      budget = Math.max(0, budget - (outcomes[0]?.meta.changes ?? 0));
      removed += outcomes[4]?.results.length ?? 0;
    }
  }
  return removed;
}

/**
 * Revoked harness credentials past the cutoff, and referenced by no run.
 *
 * A dispatch mints one credential per run and revokes it at close, so the table
 * grows with every run the Deployment has ever made. A credential a run row
 * still names is left: `agent_runs.dispatched_by` references it, and the run
 * retention pass above is what clears that reference.
 */
export { pruneRevokedCredentials } from '../db/credential-retention.js';

// ---------------------------------------------------------------------------
// The queue: a run that waits is a run row
// ---------------------------------------------------------------------------

/** What a queued run keeps until it launches: everything a launch is told, so the drain launches it exactly as the dispatch asked. */
export interface QueuedRecord {
  id: string;
  agentId: string;
  task: string;
  provider: string | null;
  model: string | null;
  heldBy: string;
  queuedAt: number;
  /** The prompt the server built at the dispatch. A task with an input builder has it rebuilt at launch, and this is what the rebuild replaces. */
  instruction?: string | null;
  /** A run that does the work and writes nothing. */
  dryRun?: boolean;
  /** The launch spec as JSON: server URL, actor, bound and parameters. */
  dispatchSpec: string;
  /** What the run carries on its row: the task's parameters and what the server decided at dispatch. A run a worker claims is never launched, so this is written here or nowhere. */
  runContext?: string | null;
}

/** What ending a queued row did: whether the write landed, and the credential that row named when it did. */
export interface QueuedRunEnd {
  applied: boolean;
  displaced: string | null;
}

/**
 * A queued run the Deployment can no longer launch is failed by name, from
 * `queued` alone.
 *
 * `started_at` is left as it is, as it is for a skipped row: a run that never
 * ran has no start, and `taskRunsLastHour` counts starts. The write answers
 * with the credential the row named at the instant it landed, for the same
 * reason a skip does.
 */
export { failQueuedRun } from '../db/runs/queue.js';

export interface QueuedRunRef {
  projectId: string;
  id: string;
  task: string | null;
  queuedAt: number;
  heldBy: string | null;
  budgetQuoteUsd:number|null;
  dispatchSpec: string | null;
  origin: 'manual' | 'automatic';
  /** The credential a re-queued row still carries, for the child a late answer may have started; null for a row that never launched. */
  dispatchedBy: string | null;
}

export { listQueuedAcrossProjects } from '../db/runs/queue.js';

/**
 * The claim queue, as a worker sees it.
 *
 * Two statements rather than one: the candidate is read, then taken by a write
 * guarded on everything the read relied on. Two workers reading the same row
 * both attempt the write and exactly one changes a row, which is the same shape
 * the dispatched claim already uses and needs no row-value support.
 *
 * `dispatched_by IS NULL` is what keeps this queue disjoint from the launch
 * path's. A queued row that still names a credential belongs to a launch the
 * queue took back while its child runs, and that child claims under the
 * credential the row names; a worker must never take it. `expireLeases` clears the column when it
 * requeues, which is what makes a run it held claimable again.
 */
export interface ClaimCandidate {
  projectId: string;
  id: string;
  task: string;
  instruction: string | null;
  dispatchSpec: string | null;
}

export interface ClaimedRunRow {
  projectId: string;
  id: string;
  task: string;
  instruction: string | null;
  runContext: string | null;
  dryRun: number;
}

export { nextClaimable } from '../db/runs/queue.js';

/** A pulled run the claim creates: its identity, single-flight subject, built input and its stage's reassertion. */
export interface PulledCandidate {
  projectId: string;
  id: string;
  task: string;
  subject: string;
  input: ClaimedInput;
  /** The selection the stage reasserts inside the write: level, head and fairness. */
  assertions: readonly Bound[];
  /** What the stage adds to the claim's batch, given the attempt the batch mints. */
  claimed?: (dispatchedBy: string) => Bound[];
}

/**
 * Take one queued run for a worker.
 *
 * The row reaches `running` and names its credential in the same statement: a
 * claim that answered a credential the row did not yet name would leave a run
 * the MCP surface resolves nothing for while it looked healthy. `started_at` is
 * rewritten so the task budget bounds the run rather than its wait in the queue.
 * The attempt the claim starts is recorded in the same batch, and only where the
 * claim landed (`core/run-steps.ts`).
 */
export { claimQueuedRun, claimPulledRun } from './worker-claim.js';

/** The prompt a claim rebuilt, and the hash and counts the server filed it under, onto the row a worker now holds. */
export interface ClaimedInput { instruction: string; instructions?: string; inputHash: string; counts: Readonly<Record<string, number | boolean>>; repository?: RepositoryCheckoutSpec; context?: Readonly<Record<string, unknown>>; subject?: string }

/** Extend a lease the caller still holds. False says the lease is gone: swept, or the run ended. */
export async function renewRunLeaseExpiry(
  db: RelationalStore, scope: ReadScope, runId: string, worker: WorkerPrincipal, expiresAt: number, now: number, dispatchedBy?: string, contact?: PreparedStatement | null,
): Promise<number | null> {
  const authority = renewingLeaseAuthority(worker, now, dispatchedBy, true);
  const deadline = runDeadlineSql();
  const statement = db.prepare(
    `UPDATE agent_runs SET lease_expires_at = MIN(${deadline}, MAX(lease_expires_at, ?))
      WHERE project_id = ? AND id = ? AND ${authority.sql} RETURNING lease_expires_at AS expiresAt`,
  ).bind(expiresAt, scope.projectId, runId, ...authority.params);
  const [result] = await db.batch([statement, ...(contact == null ? [] : [contact])]);
  return (result!.results[0] as { expiresAt: number } | undefined)?.expiresAt ?? null;
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
  const row = await db.prepare(`SELECT lease_expires_at AS expiresAt FROM agent_runs
    WHERE project_id = ? AND id = ? AND ${authority.sql}`)
    .bind(scope.projectId, runId, ...authority.params).first<{ expiresAt: number }>();
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
export function leaseOwnerOf(row: { leasedBy: string | null; leasedRunnerId: string | null; leasedRunnerCredentialId: string | null }): LeaseOwner | null {
  if (row.leasedRunnerId !== null && row.leasedRunnerCredentialId !== null) return { kind: 'runner', runnerId: row.leasedRunnerId, credentialId: row.leasedRunnerCredentialId };
  return row.leasedBy === null ? null : { kind: 'member', leasedBy: row.leasedBy };
}

export async function lapsedLeases(db: RelationalStore, now: number, limit: number): Promise<Array<{ projectId: string; id: string; owner: LeaseOwner | null; dispatchedBy: string | null }>> {
  const { results } = await db.prepare(
    `SELECT project_id AS projectId, id, leased_by AS leasedBy, leased_runner_id AS leasedRunnerId, leased_runner_credential_id AS leasedRunnerCredentialId,
            dispatched_by AS dispatchedBy FROM agent_runs
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      LIMIT ?`,
  ).bind(now, limit).all<{ projectId: string; id: string; leasedBy: string | null; leasedRunnerId: string | null; leasedRunnerCredentialId: string | null; dispatchedBy: string | null }>();
  return results.map(({ leasedBy, leasedRunnerId, leasedRunnerCredentialId, ...row }) => ({ ...row, owner: leaseOwnerOf({ leasedBy, leasedRunnerId, leasedRunnerCredentialId }) }));
}

/** A run with a single-flight subject ends when its lease lapses: its work stays due and a later claim pulls it again. */
export const LEASE_LAPSED = 'lease_lapsed';

/** Settle an expired attempt under its exact owner and attempt identity; subject runs end instead of requeuing. */
export async function settleLapsedLease(db: RelationalStore, scope: ReadScope, runId: string, owner: LeaseOwner | null, attemptId: string | null, now: number): Promise<boolean> {
  const named = owner === null ? 'leased_by IS NULL AND leased_runner_id IS NULL'
    : owner.kind === 'member' ? 'leased_by = ? AND leased_runner_id IS NULL' : 'leased_by IS NULL AND leased_runner_id = ? AND leased_runner_credential_id = ?';
  const params = owner === null ? [] : owner.kind === 'member' ? [owner.leasedBy] : [owner.runnerId, owner.credentialId];
  const ends = 'subject IS NOT NULL';
  const result = await commitRunChange(db, runChangeStatement(db,
    `UPDATE agent_runs SET status = CASE WHEN ${ends} THEN 'failed' ELSE 'queued' END,
        completed_at = CASE WHEN ${ends} THEN ? ELSE completed_at END,
        error_code = CASE WHEN ${ends} THEN '${LEASE_LAPSED}' ELSE error_code END,
        error = CASE WHEN ${ends} THEN 'The lease lapsed; the work stays due and is pulled again' ELSE error END,
        dispatched_by = CASE WHEN ${ends} THEN dispatched_by ELSE NULL END,
        started_at = CASE WHEN ${ends} THEN started_at ELSE NULL END,
        held_by = CASE WHEN ${ends} THEN NULL ELSE 'worker' END,
        leased_by = NULL, leased_runner_id = NULL, leased_runner_credential_id = NULL, lease_expires_at = NULL
      WHERE project_id = ? AND id = ? AND status = 'running' AND ${named}
        AND dispatched_by IS ? AND lease_expires_at <= ?`,
    [now, scope.projectId, runId, ...params, attemptId, now]));
  return result.changed === 1;
}

export { workerLiveness } from '../db/runs/status.js';

export { hasQueuedRun } from '../db/runs/queue.js';

// ---------------------------------------------------------------------------
// What the clock reads before it schedules a task, per Project
// ---------------------------------------------------------------------------

/** Unattributed legacy runs count conservatively against an actor's budget. */
export const UNATTRIBUTED_DISPATCH_ACTOR = '';
/** Whether an actor dispatched a run, or any actor where none is named. Bound as `actorParams`. */



/** The key `taskRunFacts` answers a Project and task under. */
export const taskFactsKey = (projectId: string, task: string): string => `${projectId}\u0000${task}`;

/** Latest entries, live admission and the rolling window use separate indexed questions for each eligible Project. */
export function taskRunFacts(
  db: RelationalStore,
  tasks: readonly string[],
  sinceMs: number,
  actor: string,
  projectId?: string | readonly string[],
): {
  statement: PreparedStatement;
  read: (rows: ReadonlyArray<Record<string, unknown>>) => Map<string, TaskRunFacts>;
} {
  const latest = lastTaskEntryQueries({ projectId: '' }, '', actor, { project: 'p.project_id', task: 't.value' });
  const projects =
    projectId === undefined
      ? ''
      : typeof projectId === 'string'
        ? 'AND p.project_id = ?'
        : 'AND p.project_id IN (SELECT value FROM json_each(?))';
  const statement = db
    .prepare(
      `SELECT p.project_id AS projectId,t.value AS task,
    EXISTS(SELECT 1 FROM agent_runs WHERE project_id=p.project_id AND task=t.value AND ${IN_FLIGHT_RUN_STATUSES}) AS live,
    (SELECT MAX(at) FROM (${latest.map(({ sql }) => 'SELECT * FROM (' + sql + ')').join(' UNION ALL ')})) AS lastEntryAt,
    (${taskEntriesSql('p.project_id', 't.value', actor)}) AS entriesSince
    FROM projects p CROSS JOIN json_each(?) t WHERE 1=1 ${projects}
      AND EXISTS(SELECT 1 FROM agent_runs WHERE project_id=p.project_id AND task=t.value LIMIT 1)`,
    )
    .bind(
      ...latest.flatMap(({ binds }) => binds),
      sinceMs,
      actor,
      JSON.stringify(tasks),
      ...(projectId === undefined ? [] : [typeof projectId === 'string' ? projectId : JSON.stringify(projectId)]),
    );
  const read = (rows: ReadonlyArray<Record<string, unknown>>): Map<string, TaskRunFacts> =>
    new Map(
      rows.map((row) => [
        taskFactsKey(String(row.projectId), String(row.task)),
        {
          live: Number(row.live) === 1,
          lastEntryAt: row.lastEntryAt === null ? null : Number(row.lastEntryAt),
          entriesSince: Number(row.entriesSince ?? 0),
        },
      ]),
    );
  return { statement, read };
}

/** The code and message on a run stopped by a signed-in member. */
export const RUN_CANCELLED = 'run_cancelled';

/**
 * End one in-flight run at the writer. A member may end only a request whose
 * persisted dispatch names them; an administrator may end any request. The
 * actor, live membership, Project and live status are checked by the update.
 */
export async function cancelRun(
  db: RelationalStore, scope: ReadScope, runId: string,
  actor: { memberId: string; admin: boolean }, now: number,
): Promise<{ displaced: string | null } | null> {
  const row = await db.prepare(`UPDATE agent_runs
    SET status = 'failed', completed_at = ?, error = ?, error_code = ?,
        lease_expires_at = NULL, held_by = NULL
    WHERE project_id = ? AND id = ? AND ${IN_FLIGHT_RUN_STATUSES}
      AND EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND m.revoked_at IS NULL)
      AND (${DISPATCH_ACTOR_SQL} = ? OR (? = 1 AND EXISTS (
        SELECT 1 FROM members m WHERE m.id = ? AND m.role = 'admin' AND m.revoked_at IS NULL)))
    RETURNING dispatched_by AS displaced`)
    .bind(now, 'Cancelled by a member', RUN_CANCELLED, scope.projectId, runId,
      actor.memberId, actor.memberId, actor.admin ? 1 : 0, actor.memberId)
    .first<{ displaced: string | null }>();
  return row;
}

function preparationOfRun(run: Pick<RunRow, 'runContext'>, key: 'repository' | 'canopy' | 'checkout'): unknown {
  if (run.runContext === null) return undefined;
  const context: unknown = JSON.parse(run.runContext);
  if (context === null || typeof context !== 'object' || Array.isArray(context)) throw new Error('Run context is not an object.');
  return (context as Record<string, unknown>)[key];
}

/** Source identity and history bound recorded with the claim's prompt. */
export function repositoryCheckoutOfRun(run: Pick<RunRow, 'runContext'>): RepositoryCheckoutSpec | null {
  const checkout = preparationOfRun(run, 'checkout');
  return checkout === undefined ? null : parseRepositoryCheckoutSpec(checkout);
}

/** The immutable source revision attached to a code run, if preparation has pinned it. */
export function repositoryPinOfRun(run: Pick<RunRow, 'runContext'>): RepositoryPin | null {
  const pin = preparationOfRun(run, 'repository');
  if (pin === undefined) return null;
  if (pin === null || typeof pin !== 'object' || Array.isArray(pin)) throw new Error('Run repository pin is invalid.');
  const record = pin as RepositoryPin;
  if (typeof record.url !== 'string' || typeof record.branch !== 'string' || typeof record.commit !== 'string'
    || !REPOSITORY_COMMIT_PATTERN.test(record.commit)) throw new Error('Run repository pin is invalid.');
  return { url: record.url, branch: record.branch, commit: record.commit };
}

/** Worker identity and the instant its preparation write is admitted. */
export interface RunLease { worker: WorkerPrincipal; now: number }

/** Pin once while the dispatched run is held; a repeat reads the first committed identity. */
export async function pinRepositoryForRun(db: RelationalStore, scope: ReadScope, run: RunRow, pin: RepositoryPin, lease?: RunLease): Promise<RepositoryPin | null> {
  repositoryPinOfRun(run);
  const result = await pinRunPreparation(db, scope, run, 'repository', pin, lease);
  return result === null ? null : result.committed ? pin : repositoryPinOfRun(result.row);
}

/** Pin a map run's repository and source input in one guarded write. */
export async function pinMapRepositoryForRun(
  db: RelationalStore, scope: ReadScope, run: RunRow, repository: RepositoryPin, source: MapSourcePin, lease: RunLease,
): Promise<{ committed: true } | { committed: false; row: RunRow } | null> {
  if (run.dispatchedBy === null) return null;
  const authority = renewingLeaseAuthority(lease.worker, lease.now, run.dispatchedBy, true);
  const write = await db.prepare(`UPDATE agent_runs SET run_context = json_set(COALESCE(run_context, '{}'),
      '$.repository', json(?), '$.canopy', json(?))
    WHERE project_id = ? AND id = ? AND ${authority.sql}
      AND json_type(COALESCE(run_context, '{}'), '$.canopy') IS NULL
      AND (json_type(COALESCE(run_context, '{}'), '$.repository') IS NULL
        OR (json_extract(run_context, '$.repository.url') = ?
          AND json_extract(run_context, '$.repository.branch') = ?
          AND json_extract(run_context, '$.repository.commit') = ?)) RETURNING id`)
    .bind(JSON.stringify(repository), JSON.stringify(source), scope.projectId, run.id, ...authority.params,
      repository.url, repository.branch, repository.commit).run();
  if (write.results.length === 1) return { committed: true };
  if (await workerRunLeaseExpiry(db, scope, run.id, lease.worker, lease.now, run.dispatchedBy) === null) return null;
  const fresh = await getRun(db, scope, run.id);
  if (fresh === null || fresh.status !== 'running' || fresh.dispatchedBy !== run.dispatchedBy) return null;
  return { committed: false, row: fresh };
}

/** The source hash and map revision a run prepared before model execution. */
export function mapSourcePinOfRun(run: Pick<RunRow, 'runContext'>): MapSourcePin | null {
  const value = preparationOfRun(run, 'canopy');
  if (value === undefined) return null;
  return parseMapSourcePin(value);
}

export async function pinMapSourceForRun(db: RelationalStore, scope: ReadScope, run: RunRow, pin: MapSourcePin, lease?: RunLease): Promise<MapSourcePin | null> {
  mapSourcePinOfRun(run);
  const result = await pinRunPreparation(db, scope, run, 'canopy', parseMapSourcePin(pin), lease);
  return result === null ? null : result.committed ? pin : mapSourcePinOfRun(result.row);
}

/** Each preparation value is written once under the held run's guard; repeats read the first pin. */
async function pinRunPreparation(db: RelationalStore, scope: ReadScope, run: RunRow, key: 'repository' | 'canopy', value: RepositoryPin | MapSourcePin, lease?: RunLease): Promise<{ committed: true } | { committed: false; row: RunRow } | null> {
  const path = `$.${key}`;
  const authority = lease === undefined
    ? { sql: "status = 'running' AND dispatched_by = ?", params: [run.dispatchedBy] }
    : renewingLeaseAuthority(lease.worker, lease.now, run.dispatchedBy ?? undefined, true);
  const write = await db.prepare(`UPDATE agent_runs SET run_context = json_set(COALESCE(run_context, '{}'), ?, json(?))
    WHERE project_id = ? AND id = ? AND ${authority.sql}
      AND json_type(COALESCE(run_context, '{}'), ?) IS NULL RETURNING id`)
    .bind(path, JSON.stringify(value), scope.projectId, run.id, ...authority.params, path).run();
  if (write.results.length === 1) return { committed: true };
  if (lease !== undefined && await workerRunLeaseExpiry(db, scope, run.id, lease.worker, lease.now, run.dispatchedBy ?? undefined) === null) return null;
  const fresh = await getRun(db, scope, run.id);
  if (fresh === null || fresh.status !== 'running' || fresh.dispatchedBy !== run.dispatchedBy) return null;
  return { committed: false, row: fresh };
}

/** A held knowledge attempt records unavailable code access and continues with its original knowledge material. */
export async function recordKnowledgeRepositoryUnavailable(db: RelationalStore, scope: ReadScope, run: RunRow,
  failure: RepositoryFailure, lease: RunLease): Promise<boolean> {
  if (run.dispatchedBy === null || !KNOWLEDGE_REPOSITORY_TASKS.includes(run.task ?? '')) return false;
  const authority = renewingLeaseAuthority(lease.worker, lease.now, run.dispatchedBy, true);
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt += 1) {
    const prompt=await db.prepare('SELECT instruction FROM agent_runs WHERE project_id=? AND id=?').bind(scope.projectId,run.id).first<{instruction:string|null}>();
    // The rewrite lands only over the instruction it is derived from; a newer instruction is read again and rewritten.
    const mutation = knowledgeUnavailable(lease.worker,knowledgeOnlyInstruction(prompt?.instruction ?? ''),scope.projectId,run.id,prompt?.instruction ?? null,lease.now,run.dispatchedBy);
    const result = await commitAttributedWrite(db,scope,mutation,{runId:run.id,toolName:'worker_repository',op:'unavailable',
      detail:{code:failure.code},recordedAt:lease.now});
    if (result.results.length === 1) return true;
    const held = await db.prepare(`SELECT json_type(run_context,'$.checkout') AS checkout,instruction FROM agent_runs WHERE project_id=? AND id=? AND ${authority.sql}`)
      .bind(scope.projectId,run.id,...authority.params).first<{checkout:string|null;instruction:string|null}>();
    if (held === null) return false;
    if (held.checkout === null) return true;
    if (held.checkout !== 'object' || held.instruction === (prompt?.instruction ?? null)) return false;
  }
  return false;
}

/** What the clock's schedule reads of one Project's runs of one task. */
export interface TaskRunFacts {
  /** A run of the task is live: pending, running or queued, as `hasLiveTaskRun` reads it. */
  live: boolean;
  /** When the actor last entered one, as `lastTaskEntryAt` reads it. */
  lastEntryAt: number | null;
  /** The actor's entries from the window's start on, as `taskEntriesSince` counts them. */
  entriesSince: number;
}
