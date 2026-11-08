import { storedQueueHold } from './queue.js';
import { CREDENTIAL_INSERT_SQL } from './claim-companions.js';
import { observedRevisionPredicate } from '../../core/settings.js';
import type { ClaimForm, WorkerClaim } from '../../core/worker-claim.js';
import { leaseOwnerColumns } from '../../core/worker-lease.js';
import { liveCountSql, RUN_ADMISSION_READY_SQL } from './live.js';
import { resolvedConcurrency, type DispatchLimits } from '../../core/limits.js';

/** One resolved Deployment limit and one task limit, re-read from maintained counts inside each admitted write. */
export const CONCURRENCY_ADMISSION_SQL = `AND ${RUN_ADMISSION_READY_SQL}
  AND (? IS NULL OR ${liveCountSql('fleet', "''", '?', '?')} < ?)
  AND (? IS NULL OR ${liveCountSql('task', '?', '?', '?')} < ?)`;

export const QUEUED_CLAIM_HEAD_SQL = `EXISTS(SELECT 1 FROM task_due d WHERE d.project_id=agent_runs.project_id AND d.run_id=agent_runs.id AND d.claimable=1)`;

export function concurrencyParams(projectId: string, task: string | null, runId: string, limits: DispatchLimits) {
  const { value } = resolvedConcurrency(limits);
  return [value, projectId, runId, value, limits.task_concurrent_runs, task, projectId, runId, task, limits.task_concurrent_runs];
}

/** Pulled-stage availability uses the same resolved limits as queue admission. */
export function limitPassesSql(task: string, limits: DispatchLimits, now: number): string {
  const t = `'${task.replaceAll("'", "''")}'`;
  const { value } = resolvedConcurrency(limits);
  const terms = [RUN_ADMISSION_READY_SQL,
    value === null ? null : `${liveCountSql('fleet', t, 'NULL', 'NULL')} < ${Math.floor(value)}`,
    limits.task_concurrent_runs === null ? null : `${liveCountSql('task', t, 'NULL', 'NULL')} < ${Math.floor(limits.task_concurrent_runs)}`,
    limits.task_runs_per_hour === null ? null : `(SELECT COUNT(*) FROM agent_runs INDEXED BY idx_agent_runs_task_started WHERE task=${t} AND started_at IS NOT NULL AND started_at>=${Math.floor(now - 3_600_000)}) < ${Math.floor(limits.task_runs_per_hour)}`,
  ].filter((term): term is string => term !== null);
  return `(${terms.join(' AND ')})`;
}

import { assertion, commit, read, readSet, write, type Bound } from '../index.js';
import { prepareBound } from '../kernel/statement.js';
import type { RelationalStore, PreparedStatement } from '../../core/adapters.js';
import type { ReadScope } from '../../read/scope.js';
import { memberWriteStore, type MemberWriteActor } from '../../auth/member-write-store.js';
import { LIVE_RUN_STATUSES, IN_FLIGHT_RUN_STATUSES, UNCLAIMED_RUN_STATUSES } from '../run-statuses.js';
import { runOriginSql, contextValue, DISPATCH_ACTOR_SQL } from '../run-context.js';
import { admissionForTask } from '../../core/task-catalogue.js';
import { PROJECT_WORK_SQL, CAPABILITY_ON_SQL, settingsWriter } from '../../core/settings.js';
import { budgetClaimPredicate } from '../../core/run-budget.js';
import { runDeadlineSql, preparationAllowanceSql, SQL_NOW_MS } from '../../core/run-deadline.js';
import { runParentLive, runnerCredentialAuthority, RUNNER_WRITE_REFUSED, runnerWriteRefusal } from '../../auth/runners.js';
import type { WorkerPrincipal } from '../../core/worker-lease.js';
import { REPOSITORY_PREPARATION_TIMEOUT_MS } from '@goondocks/myco-shared/repository';
import { INPUT_UNCHANGED, SCHEDULE_ACTOR_SQL, SCHEDULE_ENTRY_SQL } from '../schedule-entry.js';
import { UNATTRIBUTED_DISPATCH_ACTOR, skipContext, type RunInsert, type RunningRunRef, type RunAdmissionGate, type ClaimOutcome, type ActorCeiling, type WriteAdmission, type DispatchRecord, type RunCaller, type AgentIdentity, type QueuedRecord, type QueuedRunEnd, type ClaimCandidate, type ClaimedRunRow, type PulledCandidate, type ClaimedInput } from '../../core/runs.js';
export const CLAIM_SQL = `INSERT INTO agent_runs
    (project_id, id, agent_id, task, instruction, harness, provider, model, status, dry_run, started_at, run_context, dispatched_by,origin)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?,'manual'
   WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)`;

export const CLAIM_DISPATCHED_SQL = `UPDATE agent_runs
   SET status = 'running', harness = ?, instruction = COALESCE(?, instruction), provider = COALESCE(provider, ?), model = COALESCE(model, ?),
       started_at = COALESCE(started_at, ?), held_by = NULL
 WHERE project_id = ? AND id = ? AND ${UNCLAIMED_RUN_STATUSES} AND dispatched_by = ? AND task IS ?`;

export const NOT_THE_RUN_ADMITTED = '(? IS NULL OR id != ?)';

export const ACTOR_ENTRY_SQL = `task = ? AND status != 'skipped' AND COALESCE(${contextValue('replaced')}, 0) != 1
       AND COALESCE(queued_at, started_at) >= ? AND ${DISPATCH_ACTOR_SQL} = ?`;

export const ACTOR_PROJECT_SQL = '(? IS NULL OR project_id = ?)';

export const ACTOR_CEILING_WHERE = `
   AND (? IS NULL OR (SELECT COUNT(*) FROM agent_runs WHERE ${ACTOR_ENTRY_SQL} AND ${ACTOR_PROJECT_SQL} AND ${NOT_THE_RUN_ADMITTED}) < ?)`;

export function actorCeilingParams(runId: string, ceiling: ActorCeiling | undefined): (string | number | null)[] {
  return ceiling === undefined ? [null, null, null, null, null, null, runId, runId, null] : [ceiling.perDay, ceiling.task, ceiling.sinceMs, ceiling.actor, ceiling.projectId ?? null, ceiling.projectId ?? null, runId, runId, ceiling.perDay];
}

export const PROJECT_ADMISSION_WHERE = ` AND ${PROJECT_WORK_SQL} AND (? IS NULL OR ${CAPABILITY_ON_SQL})`;

export function projectAdmissionParams(scope: ReadScope, capability?: string | null): (string | null)[] {
  return [scope.projectId, capability ?? null, scope.projectId, capability ?? null];
}

export const ADMISSION_WHERE = `
   ${CONCURRENCY_ADMISSION_SQL}
   AND (? IS NULL OR (SELECT COUNT(*) FROM agent_runs INDEXED BY idx_agent_runs_task_started WHERE task = ? AND ${NOT_THE_RUN_ADMITTED} AND started_at IS NOT NULL AND started_at >= ?) < ?)
   AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND task = ? AND ${IN_FLIGHT_RUN_STATUSES} AND id != ?))${ACTOR_CEILING_WHERE}
${PROJECT_ADMISSION_WHERE}`;

export async function writeDispatchRecord(db: RelationalStore, statement: Bound, admission?: { actor?: MemberWriteActor; setup?: Bound[] }): Promise<boolean> {
  const statements = [...(admission?.setup ?? []), statement];
  const store = admission?.actor === undefined ? db : memberWriteStore(db, admission.actor.memberId, admission.actor.authority);
  const results = await commit(store, ...statements);
  return results[results.length - 1]!.results.length === 1;
}

export const NO_LIMITS: DispatchLimits = { concurrent_runs: null, task_concurrent_runs: null, task_runs_per_hour: null, fleet: null };

export function admissionParams(scope: ReadScope, task: string | null, runId: string, admission: WriteAdmission | undefined): (string | number | null)[] {
  const l = admission?.limits ?? NO_LIMITS;
  const hourStart = (admission?.now ?? 0) - 3_600_000;
  const single = admission?.singleFlight === true ? task : null;
  const gate = task === null ? null : admissionForTask(task);
  const capability = gate === null ? admission?.capability : gate.kind === 'capability' ? gate.capability : null;
  return [
    ...concurrencyParams(scope.projectId, task, runId, l),
    l.task_runs_per_hour, task, runId, runId, hourStart, l.task_runs_per_hour,
    single, scope.projectId, task, runId,
    ...actorCeilingParams(runId, admission?.ceiling),
    ...projectAdmissionParams(scope, capability),
  ];
}

export const RECORD_DISPATCH_SQL = `INSERT INTO agent_runs
    (project_id, id, agent_id, task, instruction, provider, model, status, dry_run, started_at, run_context, dispatched_by, dispatch_spec,origin)
  SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, (SELECT ${runOriginSql()} FROM (SELECT NULL AS origin,? AS dispatch_spec))
   WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)${ADMISSION_WHERE} RETURNING id`;

export const RUN_REF_SQL = `SELECT id, task, started_at AS startedAt, resumed_at AS resumedAt FROM agent_runs
   WHERE project_id = ? AND id = ?`;

export const RUNNING_SQL = `SELECT id, task, started_at AS startedAt, resumed_at AS resumedAt FROM agent_runs
   WHERE project_id = ? AND task = ? AND status = 'running'
     AND COALESCE(resumed_at, started_at) > ?
   ORDER BY COALESCE(resumed_at, started_at) DESC LIMIT 1`;

export async function recordDispatch(db: RelationalStore, scope: ReadScope, record: DispatchRecord, admission?: WriteAdmission): Promise<boolean> {
  const statement = recordDispatchWrite.bind(scope.projectId, record.id, record.agentId, record.task, record.instruction ?? null, record.provider, record.model, record.dryRun === true ? 1 : 0, record.startedAt, record.runContext, record.dispatchedBy, record.dispatchSpec ?? null, record.dispatchSpec ?? null, scope.projectId, record.id, ...admissionParams(scope, record.task, record.id, admission));
  return writeDispatchRecord(db, statement, admission);
}

export async function claimRun(
  db: RelationalStore,
  scope: ReadScope,
  row: RunInsert,
  guard: { taskName: string; admission: RunAdmissionGate; dispatchedOnly?: boolean; embeddingConfigured?: boolean; caller?: RunCaller },
  _now: number,
): Promise<ClaimOutcome> {
  const admission = admissionForTask(row.task ?? guard.taskName) ?? guard.admission;
  const capability = admission.kind === 'capability' ? admission.capability : null;
  const admissionRefusal = async (): Promise<ClaimOutcome | null> =>
    capability !== null && !(await settingsWriter(db).capabilityEnabled(scope.projectId, capability))
      ? { claimed: false, notAdmitted: capability } : null;
  const refused = await admissionRefusal();
  if (refused !== null) return refused;
  if (admission.kind === 'embedding' && guard.embeddingConfigured !== true) {
    return { claimed: false, noProvider: true };
  }
  const admissionValues = projectAdmissionParams(scope, capability);
  const failedClaim = async (): Promise<ClaimOutcome> => {
    const denied = await admissionRefusal();
    if (denied !== null) return denied;
    const held = ((await readSet(db, runReferenceRead.bind(scope.projectId, row.id)))[0][0] ?? null);
    return { claimed: false, running: held ?? null };
  };
  if (row.dispatchedBy !== null) {
    const caller = runCallerGuard(guard.caller, UNCLAIMED_RUN_STATUSES);
    const dispatched = (await commit(db, dispatchedClaims[Number(guard.caller !== undefined)]!.bind(row.harness, row.instruction, row.provider, row.model, row.startedAt, scope.projectId, row.id, row.dispatchedBy, row.task, ...caller.params, ...admissionValues)))[0];
    if (dispatched.results.length === 1) return { claimed: true };
  }
  if (guard.dispatchedOnly === true) return failedClaim();
  const result = (await commit(db, directClaimWrite.bind(scope.projectId, row.id, row.agentId, row.task, row.instruction, row.harness, row.provider, row.model, row.dryRun ? 1 : 0, row.startedAt, row.runContext, row.dispatchedBy, scope.projectId, row.id, ...admissionValues)))[0];

  if (result.results.length === 1) return { claimed: true };
  return failedClaim();
}

export async function getRunningRunForTask(db: RelationalStore, scope: ReadScope, taskName: string, maxAgeSeconds: number, now: number): Promise<RunningRunRef | null> {
  const floor = now - maxAgeSeconds * 1000;
  const [rows] = await readSet(db, runningTaskRead.bind(scope.projectId, taskName, floor));
  return rows[0] ?? null;
}

export function ensureAgentWrite(db: RelationalStore, agent: AgentIdentity, now: number): Bound {
  return agentIdentityWrite.bind(agent.id, agent.name, agent.provider, agent.model, agent.enabled ? 1 : 0, now, now);
}

export function runCallerGuard(caller: RunCaller | undefined, statuses = LIVE_RUN_STATUSES): { sql: string; params: (string | number)[] } {
  if (caller === undefined) return { sql: '', params: [] };
  return {
    sql: ` AND dispatched_by = ? AND ${statuses} AND (lease_expires_at IS NULL OR lease_expires_at > ${SQL_NOW_MS}) AND ? > ${SQL_NOW_MS}
      AND ${runDeadlineSql()} > ${SQL_NOW_MS} AND ${runParentLive()}
      AND EXISTS (SELECT 1 FROM member_credentials c JOIN members m ON m.id = c.member_id
        WHERE c.id = ? AND c.revoked_at IS NULL AND c.expires_at > ${SQL_NOW_MS} AND m.revoked_at IS NULL)`,
    params: [caller.tokenId, caller.deadline, caller.tokenId],
  };
}

export const RUN_INSIDE_BOUND_SQL = `SELECT 1 AS one FROM agent_runs
  WHERE ${LIVE_RUN_STATUSES} AND started_at IS NOT NULL
    AND ? < started_at + COALESCE(json_extract(run_context, '$.timeoutSeconds'), ?) * 1000 + ${preparationAllowanceSql()} + ?
  LIMIT 1`;

export async function hasRunInsideBound(db: RelationalStore, now: number, defaultTimeoutSeconds: number, marginMs: number): Promise<boolean> {
  return (((await readSet(db, insideBoundRead.bind(now, defaultTimeoutSeconds, marginMs)))[0][0] ?? null)) !== null;
}

export const RECORD_QUEUED_SQL = `INSERT INTO agent_runs
    (project_id, id, agent_id, task, instruction, provider, model, status, dry_run, queued_at, held_by, dispatch_spec, run_context,origin)
  SELECT ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, (SELECT ${runOriginSql()} FROM (SELECT NULL AS origin,? AS dispatch_spec))
   WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)
   AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND task = ? AND ${IN_FLIGHT_RUN_STATUSES}))${ACTOR_CEILING_WHERE}${PROJECT_ADMISSION_WHERE} RETURNING id`;

export async function recordQueued(db: RelationalStore, scope: ReadScope, record: QueuedRecord, options: { singleFlight?: boolean; ceiling?: ActorCeiling; actor?: MemberWriteActor; setup?: Bound[] } = {}): Promise<boolean> {
  const gate = admissionForTask(record.task);
  const statement = queueRecordWrite.bind(scope.projectId, record.id, record.agentId, record.task, record.instruction ?? null, record.provider, record.model, record.dryRun === true ? 1 : 0, record.queuedAt, storedQueueHold(record.heldBy), record.dispatchSpec, record.runContext ?? null, record.dispatchSpec, scope.projectId, record.id, options.singleFlight === true ? record.task : null, scope.projectId, record.task, ...actorCeilingParams(record.id, options.ceiling), ...projectAdmissionParams(scope, gate?.kind === 'capability' ? gate.capability : null));
  return writeDispatchRecord(db, statement, options);
}

export const LAUNCH_QUEUED_SQL = `UPDATE agent_runs
   SET status = 'pending', dispatched_by = ?, started_at = ?, run_context = ?, instruction = COALESCE(?, instruction),
       provider = COALESCE(?, provider), model = COALESCE(?, model), held_by = NULL
 WHERE project_id = ? AND id = ? AND status = 'queued' AND task = ?${ADMISSION_WHERE} RETURNING id`;

export async function launchQueued(db: RelationalStore, scope: ReadScope, runId: string, launch: { task: string; dispatchedBy: string; startedAt: number; runContext: string | null; instruction?: string | null; provider: string | null; model: string | null }, admission?: WriteAdmission): Promise<boolean> {
  const statement = launchQueuedWrite.bind(launch.dispatchedBy, launch.startedAt, launch.runContext, launch.instruction ?? null, launch.provider, launch.model, scope.projectId, runId, launch.task, ...admissionParams(scope, launch.task, runId, admission));
  return writeDispatchRecord(db, statement, admission);
}

export const RETURN_TO_QUEUE_SQL = `UPDATE agent_runs
   SET status = 'queued', held_by = ?, dispatch_spec = ?, dispatched_by = ?,
       queued_at = COALESCE(queued_at, started_at, ?)
 WHERE project_id = ? AND id = ? AND status = 'pending' RETURNING id`;

export async function returnToQueue(
  db: RelationalStore, scope: ReadScope, runId: string,
  hold: { heldBy: string; dispatchSpec: string; credential: string | null; now: number },
): Promise<boolean> {
  const result = (await commit(db, returnQueuedWrite.bind(storedQueueHold(hold.heldBy), hold.dispatchSpec, hold.credential, hold.now, scope.projectId, runId)))[0];
  return result.results.length === 1;
}

export async function restoreDispatchCredential(db: RelationalStore, scope: ReadScope, runId: string, tokenId: string): Promise<boolean> {
  const result = (await commit(db, dispatchCredentialWrite.bind(tokenId, scope.projectId, runId)))[0];
  return result.results.length === 1;
}

export async function skipQueued(db: RelationalStore, scope: ReadScope, runId: string, now: number, reason: string): Promise<QueuedRunEnd> {
  const row = ((await commit(db, skipQueuedWrite.bind(now, skipContext(reason), scope.projectId, runId)))[0].results[0] ?? null);
  return { applied: row !== null, displaced: row?.displaced ?? null };
}

export function pulledClaimPredicate(pull: PulledCandidate, admission: WriteAdmission): { sql: string; params: unknown[] } {
  const money = admission.budget===undefined ? {sql:'1',params:[]} : budgetClaimPredicate(admission.budget,admission.now);
  return {
    sql: `EXISTS (SELECT 1 FROM (SELECT ? AS project_id, ? AS id, ? AS task, 'automatic' AS origin) agent_runs
      WHERE NOT EXISTS (SELECT 1 FROM agent_runs existing WHERE existing.project_id = ? AND existing.id = ?)
        AND NOT EXISTS (SELECT 1 FROM agent_runs flight INDEXED BY idx_agent_runs_task_live
          WHERE flight.task = ? AND flight.${IN_FLIGHT_RUN_STATUSES} AND flight.subject = ?)
       ${ADMISSION_WHERE} AND ${money.sql} AND (${admission.settingsGuard === undefined ? '1' : observedRevisionPredicate({}, true).sql}))`,
    params: [pull.projectId, pull.id, pull.task, pull.projectId, pull.id, pull.task, pull.subject,
      ...admissionParams({ projectId: pull.projectId }, pull.task, pull.id, admission), ...money.params, ...(admission.settingsGuard === undefined ? [] : [JSON.stringify(admission.settingsGuard)])],
  };
}

export function workerClaimPredicate(candidate: ClaimCandidate, admission: WriteAdmission): { sql: string; params: unknown[] } {
  const money = admission.budget===undefined ? {sql:'1',params:[]} : budgetClaimPredicate(admission.budget,admission.now);
  return {
    sql: `EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ? AND status = 'queued' AND task = ? AND dispatched_by IS NULL AND ${QUEUED_CLAIM_HEAD_SQL}${ADMISSION_WHERE} AND ${money.sql} AND (${admission.settingsGuard === undefined ? '1' : observedRevisionPredicate({}, true).sql}))`,
    params: [candidate.projectId, candidate.id, candidate.task, ...admissionParams({ projectId: candidate.projectId }, candidate.task, candidate.id, admission), ...money.params, ...(admission.settingsGuard === undefined ? [] : [JSON.stringify(admission.settingsGuard)])],
  };
}

export function workerClaimAdmission(candidate: ClaimCandidate, admission: WriteAdmission, worker: WorkerPrincipal, now: number): { sql: string; params: unknown[] } {
  const authority = workerClaimPredicate(candidate, admission);
  const gate = runnerClaimGate(worker, now);
  return { sql: `${authority.sql} AND ${gate.sql}`, params: [...authority.params, ...gate.params] };
}

export function runnerClaimGate(worker: WorkerPrincipal, now: number): { sql: string; params: unknown[] } {
  if (worker.kind === 'member') return { sql: '1', params: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM runners claimant WHERE claimant.id = ? AND claimant.state = 'enabled')
      AND NOT EXISTS (SELECT 1 FROM agent_runs held INDEXED BY idx_agent_runs_runner_lease
        WHERE held.leased_runner_id = ? AND held.status = 'running' AND held.lease_expires_at > ?)`,
    params: [worker.runnerId, worker.runnerId, now],
  };
}

export function claimedInputWrite(
  db: RelationalStore, scope: ReadScope, runId: string, dispatchedBy: string, input: ClaimedInput,
): Bound {
  return claimInputWrite.bind(input.instruction, JSON.stringify({ ...input.context, input_hash: input.inputHash, counts: input.counts, checkout: input.repository ?? null, preparationTimeoutMs: input.repository === undefined ? 0 : REPOSITORY_PREPARATION_TIMEOUT_MS }), scope.projectId, runId, dispatchedBy);
}

export async function markRecordedLaunch(db: RelationalStore, runId: string): Promise<void> {
  (await commit(db, recordLaunchWrite.bind(runId)))[0];
}

export async function getDispatchActor(db: RelationalStore, scope: ReadScope, runId: string): Promise<string | null> {
  const row = ((await readSet(db, dispatchActorRead.bind(scope.projectId, runId)))[0][0] ?? null);
  return row?.actor ?? null;
}

export async function lastTaskEntryAt(db: RelationalStore, scope: ReadScope, task: string, actor?: string): Promise<number | null> {
  const queries = actor === undefined
    ? [lastTaskEntries[0]!.bind(scope.projectId, task), lastTaskEntries[1]!.bind(scope.projectId, task, skipContext(INPUT_UNCHANGED))]
    : [...new Set([actor, UNATTRIBUTED_DISPATCH_ACTOR])].map(held => actorTaskEntry.bind(scope.projectId, task, held));
  const times = await Promise.all(queries.map(async query => (await readSet(db, query))[0][0]?.at ?? null));
  const entries = times.filter((at): at is number => at !== null);
  return entries.length === 0 ? null : Math.max(...entries);
}

export function lastTaskEntryQueries(
  scope: ReadScope,
  task: string,
  actor?: string,
  columns?: { project: string; task: string },
): Array<{ sql: string; binds: unknown[] }> {
  const project = columns?.project ?? '?',
    taskColumn = columns?.task ?? '?';
  const identity = columns === undefined ? [scope.projectId, task] : [];
  if (actor !== undefined)
    return [...new Set([actor, UNATTRIBUTED_DISPATCH_ACTOR])].map((held) => ({
      sql: `SELECT COALESCE(queued_at, started_at) AS at FROM agent_runs INDEXED BY idx_agent_runs_schedule_entry
      WHERE project_id=${project} AND task=${taskColumn} AND ${SCHEDULE_ENTRY_SQL} AND ${SCHEDULE_ACTOR_SQL}=?
      ORDER BY COALESCE(queued_at,started_at) DESC LIMIT 1`,
      binds: [...identity, held],
    }));
  return [
    { predicate: "status != 'skipped'", values: [] },
    { predicate: "status = 'skipped' AND run_context = ?", values: [skipContext(INPUT_UNCHANGED)] },
  ].map(({ predicate, values }) => ({
    sql: `SELECT COALESCE(queued_at, started_at) AS at FROM agent_runs
      WHERE project_id = ${project} AND task = ${taskColumn} AND ${predicate} ${ACTOR_FILTER_SQL}
      ORDER BY COALESCE(queued_at, started_at) DESC LIMIT 1`,
    binds: [...identity, ...values, ...actorParams(actor)],
  }));
}

export async function deploymentTaskEntriesSince(db: RelationalStore, task: string, sinceMs: number, actor: string, projectId?: string): Promise<number> {
  const row = ((await readSet(db, taskEntriesRead.bind(task, sinceMs, actor, projectId ?? null, projectId ?? null)))[0][0] ?? null);
  return row?.c ?? 0;
}

export async function deploymentTaskCeilingWindow(db: RelationalStore, task: string, sinceMs: number, actor: string, perDay: number): Promise<{ used: number; pivotAt: number | null }> {
  const row = ((await readSet(db, ceilingWindowRead.bind(task, sinceMs, actor, Math.max(0, perDay))))[0][0] ?? null);
  const used = row?.used ?? 0;
  return { used, pivotAt: perDay > 0 && used >= perDay ? row?.pivot ?? null : null };
}

export async function deploymentLastTaskEntryAt(db: RelationalStore, task: string, actor: string): Promise<number | null> {
  const row = ((await readSet(db, lastDeploymentEntryRead.bind(task, actor)))[0][0] ?? null);
  return row?.at ?? null;
}

export async function deploymentLatestTaskRun(db: RelationalStore, task: string, sinceMs: number): Promise<{ status: string; error: string | null; at: number } | null> {
  const [rows] = await readSet(db, latestTaskRunRead.bind(task, sinceMs));
  return rows[0] ?? null;
}

export async function deploymentTaskRunTally(db: RelationalStore, task: string, sinceMs: number, actor: string): Promise<{ inFlight: number; completed: number; failed: number }> {
  const row = ((await readSet(db, taskTallyRead.bind(task, sinceMs, actor)))[0][0] ?? null);
  return row ?? { inFlight: 0, completed: 0, failed: 0 };
}

export function taskEntriesSql(project = '?', task = '?', actor?: string): string {
  return `SELECT COUNT(*) AS c FROM agent_runs ${actor === undefined ? '' : 'INDEXED BY idx_agent_runs_schedule_entry'} WHERE project_id = ${project} AND task = ${task} AND status != 'skipped'
    AND COALESCE(${contextValue('replaced')},0)!=1 AND COALESCE(queued_at,started_at)>=? ${actor === undefined ? '' : `AND ${SCHEDULE_ACTOR_SQL} IN (?, '')`}`;
}

export async function taskEntriesSince(db: RelationalStore, scope: ReadScope, task: string, sinceMs: number, actor?: string): Promise<number> {
  const row = ((await readSet(db, projectTaskEntries[Number(actor !== undefined)]!.bind(scope.projectId, task, sinceMs, ...(actor === undefined ? [] : [actor]))))[0][0] ?? null);
  return row?.c ?? 0;
}

export async function markRunReplaced(db: RelationalStore, scope: ReadScope, runId: string): Promise<boolean> {
  const result = (await commit(db, replaceRunWrite.bind(scope.projectId, runId)))[0];
  return result.results.length === 1;
}

export async function hasSuccessorOf(db: RelationalStore, scope: ReadScope, runId: string): Promise<boolean> {
  return (((await readSet(db, successorRead.bind(scope.projectId, runId)))[0][0] ?? null)) !== null;
}

export async function successorsSince(db: RelationalStore, scope: ReadScope, task: string, sinceMs: number): Promise<number> {
  const row = ((await readSet(db, successorsRead.bind(scope.projectId, task, sinceMs)))[0][0] ?? null);
  return row?.c ?? 0;
}

export async function hasLiveTaskRunAnywhere(db: RelationalStore, task: string): Promise<boolean> {
  return (((await readSet(db, liveTaskAnywhereRead.bind(task)))[0][0] ?? null)) !== null;
}

export async function hasLiveTaskRun(db: RelationalStore, scope: ReadScope, task: string): Promise<boolean> {
  return (((await readSet(db, liveTaskRead.bind(scope.projectId, task)))[0][0] ?? null)) !== null;
}

export async function recordSkipped(db: RelationalStore, scope: ReadScope, record: { id: string; agentId: string; task: string; reason: string; at: number }): Promise<void> {
  (await commit(db, skippedRunWrite.bind(scope.projectId, record.id, record.agentId, record.task, record.at, record.at, skipContext(record.reason), scope.projectId, record.id)))[0];
}

const recordDispatchWrite = write<readonly unknown[], { id: string }>({ name: 'runs.recordDispatchWrite', sql: RECORD_DISPATCH_SQL });
const runReferenceRead = read<readonly unknown[], RunningRunRef>({ name: 'runs.runReferenceRead', sql: RUN_REF_SQL });
const dispatchedClaims = [false, true].map(called => write<readonly unknown[], { id: string }>({
  name: `runs.dispatchedClaim${called ? 'Caller' : 'Direct'}`, sql: CLAIM_DISPATCHED_SQL
    + runCallerGuard(called ? {tokenId:'',deadline:0,now:0} : undefined, UNCLAIMED_RUN_STATUSES).sql + PROJECT_ADMISSION_WHERE + ' RETURNING id' }));
const directClaimWrite = write<readonly unknown[], { id: string }>({ name: 'runs.directClaimWrite', sql: CLAIM_SQL + PROJECT_ADMISSION_WHERE + ' RETURNING id' });
const runningTaskRead = read<readonly unknown[], RunningRunRef>({ name: 'runs.runningTaskRead', sql: RUNNING_SQL });
const agentIdentityWrite = write<readonly unknown[], { id: string }>({ name: 'runs.agentIdentityWrite', sql: `INSERT INTO agents (id, name, provider, model, source, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'built-in', ?, ?, ?)
      ON CONFLICT (id) DO NOTHING` });
const insideBoundRead = read<readonly unknown[], { one: number }>({ name: 'runs.insideBoundRead', sql: RUN_INSIDE_BOUND_SQL });
const queueRecordWrite = write<readonly unknown[], { id: string }>({ name: 'runs.queueRecordWrite', sql: RECORD_QUEUED_SQL });
const launchQueuedWrite = write<readonly unknown[], { id: string }>({ name: 'runs.launchQueuedWrite', sql: LAUNCH_QUEUED_SQL });
const returnQueuedWrite = write<readonly unknown[], { id: string }>({ name: 'runs.returnQueuedWrite', sql: RETURN_TO_QUEUE_SQL });
const dispatchCredentialWrite = write<readonly unknown[], { id: string }>({ name: 'runs.dispatchCredentialWrite', sql: `UPDATE agent_runs SET dispatched_by = ? WHERE project_id = ? AND id = ? AND status = 'pending' RETURNING id` });
const skipQueuedWrite = write<readonly unknown[], { displaced: string | null }>({ name: 'runs.skipQueuedWrite', sql: `UPDATE agent_runs SET status = 'skipped', completed_at = ?, run_context = ?, held_by = NULL, dispatch_spec = NULL
       WHERE project_id = ? AND id = ? AND status = 'queued'
     RETURNING dispatched_by AS displaced` });
const claimInputWrite = write<readonly unknown[], { id: string }>({ name: 'runs.claimInputWrite', sql: `UPDATE agent_runs SET instruction = ?, run_context = json_patch(COALESCE(run_context, '{}'), ?) WHERE project_id = ? AND id = ? AND status = 'running' AND dispatched_by = ?` });
const recordLaunchWrite = write<readonly unknown[], { id: string }>({ name: 'runs.recordLaunchWrite', sql: `UPDATE agent_runs SET harness = 'record' WHERE id = ?` });
const dispatchActorRead = read<readonly unknown[], { actor: string | null }>({ name: 'runs.dispatchActorRead', sql: `SELECT ${DISPATCH_ACTOR_SQL} AS actor FROM agent_runs WHERE project_id = ? AND id = ?` });
const lastTaskEntries = ["status != 'skipped'", "status = 'skipped' AND run_context = ?"].map((predicate, i) =>
  read<readonly unknown[], { at: number }>({ name: `runs.lastTaskEntry${i === 0 ? 'Started' : 'Unchanged'}`, sql:
    `SELECT COALESCE(queued_at, started_at) AS at FROM agent_runs WHERE project_id=? AND task=? AND ${predicate}
      ORDER BY COALESCE(queued_at,started_at) DESC LIMIT 1` }));
const actorTaskEntry = read<[string,string,string], { at:number }>({ name:'runs.lastActorTaskEntry', sql:
  `SELECT COALESCE(queued_at, started_at) AS at FROM agent_runs INDEXED BY idx_agent_runs_schedule_entry
    WHERE project_id=? AND task=? AND ${SCHEDULE_ENTRY_SQL} AND ${SCHEDULE_ACTOR_SQL}=?
    ORDER BY COALESCE(queued_at,started_at) DESC LIMIT 1` });
const taskEntriesRead = read<readonly unknown[], { c: number }>({ name: 'runs.taskEntriesRead', sql: `SELECT COUNT(*) AS c FROM agent_runs WHERE ${ACTOR_ENTRY_SQL} AND ${ACTOR_PROJECT_SQL}` });
const ceilingWindowRead = read<readonly unknown[], { used: number; pivot: number | null }>({ name: 'runs.ceilingWindowRead', sql: `SELECT COUNT(*) AS used, MIN(at) AS pivot FROM (SELECT COALESCE(queued_at, started_at) AS at FROM agent_runs
      WHERE ${ACTOR_ENTRY_SQL} ORDER BY at DESC LIMIT ?)` });
const lastDeploymentEntryRead = read<readonly unknown[], { at: number | null }>({ name: 'runs.lastDeploymentEntryRead', sql: `SELECT MAX(COALESCE(queued_at, started_at)) AS at FROM agent_runs WHERE task = ? AND status != 'skipped' AND ${DISPATCH_ACTOR_SQL} = ?` });
const latestTaskRunRead = read<readonly unknown[], { status: string; error: string | null; at: number }>({ name: 'runs.latestTaskRunRead', sql: `SELECT status, error, COALESCE(queued_at, started_at) AS at FROM agent_runs
      WHERE task = ? AND status != 'skipped' AND COALESCE(queued_at, started_at) >= ? ORDER BY at DESC LIMIT 1` });
const taskTallyRead = read<readonly unknown[], { inFlight: number; completed: number; failed: number }>({ name: 'runs.taskTallyRead', sql: `SELECT COALESCE(SUM(CASE WHEN ${IN_FLIGHT_RUN_STATUSES} THEN 1 ELSE 0 END), 0) AS inFlight,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM agent_runs WHERE task = ? AND COALESCE(queued_at, started_at) >= ? AND ${DISPATCH_ACTOR_SQL} = ?` });
const projectTaskEntries = [false,true].map(actor => read<readonly unknown[], { c: number }>({
  name: `runs.projectTaskEntries${actor ? 'Actor' : 'All'}`, sql: taskEntriesSql('?','?',actor ? '' : undefined) }));
const replaceRunWrite = write<readonly unknown[], { id: string }>({ name: 'runs.replaceRunWrite', sql: `UPDATE agent_runs SET run_context = json_set(COALESCE(run_context, '{}'), '$.replaced', json('true'))
      WHERE project_id = ? AND id = ?
        AND (run_context IS NULL OR json_type(CASE WHEN json_valid(run_context) THEN run_context END) = 'object') RETURNING id` });
const successorRead = read<readonly unknown[], { one: number }>({ name: 'runs.successorRead', sql: `SELECT 1 AS one FROM agent_runs WHERE project_id = ? AND ${contextValue('replaces')} = ? LIMIT 1` });
const successorsRead = read<readonly unknown[], { c: number }>({ name: 'runs.successorsRead', sql: `SELECT COUNT(*) AS c FROM agent_runs WHERE project_id = ? AND task = ?
       AND ${contextValue('replaces')} IS NOT NULL
       AND COALESCE(queued_at, started_at) >= ?` });
const liveTaskAnywhereRead = read<readonly unknown[], { one: number }>({ name: 'runs.liveTaskAnywhereRead', sql: `SELECT 1 AS one FROM agent_runs WHERE ${IN_FLIGHT_RUN_STATUSES} AND task = ? LIMIT 1` });
const liveTaskRead = read<readonly unknown[], { one: number }>({ name: 'runs.liveTaskRead', sql: `SELECT 1 AS one FROM agent_runs WHERE project_id = ? AND task = ? AND ${IN_FLIGHT_RUN_STATUSES} LIMIT 1` });
const skippedRunWrite = write<readonly unknown[], { id: string }>({ name: 'runs.skippedRunWrite', sql: `INSERT INTO agent_runs (project_id, id, agent_id, task, status, dry_run, started_at, completed_at, run_context)
       SELECT ?, ?, ?, ?, 'skipped', 0, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)` });

export function ensureAgentStatement(...args: Parameters<typeof ensureAgentWrite>): PreparedStatement { return prepareBound(args[0], ensureAgentWrite(...args)); }

export function claimedInputStatement(...args: Parameters<typeof claimedInputWrite>): PreparedStatement { return prepareBound(args[0], claimedInputWrite(...args)); }

/** The guarded source write and every named assertion settle with the claim companions. */
export async function commitWorkerClaim(db: RelationalStore, setup: readonly Bound[],
  claim: Bound<ClaimedRunRow, 'write'>, companions: Bound[], guards: readonly Bound[] = []): Promise<ClaimedRunRow | undefined> {
  try {
    const results = await commit(db, ...guards, ...setup, claim, ...companions);
    return (results[setup.length + guards.length]!.results as ClaimedRunRow[])[0];
  } catch (error) {
    if (error instanceof Error && error.message.includes('claim_selection_refused')) return undefined;
    return runnerWriteRefusal(error);
  }
}
const quietSql = 'EXISTS (SELECT 1 FROM learning_sessions WHERE project_id = ? AND session_id = ? AND quiet_at <= ?)';
const quietSession = (input: ClaimedInput | undefined): string | null => {
  const context = input?.context, assignment = context?.assignment;
  return typeof context?.session_id === 'string' && assignment !== null && typeof assignment === 'object'
    && 'kind' in assignment && ['cards','learning'].includes(String(assignment.kind)) ? context.session_id : null;
};
const budgetVariants = ['none','inactive','active','observed'] as const;
const dummyCandidate: ClaimCandidate = { projectId:'',id:'',task:'',instruction:null,dispatchSpec:null };
const dummyPull: PulledCandidate = { ...dummyCandidate,subject:'',input:{instruction:'',inputHash:'',counts:{}},assertions:[] };
const claimDefinitions = Object.fromEntries(budgetVariants.flatMap(budgetKind => [false,true].flatMap(pulled =>
  [false,true].flatMap(runner => [false,true].flatMap(quiet => [false,true].map(settings => {
    const admission: WriteAdmission = {limits:NO_LIMITS,now:0,
      ...(budgetKind === 'none' ? {} : {budget:{active:budgetKind!=='inactive',estimate:0,profileJson:'',...(budgetKind==='observed'?{stateKey:''}:{})}}),
      ...(settings ? {settingsGuard:{}} : {})};
    const selection = pulled ? pulledClaimPredicate(dummyPull,admission) : workerClaimPredicate(dummyCandidate,admission);
    const gate = runnerClaimGate(runner ? {kind:'runner',runnerId:'',credentialId:'',machineId:null} : {kind:'member',tokenId:'',machineId:''},0);
    const authority = `(${selection.sql}) AND (${quiet ? quietSql : '1'}) AND (${gate.sql})`;
    const name = `${pulled ? 'pulled' : 'queued'}${budgetKind}${runner ? 'Runner' : 'Member'}${quiet ? 'Quiet' : 'Any'}${settings ? 'Observed' : 'Current'}`;
    return [name,{guard:assertion<readonly unknown[]>({name:`runs.${name}Admission`,sql:`SELECT CASE WHEN ${authority} THEN 1 ELSE json_extract('[]','$[claim_selection_refused]') END`}),credential:write<readonly unknown[]>({name:`runs.${name}Credential`,sql:CREDENTIAL_INSERT_SQL+` AND ${authority} RETURNING id`}),run:write<readonly unknown[],ClaimedRunRow>({name:`runs.${name}`,sql: pulled ?
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, origin, subject, dispatch_spec, started_at, dispatched_by,
        leased_by,leased_runner_id,leased_runner_credential_id,lease_expires_at,harness,reasoning_level,model,execution_overrides)
      SELECT ?,?,'myco-agent',?,'running','automatic',?,?,?,?,?,?,?,?,?,?,?,? WHERE ${authority}
      RETURNING project_id AS projectId,id,task,instruction,run_context AS runContext,dry_run AS dryRun` :
      `UPDATE agent_runs
        SET status = 'running', started_at = ?, dispatched_by = ?, leased_by = ?, leased_runner_id = ?, leased_runner_credential_id = ?,
        lease_expires_at=?,harness=?,held_by=NULL,reasoning_level=?,model=?,execution_overrides=?,subject=COALESCE(?,subject)
      WHERE project_id=? AND id=? AND ${authority}
        AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM agent_runs flight INDEXED BY idx_agent_runs_task_live
          WHERE flight.task=agent_runs.task AND flight.${IN_FLIGHT_RUN_STATUSES} AND flight.subject=? AND flight.id!=agent_runs.id))
      RETURNING project_id AS projectId,id,task,instruction,run_context AS runContext,dry_run AS dryRun`})}];
  }))))));

function claimBinding(form: ClaimForm, claim: WorkerClaim, admission: WriteAdmission) {
  const candidate = form.kind === 'queued' ? form.candidate : form.pull;
  const selection = form.kind === 'queued' ? workerClaimPredicate(form.candidate,admission) : pulledClaimPredicate(form.pull,admission);
  const quiet = quietSession(claim.input), gate = runnerClaimGate(claim.worker,claim.now);
  const budget = admission.budget;
  const budgetKind = budget === undefined ? 'none' : !budget.active ? 'inactive' : budget.stateKey === undefined ? 'active' : 'observed';
  const name = `${form.kind}${budgetKind}${claim.worker.kind === 'runner' ? 'Runner' : 'Member'}${quiet === null ? 'Any' : 'Quiet'}${admission.settingsGuard === undefined ? 'Current' : 'Observed'}`;
  return {definition:claimDefinitions[name]!,candidate,
    authority:[...selection.params,...(quiet === null ? [] : [candidate.projectId,quiet,claim.now]),...gate.params]};
}

/** Select a declared claim variant; only observed values enter its bindings. */
export function workerClaimWrite(form: ClaimForm, claim: WorkerClaim, admission: WriteAdmission, dispatchedBy: string): Bound<ClaimedRunRow,'write'> {
  const {definition,candidate,authority}=claimBinding(form,claim,admission), owner=leaseOwnerColumns(claim.worker);
  const profile = [claim.profile.tier,claim.profile.model,JSON.stringify({requested:claim.profile,harness:claim.harness})];
  const subject = claim.input?.subject ?? null;
  return definition.run.bind(...(form.kind === 'pulled'
    ? [candidate.projectId,candidate.id,candidate.task,form.pull.subject,JSON.stringify({actor:'deployment'}),claim.now,dispatchedBy,
      owner.leasedBy,owner.runnerId,owner.runnerCredentialId,claim.leaseExpiresAt,claim.harness,...profile,...authority]
    : [claim.now,dispatchedBy,owner.leasedBy,owner.runnerId,owner.runnerCredentialId,claim.leaseExpiresAt,claim.harness,...profile,
      subject,candidate.projectId,candidate.id,...authority,subject,subject]));
}
export function workerCredentialGate(form: ClaimForm, claim: WorkerClaim, admission: WriteAdmission) {
  const {definition,authority}=claimBinding(form,claim,admission);
  return {write:definition.credential,values:authority};
}
const claimRunnerAuthority = assertion<[string, string]>({ name: 'runs.claimRunnerAuthority', sql:
  `SELECT CASE WHEN EXISTS(SELECT 1 FROM runner_credentials c WHERE c.id=? AND c.runner_id=?
    AND ${runnerCredentialAuthority('c', SQL_NOW_MS)}) THEN 1 ELSE json_extract('[]','${RUNNER_WRITE_REFUSED}') END` });

/** Authority and admission are asserted before any claim companion can commit. */
export function workerClaimAssertions(form: ClaimForm, claim: WorkerClaim, admission: WriteAdmission): Bound[] {
  const { definition, authority } = claimBinding(form, claim, admission);
  return [
    ...(claim.worker.kind === 'runner' ? [claimRunnerAuthority.bind(claim.worker.credentialId, claim.worker.runnerId)] : []),
    definition.guard.bind(...authority),
  ];
}

export const runnerAssignmentWrite = write<readonly unknown[], {id:string}>({name:'runs.runnerAssignmentWrite',sql:
  `UPDATE runners SET last_assigned_at=? WHERE id=? AND EXISTS(SELECT 1 FROM agent_runs
    WHERE project_id=? AND id=? AND leased_runner_id=runners.id AND dispatched_by=?)`});

export const ACTOR_MATCH_SQL = `(? IS NULL OR COALESCE(${DISPATCH_ACTOR_SQL}, ?) = ?)`;

const ACTOR_FILTER_SQL = `AND ${ACTOR_MATCH_SQL}`;
const actorParams = (actor?: string): Array<string | null> => [actor ?? null, actor ?? null, actor ?? null];
