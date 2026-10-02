import { profileWorkerServer } from '../helpers/profile-worker-server.js';
/**
 * The lease a worker holds, as the worker keeps it (#1424).
 *
 * The Deployment here is hand-written, so a test decides exactly when an answer
 * lands and what it says: after a sleep, never, or after the run it renewed has
 * ended. The harness is the stub on PATH from `tests/helpers/stub-profile-harness.ts`,
 * held open until the test releases it. The worker's clock and the Deployment's
 * are separate, and a sleep moves both, as it does between two real machines.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, type WorkerOutcome } from '@myco/runner/loop.js';
import { listingOnly, withRunMcp } from '../helpers/run-mcp-fetch.ts';
import { stubProfileHarness, PROFILE_STUB_DETECTED, PROFILE_STUB_HARNESS, STUB_PROFILE } from '../helpers/stub-profile-harness.ts';

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
function rig(options: { skewMs?: number; lease?: Handler; claim?: Handler; end?: Handler; once?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'myco-lease-clock-'));
  const release = join(dir, 'release');
  const spawned = join(dir, 'spawned');
  expect(stubProfileHarness({ holdUntil: release, spawnedFile: spawned })).toEqual(PROFILE_STUB_DETECTED);
  let offset = 0;
  const serverClock = (): number => Date.now() + offset;
  const workerClock = (): number => serverClock() + (options.skewMs ?? 0);
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const lines: string[] = [];
  let claimed = false;

  const run = { projectId: 'proj_1', id: 'run_1', task: 'title-summary', instruction: 'do it', harness: PROFILE_STUB_HARNESS, runToken: 'tok_run', credentialEnv: {}, profile: STUB_PROFILE, timeoutSeconds: 60, attemptId: ATTEMPT };
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
        : options.end !== undefined ? options.end(body, signal) : Response.json({ persisted: true, ended: true, status: body.status });
    const response = await answer;
    response.headers.set('x-myco-protocol', '1');
    return response;
  }) as unknown as typeof fetch;

  const stopping = new AbortController();
  const start = (): Promise<WorkerOutcome> => withRunMcp(SERVER_URL, (request) => listingOnly(request), () => runWorker({
    serverUrl: SERVER_URL, token: 'x'.repeat(43), lockDir: null,
    runRoot: mkdtempSync(join(tmpdir(), 'myco-lease-clock-runs-')),
    only: [PROFILE_STUB_HARNESS], once: options.once ?? true, pollIdleMs: 50,
    log: (line) => { lines.push(line); }, fetchImpl: profileWorkerServer(fetchImpl), signal: stopping.signal, clock: workerClock,
  }));
  return {
    sent, lines, start, stopping, run,
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
        return Response.json({ persisted: true, claimed: true, heartbeatMs: HEARTBEAT_MS, leaseMs: LEASE_MS, run: { projectId: 'proj_1', id: 'run_1', task: 'title-summary', instruction: 'do it', harness: PROFILE_STUB_HARNESS, runToken: 'tok_run', credentialEnv: {}, profile: STUB_PROFILE, timeoutSeconds: 60, attemptId: ATTEMPT } });
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

  it('counts a renewal from when it was sent, so an answer held up past a sleep does not stretch the lease', async () => {
    let renewals = 0;
    const held: Array<() => void> = [];
    let r: ReturnType<typeof rig>;
    r = rig({
      lease: () => {
        renewals += 1;
        if (renewals < 4) return Response.json({ persisted: true, held: true, expiresAt: 0, leaseMs: LEASE_MS });
        // From the fourth on, answers are held, as a machine that slept holds whatever its socket received.
        return new Promise<Response>((resolve) => {
          held.push(() => { resolve(Response.json({ persisted: true, held: true, expiresAt: 0, leaseMs: LEASE_MS })); });
        });
      },
    });
    try {
      const outcome = r.start();
      await until('a renewal whose answer is held', () => held.length >= 1);
      // The machine sleeps past the lease every renewal so far was sent for,
      // and the held answers land the moment it wakes.
      r.sleep(LEASE_MS + 30_000);
      for (const answer of held) answer();
      await until('the worker to stop the harness', () => r.lines.some((l) => l.includes('slept past')), 3_000)
        .catch((error: Error) => { throw new Error(`${error.message}\n${r.report()}`); });
      expect(await outcome).toEqual({ driven: 1, refused: null });
      expect(r.ended()).toEqual([]);
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);

  it('never lets a late answer to an earlier renewal shorten the lease a later one won', async () => {
    let renewals = 0;
    let first: (() => void) | null = null;
    const r = rig({
      lease: () => {
        renewals += 1;
        // The first renewal's answer is held; every later one is answered at once.
        if (renewals === 1) return new Promise<Response>((resolve) => { first = () => { resolve(Response.json({ persisted: true, held: true, expiresAt: 0, leaseMs: LEASE_MS })); }; });
        return Response.json({ persisted: true, held: true, expiresAt: 0, leaseMs: LEASE_MS });
      },
    });
    try {
      const outcome = r.start();
      await until('the first renewal', () => first !== null);
      // Twelve seconds pass in steps too short to read as sleep, each renewed.
      for (let i = 0; i < 3; i += 1) {
        r.sleep(4_000);
        const at = renewals;
        await until('a renewal after the step', () => renewals > at + 1);
      }
      // A sleep shorter than the latest renewal's lease and longer than the
      // first's; the first renewal's answer lands the moment the machine wakes.
      r.sleep(LEASE_MS - 5_000);
      first!();
      const woke = renewals;
      await until('a renewal after the wake', () => renewals > woke);
      r.release();
      expect(await outcome).toEqual({ driven: 1, refused: null });
      expect({ stopped: r.lines.some((l) => l.includes('slept past')), ended: r.ended().map((x) => x.body.status) }, r.report())
        .toEqual({ stopped: false, ended: ['completed'] });
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);

  it('gives up a claim the Deployment never answers within the cadence, and keeps polling', async () => {
    const claims: Array<{ at: number; abandonedAt: number | null }> = [];
    let r: ReturnType<typeof rig>;
    r = rig({
      once: false,
      claim: (_body, signal) => {
        const claim = { at: Date.now(), abandonedAt: null as number | null };
        claims.push(claim);
        // The first claim takes a run, which sets the cadence; the second never answers; the rest find nothing.
        if (claims.length === 1) return Response.json({ persisted: true, claimed: true, heartbeatMs: HEARTBEAT_MS, leaseMs: LEASE_MS, run: r.run });
        if (claims.length === 2) {
          return new Promise<Response>((_, reject) => {
            signal?.addEventListener('abort', () => { claim.abandonedAt = Date.now(); reject(signal.reason); }, { once: true });
          });
        }
        return Response.json({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 50 });
      },
    });
    try {
      r.release();
      const outcome = r.start();
      await until('a claim after the one that never answered', () => claims.length >= 3, 5_000)
        .catch((error: Error) => { throw new Error(`${error.message}\n${r.report()}`); });
      const hung = claims[1]!;
      expect(hung.abandonedAt !== null && hung.abandonedAt - hung.at <= HEARTBEAT_MS * 5, JSON.stringify(hung)).toBe(true);
      r.stopping.abort();
      expect(await outcome).toEqual({ driven: 1, refused: null });
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);

  it('gives up an end the Deployment never answers within the cadence, says so, and goes on', async () => {
    let asked: { at: number; abandonedAt: number | null } | null = null;
    const r = rig({
      end: (_body, signal) => {
        const end = { at: Date.now(), abandonedAt: null as number | null };
        asked = end;
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => { end.abandonedAt = Date.now(); reject(signal.reason); }, { once: true });
        });
      },
    });
    try {
      r.release();
      const outcome = await Promise.race([r.start(), wait(5_000).then(() => 'hung' as const)]);
      expect(outcome, r.report()).toEqual({ driven: 1, refused: null });
      const end = asked as { at: number; abandonedAt: number | null } | null;
      expect(end !== null && end.abandonedAt !== null && end.abandonedAt - end.at <= HEARTBEAT_MS * 5, JSON.stringify(end)).toBe(true);
      expect(r.lines.some((l) => l.startsWith('could not report the outcome of run_1'))).toBe(true);
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);

  it('notices a sleep with a claim in flight, and waits out the settle before claiming again', async () => {
    let claims = 0;
    let r: ReturnType<typeof rig>;
    r = rig({
      once: false,
      claim: () => {
        claims += 1;
        // The machine sleeps while the first claim is in flight.
        if (claims === 1) r.sleep(10 * 60_000);
        return Response.json({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 50 });
      },
    });
    try {
      const outcome = r.start();
      await until('the wake to be said', () => r.lines.some((l) => l.startsWith('this machine woke')), 3_000)
        .catch((error: Error) => { throw new Error(`${error.message}\n${r.report()}`); });
      await wait(300);
      // It waits out the settle rather than claiming again at once.
      expect({ claims, said: r.lines.find((l) => l.startsWith('this machine woke')) }).toEqual({ claims: 1, said: expect.stringContaining('awake 180s') });
      r.stopping.abort();
      await outcome;
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);
});

/**
 * An answer cut short by the worker's own request deadline.
 *
 * When a deadline fires after an answer's status line arrived and before its
 * body did, Bun's fetch resolves the body as empty rather than rejecting: a 200
 * with nothing to read. `truncatedAt` answers that way, deterministically: the
 * headers now, declaring the body the Deployment sent, and the body ending empty
 * the moment the request's signal aborts.
 */
function truncatedAt(signal: AbortSignal | undefined, sent: Record<string, unknown>): Response {
  const body = JSON.stringify(sent);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal === undefined) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); return; }
      signal.addEventListener('abort', () => { controller.close(); }, { once: true });
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(body).byteLength) } });
}

describe('an answer cut short by the worker\'s own deadline', () => {
  it('is an end that did not arrive, not a Deployment refusing the worker', async () => {
    const r = rig({ end: (body, signal) => truncatedAt(signal, { persisted: true, ended: true, status: body.status }) });
    try {
      r.release();
      expect(await r.start(), r.report()).toEqual({ driven: 1, refused: null });
      expect(r.lines.some((l) => l.startsWith('could not report the outcome of run_1')), r.report()).toBe(true);
      expect(r.lines.some((l) => l.includes('refused the outcome')), r.report()).toBe(false);
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);

  it('is a renewal that did not arrive, which leaves the harness running', async () => {
    const r = rig({ lease: (_body, signal) => truncatedAt(signal, { persisted: true, held: true, expiresAt: 0, leaseMs: LEASE_MS }) });
    try {
      const outcome = r.start();
      await until('several renewals', () => r.sent.filter((s) => s.path === '/worker/lease').length >= 4);
      r.release();
      expect(await outcome, r.report()).toEqual({ driven: 1, refused: null });
      expect({ refused: r.lines.some((l) => l.includes('refused the lease')), ended: r.ended().map((s) => s.body.status) }, r.report())
        .toEqual({ refused: false, ended: ['completed'] });
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);

  it('is a claim that did not arrive, and the worker keeps polling', async () => {
    let claims = 0;
    let r: ReturnType<typeof rig>;
    r = rig({
      once: false,
      claim: (_body, signal) => {
        claims += 1;
        // The first claim takes a run, which sets the cadence the next claim is bounded by.
        if (claims === 1) return Response.json({ persisted: true, claimed: true, heartbeatMs: HEARTBEAT_MS, leaseMs: LEASE_MS, run: r.run });
        if (claims === 2) return truncatedAt(signal, { persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 50 });
        r.stopping.abort();
        return Response.json({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 50 });
      },
    });
    try {
      r.release();
      expect(await r.start(), r.report()).toEqual({ driven: 1, refused: null });
      expect(claims).toBe(3);
    } finally { r.release(); r.stopping.abort(); }
  }, 20_000);
});
