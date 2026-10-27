import type {RelationalStore} from '@myco-server-worker/core/adapters.js';
import {listSessionActivity} from '@myco-server-worker/read/session-activity.js';
import {sessionLineage} from '@myco-server-worker/read/lineage.js';
import {listUnplacedHookRecords,countUnplacedContextRecords} from '@myco-server-worker/read/hook-placement.js';
import {sessionTurnContexts,turnDetail,toolUsage} from '@myco-server-worker/read/turns.js';
import {injectionForPrompt} from '@myco-server-worker/core/injection.js';
import {receiptPlans} from '@myco-server-worker/read/view-store.js';
import {mirrorViewSession,publishMirroredSession} from './view-instances.js';
import {seedLegacyCIResults} from '../../helpers/view-read-legacy-fixtures.js';
import {uuid} from './fixtures.js';
import * as turns from '@myco-server-worker/read/turns.js';
import * as children from '@myco-server-worker/read/children.js';
import * as sessions from '@myco-server-worker/read/sessions.js';
import * as plans from '@myco-server-worker/read/plans.js';
import {activityFeed} from '@myco-server-worker/read/activity.js';
import {processedBody} from '@myco-server-worker/read/processed.js';
import {sessionMaterial} from '@myco-server-worker/core/titling.js';
import {childrenRowsByPrompt,turnChildPage,turns_readTurnBodies,lineage_sessionsNamed,lineage_childIdsOf,sessions_instantStatements} from '@myco-server-worker/read/view-store.js';
import {legacyBodyBlobs} from '../../helpers/view-read-legacy-fixtures.js';

export const worldScope={projectId:'project'};

export interface ViewReadWorkload {id:string;read:(db:RelationalStore)=>Promise<unknown>}

/** Each workload returns its complete public value from the writer-shaped consumer world. */
export function viewReadWorkloads():ViewReadWorkload[]{
 const result:ViewReadWorkload[]=[];
 const add=(id:string,read:ViewReadWorkload['read'])=>{result.push({id,read})};
 for(const order of ['ASC','DESC'] as const)for(const limit of [1,200]){
  add('turns/'+order+'/'+limit,async db=>{
   const first=await turns.listTurns(db,worldScope,'session',{order,limit});
   return [first,first.cursor===null?null:await turns.listTurns(db,worldScope,'session',{order,limit,cursor:first.cursor})];
  });
 }
 add('turns/origin',db=>turns.listTurns(db,worldScope,'session',{origins:['user']}));
 add('turns/prompt',db=>turns.listTurns(db,worldScope,'session',{promptId:uuid(22)}));
 add('turns/admission',db=>turns.promptInSession(db,worldScope,'session',uuid(20)));
 add('turns/detail',db=>turns.turnDetail(db,worldScope,'session',uuid(20)));
 add('turns/bodies',db=>turns_readTurnBodies(db,worldScope,'session',[uuid(20),uuid(22)]));
 add('turns/steering',db=>turns.listSteeringChildren(db,worldScope,'session',uuid(22),{limit:1}));
 for(const collection of turns.TURN_COLLECTIONS)add('turns/collection/'+collection,db=>turns.turnCollection(db,worldScope,'session',uuid(20),collection,{limit:1}));
 for(const collection of ['response','attachment','plan','answer'] as const)add('children/by-prompt/'+collection,db=>childrenRowsByPrompt(db,worldScope,'session',collection,[uuid(20),uuid(22)],1));
 for(const collection of ['plan','answer'] as const)add('children/page/'+collection,db=>turnChildPage(db,worldScope,'session',collection,{limit:1}));
 add('turns/collection/attachment-blob',db=>turns.turnCollection(db,worldScope,'session',uuid(12020),'attachments',{limit:1}));
 add('children/by-prompt/attachment-blob',db=>childrenRowsByPrompt(db,worldScope,'session','attachment',[uuid(12020)],1));
 add('children/page/answer-prompt',db=>turnChildPage(db,worldScope,'session','answer',{limit:1,promptId:uuid(20)}));
 add('children/context-deliveries',db=>children.listContextInjections(db,worldScope,'session',{limit:200}));
 for(const name of ['listPrompts','listResponses','listToolCalls','listPlans','listAttachments','listContextInjections'] as const)add('children/'+name,db=>children[name](db,worldScope,'session',{limit:1}));
 add('tools/all',db=>turns.toolUsage(db,worldScope,'session'));
 add('tools/prompt',db=>turns.toolUsage(db,worldScope,'session',uuid(20)));
 add('contexts',db=>turns.sessionTurnContexts(db,worldScope,'session'));
 add('hook/unplaced',db=>listUnplacedHookRecords(db,worldScope,'session'));
 add('hook/count/session',db=>countUnplacedContextRecords(db,worldScope,'session',700));
 add('hook/count/project',db=>countUnplacedContextRecords(db,worldScope,undefined,700));
 add('hook/count/all',db=>countUnplacedContextRecords(db,undefined,undefined,700));
 add('plan/full',db=>plans.getPlan(db,worldScope,uuid(50)));
 add('plan/summary',db=>plans.getPlan(db,worldScope,uuid(50),{summary:true}));
 add('plan/membership',db=>plans.planInSession(db,worldScope,'session',uuid(50)));
 add('session/admission',db=>sessions.getSession(db,worldScope,'session',700));
 add('session/counts',db=>sessions.sessionCounts(db,worldScope,'session'));
 add('session/counts-bulk',db=>sessions.sessionCountsFor(db,worldScope,['session','continued','missing']));
 for(const window of [undefined,'activity'] as const)for(const q of [undefined,'baseline','unmatched']){
  const opts={limit:200,fidelity:'any' as const,now:700,...(window===undefined?{}:{window,since:0}),...(q===undefined?{}:{q})};
  add('sessions/'+window+'/'+q,db=>sessions.listSessionSummaries(db,worldScope,opts,700));
  add('sessions/across/'+window+'/'+q,db=>sessions.listSessionSummariesAcross(db,{all:true},opts,700));
 }
 add('lineage',db=>sessionLineage(db,worldScope,'session'));
 add('lineage/named',db=>lineage_sessionsNamed(db,worldScope,['session','continued']));
 for(const kind of ['launched','continuation'] as const)add('lineage/children/'+kind,db=>lineage_childIdsOf(db,worldScope,kind,['session'],200));
 for(const kind of ['launched','continuation'] as const)add('lineage/child-labels/'+kind,async db=>lineage_sessionsNamed(db,worldScope,await lineage_childIdsOf(db,worldScope,kind,['session'],200)));
 add('feed',db=>activityFeed(db,worldScope));
 for(const type of [undefined,'failure','no_result','child_session','continuation'] as const)add('activity/'+type,db=>listSessionActivity(db,worldScope,'session',{type}));
 for(const mode of ['claim','owner','refresh'] as const)add('title/'+mode,db=>sessionMaterial(db,worldScope.projectId,'session',mode));
 for(const [kind,id]of [['prompt',uuid(20)],['response',uuid(30)],['plan',uuid(50)],['tool-input',uuid(40)],['tool-output',uuid(40)]] as const)
  add('body/'+kind,db=>processedBody({db,blobs:legacyBodyBlobs},worldScope,kind,id));
 add('injection',db=>injectionForPrompt(db,worldScope,'session',uuid(20)));
 add('receipt/historical',db=>receiptPlans(db,worldScope,[{receiptId:'historical',planIds:[uuid(50)]}]));
 return result;
}

export async function seedViewConsumerWorld(db:RelationalStore):Promise<void>{
 await seedLegacyCIResults(db);
}

export async function mirrorConsumerWorld(db:RelationalStore):Promise<void>{
 const sessions=(await db.prepare('SELECT session_id FROM sessions WHERE project_id=?').bind(worldScope.projectId).all<{session_id:string}>()).results;
 for(const {session_id:sessionId}of sessions){
  const parent='world-parent-'+sessionId,tail='world-tail-'+sessionId;
  await mirrorViewSession(db,{...worldScope,sessionId,instanceId:parent,state:'frozen'});
  await mirrorViewSession(db,{...worldScope,sessionId,instanceId:tail,state:'live',parent},false);
  await publishMirroredSession(db,worldScope.projectId,sessionId,tail,parent);
 }
}

export async function mutateOriginalWorld(db:RelationalStore,world:'poison'|'gone'):Promise<void>{
 if(world==='gone'){
  for(const table of ['prompt_batches','responses','tool_calls','plans'])await db.prepare(`DELETE FROM ${table} WHERE project_id=?`).bind(worldScope.projectId).run();
  return;
 }
 await db.batch([
  db.prepare("UPDATE prompt_batches SET text='poison unmatched',blob_key=NULL,origin='user',parent_prompt_id=NULL,created_at=99999,updated_at=99999 WHERE project_id=?").bind(worldScope.projectId),
  db.prepare("UPDATE responses SET text='poison',blob_key=NULL,prompt_id='missing',created_at=99999 WHERE project_id=?").bind(worldScope.projectId),
  db.prepare("UPDATE tool_calls SET tool_name='Poison',input='poison',input_bytes=6,input_blob_key=NULL,output_preview='poison',output_blob_key=NULL,prompt_id='missing',success=1,result_reason='reported',created_at=99999 WHERE project_id=?").bind(worldScope.projectId),
  db.prepare("UPDATE plans SET title='poison',content='poison',blob_key=NULL,status='completed',prompt_id='missing',created_at=99999,updated_at=99999 WHERE project_id=?").bind(worldScope.projectId),
 ]);
}

export async function activityConsumerWorld(db:RelationalStore):Promise<unknown>{
 const opts=[{}, {type:'failure'}, {type:'no_result'}, {type:'child_session'}, {type:'continuation'}] as const;
 return [
  ...await Promise.all(opts.map(options=>listSessionActivity(db,worldScope,'session',options))),
  await sessionLineage(db,worldScope,'session'),
  await listUnplacedHookRecords(db,worldScope,'session'),
  await countUnplacedContextRecords(db,worldScope,'session',700),
  await countUnplacedContextRecords(db,worldScope,undefined,700),
  await countUnplacedContextRecords(db,undefined,undefined,700),
 ];
}

export async function injectionConsumerWorld(db:RelationalStore):Promise<unknown>{
 const receipts=(await db.prepare('SELECT id,plan_ids FROM spore_injections WHERE project_id=? AND session_id=? ORDER BY id').bind(worldScope.projectId,'session').all<{id:string;plan_ids:string|null}>()).results;
 return [
  await sessionTurnContexts(db,worldScope,'session'),await turnDetail(db,worldScope,'session',uuid(20)),
  await injectionForPrompt(db,worldScope,'session',uuid(20)),await toolUsage(db,worldScope,'session'),
  [...await receiptPlans(db,worldScope,receipts.map(row=>({receiptId:row.id,planIds:JSON.parse(row.plan_ids??'[]')})))],
 ];
}

/** Arity points cover empty, full and split chunks beside each bounded page. */
export function viewArityWorkloads():ViewReadWorkload[]{
 const rows:ViewReadWorkload[]=[];
 const add=(id:string,read:ViewReadWorkload['read'])=>rows.push({id,read});
 for(const count of [0,1,90,91,201]){
  const sessionIds=Array.from({length:count},(_,index)=>index===0?'session':'arity-missing-'+index);
  add('arity/counts/'+count,db=>sessions.sessionCountsFor(db,worldScope,sessionIds));
  add('arity/instants/'+count,async db=>{
   const work=sessions_instantStatements(db,worldScope,sessionIds);
   const instants=await work.parse(work.statements.length?await db.batch(work.statements):[]);
   return {instants:instants.toSorted((a,b)=>a.sessionId.localeCompare(b.sessionId)||a.at-b.at),
    buckets:[...sessions.bucketActivity(sessionIds.map(sessionId=>({sessionId,startedAt:0,firstReceivedAt:0,endedAt:1000,lastReceivedAt:1000})),instants,1000)]};
  });
  if(count<=91){
   const prompts=Array.from({length:count},(_,index)=>index===0?uuid(20):uuid(70000+index));
   add('arity/bodies/'+count,db=>turns_readTurnBodies(db,worldScope,'session',prompts));
   for(const collection of ['response','attachment','plan','answer'] as const)add('arity/by-prompt/'+collection+'/'+count,db=>childrenRowsByPrompt(db,worldScope,'session',collection,prompts,200));
   add('arity/lineage/'+count,db=>lineage_sessionsNamed(db,worldScope,sessionIds));
   for(const kind of ['launched','continuation'] as const)add('arity/edges/'+kind+'/'+count,db=>lineage_childIdsOf(db,worldScope,kind,sessionIds,201));
   add('arity/receipts/'+count,db=>receiptPlans(db,worldScope,Array.from({length:count},(_,index)=>({receiptId:'arity-'+index,planIds:[uuid(50)]}))));
  }
 }
 for(const missing of [false,true])for(const cursor of [undefined,'0:empty','999999:empty']){
  const sessionId=missing?'arity-missing':'session',options={limit:200,...(cursor===undefined?{}:{cursor})};
  for(const collection of turns.TURN_COLLECTIONS)add('arity/collection/'+collection+'/'+sessionId+'/'+cursor,db=>turns.turnCollection(db,worldScope,sessionId,uuid(20),collection,options));
  add('arity/steering/'+sessionId+'/'+cursor,db=>turns.listSteeringChildren(db,worldScope,sessionId,uuid(22),options));
  for(const name of ['listPrompts','listResponses','listToolCalls','listPlans','listAttachments','listContextInjections'] as const)add('arity/children/'+name+'/'+sessionId+'/'+cursor,db=>children[name](db,worldScope,sessionId,options));
  add('arity/hook/'+sessionId+'/'+cursor,db=>listUnplacedHookRecords(db,worldScope,sessionId,options));
  add('arity/activity/'+sessionId+'/'+cursor,db=>listSessionActivity(db,worldScope,sessionId,options));
  for(const mode of ['claim','owner','refresh'] as const)add('arity/title/'+mode+'/'+sessionId+'/'+cursor,db=>sessionMaterial(db,worldScope.projectId,sessionId,mode));
 }
 add('arity/feed/100',db=>activityFeed(db,worldScope,100));
 for(const window of [undefined,'activity'] as const)for(const cursor of [undefined,'0:empty']){
  const options={limit:200,fidelity:'any' as const,q:'baseline',agent:'claude-code',branch:'main',memberLabel:'member',state:'open' as const,until:5000,...(window===undefined?{}:{window,since:0,now:700}),...(cursor===undefined?{}:{cursor})};
  const projects={all:false as const,projectIds:['project',...Array.from({length:63},(_,index)=>'arity-project-'+index)]};
  add('arity/across/'+window+'/'+cursor,db=>sessions.listSessionSummariesAcross(db,projects,options,700));
 }
 return rows;
}
