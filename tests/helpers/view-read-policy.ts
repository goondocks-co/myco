import {execFileSync} from 'node:child_process';
import legacy from '../myco-server/fixtures/view-read-legacy.json';
import {SCHEMA_STEPS} from '../../packages/myco-server/src/db/schema.js';
import {protectedRelations} from './statement-recorder.js';
import policy from '../myco-server/fixtures/view-read-preparations.json';
import { checkedPreparationOrigins, checkedPreparationSource } from './statement-recorder.js';

export const preparationOriginPolicyUrl = new URL('../myco-server/fixtures/view-read-preparations.json', import.meta.url);
export const preparationOriginEnvelope = policy;
export const preparationSourceExceptions = [...legacy.sourceExceptions.filter(row=>!policy.writer.sourceExceptions.some(held=>held.id===row.id)),...policy.writer.sourceExceptions];
export const preparationFoundationImports = [...legacy.foundationImports,...policy.writer.foundationImports.filter(row=>!legacy.foundationImports.some(held=>JSON.stringify(held)===JSON.stringify(row)))];
export const preparationSourcePins = await checkedPreparationSource(policy.sourceClosureProgram);
const fixtureIds=new Set(policy.extensions.flatMap(entry=>entry.ids));
const fixtureCallerKeys=preparationSourcePins.callers.map(row=>row.key).sort();

/** Fixture permissions match the entire sealed caller context. */
const writerOrigins=await checkedPreparationOrigins(policy.writer.preparationOrigins);
type PhysicalOrigin=Awaited<ReturnType<typeof checkedPreparationOrigins>>[number];
export function mergePreparationOrigins(base:readonly PhysicalOrigin[],writer:readonly PhysicalOrigin[]):PhysicalOrigin[]{
 const key=(row:PhysicalOrigin)=>JSON.stringify([row.id,row.file,row.owner,row.expression,row.phase]);
 const overrides=new Map(writer.map(row=>[key(row),row]));
 return base.map(origin=>overrides.get(key(origin))??origin).concat(writer.filter(row=>row.id.startsWith('pr5-')));
}
export const preparationOrigins = mergePreparationOrigins(await checkedPreparationOrigins(policy),writerOrigins).map(origin=>{
 if(origin.id.startsWith('H:'))return {...origin,relations:[...new Set(SCHEMA_STEPS.flatMap(step=>step.statements.flatMap(protectedRelations)))].sort()};
 if(policy.replayOnly.includes(origin.id))return {...origin,relations:[],...(origin.callerRelations===undefined?{}:{callerRelations:origin.callerRelations.map(context=>({...context,relations:[]}))})};
 return fixtureIds.has(origin.id)&&origin.callerRelations!==undefined?{...origin,callerKeys:fixtureCallerKeys}:origin;
});

/** The candidate source inventory includes tracked and unignored new files. */
export function preparationSourceInventory(root:string):string[]{
 const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--deduplicate','-z','--','packages/myco-server/src','packages/myco/src','packages/myco-shared/src','tests'],{cwd:root,encoding:'utf8'});
 return [...new Set(files.split('\0').filter(file=>/\.tsx?$/.test(file)))].sort();
}
