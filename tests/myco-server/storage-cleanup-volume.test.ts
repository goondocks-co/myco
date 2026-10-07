import { expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { eventContent } from '@myco-server-worker/core/event-content.js';
import { storageCleanup, storageCleanupPending } from '@myco-server-worker/core/storage-cleanup.js';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { archiveRawSources } from '@myco-server-worker/core/raw-archive.js';
import { seedCredential } from './helpers/d1.js';
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

it('reduces occupied record and index bytes for a representative event and input distribution', async () => {
  const rig = sqliteEnv();
  try {
    const now = Date.now();
    seedCredential(rig.sqlite, { id: TOKEN, memberId: 'm'.repeat(21), machineId: 'c'.repeat(17), hash: '0'.repeat(64) });
    rig.sqlite.query('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,0)').run(PROJECT, 'volume sample');
    rig.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES(?,?,?,?,?,?)`).run(PROJECT, SESSION, 'synthetic', TOKEN, now, now);

    const trigger = rig.sqlite.query(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='events_raw_archive_queue'`)
      .get() as { sql: string } | null;
    if (trigger) rig.sqlite.exec('DROP TRIGGER events_raw_archive_queue');
    const insertEvent = rig.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,
      envelope_hash,created_at,received_at,payload_bytes,producer_adapter)
      VALUES(?,?,?,?,'response','import',?,?,?,?,?,'transcript-parse')`);
    const eventIds: string[] = [];
    for (const cohort of EVENT_COHORTS) {
      for (let n = 0; n < cohort.rows; n += 1) {
        const id = uuid(30_000 + eventIds.length);
        const prefix = JSON.stringify({ text: '' });
        const payload = JSON.stringify({ text: id + 'x'.repeat(cohort.bytes - prefix.length - id.length) });
        expect(new TextEncoder().encode(payload).byteLength).toBe(cohort.bytes);
        insertEvent.run(PROJECT, id, SESSION, TOKEN, payload, await sha256Hex(`envelope-${id}`), now, now, cohort.bytes);
        eventIds.push(id);
      }
    }
    expect(rig.sqlite.query(`SELECT COUNT(DISTINCT raw_revision) AS revisions FROM events WHERE project_id=? AND session_id=?`)
      .get(PROJECT, SESSION)).toEqual({ revisions: EVENT_COUNT });
    if (trigger) rig.sqlite.exec(trigger.sql);

    const insertInput = rig.sqlite.query(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,input,
      success,created_at,token_id,received_at) VALUES(?,?,?,?,'Edit',?,1,?,?,?)`);
    let inputNumber = 0;
    for (const cohort of INPUT_COHORTS) {
      for (let n = 0; n < cohort.rows; n += 1) {
        const input = 'x'.repeat(cohort.bytes);
        insertInput.run(PROJECT, uuid(40_000 + inputNumber), SESSION, eventIds[inputNumber], input, now, TOKEN, now);
        inputNumber += 1;
      }
    }
    rig.sqlite.exec('DELETE FROM storage_cleanup_queue');

    const measure = () => occupiedStorage(rig.sqlite);
    const before = measure();
    for (let pass = 0; pass < EVENT_COUNT + 3 &&
      (rig.sqlite.query('SELECT phase FROM raw_archive_state WHERE id=1').get() as { phase: number }).phase < 2; pass += 1) {
      await archiveRawSources(rig.serverEnv, now, 365);
    }
    expect(rig.sqlite.query('SELECT phase FROM raw_archive_state WHERE id=1').get()).toEqual({ phase: 2 });
    const phases: Array<Record<string,number>>=[];
    for(const [phase,label] of [[0,'tool-input'],[1,'event']] as const){
      const phaseBefore=measure();
      const countBefore=(rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get() as {converted_rows:number}).converted_rows;
      const bundlesBefore=(rig.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get() as {n:number}).n;
      for(let pass=0;pass<EVENT_COUNT*4 && (rig.sqlite.query('SELECT phase FROM storage_cleanup_state').get() as {phase:number}).phase===phase;pass++){
        await storageCleanup(rig.serverEnv,now,{clock:()=>
          (rig.sqlite.query('SELECT phase FROM storage_cleanup_state').get() as {phase:number}).phase>phase?2001:0});
      }
      const phaseAfter=measure();
      const rows=(rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get() as {converted_rows:number}).converted_rows-countBefore;
      const bundles=(rig.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get() as {n:number}).n-bundlesBefore;
      const result={phase,rows,bundles,entriesPerBundle:rows/bundles,netBytes:phaseAfter.bytes-phaseBefore.bytes,
        netBytesPerRow:(phaseAfter.bytes-phaseBefore.bytes)/rows};
      phases.push(result);
      console.info(`storage cleanup phase ${label}: ${JSON.stringify(result)}`);
      expect(rows).toBeGreaterThan(0);
      expect(result.entriesPerBundle).toBeGreaterThanOrEqual(phase===0?12:20);
      expect(result.netBytesPerRow).toBeLessThan(0);
    }
    for (let pass = 0; pass < EVENT_COUNT * 4 && await storageCleanupPending(rig.db); pass += 1) {
      await storageCleanup(rig.serverEnv, now);
    }
    expect(await storageCleanupPending(rig.db)).toBe(false);
    const after = measure();
    const tables = new Set([...before.byTable.keys(), ...after.byTable.keys()]);
    const deltas = Object.fromEntries([...tables].map(name => [name,
      (after.byTable.get(name) ?? 0) - (before.byTable.get(name) ?? 0)]));
    const changedTables = Object.fromEntries(Object.entries(deltas).filter(([, bytes]) => bytes !== 0));
    const metadataAdded = Object.entries(deltas).filter(([name, bytes]) =>
      name !== 'events' && name !== 'tool_calls' && bytes > 0).reduce((sum, [, bytes]) => sum + bytes, 0);
    const netBytes = after.bytes - before.bytes;
    const projectedPopulationNetBytes = Math.round(netBytes * POPULATION_EVENTS / EVENT_COUNT);
    const state = rig.sqlite.query('SELECT converted_rows,cleared_bytes,metadata_added_bytes FROM storage_cleanup_state WHERE id=1')
      .get() as { converted_rows: number; cleared_bytes: number; metadata_added_bytes: number };
    console.info(`storage cleanup representative volume: ${JSON.stringify({
      phases, cohorts: EVENT_COHORTS, events: EVENT_COUNT, inputCohorts: INPUT_COHORTS, inputs: INPUT_COUNT,
      clearedBytes: state.cleared_bytes,
      reportedMetadataBytes: state.metadata_added_bytes, reportedNetBytes: state.metadata_added_bytes - state.cleared_bytes,
      metadataAdded, netRepresentationOverheadBytes: state.cleared_bytes + netBytes,
      netBytes, projectedPopulationNetBytes,
      before: { bytes: before.bytes, occupiedPageBytes: before.page_bytes, pages: before.pages, free: before.free },
      after: { bytes: after.bytes, occupiedPageBytes: after.page_bytes, pages: after.pages, free: after.free }, changedTables,
    })}`);
    const retained = (rig.sqlite.query('SELECT COUNT(*) AS n FROM storage_cleanup_omissions').get() as {n:number}).n;
    expect(state.converted_rows + retained).toBe(EVENT_COUNT + INPUT_COUNT);
    expect(state.metadata_added_bytes).toBeGreaterThan(0);
    expect(state.metadata_added_bytes - state.cleared_bytes).toBeLessThan(0);
    expect(Object.values(deltas).reduce((sum, bytes) => sum + bytes, 0)).toBe(netBytes);
    expect(deltas.raw_resources).toBeGreaterThan(0);
    expect(metadataAdded).toBeGreaterThan(0);
    expect(netBytes).toBeLessThan(0);
    expect(after.page_bytes).toBeLessThan(before.page_bytes);
    expect(after.free).toBeGreaterThan(before.free);
  } finally {
    rig.sqlite.close();
  }
});

it('reduces occupied bytes on the tool-input-only dogfood cohorts with sparse eligible identities',async()=>{
  const rig=sqliteEnv();
  try{
    const now=Date.now();let number=0;
    const insert=rig.sqlite.query(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,tool_name,input,
      success,created_at,token_id,received_at) VALUES('proj_1',?,'input-only',?,'Read',?,1,?,'token',?)`);
    const event=rig.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      VALUES('proj_1',?,'input-only','token','tool.use','cli','{}','hash',?,?)`);
    for(const cohort of INPUT_COHORTS)for(let n=0;n<cohort.rows;n++){
      for(let sparse=0;sparse<10;sparse++){
        const id=uuid(50000+number);event.run(id,number,now);
        insert.run(id,id,'x'.repeat(sparse===0?cohort.bytes:100),number++,now);
      }
    }
    rig.sqlite.exec('DELETE FROM storage_cleanup_queue');
    const before=occupiedStorage(rig.sqlite);
    for(let pass=0;pass<300&&await storageCleanupPending(rig.db);pass++)await storageCleanup(rig.serverEnv,now);
    expect(await storageCleanupPending(rig.db)).toBe(false);
    const after=occupiedStorage(rig.sqlite);
    const {n:bundles}=rig.sqlite.query('SELECT COUNT(*) AS n FROM archive_bundles').get() as {n:number};
    const {converted_rows:rows}=rig.sqlite.query('SELECT converted_rows FROM storage_cleanup_state').get() as {converted_rows:number};
    const result={phase:0,rows,bundles,entriesPerBundle:rows/bundles,netBytes:after.bytes-before.bytes,
      netBytesPerRow:(after.bytes-before.bytes)/rows};
    console.info(`storage cleanup tool-input-only volume: ${JSON.stringify(result)}`);
    expect(rows).toBe(INPUT_COUNT);
    expect(result.entriesPerBundle).toBeGreaterThanOrEqual(12);
    expect(result.netBytesPerRow).toBeLessThan(0);
    expect(after.page_bytes).toBeLessThan(before.page_bytes);
  }finally{rig.sqlite.close();}
});

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
    expect(state.cleared_bytes).toBe(bodies.reduce((sum, row) => sum + row.bytes - 2, 0));
    expect(rig.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id='volume-history' AND payload='{}' AND payload_format='archived'`).get())
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
