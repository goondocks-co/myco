import { expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { sqliteRelationalStore } from '../../packages/myco-server/src/platform/bun/sqlite.js';
import { readBudgetStatus } from '../../packages/myco-server/src/read/budget.js';

export function seedRecoveryBudget(db: Database, priced: boolean, now: number): void {
  db.run("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('budget-project','Budget',0)");
  db.run("INSERT OR IGNORE INTO members(id,label,created_at) VALUES('budget-member','Budget',0)");
  db.run("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Agent','built-in',1,0)");
  for (const [id, origin, cost] of [['automatic','clock',0.1],['manual','budget-member',0.2]] as const) {
    const attempt=`budget-${id}`;
    db.run(`INSERT INTO member_credentials(id,member_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES(?,'budget-member',?,?,?, ?,?)`,[attempt,attempt,now,now+60_000,attempt,now]);
    db.run(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,dispatched_by,cost_usd,dispatch_spec${priced?',origin':''})
      VALUES('budget-project',?,'myco-agent','title-summary','completed',?,?,?,?,?${priced?',?':''})`,
    [id,now,now+1,attempt,cost,JSON.stringify({actor:origin}),...(priced?[id]:[])]);
    db.run(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at${priced?',estimate_usd,cost_usd,cost_source,profile_json':''})
      VALUES('budget-project',?,?,'fixture-worker',?${priced?',0.1,?,\'actual\',?':''})`,
    [id,attempt,now,...(priced?[cost,JSON.stringify({harness:'codex',profile:{tier:'low',model:'fixture',effort:'low',sources:{tier:'task',model:'configured'}}})]:[])]);
  }
  db.run(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at${priced?',estimate_usd,cost_usd,cost_source':''})
    VALUES('budget-project','automatic','budget-failed','fixture-worker',?${priced?',0.1,0.7,\'actual\'':''})`,[now-1]);
}

export async function assertRecoveryBudget(db: Database, priced: boolean, now: number): Promise<void> {
  const status=await readBudgetStatus(sqliteRelationalStore(db),now);
  expect(status.active).toBe(true);
  expect(status.automaticUsd).toBeCloseTo(priced?0.8:0.2);
  expect(status.manualUsd).toBeCloseTo(0.2);
  expect(db.query("SELECT attempt_id,cost_usd,cost_source FROM agent_run_attempts WHERE project_id='budget-project' ORDER BY attempt_id").all())
    .toEqual(priced?[
      {attempt_id:'budget-automatic',cost_usd:0.1,cost_source:'actual'},
      {attempt_id:'budget-failed',cost_usd:0.7,cost_source:'actual'},
      {attempt_id:'budget-manual',cost_usd:0.2,cost_source:'actual'},
    ]:[
      {attempt_id:'budget-automatic',cost_usd:null,cost_source:null},
      {attempt_id:'budget-failed',cost_usd:null,cost_source:null},
      {attempt_id:'budget-manual',cost_usd:null,cost_source:null},
    ]);
}
