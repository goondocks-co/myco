import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '@myco/cli/setup.js';
import { run as login } from '@myco/cli/login.js';
import { runRunnerService } from '@myco/cli/runner-service.js';
import { executorServiceTarget } from '@myco/cli/worker-service.js';
import { homeReport } from '@myco/cli/member-doctor.js';
import { consentToPlan, type SetupDeps } from '@myco/setup/steps.js';
import { observeSetup } from '@myco/setup/observe.js';
import { planFingerprint, readSetupFile, saveSetupFile, setupFilePath } from '@myco/setup/answers.js';
import { readDeploymentMembership, readRegistryEntry, writeDeploymentMembership, writeRegistryEntry, deploymentPath } from '@myco/member/registry.js';
import { MemberSpool } from '@myco/member/spool.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { bufferLockPath, updateSessionState } from '@myco/member/session-state.js';
import { installWorkerService } from '@myco/runner/service.js';
import { workerLockPath } from '@myco/runner/instance.js';
import { recordDefaultDeployment, readDefaultDeployment } from '@myco/member/default-deployment.js';
import { readRunnerRecord, recordRunnerContact, runnerRecordPath } from '@myco/runner/runner-registry.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { recordingPlatform } from '../helpers/fake-service-manager.js';
import { enrolledBeforeInstall } from './fixtures/interrupted-state.js';
import { legacyFixtureHome } from './fixtures/legacy-home.js';
import { fakeGitHub, SETUP_APP } from './fixtures/github.js';
import { createBunHandler, type BunHandler } from '@myco-server-worker/entry/bun.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { seededSqlite } from '../myco-server/helpers/d1.js';
import { SESSION_SECRET } from '../myco-server/helpers/owner.js';
import { OAUTH_STATE_COOKIE } from '@myco-server-worker/auth/owner/github.js';
import { SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';

const URL = 'https://setup.invalid';
const fakeFetch = (fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch => Object.assign(fn, { preconnect: () => {} });
let root: string;
let home: string;
let project: string;
let lines: string[];
let errors: string[];
const closers: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-journey-'));
  home = path.join(root, 'myco'); project = path.join(root, 'repo');
  fs.mkdirSync(project);
  execFileSync('git', ['init', '-q'], { cwd: project });
  lines = []; errors = [];
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
});
const base = (): SetupDeps => ({ mycoHome: home, cwd: project, ask: async () => null, agents: () => [], stdout: line => lines.push(line), stderr: line => errors.push(line) });

function holdRunnerLock(lockDir: string): void {
  const held = LifecycleLock.acquire(workerLockPath(lockDir, URL), { command: 'fixture runner' });
  if (!held.acquired) throw new Error('Fixture runner lock already held');
  closers.push(() => held.lock.release());
}

/** Names, contents, modes and mtimes cover status's filesystem contract. */
function snapshot(directory: string): unknown {
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory).sort().map((name) => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? snapshot(file) : stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString('base64')];
  });
}

const configuredFetch = fakeFetch(async (input) => {
  const request = new Request(input);
  const route = new globalThis.URL(request.url).pathname;
  if (route === '/health') return Response.json({ ok: true });
  if (route === '/auth/login') return new Response(null, { status: 302, headers: { location: `https://github.com/login/oauth/authorize?client_id=fixture&redirect_uri=${encodeURIComponent(`${URL}/auth/callback`)}` } });
  if (route === '/runners/contact') return Response.json({ persisted: true, runner: { id: 'rn_setup_enrolled', name: 'Fixture runner', deploymentId: 'fixture-deployment', state: 'enabled' }, credential: { id: 'credential', expiresAt: 9999999999999, refreshAfter: 0 } });
  if (route === '/members/status') return Response.json({ target: 'fixture' });
  throw new Error(`unexpected route ${route}`);
});

async function deployment(target: 'native' | 'd1-adapter') {
  const github = fakeGitHub();
  let handler: BunHandler | undefined;
  let handle: (request: Request) => Promise<Response>;
  const secrets = { GITHUB_CLIENT_ID: SETUP_APP.clientId, GITHUB_CLIENT_SECRET: SETUP_APP.clientSecret, SESSION_SECRET };
  if (target === 'native') {
    const sqlite = seededSqlite();
    sqlite.run("UPDATE members SET github_id = '770001', role = 'member' WHERE id = 'mem_machine_2'");
    const databasePath = path.join(root, 'server.sqlite');
    fs.writeFileSync(databasePath, sqlite.serialize()); sqlite.close();
    handler = await createBunHandler({ databasePath, blobDir: path.join(root, 'blobs'), header: 'x-forwarded-for', wakeLoop: false, ...secrets, fetchImpl: github.fetchImpl });
    closers.push(() => handler!.close());
    handle = handler.fetch;
  } else {
    const fixture = sqliteEnv();
    fixture.sqlite.run("UPDATE members SET github_id = '770001', role = 'member' WHERE id = 'mem_machine_2'");
    closers.push(() => fixture.sqlite.close());
    const server = createServer({ now: Date.now, sourceOf: () => '192.0.2.30', fetchImpl: github.fetchImpl });
    handle = (request) => server.handleRequest(request, { ...fixture.serverEnv, secrets });
  }
  const signin = await handle(new Request(`${URL}/auth/login`, { headers: { 'x-forwarded-for': '192.0.2.30' } }));
  const state = new globalThis.URL(signin.headers.get('location')!).searchParams.get('state')!;
  const callback = await handle(new Request(`${URL}/auth/callback?code=teammate&state=${encodeURIComponent(state)}`, { headers: { 'x-forwarded-for': '192.0.2.30', cookie: `${OAUTH_STATE_COOKIE}=${state}` } }));
  expect(callback.status).toBe(302);
  const cookies = callback.headers.get('set-cookie')!;
  const cookie = `${SESSION_COOKIE}=${cookies.slice(cookies.indexOf(`${SESSION_COOKIE}=`) + SESSION_COOKIE.length + 1).split(';')[0]}`;
  const calls: string[] = [];
  const fetchImpl = fakeFetch(async (input, init) => {
    const request = new Request(input, init);
    request.headers.set('x-forwarded-for', '192.0.2.30');
    const route = new globalThis.URL(request.url).pathname;
    calls.push(route);
    const response = await handle(request);
    if (route === '/auth/device/start' && response.ok) {
      const grant = await response.clone().json() as { user_code: string };
      const approved = await handle(new Request(`${URL}/api/device/approve`, { method: 'POST', headers: { origin: URL, cookie, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.30' }, body: JSON.stringify({ user_code: grant.user_code }) }));
      expect(approved.status).toBe(200);
    }
    return response;
  });
  return { fetchImpl, calls, github };
}

describe('teammate journey (c)', () => {
  for (const target of ['native', 'd1-adapter'] as const) it(`joins as a fake GitHub teammate through ${target}, with no worker`, async () => {
    const server = await deployment(target);
    const platform = recordingPlatform();
    const deps: SetupDeps = { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'setup-teammate-machine' }, worker: { runner: platform.runner } };
    const args = ['--join', URL, '--root', project, '--project', 'proj_1', '--no-agents', '--no-runner'];
    expect(await run(args, deps)).toBe(0);
    expect(errors).toEqual([]);
    expect(readDeploymentMembership(URL, home)?.memberId).toBe('mem_machine_2');
    expect(readRegistryEntry(project, home)?.projectId).toBe('proj_1');
    expect(platform.commands).toEqual([]);
    expect(server.calls.filter((route) => route === '/auth/device/start')).toHaveLength(1);
    expect(await run([], deps)).toBe(0);
    expect(server.calls.filter((route) => route === '/auth/device/start')).toHaveLength(1);
    const before = snapshot(home);
    expect(await run(['--status', '--json'], { ...deps, fetch: fakeFetch(async () => { throw new Error('status made a network call'); }) })).toBe(0);
    expect(snapshot(home)).toEqual(before);
    expect(server.github.calls).toHaveLength(2);
  });

  it('resumes provisioning and project connection after sign-in was interrupted', async () => {
    const server = await deployment('d1-adapter');
    let interrupted = true;
    const deps: SetupDeps = { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'interrupted-machine' },
      login: async (args, loginDeps) => {
        expect(loginDeps?.provision).toBe('defer');
        const ok = await login(args, loginDeps);
        if (interrupted) { interrupted = false; throw new Error('Ctrl-C mid-step'); }
        return ok;
      } };
    expect(await run(['--join', URL, '--project', 'proj_1', '--no-agents', '--no-runner'], deps)).toBe(2);
    expect(readDeploymentMembership(URL, home)).not.toBeNull();
    expect(readRegistryEntry(project, home)).toBeNull();
    expect(await run([], { ...deps, login: async () => { throw new Error('must not repeat login'); } })).toBe(0);
    expect(readRegistryEntry(project, home)?.projectId).toBe('proj_1');
  });

  it('stops on unreachable observations without creating a new credential', async () => {
    writeDeploymentMembership({ serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
    const before = fs.readFileSync(deploymentPath(URL, home));
    let loggedIn = false;
    expect(await run(['--join', URL, '--no-runner', '--no-agents'], { ...base(), fetch: fakeFetch(async () => { throw new Error('offline'); }), login: async () => { loggedIn = true; return false; } })).toBe(2);
    expect(loggedIn).toBe(false);
    expect(fs.readFileSync(deploymentPath(URL, home))).toEqual(before);
    expect(errors.join('\n')).toContain('unavailable');
  });

  it('changes the default directly after the one explicit choice', async () => {
    const server = await deployment('d1-adapter');
    recordDefaultDeployment('https://other.invalid', { mycoHome: home });
    expect(await run(['--join', URL, '--project', 'proj_1', '--default', '--no-agents', '--no-runner'], { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'default-machine' } })).toBe(0);
    expect(readDefaultDeployment(home)?.serverUrl).toBe(URL);
    expect(lines.join('\n')).toContain('#1724');
  });

  it('re-asks before a saved default answer replaces a later user choice', async () => {
    const server = await deployment('d1-adapter');
    recordDefaultDeployment('https://first.invalid', { mycoHome: home });
    const deps: SetupDeps = { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'changed-default-machine' } };
    expect(await run(['--join', URL, '--project', 'proj_1', '--default', '--no-agents', '--no-runner'], deps)).toBe(0);
    recordDefaultDeployment('https://later.invalid', { mycoHome: home, replace: true });
    expect(await run(['--yes'], deps)).toBe(2);
    expect(readDefaultDeployment(home)?.serverUrl).toBe('https://later.invalid');
    expect(errors.join('\n')).toContain('changed plans require fresh consent');
  });

  it('returns the join owner’s project-choice refusal without a terminal', async () => {
    const server = await deployment('d1-adapter');
    expect(await run(['--join', URL, '--no-agents', '--no-runner'], { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'no-project-choice' } })).toBe(2);
    expect(errors.join('\n')).toContain('myco member join --project');
    expect(readRegistryEntry(project, home)).toBeNull();
  });

  it('conducts an explicit changed Project choice and refuses new creation on a bound repository', async () => {
    const server = await deployment('d1-adapter');
    const deps: SetupDeps = { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'project-choice-machine' } };
    expect(await run(['--join', URL, '--project', 'proj_1', '--no-agents', '--no-runner'], deps)).toBe(0);
    expect(await run(['--project', 'proj_2'], deps)).toBe(0);
    expect(readRegistryEntry(project, home)?.projectId).toBe('proj_2');
    expect(await run(['--new', 'Another'], deps)).toBe(2);
    expect(readRegistryEntry(project, home)?.projectId).toBe('proj_2');
    expect(server.calls).not.toContain('/members/projects');
  });

  it('cannot report completion when an operation returns without the durable binding', async () => {
    writeDeploymentMembership({ serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
    expect(await run(['--join', URL, '--project', 'proj_1', '--no-agents', '--no-runner'], { ...base(), fetch: configuredFetch,
      join: async () => ({ version: 2, serverUrl: URL, root: project, projectId: 'proj_1', token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }),
    })).toBe(2);
    expect(errors.join('\n')).toContain('project remains absent');
  });
});

describe('runner journey (d)', () => {
  function runnerDeps() {
    const platform = recordingPlatform();
    const user = path.join(root, 'user');
    fs.mkdirSync(user);
    let time = Date.now();
    const deps: SetupDeps = { ...base(), fetch: configuredFetch, now: () => time,
      sleep: async (ms) => { time += ms; },
      worker: { home: user, binaryPath: path.join(root, 'bin', 'myco'), platform: 'darwin', runner: platform.runner,
        ownDeploymentUrls: async () => [], lockDir: path.join(root, 'locks'), harnessDirs: () => [], detect: () => [] },
    };
    return { deps, platform, advance: (ms: number) => { time += ms; } };
  }

  it('registers a runner without membership and respects a declined service on reruns', async () => {
    let starts = 0;
    const fake = runnerDeps();
    const fetchImpl = fakeFetch(async (input, init) => {
      const route = new globalThis.URL(new Request(input, init).url).pathname;
      if (route === '/auth/login') throw new Error('runner setup must not probe member sign-in');
      if (route === '/auth/runner/start') { starts++; return Response.json({ device_code: 'd'.repeat(43), user_code: 'BCDF-2345', expires_in: 600, interval: 1 }); }
      if (route === '/auth/runner/poll') return Response.json({ registered: true, runnerId: 'rn_setup_enrolled', name: 'mini', deploymentId: 'fixture-deployment' });
      return configuredFetch(input, init);
    });
    expect(await run(['--runner', URL, '--runner-name', 'mini', '--runner-service', 'skip', '--yes'], { ...fake.deps, fetch: fetchImpl })).toBe(0);
    expect(readDeploymentMembership(URL, home)).toBeNull();
    expect(readRunnerRecord(URL, home)?.name).toBe('mini');
    expect(await run([], { ...fake.deps, fetch: fetchImpl })).toBe(0);
    expect(starts).toBe(1);
    expect(fake.platform.commands).toEqual([]);
  });

  it('resumes enrollment after a failed install, and waits for a fresh acknowledged offer', async () => {
    await enrolledBeforeInstall(home, URL);
    const fake = runnerDeps();
    let fail = true;
    let installs = 0;
    const deps: SetupDeps = { ...fake.deps, register: async () => { throw new Error('must not register again'); },
      service: async (verb, args, serviceDeps) => {
        installs++;
        if (fail) { fail = false; return false; }
        const ok = await runRunnerService(verb, args, serviceDeps);
        holdRunnerLock(fake.deps.worker!.lockDir!);
        const record = readRunnerRecord(URL, home)!;
        await recordRunnerContact(URL, { runnerId: record.runnerId!, deploymentId: record.deploymentId! }, Date.now() + 1000, home, { offered: ['claude-code'], withheld: [] });
        return ok;
      } };
    expect(await run(['--runner', URL, '--runner-service', 'install', '--yes'], deps)).toBe(2);
    expect(readRunnerRecord(URL, home)?.runnerId).toBe('rn_setup_enrolled');
    expect(await run([], deps)).toBe(0);
    expect(installs).toBe(2);
    expect(lines.join('\n')).toContain('Runner offering claude-code');
  });

  it('rejects an old offer from before service installation', async () => {
    const record = await enrolledBeforeInstall(home, URL);
    await recordRunnerContact(URL, { runnerId: record.runnerId, deploymentId: record.deploymentId }, 1, home, { offered: ['claude-code'], withheld: [] });
    const fake = runnerDeps();
    expect(await run(['--runner', URL, '--runner-service', 'install', '--yes'], fake.deps)).toBe(2);
    expect(errors.join('\n')).toContain('No current runner offer');
    expect(lines.join('\n')).not.toContain('Runner offering');
  });

  it('a saved runner role and install choice never grant service consent', async () => {
    await enrolledBeforeInstall(home, URL);
    saveSetupFile(home, { version: 1, answers: { role: 'runner', url: URL, runnerService: 'install' }, consented: {} });
    const fake = runnerDeps();
    expect(await run([], fake.deps)).toBe(2);
    expect(fake.platform.commands).toEqual([]);
    expect(errors.join('\n')).toContain('no terminal');
  });
});

describe('observation and consent contracts', () => {
  for (const runtime of ['running', 'stopped', 'unavailable', 'starting', 'restarted'] as const) it(`status reports an installed runner as ${runtime} without changing HOME or MYCO_HOME`, async () => {
    const record = await enrolledBeforeInstall(home, URL);
    const platform = recordingPlatform();
    const userHome = path.join(root, 'user');
    const lockDir = path.join(root, 'locks');
    const worker = { home: userHome, mycoHome: home, platform: 'darwin' as const, binaryPath: path.join(root, 'bin', 'myco'), runner: platform.runner, lockDir };
    const installed = installWorkerService(executorServiceTarget(URL, worker, 'runner'), [], { runner: platform.runner });
    if (runtime === 'stopped') platform.running.clear();
    if (runtime !== 'starting') holdRunnerLock(lockDir);
    if (runtime === 'unavailable') worker.runner = (command, args) => { platform.runner(command, args); return { status: null, error: new Error('Fixture service manager unavailable') }; };
    if (runtime === 'restarted') fs.utimesSync(installed.unitFile, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    await recordRunnerContact(URL, { runnerId: record.runnerId, deploymentId: record.deploymentId }, Date.now() + (runtime === 'restarted' ? -5000 : 1000), home, { offered: ['claude-code'], withheld: [] });
    const unrelated = runnerRecordPath('https://unrelated.invalid', home);
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, '{}', { mode: 0o600 });
    platform.commands.length = 0;
    const before = snapshot(root);
    expect(await run(['--status', '--json', '--runner', URL, '--runner-service', 'install'], { ...base(), worker, fetch: fakeFetch(async () => { throw new Error('status made a network call'); }) })).toBe(runtime === 'unavailable' ? 4 : runtime === 'running' ? 0 : 3);
    const observations = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
    const service = observations.find(fact => fact.id === 'runner.service');
    expect(service?.state).toBe(runtime === 'unavailable' ? 'unavailable' : runtime === 'stopped' ? 'incomplete' : 'complete');
    expect(service?.detail).toContain(runtime === 'unavailable' ? 'unavailable' : runtime === 'stopped' ? 'installed, stopped' : 'running');
    expect(observations.find(fact => fact.id === 'runner.offer')?.state).toBe(runtime === 'starting' || runtime === 'restarted' ? 'incomplete' : 'complete');
    expect(snapshot(root)).toEqual(before);
    expect(platform.commands).toHaveLength(1);
    expect(platform.commands[0]).toMatch(/^launchctl list /);
  });

  for (const missingLock of [false, true]) it(`status observes capture backlog ${missingLock ? 'with a missing lock' : 'and delivery facts'} without repairing it`, async () => {
    const entry = { version: 2, serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1, root: project, projectId: 'proj_capture' };
    writeRegistryEntry(entry, { mycoHome: home });
    const spool = new MemberSpool(entry, { mycoHome: home });
    const sessionId = 'setup-capture';
    spool.append(sessionId, promptEvent({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' }, { promptId: mintId(), text: 'fixture prompt' }));
    updateSessionState(spool.dir, sessionId, state => { state.lastDeliveryAt = 1000; });
    fs.writeFileSync(path.join(spool.dir, 'offline.json'), JSON.stringify({ since: 1000, nextProbeAt: 3000, backoffMs: 2000 }), { mode: 0o600 });
    spool.appendRefused({ eventId: mintId(), sessionId, kind: 'prompt', code: 'clock_skew', reason: 'Fixture clock refusal', at: 1000 });
    if (missingLock) fs.unlinkSync(bufferLockPath(spool.dir, sessionId));
    const before = snapshot(root);
    expect(await run(['--status', '--json', '--join', URL, '--root', project, '--no-agents', '--no-runner'], { ...base(), now: () => 2000 })).toBe(missingLock ? 4 : 0);
    const observations = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
    const backlog = observations.find(fact => fact.id === 'machine.backlog');
    expect(backlog?.scope).toBe(project);
    expect(backlog?.state).toBe(missingLock ? 'unavailable' : 'incomplete');
    if (!missingLock) {
      expect(backlog?.detail).toContain('1 event(s) waiting');
      expect(backlog?.detail).toContain(new Date(1000).toISOString());
      expect(observations.find(fact => fact.id === 'machine.latch')?.state).toBe('incomplete');
      expect(observations.find(fact => fact.id === 'machine.refusals')?.state).toBe('incomplete');
    }
    expect(snapshot(root)).toEqual(before);
    await homeReport(home, { mycoHome: home, cwd: project, fetch: configuredFetch, worker: { home: path.join(root, 'user'), runner: recordingPlatform().runner, lockDir: path.join(root, 'locks') } });
    expect(snapshot(root)).toEqual(before);
  });

  it('status dates the full refusal history and only flags recent refusals', async () => {
    const now = Date.UTC(2026, 9, 11);
    const entry = { version: 2, serverUrl: URL, token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1, root: project, projectId: 'proj_capture' };
    writeRegistryEntry(entry, { mycoHome: home });
    const spool = new MemberSpool(entry, { mycoHome: home });
    const old = now - 8 * 24 * 60 * 60 * 1000;
    const append = (at: number) => spool.appendRefused({ eventId: mintId(), sessionId: 'refusal-history', kind: 'prompt', code: 'clock_skew', reason: 'Fixture refusal', at });
    append(old);
    for (const recent of [false, true]) {
      if (recent) {
        append(now);
        for (let i = 0; i < 55; i++) append(old);
      }
      const before = snapshot(root);
      await run(['--status', '--json', '--join', URL, '--root', project, '--no-agents', '--no-runner'], { ...base(), now: () => now });
      const observations = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
      const refusal = observations.find(fact => fact.id === 'machine.refusals');
      expect(refusal?.state).toBe(recent ? 'incomplete' : 'complete');
      expect(refusal?.detail).toContain(new Date(recent ? now : old).toISOString());
      expect(refusal?.detail).toContain(recent ? '57 refused event(s)' : '1 refused event(s)');
      expect(refusal?.detail).toContain(recent ? '1 in the last 7 days' : '0 in the last 7 days');
      expect(snapshot(root)).toEqual(before);
    }
    append(1e30);
    const before = snapshot(root);
    await run(['--status', '--json', '--join', URL, '--root', project, '--no-agents', '--no-runner'], { ...base(), now: () => now });
    const observations = JSON.parse(lines.at(-1)!).observations as Awaited<ReturnType<typeof observeSetup>>;
    expect(observations.find(fact => fact.id === 'machine.backlog')?.state).toBe('complete');
    expect(observations.find(fact => fact.id === 'machine.refusals')?.detail).toContain('newest unknown');
    expect(snapshot(root)).toEqual(before);
  });

  it('status on a fresh home is strictly read-only and makes no calls', async () => {
    const before = snapshot(root);
    expect(await run(['--status', '--json'], { ...base(), fetch: fakeFetch(async () => { throw new Error('network'); }), worker: { runner: () => { throw new Error('service'); } } })).toBe(3);
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(setupFilePath(home))).toBe(false);
  });

  it('status observes malformed membership as unavailable instead of missing', async () => {
    const file = deploymentPath(URL, home);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}', { mode: 0o600 });
    const before = snapshot(home);
    expect(await run(['--status', '--join', URL, '--json'], base())).toBe(4);
    expect(lines.join('\n')).toContain('unavailable');
    expect(snapshot(home)).toEqual(before);
  });

  it('remote runner status neither rotates credentials nor writes local records or Deployment telemetry', async () => {
    await enrolledBeforeInstall(home, URL);
    const before = snapshot(home);
    const calls: string[] = [];
    expect(await run(['--status', '--runner', URL, '--runner-service', 'skip', '--check-remote'], { ...base(), fetch: fakeFetch(async (input, init) => {
      calls.push(new globalThis.URL(new Request(input, init).url).pathname);
      return configuredFetch(input, init);
    }) })).toBe(0);
    expect(calls).toEqual(['/health']);
    expect(lines.join('\n')).toContain('runner contact writes Deployment telemetry');
    expect(snapshot(home)).toEqual(before);
  });

  it('a changed fingerprint re-asks even with --yes and refuses with no terminal', async () => {
    const file = readSetupFile(home);
    const opts = { home, file, id: 'service', plan: { binary: '/first', home, unit: 'fixture' }, question: 'Install?', ask: async () => null, out: (line: string) => lines.push(line), yes: true };
    await consentToPlan(opts);
    const first = snapshot(home);
    await expect(consentToPlan({ ...opts, plan: { ...opts.plan, binary: '/second' } })).rejects.toThrow('changed plans require fresh consent');
    expect(snapshot(home)).toEqual(first);
    let asked = 0;
    await consentToPlan({ ...opts, plan: { ...opts.plan, binary: '/second' }, ask: async () => { asked++; return 'yes'; } });
    expect(asked).toBe(1);
    expect(readSetupFile(home).consented.service).toBe(planFingerprint({ ...opts.plan, binary: '/second' }));
  });

  it('canonical fingerprints ignore key order, and answers reject completion or secrets', () => {
    expect(planFingerprint({ url: URL, nested: { b: 2, a: 1 } })).toBe(planFingerprint({ nested: { a: 1, b: 2 }, url: URL }));
    const file = readSetupFile(home);
    expect(() => saveSetupFile(home, { ...file, token: 'secret' } as never)).toThrow();
    saveSetupFile(home, { ...file, answers: { role: 'join', url: URL } });
    expect(fs.statSync(setupFilePath(home)).mode & 0o777).toBe(0o600);
  });

  it('legacy deferral never executes a binary or starts a remote flow', async () => {
    const legacy = legacyFixtureHome(path.join(root, 'legacy'));
    const sentinel = path.join(root, 'executed-legacy');
    fs.writeFileSync(legacy.binary, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
    fs.chmodSync(legacy.binary, 0o755);
    expect(await run(['--join', URL, '--no-agents', '--no-runner'], { ...base(), mycoHome: legacy.mycoHome, fetch: fakeFetch(async () => { throw new Error('must defer before remote flow'); }) })).toBe(2);
    expect(errors.join('\n')).toContain('migration is pending');
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('observes a different project destination without changing it', async () => {
    const server = await deployment('d1-adapter');
    expect(await run(['--join', URL, '--project', 'proj_1', '--no-agents', '--no-runner'], { ...base(), fetch: server.fetchImpl, sleep: async () => {}, loginDeps: { machineId: 'binding-machine' } })).toBe(0);
    const before = snapshot(home);
    const observations = await observeSetup(home, { role: 'join', url: 'https://other.invalid', root: project }, base());
    expect(observations.find((fact) => fact.id === 'project')?.detail).toContain('bound-elsewhere');
    expect(snapshot(home)).toEqual(before);
  });
});
