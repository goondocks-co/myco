import fs from 'node:fs';
const {appendFileSync}=fs;
import {createHash} from 'node:crypto';
import {ViewReadRefusal} from '@myco-server-worker/core/read-refusals.js';
import {expect} from 'bun:test';
import {writerReadTest as it} from './helpers/view-instances.js';
import {LEGACY_ONLY_OPERATIONS,withViewReadResponse} from '@myco-server-worker/read/view-store.js';
import {statementRecorder,type RecordedStatement} from '../helpers/statement-recorder.js';
import {readTag} from '../helpers/view-read-contract.js';
import {VIEW_READ_OPERATIONS} from '../helpers/view-read-operations.js';
import {withViewStorePair} from './helpers/view-stores.js';
import {mirrorConsumerWorld,mutateOriginalWorld,seedViewConsumerWorld,viewReadWorkloads,viewArityWorkloads} from './helpers/view-worlds.js';
import {appendViewCostHistory} from './helpers/view-instances.js';

const bytes=(value:unknown)=>JSON.stringify(value,(_key,row)=>row instanceof Map?[...row]:row);
const migrated:string[]=VIEW_READ_OPERATIONS.filter(row=>row.family!==null&&!new Set<string>(LEGACY_ONLY_OPERATIONS).has(row.id)).map(row=>row.id).sort();

it('every migrated operation retains its independent writer-world output in parent, poison and gone worlds',async()=>{
 const differences:string[]=[];
 await withViewStorePair('native-D1',db=>seedViewConsumerWorld(db,false),async(first,second)=>{
  for(const [db,target] of [[first,'native'],[second,'D1']] as const){
  const expected=new Map<string,string>();
  const workloads=viewReadWorkloads();
  for(const workload of workloads)expected.set(workload.id,bytes(await workload.read(db)));
  expect(Number(expected.get('hook/count/session'))).toBeGreaterThan(0);
  const counts:unknown=JSON.parse(expected.get('session/counts')!);
  if(typeof counts!=='object'||counts===null)throw new Error('Writer world has no material counts');
  const rowsPerInstance=Math.max(...Object.values(counts).filter((value):value is number=>typeof value==='number'));
  await mirrorConsumerWorld(db);
  for(const world of ['parent','poison','gone'] as const){
   const covered=new Set<string>();
   if(world!=='parent')await mutateOriginalWorld(db,world);
   for(const workload of workloads){
    const recorded=statementRecorder(db,{accounting:target==='D1'?'d1':'native'});
    let actual:unknown;
    try{actual=await withViewReadResponse(recorded.db,()=>700,workload.read);}
    catch(error){
     if(!(error instanceof ViewReadRefusal))throw error;
     actual={refusal:error.code};
    }
    const same=bytes(actual)===expected.get(workload.id)!;
    if(!same)differences.push([target,world,workload.id].join('/'));
    const sensitivity=process.env.MYCO_VIEW_READ_SENSITIVITY_REPORT;
    if(sensitivity)appendFileSync(sensitivity,JSON.stringify({target,world,workload:workload.id,same,expected:expected.get(workload.id),actual:bytes(actual),
     sinks:recorded.statements.map(query=>({tag:readTag(query.sql),method:query.method,binds:query.binds,sql:query.sql,template:createHash('sha256').update(query.sql).digest('hex')}))})+'\n');
    const planFile=process.env.MYCO_VIEW_READ_WORLD_PLANS;
    for(const query of recorded.statements){
     const plan=await explainReadPlan(db,query),source=viewSourceArmPlans(query,plan,{instances:2,rowsPerInstance,survivingFacts:world==='gone'?0:rowsPerInstance});
     if(source.errors.length){
      console.info('VIEW_SOURCE_Q_FAILURE',JSON.stringify({target,world,workload:workload.id,errors:source.errors}));
      if(planFile)appendFileSync(planFile,JSON.stringify({target,world,workload:workload.id,query,plan,source})+'\n');
     }
     for(const error of source.errors)differences.push(target+'/'+world+'/'+workload.id+' source arm: '+error);
     const isolated=[];
     for(const alone of isolatedViewSources(query,{projectId:'project',sessionId:'session'})){
      const alonePlan=await explainReadPlan(db,alone),checked=viewSourceArmPlans(alone,alonePlan,{instances:2,rowsPerInstance,survivingFacts:world==='gone'?0:rowsPerInstance});
      if(checked.errors.length)console.info('VIEW_ISOLATED_Q_FAILURE',JSON.stringify({target,world,workload:workload.id,name:alone.name,errors:checked.errors}));
      for(const error of checked.errors)differences.push(target+'/'+world+'/'+workload.id+'/'+alone.name+' standalone source arm: '+error);
      if(planFile)isolated.push({query:alone,plan:alonePlan,source:checked});
     }
     if(planFile)appendFileSync(planFile,JSON.stringify({target,world,workload:workload.id,query,plan,source,isolated})+'\n');
    }
    for(const statement of recorded.statements){const tag=readTag(statement.sql);if(tag!==null&&migrated.includes(tag.operation))covered.add(tag.operation)}
   }
   expect([...covered].sort(),target+'/'+world+' operation inventory').toEqual(migrated);
  }
  }
 },'native');
 expect(differences,'all independent public values and physical source plans').toEqual([]);
},120_000);

it('actual consumer templates freeze view-history work before larger hidden-instance histories',async()=>{
 const native=new Map<string,{sql:string;bindCount:number;method:RecordedStatement['method']}[]>();
 await withViewStorePair('native-D1',async db=>{
  await seedViewConsumerWorld(db);await mirrorConsumerWorld(db);await mutateOriginalWorld(db,'gone');
 },async(first,second)=>{
  for(const [db,target] of [[first,'native'],[second,'D1']] as const){
  const frozen=new Map<string,{bytes:string;reads:(number|null)[];queries:{sql:string;binds:readonly unknown[];method:RecordedStatement['method']}[]}>();
  const workloads=viewReadWorkloads();
  let previous=0;
  for(const history of [400,1200,5000]){
   await appendViewCostHistory(db,[{projectId:'project',sessionId:'session',instanceId:'world-parent-session'}],previous,history);
   previous=history;
   for(const workload of workloads){
    const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native'});
    const result=bytes(await withViewReadResponse(observed.db,()=>700,workload.read));
    const key=history+'/'+workload.id;
    const queries=observed.statements.map(row=>({sql:row.sql,binds:row.binds,method:row.method}));
    const shape=queries.map(({sql,binds,method})=>({sql,bindCount:binds.length,method}));
    if(target==='native')native.set(key,shape);else expect(shape,target+'/'+key+' native template trace').toEqual(native.get(key)!);
    const reads=observed.statements.map(row=>{
     if(target==='D1'&&row.rowsRead===undefined)throw new Error('D1 rows_read missing for '+workload.id);
     return row.rowsRead??null;
    });
    if(history===400)frozen.set(workload.id,{bytes:result,reads,queries});
    const bound=frozen.get(workload.id)!;
    expect(result,target+'/'+key).toBe(bound.bytes);
    expect(reads.length,target+'/'+key+' statement count').toBe(bound.reads.length);
    expect(queries,target+'/'+key+' same seeded-world trace').toEqual(bound.queries);
    if(target==='D1')for(const [index,count]of reads.entries())expect(count,target+'/'+key+'/'+index).toBeLessThanOrEqual(bound.reads[index]!);
    console.info('VIEW_TEMPLATE_HISTORY',JSON.stringify({target,history,workload:workload.id,reads,bound:bound.reads,accounting:target==='D1'?'actual D1 rows_read':'native statement trace; no rows_read attribution'}));
   }
  }
  }
 },'native');
},180_000);

import {COST_MATERIALS,convertedLegacyHistory,hiddenLegacyHistory,survivingFactHistory,SURVIVING_FACT_READ_COEFFICIENT,HIDDEN_LEGACY_READ_COEFFICIENT,type CorpusReadBound} from './helpers/view-read-costs.js';
const legacyBounds=new Map<string,CorpusReadBound>(),factBounds=new Map<string,CorpusReadBound>();
const CALIBRATION_ROWS=5;
let calibration:Promise<void>|undefined;
function calibrateReadBounds():Promise<void>{
 return calibration??=(async()=>{
 for(const {read,bounds,rowCoefficient}of [
  {read:hiddenLegacyHistory,bounds:legacyBounds,rowCoefficient:HIDDEN_LEGACY_READ_COEFFICIENT},
  {read:survivingFactHistory,bounds:factBounds,rowCoefficient:SURVIVING_FACT_READ_COEFFICIENT},
 ])await read(CALIBRATION_ROWS,undefined,(table,read)=>{
  const coefficient=rowCoefficient*(table==='operation'?COST_MATERIALS.length:1);
  bounds.set(table,{coefficient,intercept:read-coefficient*CALIBRATION_ROWS});
 });
 })();
}
for(const material of COST_MATERIALS.filter(value=>value.table==='plans'))it(
 'converted-session '+material.table+' freezes its H_legacy term until PR 8 cleanup',
 ()=>convertedLegacyHistory(material),180_000);
for(const rows of [0,5,50,500]){
 it('view-side H has zero coefficient with hidden legacy G='+rows,async()=>{await calibrateReadBounds();await hiddenLegacyHistory(rows,legacyBounds);},180_000);
 it('new-session surviving-fact R='+rows+' retains its frozen corpus slope',async()=>{await calibrateReadBounds();await survivingFactHistory(rows,factBounds);},180_000);
}


it('empty, maximum and split arities preserve both-target rows and hosted planner limits',async()=>{
 await withViewStorePair('native-D1',db=>seedViewConsumerWorld(db,false),async(first,second)=>{
  for(const [db,target] of [[first,'native'],[second,'D1']] as const){
  const workloads=viewArityWorkloads(),expected=new Map<string,string>();
  for(const workload of workloads)expected.set(workload.id,bytes(await workload.read(db)));
  await mirrorConsumerWorld(db);
  for(const world of ['parent','poison','gone'] as const){
   if(world!=='parent')await mutateOriginalWorld(db,world);
   for(const workload of workloads){
    const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native'});
    expect(bytes(await workload.read(observed.db)),target+'/'+world+'/'+workload.id).toBe(expected.get(workload.id)!);
    await observed.drain();
    for(const query of observed.statements){
     expect(query.binds.length,target+'/'+world+'/'+workload.id+' binds').toBeLessThanOrEqual(100);
     const limits=readStatementLimits(query.sql);
     for(const terms of limits.compoundTerms)expect(terms,target+'/'+workload.id+' compound terms').toBeLessThanOrEqual(5);
     for(const terms of limits.effectiveSourceTerms)expect(terms,target+'/'+workload.id+' effective source terms').toBeLessThanOrEqual(3);
     expect(jsonDriverOrderViolations(await explainReadPlan(db,query)),target+'/'+world+'/'+workload.id+' JSON loop').toEqual([]);
    }
   }
  }
  }
 },'native');
},180_000);

import {readStatementLimits,jsonDriverOrderViolations,explainReadPlan,viewSourceArmPlans,isolatedViewSources} from './helpers/view-read-costs.js';
