import type { RelationalStore } from './adapters.js';
import { budgetActivation, BUDGET_ENABLED } from '../db/budget-activation.js';
import { runOriginSql } from '../db/run-context.js';
import { LIVE_RUN_STATUSES } from './runs.js';
import { BUDGET_DEFAULT_USD, BUDGET_LEAF, BUDGET_MINIMUM_USD, BUDGET_WINDOW_MS, stageSeedSql, workerTaskSql } from './budget-policy.js';

export { effectiveBudgetSql } from './settings.js';
import { effectiveBudgetSql } from './settings.js';

/** Each canonical accounting identity appears once, through its immutable attempt window or its live run. */
export function spendRowsSql(floor: string): string {
  const value = `COALESCE(a.cost_usd,a.estimate_usd,CASE WHEN r.status IN ('completed','failed','skipped') AND a.attempt_id=r.dispatched_by THEN r.cost_usd END,${stageSeedSql('r.task')})`;
  const columns = `${value} AS value,COALESCE(a.estimate_usd,${stageSeedSql('r.task')}) AS estimate,
    CASE WHEN a.cost_usd IS NOT NULL THEN COALESCE(a.cost_source,'actual') WHEN a.estimate_usd IS NULL AND r.status IN ('completed','failed','skipped') AND a.attempt_id=r.dispatched_by AND r.cost_usd IS NOT NULL THEN COALESCE(r.cost_source,'actual') ELSE a.cost_source END AS costSource,a.profile_json AS profileJson,r.project_id AS projectId,r.task,
    ${runOriginSql('r')} AS origin,a.attempt_id AS attemptId`;
  const join = 'r.project_id=a.project_id AND r.id=a.run_id';
  return `SELECT ${columns},0 AS live FROM agent_run_attempts a INDEXED BY idx_attempts_claimed
    JOIN agent_runs r ON ${join} WHERE a.claimed_at>${floor} AND ${workerTaskSql('r.task')}
    AND NOT (r.${LIVE_RUN_STATUSES} AND r.dispatched_by IS a.attempt_id)
    UNION ALL SELECT ${columns},1 AS live FROM agent_runs r INDEXED BY idx_agent_runs_task_live
    JOIN agent_run_attempts a ON ${join} AND a.attempt_id=r.dispatched_by
    WHERE ${workerTaskSql('r.task')} AND r.${LIVE_RUN_STATUSES}`;
}

export interface SpendRow {
  value: number; estimate: number; costSource: string | null; profileJson: string | null;
  projectId: string; task: string; origin: 'manual' | 'automatic'; attemptId: string; live: number;
}
export async function readSpendRows(db: RelationalStore, now: number): Promise<SpendRow[]> {
  return (await db.prepare(`SELECT * FROM (${spendRowsSql('?')})`).bind(now-BUDGET_WINDOW_MS).all<SpendRow>()).results;
}

export interface ClaimBudget { active: boolean; estimate: number; profileJson: string; stateKey?: string; observedEstimate?: string | null }
export function budgetClaimPredicate(budget: ClaimBudget, now: number): { sql: string; params: unknown[] } {
  if (!budget.active) return { sql: `(origin='manual' OR NOT EXISTS(SELECT 1 FROM schema_meta WHERE key='${BUDGET_ENABLED}'))`, params: [] };
  return {
    sql: `(origin='manual' OR (${budget.stateKey===undefined?'1':`(SELECT value FROM agent_state WHERE project_id=agent_runs.project_id AND agent_id='myco-agent' AND key=?) IS ?`} AND (SELECT COALESCE(SUM(value),0) FROM (${spendRowsSql('?')})) + ? <= ${effectiveBudgetSql()}))`,
    params: [...(budget.stateKey===undefined?[]:[budget.stateKey,budget.observedEstimate ?? null]),now-BUDGET_WINDOW_MS,budget.estimate],
  };
}

/** Whether an automatic item of this estimate fits the budget now; a governor that is not active admits it. */
export async function automaticFits(db: RelationalStore, estimate: number, now: number): Promise<boolean> {
  if (!(await budgetActivation(db)).active) return true;
  const predicate = budgetClaimPredicate({ active: true, estimate, profileJson: '' }, now);
  return (await db.prepare(`SELECT 1 AS fits FROM (SELECT 'automatic' AS origin) WHERE ${predicate.sql}`).bind(...predicate.params).first()) !== null;
}

export async function budgetHeld(db: RelationalStore, projectId: string, runId: string, estimate: number, now: number): Promise<boolean> {
  const active = await budgetActivation(db);
  if (!active.active) return false;
  const predicate = budgetClaimPredicate({ active: true, estimate, profileJson: '' },now);
  return (await db.prepare(`SELECT 1 AS held FROM agent_runs WHERE project_id=? AND id=? AND status='queued' AND NOT (${predicate.sql})`)
    .bind(projectId,runId,...predicate.params).first()) !== null;
}
