import { describe, it, expect } from 'bun:test';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { sqliteD1, seededSqlite } from './helpers/d1.js';

function realDb() {
  const sqlite = seededSqlite();
  sqlite.query(`INSERT INTO member_tokens (id,project_id,machine_id,token_hash,expires_at,revoked_at,bytes_written)
                VALUES ('mt_1','proj_1','machine_1','h1',9,NULL,0),('mt_2','proj_2','machine_2','h2',9,NULL,0),('mt_3','proj_1','machine_3','h3',9,NULL,0)`).run();
  return { db: sqliteD1(sqlite), sqlite };
}

const ctx = { projectId: 'proj_1', machineId: 'machine_1', tokenId: 'mt_1', bodyBytes: 100, now: 2_000 };
const at = (now: number, over: Partial<typeof ctx> = {}) => ({ ...ctx, ...over, now });
const good = { eventId: 'evt_1', sessionId: 'sess_1', kind: 'prompt', createdAt: 1_000, channel: 'cli', payload: { t: 'hi' } };
const count = (s: any, t: string) => (s.query(`SELECT COUNT(*) c FROM ${t}`).get() as any).c;
const bytes = (s: any, id: string) => (s.query(`SELECT bytes_written b FROM member_tokens WHERE id=?`).get(id) as any).b;
const sessions = (s: any) => s.query('SELECT project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at FROM sessions ORDER BY project_id, session_id').all();

describe('ingest', () => {
  it('persists, attributes the write, and stamps receipt time', async () => {
    const { db, sqlite } = realDb();
    expect(await ingestEvent(db, ctx, good)).toEqual({ persisted: true });
    expect(count(sqlite, 'events')).toBe(1);
    const row = sqlite.query('SELECT token_id, channel, created_at, received_at FROM events').get() as any;
    expect(row).toEqual({ token_id: 'mt_1', channel: 'cli', created_at: 1_000, received_at: 2_000 });
  });

  it('charges the body bytes to the token in the same batch', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good);
    await ingestEvent(db, { ...ctx, bodyBytes: 50 }, { ...good, eventId: 'evt_2' });
    expect(bytes(sqlite, 'mt_1')).toBe(150);
  });

  it('converges on replay, reports the duplicate, and charges nothing for it', async () => {
    const { db, sqlite } = realDb();
    expect(await ingestEvent(db, ctx, good)).toEqual({ persisted: true });
    expect(await ingestEvent(db, at(3_000), good)).toEqual({ persisted: true, duplicate: true });
    expect(count(sqlite, 'events')).toBe(1);
    expect(bytes(sqlite, 'mt_1')).toBe(100);
  });

  it('refuses a reused event id carrying a different payload and keeps the first', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good);
    expect(await ingestEvent(db, at(3_000), { ...good, payload: { t: 'changed' } })).toEqual({ persisted: false, reason: 'event id conflict' });
    expect(count(sqlite, 'events')).toBe(1);
    expect((sqlite.query('SELECT payload FROM events').get() as any).payload).toBe(JSON.stringify({ t: 'hi' }));
  });

  it('treats a reused event id with any other envelope field changed as a conflict, not a duplicate', async () => {
    for (const change of [{ sessionId: 'sess_2' }, { kind: 'tool_result' }, { createdAt: 7_000 }, { channel: 'http' }]) {
      const { db, sqlite } = realDb();
      await ingestEvent(db, ctx, good);
      expect(await ingestEvent(db, at(3_000), { ...good, ...change })).toEqual({ persisted: false, reason: 'event id conflict' });
      expect(count(sqlite, 'events')).toBe(1);
      expect(count(sqlite, 'sessions')).toBe(1);
    }
  });

  it('projects sessions from stored events only: server receipt times, first inserter attribution', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, at(2_000), { ...good, createdAt: 5_000 });
    await ingestEvent(db, at(3_000), { ...good, eventId: 'evt_2', createdAt: 1_000 });
    await ingestEvent(db, at(4_000, { tokenId: 'mt_3', machineId: 'machine_3' }), { ...good, eventId: 'evt_3', createdAt: 9_000 });
    expect(sessions(sqlite)).toEqual([
      { project_id: 'proj_1', session_id: 'sess_1', machine_id: 'machine_1', created_by_token_id: 'mt_1', first_received_at: 2_000, last_received_at: 4_000 },
    ]);
  });

  it('writes and mutates no session row for a duplicate, a conflict, or a malformed envelope', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, at(2_000), good);
    const before = sessions(sqlite);
    await ingestEvent(db, at(3_000), good);
    await ingestEvent(db, at(4_000, { tokenId: 'mt_3', machineId: 'machine_3' }), { ...good, sessionId: 'sess_9', payload: { t: 'squat' } });
    await ingestEvent(db, at(5_000), { ...good, eventId: 'evt_bad', kind: '' });
    await ingestEvent(db, at(6_000, { tokenId: 'mt_3', machineId: 'machine_3' }), { ...good, createdAt: 0 });
    expect(sessions(sqlite)).toEqual(before);
    expect(count(sqlite, 'sessions')).toBe(1);
  });

  it('reports a same-project replay by another token as a duplicate', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good);
    expect(await ingestEvent(db, at(3_000, { tokenId: 'mt_3', machineId: 'machine_3' }), good)).toEqual({ persisted: true, duplicate: true });
    expect((sqlite.query('SELECT token_id FROM events').get() as any).token_id).toBe('mt_1');
    expect(bytes(sqlite, 'mt_3')).toBe(0);
  });

  it('keeps distinct events sharing a millisecond', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good);
    await ingestEvent(db, ctx, { ...good, eventId: 'evt_2' });
    expect(count(sqlite, 'events')).toBe(2);
  });

  it('cannot touch another project session row', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good);
    await ingestEvent(db, at(3_000, { projectId: 'proj_2', tokenId: 'mt_2', machineId: 'machine_2' }), good);
    expect(count(sqlite, 'sessions')).toBe(2);
    expect((sqlite.query(`SELECT machine_id FROM sessions WHERE project_id='proj_1'`).get() as any).machine_id).toBe('machine_1');
  });

  it('takes machine identity from the token and refuses a caller-supplied one as an unknown field', async () => {
    const { db, sqlite } = realDb();
    expect(await ingestEvent(db, ctx, { ...good, machineId: 'spoofed' })).toEqual({ persisted: false, reason: 'unknown field machineId' });
    await ingestEvent(db, ctx, good);
    expect((sqlite.query('SELECT machine_id FROM sessions').get() as any).machine_id).toBe('machine_1');
  });

  it('refuses caller-supplied projectId and tokenId as unknown fields', async () => {
    const { db, sqlite } = realDb();
    expect((await ingestEvent(db, ctx, { ...good, projectId: 'proj_2' })).reason).toBe('unknown field projectId');
    expect((await ingestEvent(db, ctx, { ...good, tokenId: 'mt_2' })).reason).toBe('unknown field tokenId');
    expect(count(sqlite, 'events')).toBe(0);
  });

  it('refuses a malformed envelope and persists nothing', async () => {
    const { db, sqlite } = realDb();
    const r = await ingestEvent(db, ctx, { ...good, kind: '' });
    expect(r.persisted).toBe(false);
    expect(count(sqlite, 'events')).toBe(0);
    expect(bytes(sqlite, 'mt_1')).toBe(0);
  });
});
