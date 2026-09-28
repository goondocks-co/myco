/**
 * The lease a worker holds, as the worker keeps it (#1424).
 *
 * The Deployment here is hand-written, so a test decides exactly when an answer
 * lands and what it says: after a sleep, never, or after the run it renewed has
 * ended. The harness is the stub on PATH from `tests/helpers/stub-acp-harness.ts`,
 * held open until the test releases it. The worker's clock and the Deployment's
 * are separate, and a sleep moves both, as it does between two real machines.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, type WorkerOutcome } from '@myco/runner/loop.js';
import { listingOnly, withRunMcp } from '../helpers/run-mcp-fetch.ts';
import { stubAcpHarness, STUB_DETECTED, STUB_HARNESS } from '../helpers/stub-acp-harness.ts';

const SERVER_URL = 'https://deployment.example';
const LEASE_MS = 90_000;
const HEARTBEAT_MS = 100;
const ATTEMPT = 'mt_attempt_1';

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function until(what: string, pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

type Handler = (body: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<Response> | Response;

/**
 * A worker against a hand-written Deployment. `lease` and `claim` replace the
 * default answers; `skewMs` sets the worker's clock that far ahead of the
 * Deployment's.
 */
function rig(options: { skewMs?: number; lease?: Handler; claim?: Handler } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'myco-lease-clock-'));
  const release = join(dir, 'release');
  const spawned = join(dir, 'spawned');
  expect(stubAcpHarness({ holdUntil: release, spawnedFile: spawned })).toEqual(STUB_DETECTED);
  let offset = 0;
  const serverClock = (): number => Date.now() + offset;
  const workerClock = (): number => serverClock() + (options.skewMs ?? 0);
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const lines: string[] = [];
  let claimed = false;

  const run = { projectId: 'proj_1', id: 'run_1', task: 'title-summary', instruction: 'do it', harness: STUB_HARNESS, runToken: 'tok_run', credentialEnv: {}, timeoutSeconds: 60, attemptId: ATTEMPT };
  const defaultClaim: Handler = () => {
    if (claimed) return Response.json({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 50 });
    claimed = true;
    return Response.json({ persisted: true, claimed: true, heartbeatMs: HEARTBEAT_MS, leaseMs: LEASE_MS, run: { ...run, leaseExpiresAt: serverClock() + LEASE_MS } });
  };
  const defaultLease: Handler = () => Response.json({ persisted: true, held: true, expiresAt: serverClock() + LEASE_MS, leaseMs: LEASE_MS });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ path, body });
    const signal = init?.signal ?? undefined;
    const answer = path === '/worker/claim' ? (options.claim ?? defaultClaim)(body, signal)
      : path === '/worker/lease' ? (options.lease ?? defaultLease)(body, signal)
        : Response.json({ persisted: true, ended: true, status: body.status });
    const response = await answer;
    response.headers.set('x-myco-protocol', '1');
    return response;
  }) as unknown as typeof fetch;

  const stopping = new AbortController();
  const start = (): Promise<WorkerOutcome> => withRunMcp(SERVER_URL, (request) => listingOnly(request), () => runWorker({
    serverUrl: SERVER_URL, token: 'x'.repeat(43), lockDir: null,
    runRoot: mkdtempSync(join(tmpdir(), 'myco-lease-clock-runs-')),
    only: [STUB_HARNESS], once: true, pollIdleMs: 50,
    log: (line) => { lines.push(line); }, fetchImpl, signal: stopping.signal, clock: workerClock,
  }));
  return {
    sent, lines, start, stopping,
    /** Both machines sleep for `ms`: both clocks jump, and nothing on the worker's machine runs meanwhile. */
    sleep: (ms: number) => { offset += ms; },
    release: () => { if (!existsSync(release)) writeFileSync(release, ''); },
    spawned: () => (existsSync(spawned) ? readFileSync(spawned, 'utf8').trim().split('\n').length : 0),
    ended: () => sent.filter((s) => s.path === '/worker/end'),
    report: () => lines.join('\n'),
  };
}

describe('the lease a worker holds', () => {
  it('starts no harness and reports nothing for a claim whose answer lands after its lease ran out', async () => {
    let r: ReturnType<typeof rig>;
    let answered = false;
    r = rig({
      claim: () => {
        if (answered) return Response.json({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 50 });
        answered = true;
        // The machine slept with the claim in flight; its answer lands after the lease the claim won ran out.
        r.sleep(LEASE_MS + 30_000);
        return Response.json({ persisted: true, claimed: true, heartbeatMs: HEARTBEAT_MS, leaseMs: LEASE_MS, run: { projectId: 'proj_1', id: 'run_1', task: 'title-summary', instruction: 'do it', harness: STUB_HARNESS, runToken: 'tok_run', credentialEnv: {}, timeoutSeconds: 60, attemptId: ATTEMPT } });
      },
    });
    try {
      expect(await r.start()).toEqual({ driven: 1, refused: null });
      expect({ spawned: r.spawned(), ended: r.ended(), said: r.lines.some((l) => l.includes('lapsed before its harness started')) }, r.report())
        .toEqual({ spawned: 0, ended: [], said: true });
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);

  it('counts the lease down on its own clock, so a clock set ahead of the Deployment\'s never stops a live lease', async () => {
    // The worker's clock runs a minute ahead. A comparison of its clock with the
    // Deployment's expiry would read a live lease as over after a 35 s sleep.
    const r = rig({ skewMs: 60_000 });
    try {
      const outcome = r.start();
      await until('several renewals', () => r.sent.filter((s) => s.path === '/worker/lease').length >= 3);
      r.sleep(35_000);
      await until('a renewal after the sleep', () => r.sent.filter((s) => s.path === '/worker/lease').length >= 6);
      r.release();
      expect(await outcome).toEqual({ driven: 1, refused: null });
      expect({ stopped: r.lines.some((l) => l.includes('slept past')), ended: r.ended().map((s) => s.body.status) }, r.report())
        .toEqual({ stopped: false, ended: ['completed'] });
      // Every renewal names the attempt it renews.
      expect([...new Set(r.sent.filter((s) => s.path === '/worker/lease').map((s) => s.body.attemptId))]).toEqual([ATTEMPT]);
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);

  it('gives up each renewal a Deployment never answers within one heartbeat, and keeps driving', async () => {
    const renewals: Array<{ at: number; abandonedAt: number | null }> = [];
    const r = rig({
      lease: (_body, signal) => {
        const renewal = { at: Date.now(), abandonedAt: null as number | null };
        renewals.push(renewal);
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => { renewal.abandonedAt = Date.now(); reject(signal.reason); }, { once: true });
        });
      },
    });
    try {
      const outcome = r.start();
      await until('several renewals', () => renewals.length >= 6);
      const due = renewals.slice(0, -2);
      expect(due.every((x) => x.abandonedAt !== null && x.abandonedAt - x.at <= HEARTBEAT_MS * 5), JSON.stringify(due)).toBe(true);
      r.release();
      expect(await outcome).toEqual({ driven: 1, refused: null });
      expect(r.ended().map((s) => s.body.status)).toEqual(['completed']);
      expect(r.lines.filter((l) => l.includes('cannot renew'))).toHaveLength(1);
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);

  it('reads nothing into a renewal answered after the run it renewed has ended', async () => {
    const late: Array<() => void> = [];
    const r = rig({
      // Every renewal is answered only once the run is over, and says the lease is gone, as it would be.
      lease: () => new Promise<Response>((resolve) => {
        late.push(() => { resolve(Response.json({ persisted: true, held: false, reason: 'the lease is no longer held' })); });
      }),
    });
    try {
      const outcome = r.start();
      await until('several renewals', () => late.length >= 3);
      r.release();
      expect(await outcome).toEqual({ driven: 1, refused: null });
      const said = r.lines.length;
      for (const answer of late) answer();
      await wait(200);
      expect({ after: r.lines.slice(said), ended: r.ended().map((s) => s.body.status) }).toEqual({ after: [], ended: ['completed'] });
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);
});
