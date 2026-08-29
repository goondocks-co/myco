/**
 * Deployment Access: members, invitations, credentials. Membership is flat and
 * every revocation names who; revoking a member is one transaction that ends
 * everything live that is theirs and never leaves the Deployment empty.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueEnrollmentAuthority, spendEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { issueIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { revokeMember } from '@myco-server-worker/auth/members-admin.js';
import { authenticateServerMemberToken, issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie, PRINCIPAL, asOwner, asOwnerPost } from './helpers/owner.js';

const NOW = 1_800_000_000_000;

describe('membership is a boundary at authentication', () => {
  it('refuses a credential of a revoked member on every route, including one issued after the revocation by direct store access', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const token = (await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now())).token;
    expect((await worker.fetch(new Request('https://s/health'), env)).status).toBe(200);
    const before = await worker.fetch(new Request('https://s/tokens/refresh', { method: 'POST', headers: memberHeaders(token), body: '{}' }), env);
    expect(before.status).toBe(200);
    e.sqlite.query(`UPDATE members SET revoked_at = ?, revoked_by = 'mem_machine_1' WHERE id = 'mem_machine_2'`).run(Date.now());
    const after = await worker.fetch(new Request('https://s/tokens/refresh', { method: 'POST', headers: memberHeaders(token), body: '{}' }), env);
    expect(after.status).toBe(401);
    const late = (await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now())).token;
    expect(await authenticateServerMemberToken(e.db, await sha256Hex(late), Date.now())).toBeNull();
  });

  it('voids an invitation for a member revoked after the mint, and names it revoked', async () => {
    const e = sqliteEnv();
    const issued = await issueEnrollmentAuthority(e.db, NOW, { memberId: 'mem_machine_2' });
    e.sqlite.query(`UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_2'`).run(NOW);
    expect(await spendEnrollmentAuthority(e.db, issued.key, NOW + 1, 'runtime')).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('revoking a member', () => {
  it('ends everything live that is theirs in one attributed transaction, and leaves machine claims alone', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const cred = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, NOW);
    const forThem = await issueEnrollmentAuthority(e.db, NOW, { memberId: 'mem_machine_2' });
    const byThem = await issueEnrollmentAuthority(e.db, NOW, { createdByMember: 'mem_machine_2' });
    const byThemForOther = await issueEnrollmentAuthority(e.db, NOW, { createdByMember: 'mem_machine_2', memberId: 'mem_machine_3' });
    const link = await issueIdentityLinkAuthority(e.db, 'mem_machine_2', NOW);
    e.sqlite.query(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('machine_2', 'mem_machine_2', ?)`).run(NOW);

    const res = await worker.fetch(await asOwnerPost('/api/members/mem_machine_2/revoke'), env);
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 200, body: { revoked: true, revokedBy: PRINCIPAL.id } });

    expect(e.sqlite.query(`SELECT revoked_by FROM members WHERE id = 'mem_machine_2'`).get()).toEqual({ revoked_by: PRINCIPAL.id });
    expect(e.sqlite.query(`SELECT revoked_by FROM member_credentials WHERE id = ?`).get(cred.tokenId)).toEqual({ revoked_by: PRINCIPAL.id });
    expect(e.sqlite.query(`SELECT id, revoked_by FROM enrollment_authorities WHERE revoked_by = ? ORDER BY id`).all(PRINCIPAL.id))
      .toEqual([forThem.id, byThem.id, byThemForOther.id].sort().map((id) => ({ id, revoked_by: PRINCIPAL.id })));
    expect(e.sqlite.query(`SELECT revoked_by FROM identity_link_authorities WHERE id = ?`).get(link.id)).toEqual({ revoked_by: PRINCIPAL.id });
    expect(e.sqlite.query(`SELECT member_id FROM machine_claims WHERE machine_id = 'machine_2'`).get()).toEqual({ member_id: 'mem_machine_2' });
    expect(await spendEnrollmentAuthority(e.db, byThem.key, NOW + 1, 'runtime')).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses to leave the Deployment with no live linked member, changing nothing', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const cred = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
    const res = await worker.fetch(await asOwnerPost('/api/members/mem_machine_1/revoke'), env);
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 409, body: { error: 'last_member' } });
    expect(e.sqlite.query(`SELECT revoked_at FROM members WHERE id = 'mem_machine_1'`).get()).toEqual({ revoked_at: null });
    expect(e.sqlite.query(`SELECT revoked_at FROM member_credentials WHERE id = ?`).get(cred.tokenId)).toEqual({ revoked_at: null });
  });

  it('is flat and serialised: with two linked members, the first revocation wins and the second is refused as the last member', async () => {
    const e = sqliteEnv();
    e.sqlite.query(`UPDATE members SET github_id = '9002' WHERE id = 'mem_machine_2'`).run();
    const [a, b] = await Promise.all([revokeMember(e.db, 'mem_machine_2', 'mem_machine_1', NOW), revokeMember(e.db, 'mem_machine_1', 'mem_machine_2', NOW)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(e.sqlite.query(`SELECT COUNT(*) AS c FROM members WHERE revoked_at IS NULL AND github_id IS NOT NULL`).get()).toEqual({ c: 1 });
  });

  it('rolls the whole transaction back when a later statement fails', async () => {
    const e = sqliteEnv();
    e.sqlite.query(`UPDATE members SET github_id = '9002' WHERE id = 'mem_machine_2'`).run();
    e.sqlite.run(`DROP TABLE identity_link_authorities`);
    await expect(revokeMember(e.db, 'mem_machine_2', 'mem_machine_1', NOW)).rejects.toThrow();
    expect(e.sqlite.query(`SELECT revoked_at FROM members WHERE id = 'mem_machine_2'`).get()).toEqual({ revoked_at: null });
  });

  it('answers 404 for an absent member and 409 for one already revoked', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    expect((await worker.fetch(await asOwnerPost('/api/members/mem_nobody/revoke'), env)).status).toBe(404);
    e.sqlite.query(`UPDATE members SET github_id = '9002' WHERE id = 'mem_machine_2'`).run();
    expect((await worker.fetch(await asOwnerPost('/api/members/mem_machine_2/revoke'), env)).status).toBe(200);
    const again = await worker.fetch(await asOwnerPost('/api/members/mem_machine_2/revoke'), env);
    expect({ status: again.status, body: await again.json() }).toEqual({ status: 409, body: { error: 'already_revoked' } });
  });
});

describe('members and invitations', () => {
  it('lists members with whether an account is connected, never the account, and live runtimes', async () => {
    const e = sqliteEnv();
    await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const res = await worker.fetch(await asOwner('/api/members'), { ...e.env, ...OWNER_ENV });
    const raw = await res.text();
    expect(raw).not.toContain('583231');
    const { members } = JSON.parse(raw) as { members: { id: string; linked: boolean; liveCredentials: number }[] };
    expect(members.find((m) => m.id === 'mem_machine_1')).toMatchObject({ linked: true, liveCredentials: 1 });
    expect(members.find((m) => m.id === 'mem_machine_2')).toMatchObject({ linked: false, liveCredentials: 0 });
  });

  it('mints an attributed invitation once, bounds its life, validates its member, lists it live, and revokes it naming who', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const minted = await worker.fetch(await asOwnerPost('/api/enrollment', { memberId: 'mem_machine_2', ttlMinutes: 30 }), env);
    expect(minted.status).toBe(201);
    const body = await minted.json() as { key: string; id: string; expiresAt: number };
    expect(e.sqlite.query(`SELECT created_by_member, member_id FROM enrollment_authorities WHERE id = ?`).get(body.id)).toEqual({ created_by_member: PRINCIPAL.id, member_id: 'mem_machine_2' });
    expect(JSON.stringify(e.sqlite.query(`SELECT * FROM enrollment_authorities`).all())).not.toContain(body.key);

    expect((await worker.fetch(await asOwnerPost('/api/enrollment', { memberId: 'mem_nobody' }), env)).status).toBe(404);
    expect((await worker.fetch(await asOwnerPost('/api/enrollment', { ttlMinutes: 1441 }), env)).status).toBe(400);
    e.sqlite.query(`UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_3'`).run(Date.now());
    expect((await worker.fetch(await asOwnerPost('/api/enrollment', { memberId: 'mem_machine_3' }), env)).status).toBe(409);
    for (const body of ['null', '[]', '"x"']) {
      const res = await worker.fetch(new Request('https://s/api/enrollment', { method: 'POST', headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' }, body }), env);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }

    const listed = await worker.fetch(await asOwner('/api/enrollment'), env);
    const { invitations } = await listed.json() as { invitations: { id: string; memberId: string | null; createdBy: string }[] };
    expect(invitations).toEqual([{ id: body.id, memberId: 'mem_machine_2', createdBy: PRINCIPAL.id, createdAt: expect.any(Number), expiresAt: body.expiresAt }]);

    const revoked = await worker.fetch(await asOwnerPost(`/api/enrollment/${body.id}/revoke`), env);
    expect(await revoked.json()).toEqual({ revoked: true, revokedBy: PRINCIPAL.id });
    expect(e.sqlite.query(`SELECT revoked_by FROM enrollment_authorities WHERE id = ?`).get(body.id)).toEqual({ revoked_by: PRINCIPAL.id });
    expect((await (await worker.fetch(await asOwner('/api/enrollment'), env)).json() as { invitations: unknown[] }).invitations).toEqual([]);
  });

  it('pages credentials on the started index and reads activity on the token index', async () => {
    const e = sqliteEnv();
    for (const plan of [
      { sql: `EXPLAIN QUERY PLAN SELECT id FROM member_credentials WHERE (lineage_started_at < 1 OR (lineage_started_at = 1 AND id < 'x')) ORDER BY lineage_started_at DESC, id DESC LIMIT 2`, index: 'idx_member_credentials_started' },
      { sql: `EXPLAIN QUERY PLAN SELECT event_id FROM events WHERE token_id = 'a' ORDER BY created_at DESC, event_id DESC LIMIT 2`, index: 'idx_events_token_only' },
    ]) {
      const rows = e.sqlite.query(plan.sql).all() as { detail: string }[];
      expect({ index: plan.index, used: rows.some((r) => r.detail.includes(plan.index)) }).toEqual({ index: plan.index, used: true });
    }
  });
});

describe('a revoked minter', () => {
  it('voids the invitations it minted and hides them, whether revoked through the API or the store', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    e.sqlite.query(`UPDATE members SET github_id = '9002' WHERE id = 'mem_machine_2'`).run();
    const minted = await issueEnrollmentAuthority(e.db, NOW, { createdByMember: 'mem_machine_2' });
    e.sqlite.query(`UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_2'`).run(NOW);
    expect((await (await worker.fetch(await asOwner('/api/enrollment'), env)).json() as { invitations: unknown[] }).invitations).toEqual([]);
    expect(await spendEnrollmentAuthority(e.db, minted.key, NOW + 1, 'runtime')).toEqual({ ok: false, reason: 'revoked' });
    const credentials = await (await worker.fetch(await asOwner('/api/credentials'), env)).json() as { rows: { memberId: string; live: boolean }[] };
    expect(credentials.rows.filter((r) => r.memberId === 'mem_machine_2').every((r) => r.live === false)).toBe(true);
  });
});

describe('the old project-pathed token surface is gone', () => {
  it('answers 401 to a session on the retired paths, as any absent path does', async () => {
    const e = sqliteEnv();
    for (const path of ['/api/projects/proj_1/tokens', '/api/projects/proj_1/tokens/mt_x/activity']) {
      const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } }), { ...e.env, ...OWNER_ENV });
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });
});
