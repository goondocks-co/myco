import {expect} from 'bun:test';
import {lit,type ParityScenario} from '../harness.ts';
import {offeredHarness} from '../../myco-server/helpers/offered-harness.js';
import {PULL_FIXTURE_TABLE} from '../../helpers/pulled-test-stage.ts';
import {capabilitiesRequiredBy} from '@goondocks/myco-shared/repository';

export const pulledClaim:ParityScenario={
  name:'pull at claim: test stages are pulled by level into running rows with subjects, then nothing is left',
  dedicated:{pulledStage:true,cloudflare:{main:'../../tests/parity/pulled-stage/worker-entry.ts'},timeoutMs:180_000},
  async run(target) {
    const now=Date.now(),project=lit(target.projectId);
    const headers={...target.ownerHeaders(),origin:target.url,'content-type':'application/json'};
    const response=await fetch(`${target.url}/api/settings/agent.harnesses.claude-code.credential`,{method:'PUT',headers,body:JSON.stringify({value:'worker-login'})});
    expect(response.status).toBe(200);
    await target.sql("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Agent','built-in',1,1)");
    await target.sql(PULL_FIXTURE_TABLE);
    await target.sql(`INSERT OR REPLACE INTO project_capabilities VALUES(${project},'canopy',1,1,'parity')`);
    await target.sql(`INSERT INTO pull_fixture_items VALUES(${project},'older-low',2,'canopy-map',${now-1000}),(${project},'newer-high',1,'title-summary',${now})`);
    const claim=async()=>{
      const answer=await fetch(`${target.url}/worker/claim`,{method:'POST',headers:target.memberHeaders({'content-type':'application/json'}),
        body:JSON.stringify({harnesses:[offeredHarness('claude-code')],capabilities:capabilitiesRequiredBy('canopy-map')})});
      expect(answer.status).toBe(200);
      return answer.json() as Promise<{claimed:boolean;reason?:string;run?:{id:string;task:string;attemptId:string;instruction:string}}>;
    };
    const high=await claim();
    expect(high).toMatchObject({claimed:true,run:{task:'title-summary',instruction:'fixture item newer-high'}});
    expect(await claim()).toMatchObject({claimed:true,run:{task:'canopy-map'}});
    expect(await claim()).toMatchObject({claimed:false,reason:'no_work'});
    expect(await target.sql(`SELECT r.subject,r.origin,r.status,a.estimate_usd IS NOT NULL AS priced FROM agent_runs r
      JOIN agent_run_attempts a ON a.project_id=r.project_id AND a.run_id=r.id AND a.attempt_id=r.dispatched_by WHERE r.subject IS NOT NULL ORDER BY r.subject`))
      .toEqual([{subject:'fixture:newer-high',origin:'automatic',status:'running',priced:1},{subject:'fixture:older-low',origin:'automatic',status:'running',priced:1}]);
    const ended=await fetch(`${target.url}/worker/end`,{method:'POST',headers:target.memberHeaders({'content-type':'application/json'}),
      body:JSON.stringify({projectId:target.projectId,runId:high.run!.id,attemptId:high.run!.attemptId,status:'failed',usage:{inputTokens:null,outputTokens:null,costUsd:0.05}})});
    expect(await ended.json()).toMatchObject({ended:true});
  },
};
