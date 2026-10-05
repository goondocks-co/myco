/**
 * Member sign-in: a GitHub session is a member only while a live member row is
 * linked to its account, decided on every request. The link is minted by the
 * member's own credential on a Deployment with no linked admin, and by a
 * signed-in admin after, and spent by the signed-in account that confirms it.
 */
import { jsonBody } from '../helpers/json-body.js';
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { LINK_REQUIRES_ADMIN } from '@myco-server-worker/auth/members.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/constants.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { LINKED_SUB, OWNER_ENV, PRINCIPAL, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

const IP = { 'cf-connecting-ip': '1.2.3.4' };
const get = async (path: string, sub: string) => new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now(), sub), ...IP } });
const post = async (path: string, sub: string, body: unknown, origin = 'https://s') =>
  new Request(`https://s${path}`, { method: 'POST', headers: { cookie: await ownerCookie(Date.now(), sub), ...IP, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A member credential for `memberId`, and the one-time link key it mints: only on a Deployment with no linked admin. */
async function mintLink(e: ReturnType<typeof sqliteEnv>, memberId: string, machineId: string): Promise<string> {
  const token = (await issueMemberToken(e.db, { memberId, machineId }, Date.now())).token;
  const res = await worker.fetch(new Request('https://s/members/link-github', { method: 'POST', headers: memberHeaders(token), body: '{}' }), { ...e.env, ...OWNER_ENV });
  const body = await res.json() as { persisted: boolean; key?: string };
  expect(body.persisted).toBe(true);
  return body.key!;
}

/** The one-time link key the seeded admin creates for `memberId` from the dashboard. */
async function adminLink(e: ReturnType<typeof sqliteEnv>, memberId: string): Promise<string> {
  const res = await worker.fetch(await post(`/api/members/${memberId}/link-github`, LINKED_SUB, undefined), { ...e.env, ...OWNER_ENV });
  const body = await res.json() as { key?: string };
  expect({ status: res.status, key: typeof body.key }).toEqual({ status: 201, key: 'string' });
  return body.key!;
}

/** Every member unlinked: a Deployment on which no admin has signed in yet. */
const fresh = (e: ReturnType<typeof sqliteEnv>) => e.sqlite.query(`UPDATE members SET github_id = NULL`).run();
const linkRequest = (token: string) => new Request('https://s/members/link-github', { method: 'POST', headers: memberHeaders(token), body: '{}' });

describe('member sign-in', () => {
  it('links the signed-in account to the member an admin\'s key names, after a preview that names it, and the account then reaches every member route', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const key = await adminLink(e, 'mem_machine_2');

    expect((await worker.fetch(await get('/api/projects', '9001'), env)).status).toBe(401);

    const preview = await worker.fetch(await post('/auth/link', '9001', { key }), env);
    expect({ status: preview.status, body: await preview.json() }).toEqual({ status: 200, body: { preview: { member: { id: 'mem_machine_2', label: 'machine_2', role: 'admin' } } } });
    expect(e.executed.filter((sql) => /UPDATE members/.test(sql))).toEqual([]);

    const linked = await worker.fetch(await post('/auth/link', '9001', { key, confirm: true, memberId: 'mem_machine_3' }), env);
    expect({ status: linked.status, body: await linked.json() }).toEqual({ status: 200, body: { linked: true, member: { id: 'mem_machine_2', label: 'machine_2', role: 'admin' } } });
    expect(e.sqlite.query(`SELECT id FROM members WHERE github_id = '9001'`).all()).toEqual([{ id: 'mem_machine_2' }]);

    expect((await worker.fetch(await get('/api/projects', '9001'), env)).status).toBe(200);
    const me = await worker.fetch(await get('/auth/me', '9001'), env);
    expect(await jsonBody(me)).toEqual({ sub: '9001', login: 'octocat', owner: false, member: { id: 'mem_machine_2', label: 'machine_2', role: 'admin' } });
  });

  it('is flat: two linked members see the same projects', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const key = await adminLink(e, 'mem_machine_2');
    expect((await worker.fetch(await post('/auth/link', '9001', { key, confirm: true }), env)).status).toBe(200);
    const [a, b] = await Promise.all([worker.fetch(await get('/api/projects', '583231'), env), worker.fetch(await get('/api/projects', '9001'), env)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.json()).toEqual(await b.json());
  });

  it('refuses an unlinked account on every member route with no write, and answers it on the two link routes while metering it like credential-free traffic', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    e.executed.length = 0;
    for (const path of ['/api/projects', '/api/status', '/api/projects/proj_1/sessions']) {
      expect({ path, status: (await worker.fetch(await get(path, '4242'), env)).status }).toEqual({ path, status: 401 });
    }
    expect(e.executed.filter((sql) => /INSERT INTO members|UPDATE members/.test(sql))).toEqual([]);

    e.sourceKeys.length = 0;
    expect((await worker.fetch(await get('/auth/me', '4242'), env)).status).toBe(200);
    expect(e.sourceKeys.length).toBe(1);
    e.sourceKeys.length = 0;
    expect((await worker.fetch(await get('/auth/me', '583231'), env)).status).toBe(200);
    expect(e.sourceKeys).toEqual([]);
  });

  it('stops admitting a member the moment it is revoked', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    expect((await worker.fetch(await get('/api/projects', '583231'), env)).status).toBe(200);
    e.sqlite.query(`UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_1'`).run(Date.now());
    expect((await worker.fetch(await get('/api/projects', '583231'), env)).status).toBe(401);
  });

  it('names every refusal of a link: spent, foreign origin, an account already another member\'s, a member already linked, a member revoked', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };

    const crossOrigin = await worker.fetch(await post('/auth/link', '9001', { key: 'k'.repeat(43) }, 'https://evil.example'), env);
    expect(crossOrigin.status).toBe(403);

    const key = await adminLink(e, 'mem_machine_2');
    expect((await worker.fetch(await post('/auth/link', '9001', { key, confirm: true }), env)).status).toBe(200);
    const spent = await worker.fetch(await post('/auth/link', '9002', { key, confirm: true }), env);
    expect({ status: spent.status, body: await spent.json() }).toEqual({ status: 400, body: { error: 'link_denied' } });

    const taken = await worker.fetch(await post('/auth/link', '9001', { key: await adminLink(e, 'mem_machine_3'), confirm: true }), env);
    expect({ status: taken.status, body: await taken.json() }).toEqual({ status: 409, body: { error: 'identity_taken' } });
    expect(e.sqlite.query(`SELECT id FROM members WHERE github_id = '9001'`).all()).toEqual([{ id: 'mem_machine_2' }]);

    // A key minted ahead of the member's link, spent after it.
    const early = (await issueIdentityLinkAuthority(e.db, 'mem_machine_2', Date.now(), { issuedBy: PRINCIPAL.id }))!.key;
    const again = await worker.fetch(await post('/auth/link', '9003', { key: early, confirm: true }), env);
    expect({ status: again.status, body: await again.json() }).toEqual({ status: 409, body: { error: 'member_linked' } });

    const doomed = await adminLink(e, 'mem_machine_4');
    e.sqlite.query(`UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_4'`).run(Date.now());
    const revoked = await worker.fetch(await post('/auth/link', '9004', { key: doomed, confirm: true }), env);
    expect({ status: revoked.status, body: await revoked.json() }).toEqual({ status: 403, body: { error: 'member_revoked' } });

    const malformed = await worker.fetch(await post('/auth/link', '9005', { key: 'short' }), env);
    expect(malformed.status).toBe(400);
  });

  it('mints a link only for a member credential, with an empty body, charging no quota, on a Deployment with no linked admin', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    fresh(e);
    expect((await worker.fetch(new Request('https://s/members/link-github', { method: 'POST', headers: IP, body: '{}' }), env)).status).toBe(401);
    const token = (await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now())).token;
    const extra = await worker.fetch(new Request('https://s/members/link-github', { method: 'POST', headers: memberHeaders(token), body: '{"memberId":"mem_machine_3"}' }), env);
    expect(await extra.json()).toMatchObject({ persisted: false, code: 'unknown_field' });
    const minted = await worker.fetch(new Request('https://s/members/link-github', { method: 'POST', headers: memberHeaders(token), body: '{}' }), env);
    expect(await minted.json()).toMatchObject({ persisted: true });
    expect(e.sqlite.query(`SELECT bytes_written FROM member_credentials`).all()).toEqual(expect.arrayContaining([{ bytes_written: 0 }]));
    expect(e.sqlite.query(`SELECT member_id FROM identity_link_authorities`).all()).toEqual([{ member_id: 'mem_machine_2' }]);
  });
});

describe('bootstrap, then admin (#1448)', () => {
  const linked = (e: ReturnType<typeof sqliteEnv>) => e.sqlite.query(`SELECT id, github_id FROM members WHERE github_id IS NOT NULL ORDER BY id`).all();
  const keyRows = (e: ReturnType<typeof sqliteEnv>) => (e.sqlite.query(`SELECT COUNT(*) c FROM identity_link_authorities`).get() as { c: number }).c;

  it('lets the first sign-in on a fresh Deployment link itself through a member credential, and that account then signs in', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    fresh(e);
    const key = await mintLink(e, 'mem_machine_2', 'machine_2');
    const bound = await worker.fetch(await post('/auth/link', '9001', { key, confirm: true }), env);
    expect({ status: bound.status, body: await bound.json() }).toEqual({ status: 200, body: { linked: true, member: { id: 'mem_machine_2', label: 'machine_2', role: 'admin' } } });
    expect((await worker.fetch(await get('/api/projects', '9001'), env)).status).toBe(200);
  });

  it('refuses a member credential\'s self-link once an admin is linked, an unlinked admin\'s included: no key, no bind, and the linked admin still signs in', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    e.sqlite.query(`UPDATE members SET role = 'member' WHERE id = 'mem_machine_3'`).run();
    for (const [memberId, machineId] of [['mem_machine_2', 'machine_2'], ['mem_machine_3', 'machine_3'], [PRINCIPAL.id, 'machine_1']]) {
      const token = (await issueMemberToken(e.db, { memberId, machineId }, Date.now())).token;
      const res = await worker.fetch(linkRequest(token), env);
      expect({ memberId, status: res.status, body: await res.json() }).toEqual({ memberId, status: 200, body: { persisted: false, code: 'link_requires_admin', reason: LINK_REQUIRES_ADMIN } });
    }
    expect(keyRows(e)).toBe(0);
    expect(linked(e)).toEqual([{ id: PRINCIPAL.id, github_id: LINKED_SUB }]);
    expect((await worker.fetch(await get('/api/projects', LINKED_SUB), env)).status).toBe(200);
    expect(await jsonBody(await worker.fetch(await get('/auth/me', LINKED_SUB), env))).toEqual({ sub: LINKED_SUB, login: 'octocat', owner: false, member: PRINCIPAL });
  });

  it('refuses a key minted during bootstrap once bootstrap is over, in the preview and at confirmation, binding nothing', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    fresh(e);
    const first = await mintLink(e, 'mem_machine_2', 'machine_2');
    const stale = await mintLink(e, 'mem_machine_3', 'machine_3');
    expect((await worker.fetch(await post('/auth/link', '9001', { key: first, confirm: true }), env)).status).toBe(200);
    const preview = await worker.fetch(await post('/auth/link', '9002', { key: stale }), env);
    expect({ status: preview.status, body: await preview.json() }).toEqual({ status: 403, body: { error: 'link_requires_admin' } });
    const confirmed = await worker.fetch(await post('/auth/link', '9002', { key: stale, confirm: true }), env);
    expect({ status: confirmed.status, body: await confirmed.json() }).toEqual({ status: 403, body: { error: 'link_requires_admin' } });
    expect(linked(e)).toEqual([{ id: 'mem_machine_2', github_id: '9001' }]);
  });

  it('binds one of two bootstrap confirmations sent at once', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    fresh(e);
    const a = await mintLink(e, 'mem_machine_2', 'machine_2');
    const b = await mintLink(e, 'mem_machine_3', 'machine_3');
    const [ra, rb] = await Promise.all([
      worker.fetch(await post('/auth/link', '9001', { key: a, confirm: true }), env),
      worker.fetch(await post('/auth/link', '9002', { key: b, confirm: true }), env),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 403]);
    expect(linked(e)).toHaveLength(1);
  });

  it('lets a signed-in admin create a link for a member, which binds the account that confirms it', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const key = await adminLink(e, 'mem_machine_3');
    expect(e.sqlite.query(`SELECT member_id, issued_by FROM identity_link_authorities`).all()).toEqual([{ member_id: 'mem_machine_3', issued_by: PRINCIPAL.id }]);
    const preview = await worker.fetch(await post('/auth/link', '9003', { key }), env);
    expect(await jsonBody(preview)).toEqual({ preview: { member: { id: 'mem_machine_3', label: 'machine_3', role: 'admin' } } });
    expect((await worker.fetch(await post('/auth/link', '9003', { key, confirm: true }), env)).status).toBe(200);
    expect((await worker.fetch(await get('/api/projects', '9003'), env)).status).toBe(200);
    expect(linked(e)).toEqual([{ id: PRINCIPAL.id, github_id: LINKED_SUB }, { id: 'mem_machine_3', github_id: '9003' }]);
  });

  it('keeps the admin link to the dashboard session of an admin: a member bearer, a plain member\'s session, and a cross-origin post are refused, minting nothing', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const token = (await issueMemberToken(e.db, { memberId: PRINCIPAL.id, machineId: 'machine_1' }, Date.now())).token;
    const bearer = await worker.fetch(new Request('https://s/api/members/mem_machine_3/link-github', { method: 'POST', headers: { ...memberHeaders(token), origin: 'https://s' } }), env);
    expect(bearer.status).toBe(401);
    seedMemberRoleAccount(e.sqlite);
    const plain = await worker.fetch(await post('/api/members/mem_machine_3/link-github', '770001', undefined), env);
    expect({ status: plain.status, body: await plain.json() }).toEqual({ status: 403, body: { error: 'not_admin', reason: 'this action is for an admin' } });
    const foreign = await worker.fetch(await post('/api/members/mem_machine_3/link-github', LINKED_SUB, undefined, 'https://evil.example'), env);
    expect(foreign.status).toBe(403);
    expect(keyRows(e)).toBe(0);
  });

  it('withdraws a member\'s earlier link when an admin creates another for them', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const first = await adminLink(e, 'mem_machine_3');
    const second = await adminLink(e, 'mem_machine_3');
    const stale = await worker.fetch(await post('/auth/link', '9003', { key: first }), env);
    expect({ status: stale.status, body: await stale.json() }).toEqual({ status: 400, body: { error: 'link_denied' } });
    expect((await worker.fetch(await post('/auth/link', '9003', { key: second }), env)).status).toBe(200);
  });

  it('refuses a plain member\'s self-link during bootstrap', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    fresh(e);
    e.sqlite.query(`UPDATE members SET role = 'member' WHERE id = 'mem_machine_2'`).run();
    const token = (await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now())).token;
    const res = await worker.fetch(linkRequest(token), env);
    expect(await jsonBody(res)).toEqual({ persisted: false, code: 'link_requires_admin', reason: LINK_REQUIRES_ADMIN });
    expect(keyRows(e)).toBe(0);
  });

  it('names what an admin cannot link: a member already linked, one removed, one absent, and the runtime\'s own member', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    e.sqlite.query(`UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_4'`).run(Date.now());
    e.sqlite.query(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', 1, 'member')`).run(HARNESS_MEMBER_ID);
    const cases: Array<[string, number, unknown]> = [
      [PRINCIPAL.id, 409, { error: 'member_linked' }],
      ['mem_machine_4', 409, { error: 'member_revoked' }],
      ['mem_nobody', 404, { error: 'not_found' }],
      [HARNESS_MEMBER_ID, 409, { error: 'member_is_runtime' }],
    ];
    for (const [memberId, status, body] of cases) {
      const res = await worker.fetch(await post(`/api/members/${memberId}/link-github`, LINKED_SUB, undefined), env);
      expect({ memberId, status: res.status, body: await res.json() }).toEqual({ memberId, status, body });
    }
    expect(keyRows(e)).toBe(0);
  });
});
