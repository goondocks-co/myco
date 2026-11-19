import type { RelationalStore } from '../../core/adapters.js';
import { USER_AGENT_ID } from '../../constants.js';
import { assertion, commitNamed, first, read, readSet, refusalCode, refusalDetail, write } from '../index.js';
import type { CurationUnitKind } from './curation-history.js';
import { completeKnowledgeSql, currentCurationEdgeSql, knowledgeStateSql, sameSporeStateSql, sporeKnowledgeSql } from './curation-history-sql.js';
import { curationCloseWrites } from './curation-work.js';

const UNIT_MEMBERS = 'sqlite_autoindex_spore_curation_unit_members_1';
const ADMIN_UNDO_CLUSTER_PREFIX = 'undo:';
export interface CurationUnit {
  id:string;kind:CurationUnitKind;created_at:number;member_count:number;unavailable:string|null;
  undone_at:number|null;undone_by:string|null;undone_label:string|null;
}
export interface CurationUndoNote {id:string;role:'source'|'retired'|'output'|'target';label:string;revision:number;status:string|null}
export interface CurationUndoConflict {
  code:string;noteId?:string;label?:string;field?:string;actual?:unknown;expected?:unknown;
  outputId?:string;outputLabel?:string;relation?:string;laterUnitId?:string|null;laterNoteId?:string|null;
}
const labelSql=(snapshot:string,id:string,current:string='NULL'):string=>`COALESCE(NULLIF(${current},''),NULLIF(json_extract(${snapshot},'$.agentLine'),''),${id})`;
const unitById=read<[project:string,unit:string],CurationUnit>({name:'curationUndo.unit',sql:'SELECT * FROM spore_curation_units WHERE project_id=?1 AND id=?2'});
const unitForNote=read<[project:string,note:string],CurationUnit>({name:'curationUndo.forNote',sql:`
  SELECT u.* FROM spore_curation_unit_members m CROSS JOIN spore_curation_units u ON u.project_id=m.project_id AND u.id=m.unit_id
  WHERE m.project_id=?1 AND m.spore_id=?2 ORDER BY u.undone_at IS NULL DESC,
    CASE WHEN u.unavailable IS NULL OR u.unavailable='output_missing' THEN 0 ELSE 1 END,
    CASE m.role WHEN 'output' THEN 1 WHEN 'target' THEN 2 ELSE 0 END,u.created_at DESC,u.id LIMIT 1`});
const notes=read<[project:string,unit:string],CurationUndoNote>({name:'curationUndo.notes',sql:`
  SELECT m.spore_id AS id,m.role,${labelSql('m.after_json','m.spore_id','s.agent_line')} AS label,
    COALESCE(s.revision,json_extract(m.after_json,'$.revision'),0) AS revision,s.status
  FROM spore_curation_unit_members m INDEXED BY ${UNIT_MEMBERS} LEFT JOIN spores s ON s.project_id=m.project_id AND s.id=m.spore_id
  WHERE m.project_id=?1 AND m.unit_id=?2 ORDER BY m.role,m.spore_id`});

const expectedKnowledge=knowledgeStateSql('m.after_json');
/** A retired output reads as unchanged only when a person retired it; one a later, still-current curation retired or used blocks the undo. */
const usedLater=`EXISTS(SELECT 1 FROM spore_curation_unit_members x CROSS JOIN spore_curation_units xu ON xu.project_id=x.project_id AND xu.id=x.unit_id
  WHERE x.project_id=m.project_id AND x.spore_id=m.spore_id AND x.unit_id<>m.unit_id AND x.role IN ('source','retired') AND xu.undone_at IS NULL)`;
const currentKnowledge=sporeKnowledgeSql('s',`CASE WHEN m.role='output' AND s.status='obsolete' AND NOT ${usedLater} THEN 'active' ELSE s.status END`);
const differentField=`(SELECT key FROM json_each(${expectedKnowledge}) expected WHERE json_extract(${currentKnowledge},'$."'||expected.key||'"') IS NOT expected.value LIMIT 1)`;
const laterUnit=(column:string):string=>`(SELECT ${column} FROM spore_curation_unit_members later CROSS JOIN spore_curation_units u
  ON u.project_id=later.project_id AND u.id=later.unit_id WHERE later.project_id=m.project_id AND later.spore_id=m.spore_id
  AND later.role IN ('source','retired') AND later.unit_id<>m.unit_id AND u.undone_at IS NULL AND (u.unavailable IS NULL OR u.unavailable='output_missing')
  AND json_extract(later.after_json,'$.status')=s.status
  AND ${completeKnowledgeSql('later.after_json')} AND ${sameSporeStateSql(knowledgeStateSql('later.after_json'),sporeKnowledgeSql('s'))}
  AND u.created_at>=(SELECT created_at FROM spore_curation_units own WHERE own.project_id=m.project_id AND own.id=m.unit_id) ORDER BY u.created_at DESC,u.id LIMIT 1)`;
const conflictSql=(project:string,unit:string):string=>`SELECT detail FROM (
  SELECT 0 AS priority,m.spore_id AS note,json_object('code',CASE WHEN s.id IS NULL THEN 'note_missing'
      WHEN NOT ${completeKnowledgeSql('m.after_json')} THEN 'history_incomplete' ELSE 'note_changed' END,
    'noteId',m.spore_id,'label',${labelSql('m.after_json','m.spore_id','s.agent_line')},'field',${differentField},
    'actual',json_extract(${currentKnowledge},'$."'||${differentField}||'"'),
    'expected',json_extract(${expectedKnowledge},'$."'||${differentField}||'"'),
    'laterUnitId',${laterUnit('u.id')},'laterNoteId',${laterUnit(`CASE WHEN u.kind='resolution' THEN later.spore_id ELSE COALESCE((SELECT o.spore_id FROM spore_curation_unit_members o INDEXED BY ${UNIT_MEMBERS} WHERE o.project_id=u.project_id AND o.unit_id=u.id AND o.role IN ('output','target') ORDER BY o.role LIMIT 1),later.spore_id) END`)}) AS detail
  FROM spore_curation_unit_members m INDEXED BY ${UNIT_MEMBERS} LEFT JOIN spores s ON s.project_id=m.project_id AND s.id=m.spore_id
  WHERE m.project_id=${project} AND m.unit_id=${unit} AND m.role<>'target' AND NOT(m.role='output' AND s.id IS NULL)
    AND (s.id IS NULL OR NOT ${completeKnowledgeSql('m.after_json')} OR NOT ${sameSporeStateSql(expectedKnowledge,currentKnowledge)})
  UNION ALL
  SELECT 1,e.spore_id,json_object('code','incoming_resolution','noteId',e.spore_id,'label',COALESCE(NULLIF(s.agent_line,''),s.id),
    'outputId',o.spore_id,'outputLabel',${labelSql('o.after_json','o.spore_id')},'relation',e.action,
    'laterUnitId',(SELECT u.id FROM spore_curation_unit_members incoming CROSS JOIN spore_curation_units u
      ON u.project_id=incoming.project_id AND u.id=incoming.unit_id WHERE incoming.project_id=e.project_id AND incoming.spore_id=e.spore_id
      AND u.undone_at IS NULL AND u.unavailable IS NULL AND u.kind='resolution' AND ${completeKnowledgeSql('incoming.after_json')}
      AND ${sameSporeStateSql(knowledgeStateSql('incoming.after_json'),sporeKnowledgeSql('s'))}
      AND EXISTS(SELECT 1 FROM json_each(incoming.event_ids) ids WHERE ids.value=e.id) LIMIT 1),
    'laterNoteId',e.spore_id)
  FROM spore_curation_unit_members o INDEXED BY ${UNIT_MEMBERS}
    CROSS JOIN resolution_events e INDEXED BY idx_resolution_events_successor ON e.project_id=o.project_id AND e.new_spore_id=o.spore_id
    CROSS JOIN spores s ON s.project_id=e.project_id AND s.id=e.spore_id
  WHERE o.project_id=${project} AND o.unit_id=${unit} AND o.role='output'
    AND e.action IN ('consolidate','supersede') AND s.status=CASE e.action WHEN 'consolidate' THEN 'consolidated' ELSE 'superseded' END
    AND ${currentCurationEdgeSql('e.project_id','e.spore_id','e.id')}
    AND NOT EXISTS(SELECT 1 FROM spore_curation_unit_members own WHERE own.project_id=o.project_id AND own.unit_id=o.unit_id AND own.spore_id=e.spore_id)
) ORDER BY priority,note LIMIT 1`;
const conflict=read<[project:string,unit:string],{detail:string}>({name:'curationUndo.conflict',sql:conflictSql('?1','?2')});
export const curationUnitForNote=(db:RelationalStore,project:string,note:string)=>first(db,unitForNote.bind(project,note));
export const readCurationUnit=(db:RelationalStore,project:string,unit:string)=>first(db,unitById.bind(project,unit));
export async function readCurationUndoDetails(db:RelationalStore,project:string,unit:CurationUnit){
  const [members,blocked]=await readSet(db,notes.bind(project,unit.id),...(unit.undone_at===null?[conflict.bind(project,unit.id)]:[]));
  return {members,conflict:blocked?.[0]===undefined?null:JSON.parse(blocked[0].detail) as CurationUndoConflict};
}
const UNDO_REFUSED=refusalCode('curation_undo_refused');
export const curationUndoRefusal=(error:unknown):CurationUndoConflict|null=>{
  const detail=refusalDetail(error,UNDO_REFUSED);return detail===null?null:JSON.parse(detail) as CurationUndoConflict;
};
const admitted=assertion<[project:string,unit:string,actor:string]>({name:'curationUndo.admitted',refusal:UNDO_REFUSED,
  with:`WITH unit AS(SELECT * FROM spore_curation_units WHERE project_id=?1 AND id=?2),bad AS(${conflictSql('?1','?2')})`,
  when:`EXISTS(SELECT 1 FROM members WHERE id=?3 AND role='admin' AND revoked_at IS NULL)
    AND EXISTS(SELECT 1 FROM unit WHERE undone_at IS NULL AND (unavailable IS NULL OR unavailable='output_missing') AND member_count>0
      AND member_count=(SELECT COUNT(*) FROM spore_curation_unit_members WHERE project_id=?1 AND unit_id=?2)) AND NOT EXISTS(SELECT 1 FROM bad)`,
  detail:`CASE WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=?3 AND role='admin' AND revoked_at IS NULL) THEN json_object('code','not_admin')
    WHEN NOT EXISTS(SELECT 1 FROM unit) THEN json_object('code','not_found')
    WHEN EXISTS(SELECT 1 FROM unit WHERE undone_at IS NOT NULL) THEN json_object('code','already_undone')
    WHEN EXISTS(SELECT 1 FROM unit WHERE unavailable IS NOT NULL AND unavailable<>'output_missing') THEN json_object(
      'code',(SELECT unavailable FROM unit),'noteId',?2,'label',COALESCE((SELECT ${labelSql('m.after_json','m.spore_id')} FROM spore_curation_unit_members m WHERE m.project_id=?1 AND m.unit_id=?2 AND m.role='output' LIMIT 1),?2))
    WHEN EXISTS(SELECT 1 FROM unit WHERE member_count<>(SELECT COUNT(*) FROM spore_curation_unit_members WHERE project_id=?1 AND unit_id=?2)) THEN json_object('code','history_incomplete')
    WHEN EXISTS(SELECT 1 FROM bad) THEN (SELECT detail FROM bad) ELSE json_object('code','history_incomplete') END`,
});
const undoEvents=write<[project:string,unit:string,actor:string,agent:string,at:number]>({name:'curationUndo.events',sql:`
  INSERT INTO resolution_events(project_id,id,agent_id,spore_id,action,reason,author,created_at)
  SELECT ?1,?2||':undo:'||m.spore_id,?4,m.spore_id,CASE WHEN m.role='output' THEN 'obsolete' ELSE 'restore' END,
    'Curation undone by '||COALESCE((SELECT NULLIF(label,'') FROM members WHERE id=?3),'an administrator')||'. Original notes restored.',?3,?5
  FROM spore_curation_unit_members m INDEXED BY ${UNIT_MEMBERS} CROSS JOIN spores s ON s.project_id=m.project_id AND s.id=m.spore_id
  WHERE m.project_id=?1 AND m.unit_id=?2 AND m.role<>'target' AND (m.role<>'output' OR s.status='active')`});
const move=write<[project:string,unit:string,at:number]>({name:'curationUndo.move',sql:`
  UPDATE spores SET status=CASE WHEN EXISTS(SELECT 1 FROM spore_curation_unit_members m INDEXED BY ${UNIT_MEMBERS}
      WHERE m.project_id=?1 AND m.unit_id=?2 AND m.spore_id=spores.id AND m.role='output') THEN 'obsolete' ELSE 'active' END,
    revision=revision+1,updated_at=?3 WHERE rowid IN(
      SELECT s.rowid FROM spore_curation_unit_members m INDEXED BY ${UNIT_MEMBERS}
        CROSS JOIN spores s ON s.project_id=m.project_id AND s.id=m.spore_id
      WHERE m.project_id=?1 AND m.unit_id=?2 AND (m.role IN ('source','retired') OR (m.role='output' AND s.status='active')))`});
const keepWork=write<[project:string,unit:string,key:string]>({name:'curationUndo.keepWork',sql:`
  INSERT INTO spore_curation_work(project_id,cluster_key,members)
  SELECT ?1,?3,json_group_array(json_object('id',m.spore_id,'revision',s.revision,'closeness',0))
  FROM spore_curation_unit_members m INDEXED BY ${UNIT_MEMBERS} CROSS JOIN spores s ON s.project_id=m.project_id AND s.id=m.spore_id
  WHERE m.project_id=?1 AND m.unit_id=?2 AND s.status='active' AND (m.role IN ('source','retired') OR (m.role='target'
    AND ${sameSporeStateSql(knowledgeStateSql('m.after_json'),sporeKnowledgeSql('s'))}))`});
const markUndone=write<[project:string,unit:string,actor:string,at:number]>({name:'curationUndo.mark',sql:`
  UPDATE spore_curation_units SET undone_at=?4,undone_by=?3,undone_label=(SELECT NULLIF(label,'') FROM members WHERE id=?3)
  WHERE project_id=?1 AND id=?2 AND undone_at IS NULL`});

/** Admission fences knowledge and dependencies; fresh restored revisions settle before the last undo write. */
export async function commitCurationUndo(db:RelationalStore,options:{project:string;unit:string;actor:string;now:number}):Promise<void>{
  const {project,unit,actor,now}=options;const key=ADMIN_UNDO_CLUSTER_PREFIX+unit;
  await commitNamed(db,{
    admitted:admitted.bind(project,unit,actor),events:undoEvents.bind(project,unit,actor,USER_AGENT_ID,now),
    moved:move.bind(project,unit,now),keep:keepWork.bind(project,unit,key),
    ...curationCloseWrites({projectId:project,work:{cluster_key:key,run_id:null,members:'[]'},decision:'keep',
      reason:'An administrator undid this curation and kept the original notes.',now}),
    undone:markUndone.bind(project,unit,actor,now),
  });
}
