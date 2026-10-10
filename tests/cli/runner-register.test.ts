/**
 * `myco runner register` — what a person sees and what lands on disk.
 *
 * The runner bearer is minted here and written to the pending record before the
 * Deployment hears of it; the Deployment's approval is the commit; a poll reply
 * lost after approval is recovered by presenting the bearer to the contact route.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/runner.js';
import { closureOf, moduleKey, REPO_ROOT } from '../helpers/import-closure.js';
import { readRunnerRecord, runnerDir, runnerRecordPath, stagePending, withRunnerLock, publishRunnerRecord, RUNNER_RECORD_VERSION } from '@myco/runner/runner-registry.js';

const SERVER = 'https://myco.example.com';
const DEVICE = 'd'.repeat(43);
const CODE = 'BCDF-2345';
const START = { device_code: DEVICE, user_code: CODE, expires_in: 600, interval: 5 };
const BEARER = /^mycorun_[A-Za-z0-9_-]{43}$/;
const NAME = 'box-1';
const OLD_BEARER = `mycorun_${'o'.repeat(43)}`;
const NOW = 1_800_000_000_000;

interface Call { path: string; body: Record<string, unknown>; authorization: string | null }

describe('myco runner register', () => {
  let home: string;
  let out: string[];
  let err: string[];
  let calls: Call[];

  for (const [status, error, words] of [[409, 'no_owner', 'myco server setup-owner'], [403, 'not_admin', 'owner or an admin'], [429, 'limited', 'Wait a minute'], [400, 'unknown', 'refused to start']] as const) {
    it(`explains start refusal ${error} without polling`, async () => {
      const exit = await run(['register', SERVER, '--name', NAME], {
        mycoHome: home, hostname: () => 'Laptop', machineId: 'new_runner', stdout: line => out.push(line), stderr: line => err.push(line),
        fetch: async (input) => { calls.push({ path: new URL(String(input)).pathname, body: {}, authorization: null }); return Response.json({ error }, { status }); },
      });
      expect(exit).toBe(false);
      expect(err.join(' ')).toContain(words);
      if (error === 'no_owner') expect(err.join(' ').match(/\(no_owner\)/g)).toHaveLength(1);
      expect(calls.map(call => call.path)).toEqual(['/auth/runner/start']);
    });
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-register-'));
    out = [];
    err = [];
    calls = [];
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  const serverRoutes = (handler: (call: Call) => Response | Promise<Response>): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const call = { path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown>, authorization: request.headers.get('authorization') };
      calls.push(call);
      return handler(call);
    }) as typeof fetch;

  const deps = (fetchImpl: typeof fetch) => ({
    fetch: fetchImpl, mycoHome: home, machineId: 'machine_box', hostname: () => 'box.local', os: () => 'linux',
    now: () => NOW, sleep: async () => {}, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l),
  });
  const registered = (candidate: string) => Response.json({ registered: true, runnerId: 'run_1', name: NAME, deploymentId: 'dep_1' }, { headers: { 'x-candidate': candidate } });
  const contactAnswer = Response.json({
    persisted: true, runner: { id: 'run_1', name: NAME, state: 'enabled', deploymentId: 'dep_1' },
    credential: { id: 'rc_1', expiresAt: NOW + 7 * 86_400_000, refreshAfter: NOW + 5 * 86_400_000 }, heartbeatMs: 30_000, pollIdleMs: 2_000,
  });
  const callsTo = (route: string): Call[] => calls.filter((c) => c.path === route);

  it('prints the link, the code and the runner name, then publishes the record once approved', async () => {
    let polls = 0;
    const fetchImpl = serverRoutes((call) => {
      if (call.path === '/auth/runner/start') return Response.json(START);
      polls += 1;
      return polls === 1 ? Response.json({ error: 'authorization_pending' }, { status: 400 }) : registered(String(callsTo('/auth/runner/start')[0]!.body.candidate));
    });
    expect(await run(['register', 'myco.example.com', '--name', NAME], deps(fetchImpl))).toBe(true);

    const start = callsTo('/auth/runner/start')[0]!.body;
    expect(start).toMatchObject({ name: NAME, machineId: 'machine_box', machineName: 'box.local', os: 'linux' });
    expect(start.candidate).toMatch(BEARER);
    expect(callsTo('/auth/runner/poll')[0]!.body).toEqual({ device_code: DEVICE });

    const text = out.join('\n');
    expect(text).toContain(`Open ${SERVER}/device?code=${encodeURIComponent(CODE)}`);
    expect(text).toContain(`Code: ${CODE}`);
    expect(text).toContain(`Register a runner named ${NAME}`);
    expect(text).toContain(`myco runner run --server ${SERVER}`);
    expect(text).not.toContain(String(start.candidate));
    expect(text).not.toContain(DEVICE);

    const record = readRunnerRecord(SERVER, home)!;
    expect(record).toMatchObject({ version: RUNNER_RECORD_VERSION, serverUrl: SERVER, runnerId: 'run_1', name: NAME, deploymentId: 'dep_1', token: start.candidate });
    expect(record.pending).toBeUndefined();
    expect(fs.statSync(runnerRecordPath(SERVER, home)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(runnerDir(SERVER, home)).mode & 0o777).toBe(0o700);
  });

  it('opens no browser and reaches nothing of the member, login or service machinery', () => {
    const closure = closureOf([path.join(REPO_ROOT, 'packages/myco/src/cli/runner.ts')]);
    const reached = [...closure.modules.keys()];
    const forbidden = [/open-browser/, /cli\/open\.ts$/, /symbionts\/installer/, /cli\/login\.ts$/];
    for (const pattern of forbidden) expect(reached.filter((key) => pattern.test(key))).toEqual([]);
    for (const key of reached) {
      const source = fs.readFileSync(closure.modules.get(key)!, 'utf-8');
      expect(source.includes('openBrowser')).toBe(false);
    }
    expect(reached).toContain(moduleKey(path.join(REPO_ROOT, 'packages/myco/src/runner/runner-registry.ts')));
  });

  it('writes the candidate to pending storage before /auth/runner/start is called', async () => {
    let heldAtStart: ReturnType<typeof readRunnerRecord> = null;
    const fetchImpl = serverRoutes((call) => {
      if (call.path === '/auth/runner/start') {
        heldAtStart = readRunnerRecord(SERVER, home);
        return Response.json(START);
      }
      return registered('');
    });
    expect(await run(['register', SERVER, '--name', NAME], deps(fetchImpl))).toBe(true);
    const candidate = callsTo('/auth/runner/start')[0]!.body.candidate;
    expect(heldAtStart!.pending).toMatchObject({ kind: 'register', candidate });
    expect(heldAtStart!.token).toBeUndefined();
  });

  it('keeps the device grant with the pending candidate once the Deployment has issued it', async () => {
    let heldAtPoll: ReturnType<typeof readRunnerRecord> = null;
    const fetchImpl = serverRoutes((call) => {
      if (call.path === '/auth/runner/start') return Response.json(START);
      heldAtPoll = readRunnerRecord(SERVER, home);
      return registered('');
    });
    expect(await run(['register', SERVER, '--name', NAME], deps(fetchImpl))).toBe(true);
    expect(heldAtPoll!.pending).toMatchObject({ kind: 'register', deviceCode: DEVICE, userCode: CODE, pollIntervalSeconds: 5, deviceExpiresAt: NOW + 600_000 });
  });

  it('recovers a poll reply lost after approval by presenting the candidate to /runners/contact', async () => {
    const fetchImpl = serverRoutes((call) => {
      if (call.path === '/auth/runner/start') return Response.json(START);
      if (call.path === '/auth/runner/poll') throw new TypeError('connection lost');
      return contactAnswer.clone();
    });
    expect(await run(['register', SERVER, '--name', NAME], deps(fetchImpl))).toBe(true);
    const candidate = String(callsTo('/auth/runner/start')[0]!.body.candidate);
    const contact = callsTo('/runners/contact');
    expect(contact).toHaveLength(1);
    expect(contact[0]!.authorization).toBe(`Bearer ${candidate}`);
    const record = readRunnerRecord(SERVER, home)!;
    expect(record).toMatchObject({ runnerId: 'run_1', name: NAME, token: candidate, tokenId: 'rc_1', refreshAfter: NOW + 5 * 86_400_000 });
    expect(record.pending).toBeUndefined();
  });

  it('keeps the pending candidate when neither the poll nor the contact can be completed', async () => {
    const fetchImpl = serverRoutes((call) => {
      if (call.path === '/auth/runner/start') return Response.json(START);
      throw new TypeError('connection lost');
    });
    expect(await run(['register', SERVER, '--name', NAME], deps(fetchImpl))).toBe(false);
    expect(readRunnerRecord(SERVER, home)!.pending).toMatchObject({ kind: 'register', candidate: callsTo('/auth/runner/start')[0]!.body.candidate });
    expect(err.join('\n')).toContain('again');
  });

  it('settles an earlier registration through the contact route when run again', async () => {
    const candidate = `mycorun_${'p'.repeat(43)}`;
    await withRunnerLock(SERVER, (lock) => stagePending(lock, { kind: 'register', candidate, startedAt: NOW - 1000 }, NAME), home);
    const fetchImpl = serverRoutes(() => contactAnswer.clone());
    expect(await run(['register', SERVER], deps(fetchImpl))).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(['/runners/contact']);
    expect(readRunnerRecord(SERVER, home)).toMatchObject({ token: candidate, runnerId: 'run_1' });
  });

  it('keeps polling the earlier device grant when the contact says the registration has not committed', async () => {
    const candidate = `mycorun_${'q'.repeat(43)}`;
    await withRunnerLock(SERVER, (lock) => stagePending(lock, {
      kind: 'register', candidate, startedAt: NOW - 1000, deviceCode: DEVICE, userCode: CODE, deviceExpiresAt: NOW + 300_000, pollIntervalSeconds: 5,
    }, NAME), home);
    const fetchImpl = serverRoutes((call) => (call.path === '/runners/contact' ? new Response('{}', { status: 401 }) : registered(candidate)));
    expect(await run(['register', SERVER], deps(fetchImpl))).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(['/runners/contact', '/auth/runner/poll']);
    expect(callsTo('/auth/runner/poll')[0]!.body).toEqual({ device_code: DEVICE });
    expect(out.join('\n')).toContain(`Code: ${CODE}`);
    expect(readRunnerRecord(SERVER, home)).toMatchObject({ token: candidate });
  });

  it('starts over with a fresh candidate when the earlier device grant has lapsed', async () => {
    const stale = `mycorun_${'s'.repeat(43)}`;
    await withRunnerLock(SERVER, (lock) => stagePending(lock, {
      kind: 'register', candidate: stale, startedAt: NOW - 900_000, deviceCode: DEVICE, userCode: CODE, deviceExpiresAt: NOW - 1, pollIntervalSeconds: 5,
    }, NAME), home);
    const fetchImpl = serverRoutes((call) => {
      if (call.path === '/runners/contact') return new Response('{}', { status: 401 });
      if (call.path === '/auth/runner/start') return Response.json(START);
      return registered('');
    });
    expect(await run(['register', SERVER, '--name', 'box-2'], deps(fetchImpl))).toBe(true);
    const fresh = String(callsTo('/auth/runner/start')[0]!.body.candidate);
    expect(fresh).toMatch(BEARER);
    expect(fresh).not.toBe(stale);
    expect(readRunnerRecord(SERVER, home)).toMatchObject({ token: fresh });
  });

  it('forgets the pending candidate when the dashboard denies the registration', async () => {
    const fetchImpl = serverRoutes((call) => (call.path === '/auth/runner/start' ? Response.json(START) : Response.json({ error: 'access_denied' }, { status: 400 })));
    expect(await run(['register', SERVER, '--name', NAME], deps(fetchImpl))).toBe(false);
    expect(err.join('\n')).toContain('denied');
    expect(readRunnerRecord(SERVER, home)).toBeNull();
  });

  it('refuses plain http to a host that is not loopback, before any request', async () => {
    const fetchImpl = serverRoutes(() => Response.json(START));
    expect(await run(['register', 'http://myco.example.com'], deps(fetchImpl))).toBe(false);
    expect(err.join('\n')).toContain('https');
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(home, 'runner'))).toBe(false);
  });

  it('accepts plain http on loopback', async () => {
    const fetchImpl = serverRoutes((call) => (call.path === '/auth/runner/start' ? Response.json(START) : registered('')));
    expect(await run(['register', 'localhost:8080', '--name', NAME], deps(fetchImpl))).toBe(true);
    expect(readRunnerRecord('http://localhost:8080', home)).toMatchObject({ serverUrl: 'http://localhost:8080' });
  });

  it('refuses to register over a runner it already holds, naming it', async () => {
    await withRunnerLock(SERVER, (lock) => publishRunnerRecord(lock, { version: RUNNER_RECORD_VERSION, serverUrl: SERVER, name: 'earlier', runnerId: 'run_0', token: OLD_BEARER }), home);
    const fetchImpl = serverRoutes(() => Response.json(START));
    expect(await run(['register', SERVER], deps(fetchImpl))).toBe(false);
    expect(err.join('\n')).toContain('already registered');
    expect(err.join('\n')).toContain('earlier');
    expect(calls).toEqual([]);
    expect(readRunnerRecord(SERVER, home)!.token).toBe(OLD_BEARER);
  });

  describe('--replace keeps the acknowledged credential until the replacement commits', () => {
    const acknowledged = () => withRunnerLock(SERVER, (lock) => publishRunnerRecord(lock, {
      version: RUNNER_RECORD_VERSION, serverUrl: SERVER, name: 'earlier', deploymentId: 'dep_0', runnerId: 'run_0', token: OLD_BEARER,
    }), home);

    it('keeps it when the Deployment cannot be reached, staging the replacement beside it', async () => {
      await acknowledged();
      const offline = (async () => { throw new Error('offline'); }) as typeof fetch;
      expect(await run(['register', SERVER, '--name', 'earlier', '--replace'], deps(offline))).toBe(false);
      const record = readRunnerRecord(SERVER, home)!;
      expect(record).toMatchObject({ token: OLD_BEARER, runnerId: 'run_0', name: 'earlier' });
      expect(record.pending).toMatchObject({ kind: 'register', name: 'earlier', replace: true });
      expect(err.join('\n')).toContain('--name earlier --replace');
    });

    it('keeps it, and drops the staged replacement, when the approval is denied', async () => {
      await acknowledged();
      const fetchImpl = serverRoutes((call) => (call.path === '/auth/runner/start' ? Response.json(START) : Response.json({ error: 'access_denied' }, { status: 400 })));
      expect(await run(['register', SERVER, '--name', 'earlier', '--replace'], deps(fetchImpl))).toBe(false);
      const record = readRunnerRecord(SERVER, home)!;
      expect(record).toMatchObject({ token: OLD_BEARER, runnerId: 'run_0', name: 'earlier' });
      expect(record.pending).toBeUndefined();
    });

    it('holds both while the approval is outstanding, so an interruption leaves a usable credential', async () => {
      await acknowledged();
      let during: ReturnType<typeof readRunnerRecord> = null;
      const fetchImpl = serverRoutes((call) => {
        if (call.path === '/auth/runner/start') return Response.json(START);
        during = readRunnerRecord(SERVER, home);
        return registered(String(callsTo('/auth/runner/start')[0]!.body.candidate));
      });
      expect(await run(['register', SERVER, '--name', 'earlier', '--replace'], deps(fetchImpl))).toBe(true);
      expect(during).toMatchObject({ token: OLD_BEARER, pending: { kind: 'register', name: 'earlier', deviceCode: DEVICE } });
      const candidate = String(callsTo('/auth/runner/start')[0]!.body.candidate);
      expect(readRunnerRecord(SERVER, home)).toMatchObject({ token: candidate, runnerId: 'run_1', name: NAME });
      expect(readRunnerRecord(SERVER, home)!.pending).toBeUndefined();
      expect(callsTo('/auth/runner/start')[0]!.body).toMatchObject({ replace: true, runnerId: 'run_0', name: 'earlier' });
      expect(out.join('\n')).toContain('replace registration for earlier');
      expect(out.join('\n')).toContain('keeps the same machine and history');
    });

    it('binds the known identity when using its new dashboard name', async () => {
      await acknowledged();
      const fetchImpl = serverRoutes(call => call.path === '/auth/runner/start'
        ? Response.json(START) : Response.json({ registered: true, runnerId: 'run_0', name: 'renamed', deploymentId: 'dep_0' }));
      expect(await run(['register', SERVER, '--name', 'renamed', '--replace'], deps(fetchImpl))).toBe(true);
      expect(callsTo('/auth/runner/start')[0]!.body).toMatchObject({ replace: true, runnerId: 'run_0', name: 'renamed' });
      expect(readRunnerRecord(SERVER, home)).toMatchObject({ runnerId: 'run_0', name: 'renamed' });
    });

    it('settles then replaces an uncommitted request made before a dashboard rename', async () => {
      await acknowledged();
      const stale = `mycorun_${'s'.repeat(43)}`;
      await withRunnerLock(SERVER, lock => stagePending(lock, {
        kind: 'register', replace: true, name: 'earlier', candidate: stale, startedAt: NOW - 1000,
        deviceCode: DEVICE, userCode: CODE, deviceExpiresAt: NOW + 300_000, pollIntervalSeconds: 5,
      }, 'earlier'), home);
      const fetchImpl = serverRoutes(call => {
        if (call.path === '/runners/contact') return new Response('{}', { status: 401 });
        if (call.path === '/auth/runner/start') return Response.json(START);
        return Response.json({ registered: true, runnerId: 'run_0', name: 'renamed', deploymentId: 'dep_0' });
      });
      expect(await run(['register', SERVER, '--name', 'renamed', '--replace'], deps(fetchImpl))).toBe(true);
      expect(calls.map(call => call.path)).toEqual(['/runners/contact', '/auth/runner/start', '/auth/runner/poll']);
      expect(callsTo('/auth/runner/start')[0]!.body).toMatchObject({ name: 'renamed', runnerId: 'run_0', replace: true });
      expect(callsTo('/auth/runner/start')[0]!.body.candidate).not.toBe(stale);
      expect(readRunnerRecord(SERVER, home)).toMatchObject({ runnerId: 'run_0', name: 'renamed' });
    });

    it('retains the pending candidate and the explicitly requested name when its outcome is unknown', async () => {
      await acknowledged();
      const candidate = `mycorun_${'p'.repeat(43)}`;
      await withRunnerLock(SERVER, lock => stagePending(lock, {
        kind: 'register', replace: true, name: 'earlier', candidate, startedAt: NOW - 1000,
        deviceCode: DEVICE, userCode: CODE, deviceExpiresAt: NOW + 300_000, pollIntervalSeconds: 5,
      }, 'earlier'), home);
      const offline = serverRoutes(() => { throw new TypeError('offline'); });
      expect(await run(['register', SERVER, '--name', 'renamed', '--replace'], deps(offline))).toBe(false);
      expect(calls.map(call => call.path)).toEqual(['/runners/contact']);
      expect(err.join('\n')).toContain('--name renamed --replace again');
      expect(readRunnerRecord(SERVER, home)).toMatchObject({ runnerId: 'run_0', token: OLD_BEARER, pending: { candidate } });
    });
  });

  it('rejects a runner name the Deployment would refuse', async () => {
    const fetchImpl = serverRoutes(() => Response.json(START));
    expect(await run(['register', SERVER, '--name', 'has space'], deps(fetchImpl))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('names the runner after the sanitized host name by default', async () => {
    const fetchImpl = serverRoutes((call) => (call.path === '/auth/runner/start' ? Response.json(START) : registered('')));
    const withHost = { ...deps(fetchImpl), hostname: () => 'Chris’s MacBook (2)' };
    expect(await run(['register', SERVER], withHost)).toBe(true);
    expect(callsTo('/auth/runner/start')[0]!.body.name).toBe('Chris-s-MacBook--2-');
  });
});
