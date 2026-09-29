/**
 * Identity link authorities: the proof that binds a GitHub account to a member.
 *
 * A member credential mints one while the Deployment has no linked admin, an
 * admin mints one after; the account that proved itself through GitHub spends.
 * Nothing here takes a member id from a caller — the authority names it.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  IDENTITY_LINK_KEY_PATTERN, IDENTITY_LINK_RETENTION_MS, IDENTITY_LINK_TTL_MS,
  issueIdentityLinkAuthority, memberByGithubId, previewIdentityLinkAuthority, reclaimIdentityLinkAuthorities, spendIdentityLinkAuthority,
  type IssuedIdentityLinkAuthority,
} from '@myco-server-worker/auth/identity-link.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { migrateAndSeed } from './helpers/d1.js';

const NOW = 1_800_000_000_000;

/** The seeded admin `mem_machine_1`, linked to a GitHub account: the one who creates link keys once bootstrap is over. */
const ADMIN = 'mem_machine_1';

function rig() {
  const sqlite = migrateAndSeed(new Database(':memory:'));
  return { sqlite, db: sqliteRelationalStore(sqlite) };
}

/** A key the seeded admin created for `memberId`. */
async function issue(db: RelationalStore, memberId: string, nowMs: number, options: { ttlMs?: number } = {}): Promise<IssuedIdentityLinkAuthority> {
  const issued = await issueIdentityLinkAuthority(db, memberId, nowMs, { issuedBy: ADMIN, ...options });
  if (issued === null) throw new Error('fixture: the seeded admin was refused a link key');
  return issued;
}

describe('identity link authority', () => {
  it('mints a key of the admitted shape, bound to the member, and stores only its digest', async () => {
    const r = rig();
    const issued = await issue(r.db, 'mem_machine_2', NOW);
    expect(IDENTITY_LINK_KEY_PATTERN.test(issued.key)).toBe(true);
    expect(issued.id.startsWith('il_')).toBe(true);
    expect(issued.expiresAt).toBe(NOW + IDENTITY_LINK_TTL_MS);
    const rows = r.sqlite.query(`SELECT member_id, used_at, issued_by FROM identity_link_authorities`).all();
    expect(rows).toEqual([{ member_id: 'mem_machine_2', used_at: null, issued_by: ADMIN }]);
    expect(JSON.stringify(r.sqlite.query(`SELECT * FROM identity_link_authorities`).all())).not.toContain(issued.key);
  });

  it('binds the account that spends it to the member the key names, and the member is then found by that account', async () => {
    const r = rig();
    const issued = await issue(r.db, 'mem_machine_2', NOW);
    expect(await spendIdentityLinkAuthority(r.db, issued.key, '9001', NOW)).toEqual({ ok: true, member: { id: 'mem_machine_2', label: 'machine_2', role: 'admin' } });
    expect(r.sqlite.query(`SELECT github_id FROM members WHERE id = 'mem_machine_2'`).get()).toEqual({ github_id: '9001' });
    expect(r.sqlite.query(`SELECT used_by FROM identity_link_authorities WHERE id = ?`).get(issued.id)).toEqual({ used_by: '9001' });
    expect(await memberByGithubId(r.db, '9001')).toEqual({ id: 'mem_machine_2', label: 'machine_2', role: 'admin' });
  });

  it('spends once: a second presentation, an unknown key, and an expired key are all denied alike, changing nothing', async () => {
    const r = rig();
    const issued = await issue(r.db, 'mem_machine_2', NOW);
    expect(await spendIdentityLinkAuthority(r.db, issued.key, '9001', NOW)).toMatchObject({ ok: true });
    expect(await spendIdentityLinkAuthority(r.db, issued.key, '9002', NOW)).toEqual({ ok: false, reason: 'denied' });
    expect(await spendIdentityLinkAuthority(r.db, 'x'.repeat(43), '9002', NOW)).toEqual({ ok: false, reason: 'denied' });
    const late = await issue(r.db, 'mem_machine_3', NOW);
    expect(await spendIdentityLinkAuthority(r.db, late.key, '9003', NOW + IDENTITY_LINK_TTL_MS)).toEqual({ ok: false, reason: 'denied' });
    expect(r.sqlite.query(`SELECT github_id FROM members WHERE id IN ('mem_machine_2','mem_machine_3') ORDER BY id`).all())
      .toEqual([{ github_id: '9001' }, { github_id: null }]);
  });

  it('refuses an account that is already another member\'s, keeping the first binding and spending the key', async () => {
    const r = rig();
    const a = await issue(r.db, 'mem_machine_2', NOW);
    expect(await spendIdentityLinkAuthority(r.db, a.key, '9001', NOW)).toMatchObject({ ok: true });
    const b = await issue(r.db, 'mem_machine_3', NOW);
    expect(await spendIdentityLinkAuthority(r.db, b.key, '9001', NOW)).toEqual({ ok: false, reason: 'identity_taken' });
    expect(r.sqlite.query(`SELECT id FROM members WHERE github_id = '9001'`).all()).toEqual([{ id: 'mem_machine_2' }]);
    expect(await spendIdentityLinkAuthority(r.db, b.key, '9002', NOW)).toEqual({ ok: false, reason: 'denied' });
  });

  it('refuses a member that is already linked to another account: what the victim of a stolen key sees', async () => {
    const r = rig();
    const first = await issue(r.db, 'mem_machine_2', NOW);
    expect(await spendIdentityLinkAuthority(r.db, first.key, '9001', NOW)).toMatchObject({ ok: true });
    const second = await issue(r.db, 'mem_machine_2', NOW);
    expect(await spendIdentityLinkAuthority(r.db, second.key, '9002', NOW)).toEqual({ ok: false, reason: 'member_linked' });
    expect(r.sqlite.query(`SELECT github_id FROM members WHERE id = 'mem_machine_2'`).get()).toEqual({ github_id: '9001' });
  });

  it('refuses a member revoked after the mint, and a revoked member is never found by its account', async () => {
    const r = rig();
    const issued = await issue(r.db, 'mem_machine_2', NOW);
    r.sqlite.query(`UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_2'`).run(NOW);
    expect(await spendIdentityLinkAuthority(r.db, issued.key, '9001', NOW)).toEqual({ ok: false, reason: 'member_revoked' });
    expect(await memberByGithubId(r.db, '583231')).toEqual({ id: 'mem_machine_1', label: 'machine_1', role: 'admin' });
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
    const spent = await issue(r.db, 'mem_machine_2', old);
    await spendIdentityLinkAuthority(r.db, spent.key, '9001', old);
    const expired = await issue(r.db, 'mem_machine_3', old - IDENTITY_LINK_TTL_MS);
    const live = await issue(r.db, 'mem_machine_4', NOW - IDENTITY_LINK_RETENTION_MS - 1, { ttlMs: 2 * IDENTITY_LINK_RETENTION_MS });
    expect(await reclaimIdentityLinkAuthorities(r.db, NOW)).toEqual({ reclaimed: 2 });
    const remaining = r.sqlite.query(`SELECT id FROM identity_link_authorities ORDER BY id`).all() as { id: string }[];
    expect(remaining.map((x) => x.id)).toEqual([live.id]);
    expect(remaining.map((x) => x.id)).not.toContain(spent.id);
    expect(remaining.map((x) => x.id)).not.toContain(expired.id);
  });
});

/** Every member unlinked: a Deployment on which no admin has signed in yet. */
const fresh = (sqlite: Database) => sqlite.query(`UPDATE members SET github_id = NULL`).run();
const linked = (sqlite: Database) => sqlite.query(`SELECT id, github_id FROM members WHERE github_id IS NOT NULL ORDER BY id`).all();
const keyRows = (sqlite: Database) => (sqlite.query(`SELECT COUNT(*) c FROM identity_link_authorities`).get() as { c: number }).c;

describe('bootstrap, then admin (#1448)', () => {
  it('mints and binds a member\'s own key on a fresh Deployment, and once that admin is linked mints no other member\'s own key', async () => {
    const r = rig();
    fresh(r.sqlite);
    const own = await issueIdentityLinkAuthority(r.db, 'mem_machine_2', NOW);
    expect(own).not.toBeNull();
    expect(r.sqlite.query(`SELECT issued_by FROM identity_link_authorities`).all()).toEqual([{ issued_by: null }]);
    expect(await spendIdentityLinkAuthority(r.db, own!.key, '9001', NOW)).toEqual({ ok: true, member: { id: 'mem_machine_2', label: 'machine_2', role: 'admin' } });

    expect(await issueIdentityLinkAuthority(r.db, 'mem_machine_3', NOW)).toBeNull();
    expect(keyRows(r.sqlite)).toBe(1);
    expect(linked(r.sqlite)).toEqual([{ id: 'mem_machine_2', github_id: '9001' }]);
  });

  it('mints no key for a member\'s own credential while any admin is linked, an unlinked admin included, and binds nothing', async () => {
    const r = rig();
    r.sqlite.query(`UPDATE members SET role = 'member' WHERE id = 'mem_machine_3'`).run();
    for (const member of ['mem_machine_2', 'mem_machine_3', ADMIN]) {
      expect({ member, issued: await issueIdentityLinkAuthority(r.db, member, NOW) }).toEqual({ member, issued: null });
    }
    expect(keyRows(r.sqlite)).toBe(0);
    expect(linked(r.sqlite)).toEqual([{ id: ADMIN, github_id: '583231' }]);
    expect(await memberByGithubId(r.db, '583231')).toEqual({ id: ADMIN, label: 'machine_1', role: 'admin' });
  });

  it('keeps bootstrap open while only a plain member is linked: the rule reads linked admins', async () => {
    const r = rig();
    fresh(r.sqlite);
    r.sqlite.query(`UPDATE members SET role = 'member', github_id = '9009' WHERE id = 'mem_machine_3'`).run();
    const own = await issueIdentityLinkAuthority(r.db, 'mem_machine_2', NOW);
    expect(own).not.toBeNull();
    expect(await spendIdentityLinkAuthority(r.db, own!.key, '9001', NOW)).toMatchObject({ ok: true });
    expect(await issueIdentityLinkAuthority(r.db, 'mem_machine_4', NOW)).toBeNull();
  });

  it('binds nothing with a key minted during bootstrap once bootstrap is over: the preview and the spend both say an admin must link it', async () => {
    const r = rig();
    fresh(r.sqlite);
    const first = (await issueIdentityLinkAuthority(r.db, 'mem_machine_2', NOW))!;
    const stale = (await issueIdentityLinkAuthority(r.db, 'mem_machine_3', NOW))!;
    expect(await previewIdentityLinkAuthority(r.db, stale.key, NOW)).toEqual({ ok: true, member: { id: 'mem_machine_3', label: 'machine_3', role: 'admin' } });
    expect(await spendIdentityLinkAuthority(r.db, first.key, '9001', NOW)).toMatchObject({ ok: true });

    expect(await previewIdentityLinkAuthority(r.db, stale.key, NOW)).toEqual({ ok: false, reason: 'link_requires_admin' });
    expect(await spendIdentityLinkAuthority(r.db, stale.key, '9002', NOW)).toEqual({ ok: false, reason: 'link_requires_admin' });
    expect(linked(r.sqlite)).toEqual([{ id: 'mem_machine_2', github_id: '9001' }]);
  });

  it('lets one of two bootstrap spends bind when the second has read the member unlinked before the first binds: the rule is decided in the write', async () => {
    const r = rig();
    fresh(r.sqlite);
    const a = (await issueIdentityLinkAuthority(r.db, 'mem_machine_2', NOW))!;
    const b = (await issueIdentityLinkAuthority(r.db, 'mem_machine_3', NOW))!;

    // B runs every read and stops at its bind; A spends whole; then B binds.
    let reachBind!: () => void;
    const atBind = new Promise<void>((resolve) => { reachBind = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holdRun = (statement: PreparedStatement): PreparedStatement => ({
      bind: (...values: unknown[]) => holdRun(statement.bind(...values)),
      first: <T,>() => statement.first<T>(),
      all: <T,>() => statement.all<T>(),
      run: async () => { reachBind(); await released; return statement.run(); },
    });
    const held: RelationalStore = {
      prepare: (sql) => (/^\s*UPDATE members SET github_id/.test(sql) ? holdRun(r.db.prepare(sql)) : r.db.prepare(sql)),
      batch: (statements) => r.db.batch(statements),
    };
    const second = spendIdentityLinkAuthority(held, b.key, '9002', NOW);
    await atBind;
    expect(linked(r.sqlite)).toEqual([]);
    expect(await spendIdentityLinkAuthority(r.db, a.key, '9001', NOW)).toMatchObject({ ok: true });
    release();
    expect(await second).toEqual({ ok: false, reason: 'link_requires_admin' });
    expect(linked(r.sqlite)).toEqual([{ id: 'mem_machine_2', github_id: '9001' }]);
  });

  it('binds an admin\'s key after bootstrap, and nothing once that admin is revoked, unlinked or no longer an admin', async () => {
    const r = rig();
    const ok = await issue(r.db, 'mem_machine_2', NOW);
    expect(await spendIdentityLinkAuthority(r.db, ok.key, '9001', NOW)).toMatchObject({ ok: true });

    const cases: Array<[string, string]> = [
      ['revoked', `UPDATE members SET revoked_at = ${NOW} WHERE id = '${ADMIN}'`],
      ['unlinked', `UPDATE members SET github_id = NULL WHERE id = '${ADMIN}'`],
      ['demoted', `UPDATE members SET role = 'member' WHERE id = '${ADMIN}'`],
    ];
    for (const [what, change] of cases) {
      const s = rig();
      const key = await issue(s.db, 'mem_machine_3', NOW);
      s.sqlite.query(change).run();
      expect({ what, spent: await spendIdentityLinkAuthority(s.db, key.key, '9003', NOW) }).toEqual({ what, spent: { ok: false, reason: 'link_requires_admin' } });
      expect({ what, linked: s.sqlite.query(`SELECT github_id FROM members WHERE id = 'mem_machine_3'`).get() }).toEqual({ what, linked: { github_id: null } });
    }
  });

  it('mints no admin key for an issuer that is not a live, linked admin', async () => {
    const r = rig();
    r.sqlite.query(`UPDATE members SET role = 'member', github_id = '9002' WHERE id = 'mem_machine_2'`).run();
    for (const issuedBy of ['mem_machine_2', 'mem_machine_3', 'mem_nobody']) {
      expect({ issuedBy, issued: await issueIdentityLinkAuthority(r.db, 'mem_machine_4', NOW, { issuedBy }) }).toEqual({ issuedBy, issued: null });
    }
    expect(keyRows(r.sqlite)).toBe(0);
  });

  it('withdraws the member\'s earlier unspent keys when an admin creates a new one, and none when the mint is refused', async () => {
    const r = rig();
    const earlier = await issue(r.db, 'mem_machine_3', NOW);
    const later = (await issueIdentityLinkAuthority(r.db, 'mem_machine_3', NOW, { issuedBy: ADMIN, replaceUnspent: true }))!;
    expect(await previewIdentityLinkAuthority(r.db, earlier.key, NOW)).toEqual({ ok: false, reason: 'denied' });
    expect(await previewIdentityLinkAuthority(r.db, later.key, NOW)).toMatchObject({ ok: true });
    expect(await issueIdentityLinkAuthority(r.db, 'mem_machine_3', NOW, { replaceUnspent: true })).toBeNull();
    expect(await previewIdentityLinkAuthority(r.db, later.key, NOW)).toMatchObject({ ok: true });
  });
});
