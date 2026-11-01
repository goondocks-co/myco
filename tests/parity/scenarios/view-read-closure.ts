import {expect} from 'bun:test';
import {documentsPublished,expectPersisted,type ParityScenario} from '../harness.ts';
import {selectOwner} from './backup-restore.ts';
import {readTag,runtimeBoundary} from '../../helpers/view-read-contract.ts';
import type {ReadTrace} from '../../helpers/statement-recorder.ts';
import {WORK_SWEEP_MIN_MS} from '@myco-server-worker/core/embedding/work-state.js';

const families=(trace:ReadTrace)=>new Set(trace.statements.flatMap(row=>{const tag=readTag(row.sql);return tag?[tag.operation.split(':')[0]!]:[]}));
export const viewReadClosure:ParityScenario={
 name:'view read closure: actual HTTP MCP scheduled clock alarm and recovery constructors',
 dedicated:{timeoutMs:120000,cloudflare:{embeddingFixture:true},sqliteVec:true},
 async run(target){
  if(!target.readTrace)throw new Error('Target has no common read recorder');
  const traces:ReadTrace[]=[await target.readTrace()];
  await selectOwner(target);
  const stub=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>Response.json({data:[{embedding:[1,0,0,0,0,0,0,0]}]})});
  const owner=async(route:string,method='GET',body?:unknown)=>{
   const response=await fetch(target.url+route,{method,headers:{...target.ownerHeaders(),origin:target.url,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
   const text=await response.text();expect(response.status,method+' '+route+' '+text).toBe(200);
  };
  try{
   const choice=(model:'a'|'b')=>target.name==='selfhosted'?{provider:'openai-compatible',model:'closure-'+model,endpoint:'http://127.0.0.1:'+stub.port}:{provider:'workers-ai',model:model==='a'?'@cf/baai/bge-m3':'@cf/baai/bge-base-en-v1.5'};
   await owner('/api/embedding','PUT',choice('a'));
   traces.push(await target.readTrace());
   await target.clockWake();
   const scheduled=await target.readTrace();traces.push(scheduled);
   expect(runtimeBoundary(scheduled.statements)).toEqual([]);
   const work=families(scheduled);
   for(const family of ['M28','M31','M34'])expect(work.has(family),'scheduled '+family+' got '+[...work].join(',')).toBe(true);
   if(target.name==='cloudflare'){
    const parent=scheduled.spans.find(row=>row.operation==='scheduled'),child=scheduled.spans.find(row=>row.operation==='DeploymentClock.wake');
    expect(parent?.spanId).toBeString();expect(child?.parentSpanId).toBe(parent?.spanId);
    expect(scheduled.statements.some(row=>row.spanId===child?.spanId&&readTag(row.sql)!==null)).toBe(true);
    if(!target.clockAlarm)throw new Error('Target has no controlled real alarm');
    await target.clockAlarm(Date.now()+WORK_SWEEP_MIN_MS+1);const alarm=await target.readTrace();traces.push(alarm);
    const span=alarm.spans.find(row=>row.operation==='DeploymentClock.alarm');
    expect(span?.spanId).toBeString();const wake=alarm.spans.find(row=>row.operation==='DeploymentClock.wake'&&row.parentSpanId===span?.spanId);expect(wake?.spanId).toBeString();expect(alarm.statements.some(row=>row.spanId===wake?.spanId&&readTag(row.sql)!==null)).toBe(true);
    expect(families(alarm).has('M32')).toBe(true);
   }else{
    await target.clockWake(Date.now()+WORK_SWEEP_MIN_MS+1);const sweep=await target.readTrace();traces.push(sweep);expect(families(sweep).has('M32')).toBe(true);
   }
   const session='view-read-closure',prompt=crypto.randomUUID(),response=crypto.randomUUID(),plan=crypto.randomUUID(),tool=crypto.randomUUID(),now=Date.now();
   for(const [kind,payload]of [
    ['session.start',{agent:'copilot',startedAt:now}],
    ['prompt',{promptId:prompt,text:'closurecanary',origin:'user'}],
    ['response',{responseId:response,promptId:prompt,text:'closure response'}],
    ['tool.use',{toolCallId:tool,promptId:prompt,toolName:'Read',input:{path:'closure.ts'},success:true}],
    ['plan',{planKey:plan,promptId:prompt,title:'closure plan',content:'closure plan',status:'active'}],
   ]as const)await expectPersisted(await fetch(target.url+'/events',{method:'POST',headers:target.memberHeaders({'content-type':'application/json'}),body:JSON.stringify({eventId:crypto.randomUUID(),sessionId:session,kind,payload,createdAt:now,channel:'cli',producer:{adapter:'parity',version:'1'}})}),kind);
   traces.push(await target.readTrace());
   if(!target.primeEmbedding)throw new Error('Target has no writer-shaped vector fixture');
   if(target.name==='cloudflare'){if(!target.clockAlarm)throw new Error('Target has no controlled real alarm');await target.clockAlarm(Date.now()+2*WORK_SWEEP_MIN_MS+1);}else await target.clockWake();
   const reconcile=await target.readTrace();traces.push(reconcile);
   expect(reconcile.statements.some(row=>row.phase==='clock'&&readTag(row.sql)?.operation.startsWith('M33:')),'clock-dispatched source reconcile').toBe(true);
   await target.primeEmbedding(target.projectId);
   await owner('/api/embedding/passed-over');
   await owner('/api/embedding/switch/estimate','POST',choice('b'));
   const embedding=await target.readTrace();traces.push(embedding);
   for(const family of ['M33','M35'])expect(families(embedding).has(family),'embedding '+family).toBe(true);
   await owner('/api/embedding/switch','POST',{...choice('b'),confirm:true});
   traces.push(await target.readTrace());
   if(target.name==='cloudflare'){if(!target.clockAlarm)throw new Error('Target has no controlled real alarm');await target.clockAlarm(Date.now()+3*WORK_SWEEP_MIN_MS+1);}else await target.clockWake();
   const switched=await target.readTrace();traces.push(switched);
   expect(switched.statements.some(row=>row.phase==='clock'&&readTag(row.sql)?.operation.startsWith('M35:')),'clock-dispatched switch completion').toBe(true);
   await documentsPublished(target,session);traces.push(await target.readTrace());
   const base='/api/projects/'+target.projectId+'/sessions/'+session;
   for(const route of [base+'/turns',base+'/turns/'+prompt,base+'/turns/'+prompt+'/tool-calls',base+'/activity',base+'/unplaced-records',base+'/plans',base,'/api/projects/'+target.projectId+'/sessions','/api/projects/'+target.projectId+'/search?q=closurecanary&mode=fts'])await owner(route);
   const http=await target.readTrace();traces.push(http);expect(http.statements.filter(row=>readTag(row.sql)!==null).length).toBeGreaterThan(0);
   expect(http.spans.some(row=>row.phase==='entry')).toBe(true);expect(runtimeBoundary(http.statements)).toEqual([]);
   for(const [name,args]of [
    ['myco_sessions',{op:'get',id:session}],
    ['myco_sessions',{op:'list'}],
    ['myco_plans',{op:'get',id:plan}],
    ['myco_search',{query:'closurecanary',mode:'fts'}],
   ]as const){
    const result=await fetch(target.url+'/mcp',{method:'POST',headers:target.memberHeaders({'content-type':'application/json',accept:'application/json, text/event-stream'}),body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{project:target.projectId,...args}}})});
    expect(result.status).toBe(200);const text=await result.text();expect(text).not.toContain('"isError":true');expect(text).not.toContain('"error":');
   }
   const mcp=await target.readTrace();traces.push(mcp);expect(mcp.statements.filter(row=>readTag(row.sql)!==null).length).toBeGreaterThan(0);expect(runtimeBoundary(mcp.statements)).toEqual([]);
   if(target.name==='cloudflare'){
    const constructors=traces.flatMap(row=>row.constructors.map(frame=>frame.operation));
    expect(constructors).toContain('DeploymentClock.constructor');expect(constructors).toContain('RecoveryProducer.constructor');
   }
  }finally{stub.stop(true)}
 },
};
