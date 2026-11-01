import {expect,it} from 'bun:test';
import {listSessions,listSessionsAcross,listSessionSummaries,listSessionSummariesAcross,sessionCountsFor,createProject} from '@myco-server-worker/read/sessions.js';
import {activityFeed} from '@myco-server-worker/read/activity.js';
import {sessionLineage} from '@myco-server-worker/read/lineage.js';
import {captureViewSession,withViewStores,withViewStorePair} from './helpers/view-stores.js';
import {mirrorViewSession,publishMirroredSession} from './helpers/view-instances.js';
import {statementRecorder} from '../helpers/statement-recorder.js';
import type {RelationalStore} from '@myco-server-worker/core/adapters.js';
import {withViewReadResponse} from '@myco-server-worker/read/view-store.js';
import {setViewLayerValues} from './helpers/view-instances.js';

const scope={projectId:'project'};
const filters=[{fidelity:'any'}, {fidelity:'any',q:'factcanary'}, {fidelity:'any',window:'activity',since:0,now:2000}] as const;

it('a legacy session selected before publication retains its absent source through count hydration',async()=>{
 const evidence:{target:string;expected:unknown;actual:unknown}[]=[];
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  const expected=await listSessionSummaries(db,scope,{fidelity:'any'},2000);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'next',state:'building'},false);
  let flipped=false;
  const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',after:async row=>{
   if(!flipped&&row.sql.startsWith('/*vs:M13:')){flipped=true;await publishMirroredSession(db,'project','session','next')}
  }});
  const actual=await listSessionSummaries(observed.db,scope,{fidelity:'any'},2000);
  evidence.push({target,expected,actual});
 });
 console.info('VIEW_LEGACY_FLIP',JSON.stringify(evidence));
 for(const row of evidence)expect(row.actual,row.target).toEqual(row.expected);
},60_000);

async function labels(db:RelationalStore):Promise<unknown[]>{
 return [
  ...await Promise.all(filters.map(opts=>listSessions(db,scope,opts))),
  await listSessionsAcross(db,{all:true},{fidelity:'any'}),
  await activityFeed(db,scope),
  await sessionLineage(db,scope,'session'),
 ];
}

it('correlated session, activity and lineage labels survive classified originals disappearing',async()=>{
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  const expected=await labels(db);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'parent',state:'frozen'});
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'tail',state:'live',parent:'parent'},false);
  await publishMirroredSession(db,'project','session','tail','parent');
  expect(await labels(db),target+' published').toEqual(expected);
  await db.prepare("UPDATE prompt_batches SET text='poison' WHERE project_id='project'").run();
  expect(await labels(db),target+' poison').toEqual(expected);
  await db.prepare("DELETE FROM prompt_batches WHERE project_id='project'").run();
  expect(await labels(db),target+' gone').toEqual(expected);
 });
},60_000);

it('direct batched count and instant operations include frozen rows with every original table empty',async()=>{
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  const ids=['missing','session'];
  const expected=await sessionCountsFor(db,scope,ids);
  const rail=await listSessionSummaries(db,scope,{fidelity:'any'},2000);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'parent',state:'frozen'});
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'tail',state:'live',parent:'parent'},false);
  await publishMirroredSession(db,'project','session','tail','parent');
  for(const table of ['prompt_batches','responses','tool_calls','plans'])await db.prepare(`DELETE FROM ${table} WHERE project_id=?`).bind(scope.projectId).run();
  expect(await sessionCountsFor(db,scope,ids),target).toEqual(expected);
  expect(await listSessionSummaries(db,scope,{fidelity:'any'},2000),target).toEqual(rail);
 });
},60_000);

