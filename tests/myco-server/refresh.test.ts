import { describe, it, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { cloudflareSourceOf } from '@myco-server-worker/platform/cloudflare.js';
import {
  MEMBER_TOKEN_MAX_LINEAGE_MS, MEMBER_TOKEN_PATTERN, MEMBER_TOKEN_REFRESH_WINDOW_MS, MEMBER_TOKEN_TTL_MS,
  issueMemberToken, revokeMemberLineage, revokeMemberToken,
} from '@myco-server-worker/auth/tokens.js';
import { BLOB_RESERVATION_TTL_MS, MEMBER_TOKEN_BYTE_QUOTA, PROTOCOL_HEADER, RETRY_AFTER_SECONDS, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { blobPost, bytesWritten, count, envelope, memberHeaders, memberPost, sqliteEnv, uuid } from './helpers/fixtures.js';

const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;
const T0 = 1_700_000_000_000;
const WINDOW_OPENS = T0 + MEMBER_TOKEN_TTL_MS - MEMBER_TOKEN_REFRESH_WINDOW_MS;

/** A server over a clock the test moves, with a member of machine_1 minted at T0. */
async function rig(opts: Parameters<typeof sqliteEnv>[0] = {}) {
  const e = sqliteEnv(opts);
  const clock = { now: T0 };
  const server = createServer({ now: () => clock.now, sourceOf: cloudflareSourceOf });
  const root = await issueMemberToken(e.db, { projectId: 'proj_1', machineId: 'machine_1' }, T0);
  const fetch = (req: Request) => server.handleRequest(req, e.env);
  const refresh = (token: string, body = '{}') => fetch(memberPost(token, body, '/tokens/refresh'));
  const post = (token: string, n: number) => fetch(memberPost(token, envelope({ eventId: uuid(n), payload: { promptId: uuid(1_000 + n), text: `p${n}`, origin: 'user' } })));
  const row = (tokenId: string) => e.sqlite.query(`SELECT id, predecessor_id, lineage_root, lineage_started_at, first_used_at, expires_at, revoked_at, bytes_written FROM member_tokens WHERE id = ?`).get(tokenId) as Record<string, unknown>;
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
    expect(count(r.e.sqlite, 'member_tokens')).toBe(1);
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
    expect(r.emitted('token_refreshed')).toEqual([{ kind: 'token_refreshed', projectId: 'proj_1', tokenId: body.tokenId, predecessorId: r.root.tokenId }]);
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
    const live = r.e.sqlite.query(`SELECT id FROM member_tokens WHERE predecessor_id = ? AND revoked_at IS NULL`).all(r.root.tokenId) as { id: string }[];
    expect(live).toEqual([{ id: issued[3] }]);
    expect(r.e.sqlite.query(`SELECT id, revoked_at FROM member_tokens WHERE predecessor_id = ? ORDER BY revoked_at`).all(r.root.tokenId))
      .toEqual([{ id: issued[3], revoked_at: null }, { id: issued[0], revoked_at: WINDOW_OPENS + 2 }, { id: issued[1], revoked_at: WINDOW_OPENS + 3 }, { id: issued[2], revoked_at: WINDOW_OPENS + 4 }]);
    expect(count(r.e.sqlite, 'member_tokens')).toBe(5);
    for (const stale of issued.slice(0, 3)) expect((await r.fetch(memberPost(stale, '{}', '/tokens/refresh'))).status).toBe(401);
  });

  it('clamps every successor to the lineage ceiling and answers lineage_expired to a token already expiring at it, without refreshAfter', async () => {
    const r = await rig();
    const startedAt = T0 - MEMBER_TOKEN_MAX_LINEAGE_MS + MEMBER_TOKEN_TTL_MS + 1_000;
    r.e.sqlite.query(`UPDATE member_tokens SET lineage_started_at = ? WHERE id = ?`).run(startedAt, r.root.tokenId);
    const ceiling = startedAt + MEMBER_TOKEN_MAX_LINEAGE_MS;
    expect(ceiling).toBeGreaterThan(r.root.expiresAt);
    r.clock.now = WINDOW_OPENS;
    const clamped = await json(await r.refresh(r.root.token));
    expect(clamped).toMatchObject({ refreshed: true, expiresAt: ceiling, refreshAfter: ceiling - MEMBER_TOKEN_REFRESH_WINDOW_MS });
    expect(r.row(clamped.tokenId as string)).toMatchObject({ expires_at: ceiling, lineage_started_at: startedAt, lineage_root: r.root.tokenId });
    r.clock.now = ceiling - MEMBER_TOKEN_REFRESH_WINDOW_MS;
    const res = await r.capture(() => r.refresh(clamped.token as string));
    expect({ status: res.status, body: await json(res) }).toEqual({ status: 200, body: { refreshed: false, code: 'lineage_expired', reason: 'token lineage expired' } });
    expect(r.emitted('refresh_refused')).toEqual([{ kind: 'refresh_refused', projectId: 'proj_1', tokenId: clamped.tokenId, reason: 'lineage_expired' }]);
    expect(count(r.e.sqlite, 'member_tokens')).toBe(2);
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
    expect(r.emitted('successor_activated')).toEqual([{ kind: 'successor_activated', projectId: 'proj_1', tokenId: successor.tokenId, predecessorId: r.root.tokenId }]);
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
    r.e.sqlite.query(`DELETE FROM member_tokens WHERE id = ?`).run(r.root.tokenId);
    r.clock.now += 1;
    expect((await json(await r.post(successor.token, 2))).persisted).toBe(true);
    const own = bytesWritten(r.e.sqlite, successor.tokenId);
    expect(own).toBeGreaterThan(0);
    expect(r.row(successor.tokenId)).toMatchObject({ first_used_at: r.clock.now, revoked_at: null });
    expect((await json(await r.post(successor.token, 3))).persisted).toBe(true);
    expect(bytesWritten(r.e.sqlite, successor.tokenId)).toBe(own * 2);
  });

  it('refuses a predecessor\'s stalled upload that completes after activation: the reconcile admits nothing for a revoked token, the object it put is deleted, no row lands and no counter moves', async () => {
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
    expect(await json(await inflight)).toEqual({ stored: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(bytesWritten(r.e.sqlite, r.root.tokenId)).toBe(0);
    expect(bytesWritten(r.e.sqlite, successor.tokenId)).toBe(carried);
    expect(count(r.e.sqlite, 'blobs')).toBe(0);
    expect(count(r.e.sqlite, 'blob_reservations')).toBe(0);
    expect(r.e.bucket.deletes).toEqual([`proj_1/${key}`]);
    expect(r.e.bucket.objects.size).toBe(0);
    r.clock.now += 1;
    expect((await json(await r.fetch(blobPost(successor.token, key, payload)))).stored).toBe(true);
  });

  it('refuses a predecessor\'s event that authenticated before activation and wrote after it: the raw insert admits nothing for a revoked token', async () => {
    let hook: ((sqlite: Database) => void) | null = null;
    const r = await rig({ onSql: (sql, sqlite) => { if (hook && sql.includes('INSERT INTO events')) { const h = hook; hook = null; h(sqlite); } } });
    const successor = await successorOf(r, r.root.token, r.root.expiresAt);
    const activation = r.clock.now + 1;
    hook = (sqlite) => {
      sqlite.query(`UPDATE member_tokens SET bytes_written = (SELECT bytes_written FROM member_tokens WHERE id = ?), first_used_at = ? WHERE id = ?`).run(r.root.tokenId, activation, successor.tokenId);
      sqlite.query(`UPDATE member_tokens SET revoked_at = ? WHERE id = ?`).run(activation, r.root.tokenId);
    };
    expect(await json(await r.post(r.root.token, 1))).toEqual({ persisted: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(hook).toBeNull();
    expect(count(r.e.sqlite, 'events')).toBe(0);
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: activation, bytes_written: 0 });
    expect(bytesWritten(r.e.sqlite, successor.tokenId)).toBe(0);
  });

  it('mints nothing when a lineage revoke lands between a refresh\'s authentication and its insert: 503 in the refreshed shape, no live row under the revoked root, and the presented token answers 401 next', async () => {
    let hook: ((sqlite: Database) => void) | null = null;
    const r = await rig({ onSql: (sql, sqlite) => { if (hook && sql.includes('INSERT INTO member_tokens')) { const h = hook; hook = null; h(sqlite); } } });
    const s1 = await successorOf(r, r.root.token, r.root.expiresAt);
    r.clock.now += 1;
    const revokedAt = r.clock.now;
    hook = (sqlite) => {
      sqlite.query(`UPDATE member_tokens SET revoked_at = ? WHERE lineage_root = (SELECT lineage_root FROM member_tokens WHERE id = ?) AND revoked_at IS NULL`).run(revokedAt, r.root.tokenId);
    };
    const res = await r.capture(() => r.refresh(r.root.token));
    expect(hook).toBeNull();
    expect({ status: res.status, body: await json(res) }).toEqual({ status: 503, body: { refreshed: false, code: 'unavailable', reason: 'unavailable' } });
    expect(r.emitted('refresh_error')).toEqual([{ kind: 'refresh_error', projectId: 'proj_1', tokenId: r.root.tokenId, error_class: 'revoked' }]);
    expect(r.emitted('token_refreshed')).toEqual([]);
    expect(count(r.e.sqlite, 'member_tokens')).toBe(2);
    expect(r.e.sqlite.query(`SELECT id FROM member_tokens WHERE lineage_root = ? AND revoked_at IS NULL`).all(r.root.tokenId)).toEqual([]);
    expect(r.row(s1.tokenId)).toMatchObject({ revoked_at: revokedAt });
    expect((await r.refresh(r.root.token)).status).toBe(401);
    expect((await r.post(r.root.token, 1)).status).toBe(401);
  });

  it('refuses a predecessor\'s upload whose reservation is taken after activation: the reservation insert admits nothing for a revoked token, no row and no put', async () => {
    let hook: ((sqlite: Database) => void) | null = null;
    const r = await rig({ onSql: (sql, sqlite) => { if (hook && sql.includes('INSERT INTO blob_reservations')) { const h = hook; hook = null; h(sqlite); } } });
    const successor = await successorOf(r, r.root.token, r.root.expiresAt);
    const activation = r.clock.now + 1;
    hook = (sqlite) => {
      sqlite.query(`UPDATE member_tokens SET bytes_written = (SELECT bytes_written FROM member_tokens WHERE id = ?), first_used_at = ? WHERE id = ?`).run(r.root.tokenId, activation, successor.tokenId);
      sqlite.query(`UPDATE member_tokens SET revoked_at = ? WHERE id = ?`).run(activation, r.root.tokenId);
    };
    const payload = new Uint8Array(64).fill(3);
    expect(await json(await r.fetch(blobPost(r.root.token, await sha256HexOf(payload), payload)))).toEqual({ stored: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(hook).toBeNull();
    expect(count(r.e.sqlite, 'blob_reservations')).toBe(0);
    expect(count(r.e.sqlite, 'blobs')).toBe(0);
    expect(r.e.bucket.puts).toEqual([]);
    expect(r.row(r.root.tokenId)).toMatchObject({ revoked_at: activation, bytes_written: 0 });
  });

  it('never reads a constraint failure as a quota refusal on the exempt refresh route: 503 unavailable, while /events at quota answers quota', async () => {
    const r = await rig({ staleBytesWritten: 0 });
    r.e.sqlite.query(`UPDATE member_tokens SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA, r.root.tokenId);
    r.e.env.MYCO_DB = {
      ...r.e.db,
      prepare: (sql: string) => (sql.includes('SELECT bytes_written FROM member_tokens') ? { bind: () => ({ first: async () => ({ bytes_written: MEMBER_TOKEN_BYTE_QUOTA }) }) } : r.e.db.prepare(sql)),
      batch: async () => { throw new Error('UNIQUE constraint failed: member_tokens.predecessor_id'); },
    };
    r.clock.now = WINDOW_OPENS;
    const res = await r.refresh(r.root.token);
    expect({ status: res.status, body: await json(res) }).toEqual({ status: 503, body: { refreshed: false, code: 'unavailable', reason: 'unavailable' } });
    const events = await r.post(r.root.token, 1);
    expect({ status: events.status, body: await json(events) }).toEqual({ status: 200, body: { persisted: false, code: 'quota', reason: 'token write quota exceeded' } });
  });

  it('revokes a whole lineage by any id in the chain, refusing every token of it afterwards and nothing outside it', async () => {
    const r = await rig();
    const s1 = await successorOf(r, r.root.token, r.root.expiresAt);
    const s2 = await successorOf(r, s1.token, s1.expiresAt);
    const s3 = await successorOf(r, s2.token, s2.expiresAt);
    const other = await issueMemberToken(r.e.db, { projectId: 'proj_1', machineId: 'machine_1' }, r.clock.now);
    for (const [pred, succ] of [[r.root, s1], [s1, s2], [s2, s3]] as const) expect(r.row(pred.tokenId).revoked_at).toBe(r.row(succ.tokenId).first_used_at);
    expect(r.row(s3.tokenId)).toMatchObject({ revoked_at: null, first_used_at: null });
    expect(r.e.sqlite.query(`SELECT id FROM member_tokens WHERE lineage_root = ? AND revoked_at IS NULL ORDER BY expires_at`).all(r.root.tokenId)).toEqual([{ id: s2.tokenId }, { id: s3.tokenId }]);
    expect(await revokeMemberLineage(r.e.db, s2.tokenId, r.clock.now)).toEqual({ revoked: 2 });
    expect(r.e.sqlite.query(`SELECT id FROM member_tokens WHERE lineage_root = ? AND revoked_at IS NULL`).all(r.root.tokenId)).toEqual([]);
    for (const t of [r.root, s1, s2, s3]) expect((await r.post(t.token, 9)).status).toBe(401);
    expect((await json(await r.post(other.token, 9))).persisted).toBe(true);
    expect(await revokeMemberLineage(r.e.db, 'mt_nobody', r.clock.now)).toEqual({ revoked: 0 });
    const fresh = await rig();
    const a = await successorOf(fresh, fresh.root.token, fresh.root.expiresAt);
    expect(await revokeMemberLineage(fresh.e.db, fresh.root.tokenId, fresh.clock.now)).toEqual({ revoked: 2 });
    for (const t of [fresh.root, a]) expect((await fresh.post(t.token, 9)).status).toBe(401);
  });

  it('refuses an expired or a revoked token on the refresh route like any other: 401 without a row written', async () => {
    const r = await rig();
    const revoked = await issueMemberToken(r.e.db, { projectId: 'proj_1', machineId: 'machine_1' }, T0);
    await revokeMemberToken(r.e.db, revoked.tokenId, T0 + 1);
    r.clock.now = WINDOW_OPENS;
    expect((await r.refresh(revoked.token)).status).toBe(401);
    r.clock.now = r.root.expiresAt;
    expect((await r.refresh(r.root.token)).status).toBe(401);
    expect(count(r.e.sqlite, 'member_tokens')).toBe(2);
  });

  it('lets a token at its write quota rotate: the refresh route is exempt from the byte pre-check while /events refuses', async () => {
    const r = await rig();
    r.e.sqlite.query(`UPDATE member_tokens SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA, r.root.tokenId);
    r.clock.now = WINDOW_OPENS;
    expect(await json(await r.post(r.root.token, 1))).toEqual({ persisted: false, code: 'quota', reason: 'token write quota exceeded' });
    const successor = await json(await r.refresh(r.root.token));
    expect(successor.refreshed).toBe(true);
    r.clock.now += 1;
    expect(await json(await r.post(successor.token as string, 2))).toEqual({ persisted: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(bytesWritten(r.e.sqlite, successor.tokenId as string)).toBe(MEMBER_TOKEN_BYTE_QUOTA);
  });

  it('refuses in the refreshed shape: a token without a machine identity, a non-JSON body, a non-object body, and a body with a field', async () => {
    const r = await rig();
    const anonymous = await issueMemberToken(r.e.db, { projectId: 'proj_1', machineId: null }, T0);
    r.clock.now = WINDOW_OPENS;
    expect(await json(await r.refresh(anonymous.token))).toEqual({ refreshed: false, code: 'no_machine_identity', reason: 'token has no machine identity' });
    expect(await json(await r.refresh(r.root.token, 'nope'))).toEqual({ refreshed: false, code: 'parse', reason: 'body must be JSON' });
    expect(await json(await r.refresh(r.root.token, '[]'))).toEqual({ refreshed: false, code: 'refused', reason: 'body must be an object' });
    expect(await json(await r.refresh(r.root.token, '{"token":"x"}'))).toEqual({ refreshed: false, code: 'unknown_field', reason: 'unknown field token' });
    expect(count(r.e.sqlite, 'member_tokens')).toBe(2);
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
    const t = await issueMemberToken(e.db, { projectId: 'proj_1', machineId: 'machine_1' }, issuedAt);
    const res = await worker.fetch(new Request('https://s/tokens/refresh', { method: 'POST', headers: memberHeaders(t.token), body: '{}' }), e.env);
    const body = await json(res);
    expect(body).toMatchObject({ refreshed: true, tokenId: expect.stringMatching(/^mt_/) });
    expect(body.expiresAt as number).toBeGreaterThan(t.expiresAt);
    const early = await issueMemberToken(e.db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    expect(await json(await worker.fetch(new Request('https://s/tokens/refresh', { method: 'POST', headers: memberHeaders(early.token), body: '{}' }), e.env)))
      .toEqual({ refreshed: false, code: 'refresh_too_early', reason: 'refresh window not yet open', refreshAfter: early.expiresAt - MEMBER_TOKEN_REFRESH_WINDOW_MS });
  });
});
