import { useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { Button,ConfirmDialog,ItemLink } from '../../design';
import { ApiError,fetchJson,postJson } from '../../lib/api';
import { live } from '../../lib/live';
import { sporeStatusWord } from './words';
import { projectPath } from '../../routes/nav';

interface UndoView {
  unit:{id:string;kind:string;undoneAt:number|null;undoneBy:string|null;undoneLabel:string|null};
  restore:{id:string;label:string}[];retire:{id:string;label:string}[];
  leave?:{id:string;label:string;status:string|null}[];
  blocker:{code:string;message:string;laterNoteId?:string|null}|null;
}
const segment=encodeURIComponent;
const errorWords=(error:Error|null):string|null=>{
  if(error===null)return null;
  if(error instanceof ApiError && typeof error.body==='object' && error.body!==null && 'message' in error.body && typeof error.body.message==='string')return error.body.message;
  return 'Myco couldn’t confirm the undo. Reload this spore to see whether it happened before trying again.';
};

/** One administrator confirmation reverses the whole editorial unit, never a selected subset. */
export function CurationUndo({projectId,sporeId}:{projectId:string;sporeId:string}){
  const client=useQueryClient();const [open,setOpen]=useState(false);
  const preview=useQuery({queryKey:['curation-undo',projectId,sporeId],
    queryFn:({signal})=>fetchJson<{curation:UndoView|null}>(`/api/projects/${segment(projectId)}/spores/${segment(sporeId)}/curation`,signal),
    ...live('still')});
  const change=useMutation({
    mutationFn:(unit:string)=>postJson<{ok:true;curation:UndoView}>(`/api/projects/${segment(projectId)}/curation/${segment(unit)}/undo`,{}),
    onSuccess:async(answer)=>{
      client.setQueryData(['curation-undo',projectId,sporeId],{curation:answer.curation});setOpen(false);
      await Promise.all(['spore','spore-stream','search','curation-undo'].map(key=>client.invalidateQueries({queryKey:[key]})));
    },
  });
  if(preview.isError)return <span role="status" className="t-small text-muted">Curation history could not be read. <Button size="sm" variant="secondary" onClick={()=>void preview.refetch()}>Try again</Button></span>;
  const curation=preview.data?.curation;
  if(curation==null)return null;
  if(curation.unit.undoneAt!==null)return <span className="t-small text-muted" data-curation-undone="">This curation was undone by {curation.unit.undoneLabel??'an administrator'}.</span>;
  const list=(notes:UndoView['restore'])=><ul className="flex flex-col gap-s2">{notes.map(note=><li key={note.id}><ItemLink to={projectPath(projectId,`/spores/${segment(note.id)}`)}>{note.label}</ItemLink></li>)}</ul>;
  return <>
    <Button size="sm" variant="secondary" onClick={()=>{change.reset();setOpen(true);}}>Undo curation</Button>
    <ConfirmDialog open={open} onOpenChange={next=>{if(!change.isPending)setOpen(next);}}
      title="Undo this curation?" description="The spores this curation replaced come back as they were, with their wording and dates, and the spores it wrote are retired. Spores listed as left stay as they are. It all happens at once, or not at all."
      confirmLabel="Undo curation" tone="primary" pending={change.isPending} confirmDisabled={curation.blocker!==null}
      error={errorWords(change.error)??curation.blocker?.message??null} onConfirm={()=>change.mutate(curation.unit.id)}>
      <div className="flex flex-col gap-s4" data-curation-undo-plan="">
        <section><h3 className="t-small font-medium">Spores that come back</h3>{list(curation.restore)}</section>
        {curation.retire.length>0&&<section><h3 className="t-small font-medium">Spores it wrote, to retire</h3>{list(curation.retire)}</section>}
        {(curation.leave?.length??0)>0&&<section><h3 className="t-small font-medium">Spores left as they are</h3><ul className="flex flex-col gap-s2">{curation.leave!.map(note=><li key={note.id}><ItemLink to={projectPath(projectId,`/spores/${segment(note.id)}`)}>{note.label}</ItemLink><span className="t-small text-muted"> — {note.status===null?'No longer held':sporeStatusWord(note.status)}</span></li>)}</ul></section>}
        {curation.blocker?.laterNoteId!=null&&<ItemLink to={projectPath(projectId,`/spores/${segment(curation.blocker.laterNoteId)}`)}>Open the later curation →</ItemLink>}
      </div>
    </ConfirmDialog>
  </>;
}
