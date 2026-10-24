import {expect} from 'bun:test';
import {estimateKey} from '@myco-server-worker/core/budget-estimates.js';
import type {ExecutionProfile} from '@goondocks/myco-shared/execution-profile';
import {lit,MEMBER_ID,type ParityScenario} from '../harness.ts';
import {selectOwner} from './backup-restore.ts';

export const budgetRestore:ParityScenario={
  name:'budget: portable restore preserves every attempt cost and dispatch origin',
  dedicated:{timeoutMs:180_000},
  async run(target) {
    await selectOwner(target);
    const now=Date.now(),project=lit(target.projectId);
    await target.sql("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Agent','built-in',1,1)");
    for(const id of ['budget-A','budget-B','budget-M'])await target.sql(`INSERT INTO member_credentials(id,member_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES(${lit(id)},${lit(MEMBER_ID)},${lit(`fixture-${id}`)},${now},${now+60000},${lit(id)},${now})`);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,dispatched_by,cost_usd,origin) VALUES
      (${project},'budget-auto','myco-agent','title-summary','completed',${now},${now},'budget-B',0.10,'automatic'),
      (${project},'budget-manual','myco-agent','title-summary','completed',${now},${now},'budget-M',0.20,'manual')`);
    await target.sql(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,estimate_usd,cost_usd,cost_source) VALUES
      (${project},'budget-auto','budget-A','fixture',${now},0.10,0.70,'actual'),
      (${project},'budget-auto','budget-B','fixture',${now},0.10,0.10,'actual'),
      (${project},'budget-manual','budget-M','fixture',${now},0.10,0.20,'actual')`);
    const profile:ExecutionProfile={tier:'low',model:'pruned-fixture',effort:'low',sources:{tier:'task',model:'configured'}};
    const sampleKey=estimateKey('title-summary','codex',profile);
    const sample={estimate:2,ratioP95:20,n:50,ratioN:50,refreshedAt:now,cycle:'foreign-pruned',points:Array.from({length:50},(_,index)=>({cost:2,ratio:20,seq:1050-index}))};
    await target.sql(`INSERT INTO agent_state(project_id,agent_id,key,value,updated_at) VALUES(${project},'myco-agent',${lit(sampleKey)},${lit(JSON.stringify(sample))},${now})`);
    const headers={...target.ownerHeaders(),origin:target.url,'content-type':'application/json'};
    const create=await fetch(`${target.url}/api/backups`,{method:'POST',headers,body:'{}'});
    expect(create.status).toBe(200);const saved=await create.json() as {backup:{id:string}};
    const bytes=await fetch(`${target.url}/api/backups/${saved.backup.id}/artifact`,{headers});
    expect(bytes.status).toBe(200);const artifact=await bytes.text();
    expect(artifact).toContain('cost_usd');
    await target.sql("DELETE FROM agent_runs WHERE id IN ('budget-auto','budget-manual')");
    await target.sql(`DELETE FROM agent_state WHERE project_id=${project} AND agent_id='myco-agent' AND key=${lit(sampleKey)}`);
    const restore=await fetch(`${target.url}/api/backups/${saved.backup.id}/restore`,{method:'POST',headers,body:'{}'});
    expect(restore.status).toBe(200);expect(await restore.json()).toMatchObject({applied:true});
    expect(await target.sql("SELECT attempt_id,cost_usd FROM agent_run_attempts ORDER BY attempt_id")).toEqual([
      {attempt_id:'budget-A',cost_usd:0.70},{attempt_id:'budget-B',cost_usd:0.10},{attempt_id:'budget-M',cost_usd:0.20},
    ]);
    const status=await fetch(`${target.url}/api/status`,{headers});
    expect(await status.json()).toMatchObject({budget:{active:true,automaticUsd:expect.closeTo(0.80),manualUsd:0.20,unconfirmed:{count:0,estimatedUsd:0}}});
    const restored=await target.sql(`SELECT value FROM agent_state WHERE project_id=${project} AND agent_id='myco-agent' AND key=${lit(sampleKey)}`);
    const restoredSample=JSON.parse(String(restored[0]!.value));
    expect(restoredSample.estimate).toBe(2);
    expect(restoredSample.points.map((point:{seq:number})=>point.seq)).toEqual(Array(50).fill(0));
    const wake=async()=>{
      const response=await fetch(`${target.url}/api/wake`,{method:'POST',headers,body:'{}'});
      expect(response.status).toBe(200);await response.body?.cancel();
    };
    await wake();
    expect(await target.sql("SELECT value FROM schema_meta WHERE key='budget.estimate_watermark'")).toEqual([{value:'0'}]);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,origin)
      VALUES(${project},'budget-local-samples','myco-agent','title-summary','completed',${now},${now},'automatic')`);
    const identity=JSON.stringify({harness:'codex',profile});
    await target.sql(`WITH RECURSIVE samples(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM samples WHERE n<60)
      INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,estimate_usd,cost_usd,cost_source,profile_json)
      SELECT ${project},'budget-local-samples','budget-fresh-'||n,'fixture',${now},0.1,0.1,'actual',${lit(identity)} FROM samples`);
    await target.sql("DELETE FROM schema_meta WHERE key='budget.estimates_refreshed_at'");
    for(let pass=0;pass<3;pass++)await wake();
    const local=await target.sql(`SELECT value FROM agent_state WHERE project_id=${project} AND agent_id='myco-agent' AND key=${lit(sampleKey)}`);
    const localSample=JSON.parse(String(local[0]!.value));
    expect(localSample.estimate).toBeCloseTo(0.1,6);
    const newest=await target.sql(`SELECT settled_seq AS seq FROM agent_run_attempts WHERE project_id=${project} AND run_id='budget-local-samples' ORDER BY settled_seq DESC LIMIT 50`);
    expect(localSample.points.map((point:{seq:number})=>point.seq)).toEqual(newest.map(row=>row.seq));

  },
};
