import {Database} from 'bun:sqlite';
import {sqliteRelationalStore} from '@myco-server-worker/platform/bun/sqlite.js';
import type {PreparedStatement} from '@myco-server-worker/core/adapters.js';
import {statementRecorder,withReadPreparation} from '../helpers/statement-recorder.js';
import {createHash} from 'node:crypto';
import {expect,test,spyOn} from 'bun:test';
import legacy from './fixtures/view-read-legacy.json';
import {legacyExecutionCases,legacyVariants,legacyApplicability,legacyReceiptReferences,legacyReferencedEvents,legacyCIVariants,withFrozenCIOracle,withFrozenOracle,frozenListingReaders,executeListingVariant,executeReadVariant,frozenReadPort,currentReadPort,seedLegacyFixture,seedLegacyPromptArity,seedLegacyCISwitch,legacyCISwitchReads,seedLegacyCIResults,legacyCIResultReads,seedLegacyPublicFixture,legacyBodyBlobs,legacyPublicRequests,legacyPublicServer,type LegacyVariant} from '../helpers/view-read-legacy-fixtures.js';
import {createProject} from '@myco-server-worker/read/sessions.js';
import {SCHEMA_STEPS} from '@myco-server-worker/db/schema.js';
import type {StatementEvent} from '../helpers/statement-recorder.js';
import {significantRead,protectedSql,readTag,runtimeBoundary} from '../helpers/view-read-contract.js';
import {withViewStores,withViewStorePair} from './helpers/view-stores.js';
import {gunzipSync} from 'node:zlib';
import {LEGACY_ONLY_OPERATIONS} from '@myco-server-worker/read/view-store.js';
import {AssertionError} from 'node:assert';
import {ToolError} from '@myco-server-worker/mcp/validate.js';
import {uuid} from './helpers/fixtures.js';

const fullReplay=process.env.MYCO_VIEW_READ_FULL==='1';

test('legacy read execution matches independent base bytes, methods, order and D1 accounting',async()=>{
 await withViewStores(async(db,target)=>{
  if(target!=='native' && target!=='D1')throw new Error('Unknown execution target');
  const observed=await legacyExecutionCases(db,target);
  const frozen: Record<string, { bytes: string; statements: {text:number;binds:unknown[];method:string;rowsRead?:number}[] }> = legacy.calibration.cases[target];
  expect(Object.keys(observed)).toEqual(Object.keys(frozen));
  for(const [name,actual]of Object.entries(observed)){
   const expected=frozen[name]!;
   expect({name,bytes:actual.bytes}).toEqual({name,bytes:expected.bytes});
   expect<unknown>(actual.statements.map(statement=>({sql:readTag(statement.sql)===null ? (()=>{expect(protectedSql(statement.sql),name+' untagged protected statement').toBe(false);return statement.sql})() : significantRead(statement.sql),binds:statement.binds,method:statement.method,...(statement.rowsRead===undefined?{}:{rowsRead:statement.rowsRead})})),name)
    .toEqual(expected.statements.map(statement=>({sql:legacy.calibration.statementText[statement.text],binds:statement.binds,method:statement.method,...(statement.rowsRead===undefined?{}:{rowsRead:statement.rowsRead})})));
  }
 });
},30000);

test('canonical generator covers the frozen complete census domain and every per-family digest',()=>{
 const whole=createHash('sha256');
 const families=new Map<string,{count:number;digest:ReturnType<typeof createHash>}>();
 for(const variant of legacyVariants()) {
  const bytes=JSON.stringify(variant)+'\n';
  whole.update(bytes);
  const held=families.get(variant.family)??{count:0,digest:createHash('sha256')};
  held.count++;held.digest.update(bytes);families.set(variant.family,held);
 }
 expect([...families.values()].reduce((sum,row)=>sum+row.count,0)).toBe(legacy.domain.cases);
 expect(whole.digest('hex')).toBe(legacy.domain.sha256);
 expect(Object.fromEntries([...families].map(([id,row])=>[id,{cases:row.count,sha256:row.digest.digest('hex')}]))).toEqual(legacy.domain.familyDigests);
},30000);

test('exact-base applicability counts every tuple and rejects N/A execution',async()=>{
 const families:Record<string,{enumerated:number;applicable:number;na:number}>={},m30:unknown[]=[],reasons:Record<string,number>={};
 const sqlite=new Database(':memory:');
 try{for(const variant of legacyVariants()){
  const applicability=legacyApplicability(variant),row=families[variant.family]??={enumerated:0,applicable:0,na:0};
  row.enumerated++;row[applicability.applicable?'applicable':'na']++;
  if(variant.family==='M30')m30.push({id:variant.id,...applicability});
  if(!applicability.applicable){
   reasons[applicability.reason]=(reasons[applicability.reason]??0)+1;
   let calls=0;
   await expect(executeReadVariant(sqliteRelationalStore(sqlite),variant,()=>{calls++;throw new Error('N/A reached a sink')})).rejects.toThrow('N/A census case '+variant.id);
   expect(calls).toBe(0);
  }
 }}finally{sqlite.close()}
 expect(families).toEqual(legacy.applicability.families);
 expect(m30).toEqual(legacy.applicability.M30.cases);
 expect(reasons).toEqual(legacy.applicability.M30.reasons);
 expect(createHash('sha256').update(m30.map(row=>JSON.stringify(row)+'\n').join('')).digest('hex')).toBe(legacy.applicability.M30.sha256);
 expect(Object.values(families).reduce((n,r)=>n+r.enumerated,0)).toBe(legacy.applicability.enumerated);
 expect(Object.values(families).reduce((n,r)=>n+r.applicable,0)).toBe(legacy.applicability.applicable);
 expect(Object.values(families).reduce((n,r)=>n+r.na,0)).toBe(legacy.applicability.na);
},30000);

test('native recording preserves first-row execution and records every prepare, bind and method',async()=>{
 const sqlite=new Database(':memory:');
 try {
  const source=sqliteRelationalStore(sqlite);
  let firstCalls=0,allCalls=0;
  const wrap=(statement:PreparedStatement):PreparedStatement=>({
   ...statement,
   bind:(...values)=>wrap(statement.bind(...values)),
   first:<T,>()=>{firstCalls++;return statement.first<T>()},
   all:<T,>()=>{allCalls++;return statement.all<T>()},
  });
  const recorder=statementRecorder({prepare:sql=>wrap(source.prepare(sql)),batch:source.batch},{accounting:'native'});
  const result=await recorder.db.prepare('SELECT ? AS n UNION ALL SELECT 2 AS n').bind(1).first<{n:number}>();
  expect(result).toEqual({n:1});
  expect({firstCalls,allCalls}).toEqual({firstCalls:1,allCalls:0});
  expect(recorder.events.map(event=>({kind:event.kind,method:event.method,binds:event.binds}))).toEqual([
   {kind:'prepare',method:undefined,binds:[]},
   {kind:'bind',method:undefined,binds:[1]},
   {kind:'execute',method:'first',binds:[1]},
  ]);
  await recorder.drain();
  expect(recorder.statements).toHaveLength(1);
 }finally{sqlite.close()}
});

test.skipIf(!fullReplay)('frozen program replays representative SQL through the exact-base text table on native and D1',async()=>{
 await withFrozenOracle(async oracle=>{
  expect(oracle.textCount).toBe(legacy.statementText.count);
  const readers=frozenListingReaders(oracle),representatives=new Map<string,LegacyVariant>();
  for(const variant of legacyVariants())if(['M13','M14','M24','M25'].includes(variant.family)&&!representatives.has(variant.family))representatives.set(variant.family,variant);
  await withViewStores(async(db,target)=>{
   if(target!=='native'&&target!=='D1')throw new Error('Unknown replay target');
   await legacyExecutionCases(db,target);
   for(const variant of representatives.values()){
    const baseline=statementRecorder(db,{accounting:target==='native'?'native':'d1'});
    const current=statementRecorder(db,{accounting:target==='native'?'native':'d1'});
    const expected=await executeListingVariant(oracle.replayStore(baseline.db),variant,readers);
    const actual=await executeListingVariant(current.db,variant);
    expect(JSON.stringify(actual),target+' '+variant.id).toBe(JSON.stringify(expected));
    expect<unknown>(current.statements.map(row=>({sql:readTag(row.sql)?significantRead(row.sql):row.sql,binds:row.binds,method:row.method,rowsRead:row.rowsRead})))
     .toEqual(baseline.statements.map(row=>({sql:row.sql,binds:row.binds,method:row.method,rowsRead:row.rowsRead})));
   }
  });
 });
},120000);

function eventIdentity(events:readonly StatementEvent[],tagged:boolean){
 return events.map(event=>({kind:event.kind,sql:tagged&&readTag(event.sql)?significantRead(event.sql):event.sql,binds:event.binds,...(event.method?{method:event.method}:{}),...(event.failed?{failed:true}:{})}));
}
async function operationOutcome(work:()=>Promise<unknown>){
 try{return {bytes:JSON.stringify(await work(),(_,value)=>value instanceof Map?[...value]:value instanceof Set?[...value]:value)}}
 catch(error){
  if(!(error instanceof Error))throw error;
  if(process.env.MYCO_VIEW_READ_DIAGNOSTICS==='1'||fullReplay)console.error(error.stack);
  if(error instanceof AssertionError||error instanceof TypeError||error instanceof ReferenceError)throw error;
  const code='code'in error?error.code:undefined;
  const provider=/^D1_ERROR\b/.test(error.message)||typeof code==='string'&&/^SQLITE_/.test(code);
  const refusal=error.name==='ToolError'&&['invalid_input','unknown_tool','not_served','tool_call_failed'].includes(String(code));
  if(!provider&&!refusal)throw error;
  return {error:{name:error.name,message:error.message,...('code'in error?{code:error.code}:{}),...('errno'in error?{errno:error.errno}:{})}};
 }
}
function bundledFieldRefusal(variant:LegacyVariant):boolean{
 return variant.family==='M26'&&variant.case.kind==='tool-input'&&variant.case.storage==='bundle'&&variant.case.stage==='field';
}
async function variantOutcome(variant:LegacyVariant,work:()=>Promise<unknown>){
 if(!bundledFieldRefusal(variant))return operationOutcome(work);
 return assertedBundleFieldRefusal(work);
}
async function assertedBundleFieldRefusal(work:()=>Promise<unknown>){
 let thrown:unknown;
 try{await work();}catch(error){thrown=error;}
 if(!(thrown instanceof Error))throw new Error('Bundled field must refuse without its complete body');
 if(fullReplay)console.error(thrown.stack);
 const error={name:thrown.name,message:thrown.message,...('code'in thrown?{code:thrown.code}:{}),...('errno'in thrown?{errno:thrown.errno}:{})};
 expect(error).toEqual({name:'Error',message:'Processed tool input has a truncated prefix without its complete body'});
 return {error};
}
test('outcome comparison refuses harness errors and admits only provider or coded product errors',async()=>{
 for(const error of [new Error('uncoded failure'),new Error('Processed tool input has a truncated prefix without its complete body'),new TypeError('harness type error'),new AssertionError({message:'false == true'}),new AssertionError({message:'D1_ERROR: assertion failure'})]){
  await expect(operationOutcome(async()=>{throw error})).rejects.toBe(error);
 }
 expect(await operationOutcome(async()=>{throw new ToolError('not_served','refused')})).toEqual({error:{name:'ToolError',message:'refused',code:'not_served'}});
 const sqlite=Object.assign(new Error('constraint'),{code:'SQLITE_CONSTRAINT'});
 expect(await operationOutcome(async()=>{throw sqlite})).toEqual({error:{name:'Error',message:'constraint',code:'SQLITE_CONSTRAINT'}});
 await expect(assertedBundleFieldRefusal(async()=>{throw Object.assign(new Error('Processed tool input has a truncated prefix without its complete body'),{code:'unexpected_failure'});})).rejects.toThrow();
});
function d1DiagnosticOutcome(outcome:Awaited<ReturnType<typeof operationOutcome>>,events:readonly StatementEvent[]){
 if(!outcome.error)return outcome;
 const failed=events.findLast(event=>event.failed);
 if(!failed||!readTag(failed.sql))return outcome;
 const tag='/*vs:'+readTag(failed.sql)!.operation+'*/';
 if(!failed.sql.startsWith(tag))throw new Error('Noncanonical leading read tag');
 return {...outcome,error:{...outcome.error,message:outcome.error.message.replace(/at offset (\d+)/g,(_,offset:string)=>'at offset '+(Number(offset)-Buffer.byteLength(tag)))}};
}
test('D1 diagnostics admit exactly the canonical leading tag byte offset',async()=>{
 const original=await operationOutcome(async()=>{throw new Error('D1_ERROR: no such column: prompt_id at offset 1336: SQLITE_ERROR')});
 const sql='/*vs:M04:children_listChildren:0*/SELECT prompt_id';
 const event:StatementEvent={kind:'execute',statementId:'diagnostic',operation:'diagnostic',phase:'read',sql,binds:[],failed:true};
 const shifted=await operationOutcome(async()=>{throw new Error('D1_ERROR: no such column: prompt_id at offset 1370: SQLITE_ERROR')});
 expect(d1DiagnosticOutcome(shifted,[event])).toEqual(original);
 const secondByte=await operationOutcome(async()=>{throw new Error('D1_ERROR: no such column: prompt_id at offset 1371: SQLITE_ERROR')});
 expect(d1DiagnosticOutcome(secondByte,[event])).not.toEqual(original);
});
test('M04.0000036 preserves every D1 error byte with exactly the admitted tag offset',async()=>{
 const variant=[...legacyVariants()].find(row=>row.id==='M04.0000036');
 if(!variant)throw new Error('Missing diagnostic census case');
 await withViewStorePair('D1',async()=>{},async(_base,db)=>{
  const recorder=statementRecorder(db,{accounting:'d1'});
  const actual=await operationOutcome(()=>executeReadVariant(recorder.db,variant));await recorder.drain();
  expect(d1DiagnosticOutcome(actual,recorder.events)).toEqual({error:{name:'Error',message:'D1_ERROR: no such column: prompt_id at offset 1336: SQLITE_ERROR'}});
 });
},30000);
async function nativeVariantIdentity(fixture:'listing'|'arity'){
 await withFrozenOracle(async oracle=>{
  const frozen=frozenReadPort(oracle),listings=frozenListingReaders(oracle),classes=new Set<string>();
  let cases=0;
  const failures:{id:string;name:string;message:string;code?:unknown;errno?:unknown}[]=[];
  const started=performance.now();
   const sqlite=[new Database(':memory:')];
   const random=spyOn(crypto,'randomUUID').mockReturnValue('00000000-0000-7000-8000-000000009999');
   try{
    const source=sqliteRelationalStore(sqlite[0]!);
    {
     const db=source;
     for(const step of SCHEMA_STEPS)await db.batch(step.statements.map(sql=>db.prepare(sql)));
     for(const id of ['project','other'])await createProject(db,id,id,1);
     if(fixture==='listing')await seedLegacyFixture(db);else await seedLegacyPromptArity(db);
    }
    const clone=Database.deserialize(sqlite[0]!.serialize());sqlite.push(clone);
    const stores=[source,sqliteRelationalStore(clone)];
    const baseline=statementRecorder(stores[0]!,{accounting:'native'}),current=statementRecorder(stores[1]!,{accounting:'native'});
    const references=await legacyReceiptReferences(stores[0]!);
    const digests=new Map<string,{cases:number;digest:ReturnType<typeof createHash>;candidate:ReturnType<typeof createHash>}>();
    for(const variant of legacyVariants()){
     const large=['M13','M14','M24','M25'].includes(variant.family);
     if((fixture==='listing')!==large||!legacyApplicability(variant).applicable)continue;
     baseline.reset();current.reset();
     const before=await variantOutcome(variant,()=>large?executeListingVariant(oracle.replayStore(baseline.db),variant,listings):executeReadVariant(oracle.replayStore(baseline.db),variant,frozen));
     const after=await variantOutcome(variant,()=>large?executeListingVariant(current.db,variant):executeReadVariant(current.db,variant,currentReadPort));
     await baseline.drain();await current.drain();
     const original=eventIdentity(baseline.events,false),candidate=eventIdentity(current.events,true);
     const expected=JSON.stringify(original),actual=JSON.stringify(candidate);
     if(actual!==expected||JSON.stringify(before)!==JSON.stringify(after))throw new Error('Native identity differs for '+variant.id+'\n'+JSON.stringify({expected:original,actual:candidate,before,after}));
     if(before.error)failures.push({id:variant.id,...before.error});
     const row=digests.get(variant.family)??{cases:0,digest:createHash('sha256'),candidate:createHash('sha256')};
     row.cases++;row.digest.update(variant.id+'\n'+JSON.stringify(legacyReferencedEvents(original,references))+'\n');row.candidate.update(variant.id+'\n'+JSON.stringify(legacyReferencedEvents(candidate,references))+'\n');digests.set(variant.family,row);
     classes.add(createHash('sha256').update(fixture+'\n'+expected).digest('hex'));
     cases++;
     if(cases%20000===0)console.info(JSON.stringify({kind:'view_read_identity_progress',cases,classes:classes.size,milliseconds:performance.now()-started}));
    }
    const expected:Readonly<Record<string,{cases:number;sha256:string;candidateSha256:string;fixture:string}>>=legacy.identity.completedFamilies;
    for(const [family,row]of digests)expect<unknown>({family,fixture,cases:row.cases,sha256:row.digest.digest('hex'),candidateSha256:row.candidate.digest('hex'),...legacy.applicability.families[family as keyof typeof legacy.applicability.families]}).toEqual({family,...expected[family]});
   }finally{random.mockRestore();sqlite.forEach(db=>db.close());}
  expect(cases).toBe(Object.values(legacy.identity.completedFamilies).filter(row=>row.fixture===fixture).reduce((n,row)=>n+row.cases,0));
  expect(failures).toEqual(fixture==='listing'?legacy.identity.baseFailures:legacy.identity.remainingCapture.errors);
  console.info(JSON.stringify({kind:'view_read_identity',fixture,cases,classes:classes.size,milliseconds:performance.now()-started,nativeWork:'adapter exposes no physical row counter'}));
 });
}
test.skipIf(!fullReplay)('all 446297 listing variants preserve native preparation, binds, execution and response identity',()=>nativeVariantIdentity('listing'),1800000);
test.skipIf(!fullReplay)('all 5878 applicable remaining variants preserve native preparation, binds, execution and response identity',()=>nativeVariantIdentity('arity'),1800000);

async function distinctExecutionClasses(fixture:'listing'|'arity'){
 await withFrozenOracle(async oracle=>{
  const frozen=frozenReadPort(oracle),listings=frozenListingReaders(oracle),classes=new Set<string>();
  const seed=fixture==='listing'?seedLegacyFixture:seedLegacyPromptArity;
  const started=performance.now();let completed=0,totalRowsRead=0,variants=0;
  const random=spyOn(crypto,'randomUUID').mockReturnValue('00000000-0000-7000-8000-000000009999');
  try{
   for(const family of fixture==='listing'?['M13','M14','M24','M25']:[null]){
   const familyStarted=performance.now(),priorClasses=completed,priorVariants=variants,priorRowsRead=totalRowsRead;
   await withViewStorePair('native',seed,async(nativeBaseline,nativeCandidate)=>{
    await withViewStorePair('D1',seed,async(d1Baseline,d1Candidate)=>{
     const native=statementRecorder(nativeBaseline,{accounting:'native',captureRows:true});
     const pending:Promise<void>[]=[];
     const execute=async(variant:LegacyVariant,expectedNative:Awaited<ReturnType<typeof operationOutcome>>,nativeTrace:ReturnType<typeof eventIdentity>)=>{
      const current=statementRecorder(nativeCandidate,{accounting:'native',captureRows:true});
      const before=statementRecorder(d1Baseline,{accounting:'d1',captureRows:true}),after=statementRecorder(d1Candidate,{accounting:'d1',captureRows:true});
      const large=fixture==='listing';
      const run=(db:Parameters<typeof executeReadVariant>[0],baseline:boolean)=>large?executeListingVariant(db,variant,baseline?listings:undefined):executeReadVariant(db,variant,baseline?frozen:currentReadPort);
      const observedNative=await variantOutcome(variant,()=>run(current.db,false));
      if(JSON.stringify(expectedNative)!==JSON.stringify(observedNative))throw new Error('Native class response differs '+variant.id);
      if(JSON.stringify(nativeTrace)!==JSON.stringify(eventIdentity(current.events,true)))throw new Error('Native class trace differs '+variant.id);
      const [expected,actual]=await Promise.all([variantOutcome(variant,()=>run(oracle.replayStore(before.db),true)),variantOutcome(variant,()=>run(after.db,false))]);
      await Promise.all([current.drain(),before.drain(),after.drain()]);
      if(JSON.stringify(expected)!==JSON.stringify(d1DiagnosticOutcome(actual,after.events)))throw new Error('D1 class response differs '+variant.id+'\n'+JSON.stringify({expected,actual}));
      const original=eventIdentity(before.events,false),candidate=eventIdentity(after.events,true);
      if(JSON.stringify(original)!==JSON.stringify(candidate))throw new Error('D1 class trace differs '+variant.id+'\n'+JSON.stringify({original,candidate}));
      const work=(rows:typeof before.statements,tagged:boolean)=>rows.map(row=>({sql:tagged&&readTag(row.sql)?significantRead(row.sql):row.sql,binds:row.binds,method:row.method,rows:row.rows,rowCount:row.rowCount,rowsRead:row.rowsRead,rowsWritten:row.rowsWritten,failed:row.failed}));
      expect(work(after.statements,true),variant.id).toEqual(work(before.statements,false));
      for(const statement of before.statements)if(!statement.failed){
       expect(statement.rowsRead,variant.id+' D1 physical read accounting').toBeNumber();
       totalRowsRead+=statement.rowsRead!;
      }
      completed++;
      if(completed%2000===0)console.info(JSON.stringify({kind:'view_read_execution_progress',fixture,classes:completed,variants,milliseconds:performance.now()-started}));
     };
     for(const variant of legacyVariants()){
      if((family!==null&&variant.family!==family)||(fixture==='listing')!==['M13','M14','M24','M25'].includes(variant.family)||!legacyApplicability(variant).applicable)continue;
      native.reset();
      const expected=await variantOutcome(variant,()=>fixture==='listing'?executeListingVariant(oracle.replayStore(native.db),variant,listings):executeReadVariant(oracle.replayStore(native.db),variant,frozen));
      await native.drain();variants++;
      const trace=eventIdentity(native.events,false),identity=createHash('sha256').update(fixture+'\n'+JSON.stringify(trace)).digest('hex');
      if(classes.has(identity))continue;
      classes.add(identity);
      if(fixture==='listing'){
       pending.push(execute(variant,expected,trace));
       if(pending.length>=32)await Promise.all(pending.splice(0));
      }else await execute(variant,expected,trace);
     }
     await Promise.all(pending);
    });
   });
   console.info(JSON.stringify({kind:'view_read_execution_family',fixture,family,variants:variants-priorVariants,classes:completed-priorClasses,totalRowsRead:totalRowsRead-priorRowsRead,milliseconds:performance.now()-familyStarted}));
   }
  }finally{random.mockRestore();}
  expect(completed).toBe(classes.size);
  expect(completed).toBe(legacy.identity.executionClasses[fixture]);
  expect(variants).toBe(Object.entries(legacy.applicability.families).filter(([family])=>(fixture==='listing')===['M13','M14','M24','M25'].includes(family)).reduce((sum,[,row])=>sum+row.applicable,0));
  console.info(JSON.stringify({kind:'view_read_execution',fixture,variants,classes:completed,milliseconds:performance.now()-started,totalRowsRead,nativeWork:'adapter exposes no physical row counter; base/candidate exact on each target; D1 physical row accounting'}));
 });
}
test.skipIf(!fullReplay)('every listing statement-sequence class preserves actual native and D1 execution',()=>distinctExecutionClasses('listing'),7200000);
test.skipIf(!fullReplay)('every remaining statement-sequence class preserves actual native and D1 execution',()=>distinctExecutionClasses('arity'),7200000);

const aggregateColumns:Readonly<Record<string,readonly string[]>>={
 'M01:turns_listTurns:0':['tool_call_count','response_count','child_count','plan_count','attachment_count'],
 'M03:turns_readTurnBodies:0':['last_reply'],
 'M05:turns_steeringChildPage:0':['tool_call_count','child_count'],
 'M06:turns_toolUsage:0':['n'],
 'M07:turns_sessionTurnContexts:0':['n'],
 'M11:sessions_sessionCounts:1':['n'],
 'M15:sessions_countStatements:0':['n'],
 'M17:sessions_projectStats:0':['total','open','recent','last'],
 'M17:sessions_projectStats:1':['n'],
 'M21:hook_placement_countUnplacedContextRecords:0':['n'],
 'M22:children_countOwed:0':['total','imported'],
 'M24:plans_planTotals:0':['n'],
 'M25:search_searchType:0':['rank'],
 'M27:core_search_index_pendingSearchBlobs:0':['n'],
 'M27:core_search_index_searchBacklog:0':['n','oldest'],
 'M33:core_embedding_reconcile_passedOverSources:0':['recordedAt'],
 'M33:core_embedding_reconcile_passedOverSources:1':['n'],
 'M34:core_embedding_hubness_missingSporeVectors:0':['rewriting','waiting','abandoned'],
 'M34:countCurrentSporeVectors:0':['n'],
 'M34:prepareHubnessPublication:0':['complete'],
 'M35:core_embedding_switch_store_switchProgress:0':['total','built'],
 'M35:core_embedding_switch_store_sourceTotals:0':['sources','chars'],
 'M35:core_embedding_switch_store_switchComplete:0':['complete'],
 'M42:kpis_countOf:0':['n'],
 'M42:kpis_deliveryMeasures:0':['total','placed'],
 'M42:kpis_harnessSplit:0':['n'],
 'M42:kpis_harnessSplit:1':['n'],
 'M43:kpis_firstInjectionSamples:0':['started','first_served'],
 'M43:kpis_promptIdentityCounts:0':['n','unrecognized','unmarked','opener_conflict','contract_violation','reused'],
 'M43:kpis_promptIdentityCounts:1':['n'],
 'M43:kpis_promptIdentityCounts:2':['n'],
 'M43:kpis_promptIdentityCounts:3':['n'],
 'M43:kpis_promptIdentityCounts:4':['n'],
};
const aggregateExemptions:Readonly<Record<string,Readonly<Record<string,string>>>>={
 'M34:core_embedding_hubness_missingSporeVectors:0':{
  abandoned:'The lost-vector world reads waiting and its first rewrite before the rewrite limit.',
 },
 'M43:kpis_promptIdentityCounts:0':{
  unrecognized:'The transcript result world supplies recognized or unmarked opener records.',
  opener_conflict:'The transcript result world supplies no contradictory opener labels.',
  contract_violation:'The transcript result world uses records that match the registered transcript role.',
  reused:'The transcript result world preserves one owner for each parser source record.',
 },
};
const multiplexedAggregates=new Set([
 'M11:sessions_sessionCounts:1','M15:sessions_countStatements:0','M17:sessions_projectStats:1',
 'M21:hook_placement_countUnplacedContextRecords:0','M42:kpis_countOf:0',
]);
function aggregateIdentity(target:string,operation:string,sql:string):string{
 return JSON.stringify([target,operation,multiplexedAggregates.has(operation)?sql:'projection']);
}
function nonzeroColumns(rows:readonly unknown[],columns:readonly string[]):ReadonlySet<string>{
 return new Set(columns.filter(column=>rows.some(row=>typeof row==='object'&&row!==null&&column in row&&typeof Reflect.get(row,column)==='number'&&Number.isFinite(Reflect.get(row,column))&&Reflect.get(row,column)!==0)));
}
test('aggregate witnesses require every named column and admit signed nonzero ranks',()=>{
 expect([...nonzeroColumns([{total:1,placed:0}],['total','placed'])]).toEqual(['total']);
 expect([...nonzeroColumns([{total:1,placed:0},{total:0,placed:1}],['total','placed'])]).toEqual(['total','placed']);
 expect([...nonzeroColumns([{rank:-0.1}],['rank'])]).toEqual(['rank']);
 for(const operation of multiplexedAggregates)expect(aggregateIdentity('native',operation,'SELECT COUNT(*) AS n FROM plans')).not.toBe(aggregateIdentity('native',operation,'SELECT COUNT(*) AS n FROM responses'));
 for(const [operation,columns]of Object.entries(aggregateExemptions))for(const [column,reason]of Object.entries(columns)){
  expect(aggregateColumns[operation]).toContain(column);expect(reason.trim().length).toBeGreaterThan(0);
 }
});

test('the CI strata preserve frozen statement sequences and replay result rows on both targets',async()=>{
 const text=gunzipSync(Buffer.from(legacy.ci.data,'base64'));
 expect(createHash('sha256').update(text).digest('hex')).toBe(legacy.ci.sha256);
 const frozen=JSON.parse(text.toString()) as {texts:string[];rows:{id:string;target:'native'|'D1';fixture:'listing'|'arity';outcome:Awaited<ReturnType<typeof operationOutcome>>;events:(Omit<ReturnType<typeof eventIdentity>[number],'sql'>&{text:number})[]}[]};
 expect(frozen.texts).toHaveLength(legacy.ci.texts);
 const rows=frozen.rows.map(row=>({...row,events:row.events.map(({text,...event})=>{const sql=frozen.texts[text];if(sql===undefined)throw new Error('Missing frozen CI text');return {...event,sql};})}));
 const variants=new Map(legacyCIVariants().map(variant=>[variant.id,variant]));
 expect(variants.size).toBe(legacy.ci.cases);expect(rows).toHaveLength(2*variants.size);
 expect(new Set([...variants.values()].map(row=>row.family)).size).toBe(47);
 const random=spyOn(crypto,'randomUUID').mockReturnValue('00000000-0000-7000-8000-000000009999');
 const templates=new Set<string>();
 const witnesses=new Map<string,Set<string>>();
 const aggregates=new Map<string,Set<string>>();
 const aggregateFields=new Map<string,Set<string>>();
 const aggregateStatements=new Map<string,{target:string;operation:string;sql:string}>();
 const witness=(target:string,rows:readonly import('../helpers/statement-recorder.js').RecordedStatement[])=>{
  const ids=witnesses.get(target)??new Set<string>();
  for(const row of rows){
   const tag=readTag(row.sql);
   const columns=tag?aggregateColumns[tag.operation]:undefined;
   if(tag&&columns){
    const sql=significantRead(row.sql),key=aggregateIdentity(target,tag.operation,sql),entry=aggregates.get(key)??new Set<string>();
    aggregateStatements.set(key,{target,operation:tag.operation,sql});
    for(const column of nonzeroColumns(row.rows??[],columns))entry.add(column);
    aggregates.set(key,entry);
    const fields=aggregateFields.get(key)??new Set<string>();
    for(const value of row.rows??[])if(typeof value==='object'&&value!==null)for(const column of columns)if(column in value&&typeof Reflect.get(value,column)==='number')fields.add(column);
    aggregateFields.set(key,fields);
   }
   if(tag&&((row.changes??0)>0||(columns?nonzeroColumns(row.rows??[],columns).size>0:(row.rows??[]).length>0)))ids.add(tag.operation);
  }
  witnesses.set(target,ids);
 };
 try{await withFrozenCIOracle(async oracle=>{
  for(const fixture of ['listing','arity'] as const)for(const target of ['native','D1'] as const)await withViewStorePair(target,fixture==='listing'?seedLegacyFixture:seedLegacyPromptArity,async(baseline,candidate)=>{
   const started=performance.now();console.info(JSON.stringify({kind:'view_read_CI_phase',fixture,target,stage:'start'}));
   const references=await legacyReceiptReferences(baseline);
   const replay=statementRecorder(baseline,{accounting:target==='native'?'native':'d1',captureRows:true});
   const current=statementRecorder(candidate,{accounting:target==='native'?'native':'d1',captureRows:true});
   for(const row of rows.filter(row=>row.fixture===fixture&&row.target===target)){
    const variant=variants.get(row.id);if(!variant)throw new Error('Unknown CI stratum '+row.id);
    replay.reset();current.reset();
    const baseline=()=>fixture==='listing'?executeListingVariant(oracle.replayStore(replay.db),variant,frozenListingReaders(oracle)):executeReadVariant(oracle.replayStore(replay.db),variant,frozenReadPort(oracle));
    const candidate=()=>fixture==='listing'?executeListingVariant(current.db,variant):executeReadVariant(current.db,variant,currentReadPort);
    const bundleField=bundledFieldRefusal(variant);
    let expected:Awaited<ReturnType<typeof operationOutcome>>|undefined,actual:typeof expected;
    if(bundleField){
     for(const work of [baseline,candidate])await assertedBundleFieldRefusal(work);
    }else [expected,actual]=await Promise.all([operationOutcome(baseline),operationOutcome(candidate)]);
    await replay.drain();await current.drain();
    if(actual!==undefined)expect<unknown>(target==='D1'?d1DiagnosticOutcome(actual,current.events):actual,target+' '+row.id+' response').toEqual(expected);
    expect(eventIdentity(current.events,true),target+' '+row.id+' live bind identity').toEqual(eventIdentity(replay.events,false));
    expect<unknown>(legacyReferencedEvents(eventIdentity(current.events,true),references),target+' '+row.id).toEqual(row.events);
    witness(target,current.statements);
    for(const event of current.events){const tag=readTag(event.sql);if(tag)templates.add(tag.operation);}
    const work=(statements:typeof current.statements,tagged:boolean)=>statements.map(({sql,binds,method,rows,rowCount,rowsRead,rowsWritten,failed})=>({sql:tagged&&readTag(sql)?significantRead(sql):sql,binds,method,rows,rowCount,rowsRead,rowsWritten,failed}));
    expect(work(current.statements,true),target+' '+row.id).toEqual(work(replay.statements,false));
   }
   console.info(JSON.stringify({kind:'view_read_CI_phase',fixture,target,stage:'complete',milliseconds:performance.now()-started}));
  });
  let serial=100000;
  random.mockImplementation(()=>uuid(serial++) as ReturnType<typeof crypto.randomUUID>);
  for(const target of ['native','D1']as const)for(const [seed,read]of [[seedLegacyCIResults,legacyCIResultReads],[seedLegacyCISwitch,legacyCISwitchReads]]as const)await withViewStorePair(target,seed,async(baseline,candidate)=>{
   console.info(JSON.stringify({kind:'view_read_CI_positive',target,fixture:seed.name,stage:'start'}));
   const before=statementRecorder(baseline,{accounting:target==='native'?'native':'d1',captureRows:true}),after=statementRecorder(candidate,{accounting:target==='native'?'native':'d1',captureRows:true});
   serial=200000;const expected=await read(oracle.replayStore(before.db),frozenReadPort(oracle));
   serial=200000;const actual=await read(after.db);
   await before.drain();await after.drain();expect(actual,target+' positive results').toEqual(expected);
   if(read===legacyCIResultReads){
    const counts=actual.find(row=>row.name==='title-counts')?.value;
    if(typeof counts!=='object'||counts===null||!('live'in counts)||!('imported'in counts))throw new Error('Missing CI title counts');
    expect(counts.live,target+' live title backlog').toBeGreaterThan(0);
    expect(counts.imported,target+' imported title backlog').toBeGreaterThan(0);
   }else expect(actual).toContainEqual({name:'switch-completion',value:true});
   const work=(rows:typeof before.statements,tagged:boolean)=>rows.map(({sql,binds,method,rows,rowCount,rowsRead,rowsWritten,changes,failed})=>({sql:tagged&&readTag(sql)?significantRead(sql):sql,binds,method,rows,rowCount,rowsRead,rowsWritten,changes,failed}));
   expect(work(after.statements,true),target+' positive statement results and work').toEqual(work(before.statements,false));
   witness(target,after.statements);
   console.info(JSON.stringify({kind:'view_read_CI_positive',target,fixture:seed.name,stage:'complete'}));
  });
  for(const target of ['native','D1']){
   const missing=[...LEGACY_ONLY_OPERATIONS].filter(id=>!witnesses.get(target)?.has(id));
   console.info(JSON.stringify({kind:'view_read_CI_results',target,missing}));
   expect(missing,target+' templates without a positive result').toEqual([]);
   for(const operation of Object.keys(aggregateColumns))expect([...aggregateStatements.values()].some(row=>row.target===target&&row.operation===operation),target+' '+operation+' missing aggregate statement').toBe(true);
   const missingAggregates=[...aggregateStatements].filter(([,row])=>row.target===target).flatMap(([key,{operation,sql}])=>{
    const columns=aggregateColumns[operation]!,observed=aggregates.get(key)??new Set<string>(),exempt=aggregateExemptions[operation]??{};
    const numeric=columns.filter(column=>!aggregateFields.get(key)?.has(column)),nonzero=columns.filter(column=>!observed.has(column)&&!exempt[column]);
    return numeric.length||nonzero.length?[{operation,sql,columnsWithoutNumericRows:numeric,columnsWithoutNonzeroResult:nonzero}]:[];
   });
   console.info(JSON.stringify({kind:'view_read_CI_aggregates',target,missing:missingAggregates}));
   expect(missingAggregates,target+' aggregate columns without numeric or nonzero witnesses').toEqual([]);
   for(const [operation,exempt]of Object.entries(aggregateExemptions))for(const column of Object.keys(exempt))expect([...aggregateStatements].filter(([,row])=>row.target===target&&row.operation===operation).some(([key])=>!aggregates.get(key)?.has(column)),target+' '+operation+'/'+column+' redundant aggregate exemption').toBe(true);
  }
  expect([...LEGACY_ONLY_OPERATIONS].filter(id=>!templates.has(id))).toEqual([]);
 });}finally{random.mockRestore()}
},120000);

test('public HTTP and MCP compositions preserve exact base status content type bytes and statement counts',async()=>{
 const random=spyOn(crypto,'randomUUID').mockReturnValue('00000000-0000-7000-8000-000000009999');
 try{await withFrozenCIOracle(async oracle=>{
  for(const target of ['native','D1']as const){
   let identity:Awaited<ReturnType<typeof seedLegacyPublicFixture>>|undefined;
   await withViewStorePair(target,async db=>{identity=await seedLegacyPublicFixture(db)},async(baseline,candidate)=>{
    if(!identity)throw new Error('Public fixture has no identity');
    const before=statementRecorder(baseline,{accounting:target==='native'?'native':'d1',captureRows:true}),after=statementRecorder(candidate,{accounting:target==='native'?'native':'d1',captureRows:true});
    const base=legacyPublicServer(oracle.replayStore(before.db),oracle),current=legacyPublicServer(after.db);
    const requests=legacyPublicRequests(identity);
    expect(requests.length).toBe(legacy.ci.publicCompositions.requestsPerTarget);
    for(const [index,request]of requests.entries()){
     before.reset();after.reset();
     const response=async(fetch:(input:Request)=>Promise<Response>)=>{const row=await fetch(new Request(request.url,{method:request.method,headers:request.headers,...(request.method==='GET'?{}:{body:await request.clone().text()})}));return {status:row.status,contentType:row.headers.get('content-type'),bytes:await row.text()}};
     const original=await response(base),actual=await response(current);await before.drain();await after.drain();
     expect(actual,target+' '+request.url).toEqual(original);
     const frozen=legacy.ci.publicCompositions.requests[index]!;
     expect({status:actual.status,contentType:actual.contentType,method:request.method,url:request.url}).toEqual(frozen);
     expect(eventIdentity(after.events,true),target+' '+request.url+' preparation and execution count').toEqual(eventIdentity(before.events,false));
     const work=(rows:typeof before.statements,tagged:boolean)=>rows.map(({sql,binds,method,rows,rowCount,rowsRead,rowsWritten,failed})=>({sql:tagged&&readTag(sql)?significantRead(sql):sql,binds,method,rows,rowCount,rowsRead,rowsWritten,failed}));
     expect(work(after.statements,true),target+' '+request.url+' statement results').toEqual(work(before.statements,false));
    }
   });
  }
 });}finally{random.mockRestore()}
},30000);

test('writer-produced blob and bundle bodies reach their distinct hydration paths on both targets',async()=>{
 const random=spyOn(crypto,'randomUUID').mockReturnValue('00000000-0000-7000-8000-000000009999');
 try{await withFrozenCIOracle(async oracle=>{
  for(const target of ['native','D1']as const)await withViewStorePair(target,db=>seedLegacyPromptArity(db,0),async(baseline,candidate)=>{
   for(const storage of ['blob','bundle']as const){
    for(const kind of storage==='bundle'?['tool-input']as const:['prompt','response','plan','tool-input','tool-output']as const){
     const variant:LegacyVariant={id:'body-'+storage+'-'+kind,family:'M26',part:legacy.domain.parts.M26,empty_list_short_circuit:false,case:{kind,storage,stage:'body'}};
     const before=statementRecorder(baseline,{accounting:target==='native'?'native':'d1'}),after=statementRecorder(candidate,{accounting:target==='native'?'native':'d1'});
     const gets=legacyBodyBlobs.gets.length;
     const original=await executeReadVariant(oracle.replayStore(before.db),variant,frozenReadPort(oracle));
     const actual=await executeReadVariant(after.db,variant);await before.drain();await after.drain();
     expect(actual).toEqual(original);
     expect(actual).toBe(kind==='tool-input'&&storage==='bundle'?JSON.stringify({body:'bundle input '+'λ'.repeat(3000)}):storage+' body canary');
     if(storage==='blob'||kind==='tool-input')expect(legacyBodyBlobs.gets.length).toBeGreaterThan(gets);
     expect(eventIdentity(after.events,true)).toEqual(eventIdentity(before.events,false));
    }
   }
  });
 });}finally{random.mockRestore()}
},30000);

test('applicable embedded fragments execute their named final sink in their real source world',async()=>{
 const random=spyOn(crypto,'randomUUID').mockReturnValue('00000000-0000-7000-8000-000000009999');
 try{await withFrozenCIOracle(async oracle=>{
  const variants=[...legacyVariants()].filter(variant=>variant.family==='M30'&&legacyApplicability(variant).applicable);
  expect(variants).toHaveLength(19);
  for(const target of ['native','D1']as const)await withViewStorePair(target,db=>seedLegacyPromptArity(db,0),async(baseline,candidate)=>{
   for(const variant of variants){
    const before=statementRecorder(baseline,{accounting:target==='native'?'native':'d1',captureRows:true}),after=statementRecorder(candidate,{accounting:target==='native'?'native':'d1',captureRows:true});
    const calls:string[]=[],v=variant.case;
    const expected=v.producer==='embeddingSourceSelect'?'embedding.semanticHits':v.consumer==='M31'?(v.producer==='eligibleSource'?'factory.prepareEmbeddingSelection':'selection.retiringReceipt'):v.consumer==='M32'?(v.producer==='currentMember'?'sweep.hubnessSweep':'sweep.embeddingSweep'):v.producer==='currentMember'?'hubness.prepareHubnessWork':'hubness.countCurrentSporeVectors';
    const port:typeof currentReadPort=(namespace,name,args)=>{calls.push(namespace+'.'+name);return currentReadPort(namespace,name,args)};
    const original=await executeReadVariant(oracle.replayStore(before.db),variant,frozenReadPort(oracle));
    const actual=await executeReadVariant(after.db,variant,port);await before.drain();await after.drain();
    expect(calls,variant.id+' final sink').toEqual([expected]);
    expect(actual,variant.id).toEqual(original);
    expect(actual,variant.id+' positive source').not.toBeNull();
    if(v.consumer==='M29')expect(Array.isArray(actual)&&actual.length>0,variant.id+' hydration').toBe(true);
    if(v.consumer==='M32')expect(actual,variant.id+' source work').toMatchObject({pending:true});
    if(v.consumer==='M34'&&v.producer==='currentMember')expect(Array.isArray(actual)&&actual[3]!==null,variant.id+' stale member').toBe(true);
    if(v.consumer==='M34'&&v.producer!=='currentMember')expect(actual,variant.id+' current vectors').toBe(3);
    expect(eventIdentity(after.events,true),variant.id).toEqual(eventIdentity(before.events,false));
   }
  });
 });}finally{random.mockRestore()}
},30000);

test('oracle tokens retain loader identity and are bound to one exact statement',async()=>{
 await withFrozenCIOracle(async oracle=>{
  const sqlite=new Database(':memory:');
  try{
   const recorder=statementRecorder(sqliteRelationalStore(sqlite),{accounting:'native'});
   const sql=legacy.calibration.statementText.find(text=>protectedSql(text));
   if(!sql)throw new Error('Missing protected oracle statement');
   const prepare=oracle.replayStore(recorder.db).prepare;
   prepare(sql);
   const event=recorder.events[0];if(!event?.origin||event.origin.kind!=='oracle')throw new Error('Missing loader token');
   const origin=event.origin;
   expect(runtimeBoundary([event])).toEqual([]);
   expect(runtimeBoundary([{...event,origin:{...event.origin}}])).not.toEqual([]);
   expect(runtimeBoundary([{...event,sql:sql+' '}])).not.toEqual([]);
   expect(()=>withReadPreparation({...origin},()=>recorder.db.prepare(sql))).toThrow('untagged protected SQL');
   expect(()=>withReadPreparation(origin,()=>recorder.db.prepare(sql+' '))).toThrow('untagged protected SQL');
   await recorder.drain();
  }finally{sqlite.close()}
 });
});
