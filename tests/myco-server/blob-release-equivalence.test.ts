import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { BLOB_REFERENCES } from '@myco-server-worker/core/blob-references.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { decideRecordedBlobs } from '@myco-server-worker/db/storage/release-queue.js';
import { recordCurrent } from './helpers/release-now.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';

const P = 'proj_release';
const OTHER = 'proj_other';
const GENERATION = '00000000-0000-4000-8000-000000000001';
const OLD_GENERATION = '00000000-0000-4000-8000-000000000002';
const key = (n: number) => n.toString(16).padStart(64, '0');
const holderInserts = [
  `INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,blob_key,content_hash,status,created_at,updated_at,token_id,received_at)
    VALUES(?,'plan','session','event','machine',?,'hash','active',1,1,'credential',1)`,
  `INSERT INTO attachments(project_id,attachment_id,session_id,event_id,blob_key,media_type,byte_size,created_at,token_id,received_at)
    VALUES(?,'attachment','session','event',?,'text/plain',1,1,'credential',1)`,
  `INSERT INTO transcript_segments(project_id,transcript_id,base_offset,length,blob_key,event_id,created_at,received_at,token_id)
    VALUES(?,'transcript',0,1,?,'segment',1,1,'credential')`,
  `INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,blob_key,created_at,received_at)
    VALUES(?,'compaction','session','credential','compaction.pre','cli','{}','hash',?,1,1)`,
  `INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
    VALUES(?,'input','session','credential','tool.use','cli',json_object('blob',?),'hash',1,1)`,
  `INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
    VALUES(?,'output','session','credential','tool.use','cli',json_object('outputBlob',?),'hash',1,1)`,
  `INSERT INTO archive_bundles(project_id,session_id,token_id,event_id,envelope_hash,archive_key,receipt_key,digest,size,version,entry_count)
    VALUES(?,'session','credential','event','hash',?,'other-receipt','digest',1,1,1)`,
  `INSERT INTO archive_bundles(project_id,session_id,token_id,event_id,envelope_hash,archive_key,receipt_key,digest,size,version,entry_count)
    VALUES(?,'session','credential','event','hash','other-archive',?,'digest',1,1,1)`,
  `INSERT INTO raw_archive_refs(project_id,source_kind,source_id,session_id,archive_key,size,received_at,token_id,disposition,eligible_at)
    VALUES(?,'transcript','archive','session',?,1,1,'credential','archived',1)`,
  `INSERT INTO raw_archive_refs(project_id,source_kind,source_id,session_id,receipt_key,size,received_at,token_id,disposition,eligible_at)
    VALUES(?,'transcript','receipt','session',?,1,1,'credential','archived',1)`,
  `INSERT INTO registered_content_proofs(project_id,source_kind,source_id,key,event_id,envelope_hash,session_id,digest,size,verified_at,durable,generation)
    VALUES(?,'tool-input','proof',?,'event','hash','session','digest',1,1,1,'${GENERATION}')`,
  `INSERT INTO run_bodies(project_id,run_id,body_kind,item_id,key,size,moved_at)
    VALUES(?,'run','instruction',0,?,1,1)`,
] as const;

async function seed(db: RelationalStore): Promise<string[]> {
  for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare(`INSERT INTO projects(project_id,name,created_at) VALUES(?,'release',1),(?,'other',1)`).bind(P, OTHER),
    db.prepare(`INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)`),
    db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at) VALUES(?,'run','agent','task','completed',1)`).bind(P),
    db.prepare(`INSERT INTO members(id,label,created_at) VALUES('member','member',1)`),
    db.prepare(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES('credential','member','machine','hash',1,99999999,'credential',1)`),
    db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES(?,'session','machine','credential',1,1),(?,'session','machine','credential',1,1)`).bind(P, OTHER),
    ...Array.from({ length: holderInserts.length + 4 }, (_, n) => db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
      VALUES(?,?,1,'text/plain','credential',1,?)`).bind(P, key(n), GENERATION)),
    db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
      VALUES(?,?,1,'text/plain','credential',1,?)`).bind(OTHER, key(holderInserts.length + 0), GENERATION),
    ...holderInserts.map((sql, n) => db.prepare(sql).bind(P, key(n))),
    db.prepare(holderInserts[1]).bind(OTHER, key(holderInserts.length + 0)),
    db.prepare(`INSERT INTO attachments(project_id,attachment_id,session_id,event_id,blob_key,media_type,byte_size,created_at,token_id,received_at)
      VALUES(?,'shared','deleted','event',?,'text/plain',1,1,'credential',1)`).bind(P, key(holderInserts.length + 2)),
    db.prepare(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at)
      VALUES(?,'shared','surviving','credential','tool.use','cli',json_object('blob',?),'hash',1,1)`).bind(P, key(holderInserts.length + 2)),
    db.prepare(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,blob_key,created_at,received_at)
      VALUES(?,'projected-tool','deleted','credential','transcript.segment','cli','{}','hash',?,1,1)`).bind(P, key(holderInserts.length + 1)),
    db.prepare(`INSERT INTO object_releases(physical,kind,created_at) VALUES(?,'blob',0)`).bind(blobObjectKey(P, key(0), OLD_GENERATION)),
    db.prepare(`INSERT INTO object_releases(physical,kind,created_at) VALUES(?,'blob',0)`).bind(blobObjectKey(P, key(holderInserts.length + 3), GENERATION)),
    db.prepare(`INSERT INTO recovery_holds(token,acquired_at,holder) VALUES('producer',1,'producer'),('operator',1,'operator')`),
  ]);
  expect(Number(holderInserts.length)).toBe(Number(BLOB_REFERENCES.length));
  return [];
}

async function snapshot(db: RelationalStore) {
  return {
    blobs: (await db.prepare('SELECT project_id,key,generation FROM blobs ORDER BY project_id,key').all()).results,
    journal: (await db.prepare('SELECT physical,kind,created_at FROM object_releases ORDER BY physical').all()).results,
    candidates: (await db.prepare('SELECT project_id,key,created_at FROM blob_release_candidates ORDER BY project_id,key').all()).results,
  };
}

async function exercise(db: RelationalStore, extraKeys: string[]) {
  const pairs = [...Array.from({ length: holderInserts.length + 3 }, (_, n) => ({ projectId: P, key: key(n) })),
    { projectId: OTHER, key: key(holderInserts.length + 0) }, { projectId: P, key: key(holderInserts.length + 0) }, { projectId: P, key: key(100) },
    ...extraKeys.map(key => ({ projectId: P, key }))];
  await db.prepare(`DELETE FROM attachments WHERE project_id=? AND attachment_id='shared'`).bind(P).run();
  await db.batch(await recordCurrent(db, pairs, 2));
  const states = [];
  for (const holder of [null, 'producer', 'operator'] as const) {
    if (holder !== null) await db.prepare(`UPDATE recovery_holds SET released_at=3,release_reason='complete',released_by=? WHERE token=?`).bind(holder, holder).run();
    await decideRecordedBlobs(db, pairs, 4);
    states.push(await snapshot(db));
  }
  expect(states[0]).toEqual(states[1]);
  expect(states[2]!.blobs).toHaveLength(holderInserts.length + extraKeys.length + 4);
  expect(states[2]!.blobs.filter(row => extraKeys.includes(String(row.key)))).toHaveLength(extraKeys.length);
  expect(states[2]!.candidates).toEqual([]);
  expect(states[2]!.journal.map(row => row.physical)).toEqual([
    blobObjectKey(P, key(0), OLD_GENERATION), blobObjectKey(P, key(holderInserts.length + 0), GENERATION),
    blobObjectKey(P, key(holderInserts.length + 3), GENERATION),
  ]);
  expect((await db.prepare(`SELECT key FROM blobs WHERE project_id=? AND key IN (?,?) ORDER BY key`).bind(P, key(1), key(2)).all()).results)
    .toEqual([{ key: key(1) }, { key: key(2) }]);
  expect(await db.prepare('SELECT key FROM blobs WHERE project_id=? AND key=?').bind(P, key(holderInserts.length + 2)).first<{ key: string }>()).toEqual({ key: key(holderInserts.length + 2) });
  expect(await db.prepare('SELECT key FROM blobs WHERE project_id=? AND key=?').bind(P, key(holderInserts.length + 3)).first<{ key: string }>()).toEqual({ key: key(holderInserts.length + 3) });
  await db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    VALUES(?,?,1,'text/plain','credential',1,?)`).bind(P, key(holderInserts.length + 0), OLD_GENERATION).run();
  await decideRecordedBlobs(db, pairs, 5);
  expect((await db.prepare('SELECT generation FROM blobs WHERE project_id=? AND key=?').bind(P, key(holderInserts.length + 0)).first<{ generation: string }>())).toEqual({ generation: OLD_GENERATION });
  await decideRecordedBlobs(db, [], 6);
  return snapshot(db);
}

describe('blob release decisions on native SQLite and local D1', () => {
  it('keeps every catalogue holder, open holds, duplicate pairs and physical generations, identically on both stores', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
      compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
    const native = new Database(':memory:');
    try {
      const stores = [sqliteRelationalStore(native), await mf.getD1Database('DB') as unknown as RelationalStore];
      const seeded = await Promise.all(stores.map(seed));
      const [onNative, onD1] = [await exercise(stores[0]!, seeded[0]!), await exercise(stores[1]!, seeded[1]!)];
      expect(onD1).toEqual(onNative);
    } finally { native.close(); await mf.dispose(); }
  }, 120_000);
});
