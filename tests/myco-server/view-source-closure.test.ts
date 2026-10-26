import {expect,it} from 'bun:test';
import {getPlan} from '@myco-server-worker/read/plans.js';
import {getSession} from '@myco-server-worker/read/sessions.js';
import {listTurns} from '@myco-server-worker/read/turns.js';
import {withViewReadResponse} from '@myco-server-worker/read/view-store.js';
import {captureViewSession,withViewStores} from './helpers/view-stores.js';
import {mirrorViewSession,publishMirroredSession,setSyntheticInstanceState,setViewLayerValues,clearViewSourceIdentity} from './helpers/view-instances.js';
import {statementRecorder} from '../helpers/statement-recorder.js';
import {uuid} from './helpers/fixtures.js';
import {seedViewConsumerWorld,mirrorConsumerWorld,mutateOriginalWorld} from './helpers/view-worlds.js';

import {countUnplacedContextRecords} from '@myco-server-worker/read/hook-placement.js';
import {viewReadRefusalFinding} from '@myco-server-worker/core/attention-state.js';
import {appendCostHistory,COST_MATERIALS,deliveryProbeMultiplicity} from './helpers/view-read-costs.js';
import {composePromptContext,recallLeaves,answerDeliveredStatement} from '@myco-server-worker/core/recall.js';
import {sessionWriteAdmission} from '@myco-server-worker/ingest/projections.js';
import {statusMetadata} from '@myco-server-worker/read/meta.js';

const scope={projectId:'project'};
it('a held published session permits a fresh view-only record from another session',async()=>{
 await withViewStores(async(db,target)=>{
  for(const [sessionId,idOffset]of [['a',0],['b',100]] as const){
   await captureViewSession(db,'project',sessionId,{idOffset});
   await mirrorViewSession(db,{...scope,sessionId,instanceId:sessionId,state:'live'});
   await publishMirroredSession(db,'project',sessionId,sessionId);
  }
  await mutateOriginalWorld(db,'gone');
  await withViewReadResponse(db,()=>1,async bound=>{
   expect(await getSession(bound,scope,'a')).not.toBeNull();
   expect((await getPlan(bound,scope,uuid(150)))?.content,target).toBe('factcanary');
  });
 });
},60_000);
it('cold record admissions reuse a held session closure after every original is gone',async()=>{
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  await captureViewSession(db,'project','session',{idOffset:100});
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'live',state:'live'});
  await publishMirroredSession(db,'project','session','live');
  await mutateOriginalWorld(db,'gone');
  const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',captureRows:true});
  const rows=await withViewReadResponse(observed.db,()=>1,async bound=>{
   expect(await getSession(bound,scope,'session'),target+' session admission').not.toBeNull();
   return Promise.all([getPlan(bound,scope,uuid(50)),getPlan(bound,scope,uuid(150))]);
  });
  expect(rows.map(row=>row?.content),target).toEqual(['factcanary','factcanary']);
  const captures=observed.statements.flatMap(row=>row.rows??[]).filter(row=>typeof row==='object'&&row!==null&&'__myco_capture'in row&&row.__myco_capture!=null);
  expect(captures,target+' one returned visibility set').toHaveLength(1);
 });
},60_000);
it('concurrent record admissions share the first stored closure without a second physical visibility read',async()=>{
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  await captureViewSession(db,'project','session',{idOffset:100});
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'live',state:'live'});
  await publishMirroredSession(db,'project','session','live');
  const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',captureRows:true});
  const values=await withViewReadResponse(observed.db,()=>1,bound=>Promise.all([getPlan(bound,scope,uuid(50)),getPlan(bound,scope,uuid(150))]));
  expect(values.every(row=>row?.content==='factcanary')).toBe(true);
  const candidates=observed.statements.filter(row=>row.sql.includes('AS __myco_capture'));
  const captures=candidates.flatMap(row=>row.rows??[]).filter(row=>typeof row==='object'&&row!==null&&'__myco_capture'in row&&row.__myco_capture!=null);
  expect(captures,target+' returned closures').toHaveLength(1);
  expect(candidates).toHaveLength(2);
  expect(candidates[1]!.sql).toContain("CASE WHEN candidate.session_id IN ('session') THEN NULL");
  if(target==='D1')expect(candidates[1]!.rowsRead,target+' known-source fact and zero-row guard only').toBe(2);
 });
},60_000);

it('separate response contexts retain different published sources across a flip',async()=>{
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'first',state:'live'});
  await setViewLayerValues(db,'project','first','first source');
  await publishMirroredSession(db,'project','session','first');
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'second',state:'building'});
  await setViewLayerValues(db,'project','second','second source');
  await withViewReadResponse(db,()=>1,async first=>{
   expect((await getPlan(first,scope,uuid(50)))?.content).toBe('first source');
   await publishMirroredSession(db,'project','session','second');
   await withViewReadResponse(db,()=>2,async second=>{
    expect((await getPlan(second,scope,uuid(50)))?.content,target).toBe('second source');
    expect((await getPlan(first,scope,uuid(50)))?.content,target).toBe('first source');
   });
  });
 });
},60_000);

it('building headers and missing stored source coordinates refuse with named codes',async()=>{
 await withViewStores(async(db,target)=>{
  await captureViewSession(db);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'live',state:'live'});
  await publishMirroredSession(db,'project','session','live');
  await setSyntheticInstanceState(db,'project','live','building');
  await expect(listTurns(db,scope,'session')).rejects.toMatchObject({code:'view_state_inconsistent'});
  await setSyntheticInstanceState(db,'project','live','live');
  expect((await getPlan(db,scope,uuid(50)))?.content,target).toBe('factcanary');
  await clearViewSourceIdentity(db,'project','live');
  await expect(getPlan(db,scope,uuid(50))).rejects.toMatchObject({code:'view_source_identity_missing'});
 });
},60_000);

it('M21 count statements retain absent and published sources in every scope across a flip',async()=>{
 const evidence:{target:string;mode:string;scope:string;before:number;actual:number;after:number}[]=[];
 for(const mode of ['absent','published','all-placed'])for(const selection of ['all','project','session']){
  await withViewStores(async(db,target)=>{
   await seedViewConsumerWorld(db);
   const issued=await captureViewSession(db,'project','session',{idOffset:47978});
   if(mode==='all-placed')await appendCostHistory(db,{projectId:'project',sessionId:'session',tokenId:issued.tokenId,material:COST_MATERIALS[0],from:0,through:1,idBase:47998,parser:false});
   if(mode!=='absent')await mirrorConsumerWorld(db);
   const project=selection==='all'?undefined:scope,session=selection==='session'?'session':undefined;
   const before=await countUnplacedContextRecords(db,project,session,700);
   await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'empty-next',state:'building'},false);
   let changed=false;
   const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',captureRows:true,
    after:async row=>{
     if(!changed&&row.sql.startsWith('/*vs:M21:')&&row.sql.includes("'receipt:'")){
      changed=true;await publishMirroredSession(db,'project','session','empty-next');
     }
    },
   });
   const actual=await withViewReadResponse(observed.db,()=>700,bound=>countUnplacedContextRecords(bound,project,session,700));
   const after=await countUnplacedContextRecords(db,project,session,700);
   evidence.push({target,mode,scope:selection,before,actual,after});
   expect(before,target+' nonzero original world').toBe(mode==='all-placed'?0:1);
   expect(after,target+' different complete source').toBe(3);
   expect(actual,target+' '+mode+' '+selection).toBe(before);
   expect(observed.statements.map(row=>row.method)).toEqual(['first','first']);
  });
 }
 console.info('M21_FLIP_EVIDENCE',JSON.stringify(evidence));
},60_000);

it('M21 delivery counts refuse a malformed captured parent',async()=>{
 const evidence:unknown[]=[];
 await withViewStores(async(db,target)=>{
  await seedViewConsumerWorld(db);await mirrorConsumerWorld(db);
  await mirrorViewSession(db,{...scope,sessionId:'session',instanceId:'broken-tail',state:'live',parent:'world-parent-session'},false);
  await publishMirroredSession(db,'project','session','broken-tail');
  let result:unknown;
  try{result=await withViewReadResponse(db,()=>700,bound=>countUnplacedContextRecords(bound,scope,'session',700))}catch(error){result=error}
  expect(viewReadRefusalFinding((await statusMetadata(db)).viewReadRefusal,700)).toMatchObject({refusals:1,kind:'view_state_inconsistent'});
  evidence.push({target,result});
 });
 console.info('M21_HEADER_EVIDENCE',JSON.stringify(evidence));
 for(const row of evidence as {target:string;result:unknown}[])expect(row.result,row.target).toMatchObject({code:'view_state_inconsistent'});
},60_000);


it('M21 capture probes retain their derived per-delivery multiplicities',async()=>{
 await withViewStores(async(db,target)=>{
  await seedViewConsumerWorld(db);await mirrorConsumerWorld(db);
  const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',captureRows:true});
  await withViewReadResponse(observed.db,()=>700,bound=>countUnplacedContextRecords(bound,scope,undefined,700));
  expect(observed.statements).toHaveLength(2);
  for(const [index,query]of observed.statements.entries()){
   const result=await deliveryProbeMultiplicity(db,query);
   expect(result.errors,target+'/'+index).toEqual([]);
   expect(result.captureExpressions).toBeGreaterThan(0);
   const row=query.rows?.[0];
   expect(typeof row).toBe('object');
   if(typeof row!=='object'||row===null||!('__myco_aggregate_sources'in row))throw new Error('Missing aggregate carrier');
   const raw=row.__myco_aggregate_sources;
   if(typeof raw!=='string')throw new Error('Missing aggregate owner JSON');
   const owners:unknown=JSON.parse(raw);
   if(!Array.isArray(owners))throw new Error('Missing delivery owners');
   const deliveries=owners.length,instances=2;
   const bounds={publication:deliveries*result.probes.publication,visible:deliveries*result.probes.visible*instances,
    header:deliveries*result.probes.header*instances,checkpoint:deliveries*result.probes.checkpoint*instances};
   if(target==='D1')expect(query.rowsRead).toBeGreaterThan(0);else expect(query.rowsRead).toBeUndefined();
   console.info('M21_PROBE_MULTIPLICITY',JSON.stringify({target,index,deliveries,instances,probes:result.probes,scalarDefinitions:result.scalarDefinitions,scalarMultiplicity:result.scalarMultiplicity,bounds,rowsRead:query.rowsRead??null,
    units:'structural upper bounds per statement; checkpoint bound counts indexed ranges, with transcript work per checkpoint'}));
   const extra={...query,sql:query.sql.replace(/^\/\*vs:[^*]+\*\//,'').replace('AS __myco_aggregate_sources','AS __myco_aggregate_sources, (SELECT COUNT(*) FROM view_visible) AS __probe')};
   expect((await deliveryProbeMultiplicity(db,extra)).errors.some(error=>error.includes('unbounded capture scan'))).toBe(true);
  }
 });
},60_000);


it('M21 validates an owner first encountered by the second delivery source',async()=>{
 await withViewStores(async(db,target)=>{
  await seedViewConsumerWorld(db);
  await captureViewSession(db,'project','answer-owner',{idOffset:100000});
  const admission=sessionWriteAdmission({projectId:'project',machineId:'machine'},'answer-owner');
  const answer=await composePromptContext(db,scope,recallLeaves({'cortex.spores.inject_on_prompt_submit':false}),true,
   {sessionId:'answer-owner',text:'let us write the implementation plan',now:700,admission,promptId:null,scopeReason:'absent_key'});
  if(!answer.answerId||answer.receiptId!==undefined)throw new Error('Receipt-free answer missing');
  await answerDeliveredStatement(db,{projectId:'project',sessionId:'answer-owner',id:answer.answerId,at:700,promptId:null,scopeReason:'absent_key'},admission.admission).run();
  await mirrorViewSession(db,{...scope,sessionId:'answer-owner',instanceId:'answer-parent',state:'frozen'});
  await mirrorViewSession(db,{...scope,sessionId:'answer-owner',instanceId:'answer-tail',state:'live',parent:'answer-parent'},false);
  await publishMirroredSession(db,'project','answer-owner','answer-tail');
  for(const [index,project]of [undefined,scope].entries()){
   const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native',captureRows:true});
   await expect(withViewReadResponse(observed.db,()=>700+index,bound=>countUnplacedContextRecords(bound,project,undefined,700)))
    .rejects.toMatchObject({code:'view_state_inconsistent',source:{sessionId:'answer-owner'}});
   const queries=observed.statements.filter(row=>row.sql.startsWith('/*vs:M21:'));
   expect(queries.map(row=>row.method)).toEqual(['first','first']);
   const names=queries.map(row=>{
    const value=row.rows?.[0];
    if(typeof value!=='object'||value===null||!('__myco_aggregate_sources'in value)||typeof value.__myco_aggregate_sources!=='string')throw new Error('Missing aggregate owners');
    const owners:unknown=JSON.parse(value.__myco_aggregate_sources);
    if(!Array.isArray(owners))throw new Error('Missing aggregate owner list');
    return owners.map(owner=>owner.sessionId);
   });
   expect(names[0]).not.toContain('answer-owner');
   expect(names[1]).toContain('answer-owner');
   expect(viewReadRefusalFinding((await statusMetadata(db)).viewReadRefusal,700+index),target).toMatchObject({refusals:index+1});
  }
 });
},60_000);
