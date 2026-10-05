import { describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driverFor } from '@myco/runner/drivers/registry.js';
import * as repository from '@myco/runner/repository.js';
import { runWorker } from '@myco/runner/loop.js';
import { spawnOwnedGroup } from '@myco/runner/process-group.js';
import { retryPendingRunDirectoryDiscards } from '@myco/runner/run-directory.js';
import type { RunEvent } from '@myco/runner/events.js';
import { stubProfileHarness, PROFILE_STUB_DETECTED, PROFILE_STUB_HARNESS, STUB_PROFILE } from '../helpers/stub-profile-harness.ts';
import { profileWorkerServer } from '../helpers/profile-worker-server.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const SERVER = 'https://deployment.example';
const BOUND_MS = 8_000;
const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

async function exercise(kind: 'return' | 'checkout' | 'both', mode: 'hung' | 'fast' | 'deadline' | 'lease-deadline' | 'renewed' | 'run-bound' | 'lease-only' | 'late-error', ownedProcess = false) {
  expect(stubProfileHarness()).toEqual(PROFILE_STUB_DETECTED);
  const root = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-cleanup-deadline-')));
  const release = deferred();
  const returned = deferred();
  const disposed = deferred();
  const stopping = new AbortController();
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const lines: string[] = [];
  let offset = 0;
  let starts = 0;
  let returning = false;
  let disposing = false;
  let awake = false;
  const childStopping = new AbortController();
  let owner: ReturnType<typeof spawnOwnedGroup> | undefined;
  const cleanup = async (at: 'return' | 'checkout') => {
    if (at === 'return') { returning = true; returned.resolve(); }
    else { disposing = true; disposed.resolve(); }
    if (kind !== 'both' && kind !== at) return;
    if (mode === 'fast') { await wait(20); return; }
    if (mode === 'renewed') { await wait(250); return; }
    if (mode === 'deadline') { offset += 80_000; return; }
    if (mode === 'run-bound') { offset += 2_000; return; }
    if (mode === 'lease-only') return;
    if (mode === 'lease-deadline') { offset += 2_000_000; return; }
    await release.promise;
    if (mode === 'late-error') throw new Error('late cleanup fixture failure');
  };
  const runSpy = spyOn(driverFor(PROFILE_STUB_HARNESS)!, 'run').mockImplementation((spec) => {
    starts += 1;
    if (ownedProcess) owner = spawnOwnedGroup(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { cwd: spec.scratchDir, stdio: 'ignore' }, childStopping.signal);
    let next = 0;
    const iterator: AsyncIterator<RunEvent> = {
      next: async () => {
        if (next++ === 0) {
          if (mode === 'run-bound') offset += 70_000;
          if (mode === 'lease-only' || mode === 'late-error') offset += 1_000_001;
          return { done: false, value: { kind: 'tool_call', name: 'mcp__myco__myco_run', status: 'ok' } };
        }
        return next === 2 ? { done: false, value: { kind: 'ended', stop: 'end_turn', detail: null } } : { done: true, value: undefined };
      },
      return: async () => { await cleanup('return'); return { done: true, value: undefined }; },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  });
  const checkoutSpy = spyOn(repository, 'prepareWorkerCheckout').mockImplementation(async (_spec, scratchDir) => {
    const source = join(scratchDir, 'repo');
    mkdirSync(source);
    return { root: source, commit: 'a'.repeat(40), dispose: () => cleanup('checkout') };
  });
  let claimed = false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    posts.push({ path, body });
    if (path === '/worker/claim' && !claimed) {
      claimed = true;
      return Response.json({ persisted: true, claimed: true, heartbeatMs: mode === 'renewed' ? 25 : 100, leaseMs: mode === 'renewed' ? 100 : 1_000_000, run: {
        projectId: 'proj_1', id: 'run_cleanup', task: 'title-summary', harness: PROFILE_STUB_HARNESS,
        instruction: 'do it', instructions: null, runToken: 'run_token', credentialEnv: {}, profile: STUB_PROFILE, timeoutSeconds: mode === 'lease-only' || mode === 'late-error' ? 100_000 : 60,
        ...(kind === 'return' ? {} : { repository: { url: 'https://example.test/team/source', branch: 'main', historyDepth: 10 } }),
      } });
    }
    if (path === '/worker/lease') return Response.json({ persisted: true, held: true, leaseMs: mode === 'renewed' ? 100 : 1_000_000 });
    return Response.json({ persisted: true, ended: true, status: body.status });
  }) as typeof fetch;
  const worker = runWorker({ serverUrl: SERVER, token: 'x'.repeat(43), lockDir: null, runRoot: root, only: [PROFILE_STUB_HARNESS],
    once: true, pollIdleMs: 10, signal: stopping.signal, fetchImpl: profileWorkerServer(fetchImpl),
    clock: () => Date.now() + offset, listModels: async () => [], log: (line) => lines.push(line),
    keepAwake: () => { awake = true; return () => { awake = false; }; },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await (kind === 'checkout' ? disposed.promise : returned.promise);
    expect(awake).toBe(true);
    const done = await Promise.race([worker.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), BOUND_MS); })]);
    expect({ done, awake, endings: posts.filter(p => p.path === '/worker/end').map(p => p.body.status), starts, returning, disposing })
      .toMatchObject({ done: true, awake: false, endings: mode === 'fast' || mode === 'renewed' ? ['completed'] : [], starts: 1, returning: true, disposing: kind !== 'return' });
    if (mode === 'hung') {
      const before = posts.filter(p => p.path === '/worker/lease').length;
      await wait(250);
      expect(posts.filter(p => p.path === '/worker/lease')).toHaveLength(before);
    }
    if (mode === 'late-error') {
      release.resolve();
      await wait(20);
      expect(lines.some(line => line.includes('late cleanup fixture failure'))).toBe(true);
      expect(posts.filter(p => p.path === '/worker/end')).toHaveLength(0);
    }
  } finally {
    clearTimeout(timer);
    release.resolve();
    stopping.abort();
    await worker;
    childStopping.abort();
    await owner?.dispose();
    retryPendingRunDirectoryDiscards();
    runSpy.mockRestore();
    checkoutSpy.mockRestore();
  }
}

describe('worker attempt cleanup is bounded', () => {
  it('permits healthy cleanup while several short leases renew', () => exercise('return', 'renewed'), 10_000);
  it('reports nothing after iterator cleanup times out while a registered process still owns the directory', () => exercise('return', 'hung', true), 20_000);
  for (const kind of ['return', 'checkout', 'both'] as const) it(`does not renew forever while ${kind} cleanup never settles`, () => exercise(kind, 'hung'), 20_000);
  for (const kind of ['return', 'checkout'] as const) {
    it(`reports a healthy run only after ${kind} cleanup settles`, () => exercise(kind, 'fast'), 10_000);
    it(`reports nothing when ${kind} cleanup crosses the fixed run deadline`, () => exercise(kind, 'deadline'), 10_000);
    it(`reports nothing when ${kind} cleanup crosses the lease deadline`, () => exercise(kind, 'lease-deadline'), 10_000);
    it(`keeps the fixed run cleanup deadline when ${kind} disposal begins near it`, () => exercise(kind, 'run-bound'), 10_000);
    it(`checks current lease ownership before ${kind} disposal begins`, () => exercise(kind, 'lease-only'), 10_000);
    it(`surfaces ${kind} cleanup errors that arrive after attempt abandonment`, () => exercise(kind, 'late-error'), 10_000);
  }
});
