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
import { BUDGET_WINDOW_MS } from '@myco-server-worker/core/budget-policy.js';

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
