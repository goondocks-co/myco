import { expect, it } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { eventContent } from '@myco-server-worker/core/event-content.js';
import { storageCleanup, storageCleanupPending } from '@myco-server-worker/core/storage-cleanup.js';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { sqliteEnv, uuid } from './helpers/fixtures.js';

const ROWS = 24;
const BODY_CHARS = 120_000;

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
    const metadata = () => (rig.sqlite.query(`SELECT SUM(payload) AS bytes FROM dbstat
      WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name IN
        ('blobs','event_content_refs','raw_archive_refs','registered_content_proofs'))`)
      .get() as {bytes:number}).bytes;
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
    const state = rig.sqlite.query('SELECT converted_rows,cleared_bytes FROM storage_cleanup_state WHERE id=1')
      .get() as { converted_rows: number; cleared_bytes: number };
    expect(state.converted_rows).toBe(ROWS);
    expect(state.cleared_bytes).toBe(bodies.reduce((sum, row) => sum + row.bytes - 2, 0));
    expect(rig.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id='volume-history' AND payload='{}' AND payload_format='archived'`).get())
      .toEqual({ n: ROWS });
    const archiveRows = {
      refs: rig.sqlite.query(`SELECT COUNT(*) AS n FROM event_content_refs WHERE session_id='volume-history'`).get(),
      rawRefs: rig.sqlite.query(`SELECT COUNT(*) AS n FROM raw_archive_refs WHERE session_id='volume-history' AND source_kind='event'`).get(),
      proofs: rig.sqlite.query(`SELECT source_kind,COUNT(*) AS n FROM registered_content_proofs
        WHERE session_id='volume-history' GROUP BY source_kind ORDER BY source_kind`).all(),
    };
    expect(archiveRows).toEqual({ refs: { n: ROWS }, rawRefs: { n: ROWS },
      proofs: [{ source_kind: 'event', n: ROWS }, { source_kind: 'receipt', n: ROWS }] });
    expect(await eventContent(rig.serverEnv, 'proj_1', bodies[0]!.id)).toBe(bodies[0]!.payload);
    expect(await eventContent(rig.serverEnv, 'proj_1', bodies.at(-1)!.id)).toBe(bodies.at(-1)!.payload);

    for (let n = 0; n < ROWS; n += 1) {
      const id = uuid(21_000 + n);
      const payload = JSON.stringify({ responseId: id, text: `new capture ${n} ${'y'.repeat(BODY_CHARS + n)}` });
      insert.run(id, 'cli', payload, await sha256Hex(`reuse-${n}`), now, now, new TextEncoder().encode(payload).byteLength);
    }
    const reused = metric();
    console.info(`storage cleanup SQLite pages: ${JSON.stringify({ rows: ROWS, clearedBytes: state.cleared_bytes,
      baseline, before, after, reused, archiveRows, usage:measured.usage,wallMs,cpuMicros:cpu,metadataBytes: metadataAfter-metadataBaseline,
      metadataBytesPerEvent: (metadataAfter-metadataBaseline)/ROWS,
      livePageChange: (after.pages-after.free)-(before.pages-before.free) })}`);
    expect(reused.free).toBeLessThan(after.free);
    expect(reused.pages - after.pages).toBeLessThan(before.pages - baseline.pages);
  } finally {
    rig.sqlite.close();
  }
});
