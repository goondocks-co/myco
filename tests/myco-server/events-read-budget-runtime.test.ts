import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { rawMemberResourceSql } from '@myco-server-worker/core/raw-resources.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';

const PROJECT = 'proj_event_budget';
const BLOB = '0'.repeat(64);
const CONTEXT = { projectId: PROJECT, machineId: 'machine', tokenId: 'credential', bodyBytes: 100, now: 2_000 };
const ROW_READ_LIMIT = 64;
const CORPUS_SIZES = [1_000, 10_000] as const;

it('D1 event admission reads stay bounded as unrelated archive bundles and events grow', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
    await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?, ?, 1)').bind(PROJECT, PROJECT).run();
    await db.prepare("INSERT INTO members(id,label,created_at) VALUES('member','member',1)").run();
    await db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)").run();
    await db.prepare(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES('credential','member','machine','hash',1,99999999,'credential',1)`).run();
    await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES(?,'session','machine','credential',1,1)`).bind(PROJECT).run();
    await db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
      VALUES(?, ?,1,'text/plain','credential',1,'00000000-0000-4000-8000-000000000001')`).bind(PROJECT, BLOB).run();
    const reads: number[] = [];
    for (const size of CORPUS_SIZES) {
      const sequence = `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<${size})`;
      await db.prepare(`${sequence} INSERT OR IGNORE INTO archive_bundles(id,project_id,session_id,token_id,event_id,envelope_hash,archive_key,receipt_key,digest,size,version,entry_count)
        SELECT i,?,'session','credential','archive-event-'||i,'hash','archive-'||i,'receipt-'||i,'digest',1,1,1 FROM seq`).bind(PROJECT).run();
      await db.prepare(`${sequence} INSERT OR IGNORE INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,raw_revision)
        SELECT ?,'seed-'||i,'session','credential','notification','cli','{}','hash',1,1,1 FROM seq`).bind(PROJECT).run();
      const eventId = crypto.randomUUID();
      const planned = await planEventWrite(db as unknown as RelationalStore, CONTEXT, {
        eventId, sessionId: 'session', kind: 'prompt', createdAt: 1_000, channel: 'import',
        producer: { adapter: 'claude-code', version: '1' }, payload: { promptId: crypto.randomUUID(), blob: BLOB, origin: 'user' },
      });
      if (!planned.ok) throw new Error(JSON.stringify(planned));
      const result = await db.batch(planned.write.statements as unknown as Parameters<typeof db.batch>[0]);
      expect(planned.write.interpret(result)).toEqual({ persisted: true, projected: true });
      const rowsRead = result[0]!.meta.rows_read;
      reads.push(rowsRead);
      expect(await db.prepare('SELECT owner_member_id,provenance FROM raw_credentials WHERE token_id=?').bind('credential').first<{ owner_member_id: string; provenance: string }>())
        .toEqual({ owner_member_id: 'member', provenance: 'recorded' });
      expect((await db.prepare('SELECT raw_revision FROM events WHERE project_id=? AND event_id=?').bind(PROJECT, eventId).first<{ raw_revision: number }>())!.raw_revision).toBeGreaterThan(0);
      expect(await db.prepare('SELECT session_id FROM storage_cleanup_queue WHERE project_id=? AND resource_kind=? AND resource_id=?').bind(PROJECT, 'event', eventId).first<{ session_id: string }>())
        .toEqual({ session_id: 'session' });
    }
    console.info('EVENT_INSERT_READ_BUDGET ' + JSON.stringify({ sizes: CORPUS_SIZES, rowsRead: reads }));
    for (const [index, rowsRead] of reads.entries()) {
      expect(rowsRead, `events INSERT at ${CORPUS_SIZES[index]} archive bundles`).toBeLessThanOrEqual(ROW_READ_LIMIT);
    }
    expect(reads[1]).toBe(reads[0]);
    const proof = `SELECT ${rawMemberResourceSql('?', 'blob', '?', '?')} AS admitted`;
    const native = new Database(':memory:');
    try {
      for (const step of SCHEMA_STEPS) for (const sql of step.statements) native.exec(sql);
      const nativePlan = native.query<{ detail: string }, [string, string, string]>(`EXPLAIN QUERY PLAN ${proof}`).all(PROJECT, BLOB, 'member');
      const d1Plan = (await db.prepare(`EXPLAIN QUERY PLAN ${proof}`).bind(PROJECT, BLOB, 'member').all<{ detail: string }>()).results;
      for (const plan of [nativePlan, d1Plan]) {
        const archives = plan.filter(row => row.detail.includes(' a ')).map(row => row.detail);
        expect(archives).toHaveLength(2);
        expect(archives.some(detail => detail.includes('project_id=? AND archive_key=?'))).toBe(true);
        expect(archives.some(detail => detail.includes('project_id=? AND receipt_key=?'))).toBe(true);
      }
    } finally { native.close(); }
    const allowed = (key: string) => db.prepare(`SELECT ${rawMemberResourceSql('?', 'blob', '?', '?')} AS admitted`).bind(PROJECT, key, 'member').first<{ admitted: number }>();
    expect(await allowed(BLOB)).toEqual({ admitted: 1 });
    for (const key of ['archive-1', 'receipt-1']) {
      await db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        VALUES(?, ?,1,'text/plain','credential',1,'00000000-0000-4000-8000-000000000001')`).bind(PROJECT, key).run();
      expect(await allowed(key)).toEqual({ admitted: 0 });
    }
  } finally { await mf.dispose(); }
}, 120_000);
