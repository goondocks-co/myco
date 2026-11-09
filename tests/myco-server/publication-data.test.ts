import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';
import { expect, test } from 'bun:test';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { issueMemberToken } from './helpers/member-token.js';
import { sessionCommits } from '@myco-server-worker/read/session-commits.js';
import { GIT_STATUS_UNREADABLE } from '@myco-server-worker/ingest/projections.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { DocumentBatch, DocumentPassFull, PASS_CLOSING_STATEMENTS, VERSION_STATEMENTS, releaseHolders, type BatchDocument } from '@myco-server-worker/ingest/document-batch.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { registeredObjectKeySql } from '@myco-server-worker/core/blob-objects.js';
import { measuredContentEnv, CONTENT_WAKE_JOB_RESERVE } from '@myco-server-worker/core/content-budget.js';
import { STATEMENT_JSON_BYTES } from '@myco-server-worker/db/json-pages.js';
import { envelope, readFixtureRecords, sqliteEnv, uuid } from './helpers/fixtures.js';
import { registerBlob } from './helpers/d1.js';

const NOW = Date.now();
const limits = () => ({ calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
async function fixture() {
  const f = sqliteEnv();
  const { tokenId } = await issueMemberToken(f.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
  const ctx = { projectId: 'proj_1', machineId: 'machine_1', tokenId, bodyBytes: 1, now: NOW };
  return { ...f, ctx };
}

test('retained plan events hold their bodies across a projection overwrite and release of another holder', async () => {
  const f = await fixture();
  try {
    const text = 'retained plan'.repeat(20_000), key = await sha256Hex(text);
    const physical = registerBlob(f.sqlite, { projectId: 'proj_1', key, size: Buffer.byteLength(text), tokenId: f.ctx.tokenId, receivedAt: NOW });
    await f.bucket.put(physical, new Blob([text]).stream());
    for (const event of [
      envelope({ eventId: uuid(1), sessionId: 'session', kind: 'session.start', payload: { agent: 'claude-code' } }),
      envelope({ eventId: uuid(2), sessionId: 'session', kind: 'plan', createdAt: 2, payload: { planKey: uuid(20), blob: key } }),
      envelope({ eventId: uuid(3), sessionId: 'session', kind: 'plan', createdAt: 3, payload: { planKey: uuid(20), content: 'new plan' } }),
    ]) expect((await ingestEvent(f.db, f.ctx, event, f.serverEnv)).persisted).toBe(true);
    f.sqlite.run(`INSERT INTO retired_objects (project_id,session_id,blob_key,source_id,retired_at) VALUES ('proj_1','session',?,'other-holder',1)`, [key]);
    await releaseHolders(f.db, [{ p: 'proj_1', s: 'session', k: key, i: 'other-holder' }], NOW);
    expect(f.sqlite.query(`SELECT key FROM blobs WHERE key=?`).get(key)).toEqual({ key });
    await publishDocuments(f.serverEnv, NOW, limits());
    expect((await readFixtureRecords(f.serverEnv, 'proj_1', 'session')).filter(r => r.k === 'plan').map(r => r.content)).toEqual([text, 'new plan']);
    expect(f.sqlite.query('SELECT COUNT(*) n FROM publish_queue').get()).toEqual({ n: 0 });
  } finally { f.sqlite.close(); }
});

test('plan publication byte-pages bindings and retains inline and externalized bodies', async () => {
  const f = await fixture();
  try {
    await ingestEvent(f.db, f.ctx, envelope({ eventId: uuid(1), sessionId: 'session', kind: 'session.start', payload: { agent: 'cline' } }), f.serverEnv);
    await ingestEvent(f.db, f.ctx, envelope({ eventId: uuid(2), sessionId: 'session', kind: 'prompt', payload: { promptId: uuid(20), text: 'publish plans', origin: 'user' } }), f.serverEnv);
    await publishDocuments(f.serverEnv, NOW, limits());
    const sizes: number[] = [];
    const observe = (sql: string, statement: PreparedStatement): PreparedStatement => ({ ...statement, bind: (...values) => {
      if (sql.includes('INSERT INTO plans') || sql.includes('INSERT INTO processed_resources')) sizes.push(...values.filter((v): v is string => typeof v === 'string').map(v => Buffer.byteLength(v)));
      return observe(sql, statement.bind(...values));
    } });
    const db: RelationalStore = { prepare: sql => observe(sql, f.db.prepare(sql)), batch: statements => f.db.batch(statements) };
    const doc = await f.db.prepare(`SELECT generation,next_chunk,prompts,first_prompt,open_turn_key,? token_id FROM session_documents WHERE project_id='proj_1' AND session_id='session'`).bind(f.ctx.tokenId).first<BatchDocument>();
    const batch = new DocumentBatch({ db, blobs: f.bucket }, 'proj_1', 'session', doc!);
    const bodies = [...Array.from({ length: 12 }, (_, i) => `${i}:` + '計画'.repeat(30_000)), 'large:' + 'full body'.repeat(100_000)];
    await batch.open();
    batch.admitted = true;
    await batch.place(bodies.map((content, i) => ({ k: 'plan', id: uuid(100 + i), prompt_id: null, created_at: NOW, content })), null);
    await batch.commit(true, 'live', NOW, () => ({ sql: '1', params: [] }), () => ({ before: [], after: [] }));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(STATEMENT_JSON_BYTES);
    const plans = f.sqlite.query(`SELECT plan_key,content,blob_key FROM plans ORDER BY plan_key`).all() as { plan_key: string; content: string | null; blob_key: string | null }[];
    expect(plans.length).toBe(bodies.length);
    for (const [i, plan] of plans.entries()) {
      if (plan.blob_key === null) expect(plan.content).toBe(bodies[i]);
      else {
        expect(plan.content).toBeNull();
        const blob = await f.db.prepare(`SELECT ${registeredObjectKeySql("'proj_1'", '?')} object_key`).bind(plan.blob_key).first<{ object_key: string }>();
        expect(await new Response((await f.bucket.get(blob!.object_key))!.body).text()).toBe(bodies[i]);
      }
    }
  } finally { f.sqlite.close(); }
});

test('retiring the last holder journals release work in the holder transaction', async () => {
  const f = await fixture();
  try {
    const key = await sha256Hex('retired bytes');
    registerBlob(f.sqlite, { projectId: 'proj_1', key, size: 13, tokenId: f.ctx.tokenId, receivedAt: NOW });
    f.sqlite.run(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
      SELECT project_id,key,generation,'document','holder','event','envelope','session',key,size,1,1 FROM blobs WHERE key=?`, [key]);
    f.sqlite.run(`INSERT INTO retired_objects (project_id,session_id,blob_key,source_id,retired_at) VALUES ('proj_1','session',?,'holder',1)`, [key]);
    const interrupted: RelationalStore = { prepare: sql => f.db.prepare(sql), batch: async statements => {
      await f.db.batch(statements);
      throw new Error('interrupted after commit');
    } };
    const later = NOW + BLOB_RESERVATION_TTL_MS + 1;
    await expect(releaseHolders(interrupted, [{ p: 'proj_1', s: 'session', k: key, i: 'holder' }], later)).rejects.toThrow('interrupted after commit');
    expect(f.sqlite.query('SELECT COUNT(*) n FROM retired_objects').get()).toEqual({ n: 0 });
    expect(f.sqlite.query('SELECT key FROM blob_release_candidates').all()).toEqual([{ key }]);
    await drainObjectReleases(f.serverEnv, later);
    expect(f.sqlite.query('SELECT key FROM blobs WHERE key=?').get(key)).toBeNull();
  } finally { f.sqlite.close(); }
});

test('git provenance keeps unobserved cleanliness unknown and records an observed clean end', async () => {
  const f = await fixture();
  try {
    const headSha = 'a'.repeat(40);
    for (const [eventId, kind, payload] of [
      [uuid(1), 'session.start', { agent: 'claude-code', headSha }],
      [uuid(2), 'session.end', { headSha, dirty: false }],
    ] as const) expect((await ingestEvent(f.db, f.ctx, envelope({ eventId, sessionId: 'session', kind, payload }), f.serverEnv)).persisted).toBe(true);
    expect(f.sqlite.query(`SELECT capture_point,is_dirty,error FROM knowledge_git_provenance ORDER BY capture_point DESC`).all())
      .toEqual([{ capture_point: 'session_start', is_dirty: 0, error: GIT_STATUS_UNREADABLE }, { capture_point: 'session_end', is_dirty: 0, error: null }]);
    expect((await sessionCommits(f.db, { projectId: 'proj_1' }, 'session')).observations.map(row => row.changes)).toEqual(['unreadable', 'none']);
  } finally { f.sqlite.close(); }
});


test('plan projection pages participate in placement admission before any commit work', async () => {
  const f = await fixture();
  try {
    const records = Array.from({ length: 12 }, (_, i) => ({ k: 'plan' as const, id: uuid(100 + i), prompt_id: null, created_at: NOW, content: `${i}:` + '計画'.repeat(30_000) }));
    const doc: BatchDocument = { generation: 1, next_chunk: 0, prompts: 0, first_prompt: null, open_turn_key: null, token_id: f.ctx.tokenId };
    const probe = new DocumentBatch(f.serverEnv, 'proj_1', 'session', doc);
    await probe.open();
    await probe.place(records, null);
    const closingWithoutPlans = 9;
    const bounded = measuredContentEnv(f.serverEnv, { statements: CONTENT_WAKE_JOB_RESERVE + PASS_CLOSING_STATEMENTS + probe.writer.versions * VERSION_STATEMENTS + closingWithoutPlans + 1, blobCalls: 60 });
    const batch = new DocumentBatch(bounded.env, 'proj_1', 'session', doc);
    await batch.open();
    batch.admitted = true;
    await expect(batch.place(records, null)).rejects.toBeInstanceOf(DocumentPassFull);
    expect(batch.records).toBe(0);
    expect(bounded.usage.blobCalls).toBe(0);
  } finally { f.sqlite.close(); }
});
