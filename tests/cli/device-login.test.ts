import { describe, expect, it } from 'bun:test';
import { deviceLogin } from '@myco/cli/device-login.js';
import { normalizeMemberServerAddress } from '@myco/member/server-url.js';
import { run } from '@myco/cli/login.js';
import { readDeploymentMembership, readRegistryEntry } from '@myco/member/registry.js';
import { OWNER_ENV, ownerCookie } from '../myco-server/helpers/owner.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'd'.repeat(43);
const CODE = 'BCDF-2345';
const START = { device_code: SECRET, user_code: CODE, expires_in: 600, interval: 5 };
const ANSWER = { joined: true, memberId: 'mem_device', token: 'test-machine-credential', tokenId: 'mt_device', expiresAt: Date.now() + 100000, role: 'member', projectId: null };

describe('terminal device sign-in', () => {
  it('normalizes bare domain and IP:port to HTTPS, preserves loopback HTTP, and refuses public HTTP', () => {
    for (const [input, expected] of [
      ['myco.goondocks.co', 'https://myco.goondocks.co'], ['10.0.0.5:8080', 'https://10.0.0.5:8080'],
      ['localhost:8080', 'https://localhost:8080'], ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
      ['http://[::1]:8080', 'http://[::1]:8080'], ['https://myco.goondocks.co', 'https://myco.goondocks.co'],
    ]) expect(normalizeMemberServerAddress(input)?.origin).toBe(expected);
    for (const input of ['http://myco.goondocks.co', 'http://10.0.0.5:8080', 'ftp://s', 'https://user:password@s', '', 'two hosts']) expect(normalizeMemberServerAddress(input)).toBeNull();
  });

  it('prints only URL and human code, carries secrets in POST bodies, and persists slow_down in later polls', async () => {
    const out: string[] = [];
    const sleeps: number[] = [];
    const requests: Request[] = [];
    const replies = [Response.json(START), Response.json({ error: 'authorization_pending' }, { status: 400 }), Response.json({ error: 'slow_down', interval: 10 }, { status: 400 }), Response.json(ANSWER)];
    const fetchImpl: typeof fetch = async (input, init) => { requests.push(new Request(input, init)); return replies.shift()!; };
    expect(await deviceLogin('https://s', { machineId: 'device', machineName: 'Laptop', os: 'linux' }, {
      fetch: fetchImpl, stdout: line => out.push(line), sleep: async ms => { sleeps.push(ms); },
    })).toMatchObject({ ok: true, answer: ANSWER });
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(out.join('\n')).toContain('https://s/device?code=BCDF-2345');
    expect(out.join('\n')).not.toContain(SECRET);
    expect(out.join('\n')).not.toContain(ANSWER.token);
    for (const request of requests) {
      expect(request.url).not.toContain(SECRET);
      expect(request.method).toBe('POST');
      expect(request.redirect).toBe('error');
    }
    expect(await requests[1]!.json()).toEqual({ device_code: SECRET });
  });

  it('reports denied, expired, malformed and network answers without reflecting server secrets', async () => {
    for (const response of [Response.json({ error: 'access_denied' }, { status: 400 }), Response.json({ error: 'expired_token' }, { status: 400 }), Response.json({ joined: true, token: SECRET }), new Response(SECRET, { status: 503 })]) {
      let started = false;
      const result = await deviceLogin('https://s', { machineId: 'device', machineName: 'Laptop', os: 'linux' }, {
        stdout: () => {}, sleep: async () => {}, fetch: async () => { if (!started) { started = true; return Response.json(START); } return response; },
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    let now = 0;
    for (const reply of [new Response(SECRET), Response.json(null)]) {
      expect(await deviceLogin('https://s', { machineId: 'device', machineName: 'Laptop', os: 'linux' }, {
        stdout: () => {}, fetch: async () => reply,
      })).toMatchObject({ ok: false, code: 'unreadable' });
    }
    expect(await deviceLogin('https://s', { machineId: 'device', machineName: 'Laptop', os: 'linux' }, {
      stdout: () => {}, fetch: async () => { throw new Error(SECRET); },
    })).toMatchObject({ ok: false, code: 'unreachable', reason: 'could not complete sign-in with the Deployment' });
    expect(await deviceLogin('https://s', { machineId: 'device', machineName: 'Laptop', os: 'linux' }, {
      stdout: () => {}, clock: () => now, sleep: async ms => { now += ms; }, fetch: async () => Response.json({ ...START, expires_in: 5 }),
    })).toMatchObject({ ok: false, code: 'expired_token' });
  });

  it('myco login bare hosts and loopback URL complete the real server path with --no-agents and --root', async () => {
    for (const address of ['myco.goondocks.co', '10.0.0.5:8080', 'http://127.0.0.1:8080', 'https://s']) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-device-cli-'));
      const e = sqliteEnv();
      let now = Date.now();
      const serverUrl = normalizeMemberServerAddress(address)!.origin;
      e.sqlite.run("UPDATE members SET role = 'member', github_id = '770001' WHERE id = 'mem_machine_2'");
      const server = createServer({ now: () => now, sourceOf: () => '192.0.2.10', fetchImpl: () => { throw new Error('unexpected OAuth'); } });
      const env = { ...e.serverEnv, secrets: OWNER_ENV };
      const out: string[] = [];
      const err: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const response = await server.handleRequest(request, env);
        if (new URL(request.url).pathname === '/auth/device/start') {
          const started = await response.clone().json() as { user_code: string };
          const approval = await server.handleRequest(new Request(`${serverUrl}/api/device/approve`, {
            method: 'POST', headers: { origin: serverUrl, cookie: await ownerCookie(now, '770001') }, body: JSON.stringify({ user_code: started.user_code }),
          }), env);
          expect(approval.status).toBe(200);
        }
        return response;
      };
      try {
        expect(await run([address, '--no-agents', '--root', home], { mycoHome: home, cwd: home, machineId: 'cli_device', hostname: () => 'CLI laptop', os: () => 'linux',
          fetch: fetchImpl, sleep: async ms => { now += ms; }, clock: () => now, stdout: line => out.push(line), stderr: line => err.push(line), agents: () => { throw new Error('no-agents must skip installer'); } })).toBe(true);
        expect(readDeploymentMembership(serverUrl, home)?.memberId).toBe('mem_machine_2');
        expect(readRegistryEntry(home, home)).toBeNull();
        expect(out.join('\n')).toContain(`Signed in to ${serverUrl}`);
        expect(err).toEqual([]);
      } finally { e.sqlite.close(); fs.rmSync(home, { recursive: true, force: true }); }
    }
  });

  it('myco login refuses public HTTP before any network call or credential write', async () => {
    let dialed = false;
    const error: string[] = [];
    expect(await run(['http://public.example'], { stderr: line => error.push(line), fetch: async () => { dialed = true; throw new Error('unexpected'); } })).toBe(false);
    expect(dialed).toBe(false);
    expect(error.join('\n')).toContain('loopback');
  });
});
