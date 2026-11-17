import type { RelationalStore } from '../../core/adapters.js';
import { USER_AGENT_ID } from '../../constants.js';
import { assertion, commitNamed, first, read, readSet, refusalCode, refusalDetail, write } from '../index.js';
import type { CurationUnitKind } from './curation-history.js';
import { sporeStateSql, sameSporeStateSql } from './curation-history-sql.js';
import { curationCloseWrites } from './curation-work.js';

const UNIT_MEMBERS = 'sqlite_autoindex_spore_curation_unit_members_1';

export interface CurationUnit {
  id: string; kind: CurationUnitKind; created_at: number; member_count: number; unavailable: string | null;
  undone_at: number | null; undone_by: string | null; undone_label: string | null;
}
export interface CurationUndoNote { id: string; role: 'source' | 'retired' | 'output'; label: string; revision: number }
export interface CurationUndoConflict {
  code: string; noteId?: string; label?: string; field?: string; actual?: unknown; expected?: unknown;
  laterUnitId?: string | null; laterNoteId?: string | null;
}
const unitById = read<[project: string, unit: string], CurationUnit>({
  name:'curationUndo.unit',sql:'SELECT * FROM spore_curation_units WHERE project_id=?1 AND id=?2',
});
const unitForNote = read<[project: string, note: string], CurationUnit>({
  name:'curationUndo.forNote',
  sql:`SELECT u.* FROM spore_curation_unit_members m JOIN spore_curation_units u ON u.project_id=m.project_id AND u.id=m.unit_id
    WHERE m.project_id=?1 AND m.spore_id=?2
    ORDER BY u.undone_at IS NULL DESC,CASE WHEN m.role='output' THEN 1 ELSE 0 END,u.created_at DESC,u.id LIMIT 1`,
});
const notes = read<[project: string, unit: string], CurationUndoNote>({
  name:'curationUndo.notes',
  sql:`SELECT m.spore_id AS id,m.role,COALESCE(NULLIF(json_extract(m.after_json,'$.agentLine'),''),'A note without guidance') AS label,
    COALESCE(s.revision,json_extract(m.after_json,'$.revision')) AS revision
    FROM spore_curation_unit_members m INDEXED BY ${UNIT_MEMBERS} LEFT JOIN spores s ON s.project_id=m.project_id AND s.id=m.spore_id
    WHERE m.project_id=?1 AND m.unit_id=?2 ORDER BY m.role,m.spore_id`,
});
const conflictSql = (project: string, unit: string): string => `SELECT json_object(
    'code',CASE WHEN s.id IS NULL THEN 'note_missing' ELSE 'note_changed' END,'noteId',m.spore_id,
    'label',COALESCE(NULLIF(json_extract(m.after_json,'$.agentLine'),''),'A note without guidance'),
    'field',CASE WHEN s.id IS NULL THEN 'missing' ELSE
      (SELECT key FROM json_each(m.after_json) expected WHERE json_extract(${sporeStateSql('s')},'$."'||expected.key||'"') IS NOT expected.value LIMIT 1) END,
    'actual',s.status,'expected',json_extract(m.after_json,'$.status'),
    'laterUnitId',(SELECT u.id FROM spore_curation_unit_members later CROSS JOIN spore_curation_units u ON u.project_id=later.project_id AND u.id=later.unit_id
      WHERE later.project_id=m.project_id AND later.spore_id=m.spore_id AND later.role IN ('source','retired') AND later.unit_id<>m.unit_id AND u.undone_at IS NULL
      ORDER BY u.created_at DESC,u.id LIMIT 1),
    'laterNoteId',(SELECT o.spore_id FROM spore_curation_unit_members later CROSS JOIN spore_curation_units u ON u.project_id=later.project_id AND u.id=later.unit_id
      CROSS JOIN spore_curation_unit_members o INDEXED BY ${UNIT_MEMBERS} ON o.project_id=u.project_id AND o.unit_id=u.id AND o.role='output'
      WHERE later.project_id=m.project_id AND later.spore_id=m.spore_id AND later.role IN ('source','retired') AND later.unit_id<>m.unit_id AND u.undone_at IS NULL
      ORDER BY u.created_at DESC,u.id,o.spore_id LIMIT 1)) AS detail
  FROM spore_curation_unit_members m INDEXED BY ${UNIT_MEMBERS} LEFT JOIN spores s ON s.project_id=m.project_id AND s.id=m.spore_id
  WHERE m.project_id=${project} AND m.unit_id=${unit} AND (s.id IS NULL OR NOT ${sameSporeStateSql('m.after_json',sporeStateSql('s'))})
  ORDER BY CASE WHEN m.role='output' THEN 0 ELSE 1 END,m.spore_id LIMIT 1`;
const conflict = read<[project: string, unit: string], {detail:string}>({name:'curationUndo.conflict',sql:conflictSql('?1','?2')});
export const curationUnitForNote = (db:RelationalStore,project:string,note:string) => first(db,unitForNote.bind(project,note));
export const readCurationUnit = (db:RelationalStore,project:string,unit:string) => first(db,unitById.bind(project,unit));
export async function readCurationUndoDetails(db:RelationalStore,project:string,unit:CurationUnit) {
  const [members,blocked]=await readSet(db,notes.bind(project,unit.id),...(unit.undone_at===null?[conflict.bind(project,unit.id)]:[]));
  return {members,conflict:blocked?.[0]===undefined?null:JSON.parse(blocked[0].detail) as CurationUndoConflict};
}

const UNDO_REFUSED=refusalCode('curation_undo_refused');
export const curationUndoRefusal=(error:unknown):CurationUndoConflict|null=>{
  const detail=refusalDetail(error,UNDO_REFUSED);return detail===null?null:JSON.parse(detail) as CurationUndoConflict;
};
const admitted=assertion<[project:string,unit:string,actor:string]>({
  name:'curationUndo.admitted',refusal:UNDO_REFUSED,
  with:`WITH unit AS(SELECT * FROM spore_curation_units WHERE project_id=?1 AND id=?2),bad AS(${conflictSql('?1','?2')})`,
  when:`EXISTS(SELECT 1 FROM members WHERE id=?3 AND role='admin' AND revoked_at IS NULL)
    AND EXISTS(SELECT 1 FROM unit WHERE undone_at IS NULL AND unavailable IS NULL AND member_count>0
      AND member_count=(SELECT COUNT(*) FROM spore_curation_unit_members WHERE project_id=?1 AND unit_id=?2)) AND NOT EXISTS(SELECT 1 FROM bad)`,
  detail:`CASE WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=?3 AND role='admin' AND revoked_at IS NULL) THEN json_object('code','not_admin')
    WHEN NOT EXISTS(SELECT 1 FROM unit) THEN json_object('code','not_found')
    WHEN EXISTS(SELECT 1 FROM unit WHERE undone_at IS NOT NULL) THEN json_object('code','already_undone')
    WHEN EXISTS(SELECT 1 FROM unit WHERE unavailable IS NOT NULL) THEN json_object('code','history_unavailable')
    WHEN EXISTS(SELECT 1 FROM bad) THEN (SELECT detail FROM bad)
    ELSE json_object('code','history_incomplete') END`,
});
const undoEvents=write<[project:string,unit:string,actor:string,agent:string,at:number]>({
  name:'curationUndo.events',
  sql:`INSERT INTO resolution_events(project_id,id,agent_id,spore_id,action,reason,author,created_at)
    SELECT ?1,?2||':undo:'||m.spore_id,?4,m.spore_id,CASE WHEN m.role='output' THEN 'obsolete' ELSE 'restore' END,
      'Curation undone by '||COALESCE((SELECT NULLIF(label,'') FROM members WHERE id=?3),'an administrator')||'. Original notes restored.',?3,?5
    FROM spore_curation_unit_members m INDEXED BY ${UNIT_MEMBERS} WHERE m.project_id=?1 AND m.unit_id=?2`,
});
const rebaseParents=write<[project:string,unit:string,at:number]>({
  name:'curationUndo.parents',
  sql:`UPDATE spore_curation_unit_members AS parent SET after_json=json_set(parent.after_json,
      '$.revision',(SELECT s.revision+1 FROM spores s WHERE s.project_id=parent.project_id AND s.id=parent.spore_id),'$.updatedAt',?3)
    WHERE parent.rowid IN(SELECT held.rowid FROM spore_curation_unit_members child INDEXED BY ${UNIT_MEMBERS}
      CROSS JOIN spore_curation_unit_members held INDEXED BY idx_curation_unit_output ON held.project_id=child.project_id AND held.spore_id=child.spore_id AND held.role='output'
      CROSS JOIN spore_curation_units u ON u.project_id=held.project_id AND u.id=held.unit_id
      WHERE child.project_id=?1 AND child.unit_id=?2 AND child.role<>'output' AND held.unit_id<>?2
        AND u.undone_at IS NULL AND ${sameSporeStateSql('child.before_json','held.after_json')})`,
});
const move=write<[project:string,unit:string,at:number]>({
  name:'curationUndo.move',
  sql:`UPDATE spores SET status=CASE WHEN EXISTS(SELECT 1 FROM spore_curation_unit_members m WHERE m.project_id=?1 AND m.unit_id=?2 AND m.spore_id=spores.id AND m.role='output') THEN 'obsolete' ELSE 'active' END,
      revision=revision+1,updated_at=?3 WHERE project_id=?1 AND id IN(SELECT spore_id FROM spore_curation_unit_members WHERE project_id=?1 AND unit_id=?2)`,
});
const keepWork=write<[project:string,key:string,members:string]>({
  name:'curationUndo.keepWork',sql:`INSERT INTO spore_curation_work(project_id,cluster_key,members) VALUES(?1,?2,?3)`,
});
const markUndone=write<[project:string,unit:string,actor:string,at:number]>({
  name:'curationUndo.mark',sql:`UPDATE spore_curation_units SET undone_at=?4,undone_by=?3,
    undone_label=(SELECT NULLIF(label,'') FROM members WHERE id=?3) WHERE project_id=?1 AND id=?2 AND undone_at IS NULL`,
});

/** Admission fences the whole operation; the undo decision is its last write. */
export async function commitCurationUndo(db:RelationalStore,options:{project:string;unit:string;actor:string;now:number;key:string;members:readonly {id:string;revision:number}[]}):Promise<void>{
  const {project,unit,actor,now,key,members}=options;
  const work={cluster_key:key,run_id:null,members:JSON.stringify(members.map(member=>({...member,closeness:0})))};
  await commitNamed(db,{
    admitted:admitted.bind(project,unit,actor),
    events:undoEvents.bind(project,unit,actor,USER_AGENT_ID,now),
    parents:rebaseParents.bind(project,unit,now),
    moved:move.bind(project,unit,now),
    keep:keepWork.bind(project,key,work.members),
    ...curationCloseWrites({projectId:project,work,decision:'keep',reason:'An administrator undid this curation and kept the original notes.',now,reviewed:members}),
    undone:markUndone.bind(project,unit,actor,now),
  });
}
