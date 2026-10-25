import { sqliteEnv } from './fixtures.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { legacyWorker } from './worker-principal.js';
import { completeBudgetMigration } from '@myco-server-worker/db/budget-activation.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { claimQueuedRun, NO_LIMITS, type ClaimCandidate } from '@myco-server-worker/core/runs.js';
import type { ExecutionProfile } from '@goondocks/myco-shared/execution-profile';

export const PROFILE:ExecutionProfile={tier:'low',model:'gpt-fixture',effort:'low',sources:{tier:'task',model:'configured'}};
export async function budgetFixture(active=true) {
  const f=sqliteEnv({workerLogin:true});
  const now=Date.now();
  await ensureMember(f.db,'mem_harness',now,'member');
  await ensureMember(f.db,'mem_worker',now,'admin');
  const worker=await issueMemberToken(f.db,{memberId:'mem_worker',machineId:'budget-machine'},now);
  const principal=legacyWorker(worker.tokenId,'budget-machine');
  f.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Agent','built-in',1,?)",[now]);
  if(active) await completeBudgetMigration(f.db,now);
  const setting=async(value:number)=>expectApplied(await settingsWriter(f.db).setLeaf('agent.budget.daily_usd',value,'mem_worker',now));
  const credential=(id:string)=>f.sqlite.run(`INSERT INTO member_credentials(id,member_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
    VALUES(?,'mem_harness',?,?,?, ?,?)`,[id,`fixture-${id}`,now,now+3_600_000,id,now]);
  const queue=(id:string,origin='automatic',projectId='proj_1',task='title-summary',queuedAt=now)=>{
    f.sqlite.run(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,instruction,dispatch_spec,origin)
      VALUES(?,?,'myco-agent',?,'queued',?,'fixture input',?,?)`,[projectId,id,task,queuedAt,JSON.stringify({actor:origin==='manual'?'mem_worker':'clock',params:{session_id:'budget-session',mode:'claim'},timeoutSeconds:300}),origin]);
    return {projectId,id,task,instruction:'fixture input',dispatchSpec:'{}'};
  };
  const history=(id:string,amount:number|null,origin='automatic',claimedAt=now,estimate=0.10,task='title-summary',legacy=false,projectId='proj_1',profile:ExecutionProfile=PROFILE)=>{
    credential(id);
    f.sqlite.run(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,dispatched_by,cost_usd,origin)
      VALUES(?,?,'myco-agent',?,'completed',?,?,?, ?,?)`,[projectId,id,task,claimedAt,claimedAt+1,id,amount,origin]);
    f.sqlite.run(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,estimate_usd,cost_usd,cost_source,profile_json)
      VALUES(?,?,?,?,?,?,?,?,?)`,[projectId,id,id,worker.tokenId,claimedAt,legacy?null:estimate,legacy?null:amount,legacy?null:amount===null?'unavailable':'actual',legacy?null:JSON.stringify({harness:'codex',profile})]);
  };
  const claim=async(candidate:ClaimCandidate,at=now)=>{
    const result=await claimQueuedRun(f.serverEnv,candidate,{worker:principal,leaseExpiresAt:at+60_000,harness:'codex',profile:PROFILE,now:at});
    return result?.row ?? null;
  };
  return {...f,now,principal,workerTokenId:worker.tokenId,setting,credential,queue,history,claim};
}
function expectApplied(result:{applied:boolean}) {if(!result.applied)throw new Error('Fixture setting refused');}
