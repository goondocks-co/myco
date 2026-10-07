import { describe, expect, it } from 'bun:test';
import { signPayload, signSession, verifySession, SESSION_COOKIE, SESSION_TYP } from '@myco-server-worker/auth/owner/cookie.js';
import { deploymentIdentity, memberSubject } from '@myco-server-worker/auth/authorization.js';
import { dashboardPermissions } from '@myco-server-worker/auth/dashboard-permissions.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, SESSION_SECRET, LINKED_SUB, MEMBER_SUB, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

describe('dashboard Deployment audience', () => {
  it('refuses cross-tenant cookies with the same signing configuration and linked account', async () => {
    const a = sqliteEnv();
    const b = sqliteEnv();
    try {
      const now = Date.now();
      const audience = await deploymentIdentity(a.db);
      expect(audience).not.toBe(await deploymentIdentity(b.db));
      const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: audience, sub: LINKED_SUB, login: 'fixture', iat: now, exp: now + 60_000 })}`;
      const get = (env: typeof a.env) => worker.fetch(new Request('https://s/api/projects', { headers: { cookie, 'cf-connecting-ip': '1.2.3.4' } }), { ...env, ...OWNER_ENV });
      expect((await get(a.env)).status).toBe(200);
      const before = b.sqlite.serialize();
      expect((await get(b.env)).status).toBe(401);
      expect(b.sqlite.serialize()).toEqual(before);
      a.sqlite.run("UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_1'", [now]);
      expect((await get(a.env)).status).toBe(401);
      const me = await worker.fetch(new Request('https://s/auth/me', { headers: { cookie, 'cf-connecting-ip': '1.2.3.4' } }), { ...a.env, ...OWNER_ENV });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ member: null, membership: { state: 'inactive', reason: expect.stringContaining('inactive') }, permissions: { settings: { allowed: false } } });
    } finally { a.sqlite.close(); b.sqlite.close(); }
  });

  it('refuses legacy audience-free cookies and mismatched or empty audiences', async () => {
    const payload = { sub: LINKED_SUB, login: 'fixture', iat: 1, exp: 100 };
    const legacy = await signPayload(SESSION_SECRET, SESSION_TYP, payload);
    expect(await verifySession(SESSION_SECRET, legacy, 2, 'tenant-a')).toBeNull();
    const signed = await signSession(SESSION_SECRET, { ...payload, aud: 'tenant-a' });
    expect(await verifySession(SESSION_SECRET, signed, 2, 'tenant-a')).toMatchObject({ aud: 'tenant-a' });
    expect(await verifySession(SESSION_SECRET, signed, 2, 'tenant-b')).toBeNull();
    expect(await verifySession(SESSION_SECRET, signed, 2, '')).toBeNull();
  });
});

describe('dashboard policy projection', () => {
  it('uses live roles and preserves uploader and claimant restrictions for owners and administrators', async () => {
    const e = sqliteEnv();
    try {
      for (const role of ['owner', 'admin', 'member'] as const) {
        const permissions = dashboardPermissions({ ...await memberSubject(e.db, 'mem_machine_1', 'http'), role });
        expect(permissions.settings.allowed).toBe(role !== 'member');
        expect(permissions.roles.allowed).toBe(role === 'owner');
        expect(permissions.backups.allowed).toBe(role !== 'member');
        expect(permissions.machineSettings.scope).toBe('own');
        expect(permissions.raw.scope).toBe('own');
        expect(permissions.runsCancel.scope).toBe(role === 'member' ? 'own' : 'all');
      }
      e.sqlite.run("UPDATE members SET revoked_at = 1 WHERE id = 'mem_machine_1'");
      const inactive = dashboardPermissions(await memberSubject(e.db, 'mem_machine_1', 'http'));
      expect(inactive.settings.allowed).toBe(false);
      expect(inactive.machineSettings.scope).toBe('none');
      expect(inactive.raw.scope).toBe('none');
    } finally { e.sqlite.close(); }
  });

  it('shows the owner to every member and projects exact Stop authority for each machine', async () => {
    const e = sqliteEnv();
    try {
      seedMemberRoleAccount(e.sqlite);
      e.sqlite.run("UPDATE deployment_ownership SET member_id = 'mem_machine_1', revision = 1 WHERE id = 1");
      e.sqlite.run("UPDATE members SET role = 'admin', github_id = '770003' WHERE id = 'mem_machine_3'");
      const now = Date.now();
      for (const [machineId, memberId] of [['m_owner', 'mem_machine_1'], ['m_admin', 'mem_machine_3'], ['m_member', 'mem_machine_2']] as const) {
        e.sqlite.run('INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (?, ?, ?)', [machineId, memberId, now - 1_000]);
        await issueMemberToken(e.db, { memberId, machineId }, now);
      }
      const get = async (sub: string, path: string) => worker.fetch(new Request(`https://s${path}`, {
        headers: { cookie: await ownerCookie(e.db, now, sub), 'cf-connecting-ip': '1.2.3.4' },
      }), { ...e.env, ...OWNER_ENV });
      for (const sub of [MEMBER_SUB, '770003']) {
        const response = await get(sub, '/api/members');
        expect(response.status).toBe(200);
        const body = await response.json() as { members: Array<{ id: string; effectiveRole: string }> };
        expect(body.members.find((member) => member.id === 'mem_machine_1')?.effectiveRole).toBe('owner');
      }
      const adminResponse = await get('770003', '/api/machines');
      expect(adminResponse.status).toBe(200);
      const adminRows = (await adminResponse.json() as { machines: Array<{ machineId: string; canStop: boolean; stopReason: string | null }> }).machines;
      expect(adminRows.find((machine) => machine.machineId === 'm_owner')).toMatchObject({ canStop: false, stopReason: expect.stringContaining('owner') });
      expect(adminRows.find((machine) => machine.machineId === 'm_admin')).toMatchObject({ canStop: true, stopReason: null });
      const memberRows = (await (await get(MEMBER_SUB, '/api/machines')).json() as { machines: Array<{ machineId: string; canStop: boolean; stopReason: string | null }> }).machines;
      expect(memberRows).toEqual([expect.objectContaining({ machineId: 'm_member', canStop: true, stopReason: null })]);
      const ownerRows = (await (await get(LINKED_SUB, '/api/machines')).json() as { machines: Array<{ machineId: string; canStop: boolean }> }).machines;
      expect(ownerRows.find((machine) => machine.machineId === 'm_owner')?.canStop).toBe(true);
    } finally { e.sqlite.close(); }
  });
});
