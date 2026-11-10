import { readAttemptSpendOracle as readSpendRows } from './helpers/attempt-spend-oracle.js';
import {expect,it} from 'bun:test';
import { Database } from 'bun:sqlite';
import { budgetFixture,PROFILE } from './helpers/budget-fixture.js';
import { completeBudgetMigration,budgetActivation,budgetCompletionMessage,BUDGET_INDEX_ROW_LIMIT } from '@myco-server-worker/db/meta/budget-activation.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { V103_STATEMENTS } from '@myco-server-worker/db/schema-v103.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { createBackup, backupArtifact, backupSnapshot } from '@myco-server-worker/core/backup.js';
import { restoreArtifact } from './helpers/restore-artifact.js';

import { refreshEstimates,estimateForClaim,estimateRefreshDue } from '@myco-server-worker/core/budget-estimates.js';
import { ESTIMATE_PUBLISH_PAGE } from '@myco-server-worker/core/budget-estimates.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { schemaSqlite } from './helpers/schema-template.js';
import { engineAssertions,runTick } from '@myco-server-worker/core/tick.js';
import { estimateInvalidationStatements } from '@myco-server-worker/db/meta/budget-estimates.js';
import { restoreAttemptStatement } from '@myco-server-worker/core/attempt-accounting.js';
import worker from '@myco-server-worker/index.js';
import { asOwner,OWNER_ENV } from './helpers/owner.js';
import { migrateOnly } from '@myco-server-worker/platform/bun/server-main.js';
import { endLeasedRun } from '@myco-server-worker/core/harness.js';
import { changingAt, counting, dying, failingAt } from './helpers/store-faults.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('initializes live origins on schema103 and publishes activation after verified indexes',async()=>{
  const db=new Database(':memory:');
  try {
    for(const step of SCHEMA_STEPS.filter(step=>step.version<=102))for(const sql of step.statements)db.exec(sql);
    db.exec("INSERT INTO projects(project_id,name,created_at) VALUES('legacy','Legacy',0)");
    db.exec("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('legacy','Legacy','built-in',1,0)");
    for(const [id,actor] of [['clock','clock'],['backfill','backfill'],['deployment','deployment'],['manual','mem_owner'],['missing',null]]) {
      db.query("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,dispatch_spec) VALUES('legacy',?,'legacy','title-summary','queued',0,?)").run(id!,JSON.stringify({actor}));
    }
    for(const sql of SCHEMA_STEPS.find(step=>step.version===103)!.statements)db.exec(sql);
    const store=sqliteRelationalStore(db);
    expect(await budgetActivation(store)).toMatchObject({active:false});
    expect(db.query('SELECT id,origin FROM agent_runs ORDER BY id').all()).toEqual([
      {id:'backfill',origin:'automatic'},{id:'clock',origin:'automatic'},{id:'deployment',origin:'automatic'},{id:'manual',origin:'manual'},{id:'missing',origin:'manual'},
    ]);
    expect(await completeBudgetMigration(store,100)).toEqual({active:true,reason:null});
    expect(await completeBudgetMigration(store,200)).toEqual({active:true,reason:null});
    expect(db.query("SELECT value FROM schema_meta WHERE key='budget_enabled_at'").get()).toEqual({value:'100'});
    db.exec("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,dispatch_spec) VALUES('legacy','old-writer','legacy','title-summary','queued',0,'{\"actor\":\"clock\"}')");
    expect(db.query("SELECT origin FROM agent_runs WHERE id='old-writer'").get()).toEqual({origin:'automatic'});
  }finally{db.close();}
});

const OVER_LIMIT:Record<'agent_runs'|'agent_run_attempts',string>={
  agent_runs:`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<=?1)
    INSERT INTO agent_runs(project_id,id,agent_id,task,status,completed_at,origin) SELECT 'proj_1','bulk-'||i,'myco-agent','title-summary','completed',1,'automatic' FROM n`,
  agent_run_attempts:`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<=?1)
    INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at) SELECT 'proj_1','bulk','bulk-'||i,?2,1 FROM n`,
};
for(const table of ['agent_runs','agent_run_attempts'] as const)it(`keeps preflight refusal visible for ${table} past the index row limit`,async()=>{
  const f=await budgetFixture(false);
  try {
    f.history('bulk',0.1);
    f.sqlite.run(OVER_LIMIT[table],table==='agent_runs'?[BUDGET_INDEX_ROW_LIMIT]:[BUDGET_INDEX_ROW_LIMIT,f.workerTokenId]);
    const rows=String(f.sqlite.query<{n:number},[]>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
    expect(await completeBudgetMigration(f.db,100)).toMatchObject({active:false,reason:expect.stringContaining(table)});
    expect(await budgetActivation(f.db)).toMatchObject({active:false,reason:expect.stringContaining(rows)});
    const status=await worker.fetch(await asOwner(f.db,'/api/status'),{...f.env,...OWNER_ENV});
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({budget:{active:false,reason:expect.stringContaining(table)}});
    expect(f.sqlite.query("SELECT name FROM sqlite_master WHERE name IN ('idx_attempts_claimed','idx_agent_runs_queue_head')").all()).toEqual([]);
    expect(f.sqlite.query("SELECT value FROM schema_meta WHERE key='budget_enabled_at'").get()).toBeNull();
    expect(await f.claim(f.queue('legacy-claim'))).toBeNull();
  }finally{f.sqlite.close();}
},30_000);

it('restores every known attempt price and immutable profile through the portable artifact',async()=>{
  const source=await budgetFixture(),target=await budgetFixture();
  try {
    source.history('failed',0.70);source.history('done',0.10);source.history('manual',0.20,'manual');
    await refreshEstimates(source.db,source.now);
    const samples=source.sqlite.query<{key:string;value:string},[]>("SELECT key,value FROM agent_state WHERE key LIKE 'server.budget.estimate.%'").all();
    const before=await readSpendRows(source.db,source.now);
    const saved=await createBackup(source.db,source.bucket,{producer:'budget-test',now:source.now});
    const artifact=await backupArtifact(source.db,source.bucket,saved.id);
    if(artifact===null)throw new Error('No backup artifact');
    target.sqlite.run("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('budget.estimate_watermark','333')");
    expect(target.sqlite.query("SELECT value FROM schema_meta WHERE key='budget.estimate_watermark'").get()).toEqual({value:'333'});
    target.sqlite.run("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('budget.estimate_progress',?)",[JSON.stringify({time:0,row:0,cycle:'stale',revision:'stale'})]);
    await restoreArtifact(target.db,{authorization:{kind:'recovery'},text:artifact.text,allowForeignLineage:true});
    expect(target.sqlite.query("SELECT COUNT(*) AS n FROM schema_meta WHERE key='budget.estimate_progress'").get()).toEqual({n:0});
    expect(await readSpendRows(target.db,source.now)).toEqual(before);
    const restoredSamples=target.sqlite.query<{key:string;value:string},[]>("SELECT key,value FROM agent_state WHERE key LIKE 'server.budget.estimate.%'").all();
    expect(restoredSamples.map(row=>row.key)).toEqual(samples.map(row=>row.key));
    for(const [index,row] of restoredSamples.entries()) {
      const {points:beforePoints,...beforeFacts}=JSON.parse(samples[index]!.value);
      const {points:afterPoints,...afterFacts}=JSON.parse(row.value);
      expect(afterFacts).toEqual(beforeFacts);
      const prices=(points:{cost:number;ratio:number|null}[])=>points.map(({cost,ratio})=>({cost,ratio}));
      expect(prices(afterPoints)).toEqual(prices(beforePoints));
      expect(afterPoints.every((point:{seq:number})=>point.seq===0)).toBe(true);
    }
    expect(await estimateRefreshDue(target.db,source.now)).toBe(true);
    expect(target.sqlite.query("SELECT value FROM schema_meta WHERE key='budget.estimate_watermark'").get()).toBeNull();
    expect(artifact.text).not.toContain('\"settled_seq\"');
    target.sqlite.run("UPDATE agent_run_attempts SET steps_total=9 WHERE attempt_id='failed'");
    const epoch=target.sqlite.query("SELECT value FROM schema_meta WHERE key='budget.estimate_epoch'").get();
    await restoreArtifact(target.db,{authorization:{kind:'recovery'},text:artifact.text,allowForeignLineage:true});
    expect(await readSpendRows(target.db,source.now)).toEqual(before);
    expect(target.sqlite.query("SELECT steps_total FROM agent_run_attempts WHERE attempt_id='failed'").get()).toEqual({steps_total:9});
    expect(target.sqlite.query("SELECT value FROM schema_meta WHERE key='budget.estimate_epoch'").get()).toEqual(epoch);
  }finally{source.sqlite.close();target.sqlite.close();}
});

it('refreshes each stage profile from its own sample and lifts preparation due',async()=>{
  const f=await budgetFixture();
  try {
    f.history('title',0.30,'automatic',f.now,0.10);
    f.history('map',2,'automatic',f.now,1,'canopy-map');
    expect(await estimateRefreshDue(f.db,f.now)).toBe(true);
    expect(await engineAssertions(f.serverEnv,f.now)).toContainEqual({name:'estimate:due',maxDepth:'sleep'});
    expect(await refreshEstimates(f.db,f.now)).toMatchObject({more:false});
    expect(await estimateForClaim(f.db,'proj_1','title-summary','codex',PROFILE)).toMatchObject({estimate:0.30});
    expect(await estimateForClaim(f.db,'proj_1','canopy-map','codex',PROFILE)).toMatchObject({estimate:2});
    expect(await estimateRefreshDue(f.db,f.now)).toBe(false);
    expect(await engineAssertions(f.serverEnv,f.now)).not.toContainEqual({name:'estimate:due',maxDepth:'sleep'});
    expect(await estimateRefreshDue(f.db,f.now+3_600_000)).toBe(true);
  }finally{f.sqlite.close();}
});

it('wakes from deep sleep for an empty estimator refresh and then lifts its preparation assertion',async()=>{
  const f=await budgetFixture();
  try {
    const projects=f.sqlite.query('SELECT project_id FROM projects ORDER BY project_id').all();
    await refreshEstimates(f.db,f.now);
    expect((await runTick(f.serverEnv,f.now)).state).toBe('deep_sleep');
    await f.db.batch(estimateInvalidationStatements(f.db,{sql:'1',params:[]}));
    const wake=await runTick(f.serverEnv,f.now+1);
    expect(wake).toMatchObject({state:'sleep',heldBy:'estimate:due'});
    expect(wake.jobs).toContainEqual(expect.objectContaining({name:'estimate-refresh',failed:null,more:false}));
    expect(await estimateRefreshDue(f.db,f.now+1)).toBe(false);
    expect((await runTick(f.serverEnv,f.now+2)).state).toBe('deep_sleep');
    expect(f.sqlite.query('SELECT project_id FROM projects ORDER BY project_id').all()).toEqual(projects);
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_state WHERE key LIKE 'server.budget.estimate.%'").get()).toEqual({n:0});
  }finally{f.sqlite.close();}
});

it('restores a real schema102 artifact without synthesizing costs or origins at read time',async()=>{
  const source=new Database(':memory:');
  const target=await budgetFixture();
  try {
    for(const step of SCHEMA_STEPS.filter(step=>step.version<=102))for(const sql of step.statements)source.exec(sql);
    source.exec("INSERT INTO projects(project_id,name,created_at) VALUES('legacy','Legacy',1)");
    source.exec("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('legacy','Legacy','built-in',1,1)");
    source.exec("INSERT INTO members(id,label,created_at,role) VALUES('mem_legacy','Legacy',1,'member')");
    source.query("INSERT INTO member_credentials(id,member_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at) VALUES('B','mem_legacy','fixture-legacy',1,?,'B',1)").run(target.now+60000);
    source.query("INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,dispatched_by,cost_usd,dispatch_spec) VALUES('legacy','run','legacy','title-summary','completed',?,?, 'B',0.01,'{\"actor\":\"clock\"}')").run(target.now,target.now);
    for(const id of ['A','B'])source.query("INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at) VALUES('legacy','run',?,'fixture',?)").run(id,target.now);
    source.query("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,dispatch_spec) VALUES('legacy','queued','legacy','title-summary','queued',?,'{\"actor\":\"member\"}')").run(target.now);
    const store=sqliteRelationalStore(source),bucket=memoryBlobStore();
    const snapshot=await backupSnapshot(store,bucket,{producer:'schema102',now:target.now});
    const artifact={text:new TextDecoder().decode(snapshot.bytes)};
    expect(JSON.parse(artifact.text.split('\n')[0]!).schemaVersion).toBe(102);
    expect(artifact.text).not.toContain('estimate_usd');
    await restoreArtifact(target.db,{authorization:{kind:'recovery'},text:artifact.text,allowForeignLineage:true});
    expect((await readSpendRows(target.db,target.now)).map(row=>[row.attemptId,row.value]).sort()).toEqual([['A',0.10],['B',0.01]]);
    expect(target.sqlite.query("SELECT origin FROM agent_runs WHERE id='queued'").get()).toEqual({origin:'manual'});
  }finally{source.close();target.sqlite.close();}
});

it('enriches unknown canonical attempt evidence and refuses conflicting prices or profiles atomically',async()=>{
  const f=await budgetFixture();
  try {
    f.history('unknown',null);
    f.sqlite.run("UPDATE agent_run_attempts SET steps_total=9 WHERE attempt_id='unknown'");
    const row=f.sqlite.query<Record<string,unknown>,[]>("SELECT * FROM agent_run_attempts WHERE attempt_id='unknown'").get()!;
    expect(()=>restoreAttemptStatement(f.db,{...row,cost_source:'actual'})).toThrow('known attempt cost');
    const settled={...row,cost_usd:0.70,cost_source:'actual',steps_total:0};
    expect((await restoreAttemptStatement(f.db,settled).all()).results).toHaveLength(1);
    expect((await restoreAttemptStatement(f.db,settled).all()).results).toHaveLength(0);
    expect(f.sqlite.query("SELECT steps_total FROM agent_run_attempts WHERE attempt_id='unknown'").get()).toEqual({steps_total:9});
    await expect(restoreAttemptStatement(f.db,{...settled,cost_usd:0.10}).run()).rejects.toThrow('settled attempt cost evidence conflicts');
    await expect(restoreAttemptStatement(f.db,{...settled,profile_json:JSON.stringify({harness:'other',profile:PROFILE})}).run()).rejects.toThrow('claim evidence');
    await expect(restoreAttemptStatement(f.db,{...settled,leased_by:'other-worker'}).run()).rejects.toThrow('owner that claimed');
    f.sqlite.run("UPDATE agent_run_attempts SET machine_id='known-machine' WHERE attempt_id='unknown'");
    await expect(restoreAttemptStatement(f.db,{...settled,machine_id:'other-machine'}).run()).rejects.toThrow('claim machine');
    f.history('missing-source',0.4);
    f.sqlite.run("DROP TRIGGER agent_attempt_cost_fixed");
    f.sqlite.run("UPDATE agent_run_attempts SET cost_source=NULL WHERE attempt_id='missing-source'");
    f.sqlite.run(V103_STATEMENTS.find(sql=>sql.includes('CREATE TRIGGER IF NOT EXISTS agent_attempt_cost_fixed'))!);
    const missing=f.sqlite.query<Record<string,unknown>,[]>("SELECT * FROM agent_run_attempts WHERE attempt_id='missing-source'").get()!;
    await restoreAttemptStatement(f.db,{...missing,cost_source:'actual'}).run();
    expect(f.sqlite.query("SELECT cost_usd,cost_source FROM agent_run_attempts WHERE attempt_id='unknown'").get()).toEqual({cost_usd:0.70,cost_source:'actual'});
  }finally{f.sqlite.close();}
});

it('publishes estimator groups in bounded CAS-owned pages under overlapping wakes',async()=>{
  const f=await budgetFixture();
  try {
    const groups=ESTIMATE_PUBLISH_PAGE*2+1;
    for(let i=0;i<groups;i++)f.history(`profile-${i}`,i+0.25,'automatic',f.now,0.10,'title-summary',false,'proj_1',{...PROFILE,model:`fixture-${i}`});
    const first=await Promise.all([refreshEstimates(f.db,f.now),refreshEstimates(f.db,f.now)]);
    expect(first.every(result=>result.more)).toBe(true);
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_state WHERE key LIKE 'server.budget.estimate.%'").get()).toEqual({n:ESTIMATE_PUBLISH_PAGE});
    expect((f.sqlite.query("SELECT length(value) AS n FROM schema_meta WHERE key='budget.estimate_progress'").get() as {n:number}).n).toBeLessThan(300);
    expect(await estimateRefreshDue(f.db,f.now)).toBe(true);
    await Promise.all([refreshEstimates(f.db,f.now),refreshEstimates(f.db,f.now)]);
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_state WHERE key LIKE 'server.budget.estimate.%'").get()).toEqual({n:ESTIMATE_PUBLISH_PAGE*2});
    await Promise.all([refreshEstimates(f.db,f.now),refreshEstimates(f.db,f.now)]);
    expect(await estimateRefreshDue(f.db,f.now)).toBe(false);
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_state WHERE key LIKE 'server.budget.estimate.%'").get()).toEqual({n:groups});
    for(let i=0;i<groups;i++)expect(await estimateForClaim(f.db,'proj_1','title-summary','codex',{...PROFILE,model:`fixture-${i}`})).toMatchObject({estimate:i+0.25});
  }finally{f.sqlite.close();}
});

it('fences an initial estimator reader across a portable restore, wherever the restore lands',async()=>{
  const pair=async()=>{
    const source=await budgetFixture(),target=await budgetFixture();
    source.sqlite.run("UPDATE schema_meta SET value=? WHERE key='budget_enabled_at'",[String(source.now-1000)]);
    source.history('restored-sample',2,'automatic',source.now-500);target.history('prior-sample',9);
    const saved=await createBackup(source.db,source.bucket,{producer:'budget-race',now:source.now});
    const artifact=await backupArtifact(source.db,source.bucket,saved.id);
    if(artifact===null)throw new Error('No race artifact');
    source.sqlite.close();
    return {target,restore:()=>restoreArtifact(target.db,{authorization:{kind:'recovery'},text:artifact.text,allowForeignLineage:true})};
  };
  const counted=await pair();
  const counter=counting(counted.target.db);
  try {await refreshEstimates(counter.store,counted.target.now);}finally{counted.target.sqlite.close();}
  expect(counter.calls()).toBeGreaterThan(1);
  const answers:unknown[]=[];
  for(let at=1;at<=counter.calls();at++) {
    const {target,restore}=await pair();
    try {
      const landing=changingAt(target.db,at,restore);
      answers.push(await refreshEstimates(landing.store,target.now));
      expect(landing.landed(),`call ${at}`).toBe(true);
      for(let pass=0;(await refreshEstimates(target.db,target.now)).more;pass++)if(pass>20)throw new Error('estimator passes did not settle');
      expect((await estimateForClaim(target.db,'proj_1','title-summary','codex',PROFILE)).estimate,`call ${at}`).toBeCloseTo(5.5);
    }finally{target.sqlite.close();}
  }
  // A reader the restore overtook publishes nothing and leaves the cycle to the next wake.
  expect(answers).toContainEqual({changed:0,more:true});
});

it('keeps empty cycles constant and incrementally folds new points after the activation floor',async()=>{
  const f=await budgetFixture();
  try {
    for(let i=0;i<1000;i++)f.history(`old-${i}`,0.1,'automatic',f.now-30*86_400_000+i,0.1,'title-summary',true);
    for(let i=0;i<1000;i++)f.history(`outside-${i}`,0.1,'automatic',f.now-30*86_400_000+i);
    const cycle=async(now:number)=>{
      let passes=0;do {if(++passes>40)throw new Error('Estimator pass bound exceeded');}while((await refreshEstimates(f.db,now)).more);
      return passes;
    };
    expect(await cycle(f.now)).toBe(1);
    expect(await cycle(f.now+3_600_000)).toBe(1);
    for(let i=0;i<1000;i++)f.history(`profiled-${i}`,0.2,'automatic',f.now+i+1);
    expect(await cycle(f.now+7_200_000)).toBe(Math.ceil(1000/ESTIMATE_PUBLISH_PAGE));
    expect(await cycle(f.now+10_800_000)).toBe(1);
    expect((await estimateForClaim(f.db,'proj_1','title-summary','codex',PROFILE)).estimate).toBeCloseTo(0.2);
  }finally{f.sqlite.close();}
});

it('answers a failed completion call with a stored reason and activates on retry, wherever a call fails or the process ends',async()=>{
  const counted=await budgetFixture(false);
  let total=0;
  try {
    const counter=counting(counted.db);
    expect(await completeBudgetMigration(counter.store,100)).toEqual({active:true,reason:null});
    total=counter.calls();
  }finally{counted.sqlite.close();}
  expect(total).toBeGreaterThan(3);
  for(const fault of ['transient','ended'] as const)for(const when of ['before','after'] as const)for(let at=1;at<=total;at++) {
    const label=`${fault} ${when} call ${at}`;
    const f=await budgetFixture(false);
    try {
      const before=f.sqlite.query('SELECT key,value FROM schema_meta ORDER BY key').all();
      const store=fault==='transient'?failingAt(f.db,at,when).store:dying(f.db,at,when).store;
      const answer=await completeBudgetMigration(store,100).then(result=>result,()=>null);
      const stored=await budgetActivation(f.db);
      // A failed call never reports an activation, and an answer of inactive names the refusal the store holds.
      if(fault==='transient')expect(answer,label).toMatchObject({reason:expect.any(String)});
      expect(answer?.active,label).not.toBe(true);
      if(answer?.active===false)expect(stored,label).toEqual({active:false,reason:answer.reason});
      // A completion that cannot make its first call has learned nothing and changes nothing.
      if(at===1&&when==='before') {
        expect(answer===null?null:answer.active,label).toBeNull();
        expect(f.sqlite.query('SELECT key,value FROM schema_meta ORDER BY key').all(),label).toEqual(before);
      }
      // Whatever it left, the store holds a governor that is published and enforced, or one that holds automatic work.
      if(stored.active===true) {
        await f.setting(1);f.history(`spent-${at}`,1);
        expect(await f.claim(f.queue('over-budget')),label).toBeNull();
        expect(await completeBudgetMigration(f.db,200),label).toEqual({active:true,reason:null});
      }else {
        expect(f.sqlite.query("SELECT value FROM schema_meta WHERE key='budget_enabled_at'").get(),label).toBeNull();
        const held=f.queue('held');
        expect(await f.claim(held),label).toBeNull();
        expect(await completeBudgetMigration(f.db,200),label).toEqual({active:true,reason:null});
        expect(await f.claim(held),label).not.toBeNull();
      }
      expect(await budgetActivation(f.db),label).toEqual({active:true,reason:null});
    }finally{f.sqlite.close();}
  }
  const active=await budgetFixture();
  try {
    active.sqlite.exec('DROP INDEX idx_attempts_claimed');
    await expect(completeBudgetMigration(active.db,200)).rejects.toThrow('Active budget indexes');
  }finally{active.sqlite.close();}
},120_000);

it('native migration completion records an inactive budget and returns when index preparation fails',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'budget-native-refusal-'));
  const file=path.join(root,'server.sqlite');
  try {
    const current=schemaSqlite();
    try {fs.writeFileSync(file,current.serialize());}finally{current.close();}
    const source=new Database(file);
    source.exec('CREATE TABLE idx_attempts_claimed(id INTEGER)');
    source.close();
    expect(migrateOnly(file)).toBe(0);
    const restored=new Database(file);
    try {expect(await budgetActivation(sqliteRelationalStore(restored))).toMatchObject({active:false,reason:expect.stringContaining('idx_attempts_claimed')});}
    finally{restored.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

it('keeps profiled claims from an inactive interval when activation is retried later',async()=>{
  const f=await budgetFixture(false);
  try {
    // A completion whose call fails before it activates leaves the budget refused, and automatic work held.
    let refused=false;
    for(let at=1;!refused;at++) {
      if(at>50)throw new Error('no failed call left the budget refused');
      refused=(await completeBudgetMigration(failingAt(f.db,at,'before').store,f.now)).active===false;
    }
    expect(await budgetActivation(f.db)).toMatchObject({active:false});
    expect(await f.claim(f.queue('automatic-during-refusal'),f.now+1)).toBeNull();
    expect(await f.claim(f.queue('during-refusal','manual'),f.now+1)).not.toBeNull();
    const row=f.sqlite.query<{attemptId:string},[]>("SELECT dispatched_by AS attemptId FROM agent_runs WHERE id='during-refusal'").get()!;
    expect(await endLeasedRun(f.serverEnv,{principal:f.principal,now:f.now+2},{projectId:'proj_1',runId:'during-refusal',attemptId:row.attemptId,status:'failed',error:'fixture ending',usage:{costUsd:0.2,inputTokens:1,outputTokens:1}})).toMatchObject({ended:true});
    expect(await completeBudgetMigration(f.db,f.now+1000)).toEqual({active:true,reason:null});
    while((await refreshEstimates(f.db,f.now+1001)).more){}
    expect((await estimateForClaim(f.db,'proj_1','title-summary','codex',PROFILE)).estimate).toBeCloseTo(0.2);
    expect(f.sqlite.query("SELECT value FROM schema_meta WHERE key='budget_enabled_at'").get()).toEqual({value:String(f.now)});
    f.sqlite.exec("DELETE FROM schema_meta WHERE key='budget_activation_started_at'");
    // A retry that fails anywhere after activation answers unknown and keeps the published start.
    const counter=counting(f.db);
    await completeBudgetMigration(counter.store,f.now+2000);
    for(let at=1;at<=counter.calls();at++) {
      expect(await completeBudgetMigration(failingAt(f.db,at,'before').store,f.now+2000),`call ${at}`).toMatchObject({active:null});
      expect(f.sqlite.query("SELECT value FROM schema_meta WHERE key='budget_enabled_at'").get(),`call ${at}`).toEqual({value:String(f.now)});
    }
    expect(await completeBudgetMigration(f.db,f.now+3000)).toEqual({active:true,reason:null});
    expect(f.sqlite.query("SELECT value FROM schema_meta WHERE key='budget_enabled_at'").get()).toEqual({value:String(f.now)});
  }finally{f.sqlite.close();}
});

it('keeps an active budget enforced after a transient failure at any call of a completion',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);f.history('spent',1);
    const before=f.sqlite.query('SELECT key,value FROM schema_meta ORDER BY key').all();
    const counter=counting(f.db);
    expect(await completeBudgetMigration(counter.store,f.now+1)).toEqual({active:true,reason:null});
    expect(counter.calls()).toBeGreaterThan(0);
    for(const when of ['before','after'] as const)for(let at=1;at<=counter.calls();at++) {
      const failing=failingAt(f.db,at,when,()=>new Error('fixture transient read'));
      expect(await completeBudgetMigration(failing.store,f.now+1),`${when} call ${at}`).toMatchObject({active:null,reason:expect.stringContaining('transient')});
      expect(f.sqlite.query('SELECT key,value FROM schema_meta ORDER BY key').all(),`${when} call ${at}`).toEqual(before);
      expect(await budgetActivation(f.db),`${when} call ${at}`).toEqual({active:true,reason:null});
    }
    expect(budgetCompletionMessage({active:null,reason:'fixture transient read'})).toBe('Budget governor state not verified: fixture transient read. Automatic work requires an active validated governor; capture and manual work remain available.');
    expect(await f.claim(f.queue('over-budget'))).toBeNull();
  }finally{f.sqlite.close();}
});

it('retains a monotonic settlement cursor across attempt retention and tied claim times',async()=>{
  const f=await budgetFixture();
  try {
    f.history('first',0.1);
    await refreshEstimates(f.db,f.now);
    const cursor=f.sqlite.query<{value:string},[]>("SELECT value FROM schema_meta WHERE key='budget.estimate_watermark'").get()!.value;
    f.sqlite.exec("DELETE FROM agent_run_attempts WHERE attempt_id='first'");
    f.history('second',0.3);
    const second=f.sqlite.query<Record<string,unknown>,[]>("SELECT * FROM agent_run_attempts WHERE attempt_id='second'").get()!;
    expect(Number(second.settled_seq)).toBeGreaterThan(Number(cursor));
    expect(await refreshEstimates(f.db,f.now+3_600_000)).toMatchObject({more:false});
    expect((await estimateForClaim(f.db,'proj_1','title-summary','codex',PROFILE)).estimate).toBeCloseTo(0.2);
    expect(()=>f.sqlite.exec("UPDATE agent_run_attempts SET settled_seq=999 WHERE attempt_id='second'")).toThrow('settlement order');
    expect((await restoreAttemptStatement(f.db,{...second,settled_seq:999}).all()).results).toHaveLength(0);
    expect(f.sqlite.query("SELECT settled_seq FROM agent_run_attempts WHERE attempt_id='second'").get()).toEqual({settled_seq:second.settled_seq});
  }finally{f.sqlite.close();}
});

it('counts a settlement landing at any point of a cycle once: in that cycle or the next',async()=>{
  const counted=await budgetFixture();
  let total=0;
  try {
    counted.history('snapshot-first',0.1);
    const counter=counting(counted.db);
    expect(await refreshEstimates(counter.store,counted.now)).toMatchObject({more:false});
    total=counter.calls();
  }finally{counted.sqlite.close();}
  expect(total).toBeGreaterThan(0);
  for(let at=1;at<=total;at++) {
    const f=await budgetFixture();
    try {
      f.history('snapshot-first',0.1);
      const landing=changingAt(f.db,at,()=>f.history('snapshot-later',0.3));
      expect(await refreshEstimates(landing.store,f.now),`call ${at}`).toMatchObject({more:false});
      expect(landing.landed(),`call ${at}`).toBe(true);
      expect([0.1,0.2].map(value=>value.toFixed(6)),`call ${at}`).toContain((await estimateForClaim(f.db,'proj_1','title-summary','codex',PROFILE)).estimate.toFixed(6));
      expect(await refreshEstimates(f.db,f.now+3_600_000)).toMatchObject({more:false});
      expect((await estimateForClaim(f.db,'proj_1','title-summary','codex',PROFILE)).estimate,`call ${at}`).toBeCloseTo(0.2);
    }finally{f.sqlite.close();}
  }
});
it('replaces restored points from pruned source attempts with sixty local settlements',async()=>{
  const source=await budgetFixture(),target=await budgetFixture();
  const cycle=async(db:typeof source.db,now:number)=>{
    let passes=0;do{if(++passes>100)throw new Error('Restore estimator fixture exceeded its page bound');}while((await refreshEstimates(db,now)).more);
  };
  try {
    for(let i=0;i<1000;i++)source.history(`source-filler-${i}`,0.1,'automatic',source.now+i,0.1,'canopy-map');
    for(let i=0;i<50;i++)source.history(`source-pruned-${i}`,2,'automatic',source.now+2000+i);
    await cycle(source.db,source.now+5000);
    const cached=await estimateForClaim(source.db,'proj_1','title-summary','codex',PROFILE);
    expect(cached.estimate).toBeCloseTo(2,6);
    expect(JSON.parse(cached.observedEstimate!).points.every((point:{seq:number})=>point.seq>1000)).toBe(true);
    source.sqlite.exec('DELETE FROM agent_run_attempts; DELETE FROM agent_runs');
    source.sqlite.run("INSERT INTO agent_state(project_id,agent_id,key,value,updated_at) VALUES('proj_1','myco-agent','opaque-note','plain text',1)");
    const saved=await createBackup(source.db,source.bucket,{producer:'pruned-estimate',now:source.now+6000});
    const artifact=await backupArtifact(source.db,source.bucket,saved.id);
    if(artifact===null)throw new Error('No pruned-estimate artifact');
    await restoreArtifact(target.db,{authorization:{kind:'recovery'},text:artifact.text,allowForeignLineage:true});
    await cycle(target.db,target.now+7000);
    const restored=await estimateForClaim(target.db,'proj_1','title-summary','codex',PROFILE);
    expect(restored.estimate).toBeCloseTo(2,6);
    expect(target.sqlite.query("SELECT value FROM agent_state WHERE key='opaque-note'").get()).toEqual({value:'plain text'});
    for(let i=0;i<60;i++)target.history(`local-fresh-${i}`,0.1,'automatic',target.now+8000+i);
    await cycle(target.db,target.now+8000+3_600_000);
    const local=await estimateForClaim(target.db,'proj_1','title-summary','codex',PROFILE);
    expect(local.estimate).toBeCloseTo(0.1,6);
    expect(JSON.parse(restored.observedEstimate!).points.map((point:{seq:number})=>point.seq)).toEqual(Array(50).fill(0));
    const newest=target.sqlite.query<{seq:number},[]>('SELECT settled_seq AS seq FROM agent_run_attempts ORDER BY settled_seq DESC LIMIT 50').all().map(row=>row.seq);
    expect(JSON.parse(local.observedEstimate!).points.map((point:{seq:number})=>point.seq)).toEqual(newest);
    const watermark=target.sqlite.query("SELECT value FROM schema_meta WHERE key='budget.estimate_watermark'").get();
    await restoreArtifact(target.db,{authorization:{kind:'recovery'},text:artifact.text,allowForeignLineage:true});
    expect((await estimateForClaim(target.db,'proj_1','title-summary','codex',PROFILE)).observedEstimate).toBe(local.observedEstimate);
    expect(target.sqlite.query("SELECT value FROM schema_meta WHERE key='budget.estimate_watermark'").get()).toEqual(watermark);
  }finally{source.sqlite.close();target.sqlite.close();}
});
