import { budgetActivation } from '../db/meta/budget-activation.js';
import { estimateAdvanceStatement, estimateCompletionStatements, estimateCursor, estimateSampleStatement, estimateSettlements, estimatesRefreshedAt } from '../db/meta/budget-estimates.js';
import { commit } from '../db/index.js';
import type { RelationalStore } from './adapters.js';
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { ensureAgent, getState } from '../db/runs/state.js';
import { seedForStage, BUDGET_WORKER_TASKS, BUDGET_ESTIMATE_PREFIX } from './budget-policy.js';

const ESTIMATE_INTERVAL_MS = 3_600_000;
const ESTIMATE_SAMPLE_SIZE = 50;
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
  const results=await estimateSettlements(db,progress.after,progress.until,progress.floor,ESTIMATE_PUBLISH_PAGE);
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
  const advance=estimateAdvanceStatement(held?.value??null,next,observed.epoch,now-ESTIMATE_INTERVAL_MS);
  if(groups.size>0)await ensureAgent(db,{id:ESTIMATE_AGENT,name:ESTIMATE_AGENT,provider:null,model:null,enabled:true},now);
  const writes=[...groups.values()].map(group=>{
    const ratios=group.points.flatMap(point=>point.ratio===null?[]:[point.ratio]).sort((a,b)=>a-b);
    const sample:SampleState={estimate:group.points.reduce((sum,point)=>sum+point.cost,0)/group.points.length,
      ratioP95:ratios.length===0?null:ratios[Math.ceil(ratios.length*0.95)-1]!,n:group.points.length,ratioN:ratios.length,refreshedAt:now,cycle:progress.cycle,points:group.points};
    return estimateSampleStatement(group.projectId,ESTIMATE_AGENT,group.key,JSON.stringify(sample),now,progress.revision);
  });
  const done=results.length<ESTIMATE_PUBLISH_PAGE;
  const completion=done?estimateCompletionStatements(progress.until,now,progress.revision):[];
  const [advanced]=await commit(db,advance,...writes,...completion);
  if(advanced!.results.length!==1)return {changed:0,more:await estimateRefreshDue(db,now)};
  return {changed:results.length+writes.length,more:!done};
}

