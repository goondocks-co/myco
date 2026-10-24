import type { CloudflareBindings, DeferredWork } from '../../packages/myco-server/src/platform/cloudflare/env.ts';
import { DeploymentClock as RawDeploymentClock } from '../../packages/myco-server/src/platform/cloudflare/deployment-clock.ts';
import { RecoveryProducer as RawRecoveryProducer } from '../../packages/myco-server/src/platform/cloudflare/recovery-producer-object.ts';
import { statementRecorder,withObservedClock,installReadPreparationBoundary,readPreparationViolations,checkedPreparationOrigin, handledRequestContext as requests, type StatementFrame, type PreparationOrigin } from '../helpers/statement-recorder.ts';
import {VIEW_READ_OPERATIONS,LEGACY_ONLY_OPERATIONS} from '../../packages/myco-server/src/read/view-store.ts';
import { PARITY_REQUEST_HEADER, PARITY_WORKER_HEADER } from './requests.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import {indexFixture} from '../myco-server/helpers/vector-index.ts';
import {EMBEDDING_CATALOGUE} from '../../packages/myco-shared/src/settings-contract.ts';
import {serverEnvFromBindings} from '../../packages/myco-server/src/platform/cloudflare/env.ts';
import {reconcileEmbedding} from '../../packages/myco-server/src/core/embedding/reconcile.ts';
import {cloudflareEmbeddingLaunch} from '../../packages/myco-server/src/platform/cloudflare/embedding-runtime.ts';
import {createServer} from '../../packages/myco-server/src/pipeline.ts';
import type {ServerEnv} from '../../packages/myco-server/src/core/adapters.ts';

const spans = new AsyncLocalStorage<StatementFrame>();
let nextSpan=0;
let embeddingFixture=false;
const fixtureVectors=indexFixture();
export function installObservedEmbeddingFixture(){embeddingFixture=true;}
function fixtureBindings(bindings:CloudflareBindings):CloudflareBindings{
 if(!embeddingFixture)return bindings;
 return {...bindings,VECTORIZE:fixtureVectors,AI:{async run(model,input){
  const size=EMBEDDING_CATALOGUE['workers-ai'].models.find(row=>row.id===model)?.dimensions;
  if(size===undefined||input.text.length!==1)throw new Error('Unknown fixture embedding request');
  return {data:[Array.from({length:size},(_,index)=>index===0?1:0)]};
 }}};
}
export async function primeObservedEmbedding(env:ServerEnv,projectId:string){
 const configured=await env.embeddingProvider?.();
 if(!configured||!env.vectors)throw new Error('Embedding fixture has no configured provider or vector store');
 const maximum=100;
 for(let step=0;step<maximum;step++)if((await reconcileEmbedding({db:env.db,blobs:env.blobs,provider:configured,vectors:env.vectors},projectId,Date.now())).phase==='settled')return;
 throw new Error('Fixture embedding did not settle');
}

/** A local run-control transport serves the canonical embedding runtime under its dispatch span. */
export function installObservedEmbeddingRuntime(env:ServerEnv,pending=new Set<Promise<void>>()){
 const server=createServer({now:()=>Date.now(),sourceOf:()=> '127.0.0.1',fetchImpl:(input,init)=>env.outbound(input,init)});
 const launch=cloudflareEmbeddingLaunch(env.origin!,work=>{
  pending.add(work);void work.finally(()=>pending.delete(work));env.afterResponse(()=>work);
 },{lifetime:'clock',fetcher:(input,init)=>server.handleRequest(new Request(input,init),env)});
 env.harnessTasks=['embedding-reconcile'];env.harnessLaunch=launch;
 return async()=>{while(pending.size)await Promise.all([...pending]);};
}

function runSpan<T>(operation:string,phase:string,parent:StatementFrame|undefined,run:()=>T):T {
 const frame:StatementFrame={operation,phase,spanId:'span-'+String(++nextSpan),...(parent?.spanId?{parentSpanId:parent.spanId}:{})};
 console.log(JSON.stringify({kind:'view_read_span',...frame}));
 return spans.run(frame,run);
}

function observedBindings(bindings:CloudflareBindings, fallback:StatementFrame) {
 bindings=fixtureBindings(bindings);
 const recorder=statementRecorder(bindings.MYCO_DB,{accounting:'d1',context:()=>spans.getStore()??fallback});
 let published=0;
 const flush=async()=>{
  await recorder.drain();
  for(const event of recorder.events.slice(published))console.log(JSON.stringify({kind:'view_read_event',event}));
  published=recorder.events.length;
  for(const statement of recorder.statements)console.log(JSON.stringify({kind:'view_read_statement',...statement}));
  recorder.statements.length=0;
 };
 const clock=bindings.CLOCK;
 const wrappedClock=clock===undefined?undefined:new Proxy(clock,{get(target,key,receiver){
  if(key==='get')return (...args:Parameters<typeof clock.get>)=>{
   const stub=target.get(...args);
   return new Proxy(stub,{get(stub,key,receiver){
    const value=Reflect.get(stub,key,receiver);
    if((key==='wake'||key==='ensure')&&typeof value==='function')return (...args:unknown[])=>Reflect.apply(value,stub,[...args,spans.getStore()]);
    return typeof value==='function'?value.bind(stub):value;
   }});
  };
  const value=Reflect.get(target,key,receiver);
  return typeof value==='function'?value.bind(target):value;
 }});
 return {bindings:{...bindings,MYCO_DB:recorder.db,...(wrappedClock?{CLOCK:wrappedClock}:{})},flush};
}

export {observeHandledException} from '../helpers/statement-recorder.ts';

interface Worker {
  fetch(request: Request, bindings: CloudflareBindings, deferred?: DeferredWork): Promise<Response>;
  scheduled?(event:unknown,bindings:CloudflareBindings):Promise<void>;
}

/** Records Worker entry spans and preserves the request diagnostics. */
export function observedWorker<T extends Worker>(worker: T,origins:readonly Extract<PreparationOrigin,{kind:'exception'}>[]=[]): Omit<T, 'fetch'|'scheduled'> & Worker {
 const options={known:new Set<string>(VIEW_READ_OPERATIONS.map(row=>row.id)),legacy:new Set<string>(LEGACY_ONLY_OPERATIONS),origins:origins.map(checkedPreparationOrigin)};
 installReadPreparationBoundary(statement=>{
  const errors=readPreparationViolations([statement],options);
  if(errors.length)throw new Error(errors.join('\n'));
 });
 return {...worker,
  async fetch(request,bindings,deferred){
   const id=request.headers.get(PARITY_REQUEST_HEADER),path=new URL(request.url).pathname;
   if(id)console.log(JSON.stringify({kind:'parity_request',id,method:request.method,path}));
   const observed=observedBindings(bindings,{operation:'fetch',phase:'entry'});
   const trackedDeferred=deferred===undefined?undefined:{waitUntil(work:Promise<unknown>){deferred.waitUntil(work.finally(observed.flush));}};
   try {
    const response=await requests.run({id,path},()=>runSpan(request.method+' '+path,'entry',undefined,()=>worker.fetch(request,observed.bindings,trackedDeferred)));
    if(!id)return response;
    console.log(JSON.stringify({kind:'parity_response',id,status:response.status}));
    const marked=new Response(response.body,response);marked.headers.set(PARITY_WORKER_HEADER,id);return marked;
   }catch(error){
    console.error(JSON.stringify({kind:'parity_exception',id,path,error:error instanceof Error?error.stack:String(error)}));throw error;
   }finally{await observed.flush();}
  },
  async scheduled(event,bindings){
   if(!worker.scheduled)throw new Error('Observed Worker has no scheduled entry');
   const observed=observedBindings(bindings,{operation:'scheduled',phase:'scheduled'});
   try{return await runSpan('scheduled','scheduled',undefined,()=>worker.scheduled!(event,observed.bindings));}
   finally{await observed.flush();}
  },
 };
}

export class ObservedDeploymentClock extends RawDeploymentClock {
 private readonly flushObservations:()=>Promise<void>;
 private readonly observedEnvironment:ServerEnv;
 private readonly fixtureRuns=new Set<Promise<void>>();
 protected override clockEnv():ServerEnv{
  const env=super.clockEnv();if(embeddingFixture)installObservedEmbeddingRuntime(env,this.fixtureRuns);return env;
 }
 constructor(ctx:DurableObjectState,bindings:CloudflareBindings){
  const frame={operation:'DeploymentClock.constructor',phase:'clock'};
  console.log(JSON.stringify({kind:'view_read_constructor',...frame}));
  const observed=observedBindings(bindings,frame);
  super(ctx,observed.bindings);this.flushObservations=observed.flush;this.observedEnvironment=serverEnvFromBindings(observed.bindings);
 }
 override async wake(parent?:StatementFrame){
  try{return await runSpan('DeploymentClock.wake','clock',parent??spans.getStore(),()=>super.wake());}
  finally{while(this.fixtureRuns.size)await Promise.all([...this.fixtureRuns]);await this.flushObservations();}
 }
 override async ensure(parent?:StatementFrame){
  try{return await runSpan('DeploymentClock.ensure','clock',parent??spans.getStore(),()=>super.ensure());}
  finally{await this.flushObservations();}
 }
 override async alarm(){
  try{return await runSpan('DeploymentClock.alarm','clock',spans.getStore(),()=>super.alarm());}
  finally{await this.flushObservations();}
 }
 async observeAlarm(at?:number){return withObservedClock(at,()=>this.alarm());}
 async observeEmbedding(projectId:string){try{return await runSpan('DeploymentClock.embedding-fixture','direct',undefined,()=>primeObservedEmbedding(this.observedEnvironment,projectId));}finally{await this.flushObservations();}}
}

export class ObservedRecoveryProducer extends RawRecoveryProducer {
 private readonly flushObservations:()=>Promise<void>;
 constructor(ctx:DurableObjectState,bindings:CloudflareBindings){
  const frame={operation:'RecoveryProducer.constructor',phase:'P'};
  console.log(JSON.stringify({kind:'view_read_constructor',...frame}));
  const observed=observedBindings(bindings,frame);
  super(ctx,observed.bindings);this.flushObservations=observed.flush;
 }

 override async admit(...args:Parameters<RawRecoveryProducer['admit']>){
  try{return await runSpan('RecoveryProducer.admit','P',spans.getStore(),()=>super.admit(...args));}
  finally{await this.flushObservations();}
 }

 override async continue(...args:Parameters<RawRecoveryProducer['continue']>){
  try{return await runSpan('RecoveryProducer.continue','P',spans.getStore(),()=>super.continue(...args));}
  finally{await this.flushObservations();}
 }

 override async settleHold(...args:Parameters<RawRecoveryProducer['settleHold']>){
  try{return await runSpan('RecoveryProducer.settleHold','P',spans.getStore(),()=>super.settleHold(...args));}
  finally{await this.flushObservations();}
 }

 override async forgetUnsettledExport(...args:Parameters<RawRecoveryProducer['forgetUnsettledExport']>){
  try{return await runSpan('RecoveryProducer.forgetUnsettledExport','P',spans.getStore(),()=>super.forgetUnsettledExport(...args));}
  finally{await this.flushObservations();}
 }

 override async status(...args:Parameters<RawRecoveryProducer['status']>){
  try{return await runSpan('RecoveryProducer.status','P',spans.getStore(),()=>super.status(...args));}
  finally{await this.flushObservations();}
 }

 override async noteSchemaDrift(...args:Parameters<RawRecoveryProducer['noteSchemaDrift']>){
  try{return await runSpan('RecoveryProducer.noteSchemaDrift','P',spans.getStore(),()=>super.noteSchemaDrift(...args));}
  finally{await this.flushObservations();}
 }

 override async pendingStagingPrunes(...args:Parameters<RawRecoveryProducer['pendingStagingPrunes']>){
  try{return await runSpan('RecoveryProducer.pendingStagingPrunes','P',spans.getStore(),()=>super.pendingStagingPrunes(...args));}
  finally{await this.flushObservations();}
 }

 override async pruneStagings(...args:Parameters<RawRecoveryProducer['pruneStagings']>){
  try{return await runSpan('RecoveryProducer.pruneStagings','P',spans.getStore(),()=>super.pruneStagings(...args));}
  finally{await this.flushObservations();}
 }

 override async stagedKey(...args:Parameters<RawRecoveryProducer['stagedKey']>){
  try{return await runSpan('RecoveryProducer.stagedKey','P',spans.getStore(),()=>super.stagedKey(...args));}
  finally{await this.flushObservations();}
 }
}
