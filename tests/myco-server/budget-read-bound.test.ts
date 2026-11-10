import {refreshEstimates,estimateForClaim} from '@myco-server-worker/core/budget-estimates.js';
import {settingsWriter} from '@myco-server-worker/core/settings.js';
import {expect,it} from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import {budgetFixture,PROFILE} from './helpers/budget-fixture.js';
import {sqliteBudgetMeter,type MeterStatement} from './helpers/budget-meter.js';
import {completeBudgetMigration} from '@myco-server-worker/db/meta/budget-activation.js';
import { readBudgetStatus } from '@myco-server-worker/db/runs/budget.js';
import {BUDGET_WINDOW_MS} from '@myco-server-worker/core/budget-policy.js';
import {expireSpend,SPEND_DUE_READ_LIMIT} from '@myco-server-worker/db/runs/admission.js';
import { claimQueuedRun } from '@myco-server-worker/core/worker-claim.js';
import { workerClaimAdmission, NO_LIMITS } from '@myco-server-worker/db/runs/claim.js';
import {NO_RUNTIME_CLAIMS} from '@myco-server-worker/auth/tokens.js';
import type {RelationalStore,PreparedStatement} from '@myco-server-worker/core/adapters.js';
import { schemaD1Root } from './helpers/schema-template.js';
import { measuredStore } from './helpers/read-budget.js';

type D1=Awaited<ReturnType<Miniflare['getD1Database']>>;
const TABLES=['projects','agents','members','member_credentials','agent_runs','agent_run_attempts','agent_state','deployment_settings'];
async function copyToD1(db:Database,d1:D1) {
  await d1.batch([...TABLES].reverse().map(table=>d1.prepare(`DELETE FROM ${table}`)));
  for(const table of TABLES) {
    const rows=db.query(`SELECT * FROM ${table}`).all() as Record<string,unknown>[];
    const keys=Object.keys(rows[0]??{}).filter(key=>rows.some(row=>row[key]!==null));
    for(let start=0;start<rows.length;start+=200) {
      const values=JSON.stringify(rows.slice(start,start+200).map(row=>keys.map(key=>row[key])));
      await d1.prepare(`INSERT OR REPLACE INTO ${table}(${keys.join(',')}) SELECT ${keys.map((_,i)=>`json_extract(j.value,'$[${i}]')`).join(',')} FROM json_each(?) j`).bind(values).run();
    }
  }
  await completeBudgetMigration(d1,Date.now());
}

it('keeps mint, claim and status reads independent of attempt history, inside and outside the window',async()=>{
  const meter=sqliteBudgetMeter();
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null)}}',compatibilityDate:'2026-07-01',d1Databases:['DB'], resourcePersistencePath: await schemaD1Root()}));
  const d1=await mf.getD1Database('DB');
  try {
    for(const live of [0,20]) {
      const measured:Record<string,number[]>={};
      for(const recent of [1,1000]) {
        const f=await budgetFixture();
        try {
          await f.setting(10_000);
          await settingsWriter(f.db).setLeaf('agent.limits.task_concurrent_runs',null,'mem_worker',f.now);
          for(let i=0;i<recent;i++)f.history(`history-${i}`,0.10);
          for(let i=0;i<live;i++) {
            f.history(`live-${i}`,null,'automatic',f.now-BUDGET_WINDOW_MS-1000,0.10);
            f.sqlite.run('UPDATE agent_runs SET status=? WHERE id=?',['running',`live-${i}`]);
          }
          for(let i=0;i<1000;i++)f.sqlite.query(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,origin) VALUES('proj_1',?,'myco-agent','embedding-reconcile','completed',?,'automatic')`).run(`embedding-${i}`,f.now);
          const candidate=f.queue('candidate');
          const snapshot=f.sqlite.serialize();
          const statements:MeterStatement[]=[];
          const db:RelationalStore={...f.db,batch:async(batch:PreparedStatement[])=>{
            statements.push(...batch as unknown as MeterStatement[]);
            return f.db.batch(batch);
          }};
          await claimQueuedRun({...f.serverEnv,db},candidate,{worker:f.principal,leaseExpiresAt:f.now+60_000,harness:'codex',profile:PROFILE,now:f.now});
          const claim=statements.find(entry=>/^UPDATE agent_runs\s+SET status = 'running'/.test(entry.sql));
          const mint=statements.find(entry=>entry.sql.includes('INSERT INTO member_credentials'));
          if(claim===undefined||mint===undefined)throw new Error('No actual claim or credential mint statement captured');
          statements.length=0;
          await readBudgetStatus(db,f.now);
          const inputs:Record<string,MeterStatement>={mint,claim,...Object.fromEntries(statements.map((entry,i)=>[`status${i}`,entry]))};
          const source=Database.deserialize(snapshot);
          try {
            await copyToD1(source,d1);
            for(const [name,entry] of Object.entries(inputs)) {
              const native=meter.reads(source,entry);
              const result=await d1.prepare(entry.sql).bind(...entry.params).all();
              // The claim reads the credential its production batch minted first.
              if(name==='mint')source.query(entry.sql).run(...entry.params as never[]);
              (measured[`${name}:native`] ??= []).push(native);
              (measured[`${name}:d1`] ??= []).push(result.meta.rows_read);
            }
          } finally { source.close(); }
        } finally { f.sqlite.close(); }
      }
      console.info('BUDGET_READ_BOUND',JSON.stringify({live,measured}));
      for(const reads of Object.values(measured))expect(reads[1]).toBe(reads[0]!);
    }
  }finally{meter.close();await mf.dispose();}
},240_000);

it('keeps the first claim after an idle day and the claim of a retried run at bounded D1 reads',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null)}}',compatibilityDate:'2026-07-01',d1Databases:['DB'], resourcePersistencePath: await schemaD1Root()}));
  const d1=await mf.getD1Database('DB');
  const reads:Record<string,Record<string,number[]>>={};
  try {
    for(const shape of ['overdue','expired','retried'] as const)for(const size of [1,100,1000]) {
      const f=await budgetFixture();
      try {
        await f.setting(10_000);
        await settingsWriter(f.db).setLeaf('agent.limits.task_concurrent_runs',null,'mem_worker',f.now);
        const candidate=f.queue('candidate');
        if(shape==='retried')for(let i=0;i<size;i++)f.sqlite.run(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,estimate_usd,cost_usd,cost_source)
          VALUES('proj_1','candidate',?,?,?,0.1,0.01,'actual')`,[`retry-${i}`,f.workerTokenId,f.now-i]);
        // A busy day of settled spend whose claims all left the window during an idle day.
        else for(let i=0;i<size;i++)f.history(`busy-${i}`,0.10,'automatic',f.now-BUDGET_WINDOW_MS-10);
        const snapshot=f.sqlite.serialize();
        const statements:MeterStatement[]=[];
        const db:RelationalStore={...f.db,batch:async(batch:PreparedStatement[])=>{statements.push(...batch as unknown as MeterStatement[]);return f.db.batch(batch);}};
        if(shape==='expired')while((await expireSpend(f.db,f.now)).more);
        await claimQueuedRun({...f.serverEnv,db},candidate,{worker:f.principal,leaseExpiresAt:f.now+60_000,harness:'codex',profile:PROFILE,now:f.now});
        const claim=statements.find(entry=>/^UPDATE agent_runs\s+SET status = 'running'/.test(entry.sql));
        const mint=statements.find(entry=>entry.sql.includes('INSERT INTO member_credentials'));
        if(claim===undefined)throw new Error('No actual claim statement captured');
        const source=Database.deserialize(snapshot);
        try {
          await copyToD1(source,d1);
          if(shape==='expired')while((await expireSpend(d1 as unknown as RelationalStore,f.now)).more);
          for(const [name,entry] of [['mint',mint],['claim',claim]] as const) {
            if(entry===undefined)continue;
            const result=await d1.prepare(entry.sql).bind(...entry.params).all();
            ((reads[shape] ??= {})[name] ??= []).push(result.meta.rows_read);
          }
        } finally { source.close(); }
      } finally { f.sqlite.close(); }
    }
    console.info('BUDGET_IDLE_RETRY_D1_READS',JSON.stringify(reads));
    // Retired history and a run's earlier attempts cost nothing at claim time.
    for(const shape of ['expired','retried'] as const)for(const series of Object.values(reads[shape]!))expect(new Set(series).size).toBe(1);
    // An overdue backlog is read at most one page deep; past that admission waits for the expiry job.
    for(const series of Object.values(reads.overdue!)) {
      expect(series[2]).toBe(series[1]);
      expect(series[2]!-series[0]!).toBeLessThanOrEqual(2*(SPEND_DUE_READ_LIMIT+1));
    }
  }finally{await mf.dispose();}
},240_000);

it('seeks only new settlements after warmup with a rare key at one thousand and five thousand attempts on both stores',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null)}}',compatibilityDate:'2026-07-01',d1Databases:['DB'], resourcePersistencePath: await schemaD1Root()}));
  const d1=await mf.getD1Database('DB');
  const incremental:number[]=[];
  try {
    for(const count of [1000,5000]) {
      const f=await budgetFixture();
      try {
        for(let i=0;i<count;i++)f.history(`point-${i}`,0.2,'automatic',f.now+i);
        f.history('rare',0.5,'automatic',f.now+count,0.1,'canopy-map');
        f.history('late',null,'automatic',f.now);
        await copyToD1(f.sqlite,d1);
        for(const target of ['native','d1']) {
          if(target==='d1') {
            await d1.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('budget_enabled_at',?)").bind(String(f.now)).run();
            await d1.prepare("DELETE FROM schema_meta WHERE key LIKE 'budget.estimate%'").run();
          }
          const store:RelationalStore=target==='native'?f.db:d1;
          const measured=target==='d1'?measuredStore(d1):null;
          const db=measured?.db??store;
          const cycle=async(now:number)=>{
            let passes=0;do {if(++passes>200)throw new Error('Estimator fixture exceeded its initial rebuild bound');}while((await refreshEstimates(db,now)).more);
            return passes;
          };
          await cycle(f.now+3_600_000);
          expect(await cycle(f.now+7_200_000)).toBe(1);
          await store.prepare("UPDATE agent_run_attempts SET cost_usd=0.4,cost_source='actual' WHERE attempt_id='late'").run();
          measured?.reset();
          expect(await cycle(f.now+10_800_000)).toBe(1);
          if(measured!==null){incremental.push(measured.reads());console.info('ESTIMATOR_INCREMENTAL_BOUND',JSON.stringify({count,d1:measured.reads()}));}
          expect(await estimateForClaim(store,'proj_1','title-summary','codex',PROFILE)).toMatchObject({estimate:expect.closeTo(0.204,6),});
          expect(await estimateForClaim(store,'proj_1','canopy-map','codex',PROFILE)).toMatchObject({estimate:0.5});
        }
      }finally{f.sqlite.close();}
    }
    // The settlement after warmup costs the same at five thousand attempts as at one thousand.
    expect(incremental[1]!).toBeLessThanOrEqual(incremental[0]!);
  }finally{await mf.dispose();}
},240_000);

it('seeks fresh card and learning work without visiting active, backed-off or disabled historical sessions', async () => {
  const f = await budgetFixture();
  const meter = sqliteBudgetMeter();
  const { LEARNING_STAGES } = await import('@myco-server-worker/core/learning-stages.js');
  const DAY = 86_400_000;
  const now = Math.floor(f.now / DAY) * DAY + 5 * 60_000;
  try {
    await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled', true, 'mem_worker', f.now);
    const session = f.sqlite.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at)
      VALUES('proj_1',?,'fake','fake',1,?,?)`);
    const progress = f.sqlite.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at,pending_cards,due_cards,eligible_at,card_retry_at)
      VALUES('proj_1',?,'ready',?,?,?,?,?)`);
    session.run('previous-day-card', now, now);
    progress.run('previous-day-card', now - 3_600_000, 1, 0, null, 0);
    f.sqlite.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,due_at) VALUES('proj_1','previous-day-card','turn',1,?)`).run(now);
    session.run('future-learning', now, now);
    progress.run('future-learning', now + 2 * DAY, 0, 1, now, 0);
    const stages = LEARNING_STAGES.slice(0, 2);
    const { advanceLearningDeadlines } = await import('@myco-server-worker/db/learning/ready.js');
    const drain = async () => { while ((await advanceLearningDeadlines(f.db, now, { page: 500, age: true })).more); };
    await drain();
    const reads = async (expected = 1) => Promise.all(stages.map(async stage => {
      const due = stage.due("'proj_1'", now);
      expect(await f.db.prepare(`SELECT ${due.sql} AS due`).bind(...due.params).first()).toEqual({ due: expected });
      return meter.reads(f.sqlite, { sql: `SELECT ${due.sql}`, params: due.params });
    }));
    const before = await reads();
    const contact = async () => { f.sqlite.exec("UPDATE sessions SET ended_at=NULL,last_received_at=" + now + " WHERE project_id='proj_1' AND session_id IN ('previous-day-card','future-learning')"); await drain(); };
    await contact();
    const idleBefore = await reads(0);
    f.sqlite.prepare("UPDATE sessions SET ended_at=? WHERE project_id='proj_1' AND session_id IN ('previous-day-card','future-learning')").run(now);
    await drain();
    f.sqlite.transaction(() => {
      for (let n = 0; n < 1900; n++) {
        for (const kind of ['active', 'backoff', 'history']) {
          for (const cards of [true, false]) {
            const id = `${kind}-${cards}-${n}`;
            const old = kind === 'history';
            session.run(id, old ? now - 30 * DAY : now, kind === 'active' ? null : now);
            progress.run(id, old ? now - 30 * DAY : now, cards ? 1 : 0, cards ? 0 : 1,
              cards ? null : kind === 'backoff' ? now + DAY : now, kind === 'backoff' ? now + DAY : 0);
          }
        }
      }
    })();
    await drain();
    expect(await reads()).toEqual(before);
    expect((await stages[0]!.head(f.db, 'proj_1', now))?.key).toBe('previous-day-card');
    expect((await stages[1]!.head(f.db, 'proj_1', now))?.key).toBe('future-learning');
    await contact();
    expect(await reads(0)).toEqual(idleBefore);
  } finally { meter.close(); f.sqlite.close(); }
});

it('stops card and learning heads at the first source-ordered ready row as the ready backlog grows', async () => {
  const f = await budgetFixture();
  const meter = sqliteBudgetMeter();
  const { LEARNING_STAGES } = await import('@myco-server-worker/core/learning-stages.js');
  try {
    await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled', true, 'mem_worker', f.now);
    await settingsWriter(f.db).setLeaf('agent.learning_history_enabled', true, 'mem_worker', f.now);
    const session = f.sqlite.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at)
      VALUES('proj_1',?,'fake','fake',1,?,?)`);
    const progress = f.sqlite.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at,pending_cards,due_cards,eligible_at)
      VALUES('proj_1',?,'ready',?,1,1,?)`);
    const card = f.sqlite.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,due_at) VALUES('proj_1',?,'turn',1,?)`);
    let measured = 0;
    const statements = new WeakMap<object, { real: ReturnType<RelationalStore['prepare']>; sql: string; params: unknown[] }>();
    const measuredDb = { ...f.db, prepare(sql: string) {
      const statement = f.db.prepare(sql);
      return { ...statement, bind(...params: unknown[]) {
        const bound = statement.bind(...params as never[]);
        const wrapped = { ...bound };
        statements.set(wrapped, { real: bound, sql, params });
        return wrapped;
      } } as ReturnType<RelationalStore['prepare']>;
    }, async batch(batched: ReturnType<RelationalStore['prepare']>[]) {
      const held = batched.map(statement => statements.get(statement)!);
      measured = held.reduce((total, { sql, params }) => total + meter.reads(f.sqlite, { sql, params }), 0);
      return f.db.batch(held.map(({ real }) => real));
    } } as unknown as RelationalStore;
    const { advanceLearningDeadlines } = await import('@myco-server-worker/db/learning/ready.js');
    const samples: unknown[] = [];
    for (const fresh of [true, false]) {
      f.sqlite.exec('DELETE FROM learning_sessions; DELETE FROM turn_cards; DELETE FROM sessions');
      let previous = 0;
      let baseline: number[] | undefined;
      for (const size of [1, 100, 1900]) {
        f.sqlite.transaction(() => {
          for (let n = previous; n < size; n++) {
            const id = `ready-${String(n).padStart(4, '0')}`;
            const source = f.now - (fresh ? 0 : 30 * 86_400_000) - n;
            session.run(id, source, source); card.run(id, f.now); progress.run(id, source, f.now);
          }
        })();
        while ((await advanceLearningDeadlines(f.db, f.now, { page: 500, age: true })).more);
        const reads: number[] = [];
        for (const stage of LEARNING_STAGES.slice(fresh ? 0 : 2, fresh ? 2 : 4)) {
          expect((await stage.head(measuredDb, 'proj_1', f.now))?.key).toBe('ready-0000');
          reads.push(measured);
        }
        baseline ??= reads;
        expect(reads).toEqual(baseline);
        samples.push({ fresh, size, reads }); previous = size;
      }
    }
    console.info('ready head read bounds', { samples });
  } finally { meter.close(); f.sqlite.close(); }
});
