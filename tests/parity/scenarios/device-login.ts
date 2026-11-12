import { deviceLogin } from '@myco/cli/device-login.js';
import { expect } from 'bun:test';
import { ageRows, lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';
import { assignRole, browser, credentials, person, selectOwner, stopMember } from '../clients/identity.ts';

interface Started { device_code: string; user_code: string; interval: number; expires_in: number }

function post(target: ParityTarget, path: string, body: unknown, headers: Record<string, string> = { 'cf-connecting-ip': '1.2.3.4' }): Promise<Response> {
  return fetch(`${target.url}${path}`, { method: 'POST', headers: { ...headers, origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** Moves a pending request past the expiry its start answered, as a request nobody decided in time. */
async function expire(target: ParityTarget, machineId: string, device: Started): Promise<void> {
  await ageRows(target, { table: 'device_requests', column: 'expires_at', byMs: device.expires_in * 1000 + 1000, match: { machine_id: machineId } });
}

/** The same public and dashboard HTTP contract runs through the native entry and workerd with their own real stores. */
export const deviceLoginFlow: ParityScenario = {
  name: 'device login: start, pending, approval, single redemption, denial, expiry, slowdown and authority cap',
  dedicated: { timeoutMs: 240000 },
  async run(target) {
    await selectOwner(target);
    const member = await person(target, '168901', { login: 'device' });
    const admin = await person(target, '168902', { role: 'admin', login: 'device' });
    const memberHeaders = member.session;
    const adminHeaders = admin.session;
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
    const count = async () => (await credentials(target)).length;

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
    expect(joined).toMatchObject({ joined: true, memberId: member.id, role: 'member', projectId: null });
    expect(await count()).toBe(before + 1);
    expect(await poll(device)).toEqual({ error: 'invalid_grant' });
    expect((await decide(device)).status).toBe(409);
    expect((await decide(device, 'deny')).status).toBe(409);
    expect((await decide(device, 'preview')).status).toBe(409);

    const denied = await start();
    expect((await decide(denied, 'deny')).status).toBe(200);
    expect(await poll(denied)).toEqual({ error: 'access_denied' });
    expect((await decide(denied)).status).toBe(409);

    const expired = await start('expired_device');
    await expire(target, 'expired_device', expired);
    expect(await poll(expired)).toEqual({ error: 'expired_token' });
    expect((await decide(expired)).status).toBe(409);

    const slow = await start();
    expect(await poll(slow)).toEqual({ error: 'authorization_pending' });
    expect(await poll(slow)).toEqual({ error: 'slow_down', interval: 10 });
    expect(await poll(slow)).toEqual({ error: 'slow_down', interval: 15 });

    const capped = await start();
    expect((await decide(capped, 'approve', adminHeaders)).status).toBe(200);
    expect(await poll(capped)).toMatchObject({ joined: true, memberId: admin.id, role: 'admin' });
    expect((await post(target, '/api/device/approve', { user_code: capped.user_code, memberId: member.id }, adminHeaders)).status).toBe(400);
    const owner = await start();
    expect((await decide(owner, 'approve', target.ownerHeaders())).status).toBe(200);
    expect(await poll(owner)).toMatchObject({ joined: true, memberId: MEMBER_ID, role: 'admin' });

    // The owner approves a machine, then hands ownership to the admin, who demotes the former owner before the machine polls.
    const ownerVoided = await start();
    expect((await decide(ownerVoided, 'approve', target.ownerHeaders())).status).toBe(200);
    const ownership = await browser(target, '/api/ownership', target.ownerHeaders());
    expect((await browser(target, '/api/ownership/transfer', target.ownerHeaders(), { member_id: admin.id, expected_revision: ownership.body.revision })).status).toBe(200);
    expect((await assignRole(target, MEMBER_ID, 'member', adminHeaders)).status).toBe(200);
    expect(await poll(ownerVoided)).toEqual({ error: 'invalid_grant' });

    const output: string[] = [];
    let terminalSecret = '';
    let terminalCode = '';
    const terminal = await deviceLogin(target.url, { machineId: 'terminal_device', machineName: 'SSH machine', os: 'linux' }, {
      stdout: line => output.push(line),
      fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers); headers.set('cf-connecting-ip', '1.2.3.4');
        const response = await fetch(input, { ...init, headers });
        if (new URL(String(input)).pathname === '/auth/device/start') {
          const requested = await response.clone().json() as Started;
          terminalSecret = requested.device_code;
          terminalCode = requested.user_code;
          expect((await decide(requested)).status).toBe(200);
        }
        return response;
      }, { preconnect: fetch.preconnect }),
    });
    expect(terminal.ok).toBe(true);
    expect(output.join('\n')).toContain(`${target.url}/device?code=${encodeURIComponent(terminalCode)} on a machine`);
    expect(output.join('\n')).toContain(`Code: ${terminalCode}`);
    expect(output.join('\n')).not.toContain(terminalSecret);
    if (terminal.ok) expect(output.join('\n')).not.toContain(terminal.answer.token);

    const revoked = await start();
    expect((await decide(revoked)).status).toBe(200);
    await stopMember(target, member.id, adminHeaders);
    expect(await poll(revoked)).toEqual({ error: 'invalid_grant' });
    const runtime = target.runtime?.();
    if (runtime !== undefined) {
      expect(runtime.tail).not.toContain(device.device_code);
      expect(runtime.tail).not.toContain(joined.token as string);
    }
  },
};

/**
 * Admission and TTL reclamation run through each target's public routes, its own source identity and its wake. Bidi
 * metadata, decision audits and retention of decided requests are covered by `device.test.ts`.
 */
export const deviceAdmission: ParityScenario = {
  name: 'device login: bounded source admission and TTL reclaim',
  dedicated: { timeoutMs: 240000 },
  async run(target) {
    const request = { machineId: 'admission', machineName: 'Laptop', os: 'linux' };
    const first = await post(target, '/auth/device/start', request);
    expect(first.status).toBe(200);
    // An undecided request past its expiry is reclaimed by the wake: the row itself is gone, which no route reads.
    await expire(target, 'admission', await first.json() as Started);
    expect((await browser(target, '/api/wake', target.ownerHeaders(), {})).status).toBe(200);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM device_requests WHERE machine_id = ${lit('admission')}`)).toEqual([{ n: 0 }]);
    const starts = await Promise.all(Array.from({ length: 6 }, (_, i) => post(target, '/auth/device/start', { ...request, machineId: `admission_${i}` })));
    expect(starts.filter(response => response.status === 200)).toHaveLength(5);
    expect(starts.filter(response => response.status === 429)).toHaveLength(1);
    for (const response of starts.filter(response => response.status === 200)) {
      const started = await response.json() as Started;
      expect((await post(target, '/api/device/deny', { user_code: started.user_code }, target.ownerHeaders())).status).toBe(200);
    }
    // Five more starts fill the source's window of ten a minute, and the next is refused.
    for (let i = 0; i < 5; i++) {
      const response = await post(target, '/auth/device/start', { ...request, machineId: `rate_${i}` });
      expect(response.status).toBe(200);
      const next = await response.json() as Started;
      expect((await post(target, '/api/device/deny', { user_code: next.user_code }, target.ownerHeaders())).status).toBe(200);
    }
    expect((await post(target, '/auth/device/start', request)).status).toBe(429);
  },
};
