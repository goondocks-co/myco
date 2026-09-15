/**
 * A person's end of a session over the owner route: decided before any write,
 * so an unknown or deleted session opens nothing; a repeat is a no-op; the end
 * lands through ingest and requests a title like an agent's end does.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { listReadyTitleSessions } from '@myco-server-worker/read/children.js';
import { endSession } from '@myco-server-worker/core/session-end.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { count, envelope, sqliteEnv, uuid } from './helpers/fixtures.js';

/** A little before the request clock the route reads, so seeded turns are older than the end it writes. */
const NOW = Date.now() - 600_000;

async function rig() {
  const e = sqliteEnv();
  const issued = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
  const cookie = await ownerCookie();
  const session = (id: string, over: { endedAt?: number | null } = {}) =>
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at)
                  VALUES ('proj_1', ?, 'machine_1', ?, ?, ?, 'claude-code', ?, ?)`, [id, issued.tokenId, NOW - 10_000, NOW - 5_000, NOW - 10_000, over.endedAt ?? null]);
  const post = (id: string, headers: Record<string, string> = { cookie, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' }) =>
    worker.fetch(new Request(`https://s/api/projects/proj_1/sessions/${id}/end`, { method: 'POST', headers }), { ...e.env, ...OWNER_ENV });
  const row = (id: string) => e.sqlite.query(`SELECT ended_at AS endedAt, ended_by AS endedBy, titling_requested_at AS requestedAt, last_received_at AS lastReceivedAt FROM sessions WHERE session_id = ?`).get(id) as { endedAt: number | null; endedBy: string | null; requestedAt: number | null; lastReceivedAt: number } | null;
  return { ...e, session, post, row, tokenId: issued.tokenId };
}

describe('ending a session as a person', () => {
  it('ends an open session once through ingest, requesting a title and moving no receipt; a repeat is a no-op', async () => {
    const r = await rig();
    r.session('s1');
    r.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                  VALUES ('proj_1', 's1', 'p1', 'e1', 'first turn', 'user', 'h1', ?, ?, ?, ?)`, [NOW - 8_000, NOW - 8_000, r.tokenId, NOW - 8_000]);
    const first = await r.post('s1');
    expect(first.status).toBe(200);
    const body = (await first.json()) as { outcome: string; endedAt: number };
    expect(body.outcome).toBe('ended');
    expect(r.row('s1')).toEqual({ endedAt: body.endedAt, endedBy: 'mem_machine_1', requestedAt: body.endedAt, lastReceivedAt: NOW - 5_000 });
    expect(r.sqlite.query(`SELECT kind, channel, producer_adapter AS adapter, token_id AS tokenId FROM events`).all()).toEqual([{ kind: 'session.end', channel: 'http', adapter: 'deployment', tokenId: r.tokenId }]);
    expect((await listReadyTitleSessions(r.db, 10)).map((s) => s.sessionId)).toEqual(['s1']);

    const again = await r.post('s1');
    expect(await again.json() as unknown).toEqual({ outcome: 'already_ended', endedAt: body.endedAt });
    expect(count(r.sqlite, 'events')).toBe(1);
  });

  /** A store that runs `between` once, before the first batch the end writes: what lands between the read and the write. */
  const interleaving = (db: RelationalStore, between: () => Promise<void>): RelationalStore => {
    let ran = false;
    return { ...db, batch: async (statements) => { if (!ran) { ran = true; await between(); } return db.batch(statements); } };
  };

  it('answers open, not ended, when a newer human turn lands between the read and the write', async () => {
    const r = await rig();
    r.session('s1');
    const ctx = { projectId: 'proj_1', machineId: 'machine_1', tokenId: r.tokenId, bodyBytes: 10, now: NOW };
    const db = interleaving(r.db, async () => {
      expect(await ingestEvent(r.db, ctx, envelope({ eventId: uuid(7), sessionId: 's1', createdAt: NOW + 1, payload: { promptId: uuid(8), text: 'still here', origin: 'user' } }))).toMatchObject({ persisted: true });
    });
    expect(await endSession(db, { projectId: 'proj_1' }, 's1', NOW, 'mem_1')).toEqual({ outcome: 'open', endedAt: null });
    expect(r.row('s1')).toMatchObject({ endedAt: null, endedBy: null, requestedAt: null });
    expect(count(r.sqlite, 'events')).toBe(2);
  });

  it('answers absent, writing nothing, when the session is deleted between the read and the write', async () => {
    const r = await rig();
    r.session('s1');
    const db = interleaving(r.db, async () => {
      r.sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES ('proj_1', 's1', NULL, ?, 'mem_1')`, [NOW]);
    });
    expect(await endSession(db, { projectId: 'proj_1' }, 's1', NOW, 'mem_1')).toBeNull();
    expect(count(r.sqlite, 'events')).toBe(0);
    expect(r.row('s1')?.endedAt).toBeNull();
  });

  it('answers 404 for an unknown session and for a deleted one, writing nothing and opening no session row', async () => {
    const r = await rig();
    r.session('gone');
    r.sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES ('proj_1', 'gone', NULL, ?, 'mem_1')`, [NOW]);
    expect((await r.post('never')).status).toBe(404);
    expect((await r.post('gone')).status).toBe(404);
    expect(count(r.sqlite, 'events')).toBe(0);
    expect(count(r.sqlite, 'sessions')).toBe(1);
    expect(r.row('gone')?.endedAt).toBeNull();
  });

  it('refuses a caller with no owner session', async () => {
    const r = await rig();
    r.session('s1');
    expect((await r.post('s1', { 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' })).status).toBe(401);
    expect(count(r.sqlite, 'events')).toBe(0);
  });
});
