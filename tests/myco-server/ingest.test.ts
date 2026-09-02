import { describe, it, expect } from 'bun:test';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { sqliteD1, seededSqlite, seedCredential } from './helpers/d1.js';
import { ENVELOPE_FIELDS, PRODUCER_FIELDS } from '@myco-server-worker/ingest/envelope.js';
import { envelope, uuid, PRODUCER } from './helpers/fixtures.js';

function realDb() {
  const sqlite = seededSqlite();
  seedCredential(sqlite, { id: 'mt_1', machineId: 'machine_1', hash: 'h1' });
  seedCredential(sqlite, { id: 'mt_2', machineId: 'machine_2', hash: 'h2' });
  seedCredential(sqlite, { id: 'mt_3', machineId: 'machine_3', hash: 'h3' });
  return { db: sqliteD1(sqlite), sqlite };
}

const ctx = { projectId: 'proj_1', machineId: 'machine_1', tokenId: 'mt_1', bodyBytes: 100, now: 2_000 };
const at = (now: number, over: Partial<typeof ctx> = {}) => ({ ...ctx, ...over, now });
const good = envelope();
const count = (s: any, t: string) => (s.query(`SELECT COUNT(*) c FROM ${t}`).get() as any).c;
const bytes = (s: any, id: string) => (s.query(`SELECT bytes_written b FROM member_credentials WHERE id=?`).get(id) as any).b;
const sessions = (s: any) => s.query('SELECT project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at FROM sessions ORDER BY project_id, session_id').all();

describe('ingest', () => {
  it('persists, attributes the write, stamps receipt time, and records the producer and payload bytes', async () => {
    const { db, sqlite } = realDb();
    expect(await ingestEvent(db, ctx, good)).toEqual({ persisted: true, projected: true });
    expect(count(sqlite, 'events')).toBe(1);
    const row = sqlite.query('SELECT token_id, channel, created_at, received_at, producer_adapter, producer_version, blob_key, payload_bytes FROM events').get() as any;
    expect(row).toEqual({
      token_id: 'mt_1', channel: 'cli', created_at: 1_000, received_at: 2_000,
      producer_adapter: PRODUCER.adapter, producer_version: PRODUCER.version, blob_key: null,
      payload_bytes: new TextEncoder().encode(JSON.stringify(good.payload)).byteLength,
    });
  });

  it('charges the body bytes to the token in the same batch', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good);
    await ingestEvent(db, { ...ctx, bodyBytes: 50 }, envelope({ eventId: uuid(2), payload: { promptId: uuid(3), text: 'x', origin: 'user' } }));
    expect(bytes(sqlite, 'mt_1')).toBe(150);
  });

  it('converges on replay, reports the duplicate, and charges nothing for it', async () => {
    const { db, sqlite } = realDb();
    expect(await ingestEvent(db, ctx, good)).toEqual({ persisted: true, projected: true });
    expect(await ingestEvent(db, at(3_000), good)).toEqual({ persisted: true, duplicate: true });
    expect(count(sqlite, 'events')).toBe(1);
    expect(bytes(sqlite, 'mt_1')).toBe(100);
  });

  it('refuses a reused event id carrying a different payload and keeps the first', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good);
    expect(await ingestEvent(db, at(3_000), envelope({ payload: { promptId: uuid(2), text: 'changed', origin: 'user' } }))).toEqual({ persisted: false, code: 'event_id_conflict', reason: 'event id conflict' });
    expect(count(sqlite, 'events')).toBe(1);
    expect((sqlite.query('SELECT payload FROM events').get() as any).payload).toBe(JSON.stringify(good.payload));
  });

  it('treats a reused event id with any other envelope field changed as a conflict, not a duplicate — every field of the envelope and of its producer block, taken from the envelope\'s own field list', async () => {
    // One change per field the envelope declares, so a field added to the envelope without a change here fails.
    const changes: Record<string, Record<string, unknown>[]> = {
      sessionId: [{ sessionId: 'sess_2' }],
      kind: [{ kind: 'response', payload: { responseId: uuid(9), text: 'x' } }],
      createdAt: [{ createdAt: 7_000 }],
      channel: [{ channel: 'http' }],
      payload: [{ payload: { promptId: uuid(2), text: 'changed', origin: 'user' } }],
      producer: PRODUCER_FIELDS.map((field) => ({ producer: { ...PRODUCER, [field]: `${PRODUCER[field]}-changed` } })),
    };
    expect(Object.keys(changes).sort()).toEqual(ENVELOPE_FIELDS.filter((f) => f !== 'eventId').sort());
    for (const [field, cases] of Object.entries(changes)) {
      for (const change of cases) {
        const { db, sqlite } = realDb();
        await ingestEvent(db, ctx, good);
        expect({ field, change, res: await ingestEvent(db, at(3_000), { ...good, ...change }) }).toEqual({ field, change, res: { persisted: false, code: 'event_id_conflict', reason: 'event id conflict' } });
        expect(count(sqlite, 'events')).toBe(1);
        expect(count(sqlite, 'sessions')).toBe(1);
      }
    }
  });

  it('projects sessions from stored events only: server receipt times, first inserter attribution', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good);
    await ingestEvent(db, at(5_000), envelope({ eventId: uuid(4), createdAt: 999, payload: { promptId: uuid(5), text: 'later', origin: 'user' } }));
    expect(sessions(sqlite)).toEqual([{ project_id: 'proj_1', session_id: 'sess_1', machine_id: 'machine_1', created_by_token_id: 'mt_1', first_received_at: 2_000, last_received_at: 5_000 }]);
  });

  it('writes and mutates no session row for a duplicate, a conflict, a refused kind, or a malformed envelope', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good);
    const before = sessions(sqlite);
    await ingestEvent(db, at(9_000), good);
    await ingestEvent(db, at(9_000), envelope({ createdAt: 0, payload: { promptId: uuid(2), text: 'squat', origin: 'user' } }));
    expect(await ingestEvent(db, at(9_000), envelope({ eventId: uuid(6), sessionId: 'sess_9', kind: 'made.up', payload: {} }))).toEqual({ persisted: false, code: 'unknown_kind', reason: 'unknown kind made.up' });
    expect(await ingestEvent(db, at(9_000), { ...good, eventId: uuid(7), sessionId: 'sess_9', payload: { promptId: '1', text: 'x', origin: 'user' } })).toEqual({ persisted: false, code: 'id_grammar', reason: 'promptId must match the id grammar' });
    await ingestEvent(db, at(9_000), { ...good, eventId: uuid(8), sessionId: 'sess_9', kind: '' });
    expect(sessions(sqlite)).toEqual(before);
    expect(count(sqlite, 'events')).toBe(1);
  });

  it('refuses an event into a session another machine opened, storing nothing and charging nothing', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good);
    const other = envelope({ eventId: uuid(10), payload: { promptId: uuid(11), text: 'mine', origin: 'user' } });
    expect(await ingestEvent(db, at(3_000, { machineId: 'machine_3', tokenId: 'mt_3' }), other)).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(count(sqlite, 'events')).toBe(1);
    expect(bytes(sqlite, 'mt_3')).toBe(0);
    expect(await ingestEvent(db, at(4_000, { machineId: 'machine_3', tokenId: 'mt_3' }), { ...other, eventId: uuid(12), sessionId: 'sess_3' })).toEqual({ persisted: true, projected: true });
    expect(await ingestEvent(db, at(5_000), other)).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(await ingestEvent(db, at(6_000), { ...other, payload: { promptId: uuid(13), text: 'mine', origin: 'user' } })).toEqual({ persisted: true, projected: true });
    expect(count(sqlite, 'events')).toBe(3);
  });

  it('names the raw row by a per-request nonce: a duplicate or a conflict in the same millisecond re-fires no projection', async () => {
    const { db, sqlite } = realDb();
    const plan = envelope({ eventId: uuid(20), kind: 'plan', payload: { planKey: uuid(21), content: 'one', tags: ['a'] } });
    expect(await ingestEvent(db, at(7_000), plan)).toEqual({ persisted: true, projected: true });
    expect(await ingestEvent(db, at(7_000), plan)).toEqual({ persisted: true, duplicate: true });
    const conflicting = envelope({ eventId: uuid(20), kind: 'plan', createdAt: 1_000, payload: { planKey: uuid(21), content: 'two', tags: ['b'] } });
    expect(await ingestEvent(db, at(7_000), conflicting)).toEqual({ persisted: false, code: 'event_id_conflict', reason: 'event id conflict' });
    expect(sqlite.query(`SELECT content FROM plans`).get()).toEqual({ content: 'one' });
    expect(sqlite.query(`SELECT tag FROM tags`).all()).toEqual([{ tag: 'a' }]);
    expect((sqlite.query(`SELECT COUNT(*) c FROM events WHERE ingest_nonce = ''`).get() as any).c).toBe(0);
  });

  it('signals a plan overwritten from another source, and stays quiet for an edit from the same source or identical content', async () => {
    const { db } = realDb();
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      const key = uuid(31);
      expect(await ingestEvent(db, at(8_000), envelope({ eventId: uuid(30), kind: 'plan', payload: { planKey: key, content: 'one', originPath: 'docs/plans/a.md' } }))).toEqual({ persisted: true, projected: true });
      expect(await ingestEvent(db, at(8_001), envelope({ eventId: uuid(32), createdAt: 8_001, kind: 'plan', payload: { planKey: key, content: 'two', originPath: 'docs/plans/a.md' } }))).toEqual({ persisted: true, projected: true });
      expect(await ingestEvent(db, at(8_002), envelope({ eventId: uuid(33), createdAt: 8_002, kind: 'plan', payload: { planKey: key, content: 'two', originPath: 'transcript:ultraplan' } }))).toEqual({ persisted: true, projected: true });
      expect(lines.filter((l) => l.includes('plan_overwritten'))).toEqual([]);
      expect(await ingestEvent(db, at(8_003), envelope({ eventId: uuid(34), createdAt: 8_003, kind: 'plan', payload: { planKey: key, content: 'three', originPath: 'transcript:ultraplan' } }))).toEqual({ persisted: true, projected: true });
      const signal = lines.filter((l) => l.includes('plan_overwritten'));
      expect(signal).toHaveLength(1);
      expect(JSON.parse(signal[0]!)).toEqual({ kind: 'plan_overwritten', projectId: 'proj_1', sessionId: 'sess_1', planKey: key });
      expect(signal[0]!.includes('docs/plans')).toBe(false);
    } finally {
      console.log = original;
    }
  });

  it('reports a replay by another token of the same machine as a duplicate, and answers another machine nothing about the stored event', async () => {
    const { db, sqlite } = realDb();
    seedCredential(sqlite, { id: 'mt_1b', machineId: 'machine_1', hash: 'h1b' });
    await ingestEvent(db, ctx, good);
    expect(await ingestEvent(db, at(3_000, { machineId: 'machine_1', tokenId: 'mt_1b' }), good)).toEqual({ persisted: true, duplicate: true });
    expect(await ingestEvent(db, at(3_000, { machineId: 'machine_3', tokenId: 'mt_3' }), good)).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    const conflicting = { ...good, payload: { promptId: uuid(2), text: 'guess', origin: 'user' } };
    expect(await ingestEvent(db, at(3_000, { machineId: 'machine_3', tokenId: 'mt_3' }), conflicting)).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(count(sqlite, 'events')).toBe(1);
    expect(bytes(sqlite, 'mt_3')).toBe(0);
    expect(bytes(sqlite, 'mt_1b')).toBe(0);
  });

  it('cannot touch another project session row', async () => {
    const { db, sqlite } = realDb();
    await ingestEvent(db, ctx, good);
    expect(await ingestEvent(db, at(3_000, { projectId: 'proj_2', machineId: 'machine_2', tokenId: 'mt_2' }), good)).toEqual({ persisted: true, projected: true });
    expect(count(sqlite, 'sessions')).toBe(2);
    expect(count(sqlite, 'events')).toBe(2);
    expect((sqlite.query(`SELECT machine_id FROM sessions WHERE project_id='proj_1'`).get() as any).machine_id).toBe('machine_1');
  });

  it('takes machine identity from the token and refuses a caller-supplied one as an unknown field', async () => {
    const { db, sqlite } = realDb();
    expect(await ingestEvent(db, ctx, { ...good, machineId: 'spoofed' })).toEqual({ persisted: false, code: 'unknown_field', reason: 'unknown field machineId' });
    expect(count(sqlite, 'events')).toBe(0);
    expect(bytes(sqlite, 'mt_1')).toBe(0);
  });
});
