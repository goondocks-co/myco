import type { RelationalStore } from '../../core/adapters.js';
import type { ClaimCandidate, QueuedRunRef } from '../../core/runs.js';
import type { ReadScope } from '../../read/scope.js';
import { BUDGET_WORKER_TASKS } from '../../core/budget-policy.js';
import { PROFILE_HOLD_PREFIXES } from '@goondocks/myco-shared/run-holds';
import { commit, read, readSet, write } from '../index.js';
import { RUN_ADMISSION_READY_SQL } from './live.js';
import { runOriginSql, contextValue, BUDGET_QUOTE_USD_KEY, BUDGET_QUOTE_AT_KEY } from '../run-context.js';
import { BUDGET_ENABLED, BUDGET_QUEUE_OPENED_SQL, budgetActivation } from '../budget-activation.js';
import { effectiveBudgetSql } from '../../core/settings.js';
import type { BudgetHolds } from './budget.js';
import type { RunErrorCode } from '../../core/reader-codes.js';
import type { BindValue } from '../index.js';
import { budgetClaimPredicate, type ClaimBudget } from '../../core/run-budget.js';

/** Readiness is read from the projection and never stored on a run. */
export function storedQueueHold(holder: string): string | null {
  return holder === 'queue_building' ? null : holder;
}

/** Budget waits apply only to automatic work; manual work shares the task's capacity holds. */
export const taskHoldSql = (hold: string, origin: string) => `CASE WHEN ${origin}='manual' AND ${hold} IN ('budget','admission_building') THEN NULL ELSE ${hold} END`;

/** One task/origin's first eligible identity; the row's payload is fetched only after the seek. */
export const queueHeadSeek = (columns: string, task: string, origin: string): string => `SELECT ${columns} FROM agent_runs
  WHERE (project_id,id)=(SELECT project_id,run_id FROM task_due WHERE task=${task} AND origin=${origin} AND claimable=1 ORDER BY queued_at,run_id,project_id LIMIT 1)`;
const anyQueued = read<[], { queued: number }>({ name: 'runs.unclaimedQueued', sql:
  'SELECT EXISTS(SELECT 1 FROM task_due WHERE claimable=1) AS queued' });
export async function unclaimedQueued(db: RelationalStore): Promise<boolean> {
  const [rows] = await readSet(db, anyQueued.bind());
  return rows[0]!.queued === 1;
}
const heads = read<[string], ClaimCandidate & { queuedAt: number }>({ name: 'runs.queueHeads', sql: `SELECT r.project_id AS projectId,r.id,r.task,r.instruction,r.dispatch_spec AS dispatchSpec,r.queued_at AS queuedAt
  FROM json_each(?1) tasks CROSS JOIN json_each('["manual","automatic"]') origins
  JOIN agent_runs r ON (r.project_id,r.id)=(SELECT d.project_id,d.run_id FROM task_due d
    WHERE d.task=tasks.value AND d.origin=origins.value AND d.claimable=1 ORDER BY d.queued_at,d.run_id,d.project_id LIMIT 1)
  ORDER BY r.queued_at,r.id,r.project_id` });
export async function queueHeads(db: RelationalStore, excluded: readonly string[]): Promise<ClaimCandidate[]> {
  const [rows] = await readSet(db, heads.bind(JSON.stringify(BUDGET_WORKER_TASKS.filter(task => !excluded.includes(task)))));
  return rows;
}

const candidateBudget = [false, true].map(active => [false, true].map(observed => {
  const predicate = budgetClaimPredicate({ active, estimate: 0, profileJson: '', ...(observed ? { stateKey: '' } : {}) }, 0);
  return read<BindValue[], { id: string }>({ name: `runs.queueBudget${Number(active)}${Number(observed)}`,
    sql: `SELECT id FROM agent_runs WHERE project_id=? AND id=? AND status='queued' AND ${predicate.sql}` });
}));
/** Fixed task heads are checked against the caller's fenced budget inputs, without sweeping the queue. */
export async function nextClaimable(db: RelationalStore, excluded: readonly string[], budget?: ClaimBudget, now = Date.now()): Promise<ClaimCandidate | null> {
  for (const candidate of await queueHeads(db, excluded)) {
    if (budget === undefined) return candidate;
    const predicate = budgetClaimPredicate(budget, now);
    const [rows] = await readSet(db, candidateBudget[Number(budget.active)]![Number(budget.stateKey !== undefined)]!
      .bind(candidate.projectId, candidate.id, ...predicate.params.map(value => {
        if (value === null || typeof value === 'string' || typeof value === 'number') return value;
        throw new Error('Queued-run budget bindings must be strings, numbers or null');
      })));
    if (rows.length > 0) return candidate;
  }
  return null;
}

export interface QueuedWait { reason: string | null; since: number | null; task: string; taskQueued: number | null }
const waits = read<[string, string], QueuedWait & { runKey: string }>({ name: 'runs.queuedWaits', sql: `SELECT keys.value AS runKey,
  CASE WHEN ${RUN_ADMISSION_READY_SQL} THEN ${taskHoldSql('h.hold_reason', runOriginSql('r'))} ELSE 'queue_building' END AS reason,
  h.hold_since AS since,COALESCE(r.task,'') AS task,
  CASE WHEN ${RUN_ADMISSION_READY_SQL} THEN (SELECT SUM(t.queued_count) FROM task_runtime t WHERE t.project_id=r.project_id AND t.task=COALESCE(r.task,'')) ELSE NULL END AS taskQueued
  FROM json_each(?2) keys JOIN agent_runs r ON r.project_id=?1 AND r.id=keys.value AND r.status='queued'
  LEFT JOIN task_runtime h ON h.project_id=r.project_id AND h.task=COALESCE(r.task,'') AND h.origin=${runOriginSql('r')}` });
/** One Project-scoped statement over all requested canonical run keys. */
export async function queuedWaits(db: RelationalStore, scope: ReadScope, runKeys: readonly string[]): Promise<Map<string, QueuedWait>> {
  const [rows] = await readSet(db, waits.bind(scope.projectId, JSON.stringify(runKeys)));
  return new Map(rows.map(({ runKey, ...wait }) => [runKey, wait]));
}

const taskHolder = write<[string, string, string, number, string]>({ name: 'runs.taskHolder', sql: `UPDATE agent_runs SET held_by=?3
  WHERE (project_id,id) IN (SELECT project_id,oldest_run_id FROM task_runtime
    WHERE task IN (SELECT value FROM json_each(?1)) AND queued_count>0 AND hold_reason IS NOT ?3
      AND (EXISTS(SELECT 1 FROM json_each(?2) f WHERE f.value IS hold_reason)
        OR (?4=1 AND EXISTS(SELECT 1 FROM json_each(?5) p WHERE substr(hold_reason,1,length(p.value))=p.value)))
      AND (?3 NOT IN ('budget','admission_building') OR origin='automatic')) AND held_by IS NOT ?3` });
export async function recordTaskHolder(db: RelationalStore, tasks: readonly string[], from: readonly (string | null)[], holder: string, includeProfileHolds = false): Promise<void> {
  if (!tasks.length || !from.length || storedQueueHold(holder) === null) return;
  await commit(db, taskHolder.bind(JSON.stringify([...new Set(tasks)]), JSON.stringify(from), holder, Number(includeProfileHolds), JSON.stringify(PROFILE_HOLD_PREFIXES)));
}

export const RUN_CONTEXT_OBJECT_SQL = `CASE
  WHEN run_context IS NULL THEN '{}'
  WHEN json_valid(run_context) THEN CASE WHEN json_type(run_context) = 'object' THEN run_context ELSE json_object('unparsedRunContext', run_context) END
  ELSE json_object('unparsedRunContext', run_context) END`;

const queueHolder = write<[string, number | null, number | null, string, string]>({ name: 'runs.queueHolder', sql: `UPDATE agent_runs SET held_by=?1,
  run_context=CASE WHEN ?2 IS NULL THEN run_context ELSE json_set(${RUN_CONTEXT_OBJECT_SQL},'$.${BUDGET_QUOTE_USD_KEY}',?2,'$.${BUDGET_QUOTE_AT_KEY}',?3) END
  WHERE project_id=?4 AND id=?5 AND status='queued' AND (?1 NOT IN ('budget','admission_building') OR ${runOriginSql()}='automatic')
    AND (held_by IS NOT ?1 OR (?2 IS NOT NULL AND (${contextValue(BUDGET_QUOTE_USD_KEY)} IS NOT ?2 OR ${contextValue(BUDGET_QUOTE_AT_KEY)} IS NOT ?3)))` });
/** A quote belongs to its run; the current waiting reason belongs to its task head. */
export async function recordQueueHolder(db: RelationalStore, scope: ReadScope, runId: string, heldBy: string, quote?: { usd: number; at: number }): Promise<void> {
  if (quote !== undefined && (heldBy !== 'budget' || !Number.isFinite(quote.usd) || quote.usd < 0 || !Number.isSafeInteger(quote.at))) throw new Error('Invalid queued budget quote');
  if (storedQueueHold(heldBy) === null) return;
  await commit(db, queueHolder.bind(heldBy, quote?.usd ?? null, quote?.at ?? null, scope.projectId, runId));
}

const budgetLeaf = read<[], { budget: number }>({ name: 'runs.taskBudgetLimit', sql: `SELECT ${effectiveBudgetSql()} AS budget` });
const budgetHeads = read<[], { projectId: string; runId: string; task: string; requiredUsd: unknown; quotedAt: unknown }>({
  name: 'runs.taskBudgetHeads', sql: `SELECT h.project_id AS projectId,h.oldest_run_id AS runId,h.task,
    ${contextValue(BUDGET_QUOTE_USD_KEY)} AS requiredUsd,${contextValue(BUDGET_QUOTE_AT_KEY)} AS quotedAt
    FROM task_runtime h JOIN agent_runs r ON r.project_id=h.project_id AND r.id=h.oldest_run_id
    WHERE h.queued_count>0 AND ${taskHoldSql('h.hold_reason', 'h.origin')}='budget'`,
});
export async function readTaskBudgetHolds(db: RelationalStore): Promise<BudgetHolds> {
  const activation = await budgetActivation(db);
  const [limits, heads] = await readSet(db, budgetLeaf.bind(), budgetHeads.bind());
  const dailyUsd = limits[0]!.budget;
  return { ...activation, dailyUsd, heldHeads: activation.active ? heads.map(head => {
    const requiredUsd = typeof head.requiredUsd === 'number' && Number.isFinite(head.requiredUsd) && head.requiredUsd >= 0 ? head.requiredUsd : null;
    const quotedAt = typeof head.quotedAt === 'number' && Number.isSafeInteger(head.quotedAt) ? head.quotedAt : null;
    return { ...head, requiredUsd, quotedAt, reason: requiredUsd !== null && requiredUsd > dailyUsd ? 'budget_too_small' : 'budget' };
  }) : null };
}

const queuedRuns = read<[string, number], QueuedRunRef>({ name: 'runs.queuedAcrossProjects', sql: `SELECT r.project_id AS projectId,r.id,r.task,r.queued_at AS queuedAt,
  ${taskHoldSql('d.source_hold', 'd.origin')} AS heldBy,r.dispatch_spec AS dispatchSpec,r.dispatched_by AS dispatchedBy,d.origin,${contextValue(BUDGET_QUOTE_USD_KEY)} AS budgetQuoteUsd
  FROM task_due d JOIN agent_runs r ON r.project_id=d.project_id AND r.id=d.run_id
  WHERE d.origin<>'automatic' OR r.task IS NULL OR d.task NOT IN (SELECT value FROM json_each(?1))
  ORDER BY d.queued_at,d.run_id,d.project_id LIMIT ?2` });
export async function listQueuedAcrossProjects(db: RelationalStore, limit: number, excludeAutomaticTasks: readonly string[] = []): Promise<QueuedRunRef[]> {
  const [rows] = await readSet(db, queuedRuns.bind(JSON.stringify(excludeAutomaticTasks), limit));
  return rows;
}
const hasQueued = read<[string], { one: number }>({ name: 'runs.hasQueued', sql: `SELECT 1 AS one FROM task_runtime WHERE queued_count>0
  AND (?1='any' OR (?1='budget' AND ${taskHoldSql('hold_reason', 'origin')}='budget') OR (?1='other' AND ${taskHoldSql('hold_reason', 'origin')} IS NOT 'budget')) LIMIT 1` });
export async function hasQueuedRun(db: RelationalStore, holder: 'any' | 'budget' | 'other' = 'any'): Promise<boolean> {
  const [rows] = await readSet(db, hasQueued.bind(holder));
  return rows.length > 0;
}

export interface QueueFailureGuard { heldBy: string | null; queuedAt: number; automatic: boolean; openedAt: string | null; quote?: number }
const failures = [false,true].map(guarded => [false,true].map(automatic => [false,true].map(quoted =>
  write<readonly unknown[], { displaced: string | null }>({ name: `runs.failQueued${guarded ? 'Observed' : 'Identity'}${automatic ? 'Automatic' : 'Manual'}${quoted ? 'Quote' : 'Age'}`,
    sql: `UPDATE agent_runs SET status='failed',completed_at=?,error=?,error_code=?,held_by=NULL
      WHERE project_id=? AND id=? AND status='queued'
      ${guarded ? `AND ${taskHoldSql('held_by', runOriginSql())} IS ? AND queued_at IS ?
        ${automatic ? `AND EXISTS(SELECT 1 FROM schema_meta WHERE key='${BUDGET_ENABLED}') AND ${BUDGET_QUEUE_OPENED_SQL} IS ?` : ''}
        ${quoted ? `AND ${contextValue(BUDGET_QUOTE_USD_KEY)} IS ? AND ${contextValue(BUDGET_QUOTE_USD_KEY)}>${effectiveBudgetSql()}` : ''}` : ''}
      RETURNING dispatched_by AS displaced` }))));
/** Expiry observes the run's own hold, queue instant and budget quote in the same write. */
export async function failQueuedRun(db: RelationalStore, scope: ReadScope, runId: string, now: number, error: string, errorCode: RunErrorCode,
  guard?: QueueFailureGuard) {
  const statement = failures[Number(guard !== undefined)]![Number(guard?.automatic === true)]![Number(guard?.quote !== undefined)]!;
  const [rows] = await commit(db, statement.bind(now,error,errorCode,scope.projectId,runId,
    ...(guard === undefined ? [] : [guard.heldBy,guard.queuedAt,...(guard.automatic ? [guard.openedAt] : []),...(guard.quote === undefined ? [] : [guard.quote])])));
  return { applied: rows.results.length === 1, displaced: rows.results[0]?.displaced ?? null };
}

const queuedExists = read<[string | null], { one: number }>({ name: 'runs.queuedWorkExists', sql: `SELECT 1 AS one
  FROM agent_runs r INDEXED BY idx_agent_runs_claimable WHERE r.status='queued'
    AND (?1 IS NULL AND EXISTS(SELECT 1 FROM projects p WHERE p.project_id=r.project_id AND p.archived_at IS NULL) OR r.project_id=?1) LIMIT 1` });
export async function queuedWorkExists(db: RelationalStore, scope: { projectId: string } | { all: true }): Promise<boolean> {
  const [rows] = await readSet(db, queuedExists.bind('projectId' in scope ? scope.projectId : null));
  return rows.length > 0;
}
