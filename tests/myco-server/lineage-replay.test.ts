/**
 * H1 — a credential presented after its own lineage moved past it.
 *
 * A rotation revokes the predecessor at the successor's first use, so every later
 * request on the predecessor answers 401 exactly like an expired or operator-revoked
 * one. The audit record is the only thing that separates them.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { activateSuccessor, issueMemberToken, refreshMemberToken, revokeMemberLineage } from '@myco-server-worker/auth/tokens.js';
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
    expect(await res.json()).toEqual({ error: 'unauthorized' });
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
    const refreshed = await refreshMemberToken(e.db, {
      memberId: 'mem_machine_1', tokenId: root.tokenId, machineId: 'machine_1',
      expiresAt: root.expiresAt, lineageRoot: root.tokenId, lineageStartedAt: now,
      runtime: { runtimeLabel: 'laptop', runtimeKind: 'persistent' },
    }, root.expiresAt - 1_000);
    expect(refreshed.refreshed).toBe(true);
    expect(e.sqlite.query(`SELECT runtime_label, runtime_kind, machine_id FROM member_credentials WHERE id = ?`).get(refreshed.tokenId!))
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
