import { describe, it, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { cloudflareSourceOf } from '@myco-server-worker/platform/cloudflare/source.js';
import {
  MEMBER_TOKEN_MAX_LINEAGE_MS, MEMBER_TOKEN_PATTERN, MEMBER_TOKEN_REFRESH_WINDOW_MS, MEMBER_TOKEN_TTL_MS,
  issueMemberToken, revokeCredentialAsMember, revokeMemberLineage,
} from '@myco-server-worker/auth/tokens.js';
import { BLOB_RESERVATION_TTL_MS, PROTOCOL_HEADER, RETRY_AFTER_SECONDS, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { blobPost, bytesWritten, count, envelope, journaled, memberHeaders, memberPost, noOutboundFetch, RETIRED_BYTE_CEILING, sqliteEnv, uuid } from './helpers/fixtures.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';

const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;
const T0 = 1_700_000_000_000;
const WINDOW_OPENS = T0 + MEMBER_TOKEN_TTL_MS - MEMBER_TOKEN_REFRESH_WINDOW_MS;

/** A server over a clock the test moves, with a member of machine_1 minted at T0. */
async function rig(opts: Parameters<typeof sqliteEnv>[0] = {}) {
  const e = sqliteEnv(opts);
  const clock = { now: T0 };
  const server = createServer({ now: () => clock.now, sourceOf: cloudflareSourceOf, fetchImpl: noOutboundFetch });
  const root = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, T0);
  const fetch = (req: Request) => server.handleRequest(req, e.serverEnv);
  const refresh = (token: string, body = '{}') => fetch(memberPost(token, body, '/tokens/refresh'));
  const post = (token: string, n: number) => fetch(memberPost(token, envelope({ eventId: uuid(n), payload: { promptId: uuid(1_000 + n), text: `p${n}`, origin: 'user' } })));
  const row = (tokenId: string) => e.sqlite.query(`SELECT id, predecessor_id, lineage_root, lineage_started_at, first_used_at, expires_at, revoked_at, bytes_written FROM member_credentials WHERE id = ?`).get(tokenId) as Record<string, unknown>;
  const lines: string[] = [];
  const capture = async <T,>(f: () => Promise<T>): Promise<T> => {
    const orig = console.log;
    console.log = (s: string) => { lines.push(s); };
    try { return await f(); } finally { console.log = orig; }
  };
  const emitted = (kind: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.kind === kind);
  return { e, clock, root, fetch, refresh, post, row, capture, emitted };
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** Refreshes `token` at the top of its window and returns the successor's answer. */
async function successorOf(r: Rig, token: string, expiresAt: number) {
  r.clock.now = Math.max(r.clock.now, expiresAt - MEMBER_TOKEN_REFRESH_WINDOW_MS);
  const body = await json(await r.refresh(token));
  expect(body.refreshed).toBe(true);
  return body as { refreshed: true; token: string; tokenId: string; expiresAt: number; refreshAfter: number };
}

describe('token refresh', () => {
  it('refuses a refresh before the window opens with refresh_too_early and the instant it opens, inserting nothing', async () => {
    const r = await rig();
    for (const at of [T0, T0 + 1, WINDOW_OPENS - 1]) {
      r.clock.now = at;
      const res = await r.refresh(r.root.token);
      expect({ at, status: res.status, body: await json(res) }).toEqual({ at, status: 200, body: { refreshed: false, code: 'refresh_too_early', reason: 'refresh window not yet open', refreshAfter: WINDOW_OPENS } });
    }
    expect(count(r.e.sqlite, 'member_credentials')).toBe(1);
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: null, first_used_at: null });
  });

  it('issues a successor at the window: a new live token in the predecessor\'s lineage, unused and uncharged, expiring one TTL from now, answered once with its own window start; the predecessor stays live', async () => {
    const r = await rig();
    r.clock.now = WINDOW_OPENS;
    const res = await r.capture(() => r.refresh(r.root.token));
    expect(res.status).toBe(200);
    expect(res.headers.get(PROTOCOL_HEADER)).toBe(String(SERVER_PROTOCOL));
    const body = await json(res);
    expect(body).toEqual({ refreshed: true, token: expect.stringMatching(MEMBER_TOKEN_PATTERN), tokenId: expect.stringMatching(/^mt_/), expiresAt: WINDOW_OPENS + MEMBER_TOKEN_TTL_MS, refreshAfter: WINDOW_OPENS + MEMBER_TOKEN_TTL_MS - MEMBER_TOKEN_REFRESH_WINDOW_MS });
    expect(body.token).not.toBe(r.root.token);
    expect(r.row(body.tokenId as string)).toEqual({
      id: body.tokenId, predecessor_id: r.root.tokenId, lineage_root: r.root.tokenId, lineage_started_at: T0, first_used_at: null,
      expires_at: WINDOW_OPENS + MEMBER_TOKEN_TTL_MS, revoked_at: null, bytes_written: 0,
    });
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: null, lineage_root: r.root.tokenId, predecessor_id: null });
    expect(r.emitted('token_refreshed')).toEqual([{ kind: 'token_refreshed', memberId: 'mem_machine_1', tokenId: body.tokenId, predecessorId: r.root.tokenId }]);
    expect(JSON.stringify(r.emitted('token_refreshed'))).not.toContain(body.token as string);
    expect((await json(await r.post(r.root.token, 1))).persisted).toBe(true);
  });

  it('keeps exactly one live successor per predecessor: each further refresh revokes the unused successor before it and the successor\'s own refresh starts the next link', async () => {
    const r = await rig();
    r.clock.now = WINDOW_OPENS;
    const issued: string[] = [];
    for (let i = 0; i < 4; i++) {
      r.clock.now += 1;
      issued.push((await successorOf(r, r.root.token, r.root.expiresAt)).tokenId);
    }
    const live = r.e.sqlite.query(`SELECT id FROM member_credentials WHERE predecessor_id = ? AND revoked_at IS NULL`).all(r.root.tokenId) as { id: string }[];
    expect(live).toEqual([{ id: issued[3] }]);
    expect(r.e.sqlite.query(`SELECT id, revoked_at FROM member_credentials WHERE predecessor_id = ? ORDER BY revoked_at`).all(r.root.tokenId))
      .toEqual([{ id: issued[3], revoked_at: null }, { id: issued[0], revoked_at: WINDOW_OPENS + 2 }, { id: issued[1], revoked_at: WINDOW_OPENS + 3 }, { id: issued[2], revoked_at: WINDOW_OPENS + 4 }]);
    expect(count(r.e.sqlite, 'member_credentials')).toBe(5);
    for (const stale of issued.slice(0, 3)) expect((await r.fetch(memberPost(stale, '{}', '/tokens/refresh'))).status).toBe(401);
  });

  it('clamps every successor to the lineage ceiling and answers lineage_expired to a token already expiring at it, without refreshAfter', async () => {
    const r = await rig();
    const startedAt = T0 - MEMBER_TOKEN_MAX_LINEAGE_MS + MEMBER_TOKEN_TTL_MS + 1_000;
    r.e.sqlite.query(`UPDATE member_credentials SET lineage_started_at = ? WHERE id = ?`).run(startedAt, r.root.tokenId);
    const ceiling = startedAt + MEMBER_TOKEN_MAX_LINEAGE_MS;
    expect(ceiling).toBeGreaterThan(r.root.expiresAt);
    r.clock.now = WINDOW_OPENS;
    const clamped = await json(await r.refresh(r.root.token));
    expect(clamped).toMatchObject({ refreshed: true, expiresAt: ceiling, refreshAfter: ceiling - MEMBER_TOKEN_REFRESH_WINDOW_MS });
    expect(r.row(clamped.tokenId as string)).toMatchObject({ expires_at: ceiling, lineage_started_at: startedAt, lineage_root: r.root.tokenId });
    r.clock.now = ceiling - MEMBER_TOKEN_REFRESH_WINDOW_MS;
    const res = await r.capture(() => r.refresh(clamped.token as string));
    expect({ status: res.status, body: await json(res) }).toEqual({ status: 200, body: { refreshed: false, code: 'lineage_expired', reason: 'token lineage expired' } });
    expect(r.emitted('refresh_refused')).toEqual([{ kind: 'refresh_refused', memberId: 'mem_machine_1', tokenId: clamped.tokenId, reason: 'lineage_expired' }]);
    expect(count(r.e.sqlite, 'member_credentials')).toBe(2);
    r.clock.now = ceiling - 1;
    expect((await json(await r.post(clamped.token as string, 1))).persisted).toBe(true);
    r.clock.now = ceiling;
    expect((await r.post(clamped.token as string, 2)).status).toBe(401);
  });

  it('activates a successor at its first authenticated use, once: the predecessor is valid until then and revoked after, and the successor takes over its charged bytes plus its live reservations in that batch', async () => {
    const r = await rig();
    expect((await json(await r.post(r.root.token, 1))).persisted).toBe(true);
    const charged = bytesWritten(r.e.sqlite, r.root.tokenId);
    expect(charged).toBeGreaterThan(0);
    const successor = await successorOf(r, r.root.token, r.root.expiresAt);
    expect((await json(await r.post(r.root.token, 2))).persisted).toBe(true);
    const chargedAfter = bytesWritten(r.e.sqlite, r.root.tokenId);
    expect(chargedAfter).toBeGreaterThan(charged);
    r.e.sqlite.query(`INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at) VALUES ('live', 'proj_1', 'k1', ?, 500, ?), ('dead', 'proj_1', 'k2', ?, 7_000, ?), ('other', 'proj_1', 'k3', 'mt_other', 900, ?)`)
      .run(r.root.tokenId, r.clock.now + BLOB_RESERVATION_TTL_MS, r.root.tokenId, r.clock.now, r.clock.now + BLOB_RESERVATION_TTL_MS);
    r.clock.now += 10;
    const firstUse = r.clock.now;
    const res = await r.capture(() => r.post(successor.token, 3));
    expect((await json(res)).persisted).toBe(true);
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: firstUse, bytes_written: chargedAfter });
    const successorRow = r.row(successor.tokenId);
    const own = bytesWritten(r.e.sqlite, successor.tokenId) - chargedAfter - 500;
    expect(own).toBeGreaterThan(0);
    expect(successorRow).toMatchObject({ first_used_at: firstUse, revoked_at: null });
    expect(r.emitted('successor_activated')).toEqual([{ kind: 'successor_activated', memberId: 'mem_machine_1', tokenId: successor.tokenId, predecessorId: r.root.tokenId }]);
    expect((await r.post(r.root.token, 4)).status).toBe(401);
    r.clock.now += 10;
    expect((await json(await r.capture(() => r.post(successor.token, 5)))).persisted).toBe(true);
    expect(r.row(successor.tokenId)).toMatchObject({ first_used_at: firstUse });
    expect(bytesWritten(r.e.sqlite, successor.tokenId)).toBe(chargedAfter + 500 + own * 2);
    expect(r.emitted('successor_activated')).toHaveLength(1);
  });

  it('activates on the refresh route too, and carries the held bytes even when the predecessor has already expired on its own', async () => {
    const r = await rig();
    expect((await json(await r.post(r.root.token, 1))).persisted).toBe(true);
    const charged = bytesWritten(r.e.sqlite, r.root.tokenId);
    const successor = await successorOf(r, r.root.token, r.root.expiresAt);
    r.clock.now = r.root.expiresAt + 1_000;
    expect((await r.post(r.root.token, 2)).status).toBe(401);
    const early = await json(await r.refresh(successor.token));
    expect(early).toMatchObject({ refreshed: false, code: 'refresh_too_early' });
    expect(r.row(successor.tokenId)).toMatchObject({ first_used_at: r.clock.now, bytes_written: charged });
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: r.clock.now });
  });

  it('activates ahead of the token limiter: a successor refused by its own bucket still revokes its predecessor', async () => {
    const r = await rig();
    const successor = await successorOf(r, r.root.token, r.root.expiresAt);
    r.e.env.TOKEN_LIMIT = { limit: async () => ({ success: false }) };
    r.clock.now += 5;
    expect((await r.post(successor.token, 1)).status).toBe(429);
    expect(r.row(successor.tokenId)).toMatchObject({ first_used_at: r.clock.now });
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: r.clock.now });
  });

  it('carries nothing and still activates when the predecessor row is gone', async () => {
    const r = await rig();
    expect((await json(await r.post(r.root.token, 1))).persisted).toBe(true);
    const successor = await successorOf(r, r.root.token, r.root.expiresAt);
    r.e.sqlite.query(`DELETE FROM member_credentials WHERE id = ?`).run(r.root.tokenId);
    r.clock.now += 1;
    expect((await json(await r.post(successor.token, 2))).persisted).toBe(true);
    const own = bytesWritten(r.e.sqlite, successor.tokenId);
    expect(own).toBeGreaterThan(0);
    expect(r.row(successor.tokenId)).toMatchObject({ first_used_at: r.clock.now, revoked_at: null });
    expect((await json(await r.post(successor.token, 3))).persisted).toBe(true);
    expect(bytesWritten(r.e.sqlite, successor.tokenId)).toBe(own * 2);
  });

  it('admits nothing for a predecessor\'s stalled upload that completes after activation: the reconcile answers a revoked token as retryable, the object it put is journaled and deleted, no row lands and no counter moves', async () => {
    const r = await rig();
    const payload = new Uint8Array(4096).fill(7);
    const key = await sha256HexOf(payload);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const body = new ReadableStream<Uint8Array>({ async pull(c) { await gate; c.enqueue(payload); c.close(); } });
    r.clock.now = WINDOW_OPENS;
    const inflight = r.fetch(new Request(`https://s/blobs/${key}`, { method: 'POST', headers: memberHeaders(r.root.token, { 'content-type': 'text/plain', 'content-length': String(payload.byteLength) }), body, duplex: 'half' } as any));
    await new Promise((res) => setTimeout(res, 10));
    expect(count(r.e.sqlite, 'blob_reservations')).toBe(1);
    const successor = await successorOf(r, r.root.token, r.root.expiresAt);
    r.clock.now += BLOB_RESERVATION_TTL_MS + 1;
    const firstUse = r.clock.now;
    expect((await json(await r.post(successor.token, 1))).persisted).toBe(true);
    const carried = bytesWritten(r.e.sqlite, successor.tokenId);
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: firstUse, bytes_written: 0 });
    release();
    const answered = await inflight;
    expect({ status: answered.status, body: await json(answered) }).toEqual({ status: 503, body: { stored: false, code: 'unavailable', reason: 'unavailable' } });
    expect(bytesWritten(r.e.sqlite, r.root.tokenId)).toBe(0);
    expect(bytesWritten(r.e.sqlite, successor.tokenId)).toBe(carried);
    expect(count(r.e.sqlite, 'blobs')).toBe(0);
    expect(count(r.e.sqlite, 'blob_reservations')).toBe(0);
    const [put] = r.e.bucket.puts;
    expect(put).toStartWith(`proj_1/${key}~`);
    expect(journaled(r.e.sqlite)).toEqual([put!]);
    await drainObjectReleases(r.e.serverEnv, r.clock.now);
    expect(r.e.bucket.deletes).toEqual([put!]);
    expect(r.e.bucket.objects.size).toBe(0);
    r.clock.now += 1;
    expect((await json(await r.fetch(blobPost(successor.token, key, payload)))).stored).toBe(true);
  });

  it('admits nothing for a predecessor\'s event that authenticated before activation and wrote after it: retryable, and the retry meets the revocation', async () => {
    let hook: ((sqlite: Database) => void) | null = null;
    const r = await rig({ onSql: (sql, sqlite) => { if (hook && sql.includes('INSERT INTO events')) { const h = hook; hook = null; h(sqlite); } } });
    const successor = await successorOf(r, r.root.token, r.root.expiresAt);
    const activation = r.clock.now + 1;
    hook = (sqlite) => {
      sqlite.query(`UPDATE member_credentials SET bytes_written = (SELECT bytes_written FROM member_credentials WHERE id = ?), first_used_at = ? WHERE id = ?`).run(r.root.tokenId, activation, successor.tokenId);
      sqlite.query(`UPDATE member_credentials SET revoked_at = ? WHERE id = ?`).run(activation, r.root.tokenId);
    };
    const answered = await r.post(r.root.token, 1);
    expect({ status: answered.status, body: await json(answered) }).toEqual({ status: 503, body: { persisted: false, code: 'unavailable', reason: 'unavailable' } });
    expect(hook).toBeNull();
    expect(count(r.e.sqlite, 'events')).toBe(0);
    expect((await r.post(r.root.token, 1)).status).toBe(401);
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: activation, bytes_written: 0 });
    expect(bytesWritten(r.e.sqlite, successor.tokenId)).toBe(0);
  });

  it('mints nothing when a lineage revoke lands between a refresh\'s authentication and its insert: 503 in the refreshed shape, no live row under the revoked root, and the presented token answers 401 next', async () => {
    let hook: ((sqlite: Database) => void) | null = null;
    const r = await rig({ onSql: (sql, sqlite) => { if (hook && sql.includes('INSERT INTO member_credentials')) { const h = hook; hook = null; h(sqlite); } } });
    const s1 = await successorOf(r, r.root.token, r.root.expiresAt);
    r.clock.now += 1;
    const revokedAt = r.clock.now;
    hook = (sqlite) => {
      sqlite.query(`UPDATE member_credentials SET revoked_at = ? WHERE lineage_root = (SELECT lineage_root FROM member_credentials WHERE id = ?) AND revoked_at IS NULL`).run(revokedAt, r.root.tokenId);
    };
    const res = await r.capture(() => r.refresh(r.root.token));
    expect(hook).toBeNull();
    expect({ status: res.status, body: await json(res) }).toEqual({ status: 503, body: { refreshed: false, code: 'unavailable', reason: 'unavailable' } });
    expect(r.emitted('refresh_error')).toEqual([{ kind: 'refresh_error', memberId: 'mem_machine_1', tokenId: r.root.tokenId, error_class: 'revoked' }]);
    expect(r.emitted('token_refreshed')).toEqual([]);
    expect(count(r.e.sqlite, 'member_credentials')).toBe(2);
    expect(r.e.sqlite.query(`SELECT id FROM member_credentials WHERE lineage_root = ? AND revoked_at IS NULL`).all(r.root.tokenId)).toEqual([]);
    expect(r.row(s1.tokenId)).toMatchObject({ revoked_at: revokedAt });
    expect((await r.refresh(r.root.token)).status).toBe(401);
    expect((await r.post(r.root.token, 1)).status).toBe(401);
  });

  it('changes nothing when a single-token revoke of the presented token lands between a refresh\'s authentication and its batch: 503, its banked unused successor stays live and keeps working, and the presented token answers 401 next', async () => {
    let hook: ((sqlite: Database) => void) | null = null;
    const r = await rig({ onSql: (sql, sqlite) => { if (hook && sql.includes('UPDATE member_credentials SET revoked_at = ? WHERE predecessor_id = ?')) { const h = hook; hook = null; h(sqlite); } } });
    const s1 = await successorOf(r, r.root.token, r.root.expiresAt);
    r.clock.now += 1;
    const revokedAt = r.clock.now;
    hook = (sqlite) => { sqlite.query(`UPDATE member_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(revokedAt, r.root.tokenId); };
    const res = await r.refresh(r.root.token);
    expect(hook).toBeNull();
    expect({ status: res.status, body: await json(res) }).toEqual({ status: 503, body: { refreshed: false, code: 'unavailable', reason: 'unavailable' } });
    expect(count(r.e.sqlite, 'member_credentials')).toBe(2);
    expect(r.row(s1.tokenId)).toMatchObject({ revoked_at: null, first_used_at: null });
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: revokedAt });
    expect((await r.post(r.root.token, 1)).status).toBe(401);
    r.clock.now += 1;
    expect((await json(await r.post(s1.token, 2))).persisted).toBe(true);
    expect(r.row(s1.tokenId)).toMatchObject({ revoked_at: null, first_used_at: r.clock.now });
  });

  it('admits nothing for a predecessor\'s upload whose reservation is taken after activation: retryable, no row and no put', async () => {
    let hook: ((sqlite: Database) => void) | null = null;
    const r = await rig({ onSql: (sql, sqlite) => { if (hook && sql.includes('INSERT INTO blob_reservations')) { const h = hook; hook = null; h(sqlite); } } });
    const successor = await successorOf(r, r.root.token, r.root.expiresAt);
    const activation = r.clock.now + 1;
    hook = (sqlite) => {
      sqlite.query(`UPDATE member_credentials SET bytes_written = (SELECT bytes_written FROM member_credentials WHERE id = ?), first_used_at = ? WHERE id = ?`).run(r.root.tokenId, activation, successor.tokenId);
      sqlite.query(`UPDATE member_credentials SET revoked_at = ? WHERE id = ?`).run(activation, r.root.tokenId);
    };
    const payload = new Uint8Array(64).fill(3);
    const upload = await r.fetch(blobPost(r.root.token, await sha256HexOf(payload), payload));
    expect({ status: upload.status, body: await json(upload) }).toEqual({ status: 503, body: { stored: false, code: 'unavailable', reason: 'unavailable' } });
    expect(hook).toBeNull();
    expect(count(r.e.sqlite, 'blob_reservations')).toBe(0);
    expect(count(r.e.sqlite, 'blobs')).toBe(0);
    expect(r.e.bucket.puts).toEqual([]);
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: activation, bytes_written: 0 });
  });

  it('answers a constraint failure as retryable on refresh and capture alike, whatever the credential has stored: no failure reads as a quota refusal', async () => {
    const r = await rig();
    r.e.sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(RETIRED_BYTE_CEILING, r.root.tokenId);
    r.e.env.MYCO_DB = {
      ...r.e.db,
      batch: async () => { throw new Error('CHECK constraint failed: member_tokens_quota'); },
    };
    r.clock.now = WINDOW_OPENS;
    const res = await r.refresh(r.root.token);
    expect({ status: res.status, body: await json(res) }).toEqual({ status: 503, body: { refreshed: false, code: 'unavailable', reason: 'unavailable' } });
    const events = await r.post(r.root.token, 1);
    expect({ status: events.status, body: await json(events) }).toEqual({ status: 503, body: { persisted: false, code: 'unavailable', reason: 'unavailable' } });
  });

  it('revokes a whole lineage by any id in the chain, refusing every token of it afterwards and nothing outside it', async () => {
    const r = await rig();
    const s1 = await successorOf(r, r.root.token, r.root.expiresAt);
    const s2 = await successorOf(r, s1.token, s1.expiresAt);
    const s3 = await successorOf(r, s2.token, s2.expiresAt);
    const other = await issueMemberToken(r.e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, r.clock.now);
    for (const [pred, succ] of [[r.root, s1], [s1, s2], [s2, s3]] as const) expect(r.row(pred.tokenId).revoked_at).toBe(r.row(succ.tokenId).first_used_at);
    expect(r.row(s3.tokenId)).toMatchObject({ revoked_at: null, first_used_at: null });
    expect(r.e.sqlite.query(`SELECT id FROM member_credentials WHERE lineage_root = ? AND revoked_at IS NULL ORDER BY expires_at`).all(r.root.tokenId)).toEqual([{ id: s2.tokenId }, { id: s3.tokenId }]);
    expect(await revokeMemberLineage(r.e.db, s2.tokenId, r.clock.now, 'mem_machine_1')).toEqual({ revoked: 2 });
    expect(r.e.sqlite.query(`SELECT id FROM member_credentials WHERE lineage_root = ? AND revoked_at IS NULL`).all(r.root.tokenId)).toEqual([]);
    for (const t of [r.root, s1, s2, s3]) expect((await r.post(t.token, 9)).status).toBe(401);
    expect((await json(await r.post(other.token, 9))).persisted).toBe(true);
    expect(await revokeMemberLineage(r.e.db, 'mt_nobody', r.clock.now, 'mem_machine_1')).toEqual({ revoked: 0 });
    const fresh = await rig();
    const a = await successorOf(fresh, fresh.root.token, fresh.root.expiresAt);
    expect(await revokeMemberLineage(fresh.e.db, fresh.root.tokenId, fresh.clock.now, 'mem_machine_1')).toEqual({ revoked: 2 });
    for (const t of [fresh.root, a]) expect((await fresh.post(t.token, 9)).status).toBe(401);
  });

  it('refuses a revoked token on the refresh route, and an expired one on every other route: 401 without a row written', async () => {
    const r = await rig();
    const revoked = await issueMemberToken(r.e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, T0);
    await revokeCredentialAsMember(r.e.db, { id: 'mem_machine_1', label: 'machine_1', role: 'admin' }, revoked.tokenId, T0 + 1);
    r.clock.now = WINDOW_OPENS;
    expect((await r.refresh(revoked.token)).status).toBe(401);
    r.clock.now = r.root.expiresAt + 1;
    expect((await r.refresh(revoked.token)).status).toBe(401);
    expect((await r.post(r.root.token, 1)).status).toBe(401);
    expect((await r.fetch(memberPost(r.root.token, '{}', '/import/plan'))).status).toBe(401);
    expect(count(r.e.sqlite, 'member_credentials')).toBe(2);
  });

  it('rotates a token that lapsed while its holder was offline: the successor is minted in the same lineage, expiring one TTL from the refresh, and captures', async () => {
    const r = await rig();
    r.clock.now = r.root.expiresAt + 30 * 24 * 60 * 60 * 1000;
    expect((await r.post(r.root.token, 1)).status).toBe(401);
    const res = await r.capture(() => r.refresh(r.root.token));
    const body = await json(res);
    expect({ status: res.status, refreshed: body.refreshed, expiresAt: body.expiresAt }).toEqual({ status: 200, refreshed: true, expiresAt: r.clock.now + MEMBER_TOKEN_TTL_MS });
    expect(r.row(body.tokenId as string)).toMatchObject({ predecessor_id: r.root.tokenId, lineage_root: r.root.tokenId, lineage_started_at: T0, revoked_at: null, first_used_at: null });
    expect(r.emitted('token_refreshed')).toEqual([{ kind: 'token_refreshed', memberId: 'mem_machine_1', tokenId: body.tokenId, predecessorId: r.root.tokenId }]);
    r.clock.now += 1;
    expect((await json(await r.post(body.token as string, 2))).persisted).toBe(true);
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: r.clock.now });
  });

  it('rotates a lapsed token once: a replay after its successor is used answers 401 as a lineage replay, and a repeat before that use supersedes the unused successor', async () => {
    const r = await rig();
    r.clock.now = r.root.expiresAt + 1_000;
    const first = await json(await r.refresh(r.root.token));
    r.clock.now += 1;
    const second = await json(await r.refresh(r.root.token));
    expect([first.refreshed, second.refreshed]).toEqual([true, true]);
    expect(r.row(first.tokenId as string)).toMatchObject({ revoked_at: r.clock.now });
    expect(r.e.sqlite.query(`SELECT id FROM member_credentials WHERE predecessor_id = ? AND revoked_at IS NULL`).all(r.root.tokenId)).toEqual([{ id: second.tokenId }]);
    expect((await r.post(first.token as string, 1)).status).toBe(401);
    r.clock.now += 1;
    expect((await json(await r.post(second.token as string, 2))).persisted).toBe(true);
    r.clock.now += 1;
    const replay = await r.capture(() => r.refresh(r.root.token));
    expect(replay.status).toBe(401);
    expect(r.emitted('lineage_replayed')).toMatchObject([{ tokenId: r.root.tokenId, successorId: second.tokenId }]);
    expect(count(r.e.sqlite, 'member_credentials')).toBe(3);
  });

  it('answers lineage_expired to a lapsed token presented past its lineage ceiling, minting nothing', async () => {
    const r = await rig();
    r.clock.now = T0 + MEMBER_TOKEN_MAX_LINEAGE_MS;
    const res = await r.capture(() => r.refresh(r.root.token));
    expect({ status: res.status, body: await json(res) }).toEqual({ status: 200, body: { refreshed: false, code: 'lineage_expired', reason: 'token lineage expired' } });
    expect(r.emitted('refresh_refused')).toEqual([{ kind: 'refresh_refused', memberId: 'mem_machine_1', tokenId: r.root.tokenId, reason: 'lineage_expired' }]);
    expect(count(r.e.sqlite, 'member_credentials')).toBe(1);
    r.clock.now = T0 + MEMBER_TOKEN_MAX_LINEAGE_MS - 1;
    const last = await json(await r.refresh(r.root.token));
    expect(last).toMatchObject({ refreshed: true, expiresAt: T0 + MEMBER_TOKEN_MAX_LINEAGE_MS });
  });

  it('rotates on the credential alone: a request naming no Project and one naming a Project the Deployment has never seen both rotate, and no Project row is created', async () => {
    const r = await rig();
    r.clock.now = r.root.expiresAt + 1_000;
    const projects = count(r.e.sqlite, 'projects');
    const bare = await r.fetch(memberPost(r.root.token, '{}', '/tokens/refresh', { 'x-myco-project': '' }));
    const bareBody = await json(bare);
    expect({ status: bare.status, refreshed: bareBody.refreshed }).toEqual({ status: 200, refreshed: true });
    expect(r.row(bareBody.tokenId as string)).toMatchObject({ predecessor_id: r.root.tokenId, lineage_root: r.root.tokenId });
    r.clock.now += 1;
    const named = new Request('https://s/tokens/refresh', { method: 'POST', headers: memberHeaders(r.root.token, { 'x-myco-project': 'proj_brand_new' }), body: '{}' });
    expect(named.headers.get('x-myco-project')).toBe('proj_brand_new');
    const namedBody = await json(await r.fetch(named));
    expect(namedBody.refreshed).toBe(true);
    expect(count(r.e.sqlite, 'projects')).toBe(projects);
    expect(r.e.sqlite.query(`SELECT COUNT(*) AS n FROM projects WHERE project_id = 'proj_brand_new'`).get()).toEqual({ n: 0 });
  });

  it('never admits a lapsed token of a revoked member', async () => {
    const r = await rig();
    r.e.sqlite.query(`UPDATE members SET revoked_at = ? WHERE id = ?`).run(T0 + 1, 'mem_machine_1');
    r.clock.now = r.root.expiresAt + 1;
    expect((await r.refresh(r.root.token)).status).toBe(401);
    expect(count(r.e.sqlite, 'member_credentials')).toBe(1);
  });

  it('keeps capturing past the retired 1 GiB ceiling across a rotation: the successor carries the count and is admitted (#1416)', async () => {
    const r = await rig();
    r.e.sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(RETIRED_BYTE_CEILING, r.root.tokenId);
    r.clock.now = WINDOW_OPENS;
    expect((await json(await r.post(r.root.token, 1))).persisted).toBe(true);
    const counted = bytesWritten(r.e.sqlite, r.root.tokenId);
    expect(counted).toBeGreaterThan(RETIRED_BYTE_CEILING);
    const successor = await json(await r.refresh(r.root.token));
    expect(successor.refreshed).toBe(true);
    r.clock.now += 1;
    expect((await json(await r.post(successor.token as string, 2))).persisted).toBe(true);
    expect(bytesWritten(r.e.sqlite, successor.tokenId as string)).toBeGreaterThan(counted);
  });

  it('refuses in the refreshed shape: a token without a machine identity, a non-JSON body, a non-object body, and a body with a field', async () => {
    const r = await rig();
    const anonymous = await issueMemberToken(r.e.db, { memberId: 'mem_anon', machineId: null }, T0);
    r.clock.now = WINDOW_OPENS;
    expect(await json(await r.refresh(anonymous.token))).toEqual({ refreshed: false, code: 'no_machine_identity', reason: 'token has no machine identity' });
    expect(await json(await r.refresh(r.root.token, 'nope'))).toEqual({ refreshed: false, code: 'parse', reason: 'body must be JSON' });
    expect(await json(await r.refresh(r.root.token, '[]'))).toEqual({ refreshed: false, code: 'refused', reason: 'body must be an object' });
    expect(await json(await r.refresh(r.root.token, '{"token":"x"}'))).toEqual({ refreshed: false, code: 'unknown_field', reason: 'unknown field token' });
    expect(count(r.e.sqlite, 'member_credentials')).toBe(2);
  });

  it('answers a storage failure on the refresh route with 503 in the refreshed shape and retry-after', async () => {
    const r = await rig();
    r.clock.now = WINDOW_OPENS;
    r.e.env.MYCO_DB = { ...r.e.db, batch: async () => { throw new Error('D1_ERROR: boom'); } };
    const res = await r.refresh(r.root.token);
    expect({ status: res.status, retry: res.headers.get('retry-after'), body: await json(res) }).toEqual({ status: 503, retry: String(RETRY_AFTER_SECONDS), body: { refreshed: false, code: 'unavailable', reason: 'unavailable' } });
  });

  it('serves the route through the deployed entry on the real clock', async () => {
    const e = sqliteEnv();
    const issuedAt = Date.now() - (MEMBER_TOKEN_TTL_MS - MEMBER_TOKEN_REFRESH_WINDOW_MS / 2);
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, issuedAt);
    const res = await worker.fetch(new Request('https://s/tokens/refresh', { method: 'POST', headers: memberHeaders(t.token), body: '{}' }), e.env);
    const body = await json(res);
    expect(body).toMatchObject({ refreshed: true, tokenId: expect.stringMatching(/^mt_/) });
    expect(body.expiresAt as number).toBeGreaterThan(t.expiresAt);
    const early = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    expect(await json(await worker.fetch(new Request('https://s/tokens/refresh', { method: 'POST', headers: memberHeaders(early.token), body: '{}' }), e.env)))
      .toEqual({ refreshed: false, code: 'refresh_too_early', reason: 'refresh window not yet open', refreshAfter: early.expiresAt - MEMBER_TOKEN_REFRESH_WINDOW_MS });
  });
});
