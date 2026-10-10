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
import { recordingPlatform } from '../helpers/fake-service-manager.js';

const SECRET = 'd'.repeat(43);
const CODE = 'BCDF-2345';
const START = { device_code: SECRET, user_code: CODE, expires_in: 600, interval: 5 };
const ANSWER = { joined: true, memberId: 'mem_device', token: 'test-machine-credential', tokenId: 'mt_device', expiresAt: Date.now() + 100000, role: 'member', projectId: null };

describe('terminal device sign-in', () => {
  for (const [status, error, code, words] of [
    [409, 'no_owner', 'no_owner', 'myco server setup-owner'],
    [429, 'limited', 'slow_down', 'Wait a minute'],
    [403, 'future_code', 'refused', 'refused to start'],
    [503, 'no_owner', 'unreachable', 'could not complete'],
  ] as const) {
    it(`decodes start refusal ${status}/${error} before announcing or polling`, async () => {
      let calls = 0;
      const lines: string[] = [];
      const result = await deviceLogin('https://s', { machineId: 'fresh', machineName: 'Laptop', os: 'linux' }, {
        stdout: line => lines.push(line), sleep: async () => { throw new Error('must not poll'); },
        fetch: async () => { calls++; return Response.json({ error }, { status }); },
      });
      expect(result).toMatchObject({ ok: false, code, reason: expect.stringContaining(words) });
      expect(calls).toBe(1);
      expect(lines).toEqual([]);
      if (status === 409) {
        const errors: string[] = [];
        expect(await run(['https://s', '--no-agents'], { machineId: 'fresh', hostname: () => 'Laptop',
          stderr: line => errors.push(line), stdout: line => lines.push(line),
          fetch: async () => Response.json({ error }, { status }),
        })).toBe(false);
        expect(errors).toEqual(['myco login: https://s has no owner yet, so nobody can approve this machine. Whoever created it finishes with myco server setup-owner on the machine that created it, then run myco login https://s again. (no_owner)']);
      }
    });
  }

  it('normalizes bare domain and IP:port to HTTPS, preserves loopback HTTP, and refuses public HTTP', () => {
    for (const [input, expected] of [
      ['myco.goondocks.co', 'https://myco.goondocks.co'], ['10.0.0.5:8080', 'https://10.0.0.5:8080'],
      ['localhost:8080', 'http://localhost:8080'], ['127.0.0.1:8080', 'http://127.0.0.1:8080'], ['[::1]:8080', 'http://[::1]:8080'], ['https://localhost:8080', 'https://localhost:8080'], ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
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
    expect(out.join('\n')).toContain(`https://s/device?code=${CODE} on a machine`);
    expect(out.join('\n')).toContain(`/device?code=${encodeURIComponent(CODE)}`);
    expect(out.join('\n')).not.toContain(SECRET);
    expect(out.join('\n')).not.toContain(ANSWER.token);
    for (const request of requests) {
      expect(request.url).not.toContain(SECRET);
      expect(request.method).toBe('POST');
      expect(request.redirect).toBe('error');
    }
    expect(await requests[1]!.json()).toEqual({ device_code: SECRET });
  });

  it('backs off on 429 and on slow_down without a server interval', async () => {
    for (const reply of [Response.json({ error: 'limited' }, { status: 429 }), Response.json({ error: 'slow_down' }, { status: 400 })]) {
      const sleeps: number[] = [];
      const replies = [Response.json(START), reply, Response.json({ error: 'authorization_pending' }, { status: 400 }), Response.json(ANSWER)];
      expect(await deviceLogin('https://s', { machineId: 'device', machineName: 'Laptop', os: 'linux' }, {
        stdout: () => {}, sleep: async ms => { sleeps.push(ms); }, fetch: async () => replies.shift()!,
      })).toMatchObject({ ok: true });
      expect(sleeps).toEqual([5000, 10000, 10000]);
    }
  });

  it('retries one transient polling transport or 5xx failure with backoff and stops after a second', async () => {
    for (const network of [true, false]) {
      for (const recover of [true, false]) {
        let calls = 0;
        let now = 0;
        const sleeps: number[] = [];
        expect(await deviceLogin('https://s', { machineId: 'device', machineName: 'Laptop', os: 'linux' }, {
          stdout: () => {}, clock: () => now, sleep: async ms => { sleeps.push(ms); now += ms; }, fetch: async () => {
            calls++;
            if (calls === 1) return Response.json(START);
            if (calls === 3 && recover) return Response.json(ANSWER);
            if (network) throw new Error(SECRET);
            return new Response(SECRET, { status: 503 });
          },
        })).toMatchObject(recover ? { ok: true } : { ok: false, code: 'unreachable' });
        expect(calls).toBe(3);
        expect(sleeps).toEqual([5000, 10000]);
      }
    }
  });

  it('explains expiry or prior use when a swept request returns invalid_grant', async () => {
    const replies = [Response.json(START), Response.json({ error: 'invalid_grant' }, { status: 400 })];
    expect(await deviceLogin('https://s', { machineId: 'device', machineName: 'Laptop', os: 'linux' }, {
      stdout: () => {}, sleep: async () => {}, fetch: async () => replies.shift()!,
    })).toEqual({ ok: false, code: 'invalid_grant', reason: 'sign-in has expired or was already used; run myco login again' });
  });

  it('reports denied, expired, malformed and network answers without reflecting server secrets', async () => {
    for (const response of [Response.json({ error: 'access_denied' }, { status: 400 }), Response.json({ error: 'expired_token' }, { status: 400 }), Response.json({ joined: true, token: SECRET }), new Response(SECRET, { status: 503 })]) {
      let started = false;
      let pollNow = 0;
      const result = await deviceLogin('https://s', { machineId: 'device', machineName: 'Laptop', os: 'linux' }, {
        stdout: () => {}, clock: () => pollNow, sleep: async ms => { pollNow += ms; }, fetch: async () => { if (!started) { started = true; return Response.json(START); } return response; },
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
    for (const address of ['myco.goondocks.co', '10.0.0.5:8080', 'http://127.0.0.1:8080', 'localhost:8080', 'https://s']) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-device-cli-'));
      const e = sqliteEnv();
      let now = Date.now();
      const serverUrl = normalizeMemberServerAddress(address)!.origin;
      e.sqlite.run("UPDATE members SET role = 'admin', github_id = '770001' WHERE id = 'mem_machine_2'");
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
            method: 'POST', headers: { origin: serverUrl, cookie: await ownerCookie(e.db, now, '770001') }, body: JSON.stringify({ user_code: started.user_code }),
          }), env);
          expect(approval.status).toBe(200);
        }
        return response;
      };
      try {
        const platform = recordingPlatform();
        expect(await run([address, '--no-agents', '--root', home], { mycoHome: home, cwd: home, machineId: 'cli_device', hostname: () => 'CLI laptop', os: () => 'linux',
          worker: { mycoHome: home, home, platform: 'darwin', binaryPath: path.join(home, 'bin', 'myco'), runner: platform.runner,
            detect: () => [{ id: 'codex', installed: true, authenticated: true }], admission: async () => 'admitted',
            ownDeploymentUrls: async () => [], harnessDirs: () => [], lockDir: path.join(home, 'locks') },
          fetch: fetchImpl, sleep: async ms => { now += ms; }, clock: () => now, stdout: line => out.push(line), stderr: line => err.push(line), agents: () => { throw new Error('no-agents must skip installer'); } })).toBe(true);
        expect(readDeploymentMembership(serverUrl, home)?.memberId).toBe('mem_machine_2');
        expect(readRegistryEntry(home, home)).toBeNull();
        expect(out.join('\n')).toContain(`Signed in to ${serverUrl} as octocat (admin)`);
        expect(err).toEqual([]);
        expect(platform.commands).toEqual([]);
        expect(out.join('\n')).not.toContain('a worker now runs');
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
