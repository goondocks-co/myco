import { describe, expect, test } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { calibrationPending, reconcileHubness } from '@myco-server-worker/core/embedding/hubness.js';
import type { EmbeddingContext } from '@myco-server-worker/core/embedding/reconcile.js';
import { hasEmbeddingWork } from '@myco-server-worker/core/embedding/work.js';
import { VECTOR_LOST_MS, VECTOR_REWRITE_LIMIT } from '@myco-server-worker/core/embedding/provider.js';
import { calibrationPopulation, currentSporeVectorIds, missingSporeVectors } from '@myco-server-worker/db/embeddings/calibration.js';
import { prepareEmbeddingDue, resetEmbeddingIndex } from '@myco-server-worker/db/embeddings/work.js';
import { catchUpProjections, resetProjectionCatchup } from '@myco-server-worker/db/projections/catchup.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { withEmbeddingStore } from './helpers/embedding-work-store.js';
import { measuredStore } from './helpers/read-budget.js';

const NOW = 10 ** 12;
const MODEL = 'm';

/** Spores, with a ready receipt under `model` for each; `members` of them already settled in calibration. */
async function seed(db: RelationalStore, ids: readonly string[], options: { model?: string; members?: number; project?: string } = {}) {
  const project = options.project ?? 'p', model = options.model ?? MODEL;
  await db.prepare("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('a','a','built-in',1,1)").run();
  for (const id of ids) await db.prepare("INSERT OR IGNORE INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES(?,?,'a',?, 'decision',1)").bind(project, id, `spore ${id}`).run();
  await db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
    SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id=? AND record_id IN (SELECT value FROM json_each(?))`).bind(model, project, JSON.stringify(ids)).run();
  while ((await prepareEmbeddingDue(db, project, model)).more);
  const n = options.members ?? 0;
  await db.prepare(`INSERT OR IGNORE INTO embedding_hubness_members(project_id,model_key,id,n,vector)
    SELECT ?,?,value,?,'AACAPw==' FROM json_each(?)`).bind(project, model, n - 1, JSON.stringify(ids.slice(0, n))).run();
}

/** The population recounted from the receipts and members themselves, independent of what the triggers keep. */
async function recount(db: RelationalStore, model = MODEL, project = 'p') {
  const count = async (sql: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).bind(project, model).first<{ n: number }>())!.n;
  const current = `embedding_receipts r JOIN embedding_versions v ON v.project_id=r.project_id AND v.type=r.type AND v.record_id=r.record_id AND v.revision=r.revision
    JOIN spores s ON s.project_id=v.project_id AND s.id=v.record_id AND s.status='active' WHERE r.project_id=? AND r.model_key=? AND r.type='spore' AND r.ready=1`;
  const noMember = `NOT EXISTS (SELECT 1 FROM embedding_hubness_members m WHERE m.project_id=r.project_id AND m.model_key=r.model_key AND m.id=r.id)`;
  return {
    total: await count(current),
    covered: await count(`${current} AND r.rewrites=0`),
    members: await count('embedding_hubness_members WHERE project_id=? AND model_key=?'),
    uncovered: await count(`${current} AND r.rewrites=0 AND ${noMember}`),
  };
}

const maintained = async (db: RelationalStore, model = MODEL, project = 'p') => {
  const { total, covered, members, uncovered } = await calibrationPopulation(db, project, model);
  return { total, covered, members, uncovered };
};

const vectors = (ids: readonly string[]) => ({ get: async (_scope: unknown, wanted: readonly string[]) => wanted.filter((id) => ids.includes(id)).map((id, i) => ({ id, values: [1, i + 1] })) });
const context = (db: RelationalStore, ids: readonly string[]): EmbeddingContext => ({ db, vectors: vectors(ids), provider: { modelKey: MODEL } } as unknown as EmbeddingContext);
async function settle(db: RelationalStore, ids: readonly string[], now = NOW) {
  for (let i = 0; i < 200; i++) if ((await reconcileHubness(context(db, ids), 'p', now)).processed === 0) return;
  throw new Error('calibration did not settle');
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${String(i).padStart(4, '0')}`);

/** A context whose store returns each spore's own vector, whichever order it is asked in. */
const steady = (db: RelationalStore): EmbeddingContext => ({ db, provider: { modelKey: MODEL }, vectors: { get: async (_scope: unknown, wanted: readonly string[]) => wanted.map((id) => {
  const n = Number(id.slice(1));
  return { id, values: Array.from({ length: 8 }, (_, j) => Math.sin(n * 0.17 + j * 0.31) + Math.cos(n * 0.07 - j)) };
}) } } as unknown as EmbeddingContext);

/** `db`, running `competing` once, right after a read of the population has returned to its caller. */
function interruptedAfterPopulation(db: RelationalStore, competing: () => Promise<unknown>): RelationalStore {
  let due = true;
  return new Proxy(db, { get(store, key) {
    if (key !== 'batch') { const value = Reflect.get(store, key); return typeof value === 'function' ? value.bind(store) : value; }
    return async (statements: Parameters<RelationalStore['batch']>[0]) => {
      const results = await store.batch(statements);
      if (due && results.some((result) => (result.results[0] as { retiring?: unknown } | undefined)?.retiring !== undefined)) { due = false; await competing(); }
      return results;
    };
  } });
}

const statistics = async (db: RelationalStore) => (await db.prepare("SELECT id,neighbor_mean,neighbor_std FROM embedding_receipts WHERE project_id='p' AND type='spore' ORDER BY id").all()).results;
/** Seventy-five calibrated spores and twenty more ready to join. */
async function waitingToJoin(db: RelationalStore) {
  await seed(db, ids(75));
  for (let i = 0; i < 200 && (await reconcileHubness(steady(db), 'p', NOW)).processed > 0; i++);
  await seed(db, ids(95));
}

describe.each(['native', 'D1'])('%s calibration on maintained state', (target) => {
  test('the left-out report says nothing until its projections and the model can answer, then counts', () => withEmbeddingStore(target, async (db) => {
    await seed(db, ['s1']);
    await db.prepare('UPDATE embedding_models SET complete=1 WHERE project_id=? AND model_key=?').bind('p', MODEL).run();
    await db.prepare('UPDATE embedding_receipts SET rewrites=?,updated_at=? WHERE project_id=?').bind(VECTOR_REWRITE_LIMIT, NOW, 'p').run();
    const report = () => missingSporeVectors(db, 'p', MODEL, NOW);
    const counted = { rewriting: 0, waiting: 1, abandoned: 0 };
    expect(await report()).toEqual(counted);
    const held = async (sql: string, undo: string) => {
      await db.prepare(sql).run();
      expect(await report()).toBeNull();
      await db.prepare(undo).run();
      expect(await report()).toEqual(counted);
    };
    await held("UPDATE projection_catchup SET done=0 WHERE projection='embedding_calibration'", "UPDATE projection_catchup SET done=1 WHERE projection='embedding_calibration'");
    await held("UPDATE projection_catchup SET done=0 WHERE projection='embedding_state'", "UPDATE projection_catchup SET done=1 WHERE projection='embedding_state'");
    await held("UPDATE embedding_models SET complete=0 WHERE project_id='p'", "UPDATE embedding_models SET complete=1 WHERE project_id='p'");
    await held("UPDATE embedding_models SET active=0 WHERE project_id='p'", "UPDATE embedding_models SET active=1 WHERE project_id='p'");
    await db.prepare("DELETE FROM embedding_models WHERE project_id='p'").run();
    expect(await report()).toBeNull();
    expect(await missingSporeVectors(db, 'p', 'never-used', NOW)).toEqual({ rewriting: 0, waiting: 0, abandoned: 0 });
  }));

  test('the population follows every source, receipt and membership change, and equals a recount of them', async () => {
    await withEmbeddingStore(target, async (db) => {
      const check = async (step: string) => expect({ step, ...await maintained(db) }).toEqual({ step, ...await recount(db) });
      await seed(db, ids(6), { members: 3 });
      await check('seeded');
      await db.prepare("UPDATE spores SET content='rewritten' WHERE project_id='p' AND id=?").bind(ids(6)[0]!).run();
      await check('source revision moved');
      await db.prepare("UPDATE embedding_receipts SET rewrites=1 WHERE project_id='p' AND model_key=? AND id=?").bind(MODEL, ids(6)[1]!).run();
      await check('receipt left out');
      await db.prepare("UPDATE embedding_receipts SET ready=0 WHERE project_id='p' AND model_key=? AND id=?").bind(MODEL, ids(6)[3]!).run();
      await check('receipt unindexed');
      await db.prepare("UPDATE embedding_hubness_members SET state=2 WHERE project_id='p' AND model_key=? AND id=?").bind(MODEL, ids(6)[2]!).run();
      await check('member leaving');
      await db.prepare("DELETE FROM embedding_hubness_members WHERE project_id='p' AND model_key=? AND id=?").bind(MODEL, ids(6)[2]!).run();
      await check('member gone');
      await db.prepare("DELETE FROM embedding_receipts WHERE project_id='p' AND model_key=? AND id=?").bind(MODEL, ids(6)[4]!).run();
      await check('receipt gone');
      await db.prepare("UPDATE spores SET status='obsolete' WHERE project_id='p' AND id=?").bind(ids(6)[5]!).run();
      await check('spore retired');
      await seed(db, ids(2), { model: 'other', members: 1 });
      expect(await maintained(db, 'other')).toEqual(await recount(db, 'other'));
      await check('another model counts apart');
    });
  }, 60_000);

  test('until catch-up finishes the population reads building, calibration waits, and restore resets it the same way', async () => {
    await withEmbeddingStore(target, async (db) => {
      await seed(db, ids(5), { members: 2 });
      for (const reset of [async () => {
        await db.prepare('DELETE FROM embedding_calibration_state').run();
        await db.prepare('DELETE FROM embedding_calibration_population').run();
        await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='embedding_calibration'").run();
      }, () => resetProjectionCatchup(db)]) {
        await reset();
        expect(await calibrationPopulation(db, 'p', MODEL)).toMatchObject({ state: 'building' });
        expect(await calibrationPending(db, 'p', MODEL, NOW, true)).toBe(true);
        expect(await reconcileHubness(context(db, ids(5)), 'p', NOW)).toEqual({ phase: 'visibility', processed: 0 });
        while ((await catchUpProjections(db, { budget: { calls: 1_000, wallMs: 60_000 } })).more);
        expect(await calibrationPopulation(db, 'p', MODEL)).toMatchObject({ state: 'ready', ...await recount(db) });
      }
    });
  }, 60_000);

  test('a reset opens a new epoch: the old population is never read as current and is retired once its rows are', async () => {
    await withEmbeddingStore(target, async (db) => {
      await seed(db, ids(4), { members: 4 });
      expect(await maintained(db)).toMatchObject({ total: 4, members: 4 });
      await resetEmbeddingIndex(db, 'p');
      expect(await calibrationPopulation(db, 'p', MODEL)).toMatchObject({ state: 'building', total: 0, members: 0 });
      expect(await calibrationPending(db, 'p', MODEL, NOW, true)).toBe(true);
      expect(await reconcileHubness(context(db, ids(4)), 'p', NOW)).toEqual({ phase: 'visibility', processed: 0 });
      while ((await catchUpProjections(db, { budget: { calls: 1_000, wallMs: 60_000 } })).more);
      expect(await calibrationPopulation(db, 'p', MODEL)).toMatchObject({ state: 'ready', total: 0, members: 0 });
      expect((await db.prepare('SELECT COUNT(*) AS n FROM embedding_hubness_members').first<{ n: number }>())!.n).toBe(0);
      expect((await db.prepare('SELECT COUNT(*) AS n FROM embedding_calibration_population WHERE epoch=0').first<{ n: number }>())!.n).toBe(0);
      expect(await calibrationPending(db, 'p', MODEL, NOW, true)).toBe(false);
      await db.prepare("UPDATE spores SET content='written again' WHERE project_id='p'").run();
      await db.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
        SELECT project_id,?,record_id,type,record_id,revision,1,2 FROM embedding_versions WHERE project_id='p' AND type='spore'`).bind(MODEL).run();
      expect(await maintained(db)).toEqual(await recount(db));
      expect(await maintained(db)).toMatchObject({ total: 4, covered: 4, members: 0, uncovered: 4 });
    });
  }, 60_000);

  test('an unchanged population produces no calibration run, and only the audit finds moments changed behind the triggers', async () => {
    await withEmbeddingStore(target, async (db) => {
      await seed(db, ids(5));
      await settle(db, ids(5));
      expect(await currentSporeVectorIds(db, 'p', MODEL)).toEqual(ids(5));
      expect(await calibrationPending(db, 'p', MODEL, NOW)).toBe(false);
      const revision = await db.prepare("SELECT revision FROM embedding_work_state WHERE project_id='p' AND model_key=? AND kind='hubness'").bind(MODEL).first<{ revision: number }>();
      expect(await calibrationPending(db, 'p', MODEL, NOW + 1, true)).toBe(false);
      expect(await db.prepare("SELECT revision FROM embedding_work_state WHERE project_id='p' AND model_key=? AND kind='hubness'").bind(MODEL).first<{ revision: number }>()).toEqual(revision);
      expect(await reconcileHubness(context(db, ids(5)), 'p', NOW)).toEqual({ phase: 'settled', processed: 0 });
      // A receipt re-journaled under the same revision moves nothing calibration reads.
      await db.prepare('UPDATE embedding_receipts SET updated_at=updated_at+1 WHERE project_id=\'p\' AND id=?').bind(ids(5)[0]!).run();
      expect(await calibrationPending(db, 'p', MODEL, NOW)).toBe(false);
      await db.prepare("UPDATE embedding_hubness_members SET n=n+1 WHERE project_id='p' AND id=?").bind(ids(5)[0]!).run();
      expect(await calibrationPending(db, 'p', MODEL, NOW)).toBe(false);
      expect(await hasEmbeddingWork(db, 'p', MODEL, NOW, { fresh: true })).toBe(true);
    });
  }, 60_000);

  test('publishing a pass reads no vector and writes only statistics that changed', async () => {
    await withEmbeddingStore(target, async (db) => {
      await seed(db, ids(5));
      await settle(db, ids(5));
      await db.prepare("CREATE TABLE stat_writes(n INTEGER)").run();
      await db.prepare("CREATE TRIGGER count_stat_writes AFTER UPDATE OF neighbor_mean ON embedding_receipts BEGIN INSERT INTO stat_writes VALUES(1); END").run();
      await db.prepare("UPDATE embedding_hubness_members SET vector='not a vector' WHERE project_id='p'").run();
      await db.prepare("UPDATE embedding_cursors SET hubness_cursor='' WHERE project_id='p'").run();
      for (let i = 0; i < 4 && (await reconcileHubness(context(db, ids(5)), 'p', NOW)).processed > 0; i++);
      expect(await db.prepare("SELECT hubness_cursor FROM embedding_cursors WHERE project_id='p'").first()).toEqual({ hubness_cursor: null });
      expect((await db.prepare('SELECT COUNT(*) AS n FROM stat_writes').first<{ n: number }>())!.n).toBe(0);
      expect(await db.prepare("SELECT COUNT(*) AS n,SUM(neighbor_mean IS NOT NULL) AS published FROM embedding_receipts WHERE project_id='p' AND type='spore'").first()).toEqual({ n: 5, published: 5 });
    });
  }, 60_000);

  test('a step that read the population before another step moved on commits nothing, and rest waits for every statistic', async () => {
    let expected: unknown[] = [];
    await withEmbeddingStore(target, async (db) => {
      await waitingToJoin(db);
      for (let i = 0; i < 200 && (await reconcileHubness(steady(db), 'p', NOW)).processed > 0; i++);
      expected = await statistics(db);
      expect(expected.every((row) => (row as { neighbor_mean: number | null }).neighbor_mean !== null)).toBe(true);
      expect(await calibrationPending(db, 'p', MODEL, NOW, true)).toBe(false);
    });
    await withEmbeddingStore(target, async (db) => {
      await waitingToJoin(db);
      let competed = 0;
      const raced = interruptedAfterPopulation(db, async () => { competed++; await reconcileHubness(steady(db), 'p', NOW); });
      await reconcileHubness(steady(raced), 'p', NOW);
      expect(competed).toBe(1);
      let processed = 1;
      for (let i = 0; i < 200 && processed > 0; i++) {
        if (JSON.stringify(await statistics(db)) !== JSON.stringify(expected)) expect(await calibrationPending(db, 'p', MODEL, NOW, true)).toBe(true);
        ({ processed } = await reconcileHubness(steady(db), 'p', NOW));
      }
      expect(processed).toBe(0);
      expect(await statistics(db)).toEqual(expected);
      expect(await calibrationPending(db, 'p', MODEL, NOW, true)).toBe(false);
    });
  }, 120_000);

  test('left-out vectors still waited on come first, oldest first, then those no longer written again, each in turn', async () => {
    await withEmbeddingStore(target, async (db) => {
      const all = ids(45);
      await seed(db, all);
      await db.prepare("UPDATE embedding_receipts SET rewrites=?,updated_at=1 WHERE project_id='p'").bind(VECTOR_REWRITE_LIMIT).run();
      const waited = all.slice(10, 15);
      for (const [i, id] of waited.entries()) await db.prepare("UPDATE embedding_receipts SET updated_at=? WHERE project_id='p' AND id=?").bind(NOW - i, id).run();
      const asked: string[][] = [];
      const looking = { db, provider: { modelKey: MODEL }, vectors: { get: async (_scope: unknown, wanted: readonly string[]) => { asked.push([...wanted]); return []; } } } as unknown as EmbeddingContext;
      for (let i = 0; i < 3; i++) expect(await reconcileHubness(looking, 'p', NOW)).toEqual({ phase: 'visibility', processed: 0 });
      for (const page of asked) { expect(page).toHaveLength(20); expect(page.slice(0, 5)).toEqual([...waited].reverse()); }
      const abandoned = all.filter((id) => !waited.includes(id));
      expect([...new Set(asked.flatMap((page) => page.slice(5)))].sort()).toEqual(abandoned);
      expect(asked[0]!.slice(5)).toEqual(abandoned.slice(0, 15));
      expect(asked[2]!.slice(5)).toEqual([...abandoned.slice(30), ...abandoned.slice(0, 5)]);
    });
  }, 60_000);

  test('a population emptied before a reset leaves no row behind in the old epoch', async () => {
    await withEmbeddingStore(target, async (db) => {
      await seed(db, ids(2));
      expect(await maintained(db)).toMatchObject({ total: 2 });
      await db.prepare("DELETE FROM embedding_receipts WHERE project_id='p'").run();
      expect(await db.prepare('SELECT COUNT(*) AS n FROM embedding_calibration_population').first()).toEqual({ n: 0 });
      expect(await calibrationPopulation(db, 'p', MODEL)).toMatchObject({ state: 'ready', total: 0, members: 0 });
      await resetEmbeddingIndex(db, 'p');
      while ((await catchUpProjections(db, { budget: { calls: 1_000, wallMs: 60_000 } })).more);
      expect(await db.prepare('SELECT COUNT(*) AS n FROM embedding_calibration_population').first()).toEqual({ n: 0 });
    });
  }, 60_000);

  test('a second distribution holds the same vector without moving the hubness population, and the reverse', async () => {
    await withEmbeddingStore(target, async (db) => {
      await seed(db, ids(3), { members: 1 });
      const hubness = await maintained(db);
      await db.prepare(`INSERT INTO embedding_calibration_state(project_id,model_key,id,epoch,kind,is_current,rewrites,updated_at,member,status)
        SELECT project_id,model_key,id,epoch,'query_reference',is_current,rewrites,updated_at,member,status FROM embedding_calibration_state WHERE project_id='p'`).run();
      const second = () => db.prepare("SELECT total,member_count FROM embedding_calibration_population WHERE kind='query_reference'").first();
      expect(await second()).toEqual({ total: 3, member_count: 1 });
      expect(await maintained(db)).toEqual(hubness);
      await db.prepare("DELETE FROM embedding_receipts WHERE project_id='p' AND id=?").bind(ids(3)[2]!).run();
      expect(await maintained(db)).toEqual(await recount(db));
      expect(await maintained(db)).toMatchObject({ total: 2, members: 1 });
      expect(await second()).toEqual({ total: 3, member_count: 1 });
      expect((await db.prepare("SELECT COUNT(*) AS n FROM embedding_calibration_state WHERE kind='query_reference'").first<{ n: number }>())!.n).toBe(3);
      await db.prepare("DELETE FROM embedding_calibration_state WHERE kind='query_reference'").run();
      expect(await second()).toBeNull();
      expect(await maintained(db)).toMatchObject({ total: 2, members: 1 });
    });
  }, 60_000);
});

test('a visibility step reads fixed rows, however many left-out vectors are waited on or abandoned', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map((sql) => d1.prepare(sql)));
    await d1.prepare("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('a','a','built-in',1,1)").run();
    const measured = measuredStore(d1);
    const costs: Array<Record<string, number>> = [];
    for (const size of [300, 4_000]) {
      const project = `lost${size}`;
      await d1.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
      await d1.prepare('INSERT INTO embedding_models(project_id,model_key,complete) VALUES(?,?,1)').bind(project, MODEL).run();
      await d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${size}) INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at)
        SELECT ?,printf('s%06d',x),'a','body','decision',1 FROM n`).bind(project).run();
      await d1.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,rewrites,updated_at)
        SELECT project_id,?,record_id,type,record_id,revision,1,?,? FROM embedding_versions WHERE project_id=? AND type='spore'`).bind(MODEL, VECTOR_REWRITE_LIMIT, NOW, project).run();
      const none = { db: measured.db, provider: { modelKey: MODEL }, vectors: { get: async () => [] } } as unknown as EmbeddingContext;
      const take = async (run: () => Promise<unknown>) => { measured.reset(); await run(); return measured.reads(); };
      const waiting = await take(() => reconcileHubness(none, project, NOW));
      expect(await missingSporeVectors(measured.db, project, MODEL, NOW)).toMatchObject({ waiting: Math.min(size, 200) });
      const waitingReport = await take(() => missingSporeVectors(measured.db, project, MODEL, NOW));
      await d1.prepare('UPDATE embedding_receipts SET updated_at=1 WHERE project_id=?').bind(project).run();
      const abandoned = await take(() => reconcileHubness(none, project, NOW + VECTOR_LOST_MS));
      const abandonedAgain = await take(() => reconcileHubness(none, project, NOW + VECTOR_LOST_MS));
      costs.push({ waiting, waitingReport, abandoned, abandonedAgain });
    }
    expect(costs[1]).toEqual(costs[0]);
    expect(Math.max(costs[1]!.waiting!, costs[1]!.abandoned!, costs[1]!.abandonedAgain!)).toBeLessThanOrEqual(80);
    expect(costs[1]!.waitingReport).toBeLessThanOrEqual(1_000);
  } finally { await mf.dispose(); }
}, 120_000);

test('the left-out report ignores stale receipts and counts vectors being written again, at a fixed cost', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map((sql) => d1.prepare(sql)));
    await d1.prepare("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('a','a','built-in',1,1)").run();
    const measured = measuredStore(d1);
    const reads: number[] = [];
    for (const size of [300, 4_000]) {
      const project = `stale${size}`;
      await d1.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
      await d1.prepare('INSERT INTO embedding_models(project_id,model_key,complete) VALUES(?,?,1)').bind(project, MODEL).run();
      await d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${size}) INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at)
        SELECT ?,printf('s%06d',x),'a','body','decision',1 FROM n`).bind(project).run();
      await d1.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,rewrites,updated_at)
        SELECT project_id,?,record_id,type,record_id,revision,1,?,? FROM embedding_versions WHERE project_id=? AND type='spore'`).bind(MODEL, VECTOR_REWRITE_LIMIT, NOW, project).run();
      expect(await missingSporeVectors(measured.db, project, MODEL, NOW)).toMatchObject({ waiting: 200 });
      await d1.prepare("UPDATE spores SET content=content||' edited' WHERE project_id=?").bind(project).run();
      measured.reset();
      expect(await missingSporeVectors(measured.db, project, MODEL, NOW)).toEqual({ rewriting: 0, waiting: 0, abandoned: 0 });
      reads.push(measured.reads());
      await d1.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,rewrites,updated_at)
        SELECT project_id,?,record_id||'-again',type,record_id,revision,0,1,? FROM embedding_versions WHERE project_id=? AND type='spore' ORDER BY record_id LIMIT 3`).bind(MODEL, NOW, project).run();
      expect(await missingSporeVectors(measured.db, project, MODEL, NOW)).toEqual({ rewriting: 3, waiting: 0, abandoned: 0 });
    }
    expect(reads[1]).toBeLessThanOrEqual(reads[0]! + 2);
    expect(reads[1]).toBeLessThanOrEqual(20);
  } finally { await mf.dispose(); }
}, 120_000);

test('calibration work and the population read fixed rows, however many spores a Project calibrates', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map((sql) => d1.prepare(sql)));
    const measured = measuredStore(d1);
    const costs: Array<Record<string, number>> = [];
    for (const size of [100, 4_000]) {
      const project = `p${size}`;
      await d1.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
      await d1.prepare("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('a','a','built-in',1,1)").run();
      await d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${size}) INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at)
        SELECT ?,printf('s%06d',x),'a','body','decision',1 FROM n`).bind(project).run();
      await d1.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
        SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id=? AND type='spore'`).bind(MODEL, project).run();
      await d1.prepare(`INSERT INTO embedding_hubness_members(project_id,model_key,id,n,vector) SELECT project_id,model_key,id,?-1,'AACAPw==' FROM embedding_receipts WHERE project_id=?`).bind(size, project).run();
      const take = async (run: () => Promise<unknown>) => { measured.reset(); await run(); return measured.reads(); };
      costs.push({
        population: await take(() => calibrationPopulation(measured.db, project, MODEL)),
        work: await take(() => calibrationPending(measured.db, project, MODEL, NOW, true)),
      });
    }
    expect(costs[1]).toEqual(costs[0]);
    expect(costs[1]!.population).toBeLessThanOrEqual(12);
    expect(costs[1]!.work).toBeLessThanOrEqual(20);
  } finally { await mf.dispose(); }
}, 120_000);
