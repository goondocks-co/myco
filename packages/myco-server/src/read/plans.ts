import { registeredObjectKeySql } from '../core/blob-objects.js';
import type { RelationalStore } from '../core/adapters.js';
import { PLAN_STATUSES } from '../ingest/kinds.js';
import { clampLimit, containsPattern, encodeCursor, inListChunks, keyset, projectsDriving, projectsFiltering, type Page, type ProjectSet, type ReadScope } from './scope.js';
export {
  type plans_ProjectPlanRow as ProjectPlanRow,
  plans_WRITABLE_PLAN_STATUSES as WRITABLE_PLAN_STATUSES,
  plans_PLAN_STATUS_MESSAGE as PLAN_STATUS_MESSAGE,
  plans_progressOf as progressOf,
  plans_listProjectPlans as listProjectPlans,
  plans_pageProjectPlans as pageProjectPlans,
  type plans_PlanAcrossRow as PlanAcrossRow,
  plans_pagePlansAcross as pagePlansAcross,
  plans_planTotals as planTotals,
  type plans_ProjectPlanSummary as ProjectPlanSummary,
  plans_getPlan as getPlan,
  plans_planInSession as planInSession,
} from './view-store.js';



/**
 * Writes a plan's status as an administrative edit by a member. The stamp lands strictly after the row's, so a capture event replayed with the row's old stamp never wins over the edit. False when no such plan sits in the scope or it already holds the status.
 */
export async function setPlanStatus(db: RelationalStore, scope: ReadScope, planKey: string, status: string, by: string, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE plans SET status = ?, updated_by = ?, updated_at = MAX(updated_at + 1, ?) WHERE project_id = ? AND plan_key = ? AND status <> ? RETURNING plan_key`)
    .bind(status, by, nowMs, scope.projectId, planKey, status)
    .first();
  return result !== null;
}
