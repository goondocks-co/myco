import { claimNextRun, type DispatchOutcome, type LaunchSpec } from '@myco-server-worker/core/harness.js';
import { EXTRACTION_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { ensureAgent, nextClaimable, recordQueued } from '@myco-server-worker/core/runs.js';
import { LEARNING_PAUSED_AT } from '@myco-server-worker/core/learning-pause.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';

/** The synthetic run is queued before the pause and attributed to its dispatch actor. */
export async function queuePrePauseExtraction(env: ServerEnv, projectId: string, spec: LaunchSpec, now: number): Promise<DispatchOutcome> {
  const id=spec.runId??`fixture-${crypto.randomUUID()}`;
  await ensureAgent(env.db,{id:'myco-agent',name:'agent',provider:null,model:null,enabled:true},now);
  const landed=await recordQueued(env.db,{projectId},{id,agentId:'myco-agent',task:EXTRACTION_TASK,provider:null,
    model:null,heldBy:'worker',queuedAt:now,instruction:spec.instruction??'legacy extraction',
    dispatchSpec:JSON.stringify(spec),runContext:JSON.stringify({timeoutSeconds:spec.timeoutSeconds??900,...spec.params})});
  if(!landed) throw new Error('the pre-pause extraction fixture did not queue');
  return {dispatched:true,queued:true,runId:id,task:EXTRACTION_TASK,projectId,heldBy:'worker'};
}

/** Only the extraction fixture acquires its lease before its saved pause marker is applied. */
export async function claimPrePauseExtraction(...args: Parameters<typeof claimNextRun>): ReturnType<typeof claimNextRun> {
  const [env]=args;
  const candidate=await nextClaimable(env.db,[]);
  if(candidate?.task!==EXTRACTION_TASK) return claimNextRun(...args);
  const pause=await env.db.prepare('SELECT value FROM schema_meta WHERE key=?').bind(LEARNING_PAUSED_AT).first<{value:string}>();
  await env.db.prepare('DELETE FROM schema_meta WHERE key=?').bind(LEARNING_PAUSED_AT).run();
  try { return await claimNextRun(...args); }
  finally {
    if(pause!==null) await env.db.prepare('INSERT INTO schema_meta(key,value) VALUES(?,?)').bind(LEARNING_PAUSED_AT,pause.value).run();
  }
}
