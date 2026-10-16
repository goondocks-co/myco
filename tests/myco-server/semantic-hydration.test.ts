import { expect, test } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { semanticHits, semanticSearch, type SemanticHit, type SemanticHitCounts, type SemanticSearch } from '@myco-server-worker/read/embedding.js';
import { vectorMatches, type VectorFilters, type VectorHit } from '@myco-server-worker/core/embedding/vectors.js';
import { notTombstonedSql } from '@myco-server-worker/core/tombstones.js';
import { inListChunks } from '@myco-server-worker/read/scope.js';
import { SEARCH_PREVIEW_CHARS } from '@goondocks/myco-shared/search-types';
import { selectSporesForPrompt } from '@myco-server-worker/core/injection.js';
import { seededSqlite, sqliteD1 } from './helpers/d1.js';
import { measuredStore } from './helpers/read-budget.js';

const SCOPE = { projectId: 'proj_1' };
const MODEL = 'hydration-model';
const BODY = 'Long preview 😀\0'.repeat(1_000);
type Statement = { sql: string; params: unknown[]; rows: Record<string, unknown>[] };

function capturingStore(db: RelationalStore) {
  const statements: Statement[] = [];
  const wrap = (record: Statement, original: PreparedStatement): PreparedStatement => ({
    ...original,
    bind: (...params) => { record.params = params; return wrap(record, original.bind(...params)); },
    all: async <T,>() => {
      const answer = await original.all<T>();
      record.rows = answer.results as Record<string, unknown>[];
      return answer;
    },
  });
  return { statements, db: { ...db, prepare: (sql: string) => {
    const record: Statement = { sql, params: [], rows: [] };
    statements.push(record);
    return wrap(record, db.prepare(sql));
  } } };
}

function semantic(matches: VectorHit[]): SemanticSearch {
  return {
    provider: { modelKey: MODEL, embed: async () => [1, 0] },
    vectors: { query: async () => matches, get: async () => [], upsert: async () => {}, delete: async () => {} },
  };
}

async function seed(db: RelationalStore): Promise<VectorHit[]> {
  await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','a','built-in',1,0)").run();
  await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,title,summary,started_at,ended_at)
    VALUES('proj_1','session','machine','token',1,1,'Session title','Summary',10,20),
    ('proj_1','tombstone','machine','token',1,1,'Deleted','Still summarized',10,20),
    ('proj_2','session','machine','token',1,1,'Other','Other summary',10,20)`).run();
  await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5000)
    INSERT INTO spores(project_id,id,agent_id,session_id,prompt_id,content,context,observation_type,created_at)
    SELECT 'proj_1',printf('spore-%04d',x),'agent','session','prompt',?, 'Context','gotcha',1000+x FROM n`).bind(BODY).run();
  await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<500)
    INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at)
    SELECT 'proj_1',printf('plan-%04d',x),'session','event','machine','Plan title',?,'hash','active',1000+x,1,'token',1 FROM n`).bind(BODY).run();
  await db.prepare(`INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,blob_key,content_hash,status,created_at,updated_at,token_id,received_at)
    VALUES('proj_1','blob-proven','session','event','machine','Spilled','blob','hash','active',1001,1,'token',1),
    ('proj_1','blob-unproven','session','event','machine','Unproven','missing','hash','active',1001,1,'token',1)`).run();
  await db.prepare(`INSERT INTO processed_resources(project_id,kind,resource_id,blob_key,source_token_id,event_id,classification)
    VALUES('proj_1','plan','blob-proven','blob','token','event','processed')`).run();
  await db.prepare(`INSERT INTO knowledge_release_state(project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at)
    VALUES('proj_1','older','older','spores','spore-0001','draft','low',1,1),
    ('proj_1','latest','latest','spores','spore-0001','released','high',2,1),
    ('proj_1','tie','tie','spores','spore-0001','superseded','low',2,1)`).run();
  await db.prepare(`INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES('proj_1','tombstone',1,'token')`).run();
  await db.prepare(`UPDATE spores SET status='superseded' WHERE id='spore-0005'`).run();
  await db.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at,neighbor_mean,neighbor_std)
    SELECT project_id,?,type||':'||record_id,type,record_id,revision,1,1,0.4,0.1 FROM embedding_versions`).bind(MODEL).run();
  await db.prepare(`UPDATE embedding_receipts SET revision='stale' WHERE record_id='spore-0002'`).run();
  await db.prepare(`UPDATE embedding_receipts SET ready=0 WHERE record_id='spore-0003'`).run();
  await db.prepare(`UPDATE embedding_receipts SET model_key='other' WHERE record_id='spore-0004'`).run();
  await db.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
    VALUES('proj_1',?,'skill:retired','skill','retired','old',1,1)`).bind(MODEL).run();
  await db.prepare("UPDATE embedding_receipts SET id='foreign:'||id WHERE project_id='proj_2'").run();
  const rows = (await db.prepare(`SELECT id FROM embedding_receipts WHERE
    (project_id='proj_1' AND (type IN ('session','skill') OR (type='spore' AND record_id<='spore-0088')
      OR (type='plan' AND (record_id<='plan-0005' OR record_id LIKE 'blob-%'))))
    OR project_id='proj_2' ORDER BY id`).all<{ id: string }>()).results;
  return [...rows.map(({ id }, i) => ({ id, score: 0.99 - Math.floor(i / 2) / 1000 })), { id: 'missing', score: 0.9 }];
}

/** The receipt/view join is the compatibility oracle. */
async function oracle(db: RelationalStore, matches: VectorHit[], filters?: VectorFilters): Promise<SemanticHit[]> {
  const byId = new Map(matches.map(({ id, score }) => [id, score]));
  const rows: SemanticHit[] = [];
  for (const ids of inListChunks(matches.map(({ id }) => id))) {
    const found = await db.prepare(`SELECT s.*, r.id AS vector_id, r.neighbor_mean, r.neighbor_std FROM embedding_receipts r
      JOIN embedding_sources s ON s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision
      WHERE r.project_id = ? AND r.model_key = ? AND r.ready = 1 AND r.id IN (${ids.map(() => '?').join(',')})
      AND (s.type <> 'session' OR ${notTombstonedSql('s')})`).bind(SCOPE.projectId, MODEL, ...ids).all<Omit<SemanticHit, 'score'>>();
    rows.push(...found.results.filter((row) => vectorMatches(row, filters)).map((row) => ({ ...row, score: byId.get(row.vector_id)! })));
  }
  return rows.sort((a, b) => b.score - a.score || a.vector_id.localeCompare(b.vector_id));
}

const metadata = (rows: SemanticHit[]) => rows.map(({ text: _text, ...row }) => row);

for (const target of ['bun', 'workerd-d1'] as const) {
  test(`${target}: G5 hydration seeks only hits, bounds previews and preserves all eligibility/filter contracts`, async () => {
    const sqlite = seededSqlite();
    const mf = target === 'bun' ? null : new Miniflare(convertV4MiniflareOptions({
      modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'],
    }));
    try {
      const d1 = await mf?.getD1Database('DB');
      if (d1) {
        for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map((sql) => d1.prepare(sql)));
        await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','a',0),('proj_2','b',0)").run();
      }
      const measured = d1 ? measuredStore(d1) : null;
      const db = measured?.db ?? sqliteD1(sqlite);
      const matches = await seed(db);
      const all = await oracle(db, matches);
      expect(new Set(all.map((row) => row.type))).toEqual(new Set(['session', 'spore', 'plan']));
      expect(all.find((row) => row.record_id === 'spore-0001')?.release_state).toBe('released');
      const recording = capturingStore(db);
      measured?.reset();
      const counts: SemanticHitCounts[] = [];
      const result = await semanticHits(recording.db, SCOPE, semantic(matches), [1, 0], { topK: 100, observe: (n) => counts.push(n) });
      expect(metadata(result)).toEqual(metadata(all));
      expect(result.every((row) => row.text === '')).toBe(true);
      expect(counts.at(-1)).toEqual({ rawMatches: matches.length, joinedHits: all.length, filteredHits: all.length });
      if (measured) {
        const newReads = measured.reads();
        measured.reset();
        await oracle(db, matches);
        const oldReads = measured.reads();
        console.info(`G5 D1 5000 spores/500 plans: before=${oldReads} after=${newReads} rows_read`);
        expect(newReads).toBeLessThan(2_000);
        expect(oldReads).toBeGreaterThan(newReads * 5);
      }
      expect(recording.statements.length).toBeGreaterThan(1);
      for (const statement of recording.statements) {
        expect(statement.params.length).toBeLessThanOrEqual(100);
        expect((statement.sql.match(/\bUNION ALL\b/g) ?? []).length).toBeLessThan(5);
        const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.params).all<{ detail: string }>()).results.map((row) => row.detail).join('\n');
        expect(plan.split('\n').filter((line) => /\bSCAN\b/.test(line) && !/\bSCAN r\b/.test(line))).toEqual([]);
        expect(plan).toMatch(/SEARCH embedding_receipts .*\(project_id=\? AND model_key=\? AND id=\?\)/);
        for (const row of statement.rows) {
          expect(row).not.toHaveProperty('content');
          expect(row.text).toBe('');
        }
        if (target === 'bun' && statement === recording.statements[0]) console.info(`G5 after EQP:\n${plan}`);
      }
      if (target === 'bun') {
        const capturedOld = capturingStore(db);
        await oracle(capturedOld.db, matches);
        const first = capturedOld.statements[0];
        const before = (await db.prepare(`EXPLAIN QUERY PLAN ${first.sql}`).bind(...first.params).all<{ detail: string }>()).results.map((row) => row.detail).join('\n');
        console.info(`G5 before EQP:\n${before}`);
      }
      for (const filters of [{ type: 'spore' }, { type: 'plan' }, { type: 'session' }, { status: 'active' }, { status: 'completed' },
        { session_id: 'session' }, { observation_type: 'gotcha' }, { release_state: 'released' }, { release_confidence: 'high' },
        { created_at: { gte: 1002, lte: 1008 } }, { created_at: { gte: 1005 } }, { created_at: { lte: 1006 } },
        { type: 'spore', release_state: 'released', release_confidence: 'high', session_id: 'session', observation_type: 'gotcha', status: 'active' }] satisfies VectorFilters[]) {
        expect(metadata(await semanticHits(db, SCOPE, semantic(matches), [1, 0], { topK: 100, filters }))).toEqual(metadata(await oracle(db, matches, filters)));
      }
      const previews = capturingStore(db);
      const previewRows = await semanticHits(previews.db, SCOPE, semantic(matches), [1, 0], { topK: 100, preview: true });
      expect(previewRows.map((row) => row.text.slice(0, SEARCH_PREVIEW_CHARS))).toEqual(all.map((row) => row.text.slice(0, SEARCH_PREVIEW_CHARS)));
      for (const statement of previews.statements) {
        for (const row of statement.rows) expect(Array.from(String(row.text)).length).toBeLessThanOrEqual(SEARCH_PREVIEW_CHARS);
        const explained = (await db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.params).all<{ detail: string }>()).results;
        expect(explained.filter(({ detail }) => /\bSCAN\b/.test(detail) && !/\bSCAN (?:r|chunks|CONSTANT ROW)\b/.test(detail))).toEqual([]);
      }
      const search = await semanticSearch(db, SCOPE, semantic(matches), ['spore', 'plan', 'session'], { query: 'fixture prompt' }, 100);
      const expected = (await Promise.all(['spore', 'plan', 'session'].map((type) => oracle(db, matches, { type })))).flat()
        .sort((a, b) => b.score - a.score || a.vector_id.localeCompare(b.vector_id)).slice(0, 100);
      expect(search.map(({ id, preview }) => ({ id, preview }))).toEqual(expected.map((row) => ({ id: row.record_id, preview: row.text.slice(0, SEARCH_PREVIEW_CHARS) })));
      const input = { sessionId: 'session', promptId: 'recall', promptHash: 'recall', prompt: 'fixture prompt for recall', now: 2000 };
      const leaves = { enabled: true, maxPerPrompt: 3 };
      const selection = await selectSporesForPrompt(db, SCOPE, leaves, true, input, async () => semantic(matches));
      const fromOracle: RelationalStore = { ...db, prepare: (sql) => {
        if (!sql.startsWith('WITH hits AS MATERIALIZED')) return db.prepare(sql);
        let params: unknown[] = [];
        const statement: PreparedStatement = { bind: (...values) => { params = values; return statement; },
          all: async <T,>() => ({ results: (await oracle(db, matches.filter((hit) => params.slice(2).includes(hit.id)))).map(({ score: _score, ...row }) => row) as T[] }),
          first: async () => { throw new Error('unexpected first'); }, run: async () => { throw new Error('unexpected run'); } };
        return statement;
      } };
      await db.prepare("DELETE FROM spore_injections WHERE project_id='proj_1'").run();
      expect(await selectSporesForPrompt(fromOracle, SCOPE, leaves, true, input, async () => semantic(matches))).toEqual(selection);
    } finally { sqlite.close(); await mf?.dispose(); }
  }, 60_000);
}

test('multiple hydration chunks are in flight together and observations retain aggregate counts', async () => {
  const sqlite = seededSqlite();
  try {
    const db = sqliteD1(sqlite);
    const matches = (await seed(db)).slice(0, 100);
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const wrapped: RelationalStore = { ...db, prepare: (sql) => {
      const observe = (statement: PreparedStatement): PreparedStatement => ({ ...statement,
        bind: (...params) => observe(statement.bind(...params)),
        all: async <T,>() => {
          inFlight++; peak = Math.max(peak, inFlight);
          if (inFlight === 2) release();
          await gate;
          try { return await statement.all<T>(); } finally { inFlight--; }
        },
      });
      return observe(db.prepare(sql));
    } };
    const observations: SemanticHitCounts[] = [];
    const result = await semanticHits(wrapped, SCOPE, semantic(matches), [1, 0], { topK: 100, observe: (n) => observations.push(n) });
    expect(peak).toBe(2);
    expect(observations).toHaveLength(3);
    expect(observations.at(-1)).toEqual({ rawMatches: 100, joinedHits: result.length, filteredHits: result.length });
  } finally { sqlite.close(); }
}, 5_000);

for (const failedChunk of [0, 1]) {
  test(`hydration settles the other chunk before reporting chunk ${failedChunk}'s failure`, async () => {
    const sqlite = seededSqlite();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const db = sqliteD1(sqlite);
      const matches = await seed(db);
      const successfulIds = inListChunks(matches)[1 - failedChunk];
      const expected = await oracle(db, successfulIds);
      let chunk = 0;
      let failed!: () => void;
      const failureStarted = new Promise<void>((resolve) => { failed = resolve; });
      const wrapped: RelationalStore = { ...db, prepare: (sql) => {
        const index = chunk++;
        const wrap = (statement: PreparedStatement): PreparedStatement => ({ ...statement,
          bind: (...params) => wrap(statement.bind(...params)),
          all: async <T,>() => {
            if (index === failedChunk) { failed(); throw new Error('receipt unavailable'); }
            await gate;
            return statement.all<T>();
          },
        });
        return wrap(db.prepare(sql));
      } };
      const observations: SemanticHitCounts[] = [];
      let answered = false;
      const answer = semanticHits(wrapped, SCOPE, semantic(matches), [1, 0], { topK: 100, observe: (n) => observations.push(n) })
        .then(() => { throw new Error('expected refusal'); }, (error: unknown) => { answered = true; return { error, counts: observations.at(-1) }; });
      await failureStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const premature = answered;
      release();
      const result = await answer;
      expect(premature).toBe(false);
      expect(result.error).toMatchObject({ message: 'receipt unavailable' });
      expect(result.counts).toEqual({ rawMatches: matches.length, joinedHits: expected.length, filteredHits: expected.length });
    } finally { release(); sqlite.close(); }
  });
}
