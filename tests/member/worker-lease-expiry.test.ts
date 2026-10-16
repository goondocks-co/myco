import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker } from '@myco/runner/loop.js';
import { profileWorkerServer } from '../helpers/profile-worker-server.js';
import { listingOnly, withRunMcp } from '../helpers/run-mcp-fetch.ts';
import { stubProfileHarness, PROFILE_STUB_DETECTED, PROFILE_STUB_HARNESS, STUB_PROFILE } from '../helpers/stub-profile-harness.ts';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const SERVER = 'https://deployment.example';
const OBSERVATION_BOUND_MS = 30_000;
const SHORT_RENEWAL_MS = 80;
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function until(check: () => boolean, ms = OBSERVATION_BOUND_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('lease fixture condition did not arrive');
    await wait(5);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function rig(options: { heartbeatMs: number; leaseMs: number; renewal: (sequence: number) => Promise<Response> | Response }) {
  const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-lease-expiry-')));
  const release = join(dir, 'release');
  const spawned = join(dir, 'spawned');
  expect(stubProfileHarness({ holdUntil: release, spawnedFile: spawned })).toEqual(PROFILE_STUB_DETECTED);
  const stopping = new AbortController();
  let now = Date.now();
  const clock = () => now;
  const requests: Array<{ path: string; at: number }> = [];
  const lines: Array<{ line: string; at: number }> = [];
  let claimed = false;
  let renewals = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    requests.push({ path, at: clock() });
    if (path === '/worker/claim' && !claimed) {
      claimed = true;
      return Response.json({ persisted: true, claimed: true, heartbeatMs: options.heartbeatMs, leaseMs: options.leaseMs, run: {
        projectId: 'proj_1', id: 'run_expiry', task: 'title-summary', instruction: 'do it', harness: PROFILE_STUB_HARNESS,
        profile: STUB_PROFILE, credentialEnv: {}, runToken: 'fixture_run_token', attemptId: 'fixture_attempt', timeoutSeconds: 600,
      } });
    }
    if (path === '/worker/lease') return options.renewal(++renewals);
    return Response.json({ persisted: true, ended: true, status: 'completed' });
  }) as typeof fetch;
  const start = () => withRunMcp(SERVER, listingOnly, () => runWorker({
    serverUrl: SERVER, token: 'x'.repeat(43), lockDir: null, runRoot: join(dir, 'runs'), only: [PROFILE_STUB_HARNESS],
    once: true, pollIdleMs: 10, fetchImpl: profileWorkerServer(fetchImpl), signal: stopping.signal,
    listModels: async () => [], log: (line) => { lines.push({ line, at: clock() }); },
    clock,
  }));
  const pids = () => existsSync(spawned) ? readFileSync(spawned, 'utf8').trim().split('\n').map(Number) : [];
  return { start, requests, lines, pids, stopping,
    advance: (ms: number) => { now += ms; },
    snapshot: () => ({ requests: requests.slice(-5), renewals, lines: lines.slice(-10), pids: pids(), alive: pids().map(alive) }),
    release: () => writeFileSync(release, ''),
    ended: () => requests.filter(request => request.path === '/worker/end'),
    claimedAt: () => requests.find(request => request.path === '/worker/claim')!.at,
    renewalCount: () => renewals,
    stop: () => lines.find(entry => entry.line.includes('stopping the harness')),
  };
}

const held = (leaseMs: number) => {
  const body = JSON.stringify({ persisted: true, held: true, leaseMs });
  return new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(body).byteLength) } });
};
const unreachable = () => Response.json({ error: 'unavailable' }, { status: 503 });

async function bounded<T>(work: Promise<T>, snapshot: () => unknown): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`lease worker did not settle: ${JSON.stringify(snapshot())}`)), OBSERVATION_BOUND_MS);
    })]);
  } finally { clearTimeout(timer); }
}

async function expectLost(r: ReturnType<typeof rig>, worker: ReturnType<ReturnType<typeof rig>['start']>, expiresAt: () => number, supersededExpiry?: () => number): Promise<void> {
  await bounded(worker, r.snapshot);
  expect(r.ended()).toHaveLength(0);
  expect(r.pids()).toHaveLength(1);
  expect(r.pids().map(alive)).toEqual([false]);
  const lost = r.stop();
  expect(lost).toBeDefined();
  expect(lost!.at).toBeGreaterThanOrEqual(expiresAt());
  if (supersededExpiry !== undefined) expect(lost!.at).toBeLessThan(supersededExpiry());
}

function expectHeld(r: ReturnType<typeof rig>): void {
  expect(r.pids()).toHaveLength(1);
  expect(r.pids().map(alive)).toEqual([true]);
  expect(r.stop()).toBeUndefined();
}

async function observeRenewal(r: ReturnType<typeof rig>, step: () => void): Promise<void> {
  const previous = r.renewalCount();
  step();
  await until(() => r.renewalCount() > previous || r.stop() !== undefined);
}

describe('a worker stops at its accepted lease expiry', () => {
  it('stops an awake harness when every renewal is unreachable', async () => {
    const r = rig({ heartbeatMs: 30, leaseMs: 300, renewal: unreachable });
    const worker = r.start();
    try {
      await until(() => r.pids().length === 1 && r.renewalCount() >= 1);
      r.advance(300);
      await expectLost(r, worker, () => r.claimedAt() + 300);
    }
    finally { r.release(); r.stopping.abort(); await bounded(worker, r.snapshot); }
  }, OBSERVATION_BOUND_MS * 3);

  it('expires a short lease before a longer heartbeat can run', async () => {
    const r = rig({ heartbeatMs: OBSERVATION_BOUND_MS * 2, leaseMs: 300, renewal: unreachable });
    const worker = r.start();
    try {
      await until(() => r.pids().length === 1);
      r.advance(300);
      await expectLost(r, worker, () => r.claimedAt() + 300);
      expect(r.renewalCount()).toBe(0);
    }
    finally { r.release(); r.stopping.abort(); await bounded(worker, r.snapshot); }
  }, OBSERVATION_BOUND_MS * 3);

  it('checks awake clock expiry on a heartbeat while renewal requests never return', async () => {
    const r = rig({ heartbeatMs: 30, leaseMs: 1_000, renewal: () => new Promise<Response>(() => {}) });
    const worker = r.start();
    try {
      await until(() => r.pids().length === 1 && r.renewalCount() >= 3);
      r.advance(1_000);
      await expectLost(r, worker, () => r.claimedAt() + 1_000);
    } finally { r.release(); r.stopping.abort(); await bounded(worker, r.snapshot); }
  }, OBSERVATION_BOUND_MS * 3);

  it('accepts a newer renewal that shortens the initial lease', async () => {
    const r = rig({ heartbeatMs: 150, leaseMs: 10_000, renewal: sequence => sequence === 1 ? held(SHORT_RENEWAL_MS) : unreachable() });
    const worker = r.start();
    try {
      await until(() => r.pids().length === 1 && r.renewalCount() >= 2);
      await observeRenewal(r, () => r.advance(SHORT_RENEWAL_MS - 1));
      expectHeld(r);
      r.advance(1);
      await expectLost(r, worker, () => r.requests.find(request => request.path === '/worker/lease')!.at + SHORT_RENEWAL_MS, () => r.claimedAt() + 10_000);
    }
    finally { r.release(); r.stopping.abort(); await bounded(worker, r.snapshot); }
  }, OBSERVATION_BOUND_MS * 3);

  it('ignores an older late successful reply that would extend a newer short lease', async () => {
    let answerOld: () => void = () => {};
    const r = rig({ heartbeatMs: 80, leaseMs: 10_000, renewal: sequence => sequence === 1
      ? new Promise<Response>((resolve) => { answerOld = () => resolve(held(10_000)); })
      : sequence === 2 ? held(150) : unreachable(),
    });
    const worker = r.start();
    try {
      await until(() => r.pids().length === 1 && r.renewalCount() >= 3);
      await observeRenewal(r, answerOld);
      r.advance(150);
      await expectLost(r, worker, () => r.requests.filter(request => request.path === '/worker/lease')[1]!.at + 150, () => r.claimedAt() + 10_000);
    } finally { answerOld(); r.release(); r.stopping.abort(); await bounded(worker, r.snapshot); }
  }, OBSERVATION_BOUND_MS * 3);

  it('ignores an older late successful reply that would shorten a newer live lease', async () => {
    let answerOld: () => void = () => {};
    const r = rig({ heartbeatMs: 80, leaseMs: 10_000, renewal: sequence => sequence === 1
      ? new Promise<Response>((resolve) => { answerOld = () => resolve(held(1)); }) : sequence === 2 ? held(1_000) : unreachable(),
    });
    const worker = r.start();
    try {
      await until(() => r.pids().length === 1 && r.renewalCount() >= 3);
      await observeRenewal(r, answerOld);
      await observeRenewal(r, () => r.advance(150));
      expectHeld(r);
      r.release();
      expect(await worker).toEqual({ driven: 1, refused: null });
      expect(r.ended()).toHaveLength(1);
    } finally { answerOld(); r.release(); r.stopping.abort(); await bounded(worker, r.snapshot); }
  }, OBSERVATION_BOUND_MS * 3);
});
