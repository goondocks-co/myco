
import { describe, expect, it } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { issueIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { nameMemberFromLogin, revokeMember } from '@myco-server-worker/auth/members-admin.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

describe('auth setup refusals', () => {
  it('records the login once, keeps named repeated auth/me reads free of writes, and records a changed login', async () => {
    const statements: string[] = [];
    const e = sqliteEnv({ onSql: sql => statements.push(sql) });
    try {
      const server = createServer({ now: Date.now, sourceOf: () => '192.0.2.4', fetchImpl: () => { throw new Error('no OAuth'); } });
      const cookie = await ownerCookie(e.db);
      const me = () => server.handleRequest(new Request('https://s/auth/me', { headers: { cookie } }), { ...e.serverEnv, secrets: OWNER_ENV });
      expect((await me()).status).toBe(200);
      expect(e.sqlite.query("SELECT value FROM schema_meta WHERE key = 'github_login:583231'").get()).toEqual({ value: 'octocat' });
      statements.length = 0;
      for (let n = 0; n < 2; n++) {
        expect(await (await me()).json()).toMatchObject({ member: { label: 'machine_1' } });
      }
      expect(statements.filter(sql => /^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql))).toEqual([]);
      e.sqlite.run("UPDATE schema_meta SET value = 'old-login' WHERE key = 'github_login:583231'");
      expect((await me()).status).toBe(200);
      expect(e.sqlite.query("SELECT value FROM schema_meta WHERE key = 'github_login:583231'").get()).toEqual({ value: 'octocat' });
    } finally { e.sqlite.close(); }
  });

  it('deletes only the revoked member login in the admitted revocation batch', async () => {
    const e = sqliteEnv();
    try {
      e.sqlite.run("UPDATE deployment_ownership SET member_id = 'mem_machine_1', revision = revision + 1 WHERE id = 1");
      e.sqlite.run("UPDATE members SET github_id = '770001', role = 'member' WHERE id = 'mem_machine_2'");
      await nameMemberFromLogin(e.db, 'mem_machine_1', '583231', 'octocat');
      await nameMemberFromLogin(e.db, 'mem_machine_2', '770001', 'departing');
      expect(await revokeMember(e.db, 'mem_machine_1', 'mem_machine_1', 123)).toEqual({ ok: false, reason: 'active_owner' });
      expect(e.sqlite.query("SELECT value FROM schema_meta WHERE key = 'github_login:583231'").get()).toEqual({ value: 'octocat' });
      expect(await revokeMember(e.db, 'mem_machine_2', 'mem_machine_1', 124)).toEqual({ ok: true });
      expect(e.sqlite.query("SELECT key FROM schema_meta WHERE key LIKE 'github_login:%'").all()).toEqual([{ key: 'github_login:583231' }]);
    } finally { e.sqlite.close(); }
  });

  for (const operation of ['link', 'approve'] as const) {
    it(`does not fail ${operation} when the courtesy naming write fails`, async () => {
      let failures = 0;
      const e = sqliteEnv({ onSql: sql => {
        if (sql.startsWith('UPDATE members SET label = ?')) { failures++; throw new Error('naming unavailable'); }
      } });
      try {
        const now = Date.now();
        const server = createServer({ now: () => now, sourceOf: () => '192.0.2.5', fetchImpl: () => { throw new Error('no OAuth'); } });
        const env = { ...e.serverEnv, secrets: OWNER_ENV };
        const post = async (path: string, body: unknown, sub = '583231') => server.handleRequest(new Request('https://s' + path, {
          method: 'POST', headers: { cookie: await ownerCookie(e.db, now, sub), origin: 'https://s' }, body: JSON.stringify(body),
        }), env);
        if (operation === 'link') {
          e.sqlite.run("UPDATE members SET github_id = NULL, label = NULL WHERE id = 'mem_machine_2'");
          const key = await issueIdentityLinkAuthority(e.db, 'mem_machine_2', now, { issuedBy: 'mem_machine_1' });
          expect(key).not.toBeNull();
          const result = await post('/auth/link', { key: key!.key, confirm: true }, '770001');
          expect(result.status).toBe(200);
          expect(await result.json()).toMatchObject({ linked: true, member: { id: 'mem_machine_2', label: null } });
          expect(e.sqlite.query("SELECT github_id FROM members WHERE id = 'mem_machine_2'").get()).toEqual({ github_id: '770001' });
        } else {
          const start = await post('/auth/device/start', { machineId: 'courtesy', machineName: 'Laptop', os: 'linux' });
          const grant = await start.json() as { user_code: string; device_code: string };
          expect((await post('/api/device/approve', { user_code: grant.user_code })).status).toBe(200);
          expect(await (await post('/auth/device/poll', { device_code: grant.device_code })).json()).toMatchObject({ joined: true, memberId: 'mem_machine_1' });
        }
        expect(failures).toBe(1);
      } finally { e.sqlite.close(); }
    });
  }

  it('records no login or label from an account that no longer owns the member', async () => {
    const e = sqliteEnv();
    try {
      e.sqlite.run("UPDATE members SET github_id = 'new-account', label = NULL WHERE id = 'mem_machine_1'");
      expect(await nameMemberFromLogin(e.db, 'mem_machine_1', 'old-account', 'stale-login')).toBeNull();
      expect(e.sqlite.query("SELECT label FROM members WHERE id = 'mem_machine_1'").get()).toEqual({ label: null });
      expect(e.sqlite.query("SELECT value FROM schema_meta WHERE key LIKE 'github_login:%'").all()).toEqual([]);
    } finally { e.sqlite.close(); }
  });

  it('refuses both starts before writing when no live admin is linked, including an expired owner link', async () => {
    const e = sqliteEnv();
    try {
      e.sqlite.run('UPDATE members SET github_id = NULL');
      const server = createServer({ now: Date.now, fetchImpl: () => { throw new Error('no OAuth'); }, sourceOf: () => '192.0.2.1' });
      const env = { ...e.serverEnv, secrets: OWNER_ENV };
      for (const runner of [false, true]) {
        const response = await server.handleRequest(new Request(`https://s/auth/${runner ? 'runner' : 'device'}/start`, {
          method: 'POST', body: JSON.stringify({ machineId: 'fresh', machineName: 'Laptop', os: 'linux',
            ...(runner ? { name: 'box', candidate: 'mycorun_' + 'c'.repeat(43) } : {}) }),
        }), env);
        expect(response.status).toBe(409);
        expect(await response.json() as Record<string, unknown>).toEqual({ error: 'no_owner' });
      }
      expect(e.sqlite.query('SELECT COUNT(*) AS n FROM device_requests').get()).toEqual({ n: 0 });
      e.sqlite.run("UPDATE members SET github_id = '583231', revoked_at = 1 WHERE id = 'mem_machine_1'");
      const response = await server.handleRequest(new Request('https://s/auth/device/start', { method: 'POST',
        body: JSON.stringify({ machineId: 'fresh', machineName: 'Laptop', os: 'linux' }) }), env);
      expect(await response.json() as Record<string, unknown>).toEqual({ error: 'no_owner' });
    } finally { e.sqlite.close(); }
  });

  it('distinguishes an unclaimed Deployment and expired owner link, then names the linked owner without changing custom names', async () => {
    const e = sqliteEnv();
    try {
      const now = Date.now();
      e.sqlite.run("UPDATE deployment_ownership SET member_id = 'mem_machine_1', revision = revision + 1 WHERE id = 1");
      e.sqlite.run('UPDATE members SET github_id = NULL');
      e.sqlite.run("UPDATE members SET label = 'Deployment administrator' WHERE id = 'mem_machine_1'");
      e.sqlite.run("INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('first_member_setup','mem_machine_1')");
      const server = createServer({ now: () => now, fetchImpl: () => { throw new Error('no OAuth'); }, sourceOf: () => '192.0.2.2' });
      const env = { ...e.serverEnv, secrets: OWNER_ENV };
      const cookie = await ownerCookie(e.db, now, '900123');
      const request = (path: string, body?: unknown) => server.handleRequest(new Request('https://s' + path, {
        method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'https://s' }, body: body === undefined ? undefined : JSON.stringify(body),
      }), env);
      expect(await (await request('/auth/me')).json()).toMatchObject({ member: null, membership: { state: 'unclaimed' } });
      const expired = await issueIdentityLinkAuthority(e.db, 'mem_machine_1', now - 100, { ttlMs: 1 });
      expect(expired).not.toBeNull();
      for (const confirm of [false, true]) {
        const denied = await request('/auth/link', { key: expired!.key, confirm });
        expect(denied.status).toBe(400);
        expect(await denied.json() as Record<string, unknown>).toEqual({ error: 'owner_link_denied' });
      }
      const fresh = await issueIdentityLinkAuthority(e.db, 'mem_machine_1', now);
      expect(await (await request('/auth/link', { key: fresh!.key, confirm: true })).json()).toMatchObject({
        linked: true, member: { label: 'octocat' },
      });
      expect(await (await request('/auth/me')).json()).toMatchObject({ member: { label: 'octocat' }, owner: true, membership: { state: 'active' } });
      expect(await (await request('/auth/link', { key: expired!.key })).json() as Record<string, unknown>).toEqual({ error: 'link_denied' });
      e.sqlite.run("UPDATE members SET label = 'Chosen name' WHERE id = 'mem_machine_1'");
      expect(await (await request('/auth/me')).json()).toMatchObject({ member: { label: 'Chosen name' } });
    } finally { e.sqlite.close(); }
  });

  it('explains unconfigured sign-in on both routes, meters it and serves recovery words to a browser', async () => {
    const e = sqliteEnv();
    try {
      const server = createServer({ now: Date.now, sourceOf: () => '192.0.2.3', fetchImpl: () => { throw new Error('OAuth must not start'); } });
      const env = e.serverEnv;
      for (const path of ['/auth/me', '/auth/login']) {
        const response = await server.handleRequest(new Request('https://s' + path), env);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: 'sign_in_unconfigured', reason: expect.stringContaining('myco server github-app --url https://s') });
        expect(response.headers.get('location')).toBeNull();
      }
      const browser = await server.handleRequest(new Request('https://s/auth/login', { headers: { accept: 'text/html' } }), env);
      expect(browser.status).toBe(401);
      expect(browser.headers.get('content-type')).toContain('text/html');
      expect(await browser.text()).toContain('myco server github-app --url https://s');
      env.sourceLimit = { limit: async () => ({ success: false }) };
      expect((await server.handleRequest(new Request('https://s/auth/me'), env)).status).toBe(429);
    } finally { e.sqlite.close(); }
  });
});
