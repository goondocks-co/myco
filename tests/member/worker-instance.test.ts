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
import { holdWorkerInstance, workerHolder, workerLockDir, workerLockPath } from '@myco/runner/instance.js';
import { deploymentKeyFor } from '@myco/member/registry.js';
import { readWorkerRefusal } from '@myco/runner/refusal.js';
import { attachOptions, executableIdentity, sameProgram } from '@myco/cli/worker.js';
import { localWorkerTarget } from '@myco/cli/server.js';
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
  return {
    serverUrl: URL_, token: 'tok', lockDir, runRoot: path.join(scratch, 'runs'), only: ['no-such-harness'],
    pollIdleMs: 5, log: () => {}, fetchImpl: (async () => idle()) as unknown as typeof fetch, ...over,
  };
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
    const same = sameProgram(program);
    expect(same()).toBe(true);
    const next = path.join(scratch, 'myco.next');
    fs.writeFileSync(next, 'two');
    fs.renameSync(next, program);
    expect(same()).toBe(false);
    expect(executableIdentity(path.join(scratch, 'absent'))).toBeNull();
  });
});

describe('where each worker takes its locks', () => {
  it('the native server\'s worker locks its loopback and the origin members reach it at', () => {
    const target = localWorkerTarget({ port: 8787, origin: URL_ }, path.join(scratch, 'home'), lockDir);
    expect(target.serverUrl).toBe(LOOPBACK);
    expect(target.deploymentUrls).toEqual([LOOPBACK, URL_]);
    const native = holdWorkerInstance(target.lockDir!, target.deploymentUrls!);
    expect(holdWorkerInstance(lockDir, [URL_]).held).toBe(false);
    if (native.held) native.release();
    expect(localWorkerTarget({ port: 8787 }, scratch).lockDir).toBe(workerLockDir());
  });

  it('a worker started from the CLI or a login service locks in this machine\'s lock directory', () => {
    const attach = attachOptions(URL_, path.join(scratch, 'home'));
    expect(attach.lockDir).toBe(workerLockDir());
    expect(attach.lockDir).toBe(path.join(process.env.HOME ?? os.homedir(), '.myco', 'worker', 'locks'));
  });
});

describe('a worker the Deployment will not have', () => {
  it('ends successfully with the refusal recorded, so its service does not restart it into the same answer', async () => {
    const saved = process.env.MYCO_HOME;
    const mycoHome = path.join(scratch, 'member');
    process.env.MYCO_HOME = mycoHome;
    try {
      const { run } = await import('@myco/cli/worker.js');
      expect(await run(['--server', URL_])).toBe(true);
      expect(readWorkerRefusal(mycoHome, URL_)?.code).toBe('no_membership');
    } finally {
      if (saved === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = saved;
    }
  });
});
