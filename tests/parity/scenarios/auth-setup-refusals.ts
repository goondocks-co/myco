import { expect } from 'bun:test';
import { serve } from '@myco-server-worker/entry/bun.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { MEMBER_ID, SESSION_SECRET, lit, type ParityScenario } from '../harness.ts';

/** Fresh-owner recovery uses the same HTTP contract on native SQLite and local D1. */
export const authSetupRefusals: ParityScenario = {
  name: 'auth setup: no owner, unclaimed, expired owner link and unconfigured sign-in',
  dedicated: { cloudflare: { main: '../../tests/parity/owner-review/sign-in-unconfigured.ts' }, timeoutMs: 240000 },
  async run(target) {
    const headers = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const post = (path: string, body: unknown) => fetch(target.url + path, { method: 'POST', headers, body: JSON.stringify(body) });
    await target.sql('UPDATE members SET github_id = NULL');
    for (const runner of [false, true]) {
      const response = await post(`/auth/${runner ? 'runner' : 'device'}/start`, {
        machineId: 'unclaimed_machine', machineName: 'Laptop', os: 'linux',
        ...(runner ? { name: 'box', candidate: 'mycorun_' + 'r'.repeat(43) } : {}),
      });
      expect(response.status).toBe(409);
      expect(await response.json() as Record<string, unknown>).toEqual({ error: 'no_owner' });
    }
    expect(await target.sql('SELECT COUNT(*) AS n FROM device_requests')).toEqual([{ n: 0 }]);
    expect(await (await fetch(target.url + '/auth/me', { headers })).json()).toMatchObject({ member: null, membership: { state: 'unclaimed' } });
    for (const confirm of [false, true]) {
      const response = await post('/auth/link', { key: 'x'.repeat(43), confirm });
      expect(response.status).toBe(400);
      expect(await response.json() as Record<string, unknown>).toEqual({ error: 'owner_link_denied' });
    }
    await target.sql(`UPDATE members SET github_id = '424242' WHERE id = ${lit(MEMBER_ID)}`);
    expect(await (await post('/auth/link', { key: 'x'.repeat(43) })).json() as Record<string, unknown>).toEqual({ error: 'link_denied' });
    const start = await post('/auth/device/start', { machineId: 'claimed_machine', machineName: 'Laptop', os: 'linux' });
    expect(start.status).toBe(200);
    const grant = await start.json() as { user_code: string; device_code: string; verification_uri: string; verification_uri_complete: string };
    expect(grant.verification_uri).toBe(target.url + '/device');
    expect(grant.verification_uri_complete).toBe(`${target.url}/device?code=${grant.user_code}`);
    await target.sql(`UPDATE deployment_ownership SET member_id = ${lit(MEMBER_ID)}, revision = revision + 1 WHERE id = 1`);
    expect((await post('/api/device/approve', { user_code: grant.user_code })).status).toBe(200);
    const joined = await post('/auth/device/poll', { device_code: grant.device_code });
    expect(await joined.json()).toMatchObject({ joined: true, memberId: MEMBER_ID, memberLabel: 'parity', owner: true });
    const sub = '900009';
    await target.sql(`INSERT INTO members(id,label,role,github_id,created_at) VALUES ('mem_named_admin','Named admin','admin','${sub}',0)`);
    const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub, login: 'named-admin', iat: Date.now(), exp: Date.now() + 60000 })}`;
    const next = await (await post('/auth/device/start', { machineId: 'admin_machine', machineName: 'Laptop', os: 'linux' })).json() as { user_code: string; device_code: string };
    expect((await fetch(target.url + '/api/device/approve', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_code: next.user_code }) })).status).toBe(200);
    expect(await (await post('/auth/device/poll', { device_code: next.device_code })).json()).toMatchObject({ memberLabel: 'named-admin', owner: false, role: 'admin' });

    await target.sql('CREATE TABLE naming_writes (n INTEGER)');
    await target.sql("CREATE TRIGGER record_login_insert AFTER INSERT ON schema_meta WHEN NEW.key LIKE 'github_login:%' BEGIN INSERT INTO naming_writes VALUES (1); END");
    await target.sql("CREATE TRIGGER record_login_update AFTER UPDATE ON schema_meta WHEN NEW.key LIKE 'github_login:%' BEGIN INSERT INTO naming_writes VALUES (1); END");
    for (let n = 0; n < 2; n++) {
      expect((await fetch(target.url + '/auth/me', { headers: { ...headers, cookie } })).status).toBe(200);
    }
    expect(await target.sql('SELECT COUNT(*) AS n FROM naming_writes')).toEqual([{ n: 0 }]);

    await target.sql("CREATE TRIGGER fail_naming BEFORE UPDATE OF label ON members BEGIN SELECT RAISE(FAIL, 'naming unavailable'); END");
    try {
      await target.sql("DELETE FROM schema_meta WHERE key = 'github_login:424242'");
      const pending = await (await post('/auth/device/start', { machineId: 'naming_failure', machineName: 'Laptop', os: 'linux' })).json() as { user_code: string; device_code: string };
      expect((await post('/api/device/approve', { user_code: pending.user_code })).status).toBe(200);
      expect(await (await post('/auth/device/poll', { device_code: pending.device_code })).json()).toMatchObject({ joined: true, memberId: MEMBER_ID });

      await target.sql("INSERT INTO members(id,label,role,created_at) VALUES ('mem_courtesy_link',NULL,'member',0)");
      const link = await post('/api/members/mem_courtesy_link/link-github', {});
      expect(link.status).toBe(201);
      const { key } = await link.json() as { key: string };
      const linkCookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub: '900010', login: 'new-member', iat: Date.now(), exp: Date.now() + 60000 })}`;
      const linked = await fetch(target.url + '/auth/link', { method: 'POST', headers: { ...headers, cookie: linkCookie }, body: JSON.stringify({ key, confirm: true }) });
      expect(linked.status).toBe(200);
      expect(await linked.json()).toMatchObject({ linked: true, member: { id: 'mem_courtesy_link', label: null } });
    } finally { await target.sql('DROP TRIGGER fail_naming'); }
    expect(await target.sql("SELECT value FROM schema_meta WHERE key = 'github_login:900009'")).toEqual([{ value: 'named-admin' }]);
    expect((await post('/api/members/mem_named_admin/revoke', {})).status).toBe(200);
    expect(await target.sql("SELECT value FROM schema_meta WHERE key = 'github_login:900009'")).toEqual([]);

    const native = target.name === 'selfhosted' ? await serve({
      databasePath: target.bindings.database, blobDir: target.bindings.blob, port: 0,
      bind: 'loopback', transport: 'loopback', sourceFrom: 'socket', wakeLoop: false,
      originOf: port => `http://127.0.0.1:${port}`,
    }) : null;
    try {
      const url = native === null ? target.url : `http://127.0.0.1:${native.port}`;
      for (const path of ['/auth/me', '/auth/login']) {
        const response = await fetch(url + path, { headers: { 'cf-connecting-ip': '1.2.3.4', 'x-test-sign-in-unconfigured': '1' }, redirect: 'manual' });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: 'sign_in_unconfigured', reason: expect.stringContaining(`myco server github-app --url ${url}`) });
        expect(response.headers.get('location')).toBeNull();
      }
    } finally { await native?.stop(); }
  },
};
