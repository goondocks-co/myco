import { archivedEventMetadata } from '@myco-server-worker/db/document-tables.js';
import { expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { eventContent } from '@myco-server-worker/core/event-content.js';
import { storageCleanup, storageCleanupPending } from '@myco-server-worker/core/storage-cleanup.js';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';


import { sqliteEnv, uuid } from './helpers/fixtures.js';

const ROWS = 24;
const BODY_CHARS = 120_000;

const EVENT_COHORTS = [
  { rows: 350, bytes: 549 },
  { rows: 190, bytes: 1_470 },
  { rows: 78, bytes: 2_376 },
  { rows: 98, bytes: 3_361 },
  { rows: 261, bytes: 4_895 },
  { rows: 16, bytes: 10_805 },
  { rows: 6, bytes: 26_896 },
  { rows: 1, bytes: 127_417 },
] as const;
const INPUT_COHORTS = [{ rows: 72, bytes: 4_000 }, { rows: 16, bytes: 7_000 }, { rows: 2, bytes: 18_000 }] as const;
const EVENT_COUNT = EVENT_COHORTS.reduce((sum, cohort) => sum + cohort.rows, 0);
const INPUT_COUNT = INPUT_COHORTS.reduce((sum, cohort) => sum + cohort.rows, 0);
const POPULATION_EVENTS = 249_362;
const PROJECT = `proj_${'p'.repeat(32)}`;
const SESSION = 's'.repeat(36);
const TOKEN = 't'.repeat(19);

/** Measures every table and index in the exact database image through a dbstat-enabled SQLite reader. */
function occupiedStorage(sqlite: Database) {
  const result = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', `
import json, sqlite3, sys
db = sqlite3.connect(':memory:')
db.deserialize(sys.stdin.buffer.read())
total = db.execute('SELECT COALESCE(SUM(payload),0), COALESCE(SUM(pgsize),0) FROM dbstat').fetchone()
tables = db.execute('SELECT m.tbl_name, SUM(d.payload) FROM dbstat d JOIN sqlite_master m ON m.name=d.name GROUP BY m.tbl_name').fetchall()
print(json.dumps({'bytes': total[0], 'page_bytes': total[1], 'tables': tables,
  'pages': db.execute('PRAGMA page_count').fetchone()[0],
  'free': db.execute('PRAGMA freelist_count').fetchone()[0]}))
`], { input: sqlite.serialize(), encoding: 'utf8' })) as {
    bytes: number; page_bytes: number; tables: Array<[string, number]>; pages: number; free: number;
  };
  expect(result.pages).toBe((sqlite.query('PRAGMA page_count').get() as { page_count: number }).page_count);
  expect(result.free).toBe((sqlite.query('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count);
  return { ...result, byTable: new Map(result.tables) };
}

/** A capture-sized SQLite sample records the logical clear and SQLite's page reuse separately. */
it('measures exact cleared bytes and page reuse for a dogfood-shaped response history', async () => {
  const rig = sqliteEnv();
  try {
    const now = Date.now();
    rig.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('proj_1','volume-history','machine_1','token',?,?)`).run(now, now);
    const metric = () => {
      const page = rig.sqlite.query('PRAGMA page_count').get() as { page_count: number };
      const free = rig.sqlite.query('PRAGMA freelist_count').get() as { freelist_count: number };
      return { pages: page.page_count, free: free.freelist_count };
    };
    const metadata = () => {
      const measured = occupiedStorage(rig.sqlite);
      return ['blobs', 'archive_bundles', 'raw_resources', 'registered_content_proofs']
        .reduce((bytes, table) => bytes + (measured.byTable.get(table) ?? 0), 0);
    };
    const baseline = metric();
    const metadataBaseline = metadata();
    const bodies: Array<{ id: string; payload: string; bytes: number }> = [];
    const insert = rig.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,
      created_at,received_at,payload_bytes) VALUES('proj_1',?,'volume-history','token','response',?,?,?, ?, ?, ?)`);
    for (let n = 0; n < ROWS; n += 1) {
      const id = uuid(20_000 + n);
      const payload = JSON.stringify({ responseId: id, text: `dogfood response ${n} é🦋 ${'x'.repeat(BODY_CHARS + n)}` });
      const bytes = new TextEncoder().encode(payload).byteLength;
      insert.run(id, 'import', payload, await sha256Hex(`envelope-${n}`), now, now, bytes);
      bodies.push({ id, payload, bytes });
    }
    const before = metric();
    const measured=measuredContentEnv(rig.serverEnv);
    const cpuStart=process.cpuUsage(),wallStart=performance.now();
    for (let pass = 0; pass < ROWS * 5 && await storageCleanupPending(rig.db); pass += 1) {
      await storageCleanup(measured.env, now);
    }
    expect(await storageCleanupPending(rig.db)).toBe(false);
    const cpu=process.cpuUsage(cpuStart),wallMs=performance.now()-wallStart;
    const after = metric();
    expect(after.pages).toBe(before.pages);
    expect(after.free).toBeGreaterThan(before.free);
    const metadataAfter = metadata();
    const metadataBytes = metadataAfter-metadataBaseline;
    const state = rig.sqlite.query('SELECT converted_rows,cleared_bytes FROM storage_cleanup_state WHERE id=1')
      .get() as { converted_rows: number; cleared_bytes: number };
    expect(state.converted_rows).toBe(ROWS);
    expect(state.cleared_bytes).toBe(bodies.reduce((sum, row) => sum + row.bytes - Buffer.byteLength(archivedEventMetadata(JSON.parse(row.payload))), 0));
    expect(rig.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id='volume-history' AND json_extract(payload,'$.text') IS NULL AND payload_format='archived'`).get())
      .toEqual({ n: ROWS });
    const bundleCount = (rig.sqlite.query(`SELECT COUNT(*) AS n FROM archive_bundles WHERE session_id='volume-history'`)
      .get() as { n: number }).n;
    expect(bundleCount).toBeGreaterThan(0);
    expect(bundleCount).toBeLessThanOrEqual(ROWS);
    expect(rig.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id='volume-history'
      AND bundle_id IS NOT NULL AND bundle_entry IS NOT NULL`).get()).toEqual({ n: ROWS });
    expect(rig.sqlite.query(`SELECT source_kind,COUNT(*) AS n FROM registered_content_proofs
      WHERE session_id='volume-history' GROUP BY source_kind ORDER BY source_kind`).all())
      .toEqual([{ source_kind: 'bundle', n: bundleCount }, { source_kind: 'receipt', n: bundleCount }]);
    expect(await eventContent(rig.serverEnv, 'proj_1', bodies[0]!.id)).toBe(bodies[0]!.payload);
    expect(await eventContent(rig.serverEnv, 'proj_1', bodies.at(-1)!.id)).toBe(bodies.at(-1)!.payload);

    for (let n = 0; n < ROWS; n += 1) {
      const id = uuid(21_000 + n);
      const payload = JSON.stringify({ responseId: id, text: `new capture ${n} ${'y'.repeat(BODY_CHARS + n)}` });
      insert.run(id, 'cli', payload, await sha256Hex(`reuse-${n}`), now, now, new TextEncoder().encode(payload).byteLength);
    }
    const reused = metric();
    console.info(`storage cleanup SQLite pages: ${JSON.stringify({ rows: ROWS, clearedBytes: state.cleared_bytes,
      baseline, before, after, reused, bundleCount, usage:measured.usage,wallMs,cpuMicros:cpu,metadataBytes,
      metadataBytesPerEvent: metadataBytes/ROWS,
      metadataMeasurement: 'dbstat payload including indexes from the exact SQLite image',
      livePageChange: (after.pages-after.free)-(before.pages-before.free) })}`);
    expect(reused.free).toBeLessThan(after.free);
    expect(reused.pages - after.pages).toBeLessThan(before.pages - baseline.pages);
  } finally {
    rig.sqlite.close();
  }
});
