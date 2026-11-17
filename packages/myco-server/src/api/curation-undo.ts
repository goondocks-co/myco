import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { sporeCurationUndo, undoSporeCuration } from '../core/spore-curation-undo.js';
import { notFound, ok, resolveProjectScope } from './scope.js';

export async function handleSporeCurationUndo(env:ServerEnv,ctx:OwnerContext):Promise<Response>{
  const scope=await resolveProjectScope(env.db,ctx.member,ctx.params.projectId);
  if(scope===null)return notFound();
  return ok({curation:await sporeCurationUndo(env.db,scope,ctx.params.sporeId)});
}

export async function handleUndoCuration(env:ServerEnv,ctx:OwnerContext):Promise<Response>{
  const scope=await resolveProjectScope(env.db,ctx.member,ctx.params.projectId);
  if(scope===null)return notFound();
  const result=await undoSporeCuration(env.db,{projectId:scope.projectId,unitId:ctx.params.unitId,actor:ctx.member.id,now:ctx.now});
  if(result.ok)return ok(result);
  const refusal=result.refusal;
  return Response.json({error:`curation_${refusal.code}`,message:refusal.message,noteId:refusal.noteId,
    laterUnitId:refusal.laterUnitId,laterNoteId:refusal.laterNoteId},
    {status:refusal.code==='not_found'?404:refusal.code==='not_admin'?403:409});
}
