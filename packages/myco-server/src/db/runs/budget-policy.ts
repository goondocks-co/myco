import type { RelationalStore } from '../../core/adapters.js';
import { budgetActivation, BUDGET_ENABLED, type BudgetActivation } from '../budget-activation.js';
import { BUDGET_WINDOW_MS } from '../../core/budget-policy.js';
import { spentUsdSql as spentSql, spendReadySql } from './admission.js';

export { effectiveBudgetSql } from '../../core/settings.js';
import { effectiveBudgetSql } from '../../core/settings.js';
import { RUN_ADMISSION_READY_SQL } from './live.js';
import { read, readSet } from '../index.js';

/** Rolling spend in dollars at the floor slot, from the maintained totals: what every budget comparison reads. */
export const spentUsdSql = (floor: string): string => spentSql(floor);

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
const automaticFit = read<[number, number], { fits: number }>({ name: 'runs.automaticFit', sql: `SELECT
  EXISTS(SELECT 1 FROM schema_meta WHERE key='${BUDGET_ENABLED}') AND ${spendReadySql('?1')} AND ${spentUsdSql('?1')} + ?2 <= ${effectiveBudgetSql()} AS fits` });
export async function automaticFits(db: RelationalStore, estimate: number, now: number, reserveUsd = 0, activation?: BudgetActivation): Promise<boolean> {
  if (!(activation ?? await budgetActivation(db)).active) return false;
  const [[row]] = await readSet(db, automaticFit.bind(now-BUDGET_WINDOW_MS, estimate + reserveUsd));
  return row?.fits === 1;
}

/** Why the governor holds a queued run: no room in the window, accounting still catching up, or nothing. */
export type BudgetHold = 'budget' | 'admission_building';
const quotedHold = read<[string, string, number, number, number], { reason: BudgetHold | null }>({
  name: 'runs.quotedBudgetHold', sql: `SELECT CASE WHEN r.origin='manual' THEN NULL
    WHEN ?5=0 OR NOT EXISTS(SELECT 1 FROM schema_meta WHERE key='${BUDGET_ENABLED}') THEN 'budget'
    WHEN NOT ${RUN_ADMISSION_READY_SQL} THEN 'admission_building'
    WHEN NOT ${spendReadySql('?3')} THEN 'admission_building'
    WHEN ${spentUsdSql('?3')} + ?4 > ${effectiveBudgetSql()} THEN 'budget' END AS reason
    FROM agent_runs r WHERE r.project_id=?1 AND r.id=?2 AND r.status='queued'`,
});
export async function budgetHold(db: RelationalStore, projectId: string, runId: string, estimate: number, now: number): Promise<BudgetHold | null> {
  const active = await budgetActivation(db);
  const [[row]] = await readSet(db, quotedHold.bind(projectId, runId, now-BUDGET_WINDOW_MS, estimate, Number(active.active)));
  return row?.reason ?? null;
}

export async function budgetHeld(db: RelationalStore, projectId: string, runId: string, estimate: number, now: number): Promise<boolean> {
  return (await budgetHold(db, projectId, runId, estimate, now)) !== null;
}
