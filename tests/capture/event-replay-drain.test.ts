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
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
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
  listAttachedReplayTargets as listAttachedReplayTargetsWith,
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
import { EventBody } from '@myco/daemon/event-dispatch';
import { resolveProjectBufferDir } from '@myco/grove/paths';
import { REQUEST_CONTEXT_HEADERS } from '@myco/grove/request-context';
import { createHostRegistryOperations } from '@myco/host/registry';
import { listGroves } from '@myco/grove/registry';
import type { RemoteTarget } from '@myco/host/routing';
import { HOST_BEARER_SECRET, HOST_PROTOCOL_HEADER, HOST_PROTOCOL_VERSION } from '@myco/constants';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { startFunnelEdge, type FunnelEdge } from '../helpers/funnel-edge.js';

const MACHINE = 'alice_a1b2c3d4';
const { writeHostSecret } = createHostRegistryOperations(testPerUserLockNamespace);
const listAttachedReplayTargets = () =>
  listAttachedReplayTargetsWith(testPerUserLockNamespace);
const HOST_A = 'host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOST_B = 'host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GROVE_A = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GROVE_B = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PROJ_A = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJ_B = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// --- fakes -----------------------------------------------------------------

/** A recording transport with a per-call status hook (default 200 = ack). */
function recordingSink() {
  const calls: Array<{ hostId: string; hostUrl: string; route: string; sessionId: string; body: Record<string, unknown> }> = [];
  let statusFor: (callNo: number) => number = () => 200;
  const transport: EventReplayTransport = async (t, route, sessionId, body) => {
    calls.push({ hostId: t.host.host_id, hostUrl: t.host.host_url, route, sessionId, body });
    return { status: statusFor(calls.length) };
  };
  return { transport, calls, setStatus(fn: (callNo: number) => number) { statusFor = fn; } };
}

/** In-memory collector buffer: `bufferDir → sessionId → records` (in order).
 *  Tracks a per-session "version" bumped on every append, standing in for the
 *  real reader's size/mtime — item 5's `pendingCount` cache keys off exactly
 *  that kind of change signal, so tests can assert it invalidates on write and
 *  stays put otherwise. */
function memBuffer() {
  const dirs = new Map<string, Map<string, Record<string, unknown>[]>>();
  const versions = new Map<string, number>();
  const vkey = (dir: string, s: string) => `${dir}::${s}`;
  const reader: CollectBufferReader = {
    listSessions: (dir) => [...(dirs.get(dir)?.keys() ?? [])],
    readRecords: (dir, s) => [...(dirs.get(dir)?.get(s) ?? [])],
    statSession: (dir, s) => {
      if (!dirs.get(dir)?.has(s)) return null;
      const v = versions.get(vkey(dir, s)) ?? 0;
      return { size: v, mtimeMs: v };
    },
  };
  const append = (dir: string, s: string, record: Record<string, unknown>) => {
    const byDir = dirs.get(dir) ?? new Map<string, Record<string, unknown>[]>();
    const recs = byDir.get(s) ?? [];
    recs.push(record);
    byDir.set(s, recs);
    dirs.set(dir, byDir);
    versions.set(vkey(dir, s), (versions.get(vkey(dir, s)) ?? 0) + 1);
  };
  const remove = (dir: string, s: string) => {
    dirs.get(dir)?.delete(s);
    versions.delete(vkey(dir, s));
  };
  return { reader, append, remove };
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

function mkTarget(opts: { hostId: string; groveId: string; projectId: string; hostUrl?: string; bufferDir: string }): AttachedReplayTarget {
  const target: RemoteTarget = {
    projectId: opts.projectId as RemoteTarget['projectId'],
    groveId: opts.groveId,
    host: {
      host_id: opts.hostId,
      label: 'H',
      host_url: opts.hostUrl ?? 'https://host-a.tailnet.ts.net:8443',
      protocol_version: HOST_PROTOCOL_VERSION,
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
    // Nothing acked — but a failure IS recorded (consolidation Task C-5: a
    // session that has never once succeeded still needs a persisted entry for
    // `health()` to read; see the "drain health" describe block below).
    expect(store.get(HOST_A, 'sess-1')!.acked_count).toBe(0);
    expect(store.get(HOST_A, 'sess-1')!.consecutive_failures).toBe(1);
    expect(store.get(HOST_A, 'sess-1')!.last_error_kind).toBe('unreachable');
    expect(q.pendingCount()).toBe(1);
    fail = false;
    await q.drainAll();
    expect(store.get(HOST_A, 'sess-1')!.acked_count).toBe(1);
    expect(store.get(HOST_A, 'sess-1')!.consecutive_failures).toBe(0); // recovered
    expect(q.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// multi-host
// ---------------------------------------------------------------------------

describe('multi-host', () => {
  test('two attached projects on two hosts drain to their OWN host URL', async () => {
    const buf = memBuffer();
    buf.append('/buf/a', 'sa', evt({ session_id: 'sa' }));
    buf.append('/buf/b', 'sb', evt({ session_id: 'sb' }));
    const sink = recordingSink();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [
        mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, hostUrl: 'https://team-a.tailnet.ts.net:8443', bufferDir: '/buf/a' }),
        mkTarget({ hostId: HOST_B, groveId: GROVE_B, projectId: PROJ_B, hostUrl: 'https://team-b.tailnet.ts.net:8443', bufferDir: '/buf/b' }),
      ],
    });

    await q.drainAll();

    const a = sink.calls.filter((c) => c.hostId === HOST_A);
    const b = sink.calls.filter((c) => c.hostId === HOST_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].hostUrl).toBe('https://team-a.tailnet.ts.net:8443');
    expect(a[0].sessionId).toBe('sa');
    expect(b[0].hostUrl).toBe('https://team-b.tailnet.ts.net:8443');
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
// pendingCount perf: change-detection cache (consolidation Task C-2, item 5)
// ---------------------------------------------------------------------------

describe('pendingCount change-detection cache (item 5)', () => {
  /** Wraps a {@link CollectBufferReader} to count `readRecords` calls, so tests
   *  can assert the cache actually skips a full re-parse. */
  function countingReader(inner: CollectBufferReader): { reader: CollectBufferReader; readCalls: () => number } {
    let calls = 0;
    return {
      reader: {
        listSessions: (dir) => inner.listSessions(dir),
        readRecords: (dir, s) => { calls += 1; return inner.readRecords(dir, s); },
        statSession: (dir, s) => inner.statSession(dir, s),
      },
      readCalls: () => calls,
    };
  }

  test('an unchanged buffer is NOT re-parsed on the second pendingCount() poll', async () => {
    const buf = memBuffer();
    buf.append('/buf/a', 'sa', evt({ session_id: 'sa' }));
    const counting = countingReader(buf.reader);
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), bufferReader: counting.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: '/buf/a' })],
    });

    expect(q.pendingCount()).toBe(1); // first poll: cold cache, one parse
    const afterFirst = counting.readCalls();
    expect(afterFirst).toBeGreaterThan(0);

    expect(q.pendingCount()).toBe(1); // second poll: size/mtime unchanged → cache hit
    expect(counting.readCalls()).toBe(afterFirst); // no additional parse
  });

  test('an appended record invalidates the cache — the next poll re-parses and reflects the new count', async () => {
    const buf = memBuffer();
    buf.append('/buf/a', 'sa', evt({ session_id: 'sa' }));
    const counting = countingReader(buf.reader);
    const store = memStore();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, bufferReader: counting.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: '/buf/a' })],
    });
    expect(q.pendingCount()).toBe(1);
    const afterFirst = counting.readCalls();

    store.put({ host_id: HOST_A, project_id: PROJ_A, session_id: 'sa', acked_count: 1, updated_at: 'x' }); // fully acked
    expect(q.pendingCount()).toBe(0); // still cache-hit (buffer unchanged) — correctness holds under cache
    expect(counting.readCalls()).toBe(afterFirst);

    buf.append('/buf/a', 'sa', evt({ session_id: 'sa' })); // buffer grows → stat changes
    expect(q.pendingCount()).toBe(1); // re-parsed, sees the new un-acked record
    expect(counting.readCalls()).toBeGreaterThan(afterFirst);
  });

  test('a session whose buffer file disappeared is not counted (and the cache entry is dropped, not left dangling)', () => {
    const buf = memBuffer();
    buf.append('/buf/a', 'sa', evt({ session_id: 'sa' }));
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: '/buf/a' })],
    });
    expect(q.pendingCount()).toBe(1);
    buf.remove('/buf/a', 'sa');
    expect(q.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Session-terminal prune (consolidation Task C-2, item 6)
// ---------------------------------------------------------------------------

describe('noteSessionEnded prune (item 6 — prune only acked, buffer file included)', () => {
  // noteSessionEnded takes a RemoteTarget (not an AttachedReplayTarget), so it
  // re-derives the buffer dir itself via `resolveProjectBufferDir(groveId,
  // projectId)` — the SAME resolver `listAttachedReplayTargets` uses in
  // production. These tests key the in-memory buffer on that resolved path
  // (not an arbitrary string) so they exercise the real derivation.
  const bufferDir = resolveProjectBufferDir(GROVE_A, PROJ_A);
  // noteSessionEnded runs its OWN catch-up drain first (it has no
  // flushBeforeForward of its own — see the class doc), so every construction
  // below supplies a transport, even the ones expecting it to short-circuit
  // (records.length <= acked, checked before any transport call) — keeps every
  // test hermetic with no real network attempt.
  const unreachable: EventReplayTransport = async () => { throw new Error('unreachable in test'); };

  /** In-memory analog of `EventBuffer.deleteIfSync`'s contract for the
   *  injected seam: re-read the buffer, consult `shouldDelete` against that
   *  read, delete only on approval. Records every call for assertions. */
  function memLockedDelete(buf: ReturnType<typeof memBuffer>) {
    const calls: Array<{ dir: string; sessionId: string; approved: boolean }> = [];
    const fn = (dir: string, sessionId: string, shouldDelete: (records: Record<string, unknown>[]) => boolean): boolean => {
      if (!buf.reader.statSession(dir, sessionId)) return false; // file gone
      const approved = shouldDelete(buf.reader.readRecords(dir, sessionId));
      calls.push({ dir, sessionId, approved });
      if (!approved) return false;
      buf.remove(dir, sessionId);
      return true;
    };
    return { fn, calls };
  }

  test('a fully-acked session is pruned: BOTH the high-water entry AND the buffer file are removed', async () => {
    const buf = memBuffer();
    buf.append(bufferDir, 'sa', evt({ session_id: 'sa' }));
    buf.append(bufferDir, 'sa', stop({ session_id: 'sa' }));
    const store = memStore();
    store.put({ host_id: HOST_A, project_id: PROJ_A, session_id: 'sa', acked_count: 2, updated_at: 'x' }); // fully acked
    const del = memLockedDelete(buf);
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, bufferReader: buf.reader, transport: unreachable,
      deleteSessionBuffer: del.fn,
    });
    const t = mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir });

    await q.noteSessionEnded(t.target, 'sa');

    expect(store.get(HOST_A, 'sa')).toBeNull();
    expect(del.calls).toEqual([{ dir: bufferDir, sessionId: 'sa', approved: true }]);
    expect(buf.reader.listSessions(bufferDir)).not.toContain('sa');
  });

  test('an un-acked session whose catch-up drain ALSO fails (host unreachable) is left COMPLETELY untouched', async () => {
    const buf = memBuffer();
    buf.append(bufferDir, 'sa', evt({ session_id: 'sa' }));
    buf.append(bufferDir, 'sa', stop({ session_id: 'sa' }));
    const store = memStore();
    store.put({ host_id: HOST_A, project_id: PROJ_A, session_id: 'sa', acked_count: 1, updated_at: 'x' }); // NOT fully acked
    const del = memLockedDelete(buf);
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, bufferReader: buf.reader, transport: unreachable,
      deleteSessionBuffer: del.fn,
    });
    const t = mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir });

    await q.noteSessionEnded(t.target, 'sa');

    expect(del.calls).toHaveLength(0); // refused at the pre-check — locked delete never attempted
    expect(store.get(HOST_A, 'sa')!.acked_count).toBe(1); // unchanged — the catch-up drain couldn't reach the host
    expect(buf.reader.listSessions(bufferDir)).toContain('sa'); // buffer file untouched
  });

  test('an un-acked session whose catch-up drain SUCCEEDS is pruned (the case the drain-then-prune fix exists for)', async () => {
    const buf = memBuffer();
    buf.append(bufferDir, 'sa', evt({ session_id: 'sa' }));
    buf.append(bufferDir, 'sa', stop({ session_id: 'sa' })); // e.g. the just-buffered /sessions/unregister record
    const store = memStore();
    store.put({ host_id: HOST_A, project_id: PROJ_A, session_id: 'sa', acked_count: 1, updated_at: 'x' }); // one record un-acked
    const sink = recordingSink();
    const del = memLockedDelete(buf);
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, bufferReader: buf.reader, transport: sink.transport,
      deleteSessionBuffer: del.fn,
    });
    const t = mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir });

    await q.noteSessionEnded(t.target, 'sa');

    expect(sink.calls).toHaveLength(1); // the drain sent the un-acked tail record
    expect(del.calls).toEqual([{ dir: bufferDir, sessionId: 'sa', approved: true }]); // now caught up → pruned
    expect(store.get(HOST_A, 'sa')).toBeNull();
  });

  test('a straggler append landing between the pre-check and the locked delete is refused by the in-lock re-check (entry survives)', async () => {
    const buf = memBuffer();
    buf.append(bufferDir, 'sa', evt({ session_id: 'sa' }));
    const store = memStore();
    store.put({ host_id: HOST_A, project_id: PROJ_A, session_id: 'sa', acked_count: 1, updated_at: 'x' }); // covers record 0
    // Locked-delete fake that lands a straggler append at the exact moment the
    // lock is acquired — BEFORE the re-read — simulating the hook-fallback
    // writer that got the flock first. The in-lock shouldDelete then sees the
    // straggler and must refuse.
    let deleted = false;
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, bufferReader: buf.reader, transport: unreachable,
      deleteSessionBuffer: (dir, sessionId, shouldDelete) => {
        buf.append(dir, sessionId, evt({ session_id: sessionId, prompt: 'straggler' })); // lands first
        const approved = shouldDelete(buf.reader.readRecords(dir, sessionId)); // re-read AFTER it landed
        if (!approved) return false;
        buf.remove(dir, sessionId);
        deleted = true;
        return true;
      },
    });
    const t = mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir });

    await q.noteSessionEnded(t.target, 'sa'); // pre-check passes (1 record, acked 1)...

    expect(deleted).toBe(false); // ...but the in-lock re-check refused
    expect(store.get(HOST_A, 'sa')).not.toBeNull(); // entry survives → backstop will forward the straggler
    expect(buf.reader.readRecords(bufferDir, 'sa')).toHaveLength(2); // straggler intact
  });

  test('a session with no high-water entry at all (nothing ever drained) still prunes once its catch-up drain succeeds', async () => {
    const buf = memBuffer();
    buf.append(bufferDir, 'sa', evt({ session_id: 'sa' }));
    const store = memStore();
    const del = memLockedDelete(buf);
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, bufferReader: buf.reader, transport: recordingSink().transport,
      deleteSessionBuffer: del.fn,
    });
    const t = mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir });

    await q.noteSessionEnded(t.target, 'sa');

    // No pre-existing ReplayEntry (acked defaults to 0), but the catch-up
    // drain sends the one buffered record and advances to fully-caught-up —
    // this case behaves identically to any other un-acked session once the
    // drain succeeds.
    expect(del.calls).toEqual([{ dir: bufferDir, sessionId: 'sa', approved: true }]);
    expect(store.get(HOST_A, 'sa')).toBeNull();
  });

  test('an empty buffer (nothing ever buffered for the session) is a true no-op', async () => {
    const buf = memBuffer(); // '/buf' has no session 'sa' at all
    const store = memStore();
    const del = memLockedDelete(buf);
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, bufferReader: buf.reader, transport: unreachable,
      deleteSessionBuffer: del.fn,
    });
    const t = mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir });

    await q.noteSessionEnded(t.target, 'sa');

    expect(del.calls).toHaveLength(0);
    expect(store.get(HOST_A, 'sa')).toBeNull();
  });

  test('pruning one session never touches a different session on the same buffer dir', async () => {
    const buf = memBuffer();
    buf.append(bufferDir, 'sa', evt({ session_id: 'sa' }));
    buf.append(bufferDir, 'sb', evt({ session_id: 'sb' }));
    const store = memStore();
    store.put({ host_id: HOST_A, project_id: PROJ_A, session_id: 'sa', acked_count: 1, updated_at: 'x' }); // caught up
    store.put({ host_id: HOST_A, project_id: PROJ_A, session_id: 'sb', acked_count: 1, updated_at: 'x' }); // also caught up
    const del = memLockedDelete(buf);
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, bufferReader: buf.reader, transport: unreachable,
      deleteSessionBuffer: del.fn,
    });
    const t = mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir });

    await q.noteSessionEnded(t.target, 'sa'); // only session sa ended

    expect(store.get(HOST_A, 'sa')).toBeNull();
    expect(store.get(HOST_A, 'sb')).not.toBeNull(); // sb's entry survives
    expect(buf.reader.listSessions(bufferDir)).toEqual(['sb']);
  });

  test('a real-fs default deleteSessionBuffer removes the .jsonl file under the flock (EventBuffer.deleteIfSync semantics)', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-replay-bufdel-home-'));
    const tmpTeam = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-replay-bufdel-team-'));
    const savedHome = process.env.MYCO_HOME;
    const savedTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = tmpHome;
    process.env.MYCO_TEAM_HOME = tmpTeam;
    try {
      const realBufferDir = resolveProjectBufferDir(GROVE_A, PROJ_A);
      new EventBuffer(realBufferDir, 'sa').append(evt({ session_id: 'sa' }));
      const filePath = path.join(realBufferDir, 'sa.jsonl');
      expect(fs.existsSync(filePath)).toBe(true);

      const store = memStore();
      store.put({ host_id: HOST_A, project_id: PROJ_A, session_id: 'sa', acked_count: 1, updated_at: 'x' }); // fully acked
      const q = createEventReplayDrainQueue({ machineId: MACHINE, store, transport: unreachable }); // default deleteSessionBuffer
      const t = mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: realBufferDir });

      await q.noteSessionEnded(t.target, 'sa');

      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(path.join(realBufferDir, '.sa.lock'))).toBe(false); // lock companion reaped
      expect(store.get(HOST_A, 'sa')).toBeNull();
    } finally {
      if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
      if (savedTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeam;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpTeam, { recursive: true, force: true });
    }
  });

  test('REAL-FS straggler: a record appended after the drain-queue pre-check state is refused by the default locked delete (never destroyed)', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-replay-straggler-home-'));
    const tmpTeam = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-replay-straggler-team-'));
    const savedHome = process.env.MYCO_HOME;
    const savedTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = tmpHome;
    process.env.MYCO_TEAM_HOME = tmpTeam;
    try {
      const realBufferDir = resolveProjectBufferDir(GROVE_A, PROJ_A);
      const acked = evt({ session_id: 'sa' });
      new EventBuffer(realBufferDir, 'sa').append(acked); // record 0 — acked below
      const store = memStore();
      store.put({ host_id: HOST_A, project_id: PROJ_A, session_id: 'sa', acked_count: 1, updated_at: 'x' });

      // The race, made deterministic: the drain queue's own reader is pinned to
      // the PRE-STRAGGLER view (1 record — what the queue saw when it decided
      // to prune), while the hook-fallback appender has ALREADY landed a
      // second record on the real file via the real locked append.
      new EventBuffer(realBufferDir, 'sa').append(evt({ session_id: 'sa', prompt: 'straggler' }));
      const staleReader: CollectBufferReader = {
        listSessions: () => ['sa'],
        readRecords: () => [acked], // stale: pre-straggler view
        statSession: () => ({ size: 1, mtimeMs: 1 }),
      };

      // Default deleteSessionBuffer → the REAL EventBuffer.deleteIfSync: real
      // flock, real in-lock re-read of the real file.
      const q = createEventReplayDrainQueue({
        machineId: MACHINE, store, bufferReader: staleReader, transport: unreachable,
      });
      const t = mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: realBufferDir });

      await q.noteSessionEnded(t.target, 'sa'); // stale pre-check passes (1 record, acked 1)...

      // ...but the locked re-read saw the straggler and REFUSED. The bytes
      // survive, the entry survives, the backstop forwards the straggler later.
      const filePath = path.join(realBufferDir, 'sa.jsonl');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(new EventBuffer(realBufferDir, 'sa').readAll()).toHaveLength(2);
      expect(store.get(HOST_A, 'sa')).not.toBeNull();
    } finally {
      if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
      if (savedTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeam;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpTeam, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// fs replay-store hygiene (consolidation Task C-2 review minor: torn `.tmp`
// siblings must not outlive the entry they belonged to)
// ---------------------------------------------------------------------------

describe('fs replay store — torn `.tmp` sibling reap', () => {
  test('remove() reaps a torn `.tmp` sibling alongside the entry', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-replay-store-tmp-'));
    try {
      const store = createFsReplayStore(tmp);
      store.put({ host_id: HOST_A, project_id: PROJ_A, session_id: 'sa', acked_count: 3, updated_at: 'x' });
      const finalPath = path.join(tmp, HOST_A, 'sa.json');
      const tmpPath = `${finalPath}.tmp`;
      fs.writeFileSync(tmpPath, '{"torn'); // crash-mid-put leftover

      store.remove(HOST_A, 'sa');

      expect(fs.existsSync(finalPath)).toBe(false);
      expect(fs.existsSync(tmpPath)).toBe(false); // sibling reaped, not orphaned
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// default transport wire shape (real localhost host, direct dial)
// ---------------------------------------------------------------------------

describe('default transport wire shape', () => {
  let server: http.Server;
  let port: number;
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  let edge: FunnelEdge;
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
    // The default transport dials HTTPS, so the fixture sits behind a real TLS
    // edge — the same shape a host's socket sits behind a Funnel.
    edge = await startFunnelEdge({ port });
  });
  afterEach(async () => {
    await edge.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  test('POSTs to the captured route with the host bearer, protocol + tenancy headers, and a stripped body', async () => {
    const buf = memBuffer();
    buf.append('/buf/a', 'sess-1', evt({ prompt: 'wire' }));
    const store = memStore();
    // Default transport (no `transport` dep) → the production HTTPS dial.
    const q = createEventReplayDrainQueue({
      machineId: MACHINE, store, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, hostUrl: edge.url, bufferDir: '/buf/a' })],
    });

    await q.drainAll();

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/events');
    expect(seen[0].headers.authorization).toBe('Bearer bearer-x');
    expect(seen[0].headers[HOST_PROTOCOL_HEADER]).toBe(String(HOST_PROTOCOL_VERSION));
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
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, hostUrl: edge.url, bufferDir: '/buf/a' })],
    });
    await q.drainAll();
    expect(seen).toHaveLength(1);
    // Not acked — but a "rejected" failure IS recorded (consolidation Task
    // C-5), distinct from a transport-level "unreachable" failure.
    expect(store.get(HOST_A, 'sess-1')!.acked_count).toBe(0);
    expect(store.get(HOST_A, 'sess-1')!.last_error_kind).toBe('rejected');
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
    writeHostRecordFixture({
      host_id: HOST_A, label: 'H', host_url: 'https://host-a.tailnet.ts.net:8443', protocol_version: HOST_PROTOCOL_VERSION,
      created_at: new Date().toISOString(), projects: [{ grove_id: GROVE_A, project_id: PROJ_A, root: '/member/checkout' }],
    });
    writeHostSecret(HOST_A, HOST_BEARER_SECRET, 'bearer-x');
  }

  test('drains real buffered records via the registry, advances the real fs high-water, and materializes NO local Grove', async () => {
    writeBuffer();
    registerAttached();
    const sink = recordingSink();
    // Default store + reader + enumeration; only the transport is faked (no network).
    const q = createEventReplayDrainQueue({
      machineId: MACHINE,
      transport: sink.transport,
      lockNamespace: testPerUserLockNamespace,
    });

    await q.drainAll();

    expect(sink.calls.map((c) => c.route)).toEqual(['/events', '/events/stop']);
    expect(sink.calls.every((c) => c.hostId === HOST_A)).toBe(true);
    expect(createFsReplayStore().get(HOST_A, 'sess-1')!.acked_count).toBe(2);

    // Never-materialize: the DB-free path created NO local Grove dir/DB/registry row.
    expect(fs.existsSync(path.join(tmpHome, 'groves', GROVE_A, 'myco.db'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, 'groves', GROVE_A, 'grove.toml'))).toBe(false);
    expect(listGroves(tmpHome)).toHaveLength(0);
  });

  test('a host with no usable address yields NO targets, and its buffered events are KEPT', async () => {
    // Data preservation is the contract being pinned. A record without an
    // address cannot be dialed, so it contributes no targets — but the buffer
    // must survive untouched, because a re-join makes those events deliverable
    // again. Dropping them (or forwarding them somewhere) would be the failure.
    writeBuffer();
    writeHostRecordFixture({
      host_id: HOST_A, label: 'H', protocol_version: HOST_PROTOCOL_VERSION,
      created_at: new Date().toISOString(), projects: [{ grove_id: GROVE_A, project_id: PROJ_A, root: '/member/checkout' }],
    });
    writeHostSecret(HOST_A, HOST_BEARER_SECRET, 'bearer-x');

    expect(listAttachedReplayTargets()).toHaveLength(0);

    const sink = recordingSink();
    const q = createEventReplayDrainQueue({
      machineId: MACHINE,
      transport: sink.transport,
      lockNamespace: testPerUserLockNamespace,
    });
    await q.drainAll();

    expect(sink.calls).toHaveLength(0);
    // The buffered events are still on disk, still unacked — recoverable.
    const dir = resolveProjectBufferDir(GROVE_A, PROJ_A);
    expect(fs.existsSync(path.join(dir, 'sess-1.jsonl'))).toBe(true);
    expect(createFsReplayStore().get(HOST_A, 'sess-1')?.acked_count ?? 0).toBe(0);
  });

  test('the real enumeration reads the attach registry — a buffered project NOT attached is never drained (local path untouched, no double-forward)', async () => {
    writeBuffer(); // buffer on disk...
    // ...but NO host/attach registered. The registry-driven enumeration yields nothing.
    expect(listAttachedReplayTargets()).toHaveLength(0);
    const sink = recordingSink();
    const q = createEventReplayDrainQueue({
      machineId: MACHINE,
      transport: sink.transport,
      lockNamespace: testPerUserLockNamespace,
    });
    await q.drainAll();
    expect(sink.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Drain health (consolidation Task C-5 — routed-capture observability)
// ---------------------------------------------------------------------------

describe('drain health (consolidation Task C-5)', () => {
  test('a fully-acked session reports zero counters (no pendingUnits key)', async () => {
    const buf = memBuffer();
    const dir = '/buf/health-ok';
    buf.append(dir, 'sess-1', evt());
    const sink = recordingSink();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    await q.drainAll();

    expect(q.health().get(HOST_A)).toEqual({ pendingEntries: 0, failingEntries: 0, hostUnreachableEntries: 0 });
  });

  test('a transport throw on a session\'s FIRST attempt still shows up in health (no prior ReplayEntry to update)', async () => {
    const buf = memBuffer();
    const dir = '/buf/health-throw';
    buf.append(dir, 'sess-1', evt());
    buf.append(dir, 'sess-1', evt({ prompt: 'p2' }));
    const throwing: EventReplayTransport = async () => { throw new Error('unreachable'); };
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: throwing, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    await q.drainAll();

    expect(q.health().get(HOST_A)).toEqual({
      pendingEntries: 1,
      pendingUnits: 2,
      failingEntries: 1,
      hostUnreachableEntries: 1,
    });
  });

  test('a rejected (non-2xx) forward counts as failing but NOT host-unreachable', async () => {
    const buf = memBuffer();
    const dir = '/buf/health-reject';
    buf.append(dir, 'sess-1', evt());
    const sink = recordingSink();
    sink.setStatus(() => 500);
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    await q.drainAll();

    const counters = q.health().get(HOST_A);
    expect(counters?.failingEntries).toBe(1);
    expect(counters?.hostUnreachableEntries).toBe(0);
  });

  test('a later successful drain clears a prior failure', async () => {
    const buf = memBuffer();
    const dir = '/buf/health-recover';
    buf.append(dir, 'sess-1', evt());
    const store = memStore();
    let fail = true;
    const transport: EventReplayTransport = async () => { if (fail) throw new Error('unreachable'); return { status: 200 }; };
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, transport, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    await q.drainAll();
    expect(q.health().get(HOST_A)?.failingEntries).toBe(1);

    fail = false;
    await q.drainAll();
    expect(q.health().get(HOST_A)).toEqual({ pendingEntries: 0, failingEntries: 0, hostUnreachableEntries: 0 });
  });

  test('a removed buffer file leaves no stale failure to count — the enumeration skips the vanished session (reviewer repro, event-replay analog)', async () => {
    const buf = memBuffer();
    const dir = '/buf/health-inert';
    buf.append(dir, 'sess-1', evt());
    const store = memStore();
    const throwing: EventReplayTransport = async () => { throw new Error('unreachable'); };
    const q1 = new EventReplayDrainQueue({
      machineId: MACHINE, store, transport: throwing, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    await q1.drainAll();
    expect(q1.health().get(HOST_A)?.hostUnreachableEntries).toBe(1);

    // The buffer file goes away (e.g. a manual cleanup) while the failed
    // ReplayEntry remains persisted. A FRESH queue (doctor's disk-only
    // construction) enumerates buffer FILES — the vanished session yields no
    // row at all, so the stale failure never surfaces.
    buf.remove(dir, 'sess-1');
    const q2 = new EventReplayDrainQueue({
      machineId: MACHINE, store, transport: throwing, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    expect(q2.health().get(HOST_A)).toBeUndefined();
  });

  test('a caught-up (fully-acked) session clears a stale failure on the STORED entry, with no transport attempt', async () => {
    const buf = memBuffer();
    const dir = '/buf/health-caught-up-stale';
    buf.append(dir, 'sess-1', evt());
    const store = memStore();
    // Seed a ReplayEntry that is ALREADY fully acked (acked_count === the
    // single record in the buffer) but still carries a stale failure from a
    // past incident — the state a genuinely-recovered session is left in
    // before this fix (e.g. the host separately caught up this session via
    // another path while this entry's failure flag was never touched).
    store.put({
      host_id: HOST_A, project_id: PROJ_A, session_id: 'sess-1', acked_count: 1,
      updated_at: '2020-01-01T00:00:00.000Z',
      consecutive_failures: 3, last_error_kind: 'unreachable', last_error_at: '2020-01-01T00:00:00.000Z',
    });
    const sink = recordingSink();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store, transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    await q.drainAll();

    // No forward happened — this was a genuine no-op, not a retry that happened to succeed.
    expect(sink.calls).toHaveLength(0);
    const entry = store.get(HOST_A, 'sess-1');
    expect(entry?.consecutive_failures).toBe(0);
    expect(entry?.last_error_kind).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hook-fallback deliverability: session_id is stamped into the replayed BODY
// ---------------------------------------------------------------------------

describe('hook-fallback body stamp', () => {
  test('a fallback record (no session_id by design) replays with the buffer identity stamped into a body the host schema accepts', async () => {
    const buf = memBuffer();
    const dir = '/buf/fallback';
    // Exactly what hooks/user-prompt-submit buffers on daemon outage: the
    // reconciler keys the session from the FILENAME, so the record body
    // carries no session_id.
    buf.append(dir, 'sess-out', stampCollectRoute({ type: 'user_prompt', prompt: 'offline turn', transcript_path: '/t.jsonl' }, '/events'));
    const sink = recordingSink();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });

    await q.drainAll();

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].body.session_id).toBe('sess-out');
    // The gate: the REAL host-side schema must accept the replayed body — a
    // rejected fallback record permanently blocks every record behind it.
    expect(EventBody.safeParse(sink.calls[0].body).success).toBe(true);
  });

  test('a stop-shaped fallback record replays to /events/stop with the session stamped — never a silent /events drop', async () => {
    const buf = memBuffer();
    const dir = '/buf/stop-fallback';
    // What hooks/stop.ts buffers on outage, with the route stamp send-event
    // now writes: without the stamp this record would default to /events,
    // dispatch as an unknown type, and drop the turn's summary silently.
    buf.append(dir, 'sess-out', stampCollectRoute({ type: 'stop', last_assistant_message: 'done', transcript_path: '/t.jsonl' }, '/events/stop'));
    const sink = recordingSink();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    await q.drainAll();
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].route).toBe('/events/stop');
    expect(sink.calls[0].body.session_id).toBe('sess-out');
  });

  test('a record that already carries a session_id keeps its own', async () => {
    const buf = memBuffer();
    const dir = '/buf/carried';
    buf.append(dir, 'sess-file', evt({ session_id: 'sess-inner' }));
    const sink = recordingSink();
    const q = new EventReplayDrainQueue({
      machineId: MACHINE, store: memStore(), transport: sink.transport, bufferReader: buf.reader,
      listTargets: () => [mkTarget({ hostId: HOST_A, groveId: GROVE_A, projectId: PROJ_A, bufferDir: dir })],
    });
    await q.drainAll();
    expect(sink.calls[0].body.session_id).toBe('sess-inner');
  });
});
