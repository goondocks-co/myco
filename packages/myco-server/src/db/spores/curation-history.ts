import type { RelationalStore } from '../../core/adapters.js';
import type { CurationAnswer } from '../../core/spore-curation-contract.js';
import { commit, write, type Bound } from '../index.js';
import { CURATION_HISTORY_BACKFILL, sporeStateSql, sporeKnowledgeSql } from './curation-history-sql.js';

export type CurationUnitKind = 'answer' | 'merge' | 'legacy' | 'resolution';
const insertUnit = write<[project: string, unit: string, kind: string, run: string | null, group: string | null, at: number, count: number]>({
  name: 'curationHistory.insertUnit',
  sql: `INSERT INTO spore_curation_units(project_id,id,kind,source_run_id,cluster_key,created_at,member_count) VALUES(?1,?2,?3,?4,?5,?6,?7)`,
});
const insertOriginals = write<[project: string, unit: string, members: string, at: number]>({
  name: 'curationHistory.insertOriginals',
  sql: `INSERT INTO spore_curation_unit_members(project_id,unit_id,spore_id,role,event_ids,before_json,after_json)
    SELECT ?1,?2,s.id,json_extract(m.value,'$.role'),json_extract(m.value,'$.events'),${sporeStateSql('s')},
      json_set(${sporeStateSql('s')},'$.status',COALESCE(json_extract(m.value,'$.status'),CASE WHEN json_extract(m.value,'$.role')='retired' THEN 'obsolete' ELSE 'consolidated' END),
        '$.revision',s.revision+1,'$.updatedAt',?4)
    FROM json_each(?3) m CROSS JOIN spores s ON s.project_id=?1 AND s.id=json_extract(m.value,'$.id')`,
});
const insertOutputs = write<[project: string, unit: string, outputs: string]>({
  name: 'curationHistory.insertOutputs',
  sql: `INSERT INTO spore_curation_unit_members(project_id,unit_id,spore_id,role,before_json,after_json)
    SELECT ?1,?2,s.id,'output',NULL,${sporeStateSql('s')}
    FROM json_each(?3) m CROSS JOIN spores s ON s.project_id=?1 AND s.id=m.value`,
});

const insertTarget = write<[project:string,unit:string,target:string]>({
  name:'curationHistory.insertTarget',
  sql:`INSERT INTO spore_curation_unit_members(project_id,unit_id,spore_id,role,before_json,after_json)
    SELECT ?1,?2,s.id,'target',NULL,json_set(${sporeKnowledgeSql('s')},'$.id',s.id) FROM spores s WHERE s.project_id=?1 AND s.id=?3`,
});
interface CapturedOriginal {id:string;role:'source'|'retired';events:readonly string[];status?:string}
interface Capture {
  project: string; unit: string; kind: CurationUnitKind; run: string | null; group: string | null; now: number;
  originals: readonly CapturedOriginal[]; outputs: readonly string[]; retainedTarget?: string;
}

/** Capture runs before any original moves, inside the operation's admitted batch. */
function capture(options: Capture): Bound[] {
  if (options.originals.length === 0 && options.outputs.length === 0) return [];
  return [insertUnit.bind(options.project,options.unit,options.kind,options.run,options.group,options.now,options.originals.length+options.outputs.length+(options.retainedTarget===undefined?0:1)),
    insertOriginals.bind(options.project,options.unit,JSON.stringify(options.originals),options.now),
    ...(options.outputs.length===0?[]:[insertOutputs.bind(options.project,options.unit,JSON.stringify(options.outputs))]),
    ...(options.retainedTarget===undefined?[]:[insertTarget.bind(options.project,options.unit,options.retainedTarget)])];
}

export const curationAnswerHistory = (options: {
  project: string; run: string; group: string; now: number; answer: CurationAnswer; outputs: readonly string[];
  events: readonly {id:string;source:string}[];
}): Bound[] => {
  const originals=[...[...new Set(options.answer.notes.flatMap(note => note.sources))].map(id => ({id,role:'source' as const})),
    ...options.answer.retire.map(note => ({id:note.id,role:'retired' as const}))];
  return capture({...options,unit:options.run,kind:'answer',originals:originals.map(member=>({...member,
    events:options.events.filter(event=>event.source===member.id).map(event=>event.id)}))});
};

export const curationMergeHistory = (options: {project:string;target:string;sources:readonly {id:string;event:string}[];now:number}): Bound[] =>
  capture({...options,unit:options.target,kind:'merge',run:null,group:null,
    originals:options.sources.map(source=>({id:source.id,role:'source',events:[source.event]})),outputs:[options.target]});

export const curationResolutionHistory = (options:{project:string;event:string;source:string;target:string;status:string;now:number}):Bound[] =>
  capture({...options,unit:options.event,kind:'resolution',run:null,group:null,outputs:[],retainedTarget:options.target,
    originals:[{id:options.source,role:'source',status:options.status,events:[options.event]}]});

const bootstrap = CURATION_HISTORY_BACKFILL.map((sql,index) => write<[]>({ name: `curationHistory.bootstrap${index}`, sql }));
/** Reconcile retained operation history after restoring an older artifact; recorded decisions stay authoritative. */
export const initializeCurationHistory = (db: RelationalStore): Promise<unknown> => commit(db,...bootstrap.map(statement=>statement.bind()));
