import {preparePlanStatusWrite} from '../core/plan-status.js';
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
 * Updates a surviving fact plan and stamps it strictly after its current revision. Returns false for an unknown, view-only or same-status target. Canonical editorial callers use changePlanStatus to resolve the response and refuse a view-only target.
 */
export async function setPlanStatus(db:RelationalStore,scope:ReadScope,planKey:string,status:string,by:string,nowMs:number):Promise<boolean>{
  return (await preparePlanStatusWrite(db,scope,planKey,status,by,nowMs).statement.first())!==null;
}
