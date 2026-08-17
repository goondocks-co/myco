import { describe, it, expect } from 'bun:test';
import { ingestEvent } from '../../packages/myco-server/worker/src/ingest/events.js';
import { sqliteD1, seededSqlite } from './helpers/d1.js';

function realDb() {
  const sqlite = seededSqlite();
  sqlite.query(`INSERT INTO member_tokens (id,project_id,machine_id,token_hash,expires_at,revoked_at,bytes_written)
                VALUES ('mt_1','proj_1','machine_1','h1',9,NULL,0),('mt_2','proj_2','machine_2','h2',9,NULL,0),('mt_3','proj_1','machine_3','h3',9,NULL,0)`).run();
  return { db: sqliteD1(sqlite), sqlite };
}

const ctx = { projectId: 'proj_1', machineId: 'machine_1', tokenId: 'mt_1', bodyBytes: 100 };
const good = { eventId: 'evt_1', sessionId: 'sess_1', kind: 'prompt', createdAt: 1_000, transport: 'cli', payload: { t: 'hi' } };
const count = (s: any, t: string) => (s.query(`SELECT COUNT(*) c FROM ${t}`).get() as any).c;

describe('ingest', () => {
  it('persists, attributes the write, and stamps receipt time', async () => {
    const { db, sqlite } = realDb();
    expect(await ingestEvent(db, ctx, good, 2_000)).toEqual({ persisted: true });
    expect(count(sqlite, 'events')).toBe(1);
    const row = sqlite.query('SELECT token_id, created_at, received_at FROM events').get() as any;
    expect(row).toEqual({ token_id: 'mt_1', created_at: 1_000, received_at: 2_000 });
  });

  it('charges the body bytes to the token in the same batch', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good, 2_000);
    await ingestEvent(db, { ...ctx, bodyBytes: 50 }, { ...good, eventId: 'evt_2' }, 2_000);
    expect((sqlite.query(`SELECT bytes_written FROM member_tokens WHERE id='mt_1'`).get() as any).bytes_written).toBe(150);
  });

  it('converges on replay, reports the duplicate, and charges nothing for it', async () => {
    const { db, sqlite } = realDb();
    expect(await ingestEvent(db, ctx, good, 2_000)).toEqual({ persisted: true });
    expect(await ingestEvent(db, ctx, good, 3_000)).toEqual({ persisted: true, duplicate: true });
    expect(count(sqlite, 'events')).toBe(1);
    expect((sqlite.query(`SELECT bytes_written FROM member_tokens WHERE id='mt_1'`).get() as any).bytes_written).toBe(100);
  });

  it('refuses a reused event id carrying a different payload and keeps the first', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good, 2_000);
    expect(await ingestEvent(db, ctx, { ...good, payload: { t: 'changed' } }, 3_000)).toEqual({ persisted: false, reason: 'event id conflict' });
    expect(count(sqlite, 'events')).toBe(1);
    expect((sqlite.query('SELECT payload, payload_hash FROM events').get() as any).payload).toBe(JSON.stringify({ t: 'hi' }));
  });

  it('keeps the earliest caller time as the session start whatever the arrival order', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, { ...good, createdAt: 5_000 }, 2_000);
    await ingestEvent(db, ctx, { ...good, eventId: 'evt_2', createdAt: 1_000 }, 3_000);
    await ingestEvent(db, ctx, { ...good, eventId: 'evt_3', createdAt: 9_000 }, 4_000);
    expect(sqlite.query('SELECT started_at, updated_at FROM sessions').get()).toEqual({ started_at: 1_000, updated_at: 4_000 });
  });

  it('reports a same-project replay by another token as a duplicate', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good, 2_000);
    expect(await ingestEvent(db, { ...ctx, tokenId: 'mt_3', machineId: 'machine_3' }, good, 3_000)).toEqual({ persisted: true, duplicate: true });
    expect((sqlite.query('SELECT token_id FROM events').get() as any).token_id).toBe('mt_1');
  });

  it('keeps distinct events sharing a millisecond', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good, 2_000);
    await ingestEvent(db, ctx, { ...good, eventId: 'evt_2' }, 2_000);
    expect(count(sqlite, 'events')).toBe(2);
  });

  it('cannot touch another project session row', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good, 2_000);
    await ingestEvent(db, { ...ctx, projectId: 'proj_2', tokenId: 'mt_2', machineId: 'machine_2' }, good, 3_000);
    expect(count(sqlite, 'sessions')).toBe(2);
    expect((sqlite.query(`SELECT machine_id FROM sessions WHERE project_id='proj_1'`).get() as any).machine_id).toBe('machine_1');
  });

  it('takes machine identity from the token', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, { ...good, machineId: 'spoofed' }, 2_000);
    expect((sqlite.query('SELECT machine_id FROM sessions').get() as any).machine_id).toBe('machine_1');
  });

  it('ignores a caller-supplied projectId and tokenId', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, { ...good, projectId: 'proj_2', tokenId: 'mt_2' }, 2_000);
    expect(sqlite.query('SELECT project_id, token_id FROM events').get()).toEqual({ project_id: 'proj_1', token_id: 'mt_1' });
  });

  it('refuses a malformed envelope and persists nothing', async () => {
    const { db, sqlite } = realDb();
    const r = await ingestEvent(db, ctx, { ...good, kind: '' }, 2_000);
    expect(r.persisted).toBe(false);
    expect(count(sqlite, 'events')).toBe(0);
    expect((sqlite.query(`SELECT bytes_written FROM member_tokens WHERE id='mt_1'`).get() as any).bytes_written).toBe(0);
  });
});
