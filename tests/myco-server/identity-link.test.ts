/**
 * Identity link authorities: the proof that binds a GitHub account to a member.
 *
 * The join path mints; the account that proved itself through GitHub spends.
 * Nothing here takes a member id from a caller — the authority names it.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  IDENTITY_LINK_KEY_PATTERN, IDENTITY_LINK_RETENTION_MS, IDENTITY_LINK_TTL_MS,
  issueIdentityLinkAuthority, memberByGithubId, reclaimIdentityLinkAuthorities, spendIdentityLinkAuthority,
} from '@myco-server-worker/auth/identity-link.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { migrateAndSeed } from './helpers/d1.js';

const NOW = 1_800_000_000_000;

function rig() {
  const sqlite = migrateAndSeed(new Database(':memory:'));
  return { sqlite, db: sqliteRelationalStore(sqlite) };
}

describe('identity link authority', () => {
  it('mints a key of the admitted shape, bound to the member, and stores only its digest', async () => {
    const r = rig();
    const issued = await issueIdentityLinkAuthority(r.db, 'mem_machine_2', NOW);
    expect(IDENTITY_LINK_KEY_PATTERN.test(issued.key)).toBe(true);
    expect(issued.id.startsWith('il_')).toBe(true);
    expect(issued.expiresAt).toBe(NOW + IDENTITY_LINK_TTL_MS);
    const rows = r.sqlite.query(`SELECT member_id, used_at FROM identity_link_authorities`).all();
    expect(rows).toEqual([{ member_id: 'mem_machine_2', used_at: null }]);
    expect(JSON.stringify(r.sqlite.query(`SELECT * FROM identity_link_authorities`).all())).not.toContain(issued.key);
  });

  it('binds the account that spends it to the member the key names, and the member is then found by that account', async () => {
    const r = rig();
    const issued = await issueIdentityLinkAuthority(r.db, 'mem_machine_2', NOW);
    expect(await spendIdentityLinkAuthority(r.db, issued.key, '9001', NOW)).toEqual({ ok: true, member: { id: 'mem_machine_2', label: 'machine_2' } });
    expect(r.sqlite.query(`SELECT github_id FROM members WHERE id = 'mem_machine_2'`).get()).toEqual({ github_id: '9001' });
    expect(r.sqlite.query(`SELECT used_by FROM identity_link_authorities WHERE id = ?`).get(issued.id)).toEqual({ used_by: '9001' });
    expect(await memberByGithubId(r.db, '9001')).toEqual({ id: 'mem_machine_2', label: 'machine_2' });
  });

  it('spends once: a second presentation, an unknown key, and an expired key are all denied alike, changing nothing', async () => {
    const r = rig();
    const issued = await issueIdentityLinkAuthority(r.db, 'mem_machine_2', NOW);
    expect(await spendIdentityLinkAuthority(r.db, issued.key, '9001', NOW)).toMatchObject({ ok: true });
    expect(await spendIdentityLinkAuthority(r.db, issued.key, '9002', NOW)).toEqual({ ok: false, reason: 'denied' });
    expect(await spendIdentityLinkAuthority(r.db, 'x'.repeat(43), '9002', NOW)).toEqual({ ok: false, reason: 'denied' });
    const late = await issueIdentityLinkAuthority(r.db, 'mem_machine_3', NOW);
    expect(await spendIdentityLinkAuthority(r.db, late.key, '9003', NOW + IDENTITY_LINK_TTL_MS)).toEqual({ ok: false, reason: 'denied' });
    expect(r.sqlite.query(`SELECT github_id FROM members WHERE id IN ('mem_machine_2','mem_machine_3') ORDER BY id`).all())
      .toEqual([{ github_id: '9001' }, { github_id: null }]);
  });

  it('refuses an account that is already another member\'s, keeping the first binding and spending the key', async () => {
    const r = rig();
    const a = await issueIdentityLinkAuthority(r.db, 'mem_machine_2', NOW);
    expect(await spendIdentityLinkAuthority(r.db, a.key, '9001', NOW)).toMatchObject({ ok: true });
    const b = await issueIdentityLinkAuthority(r.db, 'mem_machine_3', NOW);
    expect(await spendIdentityLinkAuthority(r.db, b.key, '9001', NOW)).toEqual({ ok: false, reason: 'identity_taken' });
    expect(r.sqlite.query(`SELECT id FROM members WHERE github_id = '9001'`).all()).toEqual([{ id: 'mem_machine_2' }]);
    expect(await spendIdentityLinkAuthority(r.db, b.key, '9002', NOW)).toEqual({ ok: false, reason: 'denied' });
  });

  it('refuses a member that is already linked to another account: what the victim of a stolen key sees', async () => {
    const r = rig();
    const first = await issueIdentityLinkAuthority(r.db, 'mem_machine_2', NOW);
    expect(await spendIdentityLinkAuthority(r.db, first.key, '9001', NOW)).toMatchObject({ ok: true });
    const second = await issueIdentityLinkAuthority(r.db, 'mem_machine_2', NOW);
    expect(await spendIdentityLinkAuthority(r.db, second.key, '9002', NOW)).toEqual({ ok: false, reason: 'member_linked' });
    expect(r.sqlite.query(`SELECT github_id FROM members WHERE id = 'mem_machine_2'`).get()).toEqual({ github_id: '9001' });
  });

  it('refuses a member revoked after the mint, and a revoked member is never found by its account', async () => {
    const r = rig();
    const issued = await issueIdentityLinkAuthority(r.db, 'mem_machine_2', NOW);
    r.sqlite.query(`UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_2'`).run(NOW);
    expect(await spendIdentityLinkAuthority(r.db, issued.key, '9001', NOW)).toEqual({ ok: false, reason: 'member_revoked' });
    expect(await memberByGithubId(r.db, '583231')).toEqual({ id: 'mem_machine_1', label: 'machine_1' });
    r.sqlite.query(`UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_1'`).run(NOW);
    expect(await memberByGithubId(r.db, '583231')).toBeNull();
  });

  it('finds no member for an account that is not an account id, and never for an unlinked one', async () => {
    const r = rig();
    expect(await memberByGithubId(r.db, 'octocat')).toBeNull();
    expect(await memberByGithubId(r.db, '1')).toBeNull();
  });

  it('reclaims finished authorities older than the retention on the spend path, and never a live one', async () => {
    const r = rig();
    const old = NOW - IDENTITY_LINK_RETENTION_MS - 1;
    const spent = await issueIdentityLinkAuthority(r.db, 'mem_machine_2', old);
    await spendIdentityLinkAuthority(r.db, spent.key, '9001', old);
    const expired = await issueIdentityLinkAuthority(r.db, 'mem_machine_3', old - IDENTITY_LINK_TTL_MS);
    const live = await issueIdentityLinkAuthority(r.db, 'mem_machine_4', NOW - IDENTITY_LINK_RETENTION_MS - 1, { ttlMs: 2 * IDENTITY_LINK_RETENTION_MS });
    expect(await reclaimIdentityLinkAuthorities(r.db, NOW)).toEqual({ reclaimed: 2 });
    const remaining = r.sqlite.query(`SELECT id FROM identity_link_authorities ORDER BY id`).all() as { id: string }[];
    expect(remaining.map((x) => x.id)).toEqual([live.id]);
    expect(remaining.map((x) => x.id)).not.toContain(spent.id);
    expect(remaining.map((x) => x.id)).not.toContain(expired.id);
  });
});
