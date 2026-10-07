import { deviceLogin } from '@myco/cli/device-login.js';
import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { MEMBER_ID, SESSION_SECRET, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

interface Started { device_code: string; user_code: string; interval: number; expires_in: number }
const MEMBER = 'mem_device_parity';
const ADMIN = 'mem_device_admin';

async function cookie(sub: string): Promise<Record<string, string>> {
  const now = Date.now();
  return { cookie: `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { sub, login: 'device', iat: now, exp: now + 3600000 })}`, 'cf-connecting-ip': '1.2.3.4' };
}

function post(target: ParityTarget, path: string, body: unknown, headers: Record<string, string> = { 'cf-connecting-ip': '1.2.3.4' }): Promise<Response> {
  return fetch(`${target.url}${path}`, { method: 'POST', headers: { ...headers, origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** The same public and dashboard HTTP contract runs through the native entry and workerd with their own real stores. */
export const deviceLoginFlow: ParityScenario = {
  name: 'device login: start, pending, approval, single redemption, denial, expiry, slowdown and authority cap',
  dedicated: { timeoutMs: 240000 },
  async run(target) {
    const now = Date.now();
    await target.sql(`UPDATE deployment_ownership SET member_id = ${lit(MEMBER_ID)}, revision = revision + 1 WHERE id = 1`);
    await target.sql(`INSERT INTO members(id,label,role,github_id,created_at) VALUES
      (${lit(MEMBER)},'device member','member','168901',${now}), (${lit(ADMIN)},'device admin','admin','168902',${now})`);
    const memberHeaders = await cookie('168901');
    const adminHeaders = await cookie('168902');
    const start = async (machine = `device_${crypto.randomUUID()}`): Promise<Started> => {
      const response = await post(target, '/auth/device/start', { machineId: machine, machineName: 'Parity laptop', os: 'linux' });
      expect(response.status).toBe(200);
      return await response.json() as Started;
    };
    const poll = async (device: Started): Promise<Record<string, unknown>> => {
      const response = await post(target, '/auth/device/poll', { device_code: device.device_code });
      return await response.json() as Record<string, unknown>;
    };
    const decide = (device: Started, decision = 'approve', headers = memberHeaders) => post(target, `/api/device/${decision}`, { user_code: device.user_code }, headers);
    const count = async () => (await target.sql('SELECT COUNT(*) AS n FROM member_credentials'))[0]!.n;

    const device = await start('parity_login_machine');
    expect(device.interval).toBe(5);
    expect(device.expires_in).toBe(600);
    expect(await poll(device)).toEqual({ error: 'authorization_pending' });
    const previewResponse = await decide(device, 'preview');
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({ machineName: 'Parity laptop', os: 'linux', scope: 'membership', ip: target.name === 'cloudflare' ? '1.2.3.4' : '127.0.0.1' });
    expect((await post(target, '/api/device/approve', { user_code: device.user_code })).status).toBe(401);
    expect((await post(target, '/api/device/approve', { user_code: device.user_code }, { ...target.memberHeaders(), 'cf-connecting-ip': '1.2.3.4' })).status).toBe(401);
    expect((await fetch(`${target.url}/api/device/approve`, { method: 'POST',
      headers: { ...memberHeaders, origin: 'https://other.example', 'content-type': 'application/json' },
      body: JSON.stringify({ user_code: device.user_code }),
    })).status).toBe(403);
    const before = await count();
    expect(await (await decide(device)).json() as Record<string, unknown>).toEqual({ approved: true });
    const substituted = await post(target, '/members/join', { key: device.device_code, machineId: 'substituted_machine' });
    expect(await substituted.json()).toMatchObject({ joined: false, code: 'identity_claimed' });
    await Bun.sleep(5000);
    const joined = await poll(device);
    expect(joined).toMatchObject({ joined: true, memberId: MEMBER, role: 'member', projectId: null });
    expect(await count()).toBe(Number(before) + 1);
    expect(await poll(device)).toEqual({ error: 'invalid_grant' });
    expect((await decide(device)).status).toBe(409);
    expect((await decide(device, 'deny')).status).toBe(409);
    const stored = await target.sql("SELECT * FROM device_requests WHERE machine_id = 'parity_login_machine'");
    expect(stored[0]).toMatchObject({ decision: 'approved', decided_by: MEMBER });
    expect(typeof stored[0]!.decided_at).toBe('number');
    expect(JSON.stringify(stored)).not.toContain(device.device_code);
    expect(JSON.stringify(stored)).not.toContain(device.user_code);

    const denied = await start();
    expect((await decide(denied, 'deny')).status).toBe(200);
    expect(await poll(denied)).toEqual({ error: 'access_denied' });
    expect((await decide(denied)).status).toBe(409);

    const expired = await start('expired_device');
    await target.sql("UPDATE device_requests SET expires_at = 0 WHERE machine_id = 'expired_device'");
    expect(await poll(expired)).toEqual({ error: 'expired_token' });
    expect((await decide(expired)).status).toBe(409);

    const slow = await start();
    expect(await poll(slow)).toEqual({ error: 'authorization_pending' });
    expect(await poll(slow)).toEqual({ error: 'slow_down', interval: 10 });
    expect(await poll(slow)).toEqual({ error: 'slow_down', interval: 15 });

    const capped = await start();
    expect((await decide(capped, 'approve', adminHeaders)).status).toBe(404);
    expect(await poll(capped)).toEqual({ error: 'authorization_pending' });
    const owner = await start();
    expect((await decide(owner, 'approve', target.ownerHeaders())).status).toBe(200);
    expect(await poll(owner)).toMatchObject({ joined: true, memberId: MEMBER_ID, role: 'admin' });

    const ownerVoided = await start();
    expect((await decide(ownerVoided, 'approve', target.ownerHeaders())).status).toBe(200);
    await target.sql(`UPDATE deployment_ownership SET member_id = ${lit(ADMIN)}, revision = revision + 1 WHERE id = 1`);
    expect(await poll(ownerVoided)).toEqual({ error: 'invalid_grant' });

    const output: string[] = [];
    let terminalSecret = '';
    const terminal = await deviceLogin(target.url, { machineId: 'terminal_device', machineName: 'SSH machine', os: 'linux' }, {
      stdout: line => output.push(line),
      fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers); headers.set('cf-connecting-ip', '1.2.3.4');
        const response = await fetch(input, { ...init, headers });
        if (new URL(String(input)).pathname === '/auth/device/start') {
          const requested = await response.clone().json() as Started;
          terminalSecret = requested.device_code;
          expect((await decide(requested)).status).toBe(200);
        }
        return response;
      }, { preconnect: fetch.preconnect }),
    });
    expect(terminal.ok).toBe(true);
    expect(output.join('\n')).toContain(`${target.url}/device?code=`);
    expect(output.join('\n')).not.toContain(terminalSecret);
    if (terminal.ok) expect(output.join('\n')).not.toContain(terminal.answer.token);

    const revoked = await start();
    expect((await decide(revoked)).status).toBe(200);
    await target.sql(`UPDATE members SET revoked_at = ${now} WHERE id = ${lit(MEMBER)}`);
    expect(await poll(revoked)).toEqual({ error: 'invalid_grant' });
    const runtime = target.runtime?.();
    if (runtime !== undefined) {
      expect(runtime.tail).not.toContain(device.device_code);
      expect(runtime.tail).not.toContain(joined.token as string);
    }
  },
};
