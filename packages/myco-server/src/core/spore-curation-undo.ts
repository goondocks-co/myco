import type { RelationalStore } from './adapters.js';
import { curationClusterKey } from './spore-curation.js';
import {
  commitCurationUndo, curationUndoRefusal, curationUnitForNote, readCurationUndoDetails, readCurationUnit,
  type CurationUnit, type CurationUndoConflict, type CurationUndoNote,
} from '../db/spores/curation-undo.js';

export interface CurationUndoBlocker {
  code: string; message: string; noteId?: string; laterUnitId?: string | null; laterNoteId?: string | null;
}
export interface CurationUndoView {
  unit: { id: string; kind: string; undoneAt: number | null; undoneBy: string | null; undoneLabel: string | null };
  restore: { id: string; label: string }[];
  retire: { id: string; label: string }[];
  blocker: CurationUndoBlocker | null;
}

function blocker(conflict:CurationUndoConflict):CurationUndoBlocker {
  const note=conflict.label===undefined?'This note':`“${conflict.label}”`;
  const message=conflict.laterUnitId!=null ? `${note} was used by a later curation. Undo that curation first; nothing was changed.`
    : conflict.code==='note_missing' ? `${note} is missing. Restore that note from a backup before undoing this curation; nothing was changed.`
    : conflict.code==='note_changed' ? `${note} ${conflict.actual===conflict.expected?'was edited':`is now ${conflict.actual==='obsolete'?'retired':'replaced'}`}. Restore its recorded state from a backup before undoing this curation; nothing was changed.`
    : conflict.code==='already_undone' ? 'This curation is already undone. Nothing was changed; no further action is needed.'
    : conflict.code==='not_admin' ? 'Sign in as an active administrator before undoing this curation; nothing was changed.'
    : conflict.code==='not_found' ? 'The curation could not be found. Open the note again before undoing it; nothing was changed.'
    : conflict.code==='answer_history_missing' ? 'The saved answer is missing, so its full set of notes cannot be proved. Restore a backup containing that answer before undoing it; nothing was changed.'
    : conflict.code==='legacy_lineage_conflict' ? `${note} has conflicting replacement links. Restore a backup with complete, consistent lineage before undoing it; nothing was changed.`
    : 'The saved history does not prove one complete, unchanged curation. Restore a backup with complete history before undoing it; nothing was changed.';
  return {...conflict,message};
}

function undoIssue(unit:CurationUnit,members:CurationUndoNote[],conflict:CurationUndoConflict|null):CurationUndoConflict|null{
  const output=members.find(note=>note.role==='output');
  const note={noteId:output?.id??unit.id,label:output?.label??'The merged note'};
  if(unit.unavailable==='output_missing')return {...note,code:'note_missing'};
  if(unit.unavailable==='legacy_note_changed')return {...note,code:'note_changed',actual:'active',expected:'active'};
  if(unit.unavailable!==null)return {...note,code:unit.unavailable};
  return members.length!==unit.member_count?{...note,code:'history_incomplete'}:conflict;
}

async function view(db:RelationalStore,project:string,unit:CurationUnit):Promise<CurationUndoView>{
  const {members,conflict}=await readCurationUndoDetails(db,project,unit);
  const issue=unit.undone_at!==null?null:undoIssue(unit,members,conflict);
  return {unit:{id:unit.id,kind:unit.kind,undoneAt:unit.undone_at,undoneBy:unit.undone_by,undoneLabel:unit.undone_label},
    restore:members.filter(note=>note.role!=='output').map(({id,label})=>({id,label})),
    retire:members.filter(note=>note.role==='output').map(({id,label})=>({id,label})),
    blocker:issue===null?null:blocker(issue)};
}

/** A note names its current editorial unit, or the last one that was undone. */
export async function sporeCurationUndo(db:RelationalStore,scope:{projectId:string},note:string):Promise<CurationUndoView|null>{
  const unit=await curationUnitForNote(db,scope.projectId,note);
  return unit===null?null:view(db,scope.projectId,unit);
}

/** Restore the original knowledge and settle the administrator's keep decision in one commit. */
export async function undoSporeCuration(db:RelationalStore,options:{projectId:string;unitId:string;actor:string;now:number}):Promise<
  {ok:true;curation:CurationUndoView}|{ok:false;refusal:CurationUndoBlocker}
>{
  const {projectId,unitId,actor,now}=options;
  const unit=await readCurationUnit(db,projectId,unitId);
  if(unit===null)return {ok:false,refusal:blocker({code:'not_found'})};
  if(unit.undone_at!==null)return {ok:false,refusal:blocker({code:'already_undone'})};
  const {members,conflict}=await readCurationUndoDetails(db,projectId,unit);
  const issue=undoIssue(unit,members,conflict);
  if(issue!==null)return {ok:false,refusal:blocker(issue)};
  const originals=members.filter(note=>note.role!=='output').map(note=>({id:note.id,revision:note.revision+1}));
  try {
    await commitCurationUndo(db,{project:projectId,unit:unitId,actor,now,key:await curationClusterKey(originals),members:originals});
  }catch(error){
    const refused=curationUndoRefusal(error);if(refused===null)throw error;
    return {ok:false,refusal:blocker(refused)};
  }
  return {ok:true,curation:await view(db,projectId,(await readCurationUnit(db,projectId,unitId))!)};
}
