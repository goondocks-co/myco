import type { RelationalStore } from '../../core/adapters.js';
import { assertion, read, readSet, type Bound } from '../index.js';
import { CLAIM_SELECTION_REFUSED } from './claim-refusals.js';
import { liveCountSql, RUN_ADMISSION_READY_SQL } from './live.js';
import { spentUsdSql, projectSpendSql, spendReadySql } from './admission.js';
import { queueHeadSeek } from './queue.js';
import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import { capabilityOnSql, projectAcceptsWorkSql, effectiveBudgetSql, learningEnabledSql, curationDailyLimitSql, CURATION_DAILY_LIMIT_MAX } from '../../core/settings.js';
import { FRESH_LEARNING_MS, freshRetrySql as retry, learningRecencySql as recency, learningRangeSql as range } from './learning-policy.js';
import { BUDGET_WINDOW_MS, seedForStage, reserveForStage } from '../../core/budget-policy.js';
import { admissionForTask, CURATION_TASK, EXTRACTION_TASK } from '../../core/task-catalogue.js';
import { CARD_TASK } from '@goondocks/myco-shared/turn-card';
import { resolvedConcurrency, type DispatchLimits } from '../../core/limits.js';
import type { PulledItem, ServedQueue } from '../../core/pulled-stages.js';

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const instant = (now: number | string) => typeof now === 'number' ? String(Math.floor(now)) : now;
const before = (now: number | string, ms: number) => typeof now === 'number' ? String(Math.floor(now-ms)) : `(${now}-${ms})`;
const accepts = (project: string, task: string) => {
  const gate = admissionForTask(task);
  return gate?.kind === 'capability' ? capabilityOnSql(project,literal(gate.capability)) : projectAcceptsWorkSql(project);
};
function learningWorkFrom(project:string,now:number|string,kind:'cards'|'learning',fresh:boolean):string {
  const ready=kind==='cards'?'card_ready_at':'learning_ready_at', pending=kind==='cards'?'pending_cards > 0':'eligible_at IS NOT NULL';
  if(!fresh)return `learning_sessions l INDEXED BY ${kind==='cards'?'idx_learning_cards_ready':'idx_learning_ready'}`;
  const day=typeof now==='number'?String(Math.floor(now/FRESH_LEARNING_MS)):`CAST(${now}/${FRESH_LEARNING_MS} AS INTEGER)`;
  const columns='project_id,session_id,source_activity_at,eligible_at,pending_cards,card_ready_at,learning_ready_at,fresh_admitted,card_failures,failures';
  return `(SELECT ${columns} FROM learning_sessions INDEXED BY ${kind==='cards'?'idx_learning_cards_fresh':'idx_learning_fresh'}
    WHERE project_id=${project} AND source_day IN ((${day})-1,${day}) AND ${pending} AND ${ready}<=${instant(now)}
    UNION ALL SELECT ${columns} FROM learning_sessions INDEXED BY ${kind==='cards'?'idx_learning_source_pending':'idx_learning_source_eligible'}
    WHERE project_id=${project} AND source_activity_at>=((${day})+1)*${FRESH_LEARNING_MS} AND ${pending} AND ${ready}<=${instant(now)}
    UNION ALL SELECT ${columns} FROM learning_sessions INDEXED BY ${kind==='cards'?'idx_learning_cards_retry':'idx_learning_retry'}
    WHERE project_id=${project} AND ${pending} AND ${retry(kind)} AND ${recency(false,now)} AND ${ready}<=${instant(now)}) l`;
}
export function learningEligible(kind:'cards'|'learning',fresh:boolean,now:number|string):string {
  const timing=kind==='cards'?`pending_cards>0 AND card_ready_at<=${instant(now)}`:`eligible_at IS NOT NULL AND learning_ready_at<=${instant(now)}`;
  return `${timing} AND ${range(kind,fresh,now)} AND ${learningEnabledSql(!fresh)}${kind==='cards'?`
    AND EXISTS(SELECT 1 FROM turn_cards c INDEXED BY idx_turn_cards_model_due WHERE c.project_id=l.project_id
      AND c.session_id=l.session_id AND c.state='pending' AND c.due_at<=${instant(now)})`:''}`;
}
const freeLearning = (kind:'cards'|'learning') => `NOT EXISTS(SELECT 1 FROM agent_runs r INDEXED BY idx_agent_runs_task_live
  WHERE r.task=${literal(kind==='cards'?CARD_TASK:EXTRACTION_TASK)} AND r.${IN_FLIGHT_RUN_STATUSES} AND r.subject=${literal(kind==='cards'?'cards:':'session:')}||l.session_id)`;
export function learningDue(kind:'cards'|'learning',fresh:boolean,project:string,now:number|string):string {
  return `EXISTS(SELECT 1 FROM ${learningWorkFrom(project,now,kind,fresh)} WHERE l.project_id=${project}
    AND ${learningEligible(kind,fresh,now)} AND ${freeLearning(kind)})`;
}
export const CURATION_MAX_FAILURES=3;
export function curationDueWorkSql(project:string,now:number|string):string {
  return `w.project_id=${project} AND w.due_at IS NOT NULL AND w.due_at<=${instant(now)} AND w.failures<${CURATION_MAX_FAILURES}
    AND (w.failures>0 OR (SELECT COUNT(*) FROM (SELECT 1 FROM spore_curation_work INDEXED BY idx_curation_first_started
      WHERE project_id=${project} AND first_started_at IS NOT NULL AND first_started_at>${before(now,BUDGET_WINDOW_MS)}
      LIMIT ${CURATION_DAILY_LIMIT_MAX}))<${curationDailyLimitSql(project)})`;
}
export function curationAdmissionSql(project:string,now:number|string,estimateKey?:string, keySql?:string):string {
  const price=keySql===undefined&&estimateKey===undefined?String(seedForStage(CURATION_TASK)):
    `COALESCE((SELECT json_extract(value,'$.estimate') FROM agent_state WHERE project_id=${project} AND agent_id='myco-agent' AND key=${keySql??literal(estimateKey!)}),${seedForStage(CURATION_TASK)})`;
  return `EXISTS(SELECT 1 FROM spore_curation_work w INDEXED BY idx_curation_due WHERE ${curationDueWorkSql(project,now)})
    AND ${capabilityOnSql(project,"'spore_curation'")}
    AND NOT EXISTS(SELECT 1 FROM agent_runs r INDEXED BY idx_agent_runs_task_live WHERE r.task='${CURATION_TASK}' AND r.project_id=${project} AND r.${IN_FLIGHT_RUN_STATUSES})
    AND ${spendReadySql(before(now,BUDGET_WINDOW_MS))} AND ${spentUsdSql(before(now,BUDGET_WINDOW_MS))} + ${price} + ${reserveForStage(CURATION_TASK)}<=${effectiveBudgetSql()}`;
}
const limitSql = (task:string) => `${RUN_ADMISSION_READY_SQL}
  AND (i.fleet IS NULL OR ${liveCountSql('fleet',task,'NULL','NULL')}<i.fleet)
  AND (i.concurrent IS NULL OR ${liveCountSql('task',task,'NULL','NULL')}<i.concurrent)
  AND (i.hourly IS NULL OR (SELECT COUNT(*) FROM agent_runs INDEXED BY idx_agent_runs_task_started
    WHERE task=${task} AND started_at IS NOT NULL AND started_at>=i.now-3600000)<i.hourly)`;
const inputs = `WITH i AS (SELECT json_extract(?1,'$.now') AS now,json_extract(?1,'$.projectId') AS projectId,
  json_extract(?1,'$.key') AS key,json_extract(?1,'$.observed') AS observed,json_extract(?1,'$.estimateKey') AS estimateKey,
  json_extract(?1,'$.fleet') AS fleet,json_extract(?1,'$.concurrent') AS concurrent,json_extract(?1,'$.hourly') AS hourly)`;
const refusedUnless = (when:string) => ({with:inputs,from:'i',when,refusal:CLAIM_SELECTION_REFUSED});
const values = (item:PulledItem,limits:DispatchLimits,now:number,estimateKey?:string) => JSON.stringify({...item,now,estimateKey,
  fleet:resolvedConcurrency(limits).value,concurrent:limits.task_concurrent_runs,hourly:limits.task_runs_per_hour});
export interface PullPolicy {
  head(item:PulledItem,limits:DispatchLimits,now:number,estimateKey?:string):Bound;
  higher(item:PulledItem,limits:DispatchLimits,now:number,estimateKey?:string):Bound;
  fair(item:PulledItem,limits:DispatchLimits,now:number,estimateKey?:string):Bound;
}
/** Define each stage's fixed head, priority and fairness assertions at registration. */
export function definePullPolicy(name:string,task:string,due:string,head:string):PullPolicy {
  const valid=`${accepts('p.project_id',task)} AND ${due} AND ${limitSql(literal(task))}`;
  const definitions={
    head:assertion<[string]>({name:`pull.${name}Head`,...refusedUnless(head)}),
    higher:assertion<[string]>({name:`pull.${name}Priority`,...refusedUnless(`NOT EXISTS(SELECT 1 FROM projects p WHERE ${valid})`)}),
    fair:assertion<[string]>({name:`pull.${name}Fair`,...refusedUnless(`NOT EXISTS(SELECT 1 FROM projects p
      CROSS JOIN (SELECT ROUND(COALESCE((SELECT spent FROM (${projectSpendSql(`i.now-${BUDGET_WINDOW_MS}`)}) WHERE projectId=i.projectId),0),6) AS spent) mine
      LEFT JOIN (SELECT projectId,ROUND(spent,6) AS spent FROM (${projectSpendSql(`i.now-${BUDGET_WINDOW_MS}`)})) other ON other.projectId=p.project_id
      WHERE p.project_id!=i.projectId AND ${valid}
        AND (COALESCE(other.spent,0)<mine.spent OR (COALESCE(other.spent,0)=mine.spent AND p.project_id<i.projectId)))`)}),
  };
  return {head:(...args)=>definitions.head.bind(values(...args)),higher:(...args)=>definitions.higher.bind(values(...args)),fair:(...args)=>definitions.fair.bind(values(...args))};
}
export const learningPolicies = (['cards','learning'] as const).map(kind => [false,true].map(fresh => definePullPolicy(
  `${kind}${fresh?'Fresh':'History'}`,kind==='cards'?CARD_TASK:EXTRACTION_TASK,learningDue(kind,fresh,'p.project_id','i.now'),
  `EXISTS(SELECT 1 FROM learning_sessions l WHERE project_id=i.projectId AND session_id=i.key
    AND ${kind==='cards'?'source_activity_at':'eligible_at'}=i.observed AND ${learningEligible(kind,fresh,'i.now')})`)));
export const curationPolicy=definePullPolicy('curation',CURATION_TASK,curationAdmissionSql('p.project_id','i.now',undefined,'i.estimateKey'),
  `${curationAdmissionSql('i.projectId','i.now',undefined,'i.estimateKey')} AND EXISTS(SELECT 1 FROM spore_curation_work w
    WHERE ${curationDueWorkSql('i.projectId','i.now')} AND cluster_key=i.key AND due_at=i.observed AND decision IS NULL)`);
const qTask="json_extract(q.value,'$.task')",qCapability="json_extract(q.value,'$.capability')";
const queuedClearSql = `NOT EXISTS(SELECT 1 FROM json_each(?1,'$.queues') q
  CROSS JOIN json_each('["manual","automatic"]') origins WHERE ${limitSql(qTask)} AND EXISTS(
    SELECT 1 FROM (${queueHeadSeek('project_id, task',qTask,'origins.value')}) head
      WHERE ${projectAcceptsWorkSql('head.project_id')} AND (${qCapability} IS NULL OR ${capabilityOnSql('head.project_id',qCapability)})
      AND (origins.value='manual' OR ${spendReadySql(`i.now-${BUDGET_WINDOW_MS}`)} AND ${spentUsdSql(`i.now-${BUDGET_WINDOW_MS}`)}
        + COALESCE((SELECT json_extract(s.value,'$.estimate') FROM agent_state s WHERE s.project_id=head.project_id
          AND s.agent_id='myco-agent' AND s.key=json_extract(q.value,'$.estimateKey')),json_extract(q.value,'$.seed'))<=${effectiveBudgetSql()})))`;
const queuedClear=assertion<[string]>({name:'pull.queuedPriority',...refusedUnless(queuedClearSql)});
const queuedRead=read<[string], { admissible: number }>({name:'pull.queuedAdmissible',sql:`${inputs} SELECT NOT (${queuedClearSql}) AS admissible FROM i`});
const queueValues = (queues:readonly ServedQueue[],limits:DispatchLimits,now:number) => JSON.stringify({
  now,fleet:resolvedConcurrency(limits).value,concurrent:limits.task_concurrent_runs,hourly:limits.task_runs_per_hour,
  queues:queues.map(q=>{const gate=admissionForTask(q.task);return {...q,capability:gate?.kind==='capability'?gate.capability:null,seed:seedForStage(q.task)};}),
});
export async function queuedAdmissible(db: RelationalStore, queues:readonly ServedQueue[],limits:DispatchLimits,now:number):Promise<boolean> {
  const [[row]] = await readSet(db, queuedRead.bind(queueValues(queues,limits,now)));
  return row?.admissible === 1;
}

export function queuedPriority(queues:readonly ServedQueue[],limits:DispatchLimits,now:number):Bound {
  return queuedClear.bind(queueValues(queues,limits,now));
}
