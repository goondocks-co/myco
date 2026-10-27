import {expect,it} from 'bun:test';
import {withViewReadResponse,turns_readTurnBodies} from '@myco-server-worker/read/view-store.js';
import {listTurns} from '@myco-server-worker/read/turns.js';
import {statementRecorder} from '../helpers/statement-recorder.js';
import {withViewStorePair,captureViewSession} from './helpers/view-stores.js';
import {mirrorConsumerWorld,mutateOriginalWorld,seedViewConsumerWorld,viewReadWorkloads} from './helpers/view-worlds.js';
import {publishMirroredSession} from './helpers/view-instances.js';
import {COST_MATERIALS,foreignLegacyHistory,appendCostHistory,explainReadPlan} from './helpers/view-read-costs.js';

const bytes=(value:unknown)=>JSON.stringify(value,(_key,row)=>row instanceof Map?[...row]:row);

for(const axis of ['C','P','K','G'] as const)it('intrinsic '+axis+' freezes per-sink native and D1 work before its larger world',async()=>{
 const levels=axis==='K'||axis==='G'?[5,50,500]:[1,8,32];
 const samples=new Map<string,Map<number,number[]>>(),bounds=new Map<string,{coefficient:number;intercept:number}[]>(),native=new Map<string,unknown>();
 for(const size of levels){
  let selected:string[]=[],tokenId='';
  await withViewStorePair('native-D1',async db=>{
  await seedViewConsumerWorld(db);
  const issued=await captureViewSession(db,'project','session',{idOffset:12000000});
  tokenId=issued.tokenId;
  if(axis==='C')for(let index=0;index<size;index++)await captureViewSession(db,'project','candidate-'+index,{idOffset:13000000+index*100});
  else if(axis!=='G')for(const material of COST_MATERIALS.filter(value=>axis==='K'||value.table==='prompt_batches')){
   const ids=await appendCostHistory(db,{projectId:'project',sessionId:'session',tokenId:issued.tokenId,material,from:0,through:axis==='P'?32:size,idBase:14000000});
   if(material.table==='prompt_batches')selected=ids;
  }
  },async(first,second)=>{
  for(const [db,target]of [[first,'native'],[second,'D1']] as const){
  const workloads=axis==='P'?[
   {id:'selected/pages',read:(store:typeof db)=>listTurns(store,{projectId:'project'},'session',{limit:size})},
   {id:'selected/bodies',read:(store:typeof db)=>turns_readTurnBodies(store,{projectId:'project'},'session',selected.slice(0,size))},
  ]:viewReadWorkloads().filter(workload=>axis==='C'||axis==='G'||/^(?:tools\/all|contexts|hook\/count\/|session\/counts$|feed$|activity\/|title\/)/.test(workload.id));
  const expected=new Map<string,string>();
  for(const workload of workloads)expected.set(workload.id,bytes(await withViewReadResponse(db,()=>700,workload.read)));
  await mirrorConsumerWorld(db);
  if(axis==='G'){
   for(const material of COST_MATERIALS)await appendCostHistory(db,{projectId:'project',sessionId:'session',tokenId,material,from:0,through:size,idBase:14000000});
   await publishMirroredSession(db,'project','session','world-tail-session','world-parent-session');
  }else await mutateOriginalWorld(db,'gone');
  for(const workload of workloads){
   const observed=statementRecorder(db,{accounting:target==='D1'?'d1':'native'});
   expect(bytes(await withViewReadResponse(observed.db,()=>700,workload.read)),axis+'/'+size+'/'+target+'/'+workload.id).toBe(expected.get(workload.id)!);
   await observed.drain();
   const key=size+'/'+workload.id,shape=observed.statements.map(query=>({sql:query.sql,binds:query.binds,method:query.method}));
   if(target==='native')native.set(key,shape);else expect<unknown>(shape,axis+'/'+key+' native-produced trace').toEqual(native.get(key)!);
   const probes=[];
   for(const query of observed.statements){
    expect(query.sql,axis+'/'+key+' protected FTS axis belongs to its search reader').not.toMatch(/\b(?:view_)?(?:prompts|responses|tool_calls|plans|prompt_batches)_fts\b/);
    const plan=await explainReadPlan(db,query);
    probes.push(plan.filter(row=>/^(?:SEARCH|SCAN) /.test(row.detail)).map(row=>row.detail));
   }
   if(target!=='D1')continue;
   const reads=observed.statements.map(query=>{if(query.rowsRead===undefined)throw new Error('Missing D1 intrinsic work');return query.rowsRead;});
   reads.push(reads.reduce((sum,value)=>sum+value,0));
   const sample=samples.get(workload.id)??new Map<number,number[]>();sample.set(size,reads);samples.set(workload.id,sample);
   if(size===levels[1]){
    const first=sample.get(levels[0]!)!;
    expect(reads.length,axis+'/'+workload.id+' per-sink sequence').toBe(first.length);
    bounds.set(workload.id,reads.map((value,index)=>{
     const coefficient=Math.max(0,Math.ceil((value-first[index]!)/(levels[1]!-levels[0]!)));
     return {coefficient,intercept:first[index]!-coefficient*levels[0]!};
    }));
   }
   const frozen=bounds.get(workload.id);
   if(frozen)for(const [index,read]of reads.entries()){
    const bound=frozen[index];if(bound===undefined)throw new Error('Uncalibrated intrinsic sink');
    expect(read,axis+'/'+size+'/'+workload.id+'/'+index+' frozen bound').toBeLessThanOrEqual(bound.coefficient*size+bound.intercept);
   }
   console.info('VIEW_INTRINSIC_COST',JSON.stringify({axis,size,workload:workload.id,target,reads,bounds:frozen,probes,T:0,FTS:'no protected FTS reader in these operations',phase:axis==='G'?'converted sessions until PR 8 cleanup':'current effective corpus'}));
  }
  }
 },'native');
 }
},180_000);

it('other sessions and Projects cannot contribute their legacy rows or classifications to any count arm',foreignLegacyHistory,180_000);
