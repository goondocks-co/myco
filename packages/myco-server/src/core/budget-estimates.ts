import { budgetActivation } from '../db/meta/budget-activation.js';
import { estimateAdvanceStatement, estimateCompletionStatements, estimateCursor, estimateProgressGuard, estimatesRefreshedAt } from '../db/meta/budget-estimates.js';
import type { RelationalStore } from './adapters.js';
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { ensureAgent, getState, guardedStateStatement } from '../db/runs/state.js';
import { seedForStage, BUDGET_WORKER_TASKS, BUDGET_ESTIMATE_PREFIX } from './budget-policy.js';

export const ESTIMATE_INTERVAL_MS = 3_600_000;
export const ESTIMATE_SAMPLE_SIZE = 50;
export const ESTIMATE_PUBLISH_PAGE = 32;
export const ESTIMATE_AGENT = 'myco-agent';
export interface EstimateSample { estimate: number; ratioP95: number | null; n: number; ratioN: number; refreshedAt: number }
export const estimateKey = (task: string, harness: string, profile: Pick<ExecutionProfile,'tier'|'model'>): string => `${BUDGET_ESTIMATE_PREFIX}${JSON.stringify([task,harness,profile.tier,profile.model])}`;

export async function estimateForClaim(db: RelationalStore, projectId: string, task: string, harness: string, profile: ExecutionProfile) {
  const stateKey = estimateKey(task,harness,profile);
  const state = await getState(db,{projectId},ESTIMATE_AGENT,stateKey);
  const sample: EstimateSample | null = state === null ? null : JSON.parse(state.value);
  if (sample !== null && (!Number.isFinite(sample.estimate) || sample.estimate<0)) throw new Error('Invalid stored attempt estimate');
  return { estimate: sample?.estimate ?? seedForStage(task), profileJson: JSON.stringify({harness,profile}), stateKey, observedEstimate: state?.value ?? null };
}

export async function estimateRefreshDue(db: RelationalStore, now: number): Promise<boolean> {
  if (!(await budgetActivation(db)).active) return false;
  const stamp = await estimatesRefreshedAt(db);
  return stamp===null || !Number.isFinite(Number(stamp)) || now-Number(stamp)>=ESTIMATE_INTERVAL_MS;
}

type SamplePoint = { cost: number; ratio: number | null; seq:number };
interface Progress { after:number; until:number; floor:number; revision:string; cycle:string; rebuild:boolean }
interface SampleState extends EstimateSample { cycle:string; points:SamplePoint[] }
/** Settlement pages fold new prices into each Project/profile's newest fifty samples. */
export async function refreshEstimates(db: RelationalStore, now: number): Promise<{changed:number;more:boolean}> {
  if (!(await estimateRefreshDue(db,now))) return {changed:0,more:false};
  const observed=await estimateCursor(db);
  if(observed===null)throw new Error('Estimator progress unavailable');
  const held=observed.value===null?null:{value:observed.value};
  const floor=Math.min(Number(observed.enabled),Number(observed.restoredFloor??observed.enabled));
  if(observed.enabled===null||!Number.isSafeInteger(floor))throw new Error('Estimator activation floor unavailable');
  const after=Number(observed.watermark??0);
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(observed.latest))throw new Error('Estimator settlement cursor unavailable');
  const progress:Progress=held===null
    ? {after,until:Math.max(after,observed.latest),floor,revision:crypto.randomUUID(),cycle:crypto.randomUUID(),rebuild:observed.watermark===null}
    : JSON.parse(held.value);
  const results=(await db.prepare(`SELECT a.settled_seq AS seq,a.project_id AS projectId,r.task,a.profile_json AS profile,
    a.cost_usd AS cost,a.estimate_usd AS estimate FROM agent_run_attempts a INDEXED BY idx_attempts_settled JOIN agent_runs r ON r.project_id=a.project_id AND r.id=a.run_id
    WHERE a.settled_seq>? AND a.settled_seq<=? AND a.claimed_at>=? AND a.profile_json IS NOT NULL AND a.cost_usd IS NOT NULL
    ORDER BY a.settled_seq LIMIT ?`)
    .bind(progress.after,progress.until,progress.floor,ESTIMATE_PUBLISH_PAGE).all<{seq:number;projectId:string;task:string;profile:string;cost:number;estimate:number|null}>()).results;
  const groups=new Map<string,{projectId:string;key:string;points:SamplePoint[]}>();
  for(const row of results) {
    if(!BUDGET_WORKER_TASKS.includes(row.task))continue;
    const identity:{harness:string;profile:ExecutionProfile}=JSON.parse(row.profile);
    const key=estimateKey(row.task,identity.harness,identity.profile);
    const groupId=JSON.stringify([row.projectId,key]);
    let group=groups.get(groupId);
    if(group===undefined) {
      const state=await getState(db,{projectId:row.projectId},ESTIMATE_AGENT,key);
      const previous:SampleState|null=state===null?null:JSON.parse(state.value);
      group={projectId:row.projectId,key,points:previous!==null&&(!progress.rebuild||previous.cycle===progress.cycle)?previous.points:[]};
      groups.set(groupId,group);
    }
    group.points.push({seq:row.seq,cost:row.cost,ratio:row.estimate!==null&&row.estimate>0?row.cost/row.estimate:null});
    group.points.sort((a,b)=>b.seq-a.seq);
    group.points=group.points.slice(0,ESTIMATE_SAMPLE_SIZE);
  }
  const last=results.at(-1);
  if(last!==undefined)progress.after=last.seq;
  progress.revision=crypto.randomUUID();
  const next=JSON.stringify(progress);
  const guard=estimateProgressGuard(progress.revision);
  const advance=estimateAdvanceStatement(db,held?.value??null,next,observed.epoch,now-ESTIMATE_INTERVAL_MS);
  if(groups.size>0)await ensureAgent(db,{id:ESTIMATE_AGENT,name:ESTIMATE_AGENT,provider:null,model:null,enabled:true},now);
  const writes=[...groups.values()].map(group=>{
    const ratios=group.points.flatMap(point=>point.ratio===null?[]:[point.ratio]).sort((a,b)=>a-b);
    const sample:SampleState={estimate:group.points.reduce((sum,point)=>sum+point.cost,0)/group.points.length,
      ratioP95:ratios.length===0?null:ratios[Math.ceil(ratios.length*0.95)-1]!,n:group.points.length,ratioN:ratios.length,refreshedAt:now,cycle:progress.cycle,points:group.points};
    return guardedStateStatement(db,{projectId:group.projectId},ESTIMATE_AGENT,group.key,JSON.stringify(sample),now,guard);
  });
  const done=results.length<ESTIMATE_PUBLISH_PAGE;
  const completion=done?estimateCompletionStatements(db,progress.until,now,progress.revision):[];
  const [advanced]=await db.batch([advance,...writes,...completion]);
  if(advanced!.results.length!==1)return {changed:0,more:await estimateRefreshDue(db,now)};
  return {changed:results.length+writes.length,more:!done};
}

/** The observed Project/profile price and the same seed used by estimateForClaim. */
export function estimatedClaimPriceSql(project: string, task: string, key?: string): string {
  return key === undefined ? String(seedForStage(task)) : `COALESCE((SELECT json_extract(value,'$.estimate') FROM agent_state
    WHERE project_id=${project} AND agent_id='${ESTIMATE_AGENT}' AND key='${key.replaceAll("'", "''")}'),${seedForStage(task)})`;
}
