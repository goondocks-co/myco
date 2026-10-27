import {execFileSync} from 'node:child_process';
import legacy from '../myco-server/fixtures/view-read-legacy.json';
import {SCHEMA_STEPS} from '../../packages/myco-server/src/db/schema.js';
import {protectedRelations} from './statement-recorder.js';
import policy from '../myco-server/fixtures/view-read-preparations.json';
import { checkedPreparationOrigins, checkedPreparationSource } from './statement-recorder.js';

export const preparationOriginPolicyUrl = new URL('../myco-server/fixtures/view-read-preparations.json', import.meta.url);
export const preparationOriginEnvelope = policy;
export function mergeSourceExceptions<T extends {id:string;dependencies?:unknown}>(frozen:readonly T[],writer:readonly T[]):T[]{
 const stable=(row:T)=>JSON.stringify(Object.entries(row).filter(([key])=>key!=='dependencies').sort(([a],[b])=>a.localeCompare(b)));
 const original=new Map(frozen.map(row=>[row.id,row]));
 for(const row of writer){
  const held=original.get(row.id);
  if(held&&stable(held)!==stable(row))throw new Error('Writer source exception may override dependencies only: '+row.id);
 }
 return [...frozen.filter(row=>!writer.some(held=>held.id===row.id)),...writer];
}
export const preparationSourceExceptions = mergeSourceExceptions(legacy.sourceExceptions,policy.writer.sourceExceptions);
export const preparationFoundationImports = [...legacy.foundationImports,...policy.writer.foundationImports.filter(row=>!legacy.foundationImports.some(held=>JSON.stringify(held)===JSON.stringify(row)))];
export const preparationSourcePins = await checkedPreparationSource(policy.sourceClosureProgram);
const fixtureIds=new Set(policy.extensions.flatMap(entry=>entry.ids));
const fixtureCallerKeys=preparationSourcePins.callers.map(row=>row.key).sort();

/** Fixture permissions match the entire sealed caller context. */
const writerOrigins=await checkedPreparationOrigins(policy.writer.preparationOrigins);
type PhysicalOrigin=Awaited<ReturnType<typeof checkedPreparationOrigins>>[number];
export function assertPreparationRelationsExtend(sealed:readonly string[],candidate:readonly string[]):void{
 if(sealed.some(relation=>!candidate.includes(relation)))throw new Error('Preparation refresh removes sealed relations');
}
export function refreshPreparationRelations(sealed:readonly string[],observations:readonly {relations:readonly string[]}[]):string[]{
 return [...new Set([...sealed,...observations.flatMap(row=>row.relations)])].sort();
}
// Forwarded preparations retain their module origin; the interceptor admits no protected SQL.
const EMPTY_LEGACY_INTERCEPTOR=JSON.stringify(['sink-07145','tests/myco-server/recall.test.ts',
 'it:records delayed plan-calibration failure and vector timing when spore hydration fails first','sql','T']);
export function mergePreparationOrigins(base:readonly PhysicalOrigin[],writer:readonly PhysicalOrigin[]):PhysicalOrigin[]{
 const key=(row:PhysicalOrigin)=>JSON.stringify([row.id,row.file,row.owner,row.expression,row.phase]);
 const originals=new Map(base.map(row=>[key(row),row]));
 for(const row of writer.filter(row=>!row.id.startsWith('pr5-'))){
  const held=originals.get(key(row));
  if(held===undefined)throw new Error('Writer preparation origin changes frozen tuple: '+row.id);
  if(key(row)===EMPTY_LEGACY_INTERCEPTOR&&row.relations?.length===0)continue;
  assertPreparationRelationsExtend(held.relations??[],row.relations??[]);
 }
 const overrides=new Map(writer.map(row=>[key(row),row]));
 return base.map(origin=>overrides.get(key(origin))??origin).concat(writer.filter(row=>row.id.startsWith('pr5-')));
}
export function resolvePreparationOrigins(base:readonly PhysicalOrigin[],writer:readonly PhysicalOrigin[]){
 return mergePreparationOrigins(base,writer).map(origin=>{
 if(origin.id.startsWith('H:'))return {...origin,relations:[...new Set(SCHEMA_STEPS.flatMap(step=>step.statements.flatMap(protectedRelations)))].sort()};
 if(policy.replayOnly.includes(origin.id))return {...origin,relations:[],...(origin.callerRelations===undefined?{}:{callerRelations:origin.callerRelations.map(context=>({...context,relations:[]}))})};
 return fixtureIds.has(origin.id)&&origin.callerRelations!==undefined?{...origin,callerKeys:fixtureCallerKeys}:origin;
});
}
export const preparationOrigins=resolvePreparationOrigins(await checkedPreparationOrigins(policy),writerOrigins);

/** The candidate source inventory includes tracked and unignored new files. */
export function preparationSourceInventory(root:string):string[]{
 const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--deduplicate','-z','--','packages/myco-server/src','packages/myco/src','packages/myco-shared/src','tests'],{cwd:root,encoding:'utf8'});
 return [...new Set(files.split('\0').filter(file=>/\.tsx?$/.test(file)))].sort();
}
