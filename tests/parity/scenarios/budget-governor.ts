import {expect} from 'bun:test';
import {lit,MEMBER_ID,type ParityScenario} from '../harness.ts';
import {offeredHarness} from '../../myco-server/helpers/offered-harness.js';

export const budgetGovernor:ParityScenario={
  name:'budget: a manual first poll bypasses held heads and its priced spend survives worker end',
  dedicated:{timeoutMs:180_000},
  async run(target) {
    const now=Date.now(),project=lit(target.projectId);
    const headers={...target.ownerHeaders(),origin:target.url,'content-type':'application/json'};
    for(const [leaf,value] of [['agent.budget.daily_usd',1],['agent.harnesses.claude-code.credential','worker-login']] as const) {
      const response=await fetch(`${target.url}/api/settings/${leaf}`,{method:'PUT',headers,body:JSON.stringify({value})});expect(response.status).toBe(200);
    }
    await target.sql("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Agent','built-in',1,1)");
    await target.sql(`INSERT INTO member_credentials(id,member_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES('budget-history',${lit(MEMBER_ID)},'fixture-budget-history',${now},${now+60000},'budget-history',${now})`);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,dispatched_by,cost_usd,origin)
      VALUES(${project},'budget-history','myco-agent','title-summary','completed',${now},${now},'budget-history',1,'manual')`);
    await target.sql(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,estimate_usd,cost_usd,cost_source)
      VALUES(${project},'budget-history','budget-history','fixture',${now},0.10,1,'actual')`);
    const spec=JSON.stringify({serverUrl:target.url,params:{session_id:'budget-session',mode:'claim'},timeoutSeconds:300});
    await target.sql(`WITH RECURSIVE q(n) AS(SELECT 0 UNION ALL SELECT n+1 FROM q WHERE n<24)
      INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,instruction,dispatch_spec,origin)
      SELECT ${project},'budget-held-'||n,'myco-agent','title-summary','queued',${now}+n,'fixture input',${lit(spec)},'automatic' FROM q`);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,instruction,dispatch_spec,origin)
      VALUES(${project},'budget-manual','myco-agent','title-summary','queued',${now+100},'fixture input',${lit(spec)},'manual')`);
    const claim=await fetch(`${target.url}/worker/claim`,{method:'POST',headers:target.memberHeaders({'content-type':'application/json'}),body:JSON.stringify({harnesses:[offeredHarness('claude-code')]})});
    expect(claim.status).toBe(200);
    const answer=await claim.json() as {claimed:boolean;run:{id:string;attemptId:string}};
    expect(answer).toMatchObject({claimed:true,run:{id:'budget-manual'}});
    expect(await target.sql("SELECT status,held_by FROM agent_runs WHERE id='budget-held-0'")).toEqual([{status:'queued',held_by:'budget'}]);
    const ended=await fetch(`${target.url}/worker/end`,{method:'POST',headers:target.memberHeaders({'content-type':'application/json'}),body:JSON.stringify({projectId:target.projectId,runId:answer.run.id,attemptId:answer.run.attemptId,status:'failed',usage:{inputTokens:null,outputTokens:null,costUsd:0.30}})});
    expect(ended.status).toBe(200);expect(await ended.json()).toMatchObject({ended:true});
    expect(await target.sql(`SELECT estimate_usd,cost_usd,cost_source,profile_json IS NOT NULL AS profiled FROM agent_run_attempts WHERE attempt_id=${lit(answer.run.attemptId)}`))
      .toEqual([{estimate_usd:0.10,cost_usd:0.30,cost_source:'actual',profiled:1}]);
    const status=await fetch(`${target.url}/api/status`,{headers:target.ownerHeaders()});
    expect((await status.json()) as unknown).toMatchObject({budget:{active:true,dailyUsd:1,manualUsd:1.30,automaticUsd:0}});
  },
};
