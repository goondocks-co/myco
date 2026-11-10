import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from './helpers/member-token.js';
import { eventContent } from '@myco-server-worker/core/event-content.js';
import { EVENT_INLINE_PAYLOAD_BYTES } from '@myco-server-worker/ingest/event-payload.js';
import { bodyCapReason, EVENT_BODY_CAP_NEXT_CALL, MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';
import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { envelope, journaled, memberPost, registeredObject, sqliteEnv, uuid } from './helpers/fixtures.js';
import { changingAt, counting, dying, failingAt } from './helpers/store-faults.js';
import { tombstoneSession } from './helpers/session-deletion.js';

const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;
const member = (e: ReturnType<typeof sqliteEnv>) => issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
const scalar = <T,>(e: ReturnType<typeof sqliteEnv>, sql: string, ...params: Array<string | number>) => e.sqlite.query(sql).get(...params) as T;
const count = (e: ReturnType<typeof sqliteEnv>, table: string) => (scalar<{ n: number }>(e, `SELECT COUNT(*) AS n FROM ${table}`)).n;
const held = (e: ReturnType<typeof sqliteEnv>, eventId: string) => scalar<{ n: number }>(e, 'SELECT COUNT(*) AS n FROM events WHERE event_id=?', eventId).n;

/** A prompt payload whose serialized JSON is exactly `bytes` long. */
function promptOf(bytes: number, promptId: string): Record<string, unknown> {
  const fixed = JSON.stringify({ promptId, text: '', origin: 'user' }).length;
  return { promptId, text: 'é'.repeat(Math.floor((bytes - fixed) / 2)) + 'x'.repeat((bytes - fixed) % 2), origin: 'user' };
}
const stored = (e: ReturnType<typeof sqliteEnv>, eventId: string) => scalar<{ payload_format: string; payload: string }>(e, 'SELECT payload_format,payload FROM events WHERE event_id=?', eventId);
const post = async (e: ReturnType<typeof sqliteEnv>, token: string, over: Record<string, unknown>) => worker.fetch(memberPost(token, envelope(over)), e.env);
/** Stored objects no blob row registers. */
const unregistered = (e: ReturnType<typeof sqliteEnv>) => {
  const registered = new Set((e.sqlite.query('SELECT project_id, key FROM blobs').all() as { project_id: string; key: string }[]).map(row => registeredObject(e.sqlite, row.project_id, row.key)));
  return [...e.bucket.objects.keys()].filter(key => !registered.has(key)).sort();
};
/** The calls one oversized event's intake makes, counted on its own Deployment. */
async function intakeCalls(): Promise<number> {
  const e = sqliteEnv();
  try {
    const t = await member(e);
    const counter = counting(e.env.MYCO_DB);
    e.env.MYCO_DB = counter.store;
    expect(await json(await post(e, t.token, { eventId: uuid(30), payload: promptOf(EVENT_INLINE_PAYLOAD_BYTES + 1, uuid(31)) }))).toEqual({ persisted: true, projected: true });
    return counter.calls();
  } finally { e.sqlite.close(); }
}

describe('direct object-store intake of an event payload', () => {
  it('holds a payload at the ceiling inline and one byte over in the object store, each reading back byte for byte', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const atCeiling = promptOf(EVENT_INLINE_PAYLOAD_BYTES, uuid(1));
    const over = promptOf(EVENT_INLINE_PAYLOAD_BYTES + 1, uuid(2));
    expect(await json(await post(e, t.token, { eventId: uuid(11), payload: atCeiling }))).toEqual({ persisted: true, projected: true });
    expect(await json(await post(e, t.token, { eventId: uuid(12), payload: over }))).toEqual({ persisted: true, projected: true });
    expect(stored(e, uuid(11)).payload_format).toBe('inline');
    const row = stored(e, uuid(12));
    expect(row.payload_format).toBe('blob');
    // The row keeps what its relational readers use, and leaves the content out.
    expect(JSON.parse(row.payload)).toEqual({ promptId: uuid(2), origin: 'user' });
    expect(await eventContent(e.serverEnv, 'proj_1', uuid(11))).toBe(JSON.stringify(atCeiling));
    expect(await eventContent(e.serverEnv, 'proj_1', uuid(12))).toBe(JSON.stringify(over));
    expect(e.bucket.puts.length).toBe(1);
  });

  it('lands a replay once, and answers a different body under the same id as a conflict', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const payload = promptOf(EVENT_INLINE_PAYLOAD_BYTES + 100, uuid(3));
    expect(await json(await post(e, t.token, { eventId: uuid(13), payload }))).toEqual({ persisted: true, projected: true });
    const puts = e.bucket.puts.length;
    expect(await json(await post(e, t.token, { eventId: uuid(13), payload }))).toEqual({ persisted: true, duplicate: true });
    expect(e.bucket.puts.length).toBe(puts);
    const different = await json(await post(e, t.token, { eventId: uuid(13), payload: promptOf(EVENT_INLINE_PAYLOAD_BYTES + 100, uuid(4)) }));
    expect(different).toMatchObject({ persisted: false, code: 'event_id_conflict' });
    expect(await eventContent(e.serverEnv, 'proj_1', uuid(13))).toBe(JSON.stringify(payload));
    expect(count(e, 'events')).toBe(1);
  });

  it('puts no bytes in the store for a refused event', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const foreign = await json(await post(e, t.token, { eventId: uuid(14), kind: 'attachment', payload: { attachmentId: uuid(5), blob: 'a'.repeat(64), description: 'x'.repeat(EVENT_INLINE_PAYLOAD_BYTES + 1) } }));
    expect(foreign.persisted).toBe(false);
    expect(e.bucket.puts).toEqual([]);
    expect(count(e, 'blob_reservations')).toBe(0);
  });

  it('keeps nothing and answers retryable when the object store fails, and lands on the retry', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const payload = promptOf(EVENT_INLINE_PAYLOAD_BYTES + 1, uuid(6));
    e.bucket.failNextPut = 'object store unavailable';
    const failed = await post(e, t.token, { eventId: uuid(15), payload });
    expect(failed.status).toBe(503);
    expect(await json(failed)).toMatchObject({ persisted: false, code: 'unavailable' });
    expect(count(e, 'events')).toBe(0);
    expect(count(e, 'blob_reservations')).toBe(0);
    expect(await json(await post(e, t.token, { eventId: uuid(15), payload }))).toEqual({ persisted: true, projected: true });
    expect(await eventContent(e.serverEnv, 'proj_1', uuid(15))).toBe(JSON.stringify(payload));
  });

  it('never stores the event and journals its object wherever a store call fails, and a retry stores it', async () => {
    const total = await intakeCalls();
    const e = sqliteEnv();
    try {
      const t = await member(e);
      const db = e.env.MYCO_DB;
      for (let at = 1; at <= total; at++) {
        const event = { eventId: uuid(100 + at), payload: promptOf(EVENT_INLINE_PAYLOAD_BYTES + at, uuid(200 + at)) };
        e.env.MYCO_DB = failingAt(db, at, 'before').store;
        const failed = await post(e, t.token, event);
        e.env.MYCO_DB = db;
        expect({ at, status: failed.status, events: held(e, event.eventId), reservations: count(e, 'blob_reservations') }).toEqual({ at, status: 503, events: 0, reservations: 0 });
        // Every object the failed intake put is journaled for release at once, never left for a sweep to find.
        expect({ at, stray: unregistered(e).filter(key => !journaled(e.sqlite).includes(key)) }).toEqual({ at, stray: [] });
        await drainObjectReleases(e.serverEnv, Date.now());
        expect({ at, left: unregistered(e) }).toEqual({ at, left: [] });
        expect({ at, retry: await json(await post(e, t.token, event)) }).toEqual({ at, retry: { persisted: true, projected: true } });
      }
    } finally { e.sqlite.close(); }
  });

  it('keeps a stored event whole and leaves no stray object once its authority expires, wherever the process ends', async () => {
    const total = await intakeCalls();
    const e = sqliteEnv();
    try {
      const t = await member(e);
      const db = e.env.MYCO_DB;
      for (const when of ['before', 'after'] as const) for (let at = 1; at <= total; at++) {
        const payload = promptOf(EVENT_INLINE_PAYLOAD_BYTES + at + (when === 'after' ? total : 0), uuid(300 + at));
        const eventId = uuid(when === 'after' ? 500 + at : 400 + at);
        e.env.MYCO_DB = dying(db, at, when).store;
        await post(e, t.token, { eventId, payload });
        e.env.MYCO_DB = db;
        await drainObjectReleases(e.serverEnv, Date.now() + BLOB_RESERVATION_TTL_MS + 1);
        if (held(e, eventId) > 0) expect({ at, when, content: await eventContent(e.serverEnv, 'proj_1', eventId) }).toEqual({ at, when, content: JSON.stringify(payload) });
        expect({ at, when, left: unregistered(e), reservations: count(e, 'blob_reservations') }).toEqual({ at, when, left: [], reservations: 0 });
        expect({ at, when, retry: await json(await post(e, t.token, { eventId, payload })) }).toEqual({ at, when, retry: expect.objectContaining({ persisted: true }) });
      }
    } finally { e.sqlite.close(); }
  });

  it('answers retryable and stores nothing when its object authority is lost before the commit, wherever that lands', async () => {
    const total = await intakeCalls();
    const e = sqliteEnv();
    try {
      const t = await member(e);
      const db = e.env.MYCO_DB;
      for (let at = 1; at <= total; at++) {
        const event = { eventId: uuid(600 + at), payload: promptOf(EVENT_INLINE_PAYLOAD_BYTES + at, uuid(700 + at)) };
        let reserved = false;
        e.env.MYCO_DB = changingAt(db, at, () => {
          reserved = count(e, 'blob_reservations') > 0 && held(e, event.eventId) === 0;
          e.sqlite.run('DELETE FROM blob_reservations');
        }).store;
        const answer = await post(e, t.token, event);
        e.env.MYCO_DB = db;
        if (!reserved) { expect({ at, status: answer.status }).toEqual({ at, status: 200 }); continue; }
        expect({ at, status: answer.status, events: held(e, event.eventId) }).toEqual({ at, status: 503, events: 0 });
        expect({ at, retry: await json(await post(e, t.token, event)) }).toEqual({ at, retry: { persisted: true, projected: true } });
      }
    } finally { e.sqlite.close(); }
  });

  it('releases a stored body through the session deletion job, and leaves an identical body another session still proves', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const onlyHere = promptOf(EVENT_INLINE_PAYLOAD_BYTES + 5, uuid(21));
    const shared = promptOf(EVENT_INLINE_PAYLOAD_BYTES + 6, uuid(22));
    for (const [id, sessionId, payload] of [[uuid(41), 'deleted', onlyHere], [uuid(42), 'deleted', shared], [uuid(43), 'kept', shared]] as const) {
      expect(await json(await post(e, t.token, { eventId: id, sessionId, payload }))).toEqual({ persisted: true, projected: true });
    }
    expect(e.bucket.objects.size).toBe(2);
    const later = Date.now() + BLOB_RESERVATION_TTL_MS + 1;
    await tombstoneSession(e.serverEnv, { projectId: 'proj_1' }, 'deleted', 'mem_machine_1', later, 'asked');
    expect(scalar<{ state: string }>(e, "SELECT state FROM session_deletion_jobs WHERE session_id='deleted'").state).toBe('complete');
    expect(scalar<{ n: number }>(e, "SELECT COUNT(*) AS n FROM events WHERE session_id='deleted'").n).toBe(0);
    expect(scalar<{ n: number }>(e, "SELECT COUNT(*) AS n FROM registered_content_proofs WHERE session_id='deleted'").n).toBe(0);
    await drainObjectReleases(e.serverEnv, later + BLOB_RESERVATION_TTL_MS + 1);
    expect(e.bucket.objects.size).toBe(1);
    expect(await eventContent(e.serverEnv, 'proj_1', uuid(43))).toBe(JSON.stringify(shared));
  });

  it('shares one registered object between two events with the same body, and each reads back after the other is gone', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const payload = promptOf(EVENT_INLINE_PAYLOAD_BYTES + 3, uuid(9));
    for (const id of [uuid(18), uuid(19)]) expect(await json(await post(e, t.token, { eventId: id, payload }))).toEqual({ persisted: true, projected: true });
    expect(e.bucket.puts.length).toBe(1);
    expect(count(e, 'registered_content_proofs')).toBe(2);
    expect(await eventContent(e.serverEnv, 'proj_1', uuid(18))).toBe(JSON.stringify(payload));
    expect(await eventContent(e.serverEnv, 'proj_1', uuid(19))).toBe(JSON.stringify(payload));
    expect(count(e, 'blob_reservations')).toBe(0);
    expect(count(e, 'object_settlement_intents')).toBe(0);
  });

  for (const [name, damage] of [
    ['the object is gone', (e: ReturnType<typeof sqliteEnv>, physical: string) => { e.bucket.objects.delete(physical); }],
    ['the object has another size', (e: ReturnType<typeof sqliteEnv>, physical: string) => { e.bucket.seed(physical, { size: 3, bytes: new Uint8Array(3) }); }],
    ['the object has other bytes', (e: ReturnType<typeof sqliteEnv>, physical: string) => {
      const held = e.bucket.objects.get(physical)!;
      e.bucket.seed(physical, { size: held.size, bytes: new Uint8Array(held.size) });
    }],
    ['the registration names another size', (e: ReturnType<typeof sqliteEnv>) => { e.sqlite.run('UPDATE blobs SET size=size+1'); }],
  ] as const) {
    it(`stores an identical payload inline and reads it back byte for byte when ${name}`, async () => {
      const e = sqliteEnv();
      const t = await member(e);
      const payload = promptOf(EVENT_INLINE_PAYLOAD_BYTES + 5, uuid(21));
      expect(await json(await post(e, t.token, { eventId: uuid(22), payload }))).toEqual({ persisted: true, projected: true });
      damage(e, e.bucket.puts[0]!);
      expect(await json(await post(e, t.token, { eventId: uuid(23), payload }))).toEqual({ persisted: true, projected: true });
      expect(stored(e, uuid(23)).payload_format).toBe('inline');
      expect(await eventContent(e.serverEnv, 'proj_1', uuid(23))).toBe(JSON.stringify(payload));
    });
  }

  it('names the blob upload only on the event route, where a caller can make that call', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const oversized = '0'.repeat(MAX_BODY_BYTES + 1);
    const event = await json(await worker.fetch(memberPost(t.token, oversized), e.env));
    expect(event).toEqual({ persisted: false, code: 'body_cap', reason: `${bodyCapReason(MAX_BODY_BYTES + 1, MAX_BODY_BYTES)} ${EVENT_BODY_CAP_NEXT_CALL}` });
    const tool = await json(await worker.fetch(memberPost(t.token, oversized, '/mcp'), e.env));
    expect(JSON.stringify(tool)).toContain(bodyCapReason(MAX_BODY_BYTES + 1, MAX_BODY_BYTES));
    expect(JSON.stringify(tool)).not.toContain('/blobs');
  });
});
