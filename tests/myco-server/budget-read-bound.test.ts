import {refreshEstimates,estimateForClaim} from '@myco-server-worker/core/budget-estimates.js';
import {settingsWriter} from '@myco-server-worker/core/settings.js';
import {expect,it} from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import {budgetFixture,PROFILE} from './helpers/budget-fixture.js';
import {sqliteBudgetMeter,type MeterStatement} from './helpers/budget-meter.js';
import {SCHEMA_STEPS} from '@myco-server-worker/db/schema.js';
import {completeBudgetMigration} from '@myco-server-worker/db/budget-activation.js';
import {spendRowsSql} from '@myco-server-worker/core/run-budget.js';
import {readBudgetStatus} from '@myco-server-worker/read/budget.js';
import {BUDGET_WINDOW_MS,BUDGET_WORKER_TASKS} from '@myco-server-worker/core/budget-policy.js';
import {LIVE_RUN_STATUSES} from '@myco-server-worker/db/run-statuses.js';
import {claimQueuedRun,workerClaimAdmission,NO_LIMITS} from '@myco-server-worker/core/runs.js';
import {mintInsert,NO_RUNTIME_CLAIMS} from '@myco-server-worker/auth/tokens.js';
import type {RelationalStore,PreparedStatement} from '@myco-server-worker/core/adapters.js';

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

it('keeps actual mint, claim and status reads independent of old history with linear per-identity work',async()=>{
  const meter=sqliteBudgetMeter();
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null)}}',compatibilityDate:'2026-07-01',d1Databases:['DB']}));
  const d1=await mf.getD1Database('DB');
  for(const step of SCHEMA_STEPS)await d1.batch(step.statements.map(sql=>d1.prepare(sql)));
  const statuses=(LIVE_RUN_STATUSES.match(/'[^']+'/g) ?? []).length;
  const seeks=BUDGET_WORKER_TASKS.length*statuses;
  // Each live index visit has one canonical attempt PK probe.
  const LIVE_READS=2;
  let seekReads:number|undefined;
  try {
    for(const recent of [1,100,1000])for(const live of [0,1,20]) {
      const f=await budgetFixture();
      try {
        await f.setting(10_000);
        await settingsWriter(f.db).setLeaf('agent.limits.task_concurrent_runs',null,'mem_worker',f.now);
        for(let i=0;i<recent;i++)f.history(`history-${i}`,0.10);
        for(let i=0;i<live;i++) {
          f.history(`live-${i}`,null,'automatic',f.now-BUDGET_WINDOW_MS-1000,0.10);
          f.sqlite.run('UPDATE agent_runs SET status=? WHERE id=?',['running',`live-${i}`]);
        }
        const candidate=f.queue('candidate');
        const budget={active:true,estimate:0.10,profileJson:JSON.stringify({harness:'codex',profile:PROFILE})};
        const admission={limits:NO_LIMITS,now:f.now,budget};
        const snapshot=f.sqlite.serialize();
        const statements:MeterStatement[]=[];
        const db:RelationalStore={...f.db,batch:async(batch:PreparedStatement[])=>{
          statements.push(...batch as unknown as MeterStatement[]);
          return f.db.batch(batch);
        }};
        await claimQueuedRun({...f.serverEnv,db},candidate,{worker:f.principal,leaseExpiresAt:f.now+60_000,harness:'codex',profile:PROFILE,now:f.now});
        const claim=statements.find(entry=>/^UPDATE agent_runs\s+SET status = 'running'/.test(entry.sql));
        if(claim===undefined)throw new Error('No actual claim statement captured');
        const statusStatements:MeterStatement[]=[];
        const observe=(one:PreparedStatement):PreparedStatement=>({...one,bind:(...values)=>observe(one.bind(...values)),all:async<T,>()=>{
          statusStatements.push(one as unknown as MeterStatement);return one.all<T>();
        }});
        await readBudgetStatus({...f.db,prepare:sql=>observe(f.db.prepare(sql))},f.now);
        const status=statusStatements.find(entry=>entry.sql.startsWith('SELECT * FROM (')&&entry.sql.includes('idx_attempts_claimed'));
        if(status===undefined)throw new Error('No actual status accounting statement captured');
        const mintStatement=statements.find(entry=>entry.sql.includes('INSERT INTO member_credentials'));
        if(mintStatement===undefined)throw new Error('No actual credential mint statement captured');
        const inputs={mint:mintStatement,claim,status};
        const measurements:Record<string,{native:number;d1:number}[]>={mint:[],claim:[],status:[]};
        for(const old of [false,true]) {
          const source=Database.deserialize(snapshot);
          try {
            if(old) {
              for(let i=0;i<1001;i++)source.query(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,estimate_usd) VALUES('proj_1','history-0',?,'fixture',?,0.10)`).run(`old-attempt-${i}`,f.now-BUDGET_WINDOW_MS-1000);
              for(let i=0;i<1000;i++)source.query(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,origin) VALUES('proj_1',?,'myco-agent','title-summary','completed',?,'automatic')`).run(`old-run-${i}`,f.now-BUDGET_WINDOW_MS-2000);
              for(let i=0;i<1000;i++)source.query(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,origin) VALUES('proj_1',?,'myco-agent','embedding-reconcile','completed',?,'automatic')`).run(`embedding-${i}`,f.now);
            }
            {
              await copyToD1(source,d1);
              if(seekReads===undefined) {
                const empty=await d1.prepare(`SELECT SUM(value) FROM (${spendRowsSql('?')})`).bind(Number.MAX_SAFE_INTEGER).all();
                // Remove live rows for the empty-seek calibration; this first point has zero live rows.
                seekReads=Math.ceil(empty.meta.rows_read/seeks);
                expect(seekReads).toBeGreaterThan(0);
              }
              const limit=2*recent+LIVE_READS*live+seeks*seekReads;
              for(const [name,entry] of Object.entries(inputs)) {
                const plan=(await d1.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).bind(...entry.params).all<{detail:string}>()).results.map(row=>row.detail).join('\n');
                expect(plan).toContain('idx_attempts_claimed (claimed_at>?)');
                expect(plan).toContain('idx_agent_runs_task_live');
                expect(plan).not.toMatch(/SCAN (?:a\b|r\b|agent_run_attempts|agent_runs)|TEMP B-TREE/);
                const native=meter.reads(source,entry);
                const result=await d1.prepare(entry.sql).bind(...entry.params).all();
                if(native>limit||result.meta.rows_read>limit)console.info('BUDGET_BOUND_VIOLATION',JSON.stringify({recent,live,old,name,native,d1:result.meta.rows_read,limit}));
                expect(native).toBeLessThanOrEqual(limit);
                expect(result.meta.rows_read).toBeLessThanOrEqual(limit);
                measurements[name]!.push({native,d1:result.meta.rows_read});
                if(name==='mint')source.query(entry.sql).run(...entry.params as never[]);
                // Subsequent statements read the same accounting identities as their production batch.
                if(name==='claim')await d1.prepare("UPDATE agent_runs SET status='queued',dispatched_by=NULL,leased_by=NULL,lease_expires_at=NULL WHERE id='candidate'").run();
              }
              console.info('BUDGET_READ_BOUND',JSON.stringify({recent,live,old,logical:recent+live,liveReads:LIVE_READS,seekReads,seeks,limit,measurements}));
            }
          }finally{source.close();}
        }
        for(const results of Object.values(measurements))expect(results[1]).toEqual(results[0]);
      }finally{f.sqlite.close();}
    }
  }finally{meter.close();await mf.dispose();}
},240_000);


it('seeks only new settlements after warmup with a rare key at one thousand and five thousand attempts on both stores',async()=>{
  const meter=sqliteBudgetMeter();
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null)}}',compatibilityDate:'2026-07-01',d1Databases:['DB']}));
  const d1=await mf.getD1Database('DB');
  for(const step of SCHEMA_STEPS)await d1.batch(step.statements.map(sql=>d1.prepare(sql)));
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
          const statements:MeterStatement[]=[];
          const raw=new WeakMap<PreparedStatement,PreparedStatement>();
          const observe=(one:PreparedStatement,sql:string,params:unknown[]=[]):PreparedStatement=>{
            const wrapped:PreparedStatement={bind:(...values)=>observe(one.bind(...values),sql,values),first:<T,>()=>one.first<T>(),run:()=>one.run(),all:async<T,>()=>{
              if(sql.startsWith('SELECT a.'))statements.push({sql,params});
              return one.all<T>();
            }};
            raw.set(wrapped,one);return wrapped;
          };
          const db={prepare:(sql:string)=>observe(store.prepare(sql),sql),batch:(statements:PreparedStatement[])=>store.batch(statements.map(statement=>raw.get(statement)??statement))};
          const cycle=async(now:number)=>{
            let passes=0;do {if(++passes>200)throw new Error('Estimator fixture exceeded its initial rebuild bound');}while((await refreshEstimates(db,now)).more);
            return passes;
          };
          await cycle(f.now+3_600_000);
          expect(await cycle(f.now+7_200_000)).toBe(1);
          await store.prepare("UPDATE agent_run_attempts SET cost_usd=0.4,cost_source='actual' WHERE attempt_id='late'").run();
          statements.length=0;
          expect(await cycle(f.now+10_800_000)).toBe(1);
          expect(await estimateForClaim(store,'proj_1','title-summary','codex',PROFILE)).toMatchObject({estimate:expect.closeTo(0.204,6),});
          expect(await estimateForClaim(store,'proj_1','canopy-map','codex',PROFILE)).toMatchObject({estimate:0.5});
          const page=statements[0]!;
          expect((await store.prepare(page.sql).bind(...page.params).all()).results).toHaveLength(1);
          const plan=(await store.prepare(`EXPLAIN QUERY PLAN ${page.sql}`).bind(...page.params).all<{detail:string}>()).results.map(row=>row.detail).join(' / ');
          expect(plan).toContain('idx_attempts_settled (settled_seq>? AND settled_seq<?)');
          expect(plan).not.toMatch(/SCAN a|TEMP B-TREE/);
          const native=meter.reads(f.sqlite,page);
          const remote=await d1.prepare(page.sql).bind(...page.params).all();
          expect(native).toBeLessThanOrEqual(2);
          expect(remote.meta.rows_read).toBeLessThanOrEqual(2);
          console.info('ESTIMATOR_INCREMENTAL_BOUND',JSON.stringify({target,count,native,d1:remote.meta.rows_read,plan}));
        }
      }finally{f.sqlite.close();}
    }
  }finally{meter.close();await mf.dispose();}
},240_000);
