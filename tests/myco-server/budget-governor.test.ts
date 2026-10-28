import { expect,it } from 'bun:test';
import { budgetFixture,PROFILE } from './helpers/budget-fixture.js';
import { readSpendRows,budgetHeld } from '@myco-server-worker/core/run-budget.js';
import { queueHeads } from '@myco-server-worker/core/queue-heads.js';
import { settleLapsedLease,guardedStateStatement,claimQueuedRun } from '@myco-server-worker/core/runs.js';
import { readBudgetStatus } from '@myco-server-worker/read/budget.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { endLeasedRun } from '@myco-server-worker/core/harness.js';
import { claimNextRun } from '@myco-server-worker/core/harness.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { refreshEstimates,estimateForClaim,estimateKey } from '@myco-server-worker/core/budget-estimates.js';
import { budgetStatusLine } from '@goondocks/myco-shared/budget-status';
import { claimSettings } from '@myco-server-worker/core/worker-selection.js';
import { selectWorkerExecution } from '@myco-server-worker/core/harness.js';
import { capabilitiesRequiredBy } from '@goondocks/myco-shared/repository';
import { runStaleSweep,QUEUE_MAX_AGE_MS } from '@myco-server-worker/core/jobs-run.js';
import { engineAssertions } from '@myco-server-worker/core/tick.js';
import { recordQueueHolder } from '@myco-server-worker/core/runs.js';
import { BUDGET_WINDOW_MS,BUDGET_WORKER_TASKS } from '@myco-server-worker/core/budget-policy.js';
import { PULLED_STAGES, installPulledStages, queuedAdmissibleSql, type PulledItem } from '@myco-server-worker/core/pulled-stages.js';
import { withViewStores } from './helpers/view-stores.js';
import { completeBudgetMigration } from '@myco-server-worker/db/budget-activation.js';
import { NO_LIMITS } from '@myco-server-worker/core/runs.js';
import { measuredStore } from './helpers/read-budget.js';
import { expireLeases } from '@myco-server-worker/core/harness.js';
import type { WorkerPrincipal } from '@myco-server-worker/core/worker-lease.js';
import { PULL_FIXTURE_TABLE, testPulledStage } from '../helpers/pulled-test-stage.js';

it('governs across Projects atomically and lets manual work spend past the budget',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);
    f.history('spent',0);
    const a=f.queue('a','automatic','proj_1','canopy-map'),b=f.queue('b','automatic','proj_2','canopy-map');
    const batch=f.db.batch.bind(f.db);
    let prepared=0,release!:()=>void;
    const ready=new Promise<void>(resolve=>{release=resolve;});
    f.db.batch=async statements=>{if(++prepared<=2){if(prepared===2)release();await ready;}return batch(statements);};
    const outcomes=await Promise.all([f.claim(a),f.claim(b)]);
    f.db.batch=batch;
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const rows=await readSpendRows(f.db,f.now);
    expect(rows.reduce((total,row)=>total+row.value,0)).toBeCloseTo(1);
    const manual=f.queue('manual','manual');
    expect(await f.claim(manual)).not.toBeNull();
    expect((await readSpendRows(f.db,f.now)).filter(row=>row.origin==='manual')).toHaveLength(1);
  } finally {f.sqlite.close();}
});

it('keeps known zero distinct from unknown and replaces estimates with a priced failed report',async()=>{
  const f=await budgetFixture();
  try {
    f.history('zero',0);f.history('unknown',null);
    const candidate=f.queue('priced');
    expect(await f.claim(candidate)).not.toBeNull();
    const {dispatched_by:attemptId}=f.sqlite.query<{dispatched_by:string},[]>("SELECT dispatched_by FROM agent_runs WHERE id='priced'").get()!;
    expect(await endLeasedRun(f.serverEnv,{principal:f.principal,now:f.now+1},{projectId:'proj_1',runId:'priced',attemptId,status:'failed',usage:{costUsd:2,inputTokens:null,outputTokens:null}})).toMatchObject({ended:true});
    const status=await readBudgetStatus(f.db,f.now+1);
    expect(status.automaticUsd).toBeCloseTo(2.1);
    expect(status.unconfirmed?.count).toBe(1);
    expect(budgetStatusLine(status)).toContain('actual spend unknown');
    await f.setting(2);
    expect(await f.claim(f.queue('over'))).toBeNull();
  }finally{f.sqlite.close();}
});

it('shows sequential unpriced attempts from one worker across both origins and a strict window edge',async()=>{
  const f=await budgetFixture();
  try {
    const now=f.now+10_000;
    await f.setting(10);
    for(let i=0;i<20;i++)f.history(`unpriced-${i}`,null,i%5===0?'manual':'automatic',f.now+i,0.3);
    f.history('window-edge',null,'automatic',now-86_400_000,0.3);
    const status=await readBudgetStatus(f.db,now);
    expect(status.unconfirmed?.count).toBe(20);
    expect(status.unconfirmed?.estimatedUsd).toBeCloseTo(6);
    expect(status.unconfirmed?.manual.count).toBe(4);
    expect(status.unconfirmed?.automatic.count).toBe(16);
    expect(status.automaticUsd).toBeCloseTo(4.8);
    expect(status.manualUsd).toBeCloseTo(1.2);
    const candidate=f.queue('next');
    expect(await budgetHeld(f.db,candidate.projectId,candidate.id,4,now)).toBe(false);
    expect(await budgetHeld(f.db,candidate.projectId,candidate.id,4.01,now)).toBe(true);
    expect(budgetStatusLine(status)).toContain('actual spend unknown');
  }finally{f.sqlite.close();}
});

it('samples each immutable stage and model separately and bounds the last-fifty sample',async()=>{
  const f=await budgetFixture();
  try {
    f.sqlite.run("UPDATE schema_meta SET value=? WHERE key='budget_enabled_at'",[String(f.now-1000)]);
    for(let i=0;i<60;i++)f.history(`title-${i}`,i<10?100:0.2,'automatic',f.now-100+i,0.1);
    f.history('map-sample',4,'automatic',f.now,1,'canopy-map');
    f.history('other-model',7,'automatic',f.now,1,'title-summary',false,'proj_1',{...PROFILE,model:'other'});
    while((await refreshEstimates(f.db,f.now)).more){}
    expect((await estimateForClaim(f.db,'proj_1','title-summary','codex',PROFILE)).estimate).toBeCloseTo(0.2);
    expect(await estimateForClaim(f.db,'proj_1','canopy-map','codex',PROFILE)).toMatchObject({estimate:4});
    expect(await estimateForClaim(f.db,'proj_1','title-summary','codex',{...PROFILE,model:'other'})).toMatchObject({estimate:7});
    await f.setting(10_000);
    await f.claim(f.queue('live-title'));
    await f.claim(f.queue('live-map','automatic','proj_1','canopy-map'));
    expect(await claimQueuedRun(f.serverEnv,f.queue('second-title'),{worker:f.principal,leaseExpiresAt:f.now+60_000,harness:'codex',profile:{...PROFILE,effort:'high'},now:f.now})).not.toBeNull();
    const exposure=(await readBudgetStatus(f.db,f.now)).pricedExposure!;
    expect(exposure.usd).toBeCloseTo(12.4);
    expect(exposure).toMatchObject({sampleSize:51,missingSamples:0});
  }finally{f.sqlite.close();}
});

const pollBudget=(f:Awaited<ReturnType<typeof budgetFixture>>,now:number)=>claimNextRun(f.serverEnv,{principal:f.principal,harnesses:[offeredHarness('claude-code')],now});

it('ends a never-affordable quoted head with a budget reason and never asserts active for its hold',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);
    const {selected}=await selectWorkerExecution(f.serverEnv,'title-summary',[offeredHarness('claude-code')],await claimSettings(f.serverEnv),f.principal);
    if(selected===null)throw new Error('Missing fixture profile');
    await guardedStateStatement(f.db,{projectId:'proj_1'},'myco-agent',estimateKey('title-summary',selected.harness,selected.profile),JSON.stringify({estimate:2}),f.now,{sql:'1',params:[]}).run();
    f.queue('too-big');await pollBudget(f,f.now);
    expect((await engineAssertions(f.serverEnv,f.now)).some(a=>a.name==='queue:pending'&&a.maxDepth==='active')).toBe(false);
    await runStaleSweep(f.serverEnv,f.now+7*QUEUE_MAX_AGE_MS);
    expect(f.sqlite.query("SELECT status,error_code FROM agent_runs WHERE id='too-big'").get()).toEqual({status:'failed',error_code:'budget_too_small'});
    expect((await engineAssertions(f.serverEnv,f.now+7*QUEUE_MAX_AGE_MS)).some(a=>a.name.startsWith('queue:'))).toBe(false);
  }finally{f.sqlite.close();}
});

for(const active of [true,false])it(`records and reports task limit holds with budget activation ${active}`,async()=>{
  const f=await budgetFixture(active);
  try {
    await settingsWriter(f.db).setLeaf('agent.limits.task_concurrent_runs',1,'mem_worker',f.now);
    f.queue('first');expect(await pollBudget(f,f.now)).toMatchObject({claimed:true});
    f.queue('second','automatic','proj_1','title-summary',f.now+1);
    expect(await pollBudget(f,f.now+2)).toEqual({claimed:false,reason:'at_limit'});
    expect(f.sqlite.query("SELECT held_by FROM agent_runs WHERE id='second'").get()).toEqual({held_by:'task_concurrent_runs'});
  }finally{f.sqlite.close();}
});

it('replaces a stale budget mark with its limit and bounds retained fitting budget marks',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);f.history('spent',1);f.queue('held');await pollBudget(f,f.now);
    await f.setting(100);
    await settingsWriter(f.db).setLeaf('agent.limits.task_concurrent_runs',1,'mem_worker',f.now);
    f.queue('busy','manual','proj_1','title-summary',f.now-10);
    expect(await pollBudget(f,f.now+1)).toMatchObject({claimed:true,run:{id:'busy'}});
    expect(await pollBudget(f,f.now+2)).toEqual({claimed:false,reason:'at_limit'});
    expect(f.sqlite.query("SELECT held_by FROM agent_runs WHERE id='held'").get()).toEqual({held_by:'task_concurrent_runs'});
    f.queue('retained-budget');
    await recordQueueHolder(f.db,{projectId:'proj_1'},'retained-budget','budget',{usd:0.1,at:f.now});
    await runStaleSweep(f.serverEnv,f.now+3*QUEUE_MAX_AGE_MS);
    expect(f.sqlite.query("SELECT status,error_code FROM agent_runs WHERE id='held'").get()).toEqual({status:'failed',error_code:'machine_did_not_start'});
    expect(f.sqlite.query("SELECT status,error_code FROM agent_runs WHERE id='retained-budget'").get()).toEqual({status:'failed',error_code:'budget_wait_expired'});
  }finally{f.sqlite.close();}
});

it('inserts no credential when the budget refuses a queued claim before the lease write',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);f.history('spent',1);
    const before=f.sqlite.query('SELECT COUNT(*) AS n FROM member_credentials').get();
    expect(await f.claim(f.queue('refused'))).toBeNull();
    expect(f.sqlite.query('SELECT COUNT(*) AS n FROM member_credentials').get()).toEqual(before);
    const manual=f.queue('manual-refusal-control','manual');
    await recordQueueHolder(f.db,{projectId:'proj_1'},manual.id,'budget',{usd:2,at:f.now});
    expect(f.sqlite.query("SELECT held_by FROM agent_runs WHERE id='manual-refusal-control'").get()).toEqual({held_by:null});
    expect(await f.claim(manual)).not.toBeNull();
  }finally{f.sqlite.close();}
});

it('keeps the budget wait grace until the guarded claim when a sweep interleaves after the window frees',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);f.history('spent',1);f.queue('window-wait');
    expect(await pollBudget(f,f.now)).toEqual({claimed:false,reason:'no_work'});
    expect(f.sqlite.query("SELECT held_by FROM agent_runs WHERE id='window-wait'").get()).toEqual({held_by:'budget'});
    const now=f.now+BUDGET_WINDOW_MS+1;
    const prepare=f.db.prepare.bind(f.db),batch=f.db.batch.bind(f.db);
    const sqlByStatement=new WeakMap<object,string>();
    f.db.prepare=sql=>{
      const statement=prepare(sql);
      return {...statement,bind:(...params:unknown[])=>{const bound=statement.bind(...params);sqlByStatement.set(bound,sql);return bound;}};
    };
    let swept=false;
    f.db.batch=async statements=>{
      if(!swept&&statements.some(statement=>/UPDATE agent_runs\s+SET status = 'running'/.test(sqlByStatement.get(statement)??''))) {
        swept=true;await runStaleSweep(f.serverEnv,now);
      }
      return batch(statements);
    };
    const outcome=await pollBudget(f,now);
    expect(swept).toBe(true);
    expect(outcome).toMatchObject({claimed:true,run:{id:'window-wait'}});
    expect(f.sqlite.query("SELECT status,held_by FROM agent_runs WHERE id='window-wait'").get()).toEqual({status:'running',held_by:null});
  }finally{f.sqlite.close();}
});

it('manual claims ignore an unaffordable forecast and changing estimator state',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);f.history('forecast',5);
    await refreshEstimates(f.db,f.now);
    const manual=f.queue('manual-expensive','manual');
    const batch=f.db.batch.bind(f.db);
    let raced=false;
    f.db.batch=async statements=>{
      if(!raced){raced=true;f.sqlite.run("UPDATE agent_state SET value=? WHERE key=?",[JSON.stringify({estimate:10}),estimateKey('title-summary','codex',PROFILE)]);}
      return batch(statements);
    };
    expect(await f.claim(manual)).not.toBeNull();
    expect((await readSpendRows(f.db,f.now)).reduce((sum,row)=>sum+row.value,0)).toBe(10);
  }finally{f.sqlite.close();}
});

it('seeks from the current head on every poll after an older row is requeued',async()=>{
  const f=await budgetFixture();
  try {
    f.queue('later','automatic','proj_1','title-summary',f.now);
    expect((await queueHeads(f.db,[]))[0]?.id).toBe('later');
    f.queue('requeued','automatic','proj_1','title-summary',f.now-1);
    expect((await queueHeads(f.db,[]))[0]?.id).toBe('requeued');
  }finally{f.sqlite.close();}
});

it('counts manual headroom and keeps any held prefix separate from manual heads',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(10);f.history('manual-spend',9,'manual');
    const automatic=f.queue('automatic');
    expect(await budgetHeld(f.db,automatic.projectId,automatic.id,1.50,f.now)).toBe(true);
    expect(await budgetHeld(f.db,automatic.projectId,automatic.id,1,f.now)).toBe(false);
    for(let i=0;i<1001;i++)f.queue(`prefix-${i}`,'automatic','proj_1','title-summary',f.now+i);
    f.queue('manual','manual','proj_1','title-summary',f.now+2000);
    const heads=await queueHeads(f.db,[]);
    expect(heads.map(row=>row.id)).toEqual(['automatic','manual']);
    expect(await f.claim(heads[1]!)).not.toBeNull();
  } finally {f.sqlite.close();}
});

it('keeps lapsed/requeued attempts and reports unconfirmed spend instead of zero',async()=>{
  const f=await budgetFixture();
  try {
    const candidate=f.queue('map','automatic','proj_1','canopy-map');
    expect(await f.claim(candidate)).not.toBeNull();
    const row=f.sqlite.query<{dispatched_by:string},[]>("SELECT dispatched_by FROM agent_runs WHERE id='map'").get()!;
    const lapse=f.now+60_001;
    expect(await settleLapsedLease(f.db,{projectId:'proj_1'},'map',{kind:'member',leasedBy:f.workerTokenId},row.dispatched_by,lapse)).toBe(true);
    expect((await readSpendRows(f.db,lapse)).map(row=>row.value)).toEqual([1]);
    expect(await f.claim(candidate,lapse)).not.toBeNull();
    const status=await readBudgetStatus(f.db,lapse);
    expect(status.automaticUsd).toBe(2);
    expect(status.unconfirmed).toEqual({count:1,estimatedUsd:1,automatic:{count:1,estimatedUsd:1},manual:{count:0,estimatedUsd:0}});
    expect(status.pricedExposure?.missingSamples).toBe(1);
    const late=await endLeasedRun(f.serverEnv,{principal:f.principal,now:lapse},{projectId:'proj_1',runId:'map',attemptId:row.dispatched_by,status:'failed',usage:{costUsd:10,inputTokens:null,outputTokens:null}});
    expect(late.ended).toBe(false);
  } finally {f.sqlite.close();}
});

it('attributes tied and backwards-time legacy attempts by canonical id',async()=>{
  const f=await budgetFixture();
  try {
    f.history('B',0.01,'automatic',100,0.10,'title-summary',true);
    f.sqlite.run(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at) VALUES('proj_1','B','A','fixture',100)`);
    expect((await readSpendRows(f.db,101)).map(row=>[row.attemptId,row.value]).sort()).toEqual([['A',0.10],['B',0.01]]);
    f.sqlite.run("UPDATE agent_run_attempts SET steps_total=1 WHERE attempt_id='B'");
    f.history('backwards',0.01,'automatic',90,0.10,'title-summary',true);
    f.sqlite.run(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at) VALUES('proj_1','backwards','earlier','fixture',100)`);
    const window=await readSpendRows(f.db,86_400_000+95);
    expect(window.filter(row=>row.attemptId==='earlier')).toMatchObject([{value:0.10}]);
    expect(window.some(row=>row.attemptId==='backwards')).toBe(false);
    expect(await settingsWriter(f.db).setLeaf('agent.budget.daily_usd',100_000,'mem_worker',f.now)).toMatchObject({applied:true});
    expect(await settingsWriter(f.db).setLeaf('agent.budget.daily_usd',0.50,'mem_worker',f.now)).toMatchObject({applied:false});
  } finally {f.sqlite.close();}
});

for(const backwards of [false,true])it(`admits the ${backwards?'backwards-clock':'tied-time'} legacy attribution boundary through the real budget leaf`,async()=>{
    const f=await budgetFixture();
    try {
      const now=backwards?86_400_095:101;
      f.history('B',0.01,'automatic',backwards?90:100,0.10,'title-summary',true);
      f.sqlite.run("INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at) VALUES('proj_1','B','A','fixture',100)");
      f.history('manual-baseline',1,'manual',100);
      await guardedStateStatement(f.db,{projectId:'proj_1'},'myco-agent',estimateKey('title-summary','codex',PROFILE),JSON.stringify({estimate:0.01}),now,{sql:'1',params:[]}).run();
      const values=await readSpendRows(f.db,now);
      expect(values.filter(row=>row.origin==='automatic').reduce((sum,row)=>sum+row.value,0)).toBeCloseTo(backwards?0.10:0.11);
      const candidate=f.queue('candidate');
      await f.setting(1.10);
      expect(await f.claim(candidate,now)).toBeNull();
      await f.setting(backwards?1.11:1.12);
      expect(await f.claim(candidate,now)).not.toBeNull();
    }finally{f.sqlite.close();}
});

it('excludes live and historical deterministic work, including arbitrary attempt rows',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);f.history('worker',0.90);
    const candidate=f.queue('boundary');
    const before=await budgetHeld(f.db,'proj_1','boundary',0.10,f.now);
    for(let i=0;i<1000;i++)f.history(`embedding-${i}`,1,'automatic',f.now,1,'embedding-reconcile');
    f.sqlite.run("UPDATE agent_runs SET status='running' WHERE id='embedding-0'");
    expect(await readSpendRows(f.db,f.now)).toHaveLength(1);
    expect(await budgetHeld(f.db,'proj_1','boundary',0.10,f.now)).toBe(before);
    expect(await f.claim(candidate)).not.toBeNull();
  } finally {f.sqlite.close();}
});

it('claims manual work on the first poll past budget-held automatic rows and releases them when the window frees',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);f.history('spent',1);
    for(let i=0;i<25;i++)f.queue(`held-${i}`,'automatic','proj_1','title-summary',f.now+i);
    f.queue('manual','manual','proj_1','title-summary',f.now+100);
    const poll=(now:number)=>claimNextRun(f.serverEnv,{principal:f.principal,harnesses:[offeredHarness('claude-code')],now});
    expect(await poll(f.now+200)).toMatchObject({claimed:true,run:{id:'manual'}});
    expect(f.sqlite.query("SELECT status,held_by FROM agent_runs WHERE id='held-0'").get()).toEqual({status:'queued',held_by:'budget'});
    expect((await readBudgetStatus(f.db,f.now+200)).heldHeads).toEqual([{projectId:'proj_1',runId:'held-0',task:'title-summary',reason:'budget',requiredUsd:0.1,quotedAt:f.now+200}]);
    const released=await poll(f.now+86_400_001);
    expect(released).toMatchObject({claimed:true,run:{id:'held-0'}});
  }finally{f.sqlite.close();}
});

it('keeps a held head exclusion scoped to its Project',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);f.history('spent',1);
    f.queue('same-id','automatic','proj_1','title-summary',f.now);
    f.queue('same-id','manual','proj_2','title-summary',f.now+1);
    expect(await claimNextRun(f.serverEnv,{principal:f.principal,harnesses:[offeredHarness('claude-code')],now:f.now+2}))
      .toMatchObject({claimed:true,run:{id:'same-id',projectId:'proj_2'}});
  }finally{f.sqlite.close();}
});

it('returns no admitted head for an unaffordable forecast while affordable and manual work remain visible',async()=>{
  const f=await budgetFixture();
  try {
    await f.setting(1);
    const harnesses=[offeredHarness('claude-code')];
    const {selected}=await selectWorkerExecution(f.serverEnv,'canopy-map',harnesses,await claimSettings(f.serverEnv),f.principal);
    if(selected===null)throw new Error('No fixture map profile');
    await guardedStateStatement(f.db,{projectId:'proj_1'},'myco-agent',estimateKey('canopy-map',selected.harness,selected.profile),JSON.stringify({estimate:2}),f.now,{sql:'1',params:[]}).run();
    f.queue('unaffordable','automatic','proj_1','canopy-map',f.now);
    const poll=(now:number)=>claimNextRun(f.serverEnv,{principal:f.principal,harnesses,capabilities:[...capabilitiesRequiredBy('canopy-map')],now});
    expect(await poll(f.now)).toEqual({claimed:false,reason:'no_work'});
    expect(f.sqlite.query("SELECT status,held_by FROM agent_runs WHERE id='unaffordable'").get()).toEqual({status:'queued',held_by:'budget'});
    const waiting=await readBudgetStatus(f.db,f.now);
    expect(waiting.heldHeads).toMatchObject([{runId:'unaffordable',reason:'budget_too_small',requiredUsd:2}]);
    expect(budgetStatusLine(waiting)).toContain('raise the budget to $2.00 for run unaffordable');
    f.queue('affordable','automatic','proj_1','title-summary',f.now+1);
    expect(await poll(f.now+2)).toMatchObject({claimed:true,run:{id:'affordable'}});
    f.queue('manual','manual','proj_1','title-summary',f.now+3);
    expect(await poll(f.now+4)).toMatchObject({claimed:true,run:{id:'manual'}});
  }finally{f.sqlite.close();}
});

async function pullFixture(install=true) {
  const f=await budgetFixture();
  await f.setting(20);
  f.sqlite.run(PULL_FIXTURE_TABLE);
  for(const project of ['proj_1','proj_2'])f.sqlite.run("INSERT INTO project_capabilities VALUES (?,'canopy',1,1,'fixture')",[project]);
  for(const id of ['rn_a','rn_b','rn_c']) {
    f.sqlite.run('INSERT INTO runners(id,name,created_at) VALUES(?,?,?)',[id,id,f.now]);
    f.sqlite.run('INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root) VALUES(?,?,?,1,?,?,?)',[`rc_${id}`,id,`hash-${id}`,f.now,f.now+3_600_000,`rc_${id}`]);
  }
  const hooks:{during?:(item:PulledItem)=>Promise<void>|void}={};
  const restore=install?installPulledStages([testPulledStage(1,'title-summary',item=>hooks.during?.(item)),testPulledStage(2,'canopy-map',item=>hooks.during?.(item))]):()=>{};
  const env=f.serverEnv;
  const close=f.sqlite.close.bind(f.sqlite);
  f.sqlite.close=(...args:Parameters<typeof close>)=>{restore();close(...args);};
  const item=(projectId:string,id:string,level:1|2,dueAt=f.now)=>f.sqlite.run('INSERT INTO pull_fixture_items VALUES(?,?,?,?,?)',[projectId,id,level,level===1?'title-summary':'canopy-map',dueAt]);
  const runner=(id='rn_a'):WorkerPrincipal=>({kind:'runner',runnerId:id,credentialId:`rc_${id}`,machineId:null});
  const poll=(id='rn_a',at=f.now,harnesses=[offeredHarness('claude-code')])=>claimNextRun(env,{principal:runner(id),harnesses,capabilities:[...capabilitiesRequiredBy('canopy-map')],now:at});
  const pulled=()=>f.sqlite.query('SELECT project_id AS projectId,subject,status FROM agent_runs WHERE subject IS NOT NULL ORDER BY started_at,rowid').all();
  const liveRun=(id:string,task:string)=>f.sqlite.run(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,origin) VALUES('proj_1',?,'myco-agent',?,'running',?,'automatic')`,[id,task,f.now]);
  const limit=async(value:number|null)=>{if(!(await settingsWriter(f.db).setLeaf('agent.limits.task_concurrent_runs',value,'mem_worker',f.now)).applied)throw new Error('limit refused');};
  /** A refused pulled write leaves no usable credential and no attempt beyond the runs that exist. */
  const nothingStray=()=>{
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM member_credentials WHERE member_id='mem_harness' AND revoked_at IS NULL AND id NOT IN (SELECT dispatched_by FROM agent_runs WHERE dispatched_by IS NOT NULL)").get()).toEqual({n:0});
    expect(f.sqlite.query('SELECT COUNT(*) AS n FROM agent_run_attempts WHERE NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id=agent_run_attempts.project_id AND r.id=agent_run_attempts.run_id)').get()).toEqual({n:0});
  };
  return {...f,env,hooks,item,poll,pulled,liveRun,limit,nothingStray};
}

it('pulls nothing in production and claims queued rows exactly as before',async()=>{
  const f=await pullFixture(false);
  try {
    expect(PULLED_STAGES).toEqual([]);
    f.item('proj_1','due',1);
    f.queue('title','automatic','proj_1','title-summary',f.now);
    const poll=(at:number)=>claimNextRun(f.serverEnv,{principal:f.principal,harnesses:[offeredHarness('claude-code')],now:at});
    expect(await poll(f.now)).toMatchObject({claimed:true,run:{id:'title'}});
    expect(await claimNextRun(f.serverEnv,{principal:{kind:'runner',runnerId:'rn_b',credentialId:'rc_rn_b',machineId:null},harnesses:[offeredHarness('claude-code')],now:f.now})).toEqual({claimed:false,reason:'no_work'});
    expect(f.pulled()).toEqual([]);
  }finally{f.sqlite.close();}
});

it('claims admitted queued rows first, then the higher level before an older lower one, and queues nothing ahead',async()=>{
  const f=await pullFixture();
  try {
    f.item('proj_1','older-low',2,f.now-1000);f.item('proj_1','newer-high',1,f.now);
    expect(f.pulled()).toEqual([]);
    f.queue('title','automatic','proj_2','title-summary',f.now);
    expect(await f.poll('rn_a')).toMatchObject({claimed:true,run:{id:'title'}});
    expect(await f.poll('rn_b')).toMatchObject({claimed:true,run:{task:'title-summary',projectId:'proj_1'}});
    expect(await f.poll('rn_c')).toMatchObject({claimed:true,run:{task:'canopy-map'}});
    expect(f.pulled()).toEqual([{projectId:'proj_1',subject:'fixture:newer-high',status:'running'},{projectId:'proj_1',subject:'fixture:older-low',status:'running'}]);
    expect(f.sqlite.query("SELECT origin,estimate_usd IS NOT NULL AS priced FROM agent_runs r JOIN agent_run_attempts a ON a.run_id=r.id AND a.attempt_id=r.dispatched_by WHERE r.subject='fixture:newer-high'").get()).toEqual({origin:'automatic',priced:1});
  }finally{f.sqlite.close();}
});

it('pulls for the least automatically spent Project and breaks ties by Project id',async()=>{
  for(const [spent,expected] of [[[0,0],'proj_1'],[[5,1],'proj_2']] as const) {
    const f=await pullFixture();
    try {
      f.history('spent-1',spent[0],'automatic',f.now,0.1,'title-summary',false,'proj_1');
      f.history('spent-2',spent[1],'automatic',f.now,0.1,'title-summary',false,'proj_2');
      f.history('manual-2',9,'manual',f.now,0.1,'title-summary',false,'proj_2');
      f.item('proj_1','a',1);f.item('proj_2','b',1);
      expect(await f.poll()).toMatchObject({claimed:true,run:{projectId:expected}});
    }finally{f.sqlite.close();}
  }
});

it('admits nothing pulled when the top level head does not fit, even with cheaper lower work',async()=>{
  const f=await pullFixture();
  try {
    await f.setting(1);
    const {selected}=await selectWorkerExecution(f.serverEnv,'title-summary',[offeredHarness('claude-code')],await claimSettings(f.serverEnv),f.principal);
    await guardedStateStatement(f.db,{projectId:'proj_1'},'myco-agent',estimateKey('title-summary',selected!.harness,selected!.profile),JSON.stringify({estimate:2}),f.now,{sql:'1',params:[]}).run();
    f.item('proj_1','expensive',1);f.item('proj_2','cheap',2);
    await guardedStateStatement(f.db,{projectId:'proj_2'},'myco-agent',estimateKey('canopy-map',selected!.harness,{...selected!.profile,tier:'default'}),JSON.stringify({estimate:0.1}),f.now,{sql:'1',params:[]}).run();
    expect(await f.poll()).toEqual({claimed:false,reason:'no_work'});
    expect(f.pulled()).toEqual([]);
    f.nothingStray();
  }finally{f.sqlite.close();}
});

it('falls through a top level this worker cannot run now, by task limit or by profile',async()=>{
  const f=await pullFixture();
  try {
    await f.limit(1);f.liveRun('busy-title','title-summary');
    f.item('proj_1','held-high',1);f.item('proj_1','free-low',2);
    expect(await f.poll('rn_a')).toMatchObject({claimed:true,run:{task:'canopy-map'}});
    await f.limit(null);
    f.item('proj_2','free-low-2',2);
    expect(await settingsWriter(f.db).setLeaf('agent.effort_map.claude-code.low','high','mem_worker',f.now)).toEqual({applied:true});
    const mediumOnly=[{...offeredHarness('claude-code'),profile:{model:'flag' as const,efforts:['medium']}}];
    expect(await f.poll('rn_b',f.now,mediumOnly)).toMatchObject({claimed:true,run:{task:'canopy-map',projectId:'proj_2'}});
    expect(f.pulled()).toHaveLength(2);
  }finally{f.sqlite.close();}
});

it('reasserts level and capacity inside the write when they change during input preparation',async()=>{
  const freed=await pullFixture();
  try {
    await freed.limit(1);freed.liveRun('busy-title','title-summary');
    freed.item('proj_1','high',1);freed.item('proj_1','low',2);
    freed.hooks.during=item=>{if(item.key==='low')freed.sqlite.run("UPDATE agent_runs SET status='completed' WHERE id='busy-title'");};
    expect(await freed.poll()).toMatchObject({claimed:true,run:{task:'title-summary'}});
    expect(freed.pulled()).toEqual([{projectId:'proj_1',subject:'fixture:high',status:'running'}]);
    freed.nothingStray();
  }finally{freed.sqlite.close();}
  const consumed=await pullFixture();
  try {
    await consumed.limit(1);consumed.item('proj_1','low',2);
    consumed.hooks.during=()=>{consumed.item('proj_1','high',1);consumed.liveRun('filled-title','title-summary');};
    expect(await consumed.poll()).toMatchObject({claimed:true,run:{task:'canopy-map'}});
  }finally{consumed.sqlite.close();}
  const arriving=await pullFixture();
  try {
    arriving.item('proj_1','low',2);
    arriving.hooks.during=item=>{if(item.key==='low')arriving.item('proj_2','high',1);};
    expect(await arriving.poll()).toMatchObject({claimed:true,run:{task:'title-summary',projectId:'proj_2'}});
    expect(arriving.pulled()).toHaveLength(1);
    arriving.nothingStray();
  }finally{arriving.sqlite.close();}
  const spent=await pullFixture();
  try {
    spent.item('proj_1','tied-first',1);spent.item('proj_2','tied-second',1);
    spent.hooks.during=item=>{if(item.key==='tied-first')spent.history('spent-during',5,'automatic',spent.now,0.1,'title-summary',false,'proj_1');};
    expect(await spent.poll()).toMatchObject({claimed:true,run:{projectId:'proj_2'}});
    spent.nothingStray();
  }finally{spent.sqlite.close();}
  const queued=await pullFixture();
  try {
    queued.item('proj_1','only',1);
    queued.hooks.during=()=>{queued.queue('queued-during','manual','proj_2','title-summary',queued.now);};
    expect(await queued.poll()).toMatchObject({claimed:true,run:{id:'queued-during'}});
    expect(queued.pulled()).toEqual([]);
    queued.nothingStray();
  }finally{queued.sqlite.close();}
  await withViewStores(async(db,target)=>{
    if(target!=='D1')return;
    await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Agent','built-in',1,1)").run();
    await completeBudgetMigration(db,Date.now());
    await db.prepare(`INSERT INTO agent_state(project_id,agent_id,key,value,updated_at) VALUES('project','myco-agent','canopy-map','{"estimate":1000000}',1)`).run();
    const measured=measuredStore(db as Parameters<typeof measuredStore>[0]);
    const admissible=`SELECT ${queuedAdmissibleSql(BUDGET_WORKER_TASKS.map(task=>({task,estimateKey:task})),NO_LIMITS,Date.now())} AS admissible`;
    const reads=async(backlog:number)=>{
      await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,origin) SELECT 'project','held-${backlog}-'||key,'myco-agent','canopy-map','queued',key,'automatic' FROM json_each(?)`)
        .bind(JSON.stringify(Array(backlog).fill(0))).run();
      measured.reset();
      expect(await measured.db.prepare(admissible).first()).toEqual({admissible:0});
      return measured.reads();
    };
    // A held queued backlog costs the head seeks alone, whatever its length.
    const one=await reads(1);
    expect(await reads(999)).toBe(one);
  });
});

it('writes nothing when the head, the Project, the runner or the settings change during preparation',async()=>{
  for(const change of ['head','project','runner','budget'] as const) {
    const f=await pullFixture();
    try {
      f.item('proj_1','only',1);
      f.hooks.during=()=>{
        if(change==='head')f.sqlite.run("DELETE FROM pull_fixture_items WHERE item_id='only'");
        if(change==='project')f.sqlite.run("UPDATE projects SET archived_at=1 WHERE project_id='proj_1'");
        if(change==='runner')f.sqlite.run("UPDATE runners SET state='paused' WHERE id='rn_a'");
        if(change==='budget')f.history('spent-during',20,'automatic',f.now,0.1,'title-summary',false,'proj_2');
      };
      expect(await f.poll()).toEqual({claimed:false,reason:change==='runner'?'paused':'no_work'});
      expect(f.pulled()).toEqual([]);
      f.nothingStray();
    }finally{f.sqlite.close();}
  }
  const f=await pullFixture();
  try {
    f.item('proj_1','only',1);
    let changed=false;
    f.hooks.during=async()=>{if(!changed){changed=true;await settingsWriter(f.db).setLeaf('agent.reasoning_map.claude-code.low','claude-fixture-low','mem_worker',f.now);}};
    expect(await f.poll()).toMatchObject({claimed:true,run:{profile:{model:'claude-fixture-low'}}});
    expect(f.pulled()).toHaveLength(1);
    f.nothingStray();
  }finally{f.sqlite.close();}
});

it('creates one run when concurrent polls race for a subject, a runner or the last dollar',async()=>{
  const race=async(f:Awaited<ReturnType<typeof pullFixture>>,runners:readonly string[])=>{
    let arrived=0,release!:()=>void;
    const together=new Promise<void>(resolve=>{release=resolve;});
    f.hooks.during=async()=>{if(++arrived===runners.length)release();await together;};
    return Promise.all(runners.map(id=>f.poll(id)));
  };
  const subject=await pullFixture();
  try {
    subject.item('proj_1','same',1);
    expect((await race(subject,['rn_a','rn_b'])).filter(outcome=>outcome.claimed)).toHaveLength(1);
    expect(subject.pulled()).toHaveLength(1);subject.nothingStray();
  }finally{subject.sqlite.close();}
  const runner=await pullFixture();
  try {
    runner.item('proj_1','first',1);runner.item('proj_2','second',1);
    expect((await race(runner,['rn_a','rn_a'])).filter(outcome=>outcome.claimed)).toHaveLength(1);
    expect(runner.sqlite.query('SELECT COUNT(*) AS n FROM agent_run_attempts').get()).toEqual(runner.sqlite.query('SELECT COUNT(*) AS n FROM agent_runs WHERE dispatched_by IS NOT NULL').get());
    runner.nothingStray();
  }finally{runner.sqlite.close();}
  const money=await pullFixture();
  try {
    await money.setting(1);
    money.history('spent-1',0.5,'automatic',money.now,0.1,'title-summary',false,'proj_1');
    money.history('spent-2',0.35,'automatic',money.now,0.1,'title-summary',false,'proj_2');
    money.item('proj_1','a',1);money.item('proj_2','b',1);money.item('proj_2','c',1,money.now+1);
    const outcomes=await race(money,['rn_a','rn_b']);
    expect(outcomes.filter(outcome=>outcome.claimed)).toHaveLength(1);
    expect(money.pulled()).toEqual([{projectId:'proj_2',subject:'fixture:b',status:'running'}]);
    money.nothingStray();
  }finally{money.sqlite.close();}
});

it('ends a pulled run whose lease lapses instead of requeuing it, and pulls the work again',async()=>{
  const f=await pullFixture();
  try {
    f.item('proj_1','lapsing',1);
    const first=await f.poll();
    if(!first.claimed)throw new Error('pull refused');
    expect(await expireLeases(f.env,first.run.leaseExpiresAt)).toBe(1);
    expect(f.sqlite.query('SELECT status,error_code,queued_at FROM agent_runs WHERE id=?').get(first.run.id)).toEqual({status:'failed',error_code:'lease_lapsed',queued_at:null});
    const again=await f.poll('rn_a',first.run.leaseExpiresAt+1);
    expect(again).toMatchObject({claimed:true,run:{task:'title-summary'}});
    expect(f.pulled()).toEqual([{projectId:'proj_1',subject:'fixture:lapsing',status:'failed'},{projectId:'proj_1',subject:'fixture:lapsing',status:'running'}]);
    expect(f.sqlite.query('SELECT COUNT(*) AS n FROM agent_run_attempts WHERE run_id=?').get(first.run.id)).toEqual({n:1});
  }finally{f.sqlite.close();}
});

it('pulls affordable work past a queued head that never fits the budget',async()=>{
  const f=await pullFixture();
  try {
    await f.setting(1);
    const {selected}=await selectWorkerExecution(f.serverEnv,'canopy-map',[offeredHarness('claude-code')],await claimSettings(f.serverEnv),f.principal);
    await guardedStateStatement(f.db,{projectId:'proj_1'},'myco-agent',estimateKey('canopy-map',selected!.harness,selected!.profile),JSON.stringify({estimate:2}),f.now,{sql:'1',params:[]}).run();
    f.queue('unaffordable','automatic','proj_1','canopy-map',f.now);
    f.item('proj_2','affordable',1);
    expect(await f.poll()).toMatchObject({claimed:true,run:{projectId:'proj_2',task:'title-summary'}});
    expect(f.sqlite.query("SELECT status,held_by FROM agent_runs WHERE id='unaffordable'").get()).toEqual({status:'queued',held_by:'budget'});
  }finally{f.sqlite.close();}
});
