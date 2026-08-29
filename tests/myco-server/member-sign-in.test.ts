/**
 * Member sign-in: a GitHub session is a member only while a live member row is
 * linked to its account, decided on every request. The link is minted by the
 * member's credential and spent by the signed-in account that confirms it.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const IP = { 'cf-connecting-ip': '1.2.3.4' };
const get = async (path: string, sub: string) => new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now(), sub), ...IP } });
const post = async (path: string, sub: string, body: unknown, origin = 'https://s') =>
  new Request(`https://s${path}`, { method: 'POST', headers: { cookie: await ownerCookie(Date.now(), sub), ...IP, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A member credential for `memberId`, and the one-time link key it mints. */
async function mintLink(e: ReturnType<typeof sqliteEnv>, memberId: string, machineId: string): Promise<string> {
  const token = (await issueMemberToken(e.db, { memberId, machineId }, Date.now())).token;
  const res = await worker.fetch(new Request('https://s/members/link-github', { method: 'POST', headers: memberHeaders(token), body: '{}' }), { ...e.env, ...OWNER_ENV });
  const body = await res.json() as { persisted: boolean; key?: string };
  expect(body.persisted).toBe(true);
  return body.key!;
}

describe('member sign-in', () => {
  it('links the signed-in account to the member the key names, after a preview that names it, and the account then reaches every member route', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const key = await mintLink(e, 'mem_machine_2', 'machine_2');

    expect((await worker.fetch(await get('/api/projects', '9001'), env)).status).toBe(401);

    const preview = await worker.fetch(await post('/auth/link', '9001', { key }), env);
    expect({ status: preview.status, body: await preview.json() }).toEqual({ status: 200, body: { preview: { member: { id: 'mem_machine_2', label: 'machine_2' } } } });
    expect(e.executed.filter((sql) => /UPDATE members/.test(sql))).toEqual([]);

    const linked = await worker.fetch(await post('/auth/link', '9001', { key, confirm: true, memberId: 'mem_machine_3' }), env);
    expect({ status: linked.status, body: await linked.json() }).toEqual({ status: 200, body: { linked: true, member: { id: 'mem_machine_2', label: 'machine_2' } } });
    expect(e.sqlite.query(`SELECT id FROM members WHERE github_id = '9001'`).all()).toEqual([{ id: 'mem_machine_2' }]);

    expect((await worker.fetch(await get('/api/projects', '9001'), env)).status).toBe(200);
    const me = await worker.fetch(await get('/auth/me', '9001'), env);
    expect(await me.json()).toEqual({ sub: '9001', login: 'octocat', member: { id: 'mem_machine_2', label: 'machine_2' } });
  });

  it('is flat: two linked members see the same projects', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const key = await mintLink(e, 'mem_machine_2', 'machine_2');
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

    const key = await mintLink(e, 'mem_machine_2', 'machine_2');
    expect((await worker.fetch(await post('/auth/link', '9001', { key, confirm: true }), env)).status).toBe(200);
    const spent = await worker.fetch(await post('/auth/link', '9002', { key, confirm: true }), env);
    expect({ status: spent.status, body: await spent.json() }).toEqual({ status: 400, body: { error: 'link_denied' } });

    const taken = await worker.fetch(await post('/auth/link', '9001', { key: await mintLink(e, 'mem_machine_3', 'machine_3'), confirm: true }), env);
    expect({ status: taken.status, body: await taken.json() }).toEqual({ status: 409, body: { error: 'identity_taken' } });
    expect(e.sqlite.query(`SELECT id FROM members WHERE github_id = '9001'`).all()).toEqual([{ id: 'mem_machine_2' }]);

    const again = await worker.fetch(await post('/auth/link', '9003', { key: await mintLink(e, 'mem_machine_2', 'machine_2'), confirm: true }), env);
    expect({ status: again.status, body: await again.json() }).toEqual({ status: 409, body: { error: 'member_linked' } });

    const doomed = await mintLink(e, 'mem_machine_4', 'machine_4');
    e.sqlite.query(`UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_4'`).run(Date.now());
    const revoked = await worker.fetch(await post('/auth/link', '9004', { key: doomed, confirm: true }), env);
    expect({ status: revoked.status, body: await revoked.json() }).toEqual({ status: 403, body: { error: 'member_revoked' } });

    const malformed = await worker.fetch(await post('/auth/link', '9005', { key: 'short' }), env);
    expect(malformed.status).toBe(400);
  });

  it('mints a link only for a member credential, with an empty body, charging no quota', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
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
