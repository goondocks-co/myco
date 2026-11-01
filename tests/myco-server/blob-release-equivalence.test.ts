import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { BLOB_REFERENCES, blobHeld } from '@myco-server-worker/core/blob-references.js';
import { blobObjectKey, blobObjectKeySql } from '@myco-server-worker/core/blob-objects.js';
import { blobDecisionStatements, HOLD_OPEN, recordBlobCandidates } from '@myco-server-worker/core/object-release.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { sharedChecks } from '@myco-server-worker/ingest/projections.js';
import { KINDS } from '@myco-server-worker/ingest/kinds.js';

const P = 'proj_release';
const OTHER = 'proj_other';
const GENERATION = '00000000-0000-4000-8000-000000000001';
const OLD_GENERATION = '00000000-0000-4000-8000-000000000002';
const key = (n: number) => n.toString(16).padStart(64, '0');
const PAGE_SQL = `(SELECT json_extract(j.value, '$.p') AS p, json_extract(j.value, '$.k') AS k FROM json_each(?) j)`;

/** The release decision's correlated page predicates, used as the contract baseline. */
function legacyDecision(db: RelationalStore, page: string, now: number): PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO object_releases (physical, kind, created_at)
      SELECT ${blobObjectKeySql('b.project_id', 'b.key', 'b.generation')}, 'blob', ? FROM ${PAGE_SQL} c
      JOIN blobs b ON b.project_id = c.p AND b.key = c.k
      WHERE NOT ${HOLD_OPEN}
        AND EXISTS (SELECT 1 FROM blob_release_candidates rc WHERE rc.project_id = b.project_id AND rc.key = b.key)
        AND NOT (${blobHeld('c.p', 'c.k')})
      ON CONFLICT (physical) DO NOTHING`).bind(now, page),
    db.prepare(`DELETE FROM blobs
      WHERE EXISTS (SELECT 1 FROM ${PAGE_SQL} c WHERE c.p = blobs.project_id AND c.k = blobs.key)
        AND EXISTS (SELECT 1 FROM object_releases r WHERE r.physical = ${blobObjectKeySql('blobs.project_id', 'blobs.key', 'blobs.generation')})`).bind(page),
    db.prepare(`DELETE FROM blob_release_candidates WHERE NOT ${HOLD_OPEN}
      AND EXISTS (SELECT 1 FROM ${PAGE_SQL} c WHERE c.p = blob_release_candidates.project_id AND c.k = blob_release_candidates.key)`).bind(page),
    db.prepare(`SELECT COUNT(*) AS held FROM blob_release_candidates rc
      WHERE EXISTS (SELECT 1 FROM ${PAGE_SQL} c WHERE c.p = rc.project_id AND c.k = rc.key)`).bind(page),
  ];
}

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
] as const;

async function seed(db: RelationalStore): Promise<string[]> {
  for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare(`INSERT INTO projects(project_id,name,created_at) VALUES(?,'release',1),(?,'other',1)`).bind(P, OTHER),
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

async function exercise(db: RelationalStore, decision: typeof blobDecisionStatements, extraKeys: string[]) {
  const pairs = [...Array.from({ length: holderInserts.length + 3 }, (_, n) => ({ projectId: P, key: key(n) })),
    { projectId: OTHER, key: key(holderInserts.length + 0) }, { projectId: P, key: key(holderInserts.length + 0) }, { projectId: P, key: key(100) },
    ...extraKeys.map(key => ({ projectId: P, key }))];
  const page = JSON.stringify(pairs.map(row => ({ p: row.projectId, k: row.key })));
  await db.prepare(`DELETE FROM attachments WHERE project_id=? AND attachment_id='shared'`).bind(P).run();
  await db.batch(recordBlobCandidates(db, pairs, 2));
  const outcomes = [];
  for (const holder of [null, 'producer', 'operator'] as const) {
    if (holder !== null) await db.prepare(`UPDATE recovery_holds SET released_at=3,release_reason='complete',released_by=? WHERE token=?`).bind(holder, holder).run();
    outcomes.push({ result: await db.batch(decision(db, page, 4)), state: await snapshot(db) });
  }
  expect(outcomes[0]!.state).toEqual(outcomes[1]!.state);
  expect(outcomes[2]!.state.blobs).toHaveLength(holderInserts.length + extraKeys.length + 3);
  expect(outcomes[2]!.state.blobs.filter(row => extraKeys.includes(String(row.key)))).toHaveLength(extraKeys.length);
  expect(outcomes[2]!.state.candidates).toEqual([]);
  expect(outcomes[2]!.state.journal.map(row => row.physical)).toEqual([
    blobObjectKey(P, key(0), OLD_GENERATION), blobObjectKey(P, key(holderInserts.length + 0), GENERATION), blobObjectKey(P, key(holderInserts.length + 1), GENERATION),
    blobObjectKey(P, key(holderInserts.length + 3), GENERATION),
  ]);
  expect((await db.prepare(`SELECT key FROM blobs WHERE project_id=? AND key IN (?,?) ORDER BY key`).bind(P, key(1), key(2)).all()).results)
    .toEqual([{ key: key(1) }, { key: key(2) }]);
  expect(await db.prepare('SELECT key FROM blobs WHERE project_id=? AND key=?').bind(P, key(holderInserts.length + 2)).first<{ key: string }>()).toEqual({ key: key(holderInserts.length + 2) });
  expect(await db.prepare('SELECT key FROM blobs WHERE project_id=? AND key=?').bind(P, key(holderInserts.length + 3)).first<{ key: string }>()).toEqual({ key: key(holderInserts.length + 3) });
  await db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    VALUES(?,?,1,'text/plain','credential',1,?)`).bind(P, key(holderInserts.length + 0), OLD_GENERATION).run();
  outcomes.push({ result: await db.batch(decision(db, page, 5)), state: await snapshot(db) });
  expect((await db.prepare('SELECT generation FROM blobs WHERE project_id=? AND key=?').bind(P, key(holderInserts.length + 0)).first<{ generation: string }>())).toEqual({ generation: OLD_GENERATION });
  outcomes.push({ result: await db.batch(decision(db, '[]', 6)), state: await snapshot(db) });
  return outcomes.map(outcome => ({ ...outcome, result: outcome.result.map(row => ({ results: row.results, changes: row.meta.changes })) }));
}

describe('blob release decision contract on native SQLite and local D1', () => {
  it.each(['native', 'D1'] as const)('preserves deletion sets, all catalogue holders, holds, duplicate pairs and physical generations on %s', async (target) => {
    const mf = target === 'D1' ? new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
      compatibilityDate: '2026-07-01', d1Databases: ['OLD', 'NEW'] })) : null;
    const oldNative = new Database(':memory:');
    const newNative = new Database(':memory:');
    try {
      const stores = mf === null ? [sqliteRelationalStore(oldNative), sqliteRelationalStore(newNative)]
        : [await mf.getD1Database('OLD') as unknown as RelationalStore, await mf.getD1Database('NEW') as unknown as RelationalStore];
      const extraKeys = await Promise.all(stores.map(seed));
      const baseline = await exercise(stores[0]!, legacyDecision, extraKeys[0]!);
      expect(await exercise(stores[1]!, blobDecisionStatements, extraKeys[1]!)).toEqual(baseline);
    } finally { oldNative.close(); newNative.close(); await mf?.dispose(); }
  }, 120_000);

  it('seeks blob and candidate primary keys for every decision and blob-presence read on both targets', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
      compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
    const native = new Database(':memory:');
    try {
      const d1 = await mf.getD1Database('DB');
      const stores = [sqliteRelationalStore(native), d1 as unknown as RelationalStore];
      for (const store of stores) {
        await seed(store);
        const capture: Array<{ sql: string; params: unknown[] }> = [];
        const observer: RelationalStore = { ...store, prepare: sql => ({
          ...store.prepare(sql), bind: (...params) => { capture.push({ sql, params }); return store.prepare(sql).bind(...params); },
        }) };
        blobDecisionStatements(observer, JSON.stringify([{ p: P, k: key(holderInserts.length + 0) }]), 5);
        const details = [];
        for (const statement of capture) details.push((await store.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.params)
          .all<{ detail: string }>()).results.map(row => row.detail));
        for (const plan of details) expect(plan.some(detail => /^SCAN (blobs|blob_release_candidates|rc|b)\b/.test(detail))).toBe(false);
        expect(details[1]!.some(detail => detail.includes('SEARCH blobs USING INDEX') && detail.includes('project_id=? AND key=?'))).toBe(true);
        expect(details[2]!.some(detail => detail.includes('SEARCH blob_release_candidates') && detail.includes('project_id=? AND key=?'))).toBe(true);
        expect(details[3]!.some(detail => detail.includes('SEARCH rc') && detail.includes('project_id=? AND key=?'))).toBe(true);
        const spec = KINDS.find(kind => kind.name === 'prompt')!;
        const check = sharedChecks(spec, { projectId: P, machineId: 'machine', tokenId: 'credential', now: 5, nonce: 'nonce', actor: null },
          { eventId: 'event', sessionId: 'session', kind: 'prompt', createdAt: 1, channel: 'cli', producer: { adapter: 'test', version: '1' }, payload: { promptId: 'prompt', blob: key(holderInserts.length + 0), origin: 'user' }, payloadJson: '{}', payloadBytes: new TextEncoder().encode('{}') },
          { promptId: 'prompt', blob: key(holderInserts.length + 0), origin: 'user' }, []).find(check => check.read.sql.startsWith('SELECT media_type'))!;
        const plan = (await store.prepare(`EXPLAIN QUERY PLAN ${check.read.sql}`).bind(...check.read.params).all<{ detail: string }>()).results;
        expect(plan.some(row => row.detail.includes('SEARCH blobs USING INDEX') && row.detail.includes('project_id=? AND key=?'))).toBe(true);
        expect(plan.filter(row => /^SCAN (blobs|a|p|r)\b/.test(row.detail))).toEqual([]);
      }
    } finally { native.close(); await mf.dispose(); }
  }, 120_000);
});
