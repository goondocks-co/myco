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
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function until(check: () => boolean, ms = 2_000): Promise<void> {
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

function rig(options: { heartbeatMs: number; leaseMs: number; renewal: (sequence: number) => Promise<Response> | Response; clock?: () => number }) {
  const dir = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-lease-expiry-')));
  const release = join(dir, 'release');
  const spawned = join(dir, 'spawned');
  expect(stubProfileHarness({ holdUntil: release, spawnedFile: spawned })).toEqual(PROFILE_STUB_DETECTED);
  const stopping = new AbortController();
  const requests: Array<{ path: string; at: number }> = [];
  const lines: Array<{ line: string; at: number }> = [];
  let claimed = false;
  let renewals = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    requests.push({ path, at: Date.now() });
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
    listModels: async () => [], log: (line) => { lines.push({ line, at: Date.now() }); },
    clock: options.clock,
  }));
  const pids = () => existsSync(spawned) ? readFileSync(spawned, 'utf8').trim().split('\n').map(Number) : [];
  return { start, requests, lines, pids, stopping,
    release: () => writeFileSync(release, ''),
    ended: () => requests.filter(request => request.path === '/worker/end'),
    claimedAt: () => requests.find(request => request.path === '/worker/claim')!.at,
    renewalCount: () => renewals,
  };
}

const held = (leaseMs: number) => {
  const body = JSON.stringify({ persisted: true, held: true, leaseMs });
  return new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(body).byteLength) } });
};
const unreachable = () => Response.json({ error: 'unavailable' }, { status: 503 });

async function expectLost(r: ReturnType<typeof rig>, worker: ReturnType<ReturnType<typeof rig>['start']>, latestStopMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([worker.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 3_000); })]);
    expect(settled).toBe(true);
    expect(r.ended()).toHaveLength(0);
    expect(r.pids()).toHaveLength(1);
    expect(r.pids().map(alive)).toEqual([false]);
    const lost = r.lines.find(entry => entry.line.includes('stopping the harness'));
    expect(lost).toBeDefined();
    expect(lost!.at - r.claimedAt()).toBeLessThan(latestStopMs);
  } finally { clearTimeout(timer); }
}

describe('a worker stops at its accepted lease expiry', () => {
  it('stops an awake harness when every renewal is unreachable', async () => {
    const r = rig({ heartbeatMs: 30, leaseMs: 300, renewal: unreachable });
    const worker = r.start();
    try { await expectLost(r, worker, 500); }
    finally { r.release(); r.stopping.abort(); await worker; }
  }, 10_000);

  it('expires a short lease before a longer heartbeat can run', async () => {
    const r = rig({ heartbeatMs: 1_000, leaseMs: 300, renewal: unreachable });
    const worker = r.start();
    try { await expectLost(r, worker, 500); }
    finally { r.release(); r.stopping.abort(); await worker; }
  }, 10_000);

  it('checks awake clock expiry on a heartbeat while renewal requests never return', async () => {
    let offset = 0;
    const r = rig({ heartbeatMs: 30, leaseMs: 300, renewal: () => new Promise<Response>(() => {}), clock: () => Date.now() + offset });
    const worker = r.start();
    try {
      await until(() => r.renewalCount() >= 3);
      offset += 200;
      await expectLost(r, worker, 250);
    } finally { r.release(); r.stopping.abort(); await worker; }
  }, 10_000);

  it('accepts a newer renewal that shortens the initial lease', async () => {
    const r = rig({ heartbeatMs: 150, leaseMs: 10_000, renewal: sequence => sequence === 1 ? held(80) : unreachable() });
    const worker = r.start();
    try { await expectLost(r, worker, 280); }
    finally { r.release(); r.stopping.abort(); await worker; }
  }, 10_000);

  it('ignores an older late successful reply that would extend a newer short lease', async () => {
    let answerOld: () => void = () => {};
    const r = rig({ heartbeatMs: 80, leaseMs: 10_000, renewal: sequence => sequence === 1
      ? new Promise<Response>((resolve) => { answerOld = () => resolve(held(10_000)); })
      : sequence === 2 ? held(150) : unreachable(),
    });
    const worker = r.start();
    try {
      await until(() => r.renewalCount() >= 2);
      await wait(10);
      answerOld();
      await expectLost(r, worker, 500);
    } finally { answerOld(); r.release(); r.stopping.abort(); await worker; }
  }, 10_000);

  it('ignores an older late successful reply that would shorten a newer live lease', async () => {
    let answerOld: () => void = () => {};
    const r = rig({ heartbeatMs: 80, leaseMs: 10_000, renewal: sequence => sequence === 1
      ? new Promise<Response>((resolve) => { answerOld = () => resolve(held(1)); }) : held(1_000),
    });
    const worker = r.start();
    try {
      await until(() => r.renewalCount() >= 2);
      await wait(10);
      answerOld();
      await wait(150);
      expect(r.pids()).toHaveLength(1);
      expect(r.pids().map(alive)).toEqual([true]);
      expect(r.lines.some(entry => entry.line.includes('stopping the harness'))).toBe(false);
      r.release();
      expect(await worker).toEqual({ driven: 1, refused: null });
      expect(r.ended()).toHaveLength(1);
    } finally { answerOld(); r.release(); r.stopping.abort(); await worker; }
  }, 10_000);
});
