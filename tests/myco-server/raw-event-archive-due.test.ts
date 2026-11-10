import { describe, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { archiveRawSources } from '@myco-server-worker/core/raw-archive.js';
import { eventContent } from '@myco-server-worker/core/event-content.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { schemaD1Root } from './helpers/schema-template.js';
import { measuredStore } from './helpers/read-budget.js';
import { memoryBlobStore, recordingLimiter, sqliteEnv } from './helpers/fixtures.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { drainSessionDeletions } from './helpers/session-deletion.js';

const NOW = Date.now();
const OLD = NOW - 120 * 86_400_000;
const PROJECT = 'proj_1';

function sessionOf(f: ReturnType<typeof sqliteEnv>, id: string) {
  f.sqlite.query(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES(?,?,'m','token',1,1)`).run(PROJECT, id);
}
function eventOf(f: ReturnType<typeof sqliteEnv>, id: string, session: string, received: number, created = 1) {
  f.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,payload_bytes,raw_revision)
    VALUES(?,?,?,'token','notification','cli',?,?,?,?,7,1)`).run(PROJECT, id, session, `{"body":"${id}"}`, id.padEnd(64, '0'), created, received);
}
const format = (f: ReturnType<typeof sqliteEnv>, id: string) => (f.sqlite.query('SELECT payload_format AS format FROM events WHERE event_id=?').get(id) as { format: string }).format;

describe('hot event archive due work', () => {
  it('archives a due event in the first pass no matter how many young rows sit before it in session order', async () => {
    const f = sqliteEnv();
    f.sqlite.run(`UPDATE raw_archive_state SET phase=2 WHERE id=1`);
    sessionOf(f, 'aaa-young');
    sessionOf(f, 'zzz-due');
    for (let index = 0; index < 400; index += 1) eventOf(f, `young-${index}`, 'aaa-young', NOW);
    eventOf(f, 'due-1', 'zzz-due', OLD);
    let archived = 0;
    for (let pass = 0; pass < 2 && archived === 0; pass += 1) archived = await archiveRawSources(f.serverEnv, NOW, 90);
    expect(archived).toBe(1);
    expect(format(f, 'due-1')).toBe('archived');
    expect(format(f, 'young-0')).toBe('inline');
    expect(await eventContent(f.serverEnv, PROJECT, 'due-1')).toBe('{"body":"due-1"}');
  });

  it('passes by a session being deleted, archives the session behind it, and leaves its hot events to the deletion job', async () => {
    const f = sqliteEnv();
    f.sqlite.run(`UPDATE raw_archive_state SET phase=2 WHERE id=1`);
    sessionOf(f, 'deleted');
    sessionOf(f, 'kept');
    for (let index = 0; index < 3; index += 1) eventOf(f, `deleted-${index}`, 'deleted', OLD);
    eventOf(f, 'kept-1', 'kept', OLD + 1);
    expect(await tombstoneSession(f.serverEnv, { projectId: PROJECT }, 'deleted', 'mem', NOW, 'asked')).not.toBeNull();
    let archived = 0;
    for (let pass = 0; pass < 4 && archived === 0; pass += 1) archived = await archiveRawSources(f.serverEnv, NOW, 90);
    expect(archived).toBe(1);
    expect(format(f, 'kept-1')).toBe('archived');
    expect(format(f, 'deleted-0')).toBe('inline');
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM archive_bundles WHERE session_id='deleted'`).get()).toEqual({ n: 0 });
    await drainSessionDeletions(f.serverEnv, NOW);
    expect(f.sqlite.query(`SELECT state FROM session_deletion_jobs WHERE session_id='deleted'`).get()).toEqual({ state: 'complete' });
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id='deleted'`).get()).toEqual({ n: 0 });
  });

  it('refuses a bundle whose session is deleted after the pass selected it, and the event stays for the job', async () => {
    const f = sqliteEnv();
    f.sqlite.run(`UPDATE raw_archive_state SET phase=2 WHERE id=1`);
    sessionOf(f, 'late');
    eventOf(f, 'late-1', 'late', OLD);
    const db = f.serverEnv.db;
    let tombstoned = false;
    const env = { ...f.serverEnv, db: { ...db, batch: async (statements: Parameters<typeof db.batch>[0]) => {
      if (!tombstoned && statements.some(statement => (statement as { sql?: string }).sql?.includes('UPDATE raw_event_archive_state'))) {
        tombstoned = true;
        f.sqlite.run(`INSERT INTO session_tombstones(project_id,session_id,reason,created_at,created_by) VALUES(?,'late','asked',1,'mem')`, [PROJECT]);
      }
      return db.batch(statements);
    } } };
    await expect((async () => { for (let pass = 0; pass < 4 && !tombstoned; pass += 1) await archiveRawSources(env, NOW, 90); })()).rejects.toThrow();
    expect(tombstoned).toBe(true);
    expect(format(f, 'late-1')).toBe('inline');
    expect(f.sqlite.query(`SELECT COUNT(*) AS n FROM archive_bundles`).get()).toEqual({ n: 0 });
  });

  it('never archives a body already held whole in the object store, which stays readable', async () => {
    const f = sqliteEnv();
    f.sqlite.run(`UPDATE raw_archive_state SET phase=2 WHERE id=1`);
    sessionOf(f, 's');
    eventOf(f, 'stored', 's', OLD);
    f.sqlite.run(`UPDATE events SET payload_format='blob' WHERE event_id='stored'`);
    expect(await archiveRawSources(f.serverEnv, NOW, 90)).toBe(0);
    expect(await archiveRawSources(f.serverEnv, NOW, 90)).toBe(0);
    expect(format(f, 'stored')).toBe('blob');
  });

  it('passes a held session by the cursor and archives it after the cursor wraps', async () => {
    const f = sqliteEnv();
    f.sqlite.run(`UPDATE raw_archive_state SET phase=2 WHERE id=1`);
    sessionOf(f, 'held');
    sessionOf(f, 'free');
    eventOf(f, 'held-1', 'held', OLD - 1);
    eventOf(f, 'free-1', 'free', OLD);
    // Learning is on and only the free session has a published document, so the first session is held.
    f.sqlite.run(`INSERT INTO session_documents(project_id,session_id,state,generation,updated_at,last_record_at) VALUES('${PROJECT}','free','live',1,1,1)`);
    f.sqlite.run(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')`);
    let total = 0;
    for (let pass = 0; pass < 6 && format(f, 'free-1') === 'inline'; pass += 1) total += await archiveRawSources(f.serverEnv, NOW, 90);
    expect(format(f, 'free-1')).toBe('archived');
    expect(total).toBe(1);
    expect(format(f, 'held-1')).toBe('inline');
    f.sqlite.run(`DELETE FROM deployment_settings WHERE leaf='agent.scheduled_tasks_enabled'`);
    for (let pass = 0; pass < 8 && format(f, 'held-1') === 'inline'; pass += 1) await archiveRawSources(f.serverEnv, NOW, 90);
    expect(format(f, 'held-1')).toBe('archived');
  });

  it('keeps the cursor past more than a page of held rows while due rows in separate sessions archive', async () => {
    const f = sqliteEnv();
    f.sqlite.run(`UPDATE raw_archive_state SET phase=2 WHERE id=1`);
    f.sqlite.run(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')`);
    sessionOf(f, 'held');
    for (let index = 0; index < 45; index += 1) eventOf(f, `held-${index}`, 'held', OLD - 1000 + index);
    const due = 8;
    for (let index = 0; index < due; index += 1) {
      sessionOf(f, `free-${index}`);
      f.sqlite.run(`INSERT INTO session_documents(project_id,session_id,state,generation,updated_at,last_record_at) VALUES('${PROJECT}','free-${index}','live',1,1,1)`);
      eventOf(f, `free-${index}`, `free-${index}`, OLD + index);
    }
    const archivedCount = () => (f.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE payload_format='archived'`).get() as { n: number }).n;
    let passes = 0;
    while (archivedCount() < due && passes < 30) { await archiveRawSources(f.serverEnv, NOW, 90); passes += 1; }
    expect(archivedCount()).toBe(due);
    // Three passes clear the held pages, then each due row is one pass; a cursor that rewinds pays the held pages again for every row.
    expect(passes).toBeLessThanOrEqual(3 + due);
    expect(format(f, 'held-0')).toBe('inline');
  });

  it('costs the same D1 rows to find nothing due at 1,000 and 20,000 hot young events', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
    try {
      const db = await mf.getD1Database('DB');
      await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?, ?, 1)').bind(PROJECT, PROJECT).run();
      await db.prepare(`UPDATE raw_archive_state SET phase=2 WHERE id=1`).run();
      const measured = measuredStore(db);
      const env = { ...serverEnvFromBindings({ MYCO_DB: measured.db, BUCKET: memoryBlobStore(), SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() }), afterResponse: () => {} };
      const reads: number[] = [];
      let seeded = 0;
      for (const size of [1_000, 20_000]) {
        await db.prepare(`WITH RECURSIVE seq(i) AS (SELECT ${seeded + 1} UNION ALL SELECT i+1 FROM seq WHERE i<${size})
          INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,payload_bytes,raw_revision)
          SELECT ?1,'young-'||i,'s','token','notification','cli','{}',printf('%064d',i),i,${NOW},2,1 FROM seq`).bind(PROJECT).run();
        seeded = size;
        measured.reset();
        await archiveRawSources(env, NOW, 90);
        reads.push(measured.reads());
      }
      expect(reads[1]).toBe(reads[0]);
    } finally { await mf.dispose(); }
  });
});
