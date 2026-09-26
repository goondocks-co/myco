/**
 * H1 — a credential presented after its own lineage moved past it.
 *
 * A rotation revokes the predecessor at the successor's first use, so every later
 * request on the predecessor answers 401 exactly like an expired or operator-revoked
 * one, and the audit record is the only thing that separates them — on every route
 * but the refresh route. A superseded credential asking to rotate means a second
 * holder rotated the lineage, and the whole lineage is revoked, that holder's
 * successor included (#1417).
 */
import { refreshed } from './helpers/outcomes.js';
import { jsonBody } from '../helpers/json-body.js';
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { activateSuccessor, issueMemberToken, LINEAGE_REPLAY_REVOKER, MEMBER_LINEAGE_IDLE_MS, refreshMemberToken, revokeMemberLineage } from '@myco-server-worker/auth/tokens.js';
import { LINEAGE_REPLAY_GRACE_MS, PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';

/** Every telemetry line a call emits, captured from the one sink telemetry writes to. */
async function emitted<T>(run: () => Promise<T>): Promise<{ value: T; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const original = console.log;
  console.log = (s: string) => { try { lines.push(JSON.parse(s) as Record<string, unknown>); } catch { /* not telemetry */ } };
  try {
    return { value: await run(), lines };
  } finally { console.log = original; }
}

/** A member with a rotated credential whose successor has been used: predecessor superseded, successor live. */
async function rotated(now: number) {
  const e = sqliteEnv();
  const root = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  const refreshed = await refreshMemberToken(e.db, {
    memberId: 'mem_machine_1', tokenId: root.tokenId, machineId: 'machine_1',
    expiresAt: root.expiresAt, lineageRoot: root.tokenId, lineageStartedAt: now,
    runtime: { runtimeLabel: null, runtimeKind: null },
  }, root.expiresAt - 1_000);
  if (!refreshed.refreshed) throw new Error('fixture: refresh refused');
  await activateSuccessor(e.db, { tokenId: refreshed.tokenId, predecessorId: root.tokenId }, now);
  return { e, root, successor: refreshed };
}

const refreshRequest = (token: string) => new Request('https://s/tokens/refresh', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json', [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) },
  body: '{}',
});
const mcpRequest = (token: string) => new Request('https://s/mcp', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json', [PROJECT_HEADER]: 'proj_1', [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
const liveIn = (e: ReturnType<typeof sqliteEnv>, root: string) =>
  (e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials WHERE lineage_root = ? AND revoked_at IS NULL`).get(root) as { c: number }).c;

const post = (token: string) => new Request('https://s/events', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', [PROJECT_HEADER]: 'proj_1', [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) },
  body: JSON.stringify(envelope({ eventId: uuid(31) })),
});

describe('superseded credential', () => {
  it('records the lineage, the successor, and how long after the handover the request arrived — and still answers 401 like any other refusal', async () => {
    const now = Date.now();
    const { e, root, successor } = await rotated(now);
    const { value: res, lines } = await emitted(() => worker.fetch(post(root.token), e.env));

    expect(res.status).toBe(401);
    const replay = lines.find((l) => l.kind === 'lineage_replayed');
    expect(replay).toMatchObject({
      kind: 'lineage_replayed', memberId: 'mem_machine_1', tokenId: root.tokenId,
      lineageRoot: root.tokenId, successorId: successor.tokenId,
    });
    // The answer carries nothing the record carries: a holder learns only that it failed.
    expect(await jsonBody(res)).toEqual({ error: 'unauthorized' });
  });

  it('marks a request inside the hook race as explained and one past the grace as not, on the same lineage', async () => {
    // The grace is measured against the server's own clock, read when the request is
    // admitted rather than when the fixture is built, so the two are seconds apart and
    // the exact boundary is not observable from out here. These sit clear of it.
    const margin = 10_000;
    for (const [offset, withinHookRace] of [[0, true], [LINEAGE_REPLAY_GRACE_MS - margin, true], [LINEAGE_REPLAY_GRACE_MS + margin, false]] as const) {
      const activatedAt = Date.now() - offset;
      const { e, root } = await rotated(activatedAt);
      e.sqlite.query(`UPDATE member_credentials SET first_used_at = ? WHERE predecessor_id = ?`).run(activatedAt, root.tokenId);
      const { lines } = await emitted(() => worker.fetch(post(root.token), e.env));
      const replay = lines.find((l) => l.kind === 'lineage_replayed')!;
      expect({ offset, withinHookRace: replay.withinHookRace }).toEqual({ offset, withinHookRace });
    }
  });

  it('MUST NOT lock the lineage: the loser of a rotation race keeps working on its successor, and no credential is revoked by the record', async () => {
    // Two hooks on one machine race a rotation. The loser presents the predecessor after
    // the winner's first use revoked it. Recording that is right; acting on it is not —
    // this is ordinary, and revoking the lineage here would lock a member out of capture
    // over its own correct behaviour.
    const now = Date.now();
    const { e, root, successor } = await rotated(now);
    const liveBefore = (e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials WHERE revoked_at IS NULL`).get() as { c: number }).c;

    await emitted(() => worker.fetch(post(root.token), e.env));
    await emitted(() => worker.fetch(post(root.token), e.env));

    const liveAfter = (e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials WHERE revoked_at IS NULL`).get() as { c: number }).c;
    expect({ liveBefore, liveAfter }).toEqual({ liveBefore: 1, liveAfter: 1 });

    // The successor is untouched and still works: the member captures without interruption.
    const ok = await worker.fetch(post(successor.token!), e.env);
    expect((await ok.json() as Record<string, unknown>).persisted).toBe(true);
  });

  it('says nothing about a lineage an operator revoked while a successor was still banked: a successor that was never used never moved the lineage on', async () => {
    // A refresh banks a successor and leaves the predecessor live until that successor
    // is first used. Revoking the lineage in between revokes both. Presenting the
    // predecessor afterwards then looks structurally like a replay — a revoked row with
    // a successor — and is not one: nothing took over from it, an operator ended it.
    const now = Date.now();
    const e = sqliteEnv();
    const root = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
    const refreshed = await refreshMemberToken(e.db, {
      memberId: 'mem_machine_1', tokenId: root.tokenId, machineId: 'machine_1',
      expiresAt: root.expiresAt, lineageRoot: root.tokenId, lineageStartedAt: now,
      runtime: { runtimeLabel: null, runtimeKind: null },
    }, root.expiresAt - 1_000);
    expect(refreshed.refreshed).toBe(true);
    expect((e.sqlite.query(`SELECT first_used_at f FROM member_credentials WHERE predecessor_id = ?`).get(root.tokenId) as any).f).toBeNull();
    await revokeMemberLineage(e.db, root.tokenId, now, 'mem_machine_1');

    const { value: res, lines } = await emitted(() => worker.fetch(post(root.token), e.env));
    expect(res.status).toBe(401);
    expect(lines.filter((l) => l.kind === 'lineage_replayed')).toEqual([]);
  });

  it('carries the runtime binding to the successor, so a rotation never re-derives which runtime holds the lineage', async () => {
    // A re-auth that re-establishes the binding from what the caller sends is how a
    // device silently loses its identity and reverts to whoever first authenticated it.
    const now = Date.now();
    const e = sqliteEnv();
    const root = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now, null,
      { runtimeLabel: 'laptop', runtimeKind: 'persistent' });
    const outcome = await refreshMemberToken(e.db, {
      memberId: 'mem_machine_1', tokenId: root.tokenId, machineId: 'machine_1',
      expiresAt: root.expiresAt, lineageRoot: root.tokenId, lineageStartedAt: now,
      runtime: { runtimeLabel: 'laptop', runtimeKind: 'persistent' },
    }, root.expiresAt - 1_000);
    expect(outcome.refreshed).toBe(true);
    expect(e.sqlite.query(`SELECT runtime_label, runtime_kind, machine_id FROM member_credentials WHERE id = ?`).get(refreshed(outcome).tokenId))
      .toEqual({ runtime_label: 'laptop', runtime_kind: 'persistent', machine_id: 'machine_1' });
  });

  it('says nothing about a credential an operator revoked, or one that simply expired: only a lineage that moved on is a replay', async () => {
    const now = Date.now();
    const e = sqliteEnv();
    const operatorRevoked = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, now);
    e.sqlite.query(`UPDATE member_credentials SET revoked_at = ? WHERE id = ?`).run(now, operatorRevoked.tokenId);
    const expired = await issueMemberToken(e.db, { memberId: 'mem_machine_3', machineId: 'machine_3' }, now);
    e.sqlite.query(`UPDATE member_credentials SET expires_at = ? WHERE id = ?`).run(now - 1, expired.tokenId);

    for (const token of [operatorRevoked.token, expired.token]) {
      const { value: res, lines } = await emitted(() => worker.fetch(post(token), e.env));
      expect(res.status).toBe(401);
      expect(lines.filter((l) => l.kind === 'lineage_replayed')).toEqual([]);
    }
  });
});

describe('a superseded credential asking to rotate', () => {
  it('thief first: the owner\'s rotation with the head a thief already rotated revokes every live row of the lineage, the thief\'s included, and says why', async () => {
    const now = Date.now();
    const { e, root, successor: thief } = await rotated(now);
    expect(liveIn(e, root.tokenId)).toBe(1);

    const { value: res, lines } = await emitted(() => worker.fetch(refreshRequest(root.token), e.env));
    expect(res.status).toBe(401);
    expect(res.headers.get(PROTOCOL_HEADER)).toBeNull();
    expect(await jsonBody(res)).toEqual({ error: 'unauthorized', code: 'lineage_replayed' });
    expect(lines.find((l) => l.kind === 'lineage_replayed')).toMatchObject({ tokenId: root.tokenId, successorId: thief.tokenId, revoked: 1 });
    expect(liveIn(e, root.tokenId)).toBe(0);
    expect(e.sqlite.query(`SELECT revoked_by FROM member_credentials WHERE id = ?`).get(thief.tokenId)).toEqual({ revoked_by: LINEAGE_REPLAY_REVOKER });

    // The thief's successor is refused on every route, naming why; the owner's head stays refused the same way.
    for (const req of [post(thief.token!), refreshRequest(thief.token!), refreshRequest(root.token)]) {
      const refused = await worker.fetch(req, e.env);
      expect({ status: refused.status, body: await jsonBody(refused) }).toEqual({ status: 401, body: { error: 'unauthorized', code: 'lineage_replayed' } });
    }
  });

  it('revokes with no grace: a rotation asked within a second of the successor\'s first use ends the lineage too', async () => {
    const now = Date.now();
    const { e, root } = await rotated(now);
    e.sqlite.query(`UPDATE member_credentials SET first_used_at = ? WHERE predecessor_id = ?`).run(Date.now(), root.tokenId);
    expect((await emitted(() => worker.fetch(refreshRequest(root.token), e.env))).value.status).toBe(401);
    expect(liveIn(e, root.tokenId)).toBe(0);
  });

  it('revokes only while the superseded credential was issued inside the idle window: an older one, from a backup or a log, is refused and ends nothing', async () => {
    const margin = 60_000;
    for (const [issuedAgo, revokes] of [[MEMBER_LINEAGE_IDLE_MS - margin, true], [MEMBER_LINEAGE_IDLE_MS, false], [MEMBER_LINEAGE_IDLE_MS * 3, false]] as const) {
      const now = Date.now();
      const { e, root, successor } = await rotated(now);
      e.sqlite.query(`UPDATE member_credentials SET issued_at = ? WHERE id = ?`).run(now - issuedAgo, root.tokenId);
      const { value: res, lines } = await emitted(() => worker.fetch(refreshRequest(root.token), e.env));
      expect({ issuedAgo, status: res.status, body: await jsonBody(res), live: liveIn(e, root.tokenId) }).toEqual({
        issuedAgo, status: 401, body: revokes ? { error: 'unauthorized', code: 'lineage_replayed' } : { error: 'unauthorized' }, live: revokes ? 0 : 1,
      });
      expect(lines.find((l) => l.kind === 'lineage_replayed')).toMatchObject({ tokenId: root.tokenId, revoked: revokes ? 1 : 0 });
      if (!revokes) expect((await (await worker.fetch(post(successor.token!), e.env)).json() as Record<string, unknown>).persisted).toBe(true);
    }
  });

  it('owner first: a superseded credential on a capture or tool route, however late, revokes nothing — a stale bridge or a racing hook re-reads the registry', async () => {
    const activatedAt = Date.now() - LINEAGE_REPLAY_GRACE_MS * 10;
    const { e, root, successor } = await rotated(activatedAt);
    e.sqlite.query(`UPDATE member_credentials SET first_used_at = ? WHERE predecessor_id = ?`).run(activatedAt, root.tokenId);
    for (const req of [post(root.token), mcpRequest(root.token)]) {
      const { value: res, lines } = await emitted(() => worker.fetch(req, e.env));
      expect({ status: res.status, body: await jsonBody(res) }).toEqual({ status: 401, body: { error: 'unauthorized' } });
      expect(lines.find((l) => l.kind === 'lineage_replayed')).toMatchObject({ withinHookRace: false, revoked: 0 });
    }
    expect(liveIn(e, root.tokenId)).toBe(1);
    expect((await (await worker.fetch(post(successor.token!), e.env)).json() as Record<string, unknown>).persisted).toBe(true);
  });

  it('a thief who rotated the head the owner had already rotated, but not yet used: the owner\'s passed-over successor asking to rotate ends the lineage', async () => {
    const now = Date.now();
    const e = sqliteEnv();
    const head = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
    const subject = { memberId: 'mem_machine_1', tokenId: head.tokenId, machineId: 'machine_1', expiresAt: head.expiresAt, lineageRoot: head.tokenId, lineageStartedAt: now, runtime: { runtimeLabel: null, runtimeKind: null } };
    const owners = refreshed(await refreshMemberToken(e.db, subject, head.expiresAt - 2_000));
    const thiefs = refreshed(await refreshMemberToken(e.db, subject, head.expiresAt - 1_000));
    // The thief's rotation revoked the owner's unused successor; its first use revokes the head.
    expect(e.sqlite.query(`SELECT revoked_at IS NOT NULL AS r, first_used_at FROM member_credentials WHERE id = ?`).get(owners.tokenId)).toEqual({ r: 1, first_used_at: null });
    expect((await (await worker.fetch(post(thiefs.token), e.env)).json() as Record<string, unknown>).persisted).toBe(true);

    // The owner's successor on a capture route is recorded as passed over, and nothing more.
    const { value: onCapture, lines } = await emitted(() => worker.fetch(post(owners.token), e.env));
    expect(onCapture.status).toBe(401);
    expect(lines.find((l) => l.kind === 'lineage_replayed')).toMatchObject({ tokenId: owners.tokenId, successorId: thiefs.tokenId, revoked: 0 });
    expect(liveIn(e, head.tokenId)).toBe(1);

    const rotation = await worker.fetch(refreshRequest(owners.token), e.env);
    expect({ status: rotation.status, body: await jsonBody(rotation) }).toEqual({ status: 401, body: { error: 'unauthorized', code: 'lineage_replayed' } });
    expect(liveIn(e, head.tokenId)).toBe(0);
    expect((await worker.fetch(post(thiefs.token), e.env)).status).toBe(401);
  });

  it('says nothing about a successor the same holder replaced before using it: no other successor of its predecessor was used', async () => {
    const now = Date.now();
    const e = sqliteEnv();
    const head = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
    const subject = { memberId: 'mem_machine_1', tokenId: head.tokenId, machineId: 'machine_1', expiresAt: head.expiresAt, lineageRoot: head.tokenId, lineageStartedAt: now, runtime: { runtimeLabel: null, runtimeKind: null } };
    const lost = refreshed(await refreshMemberToken(e.db, subject, head.expiresAt - 2_000));
    refreshed(await refreshMemberToken(e.db, subject, head.expiresAt - 1_000));
    const { value: res, lines } = await emitted(() => worker.fetch(refreshRequest(lost.token), e.env));
    expect({ status: res.status, body: await jsonBody(res) }).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(lines.filter((l) => l.kind === 'lineage_replayed')).toEqual([]);
    expect(liveIn(e, head.tokenId)).toBe(2);
  });
});
