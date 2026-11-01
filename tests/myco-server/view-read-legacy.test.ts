import {emptyReadSql,emptyReadRows,activeCatalogueRows,explainReadPlan,legacyArmPlanViolations,partitionLegacyPlan,captureProbePlan,armPlanViolations} from './helpers/view-read-costs.js';
import {Database} from 'bun:sqlite';
import {sqliteRelationalStore} from '@myco-server-worker/platform/bun/sqlite.js';
import type {PreparedStatement} from '@myco-server-worker/core/adapters.js';
import {statementRecorder,withReadPreparation} from '../helpers/statement-recorder.js';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
const {appendFileSync,createReadStream}=fs;
import {createInterface} from 'node:readline';
import {expect,test,spyOn} from 'bun:test';
import legacy from './fixtures/view-read-legacy.json';
import {legacyExecutionCases,legacyVariants,legacyApplicability,legacyReceiptReferences,legacyReferencedEvents,legacyCIVariants,withFrozenCIOracle,withFrozenOracle,frozenListingReaders,executeListingVariant,executeReadVariant,frozenReadPort,currentReadPort,seedLegacyFixture,seedLegacyPromptArity,seedLegacyCISwitch,legacyCISwitchReads,seedLegacyCIResults,legacyCIResultReads,seedLegacyPublicFixture,legacyBodyBlobs,legacyPublicRequests,legacyPublicServer,type LegacyVariant} from '../helpers/view-read-legacy-fixtures.js';
import {createProject} from '@myco-server-worker/read/sessions.js';
import {SCHEMA_STEPS} from '@myco-server-worker/db/schema.js';
import {SERVER_SCHEMA_VERSION} from '@myco-server-worker/constants.js';
import type {StatementEvent} from '../helpers/statement-recorder.js';
import {significantRead,protectedSql,readTag,runtimeBoundary} from '../helpers/view-read-contract.js';
import {withViewStores,withViewStorePair} from './helpers/view-stores.js';
import {gunzipSync} from 'node:zlib';
import {VIEW_READ_OPERATIONS} from '../helpers/view-read-operations.js';
import {LEGACY_ONLY_OPERATIONS} from '@myco-server-worker/read/view-store.js';
import {AssertionError} from 'node:assert';
import {ToolError} from '@myco-server-worker/mcp/validate.js';
import {uuid} from './helpers/fixtures.js';

const fullReplay=process.env.MYCO_VIEW_READ_FULL==='1';

test('recorded plan SQL uses fixture permissions and cannot claim a copied module origin',async()=>{
 await withViewStores(async(db,target)=>{
  const recorded=statementRecorder(db,{accounting:target==='D1'?'d1':'native'});
  const query={sql:'/*vs:M24:plans_planTotals:0*/SELECT plan_key FROM plans WHERE project_id=? AND plan_key=? /* artifact control */',binds:['project','absent']};
  const plan=await explainReadPlan(recorded.db,query);
  expect(plan.some(row=>row.detail.includes('project_id=? AND plan_key=?')),target).toBe(true);
  const prepared=recorded.events.find(row=>row.kind==='prepare');
  expect(prepared?.origin?.kind,target).toBe('exception');
  expect(prepared?.origin!==undefined&&'replay' in prepared.origin,target).toBe(false);
  expect(prepared?.captured,target).toBe(false);
  expect(query.sql.startsWith('/*vs:M24:'),target).toBe(true);
 });
},30_000);

test.skipIf(!process.env.MYCO_VIEW_READ_Q_CASES)('every recorded independent SQL pair retains its native and D1 legacy plan and exact capture probes',async()=>{
 const files=process.env.MYCO_VIEW_READ_Q_CASES!.split(',');
 for(const file of files){
  const fixture=file.includes('listing')?'listing':'arity';
  for(const target of ['native','D1'] as const)await withViewStorePair(target,fixture==='listing'?seedLegacyFixture:seedLegacyPromptArity,async(baseline,candidate)=>{
   const lines=createInterface({input:createReadStream(file),crlfDelay:Infinity});let cases=0,footer=false,physicalProbes=0;
   const costEstimateOnly:Record<string,number>={};
   try{for await(const line of lines){
    const row:unknown=JSON.parse(line);
    if(typeof row!=='object'||row===null||!('kind'in row))throw new Error('Invalid recorded plan case');
    if(row.kind==='view_read_plan_cases_complete'){
     if(!('classes'in row)||row.classes!==cases)throw new Error('Recorded plan case footer differs');footer=true;continue;
    }
    if(footer||row.kind!=='view_read_plan_case'||!('baseline'in row)||!('candidate'in row)||!('operation'in row)||typeof row.operation!=='string'||!('caseId'in row))throw new Error('Invalid recorded independent pair');
    const shape=(value:unknown):value is {sql:string;binds:unknown[]}=>typeof value==='object'&&value!==null&&'sql'in value&&typeof value.sql==='string'&&'binds'in value&&Array.isArray(value.binds);
    if(!shape(row.baseline)||!shape(row.candidate))throw new Error('Recorded plan statement is malformed');
    const before=await explainReadPlan(baseline,row.baseline),after=await explainReadPlan(candidate,row.candidate);
    const input={sql:row.candidate.sql,original:row.baseline.sql,operation:row.operation,baseline:before,candidate:after};
    let errors:string[],retained=after;
    if(row.operation==='M21:hook_placement_countUnplacedContextRecords:0'){
     expect(emptyReadSql(input.sql),target+'/'+row.caseId+' M21 frozen reconstruction').toBe(input.original);
     const restored=await explainReadPlan(candidate,{sql:emptyReadSql(input.sql),binds:row.candidate.binds});
     retained=restored;
     errors=armPlanViolations({baseline:before,legacy:restored,publication:[],view:[]}).filter(error=>error!=='publication gate requires one exact indexed session_views search');
     errors.push(...captureProbePlan(input.sql,after).errors);
    }else{errors=legacyArmPlanViolations(input);retained=partitionLegacyPlan(input).legacy;}
    if(errors.length)console.info('VIEW_Q_FAILURE',JSON.stringify({target,caseId:row.caseId,operation:row.operation,before,after,baseline:row.baseline,candidate:row.candidate}));
    expect(errors,target+'/'+row.caseId+'/'+row.operation).toEqual([]);
    if(retained.some((plan,index)=>plan.notused!==before[index]?.notused))costEstimateOnly[row.operation]=(costEstimateOnly[row.operation]??0)+1;
    const report=process.env.MYCO_VIEW_READ_Q_REPORT;
    if(report)appendFileSync(report,JSON.stringify({kind:'view_read_Q_pair',fixture,target,caseId:row.caseId,operation:row.operation,before,after,retained})+'\n');
    physicalProbes+=captureProbePlan(input.sql,after).actual.publication;cases++;
    if(cases%10000===0)console.info('VIEW_Q_PROGRESS',JSON.stringify({fixture,target,cases,physicalProbes}));
   }}finally{lines.close();}
   expect(footer,target+'/'+fixture+' completed E artifact').toBe(true);
   expect(cases).toBeGreaterThan(0);
   const result={kind:'view_read_Q_complete',fixture,target,cases,physicalProbes,costEstimateOnly};
   console.info('VIEW_Q_COMPLETE',JSON.stringify(result));
   const report=process.env.MYCO_VIEW_READ_Q_REPORT;if(report)appendFileSync(report,JSON.stringify(result)+'\n');
  });
 }
},7200000);

test('legacy membership preserves exact SQL while migrated reads compare their original arm',()=>{
 const base='SELECT prompt_id FROM prompt_batches WHERE project_id=?';
 const wrapper=`SELECT legacy.*, NULL AS __myco_capture, 0 AS __myco_sentinel FROM (${base}) legacy UNION ALL SELECT NULL, NULL, 1 FROM session_views sv`;
 const member='/*vs:M24:plans_selectPlans:0*/'+wrapper;
 const migrated='/*vs:M01:turns_listTurns:0*/'+wrapper;
 const members=new Set<string>(LEGACY_ONLY_OPERATIONS);
 expect(members.has('M24:plans_selectPlans:0')).toBe(true);
 expect(members.has('M01:turns_listTurns:0')).toBe(false);
 expect(emptyReadSql(member)).toBe(wrapper);
 expect(emptyReadSql(migrated)).toBe(base);
 expect(emptyReadRows([{prompt_id:'p',__myco_capture:null,__myco_sentinel:0}])).toEqual([{prompt_id:'p'}]);
 expect(()=>emptyReadRows([{prompt_id:null,__myco_capture:'{}',__myco_sentinel:1}])).toThrow('publication sentinel');
});

test('a supplied capture flag cannot replace observed source preparation',()=>{
 const sqlite=new Database(':memory:');
 try{
  const recorder=statementRecorder(sqliteRelationalStore(sqlite),{accounting:'native',context:()=>({operation:'probe',phase:'read',captured:true})});
  expect(()=>withReadPreparation({kind:'module'},()=>recorder.db.prepare('/*vs:M01:turns_listTurns:0*/SELECT 1'))).toThrow('nonmember missing source capture');
 }finally{sqlite.close();}
});

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
    expect<unknown>(current.statements.map(row=>({sql:emptyReadSql(row.sql),binds:row.binds,method:row.method,rowsRead:row.rowsRead})))
     .toEqual(baseline.statements.map(row=>({sql:row.sql,binds:row.binds,method:row.method,rowsRead:row.rowsRead})));
   }
  });
 });
},120000);

function eventIdentity(events:readonly StatementEvent[],tagged:boolean){
 return events.map(event=>({kind:event.kind,sql:tagged?emptyReadSql(event.sql):event.sql,binds:event.binds,...(event.method?{method:event.method}:{}),...(event.failed?{failed:true}:{})}));
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
test.skipIf(!fullReplay)('all applicable remaining variants preserve native preparation, binds, execution and response identity',()=>nativeVariantIdentity('arity'),1800000);

async function distinctExecutionClasses(fixture:'listing'|'arity',everyVariant=false){
 const legacyMembers=new Set<string>(LEGACY_ONLY_OPERATIONS);
 const migratedFamilies=new Set(VIEW_READ_OPERATIONS.filter(row=>!legacyMembers.has(row.id)&&row.id.startsWith('M')).map(row=>row.id.split(':')[0]));
 const planCaseFile=everyVariant?process.env.MYCO_VIEW_READ_PLAN_CASES:undefined;
 const planClasses=new Set<string>();
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
     const nativeWork=(rows:ReturnType<typeof statementRecorder>['statements'],tagged:boolean)=>rows.map(row=>({sql:tagged?emptyReadSql(row.sql):row.sql,binds:row.binds,method:row.method,rows:emptyReadRows(row.rows),rowCount:row.rowCount,rowsRead:row.rowsRead,rowsWritten:row.rowsWritten,failed:row.failed}));
     const execute=async(variant:LegacyVariant,expectedNative:Awaited<ReturnType<typeof operationOutcome>>,nativeTrace:ReturnType<typeof eventIdentity>,expectedNativeWork:ReturnType<typeof nativeWork>)=>{
      const current=statementRecorder(nativeCandidate,{accounting:'native',captureRows:true});
      const before=statementRecorder(d1Baseline,{accounting:'d1',captureRows:true}),after=statementRecorder(d1Candidate,{accounting:'d1',captureRows:true});
      const large=fixture==='listing';
      const run=(db:Parameters<typeof executeReadVariant>[0],baseline:boolean)=>large?executeListingVariant(db,variant,baseline?listings:undefined):executeReadVariant(db,variant,baseline?frozen:currentReadPort);
      const observedNative=await variantOutcome(variant,()=>run(current.db,false));
      if(JSON.stringify(expectedNative)!==JSON.stringify(observedNative))throw new Error('Native class response differs '+variant.id);
      if(JSON.stringify(nativeTrace)!==JSON.stringify(eventIdentity(current.events,true)))throw new Error('Native class trace differs '+variant.id);
      if(JSON.stringify(expectedNativeWork)!==JSON.stringify(nativeWork(current.statements,true)))throw new Error('Native statement result or cost differs '+variant.id);
      const [expected,actual]=await Promise.all([variantOutcome(variant,()=>run(oracle.replayStore(before.db),true)),variantOutcome(variant,()=>run(after.db,false))]);
      await Promise.all([current.drain(),before.drain(),after.drain()]);
      if(JSON.stringify(expected)!==JSON.stringify(d1DiagnosticOutcome(actual,after.events)))throw new Error('D1 class response differs '+variant.id+'\n'+JSON.stringify({expected,actual}));
      const original=eventIdentity(before.events,false),candidate=eventIdentity(after.events,true);
      if(JSON.stringify(original)!==JSON.stringify(candidate))throw new Error('D1 class trace differs '+variant.id+'\n'+JSON.stringify({original,candidate}));
      const work=(rows:typeof before.statements,tagged:boolean)=>rows.map(row=>({sql:tagged?emptyReadSql(row.sql):row.sql,binds:row.binds,method:row.method,rows:emptyReadRows(row.rows),rowCount:row.rowCount,rowsRead:row.rowsRead,rowsWritten:row.rowsWritten,failed:row.failed}));
      expect(work(after.statements,true),variant.id).toEqual(work(before.statements,false));
      for(const statement of before.statements)if(!statement.failed){
       expect(statement.rowsRead,variant.id+' D1 physical read accounting').toBeNumber();
       totalRowsRead+=statement.rowsRead!;
      }
      if(planCaseFile)for(const [index,query]of current.statements.entries()){
       const original=expectedNativeWork[index],tag=readTag(query.sql);
       if(!original||original.failed||query.failed||!tag||legacyMembers.has(tag.operation))continue;
       const baseline={sql:original.sql,binds:original.binds,method:original.method};
       const candidate={sql:query.sql,binds:query.binds,method:query.method};
       const bindTypes=(values:readonly unknown[])=>values.map(value=>value===null?'null':typeof value);
       const key=JSON.stringify([baseline.sql,candidate.sql,baseline.method,bindTypes(baseline.binds),bindTypes(candidate.binds)]);
       if(planClasses.has(key))continue;
       planClasses.add(key);
       appendFileSync(planCaseFile,JSON.stringify({kind:'view_read_plan_case',caseId:variant.id,fixture,index,operation:tag.operation,baseline,candidate})+'\n');
      }
      completed++;
      if(completed%2000===0)console.info(JSON.stringify({kind:'view_read_execution_progress',fixture,mode:everyVariant?'variants':'classes',completed,classes:classes.size,variants,milliseconds:performance.now()-started}));
     };
     for(const variant of legacyVariants()){
      if((everyVariant&&!migratedFamilies.has(variant.family))||(family!==null&&variant.family!==family)||(fixture==='listing')!==['M13','M14','M24','M25'].includes(variant.family)||!legacyApplicability(variant).applicable)continue;
      native.reset();
      const expected=await variantOutcome(variant,()=>fixture==='listing'?executeListingVariant(oracle.replayStore(native.db),variant,listings):executeReadVariant(oracle.replayStore(native.db),variant,frozen));
      await native.drain();variants++;
      const trace=eventIdentity(native.events,false),identity=createHash('sha256').update(fixture+'\n'+JSON.stringify(trace)).digest('hex');
      if(!everyVariant&&classes.has(identity))continue;
      classes.add(identity);
      if(fixture==='listing'){
       pending.push(execute(variant,expected,trace,nativeWork(native.statements,false)));
       if(pending.length>=32)await Promise.all(pending.splice(0));
      }else await execute(variant,expected,trace,nativeWork(native.statements,false));
     }
     await Promise.all(pending);
    });
   });
   console.info(JSON.stringify({kind:'view_read_execution_family',fixture,family,mode:everyVariant?'variants':'classes',variants:variants-priorVariants,classes:completed-priorClasses,totalRowsRead:totalRowsRead-priorRowsRead,milliseconds:performance.now()-familyStarted}));
   }
  }finally{random.mockRestore();}
  expect(completed).toBe(everyVariant?variants:classes.size);
  if(!everyVariant)expect(completed).toBe(legacy.identity.executionClasses[fixture]);
  expect(variants).toBe(Object.entries(legacy.applicability.families).filter(([family])=>(!everyVariant||migratedFamilies.has(family))&&(fixture==='listing')===['M13','M14','M24','M25'].includes(family)).reduce((sum,[,row])=>sum+row.applicable,0));
  if(planCaseFile)appendFileSync(planCaseFile,JSON.stringify({kind:'view_read_plan_cases_complete',fixture,variants,completed,classes:planClasses.size})+'\n');
  console.info(JSON.stringify({kind:'view_read_execution',fixture,mode:everyVariant?'variants':'classes',variants,completed,targetComparisons:2*completed,classes:classes.size,milliseconds:performance.now()-started,totalRowsRead,nativeWork:'adapter exposes no physical row counter; base/candidate exact on each target; D1 physical row accounting'}));
 });
}
test.skipIf(!fullReplay)('every listing statement-sequence class preserves actual native and D1 execution',()=>distinctExecutionClasses('listing'),7200000);
test.skipIf(!fullReplay)('every remaining statement-sequence class preserves actual native and D1 execution',()=>distinctExecutionClasses('arity'),7200000);
test.skipIf(!fullReplay)('every migrated listing variant preserves actual native and D1 result and cost',()=>distinctExecutionClasses('listing',true),7200000);
test.skipIf(!fullReplay)('every migrated remaining variant preserves actual native and D1 result and cost',()=>distinctExecutionClasses('arity',true),7200000);

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
 const text=operation==='M21:hook_placement_countUnplacedContextRecords:0'?emptyReadSql('/*vs:'+operation+'*/'+sql):sql;
 return JSON.stringify([target,operation,multiplexedAggregates.has(operation)?text:'projection']);
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


test('catalogue identity admits only each program declared schema stamp and preserves other fields',()=>{
 expect(activeCatalogueRows([{schema_version:'103',id:'member'}],103)).toEqual(activeCatalogueRows([{schema_version:'104',id:'member'}],104));
 expect(activeCatalogueRows([{schema_version:'105',id:'member'}],104)).not.toEqual(activeCatalogueRows([{schema_version:'103',id:'member'}],103));
 expect(activeCatalogueRows([{schema_version:'104',id:'other'}],104)).not.toEqual(activeCatalogueRows([{schema_version:'103',id:'member'}],103));
});

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


test('the empty-world M10 fence transformation applies only to its declared UPDATE',()=>{
 const sql='UPDATE plans SET status=? WHERE project_id=? AND plan_key=? AND (NOT EXISTS (SELECT 1 FROM session_views sv WHERE sv.project_id=plans.project_id)) RETURNING plan_key';
 expect(emptyReadSql('/*vs:M10:plans_planInSession:0*/'+sql)).toBe('UPDATE plans SET status=? WHERE project_id=? AND plan_key=? RETURNING plan_key');
 for(const operation of ['M24:plans_planTotals:0','M42:kpis_countOf:0'])expect(emptyReadSql('/*vs:'+operation+'*/'+sql)).toBe(sql);
});
