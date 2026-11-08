import type { RelationalStore } from '../core/adapters.js';
import type { BudgetStatus } from '@goondocks/myco-shared/budget-status';
import { budgetActivation } from '../db/budget-activation.js';
import { effectiveBudgetSql } from '../core/run-budget.js';
import { readSpendSnapshot, type SpendTotals } from '../db/runs/admission.js';
import { ESTIMATE_AGENT, estimateKey, type EstimateSample } from '../core/budget-estimates.js';
import { getState } from '../core/runs.js';
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { BUDGET_WORKER_TASKS } from '../core/budget-policy.js';
import { contextValue,BUDGET_QUOTE_USD_KEY,BUDGET_QUOTE_AT_KEY } from '../db/run-context.js';

/** What the governor is holding now: each budgeted task's queue head it recorded as held by the budget, and why. */
export interface BudgetHolds {
  active: boolean;
  reason: string | null;
  dailyUsd: number;
  heldHeads: NonNullable<BudgetStatus['heldHeads']> | null;
}

/**
 * The holds the governor maintains on queue heads, read without the spend window: one queue-head seek per budgeted
 * task. A live view reads this every tick; the totals stay in `readBudgetStatus`.
 */
export async function readBudgetHolds(db: RelationalStore): Promise<BudgetHolds> {
  const activation=await budgetActivation(db);
  const leaf=await db.prepare(`SELECT ${effectiveBudgetSql()} AS budget`).first<{budget:number}>();
  if (leaf===null) throw new Error('Budget setting unavailable');
  if (!activation.active) return {...activation,dailyUsd:leaf.budget,heldHeads:null};
  const heldHeads:NonNullable<BudgetStatus['heldHeads']>=[];
  for(const task of BUDGET_WORKER_TASKS) {
    const head=await db.prepare(`SELECT project_id AS projectId,id AS runId,task,held_by AS holder,${contextValue(BUDGET_QUOTE_USD_KEY)} AS requiredUsd,${contextValue(BUDGET_QUOTE_AT_KEY)} AS quotedAt FROM agent_runs INDEXED BY idx_agent_runs_queue_head
      WHERE task=? AND origin='automatic' AND status='queued' AND dispatched_by IS NULL ORDER BY queued_at,id LIMIT 1`)
      .bind(task).first<{projectId:string;runId:string;task:string;holder:string|null;requiredUsd:unknown;quotedAt:unknown}>();
    if(head?.holder==='budget') {
      const requiredUsd=typeof head.requiredUsd==='number'&&Number.isFinite(head.requiredUsd)&&head.requiredUsd>=0?head.requiredUsd:null;
      const quotedAt=typeof head.quotedAt==='number'&&Number.isSafeInteger(head.quotedAt)?head.quotedAt:null;
      heldHeads.push({projectId:head.projectId,runId:head.runId,task:head.task,reason:requiredUsd!==null&&requiredUsd>leaf.budget?'budget_too_small':'budget',requiredUsd,quotedAt});
    }
  }
  return {...activation,dailyUsd:leaf.budget,heldHeads};
}

/** Deployment-wide totals come from the same maintained snapshot claim admission compares against; a projection still catching up reports building, never zero. */
export async function readBudgetStatus(db: RelationalStore, now: number): Promise<BudgetStatus> {
  const holds=await readBudgetHolds(db);
  const inactive={active:holds.active,reason:holds.reason,dailyUsd:holds.dailyUsd,automaticUsd:null,manualUsd:null,liveUsd:null,unconfirmed:null,pricedExposure:null,heldHeads:null};
  if (!holds.active) return inactive;
  const snapshot=await readSpendSnapshot(db,now);
  if (!snapshot.ready) return {...inactive,heldHeads:holds.heldHeads,state:'building'};
    const of=(origin:'manual'|'automatic')=>snapshot.totals.find(row=>row.origin===origin);
  const total=(pick:(row:SpendTotals)=>number,origin?:'manual'|'automatic')=>snapshot.totals.filter(row=>origin===undefined||row.origin===origin).reduce((sum,row)=>sum+pick(row),0);
  const detail=(origin:'manual'|'automatic')=>({count:of(origin)?.unconfirmed ?? 0,estimatedUsd:of(origin)?.unconfirmedEstimateUsd ?? 0});
  let exposure=0,sampleSize=0,missingSamples=0;
  const samples=new Map<string,EstimateSample|null>();
  for (const row of snapshot.live) {
    if (row.profileJson===null) { missingSamples++;continue; }
    const profile: {harness:string;profile:ExecutionProfile}=JSON.parse(row.profileJson);
    const key=estimateKey(row.task,profile.harness,profile.profile);
    const group=JSON.stringify([row.projectId,key]);
    const first=!samples.has(group);
    if(first) {
      const held=await getState(db,{projectId:row.projectId},ESTIMATE_AGENT,key);
      samples.set(group,held===null?null:JSON.parse(held.value));
    }
    const sample=samples.get(group) ?? null;
    if (sample?.ratioP95==null) {missingSamples++;continue;}
    exposure+=row.estimate*(sample.ratioP95-1);
    if(first)sampleSize+=sample.ratioN;
  }
  return {active:holds.active,reason:holds.reason,dailyUsd:holds.dailyUsd,automaticUsd:total(row=>row.usd,'automatic'),manualUsd:total(row=>row.usd,'manual'),
    liveUsd:total(row=>row.liveUsd),unconfirmed:{count:total(row=>row.unconfirmed),estimatedUsd:total(row=>row.unconfirmedEstimateUsd),manual:detail('manual'),automatic:detail('automatic')},heldHeads:holds.heldHeads,
    pricedExposure:{usd:missingSamples>0?null:exposure,sampleSize,missingSamples,provenance:'empirical-p95'},state:'ready'};
}
