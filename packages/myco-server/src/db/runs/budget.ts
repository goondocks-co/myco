import type { RelationalStore } from '../../core/adapters.js';
import type { BudgetStatus } from '@goondocks/myco-shared/budget-status';
import { admissionReady } from './live.js';
import { readSpendSnapshot, type SpendTotals } from './admission.js';
import { ESTIMATE_AGENT, estimateKey, type EstimateSample } from '../../core/budget-estimates.js';
import { getState } from '../../core/runs.js';
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';

/** What the governor is holding now: each budgeted task's queue head it recorded as held by the budget, and why. */
export interface BudgetHolds {
  active: boolean;
  reason: string | null;
  dailyUsd: number;
  heldHeads: NonNullable<BudgetStatus['heldHeads']> | null;
}

export { readTaskBudgetHolds as readBudgetHolds } from './queue.js';
import { readTaskBudgetHolds as readBudgetHolds } from './queue.js';

/** Deployment-wide totals come from the same maintained snapshot claim admission compares against; a projection still catching up reports building, never zero. */
export async function readBudgetStatus(db: RelationalStore, now: number): Promise<BudgetStatus> {
  const holds=await readBudgetHolds(db);
  const inactive={active:holds.active,reason:holds.reason,dailyUsd:holds.dailyUsd,automaticUsd:null,manualUsd:null,liveUsd:null,unconfirmed:null,pricedExposure:null,heldHeads:null};
  if (!holds.active) return inactive;
  const snapshot=await readSpendSnapshot(db,now);
  const headsReady = await admissionReady(db);
  if (!snapshot.ready || !headsReady) return {...inactive,heldHeads:headsReady ? holds.heldHeads : null,state:'building'};
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
