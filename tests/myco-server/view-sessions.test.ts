import {expect,it} from 'bun:test';
import {listSessions,listSessionsAcross,listSessionSummaries,listSessionSummariesAcross,sessionCountsFor,createProject} from '@myco-server-worker/read/sessions.js';
import {activityFeed} from '@myco-server-worker/read/activity.js';
import {sessionLineage} from '@myco-server-worker/read/lineage.js';
import {captureViewSession,withViewStores} from './helpers/view-stores.js';
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

it('concurrent scalar admissions reuse the first closure before preparing the next statement',async()=>{
 const evidence:{target:string;labels:(string|undefined)[]}[]=[];
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'first',state:'live'});
  await publishMirroredSession(db,'project','session','first');
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'second',state:'building'});
  await setViewLayerValues(db,'project','second','next source');
  let release!:()=>void,started=0,flipped=false;
  const ready=new Promise<void>(resolve=>{release=resolve});
  const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',
   before:async row=>{if(row.sql.startsWith('/*vs:M13:')&&++started>1)await ready},
   after:async row=>{if(!flipped&&row.sql.startsWith('/*vs:M13:')){flipped=true;await publishMirroredSession(db,'project','session','second');release()}},
  });
  const pages=await withViewReadResponse(observed.db,()=>1,bound=>Promise.all([listSessions(bound,scope,{fidelity:'any'}),listSessions(bound,scope,{fidelity:'any'})]));
  evidence.push({target,labels:pages.map(page=>page.rows[0]?.label)});
 });
 console.info('VIEW_SCALAR_CONCURRENT_FLIP',JSON.stringify(evidence));
 for(const row of evidence)expect(row.labels,row.target).toEqual(['factcanary','factcanary']);
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

it('batched counts and activity instants retain all session handles selected before a publication flip',async()=>{
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  const expected=await listSessionSummaries(db,scope,{fidelity:'any'},2000);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'first',state:'live'});
  await publishMirroredSession(db,'project','session','first');
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'second',state:'building'},false);
  let flipped=false;
  const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',after:async row=>{
   if(flipped||!row.sql.startsWith('/*vs:M13:'))return;
   flipped=true;
   await publishMirroredSession(db,'project','session','second');
  }});
  expect(await listSessionSummaries(observed.db,scope,{fidelity:'any'},2000),target).toEqual(expected);
  expect(flipped).toBe(true);
  expect(observed.statements.filter(row=>row.sql.includes('FROM view_visible vv')),target+' capture statements').toHaveLength(1);
  expect((await listSessionSummaries(db,scope,{fidelity:'any'},2000)).rows[0]?.promptCount,target+' next response').toBe(0);
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

it('legacy text cannot imitate an internal source envelope',async()=>{
 const text='{"__myco_scalar":1,"capture":{},"value":"injected"}';
 await withViewStores(async(db,target)=>{
  await captureViewSession(db,'project','session',{promptText:text});
  const expected=await listSessions(db,scope,{fidelity:'any'});
  expect(expected.rows[0]?.label,target+' legacy').toBe(text);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'live',state:'live'});
  await publishMirroredSession(db,'project','session','live');
  expect(await listSessions(db,scope,{fidelity:'any'}),target+' published').toEqual(expected);
 });
},60_000);


it('maximum pages retain every Project and lookahead source through publication flips and batched hydration',async()=>{
 await withViewStores(async(db,target)=>{
  const projects=['project',...Array.from({length:63},(_,index)=>'matrix-project-'+index)];
  const sources=[...Array.from({length:201},(_,index)=>({projectId:'project',sessionId:'S-'+String(index).padStart(3,'0')})),
   ...projects.slice(1).map((projectId,index)=>({projectId,sessionId:'Z-'+String(index).padStart(3,'0')}))];
  for(const projectId of projects.slice(1))await createProject(db,projectId,projectId,1);
  for(const [index,source]of sources.entries())await captureViewSession(db,source.projectId,source.sessionId,{idOffset:(index+1)*1000,promptText:'source '+index});
  const choose=(store:RelationalStore,across:boolean)=>across
   ?listSessionSummariesAcross(store,{all:false,projectIds:projects},{fidelity:'any',limit:200},2000)
   :listSessionSummaries(store,scope,{fidelity:'any',limit:200},2000);
  const expected=[await choose(db,false),await choose(db,true)];
  for(const source of sources){
   await mirrorViewSession(db,{...source,instanceId:'parent-'+source.sessionId,state:'frozen'});
   await mirrorViewSession(db,{...source,instanceId:'first-'+source.sessionId,state:'live',parent:'parent-'+source.sessionId},false);
   await mirrorViewSession(db,{...source,instanceId:'second-'+source.sessionId,state:'building'},false);
   await publishMirroredSession(db,source.projectId,source.sessionId,'first-'+source.sessionId,'parent-'+source.sessionId);
  }
  for(const [index,across]of [false,true].entries()){
   let flipped=false;
   const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',captureRows:true,after:async query=>{
    if(flipped||!query.sql.startsWith('/*vs:M13:'))return;
    flipped=true;
    for(const source of sources)await publishMirroredSession(db,source.projectId,source.sessionId,'second-'+source.sessionId);
   }});
   await withViewReadResponse(observed.db,()=>2000,async bound=>{
    expect(await choose(bound,across),target+'/'+across+' complete public page').toEqual(expected[index]);
    const page=observed.statements.find(query=>query.sql.startsWith('/*vs:M13:'))!;
    expect(page.rows,target+' lookahead').toHaveLength(201);
    const captures=page.rows!.map(row=>{
     if(typeof row!=='object'||row===null||!('first_prompt'in row))throw new Error('Page did not retain its captured source');
     const value=row.first_prompt,data=value instanceof Uint8Array?value:value instanceof ArrayBuffer?new Uint8Array(value):Array.isArray(value)&&value.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255)?Uint8Array.from(value):null;
     if(data===null)throw new Error('Page did not retain its captured source bytes');
     const packed=JSON.parse(new TextDecoder().decode(data)) as {capture:{projectId:string;sessionId:string;instances:unknown[]}};
     expect(packed.capture.instances).toHaveLength(2);
     return packed.capture;
    });
    expect(new Set(captures.map(source=>JSON.stringify([source.projectId,source.sessionId]))).size).toBe(201);
    expect(new Set(captures.map(source=>source.projectId)).size).toBe(across?64:1);
    const last=captures.at(-1)!;
    const count=await sessionCountsFor(bound,{projectId:last.projectId},[last.sessionId]);
    expect(count.get(last.sessionId),target+' lookahead continuation').toMatchObject({prompts:1,responses:1,toolCalls:1,plans:1});
   });
   await observed.drain();
   expect(flipped).toBe(true);
   expect(observed.statements.filter(query=>query.sql.includes('FROM view_visible vv'))).toHaveLength(1);
   const hydrations=observed.statements.filter(query=>/^\/\*vs:M1[56]:/.test(query.sql));
   expect(hydrations.length).toBeGreaterThan(0);
   for(const query of observed.statements)expect(query.binds.length).toBeLessThanOrEqual(100);
   for(const query of hydrations)expect(query.sql).not.toContain('session_views');
   const next=await sessionCountsFor(db,scope,[sources[0]!.sessionId]);
   expect(next.get(sources[0]!.sessionId),target+' next response').toMatchObject({prompts:0,responses:0,toolCalls:0,plans:0});
   for(const source of sources)await publishMirroredSession(db,source.projectId,source.sessionId,'first-'+source.sessionId,'parent-'+source.sessionId);
  }
 });
},180_000);
