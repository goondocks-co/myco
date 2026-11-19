import type { RelationalStore } from './adapters.js';
import {
  commitCurationUndo, curationUndoRefusal, curationUnitForNote, readCurationUndoDetails, readCurationUnit,
  type CurationUnit, type CurationUndoConflict, type CurationUndoNote,
} from '../db/spores/curation-undo.js';

export interface CurationUndoBlocker {
  code:string;message:string;noteId?:string;laterUnitId?:string|null;laterNoteId?:string|null;
}
export interface CurationUndoView {
  unit:{id:string;kind:string;undoneAt:number|null;undoneBy:string|null;undoneLabel:string|null};
  restore:{id:string;label:string}[];retire:{id:string;label:string}[];
  leave:{id:string;label:string;status:string|null}[];
  blocker:CurationUndoBlocker|null;
}
const FIELD_WORDS:Readonly<Record<string,string>>={content:'body',observationType:'type',agentLine:'one-line guidance',context:'context',
  tags:'tags',importance:'importance',filePath:'file reference',properties:'properties',contentHash:'content fingerprint'};
function blocker(conflict:CurationUndoConflict):CurationUndoBlocker{
  const note=conflict.label===undefined?'This note':`“${conflict.label}”`;
  let message:string;
  if(conflict.code==='incoming_resolution'){
    const action=conflict.relation==='consolidate'?'merged into':'replaced by';
    message=`${note} was later ${action} “${conflict.outputLabel}”. `+(conflict.laterUnitId!=null
      ?'Undo that later operation on the absorbed note’s page first; nothing was changed.'
      :'That later operation cannot currently be undone here. This curation can no longer be undone; keep its replacement current to preserve the absorbed knowledge. Nothing was changed.');
  }else if(conflict.laterUnitId!=null){
    message=`${note} was used by a later curation. Undo that curation first; nothing was changed.`;
  }else if(conflict.code==='note_missing'){
    message=`${note} is no longer held. Its original knowledge is unavailable, so this curation can no longer be undone. Nothing was changed.`;
  }else if(conflict.code==='note_changed'){
    const state=conflict.actual==='active'?'was restored by hand and is current again':conflict.actual==='obsolete'?'was retired by hand':'was replaced after this curation';
    message=conflict.field==='status'?`${note} ${state}. This curation can no longer be undone as one unit. Nothing was changed.`
      :`${note} has different ${FIELD_WORDS[conflict.field??'']??'knowledge'}. This curation can no longer be undone because that knowledge changed. Nothing was changed.`;
  }else if(conflict.code==='already_undone'){
    message='This curation is already undone. Nothing was changed; no further action is needed.';
  }else if(conflict.code==='not_admin'){
    message='Sign in as an active administrator before undoing this curation; nothing was changed.';
  }else if(conflict.code==='not_found'){
    message='The curation could not be found. Open the note again before undoing it; nothing was changed.';
  }else if(conflict.code==='legacy_existing_target'){
    message=`${note} existed before notes were merged into it. It cannot be retired as the output of one merge, so this curation cannot be undone. Nothing was changed.`;
  }else if(conflict.code==='legacy_multiple_merges'){
    message=`${note} received notes in separate operations. The saved history does not identify one merge to undo; this curation can no longer be undone as one unit. Nothing was changed.`;
  }else if(conflict.code==='answer_history_missing'){
    message='The saved answer is missing, so its complete set of notes cannot be proved. This curation can no longer be undone. Nothing was changed.';
  }else if(conflict.code==='legacy_lineage_conflict'){
    message=`${note} has conflicting replacement links. The saved history does not prove one merge, so this curation can no longer be undone. Nothing was changed.`;
  }else{
    message='The saved history is incomplete and does not prove one unchanged curation. This curation can no longer be undone. Nothing was changed.';
  }
  return {...conflict,message,...(conflict.code==='incoming_resolution'&&conflict.laterUnitId==null?{laterNoteId:null}:{})};
}
function undoIssue(unit:CurationUnit,members:CurationUndoNote[],conflict:CurationUndoConflict|null):CurationUndoConflict|null{
  const output=members.find(note=>note.role==='output');
  if(unit.unavailable!==null&&unit.unavailable!=='output_missing')return {noteId:output?.id??unit.id,label:output?.label??unit.id,code:unit.unavailable};
  return members.length!==unit.member_count?{code:'history_incomplete'}:conflict;
}
async function view(db:RelationalStore,project:string,unit:CurationUnit):Promise<CurationUndoView>{
  const {members,conflict}=await readCurationUndoDetails(db,project,unit);
  const issue=unit.undone_at!==null?null:undoIssue(unit,members,conflict);
  return {unit:{id:unit.id,kind:unit.kind,undoneAt:unit.undone_at,undoneBy:unit.undone_by,undoneLabel:unit.undone_label},
    restore:members.filter(note=>note.role==='source'||note.role==='retired').map(({id,label})=>({id,label})),
    retire:members.filter(note=>note.role==='output'&&note.status==='active').map(({id,label})=>({id,label})),
    leave:members.filter(note=>note.role==='target'||(note.role==='output'&&note.status!=='active')).map(({id,label,status})=>({id,label,status})),
    blocker:issue===null?null:blocker(issue)};
}
/** A note names its current editorial unit, or the last one that was undone. */
export async function sporeCurationUndo(db:RelationalStore,scope:{projectId:string},note:string):Promise<CurationUndoView|null>{
  const unit=await curationUnitForNote(db,scope.projectId,note);return unit===null?null:view(db,scope.projectId,unit);
}
/** The admitted commit alone decides whether the current knowledge can be restored. */
export async function undoSporeCuration(db:RelationalStore,options:{projectId:string;unitId:string;actor:string;now:number}):Promise<
  {ok:true;curation:CurationUndoView}|{ok:false;refusal:CurationUndoBlocker}
>{
  const {projectId,unitId,actor,now}=options;
  try{await commitCurationUndo(db,{project:projectId,unit:unitId,actor,now});}
  catch(error){const refused=curationUndoRefusal(error);if(refused===null)throw error;return {ok:false,refusal:blocker(refused)};}
  return {ok:true,curation:await view(db,projectId,(await readCurationUnit(db,projectId,unitId))!)};
}
