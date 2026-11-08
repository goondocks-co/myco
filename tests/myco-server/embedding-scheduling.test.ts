import { afterEach, describe, expect, it, test } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { indexFixture } from './helpers/vector-index.js';
import { measuredStore } from './helpers/read-budget.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { cloudflareEmbeddingProvider, EMBEDDING_MODEL } from '@myco-server-worker/platform/cloudflare/embedding.js';
import { dispatchEmbeddingWork, embeddingKeepsAwake, embeddingSweepPending, runEmbeddingJob, WORK_AUDIT_INTERVAL_MS } from '@myco-server-worker/core/embedding/jobs.js';
import { prepareEmbeddingDue, retainEmbeddingModels } from '@myco-server-worker/db/embeddings/work.js';
import { switchComplete, switchPassedOver } from '@myco-server-worker/db/embeddings/switch.js';
import { heldPartitions, writeSwitchedEmbedding } from '@myco-server-worker/core/settings.js';
import { calibrationPending } from '@myco-server-worker/core/embedding/hubness.js';
import { embeddingSwitchStatus } from '@myco-server-worker/core/embedding/switch.js';
import { readSwitch } from '@myco-server-worker/core/embedding/switch-store.js';
import { withEmbeddingStore } from './helpers/embedding-work-store.js';
import { calibrationPopulation } from '@myco-server-worker/db/embeddings/calibration.js';
import type { RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';

const MODEL = JSON.stringify(['cloudflare', EMBEDDING_MODEL]);
const NOW = 10 ** 12;
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });

const environment = (base: ServerEnv, db: RelationalStore, launched: string[] = []): ServerEnv => ({
  ...base, db, origin: 'https://myco.example', vectors: cloudflareVectorStore(indexFixture()),
  embeddingProvider: async () => cloudflareEmbeddingProvider({ run: async () => ({ data: [[1, 0]] }) }, { model: EMBEDDING_MODEL, modelKey: MODEL }),
  harnessLaunch: async (spec) => { launched.push(spec.runId); },
});

function fixture() {
  const f = sqliteEnv(); opened.push(f);
  const launched: string[] = [];
  f.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)");
  const project = (id: string) => f.sqlite.query('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').run(id, id);
  const spore = (projectId: string, id: string) => f.sqlite.query(`INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at)
    VALUES(?,?,'agent','architecture knowledge','decision',1)`).run(projectId, id);
  const plan = (projectId: string, id: string) => f.sqlite.query(`INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
    VALUES(?,?,'session','event','machine','the plan','hash','active',1,1,'token',1)`).run(projectId, id);
  /** A captured session awaiting its title: ineligible for embedding until it has a summary. */
  const untitled = (projectId: string, id: string) => f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
    VALUES(?,?,'machine','token',1,1)`).run(projectId, id);
  const built = (projectId: string) => f.sqlite.query(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
    SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id=?`).run(MODEL, projectId);
  const initialize = async (projectId: string) => { while ((await prepareEmbeddingDue(f.db, projectId, MODEL)).more); };
  return { ...f, launched, env: environment(f.serverEnv, f.db, launched), project, spore, plan, untitled, built, initialize };
}

describe('embedding scheduling', () => {
  it('lets a Deployment whose Projects hold nothing eligible sleep, and wakes for the first eligible source', async () => {
    const f = fixture();
    for (const id of ['a', 'b', 'c']) { f.project(id); for (let i = 0; i < 5; i++) f.untitled(id, `${id}-${i}`); }
    expect(await embeddingKeepsAwake(f.env, NOW)).toBe(false);
    expect(await embeddingSweepPending(f.env, NOW)).toBe(false);
    expect(await runEmbeddingJob(f.env, NOW)).toEqual({ changed: 0, more: false });
    for (let tick = 1; tick <= 3; tick++) expect(await embeddingKeepsAwake(f.env, NOW + tick * 60_000)).toBe(false);
    expect(f.launched).toEqual([]);

    f.sqlite.run("UPDATE sessions SET summary='what happened' WHERE project_id='b' AND session_id='b-2'");
    expect(await embeddingKeepsAwake(f.env, NOW + 5 * 60_000)).toBe(true);
    expect(await dispatchEmbeddingWork(f.env, NOW + 5 * 60_000)).toBe(1);
    expect(f.sqlite.query('SELECT project_id FROM agent_runs').all()).toEqual([{ project_id: 'b' }]);
  });

  it('finds work a mutation marks without a sweep, and rests once each marked Project is checked idle', async () => {
    const f = fixture();
    for (const id of ['a', 'b']) { f.project(id); f.plan(id, `${id}-1`); f.built(id); await f.initialize(id); }
    expect(await embeddingKeepsAwake(f.env, NOW)).toBe(false);
    expect(f.sqlite.query('SELECT project_id FROM embedding_work_attention').all()).toEqual([]);

    f.plan('a', 'a-2');
    expect(f.sqlite.query('SELECT project_id FROM embedding_work_attention').all()).toEqual([{ project_id: 'a' }]);
    expect(await embeddingKeepsAwake(f.env, NOW + 1_000)).toBe(true);
    expect(await dispatchEmbeddingWork(f.env, NOW + 1_000)).toBe(1);
    expect(f.sqlite.query('SELECT project_id FROM agent_runs').all()).toEqual([{ project_id: 'a' }]);

    f.built('a');
    expect(await embeddingKeepsAwake(f.env, NOW + 2_000)).toBe(false);
    expect(f.sqlite.query('SELECT project_id FROM embedding_work_attention').all()).toEqual([]);
    expect(await runEmbeddingJob(f.env, NOW + 3_000, { allowDispatch: false })).toEqual({ changed: 0, more: false });
  });

  it('finds a backlog no trigger marks, such as an unarchived Project, through its hourly audit of every Project', async () => {
    const f = fixture();
    f.project('a'); f.spore('a', 'a-1'); f.built('a'); await f.initialize('a');
    f.project('b'); f.spore('b', 'b-1');
    f.sqlite.run("UPDATE projects SET archived_at=1 WHERE project_id='b'");
    expect(await embeddingKeepsAwake(f.env, NOW)).toBe(false);
    f.sqlite.run("UPDATE projects SET archived_at=NULL WHERE project_id='b'");
    // Unarchiving writes no embedding row: the Project waits for the next audit.
    expect(await embeddingKeepsAwake(f.env, NOW + 60_000)).toBe(false);
    expect(await embeddingKeepsAwake(f.env, NOW + WORK_AUDIT_INTERVAL_MS + 1)).toBe(true);
    expect(await dispatchEmbeddingWork(f.env, NOW + WORK_AUDIT_INTERVAL_MS + 2)).toBe(1);
    expect(f.sqlite.query('SELECT project_id FROM agent_runs').all()).toEqual([{ project_id: 'b' }]);
  });

  it('serves every Project with work in turn when more Projects wait than one check reads', async () => {
    const f = fixture();
    const ids = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    for (const id of ids) { f.project(id); f.spore(id, `${id}-1`); }
    const served = new Set<string>();
    let now = NOW;
    for (let round = 0; round < 6 && served.size < ids.length; round++) {
      now += 10 * 60_000;
      await dispatchEmbeddingWork(f.env, now);
      for (const row of f.sqlite.query<{ project_id: string }, []>("SELECT project_id FROM agent_runs WHERE status IN ('pending','queued','running')").all()) served.add(row.project_id);
      f.sqlite.run("UPDATE agent_runs SET status='completed',completed_at=1 WHERE status IN ('pending','queued','running')");
    }
    // The second dispatch reads the attention page after the first one's, so a Project beyond the first page is served.
    expect([...served].some(id => id >= 'p32')).toBe(true);
    expect(served.size).toBeGreaterThan(2);
  });
});

describe('held vector partitions', () => {
  it('holds a model while any of its receipts awaits a confirmed deletion, and releases it once confirmed', async () => {
    const f = fixture();
    f.project('a'); f.spore('a', 'a-1'); f.built('a');
    f.sqlite.query(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at) VALUES('a','old-model','x','spore','a-1','r',-1,1)`).run();
    expect((await heldPartitions(f.db)).map(p => p.label).sort()).toHaveLength(2);
    f.sqlite.run("DELETE FROM embedding_receipts WHERE model_key='old-model'");
    expect(await heldPartitions(f.db)).toHaveLength(1);
  });
});

test('the idle embedding wake reads the same rows for one Project as for many', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  const f = sqliteEnv(); opened.push(f);
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map((sql) => d1.prepare(sql)));
    await d1.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
    const measured = measuredStore(d1);
    const env = environment(f.serverEnv, measured.db);
    const perTick: number[] = [];
    let count = 0;
    for (const size of [1, 120]) {
      await d1.prepare(`WITH RECURSIVE n(x) AS (SELECT ? UNION ALL SELECT x+1 FROM n WHERE x < ?)
        INSERT INTO projects(project_id,name,created_at) SELECT printf('p%04d',x),'p',1 FROM n`).bind(count + 1, size).run();
      await d1.prepare(`WITH RECURSIVE n(x) AS (SELECT ? UNION ALL SELECT x+1 FROM n WHERE x < ?)
        INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) SELECT printf('p%04d',x),'s','agent','body','decision',1 FROM n`).bind(count + 1, size).run();
      await d1.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
        SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions`).bind(MODEL).run();
      for (let x = count + 1; x <= size; x++) while ((await prepareEmbeddingDue(measured.db, `p${String(x).padStart(4, '0')}`, MODEL)).more);
      count = size;
      // New sources mark their Projects, and the audit reads every Project once, a page per wake; both then rest.
      let settled = false;
      for (let i = 0; i < 12 && !settled; i++) settled = !(await embeddingKeepsAwake(env, NOW + i)) && !(await embeddingSweepPending(env, NOW + i));
      expect(settled).toBe(true);
      measured.reset();
      for (let tick = 1; tick <= 5; tick++) {
        expect(await embeddingKeepsAwake(env, NOW + 100 + tick * 60_000)).toBe(false);
        expect(await runEmbeddingJob(env, NOW + 100 + tick * 60_000)).toEqual({ changed: 0, more: false });
      }
      perTick.push(measured.reads() / 5);
    }
    console.info(`idle embedding wake rows read per tick at 1 / 120 Projects: ${JSON.stringify(perTick)}`);
    expect(perTick[1]).toBe(perTick[0]);
  } finally { await mf.dispose(); }
}, 60_000);

const SWITCHED = JSON.stringify(['cloudflare', '@cf/baai/bge-large-en-v1.5']);
const RETRY = 86_400_000;

/** One Project `p` with `plans` current plans built and initialized under the model search uses and, while `standing`, a switch's model with the switch. */
async function switching(db: RelationalStore, plans = 1, standing = true) {
  await db.prepare("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
  for (let i = 0; i < plans; i++) await db.prepare(`INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
    VALUES('p',?,'session','event','machine','the plan','hash','active',1,1,'token',1)`).bind(`plan-${i}`).run();
  for (const model of standing ? [MODEL, SWITCHED] : [MODEL]) {
    await db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
      SELECT project_id,?,record_id||?,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='p'`).bind(model, model).run();
    while ((await prepareEmbeddingDue(db, 'p', model)).more);
  }
  if (standing) await db.prepare(`INSERT INTO embedding_switches(slot,id,provider,model,endpoint,model_key,from_model_key,estimated_tokens,estimated_sources,state,reason,progressed_at,started_at,started_by,updated_at)
    VALUES('deployment','sw','workers-ai','@cf/baai/bge-large-en-v1.5',NULL,?,?,0,0,'building',NULL,1,1,'owner',1)`).bind(SWITCHED, MODEL).run();
}

describe.each(['native', 'D1'])('%s embedding scheduling and switch authority', (target) => {
  const base = () => { const f = sqliteEnv(); opened.push(f); return f.serverEnv; };

  it('re-arms a Project whose switch model is deactivated after an idle check, so its work is dispatched with no source edit', async () => {
    await withEmbeddingStore(target, async (db) => {
      await switching(db);
      const launched: string[] = [];
      const env = environment(base(), db, launched);
      expect(await embeddingKeepsAwake(env, NOW)).toBe(false);
      await retainEmbeddingModels(db, 'p', [MODEL]);
      expect(await embeddingKeepsAwake(env, NOW + 1_000)).toBe(true);
      expect(await dispatchEmbeddingWork(env, NOW + 1_000)).toBe(1);
      expect(launched).toHaveLength(1);
    });
  }, 60_000);

  it('an audit replaces a work row resting on a stale idle answer, without any mutation marking the Project', async () => {
    await withEmbeddingStore(target, async (db) => {
      await switching(db, 1, false);
      const env = environment(base(), db);
      expect(await embeddingKeepsAwake(env, NOW)).toBe(false);
      await db.prepare(`INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
        VALUES('p','unseen','session','event','machine','another plan','hash','active',1,1,'token',1)`).run();
      // The change's invalidation is lost: the work row rests clean and nothing marks the Project.
      await db.prepare('UPDATE embedding_work_state SET checked_revision=revision,pending=0,wake_at=NULL').run();
      await db.prepare('DELETE FROM embedding_work_attention').run();
      expect(await embeddingKeepsAwake(env, NOW + 60_000)).toBe(false);
      expect(await embeddingKeepsAwake(env, NOW + WORK_AUDIT_INTERVAL_MS + 1)).toBe(true);
      expect(await embeddingKeepsAwake(env, NOW + WORK_AUDIT_INTERVAL_MS + 2)).toBe(true);
    });
  }, 60_000);

  it('an audit finds calibration work whose invalidation was missed, with no switch standing, and dispatches it with no further edit', async () => {
    await withEmbeddingStore(target, async (db) => {
      await switching(db, 1, false);
      const launched: string[] = [];
      const env = environment(base(), db, launched);
      expect(await embeddingKeepsAwake(env, NOW)).toBe(false);
      for (const id of ['vector-1', 'vector-2']) await db.prepare("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES('p',?,'agent','calibrated knowledge','decision',1)").bind(id).run();
      await db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
        SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='p' AND type='spore'`).bind(MODEL).run();
      // Both spore vectors are built and none is calibrated, but the change's invalidation is lost.
      await db.prepare('UPDATE embedding_work_state SET checked_revision=revision,pending=0,wake_at=NULL').run();
      await db.prepare('DELETE FROM embedding_work_attention').run();
      expect(await embeddingKeepsAwake(env, NOW + 60_000)).toBe(false);
      expect(await embeddingKeepsAwake(env, NOW + WORK_AUDIT_INTERVAL_MS + 1)).toBe(true);
      expect(await dispatchEmbeddingWork(env, NOW + WORK_AUDIT_INTERVAL_MS + 2)).toBe(1);
      expect(launched).toHaveLength(1);
    });
  }, 60_000);

  for (const standing of [false, true]) {
    it(`an audit finds another model's unfinished calibration member beside a resting snapshot (${standing ? 'switch standing' : 'no switch'})`, async () => {
      await withEmbeddingStore(target, async (db) => {
        const calibrated = standing ? SWITCHED : MODEL;
        const other = standing ? MODEL : 'previous-model';
        await db.prepare("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
        for (const id of ['vector-1', 'vector-2']) await db.prepare("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES('p',?,'agent','calibrated knowledge','decision',1)").bind(id).run();
        for (const model of standing ? [MODEL, SWITCHED] : [MODEL]) {
          await db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
            SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='p'`).bind(model).run();
          while ((await prepareEmbeddingDue(db, 'p', model)).more);
        }
        if (standing) await db.prepare(`INSERT INTO embedding_switches(slot,id,provider,model,endpoint,model_key,from_model_key,estimated_tokens,estimated_sources,state,reason,progressed_at,started_at,started_by,updated_at)
          VALUES('deployment','sw','workers-ai','@cf/baai/bge-large-en-v1.5',NULL,?,?,0,0,'building',NULL,1,1,'owner',1)`).bind(SWITCHED, MODEL).run();
        await db.prepare(`INSERT INTO embedding_hubness_members(project_id,model_key,id,n,vector) SELECT project_id,model_key,id,1,'AACAPw==' FROM embedding_receipts WHERE project_id='p' AND model_key=?`).bind(calibrated).run();
        expect(await calibrationPopulation(db, 'p', calibrated)).toMatchObject({ total: 2, covered: 2, members: 2, uncovered: 0, stale: 0, miscounted: false });
        const env = environment(base(), db);
        expect(await embeddingKeepsAwake(env, NOW)).toBe(false);
        // Another model's member is still joining, and the mark that would have woken the Project is lost.
        await db.prepare(`INSERT INTO embedding_hubness_members(project_id,model_key,id,state,n,vector) VALUES('p',?,'vector-1',1,0,'AACAPw==')`).bind(other).run();
        await db.prepare('UPDATE embedding_work_state SET checked_revision=revision,pending=0,wake_at=NULL').run();
        await db.prepare('DELETE FROM embedding_work_attention').run();
        expect(await embeddingKeepsAwake(env, NOW + 60_000)).toBe(false);
        expect(await embeddingKeepsAwake(env, NOW + WORK_AUDIT_INTERVAL_MS + 1)).toBe(true);
      });
    }, 60_000);
  }

  it('refuses to complete a switch when calibration moves after its check, keeping the switch and search\'s model', async () => {
    await withEmbeddingStore(target, async (db) => {
      await switching(db);
      expect(await calibrationPending(db, 'p', SWITCHED, NOW)).toBe(false);
      const sw = (await readSwitch(db))!;
      expect(await switchComplete(db, sw, NOW)).toBe(true);
      // Two current spores land, built under both models, so every source is still accounted for; neither is calibrated.
      for (const id of ['late-1', 'late-2']) await db.prepare("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES('p',?,'agent','late knowledge','decision',1)").bind(id).run();
      for (const model of [MODEL, SWITCHED]) await db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
        SELECT project_id,?,record_id||?,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='p' AND type='spore'`).bind(model, model).run();
      expect(await switchComplete(db, sw, NOW)).toBe(true);
      expect(await writeSwitchedEmbedding(db, { 'embedding.provider': 'workers-ai', 'embedding.model': sw.model }, 'owner', NOW, sw)).toBe(false);
      expect(await readSwitch(db)).toMatchObject({ id: 'sw', state: 'building' });
      expect(await calibrationPending(db, 'p', SWITCHED, NOW)).toBe(true);
    });
  }, 60_000);

  it('reports switch progress and its passed-over sources as still counting while passed-over membership catches up', async () => {
    await withEmbeddingStore(target, async (db) => {
      await switching(db);
      const env = environment(base(), db);
      expect(await embeddingSwitchStatus(env, NOW)).toMatchObject({ progress: 'ready', done: 1, total: 1 });
      await db.prepare("UPDATE projection_catchup SET done=0 WHERE projection='passed_over'").run();
      expect(await embeddingSwitchStatus(env, NOW)).toMatchObject({ progress: 'building' });
      expect(await switchPassedOver(db, SWITCHED, NOW, null)).toMatchObject({ state: 'building' });
      expect(await switchComplete(db, (await readSwitch(db))!, NOW)).toBe(false);
    });
  }, 60_000);
});

test('switch status and completion read the same rows whatever expired refusals a Project holds', async () => {
  await withEmbeddingStore('D1', async (db) => {
    const measured = measuredStore(db as never);
    await switching(db, 1);
    const reads: Array<{ status: number; complete: number }> = [];
    for (const size of [1, 200]) {
      await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
        INSERT OR IGNORE INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
        SELECT 'p',printf('refused-%04d',x),'session','event','machine','refused plan','hash','active',1,1,'token',1 FROM n`).bind(size).run();
      await db.prepare(`INSERT OR IGNORE INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at)
        SELECT project_id,type,record_id,?,revision,'refused',? FROM embedding_versions WHERE project_id='p' AND record_id LIKE 'refused-%'`).bind(SWITCHED, NOW - 2 * RETRY).run();
      const sw = (await readSwitch(measured.db))!;
      measured.reset();
      expect((await switchPassedOver(measured.db, SWITCHED, NOW, SWITCHED)).count).toBe(0);
      const status = measured.reads();
      measured.reset();
      expect(await switchComplete(measured.db, sw, NOW)).toBe(false);
      reads.push({ status, complete: measured.reads() });
    }
    console.info(`passed-over status / completion rows read at 1 / 200 expired refusals: ${JSON.stringify(reads)}`);
    expect(reads[1]!.status).toBe(reads[0]!.status);
    expect(reads[1]!.complete).toBeLessThanOrEqual(reads[0]!.complete + 8);
  });
}, 60_000);
