import {execFileSync} from 'node:child_process';
import policy from '../myco-server/fixtures/view-read-preparations.json';
import { checkedPreparationOrigins, checkedPreparationSource } from './statement-recorder.js';

export const preparationOriginPolicyUrl = new URL('../myco-server/fixtures/view-read-preparations.json', import.meta.url);
export const preparationOriginEnvelope = policy;
export const preparationSourcePins = await checkedPreparationSource(policy.sourceClosureProgram);
const fixtureIds=new Set(policy.extensions.flatMap(entry=>entry.ids));
const fixtureCallerKeys=preparationSourcePins.callers.map(row=>row.key).sort();

/** Fixture permissions match the entire sealed caller context. */
export const preparationOrigins = (await checkedPreparationOrigins(policy)).map(origin=>{
 if(policy.replayOnly.includes(origin.id))return {...origin,relations:[],...(origin.callerRelations===undefined?{}:{callerRelations:origin.callerRelations.map(context=>({...context,relations:[]}))})};
 return fixtureIds.has(origin.id)&&origin.callerRelations!==undefined?{...origin,callerKeys:fixtureCallerKeys}:origin;
});

/** The candidate source inventory includes tracked and unignored new files. */
export function preparationSourceInventory(root:string):string[]{
 const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--deduplicate','-z','--','packages/myco-server/src','packages/myco/src','packages/myco-shared/src','tests'],{cwd:root,encoding:'utf8'});
 return [...new Set(files.split('\0').filter(file=>/\.tsx?$/.test(file)))].sort();
}
