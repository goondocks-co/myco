import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { RAW_BACKFILL_BATCH, RAW_BACKFILL_BUDGET, rawBackfill } from '@myco-server-worker/core/raw-backfill.js';
import { LIVE_PROCESSED_FIELDS } from '@myco-server-worker/db/processed-resources.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { sqliteD1 } from './helpers/d1.js';
import { historicalBackfillSql } from './helpers/raw-backfill-fixture.js';
import { measuredStore } from './helpers/read-budget.js';

/**
 * A backfill page costs the same rows read wherever its source's cursor stands: a page late in a source reads no more
 * than a page at its start, so each page seeks to its cursor rather than walking the rows before it.
 */
async function expectCursorIndependentPages(d1: Awaited<ReturnType<Miniflare['getD1Database']>>): Promise<void> {
  const measured = measuredStore(d1);
  const sources = [
    { table: 'blobs', id: 'key' }, { table: 'transcripts', id: 'transcript_id' }, { table: 'events', id: 'event_id' },
    ...Object.values(LIVE_PROCESSED_FIELDS),
  ];
  for (const [source, { table, id }] of sources.entries()) {
    const rows = (await d1.prepare(`SELECT project_id, ${id} AS resource_id FROM ${table} ORDER BY project_id, ${id}`)
      .all<{ project_id: string; resource_id: string }>()).results;
    if (rows.length < RAW_BACKFILL_BATCH * 2) continue;
    const reads: number[] = [];
    for (const cursor of [{ project_id: '', resource_id: '' }, rows[rows.length - RAW_BACKFILL_BATCH - 1]!]) {
      await d1.prepare('UPDATE raw_provenance_backfill SET source = ?, cursor_project = ?, cursor_id = ?, complete = 0 WHERE id = 1')
        .bind(source, cursor.project_id, cursor.resource_id).run();
      measured.reset();
      await rawBackfill(measured.db, 42, { budget: { calls: 6, wallMs: 2_000 } });
      reads.push(measured.reads());
    }
    expect(reads[0], `${table} page at the start read nothing`).toBeGreaterThan(0);
    expect(reads[1], `${table} page late in the source, start ${reads[0]}`).toBeLessThanOrEqual(reads[0]! + RAW_BACKFILL_BATCH);
  }
}

it('workerd D1 and native SQLite produce identical bounded backfill runs', async () => {
  const bundle = await Bun.build({ entrypoints: [`${import.meta.dir}/../../packages/myco-server/src/core/raw-backfill.ts`], format: 'esm', target: 'browser' });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: [
    { type: 'ESModule', path: 'worker.js', contents: `import { RAW_BACKFILL_BUDGET, rawBackfill } from './backfill.js';
      export default { async fetch(request, env) {
        let statements = 0; const measurements = [];
        const db = { prepare: sql => env.DB.prepare(sql), batch: async ss => {
          statements += ss.length;
          const r = await env.DB.batch(ss);
          measurements.push(...r.map(r => r.meta.duration)); return r;
        }};
        try { const start = Date.now(); const result = await rawBackfill(db, 42);
          return Response.json({ result, elapsed: Date.now() - start, statements, measurements }); }
        catch(error) { return Response.json({ error: String(error.stack) }, { status: 500 }); }
      }};` },
    { type: 'ESModule', path: 'backfill.js', contents: await bundle.outputs[0]!.text() },
  ], compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
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
    const SOURCE_TABLES = ['blobs', 'events', 'transcripts', 'transcript_segments', 'plans'] as const;
    const stripEvents = (rows: Record<string, unknown>[], table: string) =>
      table !== 'events' ? rows : rows.map(({ raw_revision: _r, payload_format: _f, content_revision: _c, ...original }) => original);
    const d1Originals = new Map<string, string>();
    const nativeOriginals = new Map<string, string>();
    for (const table of SOURCE_TABLES) {
      d1Originals.set(table, await sha256Hex(JSON.stringify(stripEvents((await d1.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all<Record<string, unknown>>()).results, table))));
      nativeOriginals.set(table, await sha256Hex(JSON.stringify(stripEvents(native.query<Record<string, unknown>, []>(`SELECT * FROM ${table} ORDER BY rowid`).all(), table))));
    }
    let done = false;
    let nativeDone = false;
    let nativeChanged = 0;
    let d1Changed = 0;
    const samples: Array<{ elapsed: number; statements: number; measurements: number[] }> = [];
    const runs = events === 340_000 ? 4_000 : 3;
    for (let run = 0; run < runs; run++) {
      const response = await mf.dispatchFetch('http://backfill/');
      const body = await response.json() as { result: { changed: number; more: boolean }; elapsed: number; statements: number; measurements: number[] };
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
        queryMs: summary(samples.flatMap(s => s.measurements)) }));
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
    for (const table of SOURCE_TABLES) {
      expect(await sha256Hex(JSON.stringify(stripEvents((await d1.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all<Record<string, unknown>>()).results, table)))).toBe(d1Originals.get(table)!);
      expect(await sha256Hex(JSON.stringify(stripEvents(native.query<Record<string, unknown>, []>(`SELECT * FROM ${table} ORDER BY rowid`).all(), table)))).toBe(nativeOriginals.get(table)!);
    }
    await expectCursorIndependentPages(d1);
  } finally { native.close(); await mf.dispose(); }
}, 240_000);
