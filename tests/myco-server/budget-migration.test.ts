import {expect,it} from 'bun:test';
import { Database } from 'bun:sqlite';
import { budgetFixture,PROFILE } from './helpers/budget-fixture.js';
import { completeBudgetMigration,budgetActivation,budgetCompletionMessage,BUDGET_INDEX_ROW_LIMIT } from '@myco-server-worker/db/budget-activation.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { V103_STATEMENTS } from '@myco-server-worker/db/schema-v103.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { createBackup,backupArtifact,restoreArtifact } from '@myco-server-worker/core/backup.js';
import { readSpendRows } from '@myco-server-worker/core/run-budget.js';
import { refreshEstimates,estimateForClaim,estimateRefreshDue } from '@myco-server-worker/core/budget-estimates.js';
import { ESTIMATE_PUBLISH_PAGE } from '@myco-server-worker/core/budget-estimates.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { engineAssertions,runTick } from '@myco-server-worker/core/tick.js';
import { invalidateEstimates } from '@myco-server-worker/core/budget-estimates.js';
import { restoreAttemptStatement } from '@myco-server-worker/core/attempt-accounting.js';
import worker from '@myco-server-worker/index.js';
import { asOwner,OWNER_ENV } from './helpers/owner.js';
import { migrateOnly } from '@myco-server-worker/platform/bun/server-main.js';
import { endLeasedRun } from '@myco-server-worker/core/harness.js';
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

for(const table of ['agent_runs','agent_run_attempts'])it(`keeps preflight refusal visible for ${table}`,async()=>{
  const f=await budgetFixture(false);
  try {
    const db={...f.db,prepare:(sql:string)=>sql===`SELECT COUNT(*) AS n FROM ${table}`?{
      ...f.db.prepare(sql),all:async<T,>()=>({results:[{n:BUDGET_INDEX_ROW_LIMIT+1}] as T[]}),
    }:f.db.prepare(sql)};
    expect(await completeBudgetMigration(db,100)).toMatchObject({active:false,reason:expect.stringContaining(table)});
    expect(await budgetActivation(f.db)).toMatchObject({active:false,reason:expect.stringContaining('100001')});
    expect(await f.claim(f.queue('legacy-claim'))).not.toBeNull();
    expect(await completeBudgetMigration(f.db,200)).toMatchObject({active:true});
  }finally{f.sqlite.close();}
});

for(const reply of ['missing','null','negative','fractional','error'])it(`keeps unreadable preflight ${reply} visible without activating or preparing indexes`,async()=>{
  const f=await budgetFixture(false);
  try {
    const candidate=f.queue('waiting');
    const db={...f.db,prepare:(sql:string)=>sql.startsWith('SELECT COUNT(*) AS n FROM agent_')?{
      ...f.db.prepare(sql),all:async<T,>()=>{
        if(reply==='error')throw new Error('fixture count unavailable');
        return {results:(reply==='missing'?[]:[{n:reply==='null'?null:reply==='negative'?-1:1.5}]) as T[]};
      },
    }:f.db.prepare(sql)};
    expect(await completeBudgetMigration(db,100)).toMatchObject({active:false,reason:expect.stringContaining('preflight')});
    expect(await budgetActivation(f.db)).toMatchObject({active:false,reason:expect.stringContaining('preflight')});
    if(reply==='missing') {
      const status=await worker.fetch(await asOwner(f.db,'/api/status'),{...f.env,...OWNER_ENV});
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({budget:{active:false,reason:expect.stringContaining('preflight')}});
    }
    expect(f.sqlite.query("SELECT value FROM schema_meta WHERE key='version'").get()).toEqual({value:'103'});
    expect(f.sqlite.query("SELECT name FROM sqlite_master WHERE name IN ('idx_attempts_claimed','idx_agent_runs_queue_head')").all()).toEqual([]);
    expect(f.sqlite.query("SELECT value FROM schema_meta WHERE key='budget_enabled_at'").get()).toBeNull();
    expect(await f.claim(candidate)).not.toBeNull();
    expect(await completeBudgetMigration(f.db,200)).toEqual({active:true,reason:null});
    expect(f.sqlite.query("SELECT value FROM schema_meta WHERE key='budget_activation_refusal'").get()).toBeNull();
  }finally{f.sqlite.close();}
});

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
    await invalidateEstimates(f.db);
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
    const saved=await createBackup(store,bucket,{producer:'schema102',now:target.now});
    const artifact=await backupArtifact(store,bucket,saved.id);
    if(artifact===null)throw new Error('Missing old artifact');
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

it('fences an initial estimator reader across a portable restore',async()=>{
  const source=await budgetFixture(),target=await budgetFixture();
  let release!:()=>void;
  const resume=new Promise<void>(resolve=>{release=resolve;});
  try {
    source.sqlite.run("UPDATE schema_meta SET value=? WHERE key='budget_enabled_at'",[String(source.now-1000)]);
    source.history('restored-sample',2,'automatic',source.now-500);target.history('prior-sample',9);
    const saved=await createBackup(source.db,source.bucket,{producer:'budget-race',now:source.now});
    const artifact=await backupArtifact(source.db,source.bucket,saved.id);
    if(artifact===null)throw new Error('No race artifact');
    let reached!:()=>void;
    const paused=new Promise<void>(resolve=>{reached=resolve;});
    const db={...target.db,batch:async(statements:Parameters<typeof target.db.batch>[0])=>{reached();await resume;return target.db.batch(statements);}};
    const refresh=refreshEstimates(db,target.now);
    await paused;
    await restoreArtifact(target.db,{authorization:{kind:'recovery'},text:artifact.text,allowForeignLineage:true});
    release();
    expect(await refresh).toEqual({changed:0,more:true});
    await refreshEstimates(target.db,target.now);
    expect((await estimateForClaim(target.db,'proj_1','title-summary','codex',PROFILE)).estimate).toBeCloseTo(5.5);
  }finally{release();source.sqlite.close();target.sqlite.close();}
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

it('records non-invariant completion failures and preserves fatal active-index invariants',async()=>{
  for(const fault of ['metadata','catalogue','create','verification','origin','activation-reply']) {
    const f=await budgetFixture(false);
    let catalogue=0;
    try {
      const db={...f.db,prepare:(sql:string)=>{
        const statement=f.db.prepare(sql);
        return {...statement,all:async<T,>()=>{
          if((fault==='metadata'&&sql.startsWith('SELECT key,value'))||(fault==='catalogue'&&sql.startsWith('SELECT name,sql')))throw new Error(`fixture ${fault}`);
          if(sql.startsWith('SELECT name,sql')&&++catalogue===2&&fault==='verification')return {results:[] as T[]};
          if(fault==='origin'&&sql.includes('origin IS NULL'))return {results:[{missing:1}] as T[]};
          return statement.all<T>();
        },run:async()=>{
          if(fault==='create'&&sql.startsWith('CREATE INDEX'))throw new Error('fixture index preparation');
          const result=await statement.run();
          if(fault==='activation-reply'&&/INSERT OR IGNORE INTO schema_meta\(key,value\) (?:SELECT |VALUES\()'budget_enabled_at'/.test(sql))throw new Error('fixture lost activation reply');
          return result;
        }};
      }};
      expect(await completeBudgetMigration(db,100)).toMatchObject({active:['metadata','activation-reply'].includes(fault)?null:false,reason:expect.any(String)});
      expect(await budgetActivation(f.db)).toMatchObject(fault==='activation-reply'?{active:true,reason:null}:{active:false,reason:expect.any(String)});
      if(fault==='activation-reply') {
        await f.setting(1);f.history('published-spent',1);
        expect(await f.claim(f.queue('published-over-budget'))).toBeNull();
      }else expect(f.sqlite.query("SELECT value FROM schema_meta WHERE key='budget_enabled_at'").get()).toBeNull();
      expect(await completeBudgetMigration(f.db,200)).toEqual({active:true,reason:null});
    }finally{f.sqlite.close();}
  }
  const active=await budgetFixture();
  try {
    active.sqlite.exec('DROP INDEX idx_attempts_claimed');
    await expect(completeBudgetMigration(active.db,200)).rejects.toThrow('Active budget indexes');
  }finally{active.sqlite.close();}
});

it('native migration completion records an inactive budget and returns when index preparation fails',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'budget-native-refusal-'));
  const file=path.join(root,'server.sqlite');
  try {
    const source=new Database(file);
    for(const step of SCHEMA_STEPS)for(const sql of step.statements)source.exec(sql);
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
    const unavailable={...f.db,prepare:(sql:string)=>sql.startsWith('SELECT COUNT(*) AS n FROM agent_')?{
      ...f.db.prepare(sql),all:async<T,>()=>({results:[] as T[]}),
    }:f.db.prepare(sql)};
    expect(await completeBudgetMigration(unavailable,f.now)).toMatchObject({active:false});
    expect(await f.claim(f.queue('during-refusal'),f.now+1)).not.toBeNull();
    const row=f.sqlite.query<{attemptId:string},[]>("SELECT dispatched_by AS attemptId FROM agent_runs WHERE id='during-refusal'").get()!;
    expect(await endLeasedRun(f.serverEnv,{principal:f.principal,now:f.now+2},{projectId:'proj_1',runId:'during-refusal',attemptId:row.attemptId,status:'failed',error:'fixture ending',usage:{costUsd:0.2,inputTokens:1,outputTokens:1}})).toMatchObject({ended:true});
    expect(await completeBudgetMigration(f.db,f.now+1000)).toEqual({active:true,reason:null});
    while((await refreshEstimates(f.db,f.now+1001)).more){}
    expect((await estimateForClaim(f.db,'proj_1','title-summary','codex',PROFILE)).estimate).toBeCloseTo(0.2);
    expect(f.sqlite.query("SELECT value FROM schema_meta WHERE key='budget_enabled_at'").get()).toEqual({value:String(f.now)});
    f.sqlite.exec("DELETE FROM schema_meta WHERE key='budget_activation_started_at'");
    const interrupted={...f.db,prepare:(sql:string)=>sql.startsWith('SELECT name,sql')?{
      ...f.db.prepare(sql),all:async<T,>():Promise<{results:T[]}>=>{throw new Error('fixture catalogue unavailable');},
    }:f.db.prepare(sql)};
    expect(await completeBudgetMigration(interrupted,f.now+2000)).toMatchObject({active:null});
    expect(await completeBudgetMigration(f.db,f.now+3000)).toEqual({active:true,reason:null});
    expect(f.sqlite.query("SELECT value FROM schema_meta WHERE key='budget_enabled_at'").get()).toEqual({value:String(f.now)});
  }finally{f.sqlite.close();}
});

for(const fault of ['stamps','catalogue'])it(`keeps an active budget enforced after a transient ${fault} read failure`,async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);f.history('spent',1);
    const before=f.sqlite.query('SELECT key,value FROM schema_meta ORDER BY key').all();
    const db={...f.db,prepare:(sql:string)=>{
      const statement=f.db.prepare(sql);
      if(sql.startsWith(fault==='stamps'?'SELECT key,value':'SELECT name,sql'))return {...statement,all:async<T,>():Promise<{results:T[]}>=>{throw new Error('fixture transient read');}};
      return statement;
    }};
    expect(await completeBudgetMigration(db,f.now+1)).toMatchObject({active:null,reason:expect.stringContaining('transient')});
    expect(f.sqlite.query('SELECT key,value FROM schema_meta ORDER BY key').all()).toEqual(before);
    expect(await budgetActivation(f.db)).toEqual({active:true,reason:null});
    expect(budgetCompletionMessage({active:null,reason:'fixture transient read'})).toBe('Budget governor state not verified: fixture transient read');
    expect(await f.claim(f.queue('over-budget'))).toBeNull();
  }finally{f.sqlite.close();}
});
it('keeps unknown inactive completion state untouched until its stamps can be read',async()=>{
  const f=await budgetFixture(false);
  try {
    const before=f.sqlite.query('SELECT key,value FROM schema_meta ORDER BY key').all();
    const db={...f.db,prepare:(sql:string)=>sql.startsWith('SELECT key,value')?{...f.db.prepare(sql),all:async<T,>():Promise<{results:T[]}>=>{throw new Error('fixture stamps unavailable');}}:f.db.prepare(sql)};
    expect(await completeBudgetMigration(db,f.now)).toMatchObject({active:null});
    expect(f.sqlite.query('SELECT key,value FROM schema_meta ORDER BY key').all()).toEqual(before);
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

it('leaves settlements after a cycle snapshot for the next incremental cycle',async()=>{
  const f=await budgetFixture();
  try {
    f.history('snapshot-first',0.1);
    let inserted=false;
    const wrap=(statement:ReturnType<typeof f.db.prepare>,sql:string):ReturnType<typeof f.db.prepare>=>({...statement,
      bind:(...values)=>wrap(statement.bind(...values),sql),
      first:async<T,>()=>{
        const value=await statement.first<T>();
        if(!inserted&&sql.startsWith('SELECT (SELECT value')){inserted=true;f.history('snapshot-later',0.3);}
        return value;
      },
    });
    const db={...f.db,prepare:(sql:string)=>wrap(f.db.prepare(sql),sql)};
    expect(await refreshEstimates(db,f.now)).toMatchObject({more:false});
    expect(inserted).toBe(true);
    expect((await estimateForClaim(f.db,'proj_1','title-summary','codex',PROFILE)).estimate).toBeCloseTo(0.1);
    expect(await refreshEstimates(f.db,f.now+3_600_000)).toMatchObject({more:false});
    expect((await estimateForClaim(f.db,'proj_1','title-summary','codex',PROFILE)).estimate).toBeCloseTo(0.2);
  }finally{f.sqlite.close();}
});

it('propagates a refusal persistence failure instead of reporting recorded inactive state',async()=>{
  const f=await budgetFixture(false);
  try {
    const db={...f.db,prepare:(sql:string)=>{
      const statement=f.db.prepare(sql);
      return {...statement,all:async<T,>()=>sql.startsWith('SELECT COUNT(*)')?{results:[] as T[]}:statement.all<T>(),
        run:async()=>{if(sql.includes("VALUES('budget_activation_refusal'"))throw new Error('fixture refusal write failed');return statement.run();}};
    }};
    await expect(completeBudgetMigration(db,f.now)).rejects.toThrow('fixture refusal write failed');
  }finally{f.sqlite.close();}
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
