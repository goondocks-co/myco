import { EXECUTION_PROFILE_FEATURE } from '@goondocks/myco-shared/execution-profile';
import { FEATURES_HEADER } from '@goondocks/myco-shared/member-protocol';
import { profileWorkerServer } from '../helpers/profile-worker-server.js';
/**
 * One worker per Deployment per machine, and a worker that outlives its credential's rotation.
 *
 * The login service, a worker started by hand and the native server's own
 * worker can all be pointed at one Deployment. Only one of them claims; the
 * others wait and take over when it stops. A worker left running for days reads
 * its credential from the membership before each request, so a rotation the
 * hooks perform underneath it does not end its attachment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { holdWorkerInstance, unclassifiedWorkerHolders, workerHolder, workerLockDir, workerLockPath } from '@myco/runner/instance.js';
import { deploymentKeyFor } from '@myco/member/registry.js';
import { readWorkerRefusal } from '@myco/runner/refusal.js';
import { attachOptions, endReplacedWorker, executableIdentity, sameProgram } from '@myco/cli/worker.js';
import { programRuns } from '@myco/install/place-binary.js';
import { workerServiceUnit } from '@myco/runner/service.js';
import { executionDeploymentUrls } from '@myco/cli/worker-service.js';
import { runWorker, type WorkerOptions } from '@myco/runner/loop.js';

const URL_ = 'https://myco.example';
const LOOPBACK = 'http://127.0.0.1:8787';

let scratch: string;
let lockDir: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-worker-instance-'));
  lockDir = path.join(scratch, 'locks');
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

const idle = (): Response => new Response(JSON.stringify({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 5 }), { status: 200 });

function options(over: Partial<WorkerOptions> & { signal: AbortSignal }): WorkerOptions {
  const configured: WorkerOptions = {
    serverUrl: URL_, token: 'tok', lockDir, runRoot: path.join(scratch, 'runs'), only: ['no-such-harness'],
    pollIdleMs: 5, log: () => {}, fetchImpl: (async () => idle()) as unknown as typeof fetch, ...over,
  };
  return { ...configured, fetchImpl: profileWorkerServer(configured.fetchImpl!) };
}

const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error('condition never held');
};

describe('the machine-wide worker lock', () => {
  it('admits one holder per Deployment, whatever the spelling of its address', () => {
    const first = holdWorkerInstance(lockDir, [URL_]);
    expect(first.held).toBe(true);
    expect(holdWorkerInstance(lockDir, [`${URL_}/`])).toMatchObject({ held: false, holder: { pid: process.pid } });
    expect(holdWorkerInstance(lockDir, ['https://other.example']).held).toBe(true);
    if (first.held) first.release();
    expect(holdWorkerInstance(lockDir, [URL_]).held).toBe(true);
  });

  it('serializes origin aliases and credential classes by acknowledged Deployment identity', () => {
    const first = holdWorkerInstance(lockDir, [URL_], 'dep-shared');
    try {
      expect(first.held).toBe(true);
      expect(holdWorkerInstance(lockDir, ['https://alias.example'], 'dep-shared').held).toBe(false);
      const different = holdWorkerInstance(lockDir, ['https://other.example'], 'dep-other');
      expect(different.held).toBe(true);
      if (different.held) different.release();
    } finally { if (first.held) first.release(); }
    const after = holdWorkerInstance(lockDir, ['https://alias.example'], 'dep-shared');
    expect(after.held).toBe(true);
    if (after.held) after.release();
  });

  it('retains the old URL lock beside canonical aliases for a running older worker', async () => {
    const { LifecycleLock } = await import('@myco/utils/lifecycle-lock.js');
    const oldUrl = 'http://localhost:8787';
    const held = LifecycleLock.acquire(path.join(lockDir, `${deploymentKeyFor(oldUrl)}.lock`));
    try { expect(holdWorkerInstance(lockDir, [oldUrl, LOOPBACK]).held).toBe(false); }
    finally { if (held.acquired) held.lock.release(); }
  });

  it('classifies a live executor only after its authenticated Deployment lock is held', () => {
    const old = holdWorkerInstance(lockDir, [URL_]);
    try { expect(unclassifiedWorkerHolders(lockDir)).toMatchObject([{ pid: process.pid }]); }
    finally { if (old.held) old.release(); }
    expect(unclassifiedWorkerHolders(lockDir)).toEqual([]);
    const identified = holdWorkerInstance(lockDir, [URL_], 'dep-identified');
    try { expect(unclassifiedWorkerHolders(lockDir)).toEqual([]); }
    finally { if (identified.held) identified.release(); }
  });

  it('equates loopback names, default ports and URL origin spellings', () => {
    expect(workerLockPath(lockDir, 'http://localhost:8787/')).toBe(workerLockPath(lockDir, LOOPBACK));
    expect(workerLockPath(lockDir, 'http://[::1]:8787')).toBe(workerLockPath(lockDir, LOOPBACK));
    expect(workerLockPath(lockDir, 'http://0.0.0.0:8787')).toBe(workerLockPath(lockDir, LOOPBACK));
    expect(workerLockPath(lockDir, `${URL_}/a`)).toBe(workerLockPath(lockDir, `${URL_}/b`));
    expect(workerLockPath(lockDir, 'https://MYCO.example:443/')).toBe(workerLockPath(lockDir, URL_));
  });

  it('excludes a worker for the public address while the native server holds its loopback and origin', () => {
    const native = holdWorkerInstance(lockDir, [LOOPBACK, URL_]);
    expect(native.held).toBe(true);
    expect(holdWorkerInstance(lockDir, [URL_]).held).toBe(false);
    expect(holdWorkerInstance(lockDir, [LOOPBACK]).held).toBe(false);
    if (native.held) native.release();
  });

  it('holds nothing half-taken when the lock it is refused is not the first it takes', () => {
    // The locks are taken in key order; blocking the later one means the earlier was already taken when the refusal came.
    const [earlier, later] = [LOOPBACK, URL_].sort((a, b) => (deploymentKeyFor(a) < deploymentKeyFor(b) ? -1 : 1)) as [string, string];
    const other = holdWorkerInstance(lockDir, [later]);
    expect(holdWorkerInstance(lockDir, [earlier, later]).held).toBe(false);
    const free = holdWorkerInstance(lockDir, [earlier]);
    expect(free.held).toBe(true);
    if (free.held) free.release();
    if (other.held) other.release();
  });

  it('names the process serving a Deployment, and nobody once it has let go', () => {
    const held = holdWorkerInstance(lockDir, [URL_]);
    expect(workerHolder(lockDir, URL_)?.pid).toBe(process.pid);
    if (held.held) held.release();
    expect(workerHolder(lockDir, URL_)).toBeNull();
    expect(workerHolder(lockDir, 'https://never.example')).toBeNull();
  });

  it('does not take a holder record left by a killed worker for a worker, whatever pid it names', () => {
    const lockPath = workerLockPath(lockDir, URL_);
    fs.mkdirSync(lockDir, { recursive: true });
    // This process's own pid is alive; the record says it holds the lock, and the lock says nobody does.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: 1, command: 'myco worker' }));
    expect(workerHolder(lockDir, URL_)).toBeNull();
  });
});

describe('a second worker for the same Deployment', () => {
  it('refuses runner contact without Deployment identity before claiming', async () => {
    let claims = 0;
    const stopping = new AbortController();
    const result = await runWorker(options({
      signal: stopping.signal, deploymentId: 'dep-expected', compatibilityPath: '/runners/contact',
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (new URL(String(input)).pathname === '/runners/contact') return Response.json({ persisted: true, runner: { id: 'runner' } }, { headers: { [FEATURES_HEADER]: EXECUTION_PROFILE_FEATURE } });
        claims += 1; stopping.abort(); return idle();
      }) as typeof fetch,
    }));
    expect(result.refused).toBe('unauthorized');
    expect(claims).toBe(0);
  });
  it('claims nothing while the first holds the Deployment, and takes over when it stops', async () => {
    const first = holdWorkerInstance(lockDir, [URL_]);
    if (!first.held) throw new Error('the lock should be free');
    const lines: string[] = [];
    let claims = 0;
    const stopping = new AbortController();
    const second = runWorker(options({
      signal: stopping.signal,
      log: (line) => { lines.push(line); },
      fetchImpl: (async () => { claims += 1; return idle(); }) as unknown as typeof fetch,
    }));

    await until(() => lines.some((l) => l.includes('another worker on this machine')));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claims).toBe(0);
    expect(lines.filter((l) => l.includes('another worker on this machine'))).toHaveLength(1);

    first.release();
    await until(() => claims > 0);
    expect(lines).toContain('the other worker stopped; this one serves the Deployment now');
    expect(workerHolder(lockDir, URL_)?.pid).toBe(process.pid);

    stopping.abort();
    expect(await second).toEqual({ driven: 0, refused: null });
    // Stopping releases the Deployment for whoever comes next.
    expect(holdWorkerInstance(lockDir, [URL_]).held).toBe(true);
  });

  it('an updated legacy worker and runner through different origins never claim together', async () => {
    const a = new AbortController(), b = new AbortController();
    const claims = [0, 0];
    const logs: string[] = [];
    const send = (index: number): typeof fetch => (async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === '/runners/contact') return Response.json({ persisted: true, deploymentId: 'dep-shared' }, { headers: { [FEATURES_HEADER]: EXECUTION_PROFILE_FEATURE } });
      claims[index]! += 1;
      return idle();
    }) as typeof fetch;
    const first = runWorker(options({ signal: a.signal, compatibilityPath: '/runners/contact', fetchImpl: send(0) }));
    let second: Promise<unknown> | undefined;
    try {
      await until(() => claims[0]! > 0);
      second = runWorker(options({ signal: b.signal, serverUrl: 'https://alias.example', deploymentId: 'dep-shared', compatibilityPath: '/runners/contact', fetchImpl: send(1), log: (line) => logs.push(line) }));
      await until(() => logs.some((line) => line.includes('another worker on this machine')) || claims[1]! > 0);
      expect(claims[1]).toBe(0);
      a.abort(); await first;
      await until(() => claims[1]! > 0);
      b.abort(); await second;
    } finally { a.abort(); b.abort(); await first; await second; }
  });

  it('refuses a contact that changes the enrolled Deployment before any claim', async () => {
    let claims = 0;
    const stopping = new AbortController();
    const result = await runWorker(options({
      signal: stopping.signal, deploymentId: 'dep-expected', compatibilityPath: '/runners/contact',
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (new URL(String(input)).pathname === '/runners/contact') return Response.json({ persisted: true, deploymentId: 'dep-other' }, { headers: { [FEATURES_HEADER]: EXECUTION_PROFILE_FEATURE } });
        claims += 1; return idle();
      }) as typeof fetch,
    }));
    expect(result.refused).toBe('unauthorized');
    expect(claims).toBe(0);
  });

  it('stops waiting when it is stopped', async () => {
    const first = holdWorkerInstance(lockDir, [URL_]);
    const stopping = new AbortController();
    const second = runWorker(options({ signal: stopping.signal }));
    stopping.abort();
    expect(await second).toEqual({ driven: 0, refused: null });
    if (first.held) first.release();
  });
});

describe('the credential a worker presents', () => {
  const bearerOf = (init?: RequestInit): string => new Headers(init?.headers).get('authorization') ?? '';

  it('is read from the membership before every request, so a rotation reaches a running worker', async () => {
    let current = 'tok-one';
    const seen: string[] = [];
    const stopping = new AbortController();
    const running = runWorker(options({
      signal: stopping.signal,
      token: () => current,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(bearerOf(init));
        if (seen.length === 2) current = 'tok-two';
        if (seen.length >= 4) stopping.abort();
        return idle();
      }) as unknown as typeof fetch,
    }));
    await running;
    expect(seen.slice(0, 2)).toEqual(['Bearer tok-one', 'Bearer tok-one']);
    expect(seen.slice(2)).toEqual(['Bearer tok-two', 'Bearer tok-two']);
  });

  it('retries once with the successor when the predecessor it just read is refused', async () => {
    let current = 'tok-old';
    const seen: string[] = [];
    const stopping = new AbortController();
    const outcome = await runWorker(options({
      signal: stopping.signal,
      token: () => current,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(bearerOf(init));
        if (bearerOf(init) === 'Bearer tok-old') { current = 'tok-new'; return new Response('', { status: 401 }); }
        stopping.abort();
        return idle();
      }) as unknown as typeof fetch,
    }));
    expect(seen).toEqual(['Bearer tok-old', 'Bearer tok-new']);
    expect(outcome.refused).toBeNull();
  });

  it('does not retry a refused credential that is still the one on disk', async () => {
    const seen: string[] = [];
    const stopping = new AbortController();
    const outcome = await runWorker(options({
      signal: stopping.signal,
      token: () => 'tok-dead',
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => { seen.push(bearerOf(init)); return new Response('', { status: 401 }); }) as unknown as typeof fetch,
    }));
    expect(seen).toEqual(['Bearer tok-dead']);
    expect(outcome.refused).toBe('unauthorized');
  });

  it('ends the attachment once the membership is gone', async () => {
    const stopping = new AbortController();
    const outcome = await runWorker(options({ signal: stopping.signal, token: () => null }));
    expect(outcome).toEqual({ driven: 0, refused: 'no_membership' });
    stopping.abort();
  });
});

describe('a worker whose program is replaced on disk', () => {
  it('stops before its next claim, so its service starts the new program', async () => {
    let current = true;
    let claims = 0;
    const stopping = new AbortController();
    const outcome = await runWorker(options({
      signal: stopping.signal,
      stillCurrent: () => current,
      fetchImpl: (async () => { claims += 1; if (claims === 2) current = false; return idle(); }) as unknown as typeof fetch,
    }));
    expect(outcome).toEqual({ driven: 0, refused: null, replaced: true });
    expect(claims).toBe(2);
  });

  it('notices a replacement by rename, the way an update installs one', () => {
    const program = path.join(scratch, 'myco');
    fs.writeFileSync(program, 'one');
    const same = sameProgram(program, executableIdentity, () => ({ runs: true }));
    expect(same()).toBe(true);
    const next = path.join(scratch, 'myco.next');
    fs.writeFileSync(next, 'two');
    fs.renameSync(next, program);
    expect(same()).toBe(false);
    expect(executableIdentity(path.join(scratch, 'absent'))).toBeNull();
  });

  it('stays on its program while the replacement does not run, and judges each replacement once', () => {
    const program = path.join(scratch, 'myco');
    fs.writeFileSync(program, 'one');
    const probed: string[] = [];
    const said: string[] = [];
    let runs = false;
    const same = sameProgram(program, executableIdentity, (file) => {
      probed.push(fs.readFileSync(file, 'utf8'));
      return runs ? { runs: true } : { runs: false, detail: 'ended by SIGKILL' };
    }, (line) => { said.push(line); });
    fs.writeFileSync(program, 'partial');
    expect(same()).toBe(true);
    expect(same()).toBe(true);
    expect(probed).toEqual(['partial']);
    expect(said).toEqual(['the myco program on disk changed, and the new one does not run (ended by SIGKILL); staying on this one']);
    runs = true;
    fs.writeFileSync(program, 'complete program');
    expect(same()).toBe(false);
    expect(probed).toEqual(['partial', 'complete program']);
  });

  it('an attached worker judges a replacement of its program by running it', () => {
    if (process.platform === 'win32') return;
    const program = path.join(scratch, 'myco');
    fs.writeFileSync(program, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const { stillCurrent } = attachOptions(URL_, path.join(scratch, 'home'), undefined, program);
    const next = path.join(scratch, 'myco.next');
    fs.writeFileSync(next, '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });
    fs.renameSync(next, program);
    expect(stillCurrent!()).toBe(true);
    fs.writeFileSync(next, '#!/bin/sh\n[ "$1" = --version ] && echo 2.0.0\n', { mode: 0o755 });
    fs.renameSync(next, program);
    expect(stillCurrent!()).toBe(false);
  });

  it('a program the kernel will not run is judged by running it', () => {
    const program = path.join(scratch, 'myco');
    fs.writeFileSync(program, '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 });
    expect(programRuns(program)).toEqual({ runs: false, detail: 'ended by SIGKILL' });
    fs.writeFileSync(program, '#!/bin/sh\n[ "$1" = --version ] && echo 1.0.0\n', { mode: 0o755 });
    expect(programRuns(program)).toEqual({ runs: true });
    expect(programRuns(path.join(scratch, 'absent')).runs).toBe(false);
  });
});

describe('a replaced worker running as its macOS login service', () => {
  const unitLabel = (): string => workerServiceUnit(URL_, path.join(scratch, 'member')).label;

  it('asks the service to load its unit again and ends when that stops it', async () => {
    const stopping = new AbortController();
    const reloaded: string[] = [];
    const ended = endReplacedWorker(URL_, path.join(scratch, 'member'), stopping.signal, {
      platform: 'darwin', env: { XPC_SERVICE_NAME: unitLabel() }, home: scratch, waitMs: 60_000,
      reload: (spec, replacing) => { reloaded.push(`${spec.unit.label} ${replacing}`); setTimeout(() => { stopping.abort(); }, 5); return true; },
    });
    expect(await ended).toBe(true);
    // The helper is told which process it replaces, so it never takes this one for the reloaded unit.
    expect(reloaded).toEqual([`${unitLabel()} ${process.pid}`]);
  });

  it('ends non-zero for its service to restart it when no reload stops it, it cannot ask for one, or it is not that service', async () => {
    const member = path.join(scratch, 'member');
    const signal = new AbortController().signal;
    const asked: string[] = [];
    const reload = (answer: boolean) => (spec: { unit: { label: string } }): boolean => { asked.push(spec.unit.label); return answer; };
    expect(await endReplacedWorker(URL_, member, signal, { platform: 'darwin', env: { XPC_SERVICE_NAME: unitLabel() }, home: scratch, waitMs: 5, reload: reload(true) })).toBe(false);
    expect(await endReplacedWorker(URL_, member, signal, { platform: 'darwin', env: { XPC_SERVICE_NAME: unitLabel() }, home: scratch, waitMs: 5, reload: reload(false) })).toBe(false);
    expect(asked).toEqual([unitLabel(), unitLabel()]);
    for (const deps of [
      { platform: 'darwin' as const, env: {} },
      { platform: 'darwin' as const, env: { XPC_SERVICE_NAME: 'co.goondocks.myco-worker.someone-else' } },
      { platform: 'linux' as const, env: { XPC_SERVICE_NAME: unitLabel() } },
    ]) {
      expect(await endReplacedWorker(URL_, member, signal, { ...deps, home: scratch, waitMs: 5, reload: () => { throw new Error('no reload expected'); } })).toBe(false);
    }
  });
});

describe('where each worker takes its locks', () => {
  it('an explicitly attached executor locks every recorded native alias', async () => {
    const mycoHome = path.join(scratch, 'home');
    const file = path.join(mycoHome, 'server', 'local', 'server.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ port: 8787, origin: URL_, sourceFrom: 'socket' }), { mode: 0o600 });
    const urls = await executionDeploymentUrls(LOOPBACK, { mycoHome });
    expect(urls).toEqual([LOOPBACK, URL_]);
    const native = holdWorkerInstance(lockDir, urls);
    try { expect(holdWorkerInstance(lockDir, [URL_]).held).toBe(false); }
    finally { if (native.held) native.release(); }
  });

  it('a worker started from the CLI or a login service locks in this machine\'s lock directory', () => {
    const attach = attachOptions(URL_, path.join(scratch, 'home'));
    expect(attach.lockDir).toBe(workerLockDir());
    expect(attach.lockDir).toBe(path.join(process.env.HOME ?? os.homedir(), '.myco', 'worker', 'locks'));
  });
});

describe('a worker the Deployment will not have', () => {
  it('requires explicit enrollment when no legacy service is installed', async () => {
    const saved = process.env.MYCO_HOME;
    const mycoHome = path.join(scratch, 'member');
    process.env.MYCO_HOME = mycoHome;
    try {
      const { run } = await import('@myco/cli/worker.js');
      expect(await run(['--server', URL_])).toBe(false);
      expect(readWorkerRefusal(mycoHome, URL_)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = saved;
    }
  });
});
