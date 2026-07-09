/**
 * Tests for the MEMBER side of the routed plan-content companion push (plan C7 —
 * `capture/plan-drain.ts`). Hermetic: a fake host transport, an in-memory plan-file
 * reader (so content/dedup semantics are driven precisely), and either an in-memory
 * or a real fs store under a tmp `MYCO_TEAM_HOME` (persistence-across-restart).
 *
 * The load-bearing properties: (1) a plan-dir write ENQUEUES via the same
 * `isPlanWriteEvent` predicate the local path uses; (2) an unchanged file is a
 * member-side no-op (content-hash high-water); (3) `flushBeforeForward` ships
 * pending plan content — the seam the host proxy calls BEFORE forwarding
 * `/events/stop`, so plan content is present when the host's Stop backstop mines.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import {
  PlanDrainQueue,
  createFsPlanDrainStore,
  derivePlanRef,
  defaultPlanTransport,
  type PlanChunkRequest,
  type PlanDrainEntry,
  type PlanDrainStore,
  type PlanFileReader,
  type PlanPostTransport,
} from '@myco/capture/plan-drain';
import type { PlanWatchConfig } from '@myco/daemon/plan-capture';
import type { RemoteTarget } from '@myco/host/routing';
import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import { JobRunner } from '@myco/daemon/job-runner';
import { REQUEST_CONTEXT_HEADERS } from '@myco/grove/request-context';
import {
  assertGroveProjectId,
  createGroveId,
  createHostId,
  createProjectId,
} from '@myco/grove/ids';
import { upsertHost, writeHostSecret, type HostRecord } from '@myco/host/registry';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { HOST_BEARER_SECRET } from '@myco/constants';

const MACHINE = 'alice_a1b2c3d4';
const HOST_A = 'host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOST_B = 'host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const WATCH: PlanWatchConfig = { watchDirs: ['/plans'], projectRoot: '/', extensions: ['.md'] };

// --- fakes -----------------------------------------------------------------

/** In-memory plan files the {@link PlanFileReader} reads. */
function memFiles() {
  const files = new Map<string, string>();
  const reader: PlanFileReader = { read: (p) => (files.has(p) ? files.get(p)! : null) };
  return {
    reader,
    set(p: string, content: string) { files.set(p, content); },
    remove(p: string) { files.delete(p); },
  };
}

/** A fake host recording every plan POST with its dial target. Always 200. */
function fakeHost() {
  const calls: Array<{ hostId: string; proxyPort?: number; body: PlanChunkRequest }> = [];
  const transport: PlanPostTransport = async (target, body) => {
    calls.push({ hostId: target.host.host_id, proxyPort: target.host.proxy_port, body });
    return { status: 200, planId: `plan_${calls.length}` };
  };
  return { transport, calls };
}

function memStore(): PlanDrainStore {
  const m = new Map<string, PlanDrainEntry>();
  const key = (h: string, s: string, r: string) => `${h}|${s}|${r}`;
  return {
    list: () => [...m.values()],
    listForHost: (h) => [...m.values()].filter((e) => e.host_id === h),
    get: (h, s, r) => m.get(key(h, s, r)) ?? null,
    put: (e) => { m.set(key(e.host_id, e.session_id, e.plan_ref), { ...e }); },
    remove: (h, s, r) => { m.delete(key(h, s, r)); },
    purgeHost: (h) => { for (const [k, e] of [...m]) if (e.host_id === h) m.delete(k); },
    purgeProject: (h, p) => { for (const [k, e] of [...m]) if (e.host_id === h && e.project_id === p) m.delete(k); },
  };
}

function target(opts: { hostId?: string; proxyPort?: number; overlay?: string; projectId?: string } = {}): RemoteTarget {
  return {
    projectId: (opts.projectId ?? 'proj_0123456789abcdef0123456789abcdef') as RemoteTarget['projectId'],
    groveId: 'grove_0123456789abcdef0123456789abcdef',
    host: {
      host_id: opts.hostId ?? HOST_A,
      label: 'H',
      overlay_address: opts.overlay ?? '127.0.0.1:9',
      protocol_version: 1,
      proxy_port: opts.proxyPort,
    },
    bearer: 'b',
  };
}

/** PIN the mid-turn throttle off so the only drain is the explicit flush/drainAll. */
const noThrottle = {
  now: () => 1000,
  intervalMs: 100_000,
  setTimer: (() => 0) as unknown as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
  clearTimer: () => {},
};

const planEvent = (sessionId: string, planPath: string) => ({
  session_id: sessionId,
  type: 'tool_use',
  tool_name: 'Write',
  tool_input: { file_path: planPath },
  agent: 'claude-code',
});

const waitFor = async (pred: () => boolean, ms = 1000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// ---------------------------------------------------------------------------
// derivePlanRef
// ---------------------------------------------------------------------------

describe('derivePlanRef', () => {
  test('is stable per path and a filesystem-safe segment (pl_ + 32 hex)', () => {
    expect(derivePlanRef('/plans/a.md')).toBe(derivePlanRef('/plans/a.md'));
    expect(derivePlanRef('/plans/a.md')).toMatch(/^pl_[0-9a-f]{32}$/);
  });
  test('depends on the path (distinct plan files → distinct refs)', () => {
    expect(derivePlanRef('/plans/a.md')).not.toBe(derivePlanRef('/plans/b.md'));
  });
});

// ---------------------------------------------------------------------------
// Detection + content-hash dedup
// ---------------------------------------------------------------------------

describe('plan-write detection + content-hash dedup', () => {
  test('a plan-dir write enqueues and flush ships the whole file content once', async () => {
    const files = memFiles();
    files.set('/plans/x.md', '# Plan\n\nbody');
    const host = fakeHost();
    const store = memStore();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();

    q.noteCollect(t, planEvent('s', '/plans/x.md'));
    expect(store.list()).toHaveLength(1); // detected + enqueued
    await q.flushBeforeForward(t);

    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].body).toMatchObject({ machine_id: MACHINE, session_id: 's', plan_path: '/plans/x.md', content: '# Plan\n\nbody' });
  });

  test('re-flushing an UNCHANGED file is a member-side no-op (no second POST)', async () => {
    const files = memFiles();
    files.set('/plans/x.md', 'v1');
    const host = fakeHost();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store: memStore(), transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, planEvent('s', '/plans/x.md'));
    await q.flushBeforeForward(t);
    await q.flushBeforeForward(t); // content unchanged → dedup
    expect(host.calls).toHaveLength(1);
  });

  test('a CHANGED file re-ships on the next flush (content-hash high-water advanced)', async () => {
    const files = memFiles();
    files.set('/plans/x.md', 'v1');
    const host = fakeHost();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store: memStore(), transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, planEvent('s', '/plans/x.md'));
    await q.flushBeforeForward(t);
    files.set('/plans/x.md', 'v2 edited');
    q.noteCollect(t, planEvent('s', '/plans/x.md'));
    await q.flushBeforeForward(t);
    expect(host.calls.map((c) => c.body.content)).toEqual(['v1', 'v2 edited']);
  });

  test('a NON-plan-dir write does not enqueue', () => {
    const files = memFiles();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store: memStore(), fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, { session_id: 's', type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/src/index.ts' } });
    q.noteCollect(t, { session_id: 's', type: 'tool_use', tool_name: 'Read', tool_input: { file_path: '/plans/x.md' } });
    expect(q.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-host — distinct proxy_port dial targets
// ---------------------------------------------------------------------------

describe('multi-host', () => {
  test('two attached projects on two hosts push through their OWN proxy_port', async () => {
    const files = memFiles();
    files.set('/plans/a.md', 'A');
    files.set('/plans/b.md', 'B');
    const host = fakeHost();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store: memStore(), transport: host.transport, fileReader: files.reader, ...noThrottle });
    const tA = target({ hostId: HOST_A, proxyPort: 4111, projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const tB = target({ hostId: HOST_B, proxyPort: 4222, projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    q.noteCollect(tA, planEvent('sa', '/plans/a.md'));
    q.noteCollect(tB, planEvent('sb', '/plans/b.md'));
    await q.flushBeforeForward(tA);
    await q.flushBeforeForward(tB);
    expect(new Set(host.calls.filter((c) => c.hostId === HOST_A).map((c) => c.proxyPort))).toEqual(new Set([4111]));
    expect(new Set(host.calls.filter((c) => c.hostId === HOST_B).map((c) => c.proxyPort))).toEqual(new Set([4222]));
  });
});

// ---------------------------------------------------------------------------
// Durability discipline — persistence, prune-only-acked, purge, file-gone
// ---------------------------------------------------------------------------

describe('durability discipline', () => {
  let tmp: string;
  let saved: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-drain-'));
    saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the acked content-hash persists across a simulated daemon restart (fs store)', async () => {
    const files = memFiles();
    files.set('/plans/x.md', 'stable');
    const t = target();

    const host1 = fakeHost();
    const q1 = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store: createFsPlanDrainStore(), transport: host1.transport, fileReader: files.reader, ...noThrottle });
    q1.noteCollect(t, planEvent('s', '/plans/x.md'));
    await q1.flushBeforeForward(t);
    expect(host1.calls).toHaveLength(1);

    // A fresh queue (restart) reads the SAME store dir; the file is unchanged.
    const host2 = fakeHost();
    const q2 = new PlanDrainQueue({
      machineId: MACHINE, planWatchConfig: WATCH, store: createFsPlanDrainStore(), transport: host2.transport,
      fileReader: files.reader, resolveHostTarget: () => t, ...noThrottle,
    });
    await q2.drainAll();
    expect(host2.calls).toHaveLength(0); // resumed from the persisted hash — nothing to re-ship
  });

  test('prune-only-acked: a failed POST leaves the hash unadvanced (retry next tick)', async () => {
    const files = memFiles();
    files.set('/plans/x.md', 'body');
    const store = memStore();
    const t = target();
    const throwing: PlanPostTransport = async () => { throw new Error('network down'); };
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: throwing, fileReader: files.reader, ...noThrottle });
    q.noteCollect(t, planEvent('s', '/plans/x.md'));
    await q.flushBeforeForward(t); // never throws into the caller
    const ref = derivePlanRef('/plans/x.md');
    expect(store.get(HOST_A, 's', ref)!.acked_hash).toBeNull(); // NOT advanced
    expect(q.pendingCount()).toBe(1);

    // A reachable host then drains it — the entry was retained, nothing lost.
    const host = fakeHost();
    const q2 = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    await q2.flushBeforeForward(t);
    expect(host.calls).toHaveLength(1);
    expect(store.get(HOST_A, 's', ref)!.acked_hash).not.toBeNull();
  });

  test('purge-on-detach clears the project entries for that host', () => {
    const files = memFiles();
    files.set('/plans/a.md', 'a');
    const store = memStore();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, planEvent('s', '/plans/a.md'));
    expect(store.list()).toHaveLength(1);
    q.purgeProject(t.host.host_id, t.projectId as string);
    expect(store.list()).toHaveLength(0);
  });

  test('a plan file that no longer exists is not pending and is removed on drain', async () => {
    const files = memFiles();
    files.set('/plans/x.md', 'here');
    const store = memStore();
    const host = fakeHost();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, planEvent('s', '/plans/x.md'));
    const ref = derivePlanRef('/plans/x.md');
    files.remove('/plans/x.md'); // deleted before it ever drained
    expect(q.pendingCount()).toBe(0); // unreachable content → must not hold the machine awake
    await q.flushBeforeForward(t);
    expect(store.get(HOST_A, 's', ref)).toBeNull(); // inert entry removed
    expect(host.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pendingCount → JobRunner deep-sleep hold
// ---------------------------------------------------------------------------

describe('deep-sleep hold', () => {
  test('pendingCount drives the JobRunner hold while plan content is un-shipped', async () => {
    const files = memFiles();
    files.set('/plans/x.md', 'unsent');
    const store = memStore();
    const host = fakeHost();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, planEvent('s', '/plans/x.md'));
    expect(q.pendingCount()).toBe(1);

    const runner = new JobRunner({ concurrency: 2, logger: new DaemonLogger(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-jr-'))) });
    runner.register({ name: 'team-host-plan-drain', runIn: ['sleep'], kind: 'housekeeping', hold: { pending: () => q.pendingCount() }, fn: async () => {} });
    expect(runner.providesHold()).toBe('team-host-plan-drain'); // pending → deep sleep inhibited

    await q.flushBeforeForward(t); // ships it
    expect(q.pendingCount()).toBe(0);
    expect(runner.providesHold()).toBeNull(); // no pending → deep sleep allowed
  });
});

// ---------------------------------------------------------------------------
// Default transport — tenancy headers the host binds the Grove DB from
// ---------------------------------------------------------------------------

describe('defaultPlanTransport (wire headers)', () => {
  let server: http.Server;
  let received: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string } | null;

  beforeEach(async () => {
    received = null;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf-8') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, plan_id: 'plan_xyz' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  });
  afterEach(async () => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('POSTs /routed-capture/plan with the tenancy claims (project/grove/machine/session) + host bearer', async () => {
    const port = (server.address() as AddressInfo).port;
    const t = target({ overlay: `127.0.0.1:${port}` });
    const res = await defaultPlanTransport(t, {
      machine_id: MACHINE, session_id: 'sess-42', plan_path: '/plans/x.md', content: '# hi',
    });
    expect(res.status).toBe(200);
    expect(res.planId).toBe('plan_xyz');
    expect(received).not.toBeNull();
    expect(received!.method).toBe('POST');
    expect(received!.url).toBe('/routed-capture/plan');
    expect(received!.headers.authorization).toBe('Bearer b');
    expect(received!.headers[REQUEST_CONTEXT_HEADERS.projectId]).toBe(String(t.projectId));
    expect(received!.headers[REQUEST_CONTEXT_HEADERS.groveId]).toBe(t.groveId);
    expect(received!.headers[REQUEST_CONTEXT_HEADERS.machineId]).toBe(MACHINE);
    expect(received!.headers[REQUEST_CONTEXT_HEADERS.sessionId]).toBe('sess-42');
    // The member NEVER sends x-myco-auth — the host stamps its own local bearer.
    expect(received!.headers[REQUEST_CONTEXT_HEADERS.projectId]).toBeDefined();
    expect(received!.headers['x-myco-auth']).toBeUndefined();
    expect(JSON.parse(received!.body)).toMatchObject({ session_id: 'sess-42', plan_path: '/plans/x.md', content: '# hi' });
  });
});

// ---------------------------------------------------------------------------
// Flush ordering through the REAL host-proxy seam (plan content before Stop)
// ---------------------------------------------------------------------------

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;

describe('flush-before-Stop ordering (real dispatch chokepoint)', () => {
  let tmp: string;
  let saved: string | undefined;
  let server: DaemonServer;
  let base: string;
  let authToken: string;
  let host: ReturnType<typeof fakeHost>;
  let files: ReturnType<typeof memFiles>;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-cp1-'));
    saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    host = fakeHost();
    files = memFiles();
    files.set('/plans/x.md', '# routed plan\n\nshipped on Stop flush');
    const q = new PlanDrainQueue({
      machineId: MACHINE, planWatchConfig: WATCH, store: memStore(), transport: host.transport, fileReader: files.reader, ...noThrottle,
    });
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      hostProxyDeps: { ...q.proxyDeps(), bufferAppend: () => { /* keep the collect buffer off disk */ } },
    });
    // Stub both collect routes so the router matches them and the collect proxy
    // (attached-project classification) engages — the same setup the transcript
    // chokepoint test uses. The local handlers never run for a routed request.
    server.registerRoute('POST', '/events', async () => ({ body: { ok: true } }));
    server.registerRoute('POST', '/events/stop', async () => ({ body: { ok: true } }));
    await server.start(0);
    base = `http://127.0.0.1:${server.port}`;
    authToken = server.getAuthToken();
  });
  afterEach(async () => {
    await server.stop();
    if (saved === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a plan-write /events note enqueues; /events/stop flushes the plan content before forwarding', async () => {
    const projectId = assertGroveProjectId(createProjectId());
    const rec: HostRecord = {
      host_id: createHostId(),
      label: 'Mac Studio',
      overlay_address: '127.0.0.1:59', // dead port: the background /events forward fails AFTER the note/flush
      protocol_version: 1,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: createGroveId(), project_id: projectId }],
    };
    upsertHost(rec);
    writeHostSecret(rec.host_id, HOST_BEARER_SECRET, 'host-bearer');

    // 1) A plan-dir write forwarded via /events → the drain enqueues (no flush yet).
    const w = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-myco-project-id': projectId, 'x-myco-auth': authToken },
      body: JSON.stringify(planEvent('s', '/plans/x.md')),
    });
    expect(w.status).toBe(200);
    expect(host.calls).toHaveLength(0); // /events is not a flush route — nothing shipped yet

    // 2) /events/stop → the proxy flushes pending plan content BEFORE forwarding.
    const res = await fetch(`${base}/events/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-myco-project-id': projectId, 'x-myco-auth': authToken },
      body: JSON.stringify({ session_id: 's', type: 'stop', transcript_path: '/m/s.jsonl' }),
    });
    expect(res.status).toBe(200);

    await waitFor(() => host.calls.length > 0);
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].body).toMatchObject({ session_id: 's', plan_path: '/plans/x.md', content: '# routed plan\n\nshipped on Stop flush' });
  });
});
