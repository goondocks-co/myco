import type { RelationalStore } from '../core/adapters.js';
import type { BudgetStatus } from '@goondocks/myco-shared/budget-status';
import { budgetActivation } from '../db/budget-activation.js';
import { effectiveBudgetSql, readSpendRows } from '../core/run-budget.js';
import { ESTIMATE_AGENT, estimateKey, type EstimateSample } from '../core/budget-estimates.js';
import { getState } from '../core/runs.js';
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { BUDGET_WORKER_TASKS } from '../core/budget-policy.js';
import { contextValue,BUDGET_QUOTE_USD_KEY,BUDGET_QUOTE_AT_KEY } from '../db/run-context.js';

/** Deployment-wide totals share the exact attempt relation used by claim admission. */
export async function readBudgetStatus(db: RelationalStore, now: number): Promise<BudgetStatus> {
  const activation=await budgetActivation(db);
  const leaf=await db.prepare(`SELECT ${effectiveBudgetSql()} AS budget`).first<{budget:number}>();
  if (leaf===null) throw new Error('Budget setting unavailable');
  if (!activation.active) return {...activation,dailyUsd:leaf.budget,automaticUsd:null,manualUsd:null,liveUsd:null,unconfirmed:null,pricedExposure:null,heldHeads:null};
  const rows=await readSpendRows(db,now);
  const sum=(predicate:(row:typeof rows[number])=>boolean)=>rows.filter(predicate).reduce((total,row)=>total+row.value,0);
  const unconfirmed=rows.filter(row=>!row.live && !['actual','estimated'].includes(row.costSource ?? ''));
  const detail=(origin:string)=>{const selected=unconfirmed.filter(row=>row.origin===origin);return {count:selected.length,estimatedUsd:selected.reduce((sum,row)=>sum+row.estimate,0)};};
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
  let exposure=0,sampleSize=0,missingSamples=0;
  const samples=new Map<string,EstimateSample|null>();
  for (const row of rows.filter(row=>row.live && row.origin==='automatic')) {
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
  return {...activation,dailyUsd:leaf.budget,automaticUsd:sum(row=>row.origin==='automatic'),manualUsd:sum(row=>row.origin==='manual'),
    liveUsd:sum(row=>!!row.live),unconfirmed:{count:unconfirmed.length,estimatedUsd:unconfirmed.reduce((total,row)=>total+row.estimate,0),manual:detail('manual'),automatic:detail('automatic')},heldHeads,
    pricedExposure:{usd:missingSamples>0?null:exposure,sampleSize,missingSamples,provenance:'empirical-p95'}};
}
