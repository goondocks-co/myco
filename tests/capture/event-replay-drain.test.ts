/**
 * Tests for the MEMBER-side attach-aware LIVE-EVENT replay drain (plan C5,
 * capture-push §7 task 5). Hermetic — no real network. Two rigs:
 *
 *  - injected fakes (in-memory buffer reader, in-memory store, recording
 *    transport) that drive the enumeration / route-correctness / at-least-once /
 *    multi-host semantics precisely; and
 *  - a real-filesystem rig under tmp `MYCO_HOME` + `MYCO_TEAM_HOME` proving the
 *    never-materialize invariant (draining an attached project creates NO local
 *    Grove DB and enumerates from the ATTACH REGISTRY, not `listGroves`) plus the
 *    real default transport's wire shape against a localhost fake host.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  EventReplayDrainQueue,
  createEventReplayDrainQueue,
  createFsReplayStore,
  listAttachedReplayTargets,
  type AttachedReplayTarget,
  type CollectBufferReader,
  type EventReplayTransport,
  type ReplayEntry,
  type ReplayStore,
} from '@myco/capture/event-replay-drain';
import {
  COLLECT_ROUTE_BUFFER_KEY,
  DEFAULT_COLLECT_ROUTE,
  readCollectRoute,
  stampCollectRoute,
  stripCollectRoute,
} from '@myco/capture/collect-buffer-route';
import { EventBuffer } from '@myco/capture/buffer';
import { resolveProjectBufferDir } from '@myco/grove/paths';
import { REQUEST_CONTEXT_HEADERS } from '@myco/grove/request-context';
import { upsertHost, writeHostSecret } from '@myco/host/registry';
import { listGroves } from '@myco/grove/registry';
import type { RemoteTarget } from '@myco/host/routing';
import { HOST_BEARER_SECRET, HOST_PROTOCOL_HEADER } from '@myco/constants';

const MACHINE = 'alice_a1b2c3d4';
const HOST_A = 'host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOST_B = 'host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GROVE_A = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GROVE_B = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PROJ_A = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJ_B = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// --- fakes -----------------------------------------------------------------

/** A recording transport with a per-call status hook (default 200 = ack). */
function recordingSink() {
  const calls: Array<{ hostId: string; proxyPort?: number; route: string; sessionId: string; body: Record<string, unknown> }> = [];
  let statusFor: (callNo: number) => number = () => 200;
  const transport: EventReplayTransport = async (t, route, sessionId, body) => {
    calls.push({ hostId: t.host.host_id, proxyPort: t.host.proxy_port, route, sessionId, body });
    return { status: statusFor(calls.length) };
  };
  return { transport, calls, setStatus(fn: (callNo: number) => number) { statusFor = fn; } };
}

/** In-memory collector buffer: `bufferDir → sessionId → records` (in order). */
function memBuffer() {
  const dirs = new Map<string, Map<string, Record<string, unknown>[]>>();
  const reader: CollectBufferReader = {
    listSessions: (dir) => [...(dirs.get(dir)?.keys() ?? [])],
    readRecords: (dir, s) => [...(dirs.get(dir)?.get(s) ?? [])],
  };
  const append = (dir: string, s: string, record: Record<string, unknown>) => {
    const byDir = dirs.get(dir) ?? new Map<string, Record<string, unknown>[]>();
    const recs = byDir.get(s) ?? [];
    recs.push(record);
    byDir.set(s, recs);
    dirs.set(dir, byDir);
  };
  return { reader, append };
}

function memStore(): ReplayStore {
  const m = new Map<string, ReplayEntry>();
  const key = (h: string, s: string) => `${h}|${s}`;
  return {
    get: (h, s) => m.get(key(h, s)) ?? null,
    put: (e) => { m.set(key(e.host_id, e.session_id), { ...e }); },
    remove: (h, s) => { m.delete(key(h, s)); },
    purgeHost: (h) => { for (const [k, e] of [...m]) if (e.host_id === h) m.delete(k); },
    purgeProject: (h, p) => { for (const [k, e] of [...m]) if (e.host_id === h && e.project_id === p) m.delete(k); },
    list: () => [...m.values()],
  };
}

function mkTarget(opts: { hostId: string; groveId: string; projectId: string; proxyPort?: number; overlay?: string; bufferDir: string }): AttachedReplayTarget {
  const target: RemoteTarget = {
    projectId: opts.projectId as RemoteTarget['projectId'],
    groveId: opts.groveId,
    host: {
      host_id: opts.hostId,
      label: 'H',
      overlay_address: opts.overlay ?? '127.0.0.1:9',
      protocol_version: 1,
      proxy_port: opts.proxyPort,
    },
    bearer: 'bearer-x',
  };
  return { hostId: opts.hostId, projectId: opts.projectId, target, bufferDir: opts.bufferDir };
}

const evt = (over: Record<string, unknown> = {}) =>
  stampCollectRoute({ type: 'user_prompt', session_id: 'sess-1', prompt: 'hi', ...over }, '/events');
const stop = (over: Record<string, unknown> = {}) =>
  stampCollectRoute({ session_id: 'sess-1', last_assistant_message: 'done', ...over }, '/events/stop');

// ---------------------------------------------------------------------------
// route-stamp helper
// ---------------------------------------------------------------------------

describe('collect-buffer-route stamp', () => {
  test('stamp records the route, read returns it, strip removes it and leaves the body intact', () => {
    const stamped = stampCollectRoute({ type: 'tool_use', session_id: 's' }, '/events/stop');
    expect(stamped[COLLECT_ROUTE_BUFFER_KEY]).toBe('/events/stop');
    expect(readCollectRoute(stamped)).toBe('/events/stop');
    const body = stripCollectRoute(stamped);
    expect(body).toEqual({ type: 'tool_use', session_id: 's' });
    expect(COLLECT_ROUTE_BUFFER_KEY in body).toBe(false);
  });

  test('an unstamped legacy record reads as null → caller applies the /events default', () => {
    expect(readCollectRoute({ type: 'user_prompt', session_id: 's' })).toBeNull();
    expect(DEFAULT_COLLECT_ROUTE).toBe('/events');
  });

  test('stamp is non-mutating — the caller keeps the untouched body', () => {
    const original = { type: 'user_prompt', session_id: 's' };
    stampCollectRoute(original, '/events');
    expect(COLLECT_ROUTE_BUFFER_KEY in original).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// route-correct re-forward
// ---------------------------------------------------------------------------

describe('route-correct replay', () => {
  test('each buffered record re-forwards to the SAME host route it was captured on', async () => {
    const buf = memBuffer();
    const dir = '/buf/a';
    buf.append(dir, 'sess-1', evt({ prompt: 'p1' }));
    buf.append(dir, 'sess-1', stop());
    buf.append(dir, 'sess-1', stampCollectRoute({ session_id: 'sess-1' }, '/sessions/unregister'));
    const sink = recordingSink();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE,
      store: memStore(),
      transport: sink.transport,
      bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });

    await q.drainAll();

    expect(sink.calls.map((c) => c.route)).toEqual(['/events', '/events/stop', '/sessions/unregister']);
    // The reserved route key never crosses the wire.
    for (const c of sink.calls) expect(COLLECT_ROUTE_BUFFER_KEY in c.body).toBe(false);
    expect(sink.calls[0].body).toEqual({ type: 'user_prompt', session_id: 'sess-1', prompt: 'p1' });
  });

  test('an unstamped legacy record re-forwards to /events', async () => {
    const buf = memBuffer();
    const dir = '/buf/legacy';
    buf.append(dir, 'sess-1', { type: 'user_prompt', session_id: 'sess-1', prompt: 'legacy' });
    const sink = recordingSink();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    await q.drainAll();
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].route).toBe('/events');
  });
});

// ---------------------------------------------------------------------------
// at-least-once: advance high-water only after ack; resume from it; duplicates safe
// ---------------------------------------------------------------------------

describe('at-least-once (prune/advance only after ack)', () => {
  test('a mid-stream failure leaves the high-water; the next drain resumes from it (rec 1 not re-sent) and a duplicate re-forward is safe', async () => {
    const buf = memBuffer();
    const dir = '/buf/ao';
    buf.append(dir, 'sess-1', evt({ prompt: 'r0' }));
    buf.append(dir, 'sess-1', evt({ prompt: 'r1' }));
    buf.append(dir, 'sess-1', evt({ prompt: 'r2' }));
    const store = memStore();
    const sink = recordingSink();
    // First drain: rec0 ack, rec1 rejected (host 500) → stop; high-water = 1.
    sink.setStatus((n) => (n === 2 ? 500 : 200));
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });

    await q.drainAll();
    expect(sink.calls.map((c) => (c.body as { prompt: string }).prompt)).toEqual(['r0', 'r1']);
    expect(store.get(HOST_A, 'sess-1')!.acked_count).toBe(1);

    // Second drain: host healthy now → resumes at 1 (NOT 0), so r0 is never
    // re-sent, r1 is re-forwarded (the safe duplicate), r2 lands. High-water = 3.
    sink.setStatus(() => 200);
    await q.drainAll();
    expect(sink.calls.map((c) => (c.body as { prompt: string }).prompt)).toEqual(['r0', 'r1', 'r1', 'r2']);
    expect(store.get(HOST_A, 'sess-1')!.acked_count).toBe(3);
  });

  test('a fully-acked buffer re-drains as a no-op (no further forwards)', async () => {
    const buf = memBuffer();
    const dir = '/buf/done';
    buf.append(dir, 'sess-1', evt());
    buf.append(dir, 'sess-1', stop());
    const sink = recordingSink();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    await q.drainAll();
    expect(sink.calls).toHaveLength(2);
    await q.drainAll();
    expect(sink.calls).toHaveLength(2); // nothing new
  });

  test('a transport throw leaves the high-water for retry next tick', async () => {
    const buf = memBuffer();
    const dir = '/buf/throw';
    buf.append(dir, 'sess-1', evt());
    const store = memStore();
    let fail = true;
    const transport: EventReplayTransport = async () => { if (fail) throw new Error('unreachable'); return { status: 200 }; };
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, transport, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    await q.drainAll();
    expect(store.get(HOST_A, 'sess-1')).toBeNull(); // nothing acked
    expect(q.pendingCount()).toBe(1);
    fail = false;
    await q.drainAll();
    expect(store.get(HOST_A, 'sess-1')!.acked_count).toBe(1);
    expect(q.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// multi-host
// ---------------------------------------------------------------------------

describe('multi-host', () => {
  test('two attached projects on two hosts drain to their OWN host + proxy_port', async () => {
    const buf = memBuffer();
    buf.append('/buf/a', 'sa', evt({ session_id: 'sa' }));
    buf.append('/buf/b', 'sb', evt({ session_id: 'sb' }));
    const sink = recordingSink();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [
        mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, proxyPort: 4111, bufferDir: '/buf/a' }),
        mkTarget({ hostId: HOST_B, groveId: GROVE_B, projectId: PROJ_B, proxyPort: 4222, bufferDir: '/buf/b' }),
      ],
    });

    await q.drainAll();

    const a = sink.calls.filter((c) => c.hostId === HOST_A);
    const b = sink.calls.filter((c) => c.hostId === HOST_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].proxyPort).toBe(4111);
    expect(a[0].sessionId).toBe('sa');
    expect(b[0].proxyPort).toBe(4222);
    expect(b[0].sessionId).toBe('sb');
  });

  test('a version-incompatible host is skipped (its entries stay pending)', async () => {
    const buf = memBuffer();
    buf.append('/buf/a', 'sa', evt({ session_id: 'sa' }));
    const sink = recordingSink();
    const incompatible = mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: '/buf/a' });
    incompatible.target.host.protocol_version = 999;
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [incompatible],
    });
    await q.drainAll();
    expect(sink.calls).toHaveLength(0);
    expect(q.pendingCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// purge-on-detach + skip
// ---------------------------------------------------------------------------

describe('purge / skip on detach', () => {
  test('purgeProject drops the detached project high-water; other projects survive', async () => {
    const buf = memBuffer();
    buf.append('/buf/a', 'sa', evt({ session_id: 'sa' }));
    buf.append('/buf/b', 'sb', evt({ session_id: 'sb' }));
    const store = memStore();
    const sink = recordingSink();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [
        mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: '/buf/a' }),
        mkTarget({ hostId: HOST_A, groveId: GROVE_B, projectId: PROJ_B, bufferDir: '/buf/b' }),
      ],
    });
    await q.drainAll();
    expect(store.list()).toHaveLength(2);

    q.purgeProject(HOST_A, PROJ_A);
    expect(store.list().map((e) => e.project_id)).toEqual([PROJ_B]);
  });

  test('a detached project (dropped from the registry) is no longer enumerated → not drained', async () => {
    const buf = memBuffer();
    buf.append('/buf/a', 'sa', evt({ session_id: 'sa' }));
    const sink = recordingSink();
    let attached: AttachedReplayTarget[] = [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: '/buf/a' })];
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => attached,
    });
    attached = []; // detached before the tick
    await q.drainAll();
    expect(sink.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// default transport wire shape (real localhost host, direct dial)
// ---------------------------------------------------------------------------

describe('default transport wire shape', () => {
  let server: http.Server;
  let port: number;
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  let reply = 200;

  beforeEach(async () => {
    seen.length = 0;
    reply = 200;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf-8') });
        res.writeHead(reply, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  test('POSTs to the captured route with the host bearer, protocol + tenancy headers, and a stripped body', async () => {
    const buf = memBuffer();
    buf.append('/buf/a', 'sess-1', evt({ prompt: 'wire' }));
    const store = memStore();
    // Default transport (no `transport` dep) → dials 127.0.0.1:port directly (no proxy_port).
    const q = createEventReplayDrainQueue({
      machineId: MACHINE, store, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, overlay: `127.0.0.1:${port}`, bufferDir: '/buf/a' })],
    });

    await q.drainAll();

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/events');
    expect(seen[0].headers.authorization).toBe('Bearer bearer-x');
    expect(seen[0].headers[HOST_PROTOCOL_HEADER]).toBe('1');
    expect(seen[0].headers[REQUEST_CONTEXT_HEADERS.projectId]).toBe(PROJ_A);
    expect(seen[0].headers[REQUEST_CONTEXT_HEADERS.groveId]).toBe(GROVE_A);
    expect(seen[0].headers[REQUEST_CONTEXT_HEADERS.machineId]).toBe(MACHINE);
    expect(seen[0].headers[REQUEST_CONTEXT_HEADERS.sessionId]).toBe('sess-1');
    expect(JSON.parse(seen[0].body)).toEqual({ type: 'user_prompt', session_id: 'sess-1', prompt: 'wire' });
    expect(store.get(HOST_A, 'sess-1')!.acked_count).toBe(1);
  });

  test('a non-2xx host reply does NOT advance the high-water (retry next tick)', async () => {
    const buf = memBuffer();
    buf.append('/buf/a', 'sess-1', evt());
    const store = memStore();
    reply = 503;
    const q = createEventReplayDrainQueue({
      machineId: MACHINE, store, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, overlay: `127.0.0.1:${port}`, bufferDir: '/buf/a' })],
    });
    await q.drainAll();
    expect(seen).toHaveLength(1);
    expect(store.get(HOST_A, 'sess-1')).toBeNull(); // not acked
  });
});

// ---------------------------------------------------------------------------
// never-materialize + registry enumeration (real fs)
// ---------------------------------------------------------------------------

describe('never-materialize + attach-registry enumeration (real fs)', () => {
  let tmpHome: string;
  let tmpTeam: string;
  let savedHome: string | undefined;
  let savedTeam: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-replay-home-'));
    tmpTeam = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-replay-team-'));
    savedHome = process.env.MYCO_HOME;
    savedTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = tmpHome;
    process.env.MYCO_TEAM_HOME = tmpTeam;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
    if (savedTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeam;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpTeam, { recursive: true, force: true });
  });

  function writeBuffer(): void {
    const dir = resolveProjectBufferDir(GROVE_A, PROJ_A);
    new EventBuffer(dir, 'sess-1').append(stampCollectRoute({ type: 'user_prompt', session_id: 'sess-1', prompt: 'hi' }, '/events'));
    new EventBuffer(dir, 'sess-1').append(stampCollectRoute({ session_id: 'sess-1', last_assistant_message: 'done' }, '/events/stop'));
  }
  function registerAttached(): void {
    upsertHost({
      host_id: HOST_A, label: 'H', overlay_address: '127.0.0.1:9', protocol_version: 1,
      created_at: new Date().toISOString(), projects: [{ grove_id: GROVE_A, project_id: PROJ_A, root: '/member/checkout' }],
    });
    writeHostSecret(HOST_A, HOST_BEARER_SECRET, 'bearer-x');
  }

  test('drains real buffered records via the registry, advances the real fs high-water, and materializes NO local Grove', async () => {
    writeBuffer();
    registerAttached();
    const sink = recordingSink();
    // Default store + reader + enumeration; only the transport is faked (no network).
    const q = createEventReplayDrainQueue({ machineId: MACHINE, transport: sink.transport });

    await q.drainAll();

    expect(sink.calls.map((c) => c.route)).toEqual(['/events', '/events/stop']);
    expect(sink.calls.every((c) => c.hostId === HOST_A)).toBe(true);
    expect(createFsReplayStore().get(HOST_A, 'sess-1')!.acked_count).toBe(2);

    // Never-materialize: the DB-free path created NO local Grove dir/DB/registry row.
    expect(fs.existsSync(path.join(tmpHome, 'groves', GROVE_A, 'myco.db'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, 'groves', GROVE_A, 'grove.toml'))).toBe(false);
    expect(listGroves(tmpHome)).toHaveLength(0);
  });

  test('the real enumeration reads the attach registry — a buffered project NOT attached is never drained (local path untouched, no double-forward)', async () => {
    writeBuffer(); // buffer on disk...
    // ...but NO host/attach registered. The registry-driven enumeration yields nothing.
    expect(listAttachedReplayTargets()).toHaveLength(0);
    const sink = recordingSink();
    const q = createEventReplayDrainQueue({ machineId: MACHINE, transport: sink.transport });
    await q.drainAll();
    expect(sink.calls).toHaveLength(0);
  });
});
