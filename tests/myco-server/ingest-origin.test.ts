/**
 * Who the Deployment writes as, and what that changes.
 *
 * A member's write is charged to its quota and admitted only while its
 * credential is live. A write the Deployment makes for itself — an event
 * derived from transcript bytes a member already shipped and already paid for
 * — is neither. A member credential rotates, and every rotation
 * revokes its predecessor; an event derived from that credential's bytes must
 * still land afterwards, or a long-lived transcript loses every row it had left
 * to give at the moment its credential turned over.
 *
 * These drive `planEventWrite` directly rather than the route, so the admission
 * is observed where it is decided.
 */
import type { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { ingestEvent, planEventWrite } from '@myco-server-worker/ingest/events.js';
import { count, envelope, sqliteEnv, bytesWritten, uuid } from './helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';

const NOW = 1_000_000;
const PROJECT = 'proj_1';

async function rig() {
  const { sqlite, serverEnv } = sqliteEnv();
  const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
  return { sqlite, db: serverEnv.db, tokenId: issued.tokenId };
}

const ctxFor = (tokenId: string, writeOrigin?: 'member' | 'server') =>
  ({ projectId: PROJECT, machineId: 'machine_1', tokenId, bodyBytes: 100, now: NOW, ...(writeOrigin === undefined ? {} : { writeOrigin }) });

const start = (n: number) => envelope({ eventId: uuid(n), kind: 'session.start', payload: { agent: 'claude-code', startedAt: NOW - 1 } });

const revoke = (sqlite: Database, tokenId: string): void => {
  sqlite.run(`UPDATE member_credentials SET revoked_at = ? WHERE id = ?`, [NOW, tokenId]);
};

describe('write origin', () => {
  it('charges a member write to its credential and stores the event', async () => {
    const { sqlite, db, tokenId } = await rig();
    const result = await ingestEvent(db, ctxFor(tokenId), start(1));
    expect(result.persisted).toBe(true);
    expect(bytesWritten(sqlite, tokenId)).toBe(100);
    expect(count(sqlite, 'events')).toBe(1);
  });

  it('refuses a member write once its credential is revoked', async () => {
    const { sqlite, db, tokenId } = await rig();
    revoke(sqlite, tokenId);
    const result = await ingestEvent(db, ctxFor(tokenId), start(2));
    expect(result.persisted).toBe(false);
    expect(count(sqlite, 'events')).toBe(0);
  });

  it('stores a server write under the same revoked credential, which is what keeps a parse alive across a rotation', async () => {
    const { sqlite, db, tokenId } = await rig();
    revoke(sqlite, tokenId);
    const result = await ingestEvent(db, ctxFor(tokenId, 'server'), start(3));
    expect(result).toMatchObject({ persisted: true, projected: true });
    expect(count(sqlite, 'events')).toBe(1);
    expect(count(sqlite, 'sessions')).toBe(1);
  });

  it('charges a server write nothing: the bytes it derives from were charged when the member shipped them', async () => {
    const { sqlite, db, tokenId } = await rig();
    await ingestEvent(db, ctxFor(tokenId, 'server'), start(4));
    expect(bytesWritten(sqlite, tokenId)).toBe(0);
    expect(count(sqlite, 'events')).toBe(1);
  });

  it('still stamps the credential the bytes arrived on, so provenance survives the uncharged write', async () => {
    const { sqlite, db, tokenId } = await rig();
    await ingestEvent(db, ctxFor(tokenId, 'server'), start(5));
    const row = sqlite.query(`SELECT token_id FROM events`).get() as { token_id: string };
    expect(row.token_id).toBe(tokenId);
  });

  it('defaults to a member write when no origin is named, so nothing becomes uncharged by omission', async () => {
    const { sqlite, db, tokenId } = await rig();
    revoke(sqlite, tokenId);
    expect((await ingestEvent(db, ctxFor(tokenId), start(6))).persisted).toBe(false);
    expect(count(sqlite, 'events')).toBe(0);
  });

  it('does not move a session\'s last receipt: reading stored bytes is not contact from a member', async () => {
    const { sqlite, db, tokenId } = await rig();
    const old = NOW - 30 * 86_400_000;
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                VALUES (?, 'old', 'machine_1', ?, ?, ?)`, [PROJECT, tokenId, old, old]);
    await ingestEvent(db, ctxFor(tokenId, 'server'), envelope({ eventId: uuid(20), sessionId: 'old', kind: 'prompt', payload: { promptId: uuid(21), text: 'derived', origin: 'user' } }));
    const row = sqlite.query(`SELECT last_received_at FROM sessions WHERE session_id = 'old'`).get() as { last_received_at: number };
    expect(row.last_received_at).toBe(old);
    expect(count(sqlite, 'prompt_batches')).toBe(1);
  });

  it('a member write still moves it, which is what the power depth reads', async () => {
    const { sqlite, db, tokenId } = await rig();
    const old = NOW - 30 * 86_400_000;
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                VALUES (?, 'old', 'machine_1', ?, ?, ?)`, [PROJECT, tokenId, old, old]);
    await ingestEvent(db, ctxFor(tokenId), envelope({ eventId: uuid(22), sessionId: 'old', kind: 'prompt', payload: { promptId: uuid(23), text: 'shipped', origin: 'user' } }));
    const row = sqlite.query(`SELECT last_received_at FROM sessions WHERE session_id = 'old'`).get() as { last_received_at: number };
    expect(row.last_received_at).toBe(NOW);
  });

  it('opens a session row a server write names but nothing has opened yet', async () => {
    const { sqlite, db, tokenId } = await rig();
    await ingestEvent(db, ctxFor(tokenId, 'server'), envelope({ eventId: uuid(24), sessionId: 'fresh', kind: 'prompt', payload: { promptId: uuid(25), text: 'derived', origin: 'user' } }));
    expect(count(sqlite, 'sessions')).toBe(1);
    expect(count(sqlite, 'prompt_batches')).toBe(1);
  });

  it('holds every other admission for a server write: an archived Project still refuses it', async () => {
    const { sqlite, db, tokenId } = await rig();
    sqlite.run(`UPDATE projects SET archived_at = ? WHERE project_id = ?`, [NOW, PROJECT]);
    const result = await ingestEvent(db, ctxFor(tokenId, 'server'), start(7));
    expect(result.persisted).toBe(false);
    expect(count(sqlite, 'events')).toBe(0);
  });
});

describe('planned writes', () => {
  it('answers statements and an interpreter without touching the store', async () => {
    const { sqlite, db, tokenId } = await rig();
    const planned = await planEventWrite(db, ctxFor(tokenId), start(8));
    expect(planned.ok).toBe(true);
    expect(count(sqlite, 'events')).toBe(0);
  });

  it('refuses a malformed envelope before planning any statement', async () => {
    const { db, tokenId } = await rig();
    const planned = await planEventWrite(db, ctxFor(tokenId), envelope({ kind: 'not.a.kind' }));
    expect(planned.ok).toBe(false);
  });

  it('lands many events in ONE batch, which is what keeps a parse pass inside the subrequest budget', async () => {
    const { sqlite, db, tokenId } = await rig();
    const events = [start(10), start(11), start(12), start(13)];
    const planned = [];
    for (const e of events) {
      const p = await planEventWrite(db, ctxFor(tokenId, 'server'), e);
      expect(p.ok).toBe(true);
      if (p.ok) planned.push(p.write);
    }

    let calls = 0;
    const counting = { ...db, batch: (s: Parameters<typeof db.batch>[0]) => { calls += 1; return db.batch(s); } };
    const results = await counting.batch(planned.flatMap((w) => w.statements));

    let at = 0;
    const outcomes = planned.map((w) => {
      const slice = results.slice(at, at + w.statements.length);
      at += w.statements.length;
      return w.interpret(slice as Parameters<typeof w.interpret>[0]);
    });

    expect(calls).toBe(1);
    expect(outcomes.every((o) => o.persisted)).toBe(true);
    expect(count(sqlite, 'events')).toBe(4);
  });
});
