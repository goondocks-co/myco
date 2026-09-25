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
import { holdWorkerInstance, workerHolder } from '@myco/runner/instance.js';
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

  it('excludes a worker for the public address while the native server holds its loopback and origin, and holds nothing half-taken', () => {
    const native = holdWorkerInstance(lockDir, [LOOPBACK, URL_]);
    expect(native.held).toBe(true);
    expect(holdWorkerInstance(lockDir, [URL_]).held).toBe(false);
    if (native.held) native.release();

    // A worker for the public address alone blocks the native server, which then holds neither.
    const service = holdWorkerInstance(lockDir, [URL_]);
    expect(holdWorkerInstance(lockDir, [LOOPBACK, URL_]).held).toBe(false);
    expect(holdWorkerInstance(lockDir, [LOOPBACK]).held).toBe(true);
    if (service.held) service.release();
  });

  it('names the process serving a Deployment, and nobody once it has let go', () => {
    const held = holdWorkerInstance(lockDir, [URL_]);
    expect(workerHolder(lockDir, URL_)?.pid).toBe(process.pid);
    if (held.held) held.release();
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

  it('ends the attachment once the membership is gone', async () => {
    const stopping = new AbortController();
    const outcome = await runWorker(options({ signal: stopping.signal, token: () => null }));
    expect(outcome).toEqual({ driven: 0, refused: 'no_membership' });
    stopping.abort();
  });
});
