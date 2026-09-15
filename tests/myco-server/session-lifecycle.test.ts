/**
 * A session's lifecycle at its two projections: an end on any channel applies
 * only when it is not older than the newest captured human turn, a newer human
 * turn reopens, a replayed event changes nothing, an import's end applies over
 * the turns it brings and requests no title, and none of it reads the raw
 * event log.
 */
import { describe, expect, it } from 'bun:test';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { sqliteD1, seededSqlite, seedCredential } from './helpers/d1.js';
import { envelope, uuid } from './helpers/fixtures.js';

function rig() {
  const sqlite = seededSqlite();
  seedCredential(sqlite, { id: 'mt_1', machineId: 'machine_1', hash: 'h1' });
  const db = sqliteD1(sqlite);
  const ctx = { projectId: 'proj_1', machineId: 'machine_1', tokenId: 'mt_1', bodyBytes: 100, now: 10_000 };
  let n = 100;
  /** One event of `kind` at caller time `at`, on `channel`; a distinct id unless one is given. */
  const send = (kind: string, at: number, payload: Record<string, unknown>, over: { channel?: string; eventId?: string; actor?: string } = {}) =>
    ingestEvent(db, over.actor === undefined ? ctx : { ...ctx, writeOrigin: 'server' as const, actor: over.actor }, envelope({ eventId: over.eventId ?? uuid(n++), sessionId: 'sess_1', kind, createdAt: at, channel: over.actor === undefined ? over.channel ?? 'cli' : 'http', payload }));
  const end = (at: number, over: { channel?: string; eventId?: string; actor?: string } = {}) => send('session.end', at, { endedAt: at }, over);
  const prompt = (at: number, over: { channel?: string; origin?: string; eventId?: string; promptId?: string } = {}) =>
    send('prompt', at, { promptId: over.promptId ?? uuid(n++), text: `turn at ${at}`, origin: over.origin ?? 'user' }, over);
  const row = () => sqlite.query(`SELECT ended_at AS endedAt, ended_by AS endedBy, titling_requested_at AS requestedAt, titled_at AS titledAt FROM sessions WHERE session_id = 'sess_1'`).get() as { endedAt: number | null; endedBy: string | null; requestedAt: number | null; titledAt: number | null };
  return { sqlite, db, send, end, prompt, row };
}

describe('a session\'s lifecycle', () => {
  it('ends on a hook end, reopens on a newer live human turn, and ends again on a newer end', async () => {
    const r = rig();
    await r.prompt(1_000);
    await r.end(2_000);
    expect(r.row()).toMatchObject({ endedAt: 2_000, requestedAt: 2_000 });
    await r.prompt(3_000);
    expect(r.row().endedAt).toBeNull();
    await r.end(4_000);
    expect(r.row()).toMatchObject({ endedAt: 4_000, requestedAt: 2_000 });
  });

  it('leaves a resumed session open when an older end arrives after the newer turn, in either delivery order', async () => {
    const late = rig();
    await late.prompt(3_000);
    await late.end(2_000);
    expect(late.row()).toMatchObject({ endedAt: null, requestedAt: null });

    const early = rig();
    await early.end(2_000);
    await early.prompt(3_000);
    expect(early.row().endedAt).toBeNull();
    await early.end(2_500);
    expect(early.row()).toMatchObject({ endedAt: null, requestedAt: 2_000 });
  });

  it('changes nothing on a replayed end or a replayed prompt, and does not reopen on a prompt older than the end', async () => {
    const r = rig();
    await r.prompt(1_000, { eventId: uuid(1), promptId: uuid(2) });
    await r.end(2_000, { eventId: uuid(3) });
    await r.end(2_000, { eventId: uuid(3) });
    await r.prompt(1_000, { eventId: uuid(1), promptId: uuid(2) });
    expect(r.row()).toMatchObject({ endedAt: 2_000, requestedAt: 2_000 });
    await r.prompt(1_500);
    expect(r.row().endedAt).toBe(2_000);
    await r.prompt(2_000);
    expect(r.row().endedAt).toBe(2_000);
  });

  it('decides a reopen from the stored turn, so the same prompt replayed under a fresh event id and a later instant changes nothing', async () => {
    const r = rig();
    const promptId = uuid(2);
    await r.prompt(1_000, { eventId: uuid(1), promptId });
    await r.end(2_000, { eventId: uuid(3) });
    expect(await r.prompt(3_000, { eventId: uuid(4), promptId })).toMatchObject({ persisted: true });
    expect(r.sqlite.query(`SELECT created_at AS at FROM prompt_batches WHERE prompt_id = ?`).all(promptId)).toEqual([{ at: 1_000 }]);
    expect(r.row()).toMatchObject({ endedAt: 2_000, requestedAt: 2_000 });
    // The same id with other text is a conflict the row refuses; it moves nothing either.
    await r.send('prompt', 4_000, { promptId, text: 'not the same turn', origin: 'user' }, { eventId: uuid(5) });
    expect(r.row().endedAt).toBe(2_000);
    // A turn the store actually admits after the end still reopens.
    await r.prompt(5_000);
    expect(r.row().endedAt).toBeNull();
  });

  it('applies an import\'s end over the turns the file holds in either delivery order, requests no title, and leaves a delayed import end unapplied after newer live capture', async () => {
    const r = rig();
    await r.prompt(5_000, { channel: 'import' });
    await r.end(6_000, { channel: 'import' });
    expect(r.row()).toMatchObject({ endedAt: 6_000, requestedAt: null });
    await r.prompt(5_500, { channel: 'import' });
    await r.prompt(6_000, { channel: 'import' });
    expect(r.row().endedAt).toBe(6_000);
    await r.prompt(7_000);
    expect(r.row().endedAt).toBeNull();

    const endFirst = rig();
    await endFirst.end(6_000, { channel: 'import' });
    await endFirst.prompt(5_000, { channel: 'import' });
    expect(endFirst.row()).toMatchObject({ endedAt: 6_000, requestedAt: null });

    // Live capture newer than the file's instant, whichever lands first: the import's end is left unapplied.
    const late = rig();
    await late.prompt(9_000);
    await late.end(8_000, { channel: 'import' });
    expect(late.row()).toMatchObject({ endedAt: null, requestedAt: null });
    const later = rig();
    await later.end(8_000, { channel: 'import' });
    await later.prompt(9_000);
    await later.end(8_500, { channel: 'import' });
    expect(later.row()).toMatchObject({ endedAt: null, requestedAt: null });
  });

  it('decides from projected rows alone: with every raw event evicted, an older end after a newer turn stays unapplied and a newer turn still reopens', async () => {
    const evicted = rig();
    await evicted.prompt(3_000);
    evicted.sqlite.run(`DELETE FROM events`);
    await evicted.end(2_000);
    expect(evicted.row()).toMatchObject({ endedAt: null, requestedAt: null });

    const reopened = rig();
    await reopened.end(2_000);
    reopened.sqlite.run(`DELETE FROM events`);
    await reopened.prompt(3_000);
    expect(reopened.row().endedAt).toBeNull();
    reopened.sqlite.run(`DELETE FROM events`);
    await reopened.end(2_500);
    expect(reopened.row().endedAt).toBeNull();
    await reopened.end(4_000);
    expect(reopened.row().endedAt).toBe(4_000);
  });

  it('does not reopen on a prompt nobody typed, and never touches the titling attempt', async () => {
    const r = rig();
    await r.prompt(1_000);
    await r.end(2_000);
    r.sqlite.run(`UPDATE sessions SET titled_at = 2_000 WHERE session_id = 'sess_1'`);
    await r.prompt(3_000, { origin: 'system' });
    expect(r.row()).toMatchObject({ endedAt: 2_000, titledAt: 2_000 });
    await r.prompt(4_000);
    expect(r.row()).toMatchObject({ endedAt: null, titledAt: 2_000 });
  });

  it('attributes an applied end to the acting member only: an agent\'s later end clears it, a stale or replayed end leaves it, and a reopen clears it', async () => {
    const r = rig();
    await r.prompt(1_000);
    await r.end(2_000, { actor: 'mem_1' });
    expect(r.row()).toMatchObject({ endedAt: 2_000, endedBy: 'mem_1', requestedAt: 2_000 });
    await r.end(1_500, { actor: 'mem_2' });
    expect(r.row()).toMatchObject({ endedAt: 2_000, endedBy: 'mem_1' });
    await r.end(2_000, { eventId: uuid(9), actor: 'mem_2' });
    await r.end(2_000, { eventId: uuid(9), actor: 'mem_2' });
    expect(r.row()).toMatchObject({ endedAt: 2_000, endedBy: 'mem_1' });
    await r.end(3_000);
    expect(r.row()).toMatchObject({ endedAt: 3_000, endedBy: null });
    await r.end(4_000, { actor: 'mem_2' });
    expect(r.row()).toMatchObject({ endedAt: 4_000, endedBy: 'mem_2' });
    await r.prompt(5_000);
    expect(r.row()).toMatchObject({ endedAt: null, endedBy: null });
    await r.end(6_000, { channel: 'import' });
    expect(r.row()).toMatchObject({ endedAt: 6_000, endedBy: null, requestedAt: 2_000 });
  });
});
