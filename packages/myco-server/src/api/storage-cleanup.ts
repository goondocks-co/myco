import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { setStorageCleanupPaused,storageCleanupStatus,storageCleanupRetainedInline,type CleanupOmissionCursor } from '../core/storage-cleanup.js';
import { badRequest,ok,readJsonObject } from './scope.js';
import { emit } from '../telemetry.js';

/** The operator sees sweep progress and candidates retained by the net-gain rule. */
export async function handleStorageCleanup(env:ServerEnv,ctx:OwnerContext):Promise<Response>{
  const cursor=ctx.url.searchParams.get('retainedAfter');let after:CleanupOmissionCursor|undefined;
  if(cursor!==null){
    if(cursor.length>2048)return badRequest('retainedAfter must be a cleanup omission cursor');
    let parsed:unknown;try{parsed=JSON.parse(cursor);}catch{return badRequest('retainedAfter must be a cleanup omission cursor');}
    if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))return badRequest('retainedAfter must be a cleanup omission cursor');
    const value=parsed as Record<string,unknown>;
    if(Object.keys(value).length!==3||!['project_id','resource_kind','resource_id'].every(key=>
      typeof value[key]==='string'&&value[key].length>0&&value[key].length<=384))return badRequest('retainedAfter must be a cleanup omission cursor');
    after={project_id:value.project_id as string,resource_kind:value.resource_kind as string,resource_id:value.resource_id as string};
  }
  const state=await storageCleanupStatus(env.db);
  const retained=await storageCleanupRetainedInline(env.db,after);
  return ok({state,retainedInline:retained.counts,retainedInlinePage:{after:after??null,next:retained.next,examined:retained.examined}});
}

/** The route's admin admission and atomic member write guard authorize this mutation. */
export async function handleSetStorageCleanup(env:ServerEnv,ctx:OwnerContext):Promise<Response>{
  const body=await readJsonObject(ctx.request);
  if(body===null||typeof body.paused!=='boolean'||Object.keys(body).some(key=>key!=='paused'))
    return badRequest('body must contain only a boolean paused');
  const state=await setStorageCleanupPaused(env.db,body.paused,ctx.now);
  emit({kind:'storage_cleanup_control',actor:ctx.member.id,paused:body.paused});
  return ok({state});
}
