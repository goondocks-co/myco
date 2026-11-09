/**
 * What a finished authority does until it is reclaimed, what the reclaim may remove, and the one-time redemption of a
 * link key: the deadlines come from the row's own state, a row past its deadline redeems nothing, and retrying a
 * committed redemption answers what that commit decided.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { IssuedIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { issueIdentityLinkAuthority, previewIdentityLinkAuthority, spendIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { issueEnrollmentAuthority, revokeEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { joinMember } from '@myco-server-worker/auth/join.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { ENROLLMENT_RETENTION_MS, IDENTITY_LINK_RETENTION_MS, reclaimFinishedAuthorities } from '@myco-server-worker/db/identity/authority-retention.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { migrateAndSeed } from './helpers/d1.js';

const NOW = 1_800_000_000_000;
const ADMIN = 'mem_machine_1';

function rig() {
  const sqlite = migrateAndSeed(new Database(':memory:'));
  const db = sqliteRelationalStore(sqlite);
  return { sqlite, db, env: { db } as ServerEnv };
}
const deadline = (sqlite: Database, table: string, id: string) =>
  (sqlite.query(`SELECT reclaim_at FROM ${table} WHERE id=?`).get(id) as { reclaim_at: number | null }).reclaim_at;
const ids = (sqlite: Database, table: string) => (sqlite.query(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map(row => row.id);

async function link(db: ServerEnv['db'], memberId: string, now: number, ttlMs?: number): Promise<IssuedIdentityLinkAuthority> {
  const issued = await issueIdentityLinkAuthority(db, memberId, now, { issuedBy: ADMIN, ...(ttlMs === undefined ? {} : { ttlMs }) });
  if (issued === null) throw new Error('fixture: the seeded admin was refused a link key');
  return issued;
}
const joined = async (env: ServerEnv, key: string, now: number, machineId: string) =>
  await (await joinMember(env, { key, machineId }, now)).json() as { joined: boolean; code?: string };

describe('authority deadlines', () => {
  it('derives a deadline from the row at mint, spend and revoke, in the commit that finishes the row', async () => {
    const { sqlite, db, env } = rig();
    const invited = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
    expect(deadline(sqlite, 'enrollment_authorities', invited.id)).toBe(invited.expiresAt + ENROLLMENT_RETENTION_MS);
    await joined(env, invited.key, NOW + 5, 'laptop');
    expect(deadline(sqlite, 'enrollment_authorities', invited.id)).toBe(NOW + 5 + ENROLLMENT_RETENTION_MS);
    const ended = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
    await revokeEnrollmentAuthority(db, ended.id, NOW + 9, ADMIN);
    expect(deadline(sqlite, 'enrollment_authorities', ended.id)).toBe(NOW + 9 + ENROLLMENT_RETENTION_MS);

    const key = await link(db, 'mem_machine_2', NOW);
    expect(deadline(sqlite, 'identity_link_authorities', key.id)).toBe(key.expiresAt + IDENTITY_LINK_RETENTION_MS);
    await spendIdentityLinkAuthority(db, key.key, '9101', NOW + 3);
    expect(deadline(sqlite, 'identity_link_authorities', key.id)).toBe(NOW + 3 + IDENTITY_LINK_RETENTION_MS);
  });

  it('counts spending and revoking from the earlier fact, however late the second one came', async () => {
    const { sqlite, db } = rig();
    const invited = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
    sqlite.query('UPDATE enrollment_authorities SET used_at=?, revoked_at=? WHERE id=?').run(NOW + 100, NOW + 900, invited.id);
    expect(deadline(sqlite, 'enrollment_authorities', invited.id)).toBe(NOW + 100 + ENROLLMENT_RETENTION_MS);
  });

  it('reclaims at exactly its deadline, one bounded page at a time, and never a live authority', async () => {
    const { sqlite, db } = rig();
    const old = NOW - ENROLLMENT_RETENTION_MS;
    const finished = [];
    for (let i = 0; i < 4; i += 1) {
      const invited = await issueEnrollmentAuthority(db, old, { issuer: { kind: 'operator' }, role: 'member', ttlMs: 1 });
      finished.push(invited.id);
    }
    const live = await issueEnrollmentAuthority(db, old, { issuer: { kind: 'operator' }, role: 'member', ttlMs: ENROLLMENT_RETENTION_MS * 3 });
    expect(await reclaimFinishedAuthorities(db, NOW, 100)).toEqual({ reclaimed: 0 });
    expect(await reclaimFinishedAuthorities(db, NOW + 1, 2)).toEqual({ reclaimed: 2 });
    expect(ids(sqlite, 'enrollment_authorities')).toHaveLength(3);
    expect(await reclaimFinishedAuthorities(db, NOW + 1, 100)).toEqual({ reclaimed: 2 });
    expect(ids(sqlite, 'enrollment_authorities')).toEqual([live.id]);
  });

  it('sign-in deletes nothing: a finished link key stays until the job reaches it', async () => {
    const { sqlite, db } = rig();
    const old = NOW - IDENTITY_LINK_RETENTION_MS - 1;
    const finished = await link(db, 'mem_machine_2', old - 2, 1);
    const key = await link(db, 'mem_machine_3', NOW);
    expect(await spendIdentityLinkAuthority(db, key.key, '9102', NOW)).toMatchObject({ ok: true });
    expect(ids(sqlite, 'identity_link_authorities')).toContain(finished.id);
    expect(await reclaimFinishedAuthorities(db, NOW, 100)).toEqual({ reclaimed: 1 });
    expect(ids(sqlite, 'identity_link_authorities')).not.toContain(finished.id);
  });

  it('a row past its deadline redeems nothing and answers no preview, with no reclaim having run', async () => {
    const { sqlite, db, env } = rig();
    const invited = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
    const key = await link(db, 'mem_machine_2', NOW);
    sqlite.query('UPDATE enrollment_authorities SET reclaim_at=? WHERE id=?').run(NOW - 1, invited.id);
    sqlite.query('UPDATE identity_link_authorities SET reclaim_at=? WHERE id=?').run(NOW - 1, key.id);
    expect((await joined(env, invited.key, NOW, 'laptop')).joined).toBe(false);
    expect(await spendIdentityLinkAuthority(db, key.key, '9103', NOW)).toEqual({ ok: false, reason: 'denied' });
    expect(await previewIdentityLinkAuthority(db, key.key, NOW)).toEqual({ ok: false, reason: 'denied' });
    expect(sqlite.query('SELECT used_at FROM enrollment_authorities WHERE id=?').get(invited.id)).toEqual({ used_at: null });
    expect(sqlite.query('SELECT used_at FROM identity_link_authorities WHERE id=?').get(key.id)).toEqual({ used_at: null });
  });

  it('removes only what its own state makes due, whatever the stored deadline says', async () => {
    const { sqlite, db } = rig();
    const live = await issueEnrollmentAuthority(db, NOW, { issuer: { kind: 'operator' }, role: 'member' });
    sqlite.query('UPDATE enrollment_authorities SET reclaim_at=? WHERE id=?').run(NOW - 1, live.id);
    expect(await reclaimFinishedAuthorities(db, NOW, 100)).toEqual({ reclaimed: 0 });
    expect(ids(sqlite, 'enrollment_authorities')).toEqual([live.id]);
  });

  it('gives existing rows their deadlines through the catch-up, and reclaims nothing before that', async () => {
    const { sqlite, db } = rig();
    const old = NOW - ENROLLMENT_RETENTION_MS * 2;
    const invited = await issueEnrollmentAuthority(db, old, { issuer: { kind: 'operator' }, role: 'member', ttlMs: 1 });
    const key = await link(db, 'mem_machine_2', NOW - IDENTITY_LINK_RETENTION_MS * 2, 1);
    sqlite.exec("UPDATE enrollment_authorities SET reclaim_at=NULL; UPDATE identity_link_authorities SET reclaim_at=NULL; UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='authority_retention'");
    expect(await reclaimFinishedAuthorities(db, NOW, 100)).toEqual({ reclaimed: 0 });
    expect(ids(sqlite, 'enrollment_authorities')).toEqual([invited.id]);
    while ((await catchUpProjections(db)).more) { /* drains every page */ }
    expect(deadline(sqlite, 'enrollment_authorities', invited.id)).toBe(invited.expiresAt + ENROLLMENT_RETENTION_MS);
    expect(deadline(sqlite, 'identity_link_authorities', key.id)).toBe(key.expiresAt + IDENTITY_LINK_RETENTION_MS);
    expect(await reclaimFinishedAuthorities(db, NOW, 100)).toEqual({ reclaimed: 2 });
  });
});

describe('a link key redeems exactly once and its outcome can be read back', () => {
  it('answers a retry by the same account with the member the commit bound', async () => {
    const { db } = rig();
    const key = await link(db, 'mem_machine_2', NOW);
    const first = await spendIdentityLinkAuthority(db, key.key, '9201', NOW);
    expect(first).toMatchObject({ ok: true, member: { id: 'mem_machine_2' } });
    expect(await spendIdentityLinkAuthority(db, key.key, '9201', NOW + 1)).toEqual(first);
  });

  it('never tells another account how a redemption went, and binds it to nothing', async () => {
    const { sqlite, db } = rig();
    const key = await link(db, 'mem_machine_2', NOW);
    await spendIdentityLinkAuthority(db, key.key, '9201', NOW);
    expect(await spendIdentityLinkAuthority(db, key.key, '9202', NOW + 1)).toEqual({ ok: false, reason: 'denied' });
    expect(sqlite.query("SELECT github_id FROM members WHERE id='mem_machine_2'").get()).toEqual({ github_id: '9201' });
  });

  it('answers a retry of a refusal with that refusal, and the key stays spent', async () => {
    const { sqlite, db } = rig();
    const taken = await link(db, 'mem_machine_2', NOW);
    sqlite.run("UPDATE members SET github_id='9301' WHERE id='mem_machine_3'");
    expect(await spendIdentityLinkAuthority(db, taken.key, '9301', NOW)).toEqual({ ok: false, reason: 'identity_taken' });
    expect(await spendIdentityLinkAuthority(db, taken.key, '9301', NOW + 1)).toEqual({ ok: false, reason: 'identity_taken' });
    expect(sqlite.query('SELECT used_at FROM identity_link_authorities WHERE id=?').get(taken.id)).toEqual({ used_at: NOW });
  });

  it('stops answering a bind once the member no longer holds the account', async () => {
    const { sqlite, db } = rig();
    const key = await link(db, 'mem_machine_2', NOW);
    await spendIdentityLinkAuthority(db, key.key, '9401', NOW);
    sqlite.run(`UPDATE members SET revoked_at=${NOW + 1} WHERE id='mem_machine_2'`);
    expect(await spendIdentityLinkAuthority(db, key.key, '9401', NOW + 2)).toEqual({ ok: false, reason: 'denied' });
  });

  it('leaves no receipt, spend or bind when the key was never live', async () => {
    const { sqlite, db } = rig();
    const expired = await link(db, 'mem_machine_2', NOW, 1);
    expect(await spendIdentityLinkAuthority(db, expired.key, '9501', NOW + 2)).toEqual({ ok: false, reason: 'denied' });
    expect(sqlite.query('SELECT used_at FROM identity_link_authorities WHERE id=?').get(expired.id)).toEqual({ used_at: null });
    expect(sqlite.query('SELECT COUNT(*) AS n FROM identity_link_redemptions').get()).toEqual({ n: 0 });
    expect(sqlite.query("SELECT github_id FROM members WHERE id='mem_machine_2'").get()).toEqual({ github_id: null });
  });

  it('receipts are reclaimed with their retention', async () => {
    const { sqlite, db } = rig();
    const key = await link(db, 'mem_machine_2', NOW);
    await spendIdentityLinkAuthority(db, key.key, '9601', NOW);
    expect(await reclaimFinishedAuthorities(db, NOW + IDENTITY_LINK_RETENTION_MS - 1, 100)).toEqual({ reclaimed: 0 });
    expect(await reclaimFinishedAuthorities(db, NOW + IDENTITY_LINK_RETENTION_MS, 100)).toEqual({ reclaimed: 2 });
    expect(sqlite.query('SELECT COUNT(*) AS n FROM identity_link_redemptions').get()).toEqual({ n: 0 });
  });
});
