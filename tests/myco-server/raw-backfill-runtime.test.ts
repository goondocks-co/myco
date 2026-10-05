import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { Miniflare } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { RAW_BACKFILL_BATCH, RAW_BACKFILL_BUDGET, rawBackfill } from '@myco-server-worker/core/raw-backfill.js';
import { PROCESSED_FIELDS } from '@myco-server-worker/core/processed-resources.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteD1 } from './helpers/d1.js';
import { historicalBackfillSql } from './helpers/raw-backfill-fixture.js';

async function assertPageSeeks(db: RelationalStore): Promise<void> {
  const sources = [
    { table: 'blobs', id: 'key' }, { table: 'transcripts', id: 'transcript_id' }, { table: 'events', id: 'event_id' },
    ...Object.values(PROCESSED_FIELDS),
  ];
  const stopped = new Error('stop before the page commit');
  for (const [source, { table, id }] of sources.entries()) {
    const rows = (await db.prepare(`SELECT project_id, ${id} AS resource_id FROM ${table} ORDER BY project_id, ${id}`)
      .all<{ project_id: string; resource_id: string }>()).results;
    expect(rows.length).toBeGreaterThan(0);
    const cursors = [{ project_id: '', resource_id: '' }, rows[Math.floor(rows.length / 2)]!, rows[Math.floor(rows.length * .9)]!];
    for (const cursor of cursors) {
      await db.prepare('UPDATE raw_provenance_backfill SET source = ?, cursor_project = ?, cursor_id = ?, complete = 0 WHERE id = 1')
        .bind(source, cursor.project_id, cursor.resource_id).run();
      let selected = false;
      const observe = (sql: string, statement: PreparedStatement, values: unknown[] = []): PreparedStatement => ({
        ...statement,
        bind: (...bound) => observe(sql, statement.bind(...bound), bound),
        first: <T,>() => statement.first<T>(),
        run: () => statement.run(),
        all: async <T = Record<string, unknown>>() => {
          const result = await statement.all<T>();
          if (sql.startsWith('SELECT s.project_id,')) {
            selected = true;
            const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all<{ detail: string }>()).results;
            expect(plan.some(row => row.detail.startsWith('SEARCH s USING')), `${table}: ${JSON.stringify(plan)}`).toBe(true);
            expect(plan.some(row => row.detail.startsWith('SCAN s')), `${table}: ${JSON.stringify(plan)}`).toBe(false);
            const previous = await db.prepare(`SELECT s.project_id, s.${id} AS resource_id FROM ${table} s
              WHERE (s.project_id > ? OR (s.project_id = ? AND s.${id} > ?)) ORDER BY s.project_id, s.${id} LIMIT ?`)
              .bind(cursor.project_id, cursor.project_id, cursor.resource_id, RAW_BACKFILL_BATCH).all<T>();
            expect(result.results).toEqual(previous.results);
          }
          return result;
        },
      });
      await expect(rawBackfill({ prepare: sql => observe(sql, db.prepare(sql)), batch: async () => { throw stopped; } }, 42,
        { budget: { calls: 6, wallMs: 2_000 } })).rejects.toBe(stopped);
      expect(selected).toBe(true);
    }
  }
  await db.prepare("UPDATE raw_provenance_backfill SET source = 0, cursor_project = '', cursor_id = '', complete = 0 WHERE id = 1").run();
}

it('workerd D1 and native SQLite produce identical bounded backfill runs', async () => {
  const bundle = await Bun.build({ entrypoints: [`${import.meta.dir}/../../packages/myco-server/src/core/raw-backfill.ts`], format: 'esm', target: 'browser' });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
  const mf = new Miniflare({ modules: [
    { type: 'ESModule', path: 'worker.js', contents: `import { RAW_BACKFILL_BUDGET, rawBackfill } from './backfill.js';
      export default { async fetch(request, env) {
        const measurements = []; const pages = []; let pageStart = 0; let source = null; let rows = 0;
        let statements = 0;
        const observe = (s) => ({ bind: (...v) => observe(s.bind(...v)),
          first: async () => { statements++; pageStart = Date.now(); const r = await s.first(); source = r?.source; return r; },
          all: async () => { statements++; const r = await s.all(); measurements.push(r.meta.duration); rows = r.results.length; return r; },
          run: () => s.run(), statement: s });
        const db = { prepare: sql => observe(env.DB.prepare(sql)), batch: async ss => {
          statements += ss.length;
          const r = await env.DB.batch(ss.map(s => s.statement));
          measurements.push(...r.map(r => r.meta.duration)); pages.push({ source, rows, elapsed: Date.now() - pageStart, queryMs: Math.max(...r.map(r => r.meta.duration)) }); return r;
        }};
        try { const start = Date.now(); const result = await rawBackfill(db, 42);
          return Response.json({ result, elapsed: Date.now() - start, statements, measurements, pages }); }
        catch(error) { return Response.json({ error: String(error.stack) }, { status: 500 }); }
      }};` },
    { type: 'ESModule', path: 'backfill.js', contents: await bundle.outputs[0]!.text() },
  ], compatibilityDate: '2026-08-01', d1Databases: ['DB'] });
  const native = new Database(':memory:');
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS.filter(s => s.version < 71)) {
      await d1.batch(step.statements.map(sql => d1.prepare(sql)));
      for (const sql of step.statements) native.exec(sql);
    }
    const events = process.env.MYCO_BACKFILL_MEASURE === '1' ? 340_000 : 10_000;
    for (const sql of historicalBackfillSql(0, undefined, undefined, undefined, events)) {
      await d1.prepare(sql).run(); native.exec(sql);
    }
    const migration = SCHEMA_STEPS.find(s => s.version === 71)!;
    await d1.batch(migration.statements.map(sql => d1.prepare(sql)));
    for (const sql of migration.statements) native.exec(sql);
    await assertPageSeeks(sqliteD1(native));
    await assertPageSeeks(d1);
    let done = false;
    let nativeDone = false;
    let nativeChanged = 0;
    let d1Changed = 0;
    const samples: Array<{ elapsed: number; statements: number; pages: Array<{ source: number; rows: number; elapsed: number; queryMs: number }> }> = [];
    const runs = events === 340_000 ? 4_000 : 3;
    for (let run = 0; run < runs; run++) {
      const response = await mf.dispatchFetch('http://backfill/');
      const body = await response.json() as { result: { changed: number; more: boolean }; elapsed: number; statements: number; measurements: number[]; pages: Array<{ source: number; rows: number; elapsed: number; queryMs: number }> };
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.statements).toBeLessThanOrEqual(RAW_BACKFILL_BUDGET.calls);
      d1Changed += body.result.changed;
      if (!nativeDone) {
        const result = await rawBackfill(sqliteD1(native), 42);
        nativeChanged += result.changed;
        nativeDone = !result.more;
      }
      samples.push(body);
      if (!body.result.more) { done = true; break; }
    }
    if (events === 340_000) {
      const summary = (values: number[]) => { const sorted = values.toSorted((a, b) => a - b); return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1) }; };
      console.info('BACKFILL_MEASURE ' + JSON.stringify({ runs: samples.length, runMs: summary(samples.map(s => s.elapsed)), maxStatements: Math.max(...samples.map(s => s.statements)),
        sources: Array.from({ length: 9 }, (_, source) => { const pages = samples.flatMap(s => s.pages).filter(p => p.source === source); return { source, pages: pages.length, pageMs: summary(pages.map(p => p.elapsed)), queryMs: summary(pages.map(p => p.queryMs)) }; }) }));
      if (process.env.MYCO_BACKFILL_EVIDENCE) fs.writeFileSync(process.env.MYCO_BACKFILL_EVIDENCE, JSON.stringify(samples));
    }
    expect(done).toBe(true);
    for (let run = 0; !nativeDone && run < runs; run++) {
      const result = await rawBackfill(sqliteD1(native), 42);
      nativeChanged += result.changed;
      nativeDone = !result.more;
    }
    expect(nativeDone).toBe(true);
    expect(d1Changed).toBe(nativeChanged);
    for (const table of ['raw_resources', 'raw_credentials', 'processed_resources', 'raw_provenance_backfill']) {
      expect((await d1.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results).toEqual(native.query<Record<string, unknown>, []>(`SELECT * FROM ${table} ORDER BY rowid`).all());
    }
  } finally { native.close(); await mf.dispose(); }
}, 240_000);
