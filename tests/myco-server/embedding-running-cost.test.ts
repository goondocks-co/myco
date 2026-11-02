import { rereadTranscripts } from '@myco-server-worker/ingest/parse.js';
import { insertSwitch,pauseSwitch,resumeSwitch,deleteSwitch } from '@myco-server-worker/core/embedding/switch-store.js';
import { recordedWork } from '@myco-server-worker/core/embedding/work-state.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { embeddingProviderReady,embeddingProviderRevision,recordEmbeddingProviderFailure } from '@myco-server-worker/core/embedding/provider-state.js';
import { runEmbeddingJob, embeddingSweepPending } from '@myco-server-worker/core/embedding/jobs.js';
import { expect, test } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { hasEmbeddingWork } from '@myco-server-worker/core/embedding/work.js';
import { reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';
import { EmbeddingUnavailable } from '@myco-server-worker/core/embedding/provider.js';
import { memoryBlobStore, sqliteEnv } from './helpers/fixtures.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { indexFixture } from './helpers/vector-index.js';
import { measuredStore } from './helpers/read-budget.js';
import { vectorId } from '@myco-server-worker/core/embedding/vectors.js';
import { reconcileHubness, calibrationPending } from '@myco-server-worker/core/embedding/hubness.js';
import { readDocumentStatus, pendingPublication } from '@myco-server-worker/read/document-status.js';

const NOW = 10 ** 12;
const MODEL = 'm';

async function world(run: (measured: ReturnType<typeof measuredStore>) => Promise<void>, beforeFacts?: (db: RelationalStore) => Promise<void>) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) {
      if (step.version === 467 && beforeFacts !== undefined) {
        await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
        await beforeFacts(measuredStore(d1).db);
      }
      await d1.batch(step.statements.map((sql) => d1.prepare(sql)));
    }
    await d1.prepare("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
    await run(measuredStore(d1));
  } finally { await mf.dispose(); }
}

async function documents(db: RelationalStore, size: number) {
  await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
    INSERT OR IGNORE INTO session_documents(project_id,session_id,state,generation,due_at,updated_at,build)
    SELECT 'p',printf('s-%06d',x),'live',1,0,1,'{"report":{"classes":{"body_missing":1}}}' FROM n`).bind(size).run();
  await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
    INSERT OR IGNORE INTO transcripts(project_id,transcript_id,session_id,machine_id,size,first_received_at,last_received_at,token_id,imported_at)
    SELECT 'p',printf('t-%06d',x),printf('s-%06d',x),'machine',100,1,1,'token',CASE WHEN x%2=0 THEN 1 END FROM n`).bind(size).run();
}

async function plans(db: RelationalStore, size: number) {
  await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT OR IGNORE INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
    SELECT 'p',printf('plan-%06d',x),'session','event','machine','body','hash','active',1,1,'token',1 FROM n`).bind(size).run();
}

async function readyPlans(db: RelationalStore) {
  const rows = (await db.prepare("SELECT type,record_id,revision FROM embedding_versions WHERE project_id='p'").all<{ type: 'plan'; record_id: string; revision: string }>()).results;
  const ids = await Promise.all(rows.map(async row => [await vectorId({projectId:'p',modelKey:MODEL},row.type,row.record_id,row.revision),row.type,row.record_id,row.revision]));
  await db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
    SELECT 'p','m',json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),1,1 FROM json_each(?)`).bind(JSON.stringify(ids)).run();
}

const context = (db: RelationalStore, embed = async (_text: string) => [1, 0]) => ({
  db, blobs: memoryBlobStore(), vectors: cloudflareVectorStore(indexFixture()), provider: { modelKey: MODEL, embed },
});

test('positive work facts survive repeated admission until source invalidation', async () => {
  await world(async (m) => {
    for (const size of [1_000, 4_000]) {
      await plans(m.db, size);
      await m.db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
        SELECT project_id,'m',record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE record_id < printf('plan-%06d',?)`).bind(size).run();
      expect(await hasEmbeddingWork(m.db, 'p', MODEL, NOW)).toBe(true);
      m.reset();
      for (let i = 1; i <= 3; i++) expect(await hasEmbeddingWork(m.db, 'p', MODEL, NOW + i)).toBe(true);
      console.info(`positive admission ${size}: ${m.reads() / 3} rows/check, ${m.writes() / 3} writes/check`);
      expect(m.reads()).toBeLessThanOrEqual(12);
      expect(m.writes()).toBe(0);
      await m.db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
        SELECT project_id,'m',record_id,type,record_id,revision,1,1 FROM embedding_versions`).run();
      expect(await hasEmbeddingWork(m.db, 'p', MODEL, NOW + 4)).toBe(false);
    }
  });
});

test('selection seeks a late pending source without rereading completed sources', async () => {
  await world(async (m) => {
    for (const size of [1_000, 4_000]) {
      await plans(m.db, size);
      await readyPlans(m.db);
      const c = context(m.db);
      for (let warm = 0; warm < 20; warm++) await reconcileEmbedding(c, 'p', NOW);
      await plans(m.db, size + 1);
      m.reset();
      expect((await reconcileEmbedding(c, 'p', NOW + 1)).processed).toBe(1);
      console.info(`late selection ${size}: ${m.reads()} rows/step, ${m.writes()} writes/step`);
      expect(m.reads()).toBeLessThan(600);
      expect(await m.db.prepare(`SELECT 1 FROM embedding_receipts WHERE project_id='p' AND model_key='m' AND record_id=printf('plan-%06d',?) AND ready=1`).bind(size + 1).first()).not.toBeNull();
      await m.db.prepare("UPDATE plans SET content=content||' revised' WHERE plan_key= 'plan-000001'").run();
      expect((await reconcileEmbedding(c, 'p', NOW + 2)).processed).toBe(1);
      const other = {...c,provider:{...c.provider,modelKey:'other'}};
      await reconcileEmbedding(other,'p',NOW+3);
      await m.db.prepare("UPDATE plans SET content=content||' again' WHERE plan_key='plan-000001'").run();
      expect((await reconcileEmbedding(c,'p',NOW+4)).processed).toBe(1);
      expect(await m.db.prepare(`SELECT 1 FROM embedding_receipts r JOIN embedding_versions v ON v.project_id=r.project_id
        AND v.type=r.type AND v.record_id=r.record_id AND v.revision=r.revision WHERE r.model_key='m' AND r.record_id='plan-000001' AND r.ready=1`).first()).not.toBeNull();
    }
  });
});

test('hubness pages retain population evidence and invalidate it on a source change', async () => {
  await world(async (m) => {
    await m.db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('a','a','built-in',1,1)").run();
    for (const size of [1_000,4_000]) {
      await m.db.prepare("UPDATE spores SET status='active' WHERE status<>'active'").run();
      await m.db.prepare('DELETE FROM embedding_hubness_members').run();
      await m.db.prepare('DELETE FROM embedding_cursors').run();
      await m.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
        INSERT OR IGNORE INTO spores(project_id,id,agent_id,content,observation_type,created_at)
        SELECT 'p',printf('spore-%06d',x),'a','body','decision',1 FROM n`).bind(size).run();
      await m.db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
        SELECT project_id,'m',record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE 1
        ON CONFLICT(project_id,model_key,id) DO UPDATE SET revision=excluded.revision`).run();
      await m.db.prepare(`INSERT INTO embedding_hubness_members(project_id,model_key,id,state,n,vector)
        SELECT project_id,model_key,id,CASE WHEN id=printf('spore-%06d',?) THEN 1 ELSE 0 END,
          CASE WHEN id=printf('spore-%06d',?) THEN 0 ELSE ?-2 END,'AACAPw==' FROM embedding_receipts WHERE model_key='m'`).bind(size,size,size).run();
      const c = context(m.db);
      expect(await calibrationPending(m.db,'p',MODEL,NOW)).toBe(true);
      await reconcileHubness(c,'p',NOW);
      m.reset();
      expect(await calibrationPending(m.db,'p',MODEL,NOW+1)).toBe(true);
      expect((await reconcileHubness(c,'p',NOW+1)).phase).toBe('hubness');
      console.info(`hubness page ${size}: ${m.reads()} rows/page, ${m.writes()} writes/page`);
      expect(m.reads()).toBeLessThan(4_500);
      await m.db.prepare("UPDATE spores SET status='obsolete' WHERE id='spore-000001'").run();
      await reconcileHubness(c,'p',NOW+2);
      expect((await m.db.prepare("SELECT neighbor_mean FROM embedding_receipts WHERE id='spore-000101'").first<{neighbor_mean:number|null}>())?.neighbor_mean).toBeNull();
    }
  });
});

test('document facts and drain telemetry stay bounded and reflect committed catalog changes', async () => {
  await world(async (m) => {
    for (const size of [1_000,4_000]) {
      await m.db.prepare('DELETE FROM transcript_publication').run();
      await documents(m.db,size);
      await m.db.prepare("UPDATE session_documents SET due_at=0,generation=1,build='{\"report\":{\"classes\":{\"body_missing\":1}}}'").run();
      m.reset();
      const status = await readDocumentStatus(m.db);
      expect(status.sessions.live).toBe(size);
      expect(status.lagBytes).toBe(size*100);
      expect(status.differences).toEqual({body_missing:size});
      console.info(`document status ${size}: ${m.reads()} rows/poll`);
      expect(m.reads()).toBeLessThan(32);
      m.reset();
      const pending = await pendingPublication(m.db,NOW);
      console.info(`publication telemetry ${size}: ${m.reads()} rows/wake, ${pending.sessions} sessions`);
      expect(m.reads()).toBeLessThan(1_000);
      expect(pending).toEqual({sessions:128,transcripts:128,bytes:12_800,imported:{sessions:64,transcripts:64,bytes:6_400},limited:true});
      await m.db.prepare("UPDATE session_documents SET due_at=?,build=NULL WHERE project_id='p' AND session_id='s-000001'").bind(NOW+1).run();
      expect((await pendingPublication(m.db,NOW)).sessions).toBe(128);
      expect((await pendingPublication(m.db,NOW+1)).sessions).toBe(128);
      expect((await readDocumentStatus(m.db)).differences).toEqual({body_missing:size-1});
      await m.db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,session_id,generation,published_offset,record_scheme,parser_version,updated_at)
        VALUES('p','t-000001','s-000001',1,40,'scheme',1,1)`).run();
      expect((await readDocumentStatus(m.db)).lagBytes).toBe(size*100-40);
      expect((await pendingPublication(m.db,NOW+1)).bytes).toBe(12_800);
      await m.db.prepare("UPDATE session_documents SET generation=2 WHERE project_id='p' AND session_id='s-000001'").run();
      expect((await readDocumentStatus(m.db)).lagBytes).toBe(size*100);
      const before = await readDocumentStatus(m.db);
      await expect(m.db.batch([
        m.db.prepare("DELETE FROM session_documents WHERE project_id='p' AND session_id='s-000001'"),
        m.db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','duplicate',1)"),
      ])).rejects.toThrow();
      expect(await readDocumentStatus(m.db)).toEqual(before);
      await m.db.prepare("DELETE FROM session_documents WHERE session_id='s-000002'").run();
      expect((await readDocumentStatus(m.db)).sessions.live).toBe(size-1);
      await m.db.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,due_at,updated_at,build)
        VALUES('p','s-000002','live',1,0,1,'{"report":{"classes":{"body_missing":1}}}')`).run();
    }
  },db=>documents(db,1_000));
});

test('current provider quota holds admission and calls until its persisted deadline', async () => {
  for (const size of [1_000,4_000]) await world(async (m) => {
    await plans(m.db,size);
    await readyPlans(m.db);
    const warm = context(m.db);
    for (let i=0;i<32;i++) await reconcileEmbedding(warm,'p',NOW);
    await m.db.prepare("DELETE FROM embedding_receipts WHERE record_id=printf('plan-%06d',?)").bind(size).run();
    let calls = 0;
    const until = NOW + 86_400_000;
    const c = context(m.db, async () => { calls++; throw new EmbeddingUnavailable('quota', { kind: 'quota', resetsAt: until, detail: 'quota' }); });
    await expect(reconcileEmbedding(c, 'p', NOW)).rejects.toThrow('quota');
    expect(await hasEmbeddingWork(m.db,'p',MODEL,NOW+1)).toBe(false);
    m.reset();
    for (const at of [NOW + 60_000, NOW + 120_000]) {
      const admitted = await hasEmbeddingWork(m.db,'p',MODEL,at);
      if (admitted) await reconcileEmbedding(c,'p',at);
      expect(admitted).toBe(false);
    }
    console.info(`provider hold ${size}: ${m.reads() / 2} rows/wake, ${m.writes() / 2} writes/wake, ${calls} calls`);
    expect(calls).toBe(1);
    expect(m.reads() / 2).toBeLessThan(100);
    const fixture = sqliteEnv();
    try {
      const env = {...fixture.serverEnv,db:m.db,origin:'http://local.invalid',vectors:c.vectors,embeddingProvider:async()=>c.provider,
        harnessLaunch:async()=>{throw new Error('held provider dispatched');}};
      expect(await embeddingSweepPending(env,NOW+120_000)).toBe(true);
      expect(await runEmbeddingJob(env,NOW+120_000,{allowDispatch:false})).toEqual({changed:0,more:true,continueAfterMs:until-NOW-120_000});
    } finally { fixture.sqlite.close(); }
    await reconcileEmbedding(c,'p',NOW+120_000);
    expect(calls).toBe(1);
    expect(await m.db.prepare('SELECT 1 FROM embedding_source_failures').first()).toBeNull();
    await expect(reconcileEmbedding(c, 'p', until)).rejects.toThrow('quota');
    expect(calls).toBe(2);
    await m.db.prepare("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('embedding.model','\"changed\"',?,'operator')").bind(NOW).run();
    await expect(reconcileEmbedding(c,'p',NOW+180_000)).rejects.toThrow('quota');
    expect(calls).toBe(3);
  });
});

test('expired work deadlines are acknowledged once while a positive backlog stays cached', async () => {
  const f = sqliteEnv();
  try {
    const db = f.db;
    let probes = 0;
    const check = (at:number) => recordedWork(db,'proj_1',MODEL,'embedding','expiry',at,async()=>{
      probes++;
      return probes===1 ? {pending:false,wakeAt:NOW+1} : {pending:true};
    },async()=>{throw new Error('unexpected safety sweep');});
    expect(await check(NOW)).toBe(false);
    expect(await check(NOW+2)).toBe(true);
    for(let i=3;i<10;i++) expect(await check(NOW+i)).toBe(true);
    expect(probes).toBe(2);
  } finally {f.sqlite.close();}
});

test('current providers recover from pause-class and malformed responses without a configuration change', async () => {
  for(const failure of [
    ...[401,402,404].map(status=>new EmbeddingUnavailable('provider refused',{kind:'http' as const,status,retryAfterMs:null,detail:'refused'})),
    new Error('invalid vector response'),
  ]) {
    const f = sqliteEnv();
    try {
      await f.db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
      await plans(f.db,1);
      let calls=0;
      const c=context(f.db,async()=>{if(++calls===1) throw failure;return [1,0];});
      await expect(reconcileEmbedding(c,'p',NOW)).rejects.toThrow();
      const held=await f.db.prepare('SELECT retry_at FROM embedding_provider_holds').first<{retry_at:number}>();
      expect(held!.retry_at).toBeGreaterThan(NOW);
      expect(held!.retry_at).toBeLessThanOrEqual(NOW+60*60_000);
      if(!(failure instanceof EmbeddingUnavailable)) expect(held!.retry_at).toBeLessThanOrEqual(NOW+60_000);
      await reconcileEmbedding(c,'p',held!.retry_at-1);
      expect(calls).toBe(1);
      expect((await reconcileEmbedding(c,'p',held!.retry_at)).processed).toBe(1);
      expect(calls).toBe(2);
      expect(await f.db.prepare("SELECT ready FROM embedding_receipts WHERE project_id='p'").first()).toEqual({ready:1});
    } finally {f.sqlite.close();}
  }
});

test('secret changes fence in-flight failures and invalidate holds on insert, update and delete', async () => {
  const f=sqliteEnv();
  try {
    await f.db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
      await plans(f.db,1);
    const secrets=deploymentSecretStore(f.db,{material:async()=>new Uint8Array(32),version:async()=> 'test'});
    let calls=0;
    const c=context(f.db,async()=>{
      if(++calls===1) {
        await secrets.put('embedding.api_key','fake-key','operator',NOW);
        throw new EmbeddingUnavailable('old key rejected',{kind:'http',status:401,retryAfterMs:null,detail:'refused'});
      }
      return [1,0];
    });
    await expect(reconcileEmbedding(c,'p',NOW)).rejects.toThrow('old key rejected');
    expect(await embeddingProviderReady(f.db,MODEL,NOW+1)).toBe(true);
    expect((await reconcileEmbedding(c,'p',NOW+1)).processed).toBe(1);
    for(const mutate of [
      ()=>secrets.put('other.fake','fake','operator',NOW),
      ()=>secrets.put('other.fake','fake-replaced','operator',NOW),
      ()=>secrets.delete('other.fake','operator',NOW),
    ]) {
      await recordEmbeddingProviderFailure(f.db,MODEL,await embeddingProviderRevision(f.db),new Error('transient'),NOW);
      expect(await embeddingProviderReady(f.db,MODEL,NOW+1)).toBe(false);
      await mutate();
      expect(await embeddingProviderReady(f.db,MODEL,NOW+1)).toBe(true);
    }
  } finally {f.sqlite.close();}
});

async function settledSpores(db:RelationalStore,size:number,joiner=false) {
  await db.prepare("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('a','a','built-in',1,1)").run();
  await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
    INSERT OR IGNORE INTO spores(project_id,id,agent_id,content,observation_type,created_at)
    SELECT 'p',printf('spore-%06d',x),'a','body','decision',1 FROM n`).bind(size).run();
  await db.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
    SELECT project_id,'m',record_id,type,record_id,revision,1,1 FROM embedding_versions`).run();
  const count=size-(joiner ? 1 : 0);
  await db.prepare(`INSERT INTO embedding_hubness_members(project_id,model_key,id,state,n,vector)
    SELECT project_id,model_key,id,0,?,'AACAPw==' FROM embedding_receipts WHERE id<=printf('spore-%06d',?)`).bind(count-1,count).run();
}

test('a calibration start whose commit acknowledgement is lost still publishes every receipt', async () => {
  const f=sqliteEnv();
  try {
    await f.db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
    await settledSpores(f.db,120,true);
    let armed=false;
    const db:RelationalStore={prepare:f.db.prepare.bind(f.db),batch:async statements=>{
      const result=await f.db.batch(statements);
      if(armed){armed=false;throw new Error('lost commit acknowledgement');}
      return result;
    }};
    const c={...context(db),vectors:{...context(db).vectors,get:async (_scope:unknown,ids:string[])=>{
      armed=true;return ids.map(id=>({id,values:[1,0]}));
    }}};
    await expect(reconcileHubness(c,'p',NOW)).rejects.toThrow('lost commit acknowledgement');
    for(let i=1;i<12;i++) await reconcileHubness(c,'p',NOW+i);
    expect(await f.db.prepare("SELECT COUNT(*) n, SUM(neighbor_mean=0) published FROM embedding_receipts WHERE model_key='m'").first()).toEqual({n:120,published:120});
    expect(await f.db.prepare("SELECT hubness_count FROM embedding_cursors WHERE project_id='p'").first()).toEqual({hubness_count:120});
    expect(await calibrationPending(f.db,'p',MODEL,NOW+20)).toBe(false);
  } finally {f.sqlite.close();}
});

test('calibration publication pages seek after a validated population snapshot', async () => {
  for(const size of [1_000,4_000]) await world(async m=>{
    await settledSpores(m.db,size);
    await m.db.prepare("INSERT INTO embedding_cursors(project_id,hubness_cursor,hubness_token) VALUES('p','','token')").run();
    const c=context(m.db);
    await reconcileHubness(c,'p',NOW);
    for(let i=1;i<=3;i++){
      m.reset();
      expect((await reconcileHubness(c,'p',NOW+i)).processed).toBe(1);
      console.info(`publication page ${size}: ${m.reads()} rows/page`);
      expect(m.reads()).toBeLessThan(4_500);
    }
    expect(await m.db.prepare("SELECT COUNT(*) n FROM embedding_receipts WHERE neighbor_mean=0").first()).toEqual({n:200});
  });
});

test('publication capture writes net changed facts and keep telemetry bounded during a bulk reread', async () => {
  await world(async m=>{
    await documents(m.db,4_000);
    await m.db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,session_id,generation,published_offset,record_scheme,parser_version,updated_at)
      SELECT project_id,transcript_id,session_id,1,0,'scheme',1,1 FROM transcripts`).run();
    await m.db.prepare(`UPDATE session_documents SET build='{"report":{"classes":{"body_missing":1,"other":2}}}'`).run();
    for(const [label,sql,maximum] of [
      ['append',"UPDATE transcripts SET size=size+100 WHERE project_id='p' AND transcript_id='t-000001'",8],
      ['offset',"UPDATE transcript_publication SET published_offset=50 WHERE project_id='p' AND transcript_id='t-000001'",3],
      ['clear',"UPDATE session_documents SET due_at=NULL WHERE project_id='p' AND session_id='s-000001'",5],
    ] as const) {
      m.reset();await m.db.prepare(sql).run();
      console.info(`capture ${label}: ${m.reads()} read / ${m.writes()} written`);
      expect(m.writes()).toBeLessThanOrEqual(maximum);
    }
    await m.db.prepare("UPDATE transcripts SET agent='test'").run();
    await m.db.prepare(`UPDATE transcript_publication AS p SET published_offset=(SELECT size FROM transcripts t
      WHERE t.project_id=p.project_id AND t.transcript_id=p.transcript_id)`).run();
    await m.db.prepare('UPDATE session_documents SET due_at=NULL').run();
    m.reset();
    expect(await rereadTranscripts(m.db,{agent:'test'})).toBe(4_000);
    console.info(`reread 4000: ${m.reads()} read / ${m.writes()} written`);
    expect(m.writes()).toBeLessThanOrEqual(8*4_000);
    expect((await readDocumentStatus(m.db)).lagBytes).toBe(400_100);
    expect((await pendingPublication(m.db,NOW)).limited).toBe(true);
  });
});


test('switch lifecycle changes fence failures from a superseded provider call', async () => {
  const f=sqliteEnv();
  try {
    const before=await embeddingProviderRevision(f.db);
    expect(await insertSwitch(f.db,{id:'switch',provider:'openai-compatible',model:'model',endpoint:'http://model.invalid',
      modelKey:MODEL,fromModelKey:'old',estimatedTokens:0,estimatedSources:0,startedAt:NOW,startedBy:'operator'},NOW)).toBe(true);
    const rejectOld=async(revision:string)=>{
      await recordEmbeddingProviderFailure(f.db,MODEL,revision,new Error('old call failed'),NOW);
      expect(await embeddingProviderReady(f.db,MODEL,NOW+1)).toBe(true);
    };
    await rejectOld(before);
    await pauseSwitch(f.db,'switch','paused',NOW);
    const paused=await embeddingProviderRevision(f.db);
    await recordEmbeddingProviderFailure(f.db,MODEL,paused,new Error('failed'),NOW);
    expect(await resumeSwitch(f.db,'switch',NOW)).toBe(true);
    await rejectOld(paused);
    const active=await embeddingProviderRevision(f.db);
    expect(await deleteSwitch(f.db,'switch')).toBe(true);
    await rejectOld(active);
  } finally {f.sqlite.close();}
});
