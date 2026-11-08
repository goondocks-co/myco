import type { RelationalStore } from './adapters.js';
import { budgetActivation, BUDGET_ENABLED, type BudgetActivation } from '../db/budget-activation.js';
import { BUDGET_WINDOW_MS } from './budget-policy.js';
import { spendRowsSql, spentUsdSql as spentSql, spendReadySql, spendReady } from '../db/runs/admission.js';

export { effectiveBudgetSql } from './settings.js';
import { effectiveBudgetSql } from './settings.js';
export { spendRowsSql } from '../db/runs/admission.js';

/** Rolling spend in dollars at the floor slot, from the maintained totals: what every budget comparison reads. */
export const spentUsdSql = (floor: string): string => spentSql(floor);

export interface SpendRow {
  value: number; estimate: number; costSource: string | null; profileJson: string | null;
  projectId: string; task: string; origin: 'manual' | 'automatic'; attemptId: string; live: number;
}
/** The attempts counted at `now`: the window's settled facts and every live one. */
export async function readSpendRows(db: RelationalStore, now: number): Promise<SpendRow[]> {
  return (await db.prepare(`SELECT * FROM (${spendRowsSql('?')})`).bind(now-BUDGET_WINDOW_MS).all<SpendRow>()).results;
}

export interface ClaimBudget { active: boolean; estimate: number; profileJson: string; reserveUsd?: number; stateKey?: string; observedEstimate?: string | null }
/**
 * Automatic work is admitted only against caught-up accounting with room in the rolling window. The comparison reads
 * the Project/origin rollup rows and at most one page of due expiry rows, never attempt history.
 */
export function budgetClaimPredicate(budget: ClaimBudget, now: number): { sql: string; params: unknown[] } {
  if (!budget.active) return { sql: `(origin='manual')`, params: [] };
  return {
    sql: `(origin='manual' OR (EXISTS(SELECT 1 FROM schema_meta WHERE key='${BUDGET_ENABLED}') AND ${spendReadySql('?')} AND ${budget.stateKey===undefined?'1':`(SELECT value FROM agent_state WHERE project_id=agent_runs.project_id AND agent_id='myco-agent' AND key=?) IS ?`} AND ${spentUsdSql('?')} + ? <= ${effectiveBudgetSql()}))`,
    params: [now-BUDGET_WINDOW_MS,...(budget.stateKey===undefined?[]:[budget.stateKey,budget.observedEstimate ?? null]),now-BUDGET_WINDOW_MS,budget.estimate + (budget.reserveUsd ?? 0)],
  };
}

/** Automatic work requires an active governor, caught-up accounting and sufficient headroom. */
export async function automaticFits(db: RelationalStore, estimate: number, now: number, reserveUsd = 0, activation?: BudgetActivation): Promise<boolean> {
  if (!(activation ?? await budgetActivation(db)).active) return false;
  const predicate = budgetClaimPredicate({ active: true, estimate, reserveUsd, profileJson: '' }, now);
  return (await db.prepare(`SELECT 1 AS fits FROM (SELECT 'automatic' AS origin) WHERE ${predicate.sql}`).bind(...predicate.params).first()) !== null;
}

/** Why the governor holds a queued run: no room in the window, accounting still catching up, or nothing. */
export type BudgetHold = 'budget' | 'admission_building';
export async function budgetHold(db: RelationalStore, projectId: string, runId: string, estimate: number, now: number): Promise<BudgetHold | null> {
  const active = await budgetActivation(db);
  const predicate = budgetClaimPredicate({ active: active.active, estimate, profileJson: '' },now);
  const held = (await db.prepare(`SELECT 1 AS held FROM agent_runs WHERE project_id=? AND id=? AND status='queued' AND NOT (${predicate.sql})`)
    .bind(projectId,runId,...predicate.params).first()) !== null;
  if (!held) return null;
  return active.active && !(await spendReady(db, now)) ? 'admission_building' : 'budget';
}

export async function budgetHeld(db: RelationalStore, projectId: string, runId: string, estimate: number, now: number): Promise<boolean> {
  return (await budgetHold(db, projectId, runId, estimate, now)) !== null;
}
