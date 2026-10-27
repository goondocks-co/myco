import * as miniflare from 'miniflare';
import {afterEach, mock} from 'bun:test';
import * as native from '../../packages/myco-server/src/platform/bun/sqlite.js';
import type {RelationalStore} from '../../packages/myco-server/src/core/adapters.js';
import {statementRecorder,instrumentReadPreparations,instrumentObservedClock,instrumentNativeReadRequests,installReadPreparationBoundary,preparationSourcePaths} from '../helpers/statement-recorder.js';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';

import {preparationOrigins,preparationSourcePins} from '../helpers/view-read-policy.js';
export {preparationOrigins} from '../helpers/view-read-policy.js';
export const preparationRecorder=path.resolve(import.meta.dir,'../helpers/statement-recorder.ts');
const repository=path.resolve(import.meta.dir,'../..')+path.sep;
const sourcePaths=preparationSourcePaths(repository);
export function instrumentReadSource(source:string,file:string):string{
 const relative=sourcePaths.relative(file);
 return instrumentObservedClock(ts,instrumentNativeReadRequests(ts,instrumentReadPreparations(ts,source,relative,preparationOrigins,preparationRecorder,preparationSourcePins.callers),relative,preparationRecorder),relative,preparationRecorder);
}
Bun.plugin({name:'view-read-preparation-origins',setup(build){
 build.onLoad({filter:sourcePaths.filter},args=>{
  const source=fs.readFileSync(args.path,'utf8'),contents=args.path.includes('.generated.')?source:instrumentReadSource(source,args.path);
  return {contents,loader:args.path.endsWith('tsx')?'tsx':args.path.endsWith('.ts')?'ts':'js'};
 });
}});
const {runtimeBoundary}=await import('../helpers/view-read-contract.js');
installReadPreparationBoundary(statement=>{
 const errors=runtimeBoundary([statement]);
 if(errors.length)throw new Error(errors.join('\n'));
});

const createNativeStore=native.sqliteRelationalStore;
const OriginalMiniflare=miniflare.Miniflare;
let createdStores=0;
const stores=new Set<ReturnType<typeof statementRecorder>>();
const observed=new WeakMap<RelationalStore,ReturnType<typeof statementRecorder>>();
const totals=new Map<string,{prepares:number;binds:number;executions:number}>();
const byTarget=new Map<string,Map<string,{prepares:number;binds:number;executions:number}>>();

export function observeReadStore(store: RelationalStore, target: 'native' | 'd1'): RelationalStore {
 const held=observed.get(store);
 if(held)return held.db;
 const recorder=statementRecorder(store,{accounting:target,bufferLimit:1024,prepared:()=>{stores.add(recorder);},event(event){
   const tag=/^\/\*vs:([A-Za-z0-9_:]+)\*\//.exec(event.sql);
   if(!tag)return;
   const row=totals.get(tag[1]!)??{prepares:0,binds:0,executions:0};
   if(event.kind==='prepare')row.prepares++;
   else if(event.kind==='bind')row.binds++;
   else row.executions++;
   totals.set(tag[1]!,row);
   const operations=byTarget.get(target)??new Map<string,{prepares:number;binds:number;executions:number}>();
   const targetRow=operations.get(tag[1]!)??{prepares:0,binds:0,executions:0};
   if(event.kind==='prepare')targetRow.prepares++;else if(event.kind==='bind')targetRow.binds++;else targetRow.executions++;
   operations.set(tag[1]!,targetRow);byTarget.set(target,operations);
 }});
 createdStores++;
 stores.add(recorder);observed.set(store,recorder);observed.set(recorder.db,recorder);
 return recorder.db;
}

export function nativeReadObservations() {
 return {stores:createdStores,operations:new Map(totals),targets:new Map([...byTarget].map(([target,rows])=>[target,new Map([...rows].map(([id,row])=>[id,{...row}]))]))};
}

export async function factoryReadTrace(){
 for(const store of stores)await store.drain();
 return {events:[...stores].flatMap(store=>store.events),statements:[...stores].flatMap(store=>store.statements)};
}

mock.module('../../packages/myco-server/src/platform/bun/sqlite.js',()=>({
 ...native,
 sqliteRelationalStore:(...args:Parameters<typeof createNativeStore>)=>observeReadStore(createNativeStore(...args),'native'),
}));

export async function checkpointReadObservations(){
 for(const store of stores) {
  await store.drain();
  store.reset();
 }
 stores.clear();
}
afterEach(checkpointReadObservations);

mock.module('miniflare',()=>({...miniflare,Miniflare:class ObservedMiniflare extends OriginalMiniflare {
 async getD1Database(...args:Parameters<InstanceType<typeof OriginalMiniflare>['getD1Database']>) {
  const database=await super.getD1Database(...args);
  const observed=observeReadStore(database,'d1');
  return new Proxy(database,{get(target,key,receiver){
   if(key==='prepare')return observed.prepare;
   if(key==='batch')return observed.batch;
   const value=Reflect.get(target,key,receiver);
   return typeof value==='function'?value.bind(target):value;
  }});
 }
}}));

const operator=await import('../../packages/myco/src/server/d1-operator-store.js');
const createOperatorStore=operator.d1OperatorStore;
mock.module('../../packages/myco/src/server/d1-operator-store.js',()=>({...operator,
 d1OperatorStore:(...args:Parameters<typeof createOperatorStore>)=>observeReadStore(createOperatorStore(...args),'d1'),
}));
