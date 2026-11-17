import type { RelationalStore } from '../../core/adapters.js';
import type { CurationAnswer } from '../../core/spore-curation-contract.js';
import { commit, write, type Bound } from '../index.js';
import { CURATION_HISTORY_BACKFILL, sporeStateSql } from './curation-history-sql.js';

export type CurationUnitKind = 'answer' | 'merge' | 'legacy';
const insertUnit = write<[project: string, unit: string, kind: string, run: string | null, group: string | null, at: number, count: number]>({
  name: 'curationHistory.insertUnit',
  sql: `INSERT INTO spore_curation_units(project_id,id,kind,source_run_id,cluster_key,created_at,member_count) VALUES(?1,?2,?3,?4,?5,?6,?7)`,
});
const insertOriginals = write<[project: string, unit: string, members: string, at: number]>({
  name: 'curationHistory.insertOriginals',
  sql: `INSERT INTO spore_curation_unit_members(project_id,unit_id,spore_id,role,before_json,after_json)
    SELECT ?1,?2,s.id,json_extract(m.value,'$.role'),${sporeStateSql('s')},
      json_set(${sporeStateSql('s')},'$.status',CASE WHEN json_extract(m.value,'$.role')='retired' THEN 'obsolete' ELSE 'consolidated' END,
        '$.revision',s.revision+1,'$.updatedAt',?4)
    FROM json_each(?3) m CROSS JOIN spores s ON s.project_id=?1 AND s.id=json_extract(m.value,'$.id')`,
});
const insertOutputs = write<[project: string, unit: string, outputs: string]>({
  name: 'curationHistory.insertOutputs',
  sql: `INSERT INTO spore_curation_unit_members(project_id,unit_id,spore_id,role,before_json,after_json)
    SELECT ?1,?2,s.id,'output',NULL,${sporeStateSql('s')}
    FROM json_each(?3) m CROSS JOIN spores s ON s.project_id=?1 AND s.id=m.value`,
});

interface Capture {
  project: string; unit: string; kind: 'answer' | 'merge'; run: string | null; group: string | null; now: number;
  originals: readonly { id: string; role: 'source' | 'retired' }[]; outputs: readonly string[];
}

/** Capture runs after output insertion and before any original note moves, inside that operation's admitted batch. */
function capture(options: Capture): Bound[] {
  if (options.originals.length === 0 && options.outputs.length === 0) return [];
  return [insertUnit.bind(options.project,options.unit,options.kind,options.run,options.group,options.now,options.originals.length+options.outputs.length),
    insertOriginals.bind(options.project,options.unit,JSON.stringify(options.originals),options.now),
    insertOutputs.bind(options.project,options.unit,JSON.stringify(options.outputs))];
}

export const curationAnswerHistory = (options: {
  project: string; run: string; group: string; now: number; answer: CurationAnswer; outputs: readonly string[];
}): Bound[] => capture({ ...options, unit: options.run, kind: 'answer',
  originals: [...[...new Set(options.answer.notes.flatMap(note => note.sources))].map(id => ({id,role:'source' as const})),
    ...options.answer.retire.map(note => ({id:note.id,role:'retired' as const}))] });

export const curationMergeHistory = (options: { project: string; target: string; sources: readonly string[]; now: number }): Bound[] =>
  capture({ ...options, unit: options.target, kind: 'merge', run: null, group: null, originals: options.sources.map(id=>({id,role:'source'})), outputs: [options.target] });

const bootstrap = CURATION_HISTORY_BACKFILL.map((sql,index) => write<[]>({ name: `curationHistory.bootstrap${index}`, sql }));
/** Reconcile retained operation history after a restore of an older artifact. Existing units and undo decisions stay authoritative. */
export const initializeCurationHistory = (db: RelationalStore): Promise<unknown> => commit(db,...bootstrap.map(statement=>statement.bind()));
