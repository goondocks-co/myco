import { claimNextRun, type DispatchOutcome, type LaunchSpec } from '@myco-server-worker/core/harness.js';
import { EXTRACTION_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { ensureAgent } from '@myco-server-worker/db/runs/state.js';
import { recordQueued } from '@myco-server-worker/db/runs/claim.js';
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

export const claimPrePauseExtraction = claimNextRun;
