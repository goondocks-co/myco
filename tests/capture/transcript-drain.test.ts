/**
 * Tests for the MEMBER side of routed transcript capture (plan C1 — the
 * transcript-content drain). Hermetic: fake host transport honoring the C2
 * offset contract (append / replay / gap), an in-memory file reader (so
 * offset/inode/line-split semantics are driven precisely), and either an
 * in-memory or a real fs store under a tmp `MYCO_TEAM_HOME` (persistence).
 *
 * The load-bearing assertion is OFFSET AUTHORITY: on a partial-overlap replay
 * the member re-slices the next send from the HOST'S returned size and the
 * transcript tail is NOT dropped.
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import {
  TranscriptDrainQueue,
  createFsDrainStore,
  defaultTranscriptTransport,
  type DrainEntry,
  type DrainStore,
  type TranscriptChunkRequest,
  type TranscriptFileReader,
  type TranscriptPostTransport,
} from '@myco/capture/transcript-drain';
import { deriveTranscriptId } from '@myco/host/routed-transcript';
import type { RemoteTarget } from '@myco/host/routing';
import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import { JobRunner } from '@myco/daemon/job-runner';
import { defaultDial } from '@myco/daemon/host-proxy';
import { createStreamableMcpHttpHandler } from '@myco/mcp/http';
import { REQUEST_CONTEXT_HEADERS } from '@myco/grove/request-context';
import {
  assertGroveProjectId,
  createGroveId,
  createHostId,
  createProjectId,
} from '@myco/grove/ids';
import { createHostRegistryOperations, type HostRecord } from '@myco/host/registry';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { HOST_BEARER_SECRET } from '@myco/constants';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { startFunnelEdge, type FunnelEdge } from '../helpers/funnel-edge.js';
import { HOST_PROTOCOL_VERSION } from '@myco/constants.js';

const MACHINE = 'alice_a1b2c3d4';
const { writeHostSecret } = createHostRegistryOperations(testPerUserLockNamespace);
const HOST_A = 'host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOST_B = 'host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// --- fakes -----------------------------------------------------------------

/** An in-memory file backing store the {@link TranscriptFileReader} reads. */
function memFiles() {
  const files = new Map<string, { buf: Buffer; inode: number }>();
  const reader: TranscriptFileReader = {
    stat(p) {
      const f = files.get(p);
      return f ? { size: f.buf.length, inode: f.inode } : null;
    },
    readSlice(p, offset, length) {
      const f = files.get(p);
      if (!f || length <= 0) return Buffer.alloc(0);
      return f.buf.subarray(offset, offset + length);
    },
  };
  return {
    reader,
    set(p: string, content: string, inode = 1) { files.set(p, { buf: Buffer.from(content), inode }); },
    append(p: string, content: string) {
      const f = files.get(p)!;
      f.buf = Buffer.concat([f.buf, Buffer.from(content)]);
    },
    rotate(p: string, content: string, inode: number) { files.set(p, { buf: Buffer.from(content), inode }); },
  };
}

/** A fake host honoring the C2 offset contract, per host_id. Records every POST
 *  with the dial target so multi-host routing is assertable. */
function multiFakeHost() {
  const contents = new Map<string, Buffer>();
  const calls: Array<{ hostId: string; hostUrl: string; body: TranscriptChunkRequest }> = [];
  const transport: TranscriptPostTransport = async (target, body) => {
    calls.push({
      hostId: target.host.host_id,
      hostUrl: target.host.host_url,
      body,
    });
    const cur = contents.get(target.host.host_id) ?? Buffer.alloc(0);
    const bytes = Buffer.from(body.bytes, 'base64');
    if (body.base_offset === cur.length) {
      const next = Buffer.concat([cur, bytes]);
      contents.set(target.host.host_id, next);
      return { status: 200, size: next.length, action: 'append' };
    }
    if (body.base_offset < cur.length) return { status: 200, size: cur.length, action: 'replay' };
    return { status: 409, size: cur.length, action: 'gap' };
  };
  return {
    transport,
    calls,
    /** Seed a host's pre-existing materialized content (a prior partial delivery). */
    seed(hostId: string, content: string) { contents.set(hostId, Buffer.from(content)); },
    content(hostId: string) { return (contents.get(hostId) ?? Buffer.alloc(0)).toString('utf-8'); },
  };
}

function memStore(): DrainStore {
  const m = new Map<string, DrainEntry>();
  const key = (h: string, s: string, t: string) => `${h}|${s}|${t}`;
  return {
    list: () => [...m.values()],
    listForHost: (h) => [...m.values()].filter((e) => e.host_id === h),
    get: (h, s, t) => m.get(key(h, s, t)) ?? null,
    put: (e) => { m.set(key(e.host_id, e.session_id, e.transcript_id), { ...e }); },
    remove: (h, s, t) => { m.delete(key(h, s, t)); },
    purgeHost: (h) => { for (const [k, e] of [...m]) if (e.host_id === h) m.delete(k); },
    purgeProject: (h, p) => { for (const [k, e] of [...m]) if (e.host_id === h && e.project_id === p) m.delete(k); },
  };
}

function target(opts: { hostId?: string; hostUrl?: string; projectId?: string } = {}): RemoteTarget {
  return {
    projectId: (opts.projectId ?? 'proj_0123456789abcdef0123456789abcdef') as RemoteTarget['projectId'],
    groveId: 'grove_0123456789abcdef0123456789abcdef',
    host: {
      host_id: opts.hostId ?? HOST_A,
      label: 'H',
      host_url: opts.hostUrl ?? 'https://host-a.tailnet.ts.net:8443',
      protocol_version: HOST_PROTOCOL_VERSION,
    },
    bearer: 'b',
  };
}

/** Deps that PIN the mid-turn throttle off (constant clock + no-op timers) so the
 *  only drain is the explicit `flushBeforeForward`/`drainAll` the test drives —
 *  the leading edge never fires and the trailing timer never runs. */
const noThrottle = {
  lockNamespace: testPerUserLockNamespace,
  now: () => 1000,
  intervalMs: 100_000,
  setTimer: (() => 0) as unknown as (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
  clearTimer: () => {},
};

const waitFor = async (pred: () => boolean, ms = 1000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// ---------------------------------------------------------------------------
// Offset authority — the reviewer-flagged tail-not-dropped case
// ---------------------------------------------------------------------------

describe('offset authority (re-slice from the host-returned size)', () => {
  test('partial-overlap replay: the next send re-slices from the host size — the tail is NOT dropped', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'AAAA\nBBBB\nCCCC\n', 1); // full member file: 15 bytes
    const host = multiFakeHost();
    host.seed(HOST_A, 'AAAA\nBBBB\n'); // host already holds the first 10 bytes
    const store = memStore();
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();

    q.noteCollect(t, { session_id: 'sess-1', transcript_path: p, agent: 'claude-code', type: 'tool' });
    await q.flushBeforeForward(t);

    // First send at base 0 overlaps → host answers replay, size 10; the member
    // re-slices from 10 and appends the tail. Assumed base+len would have skipped [10,15).
    expect(host.calls.map((c) => c.body.base_offset)).toEqual([0, 10]);
    expect(host.content(HOST_A)).toBe('AAAA\nBBBB\nCCCC\n');
    expect(host.content(HOST_A)).toContain('CCCC'); // the tail landed

    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: p, inode: 1 });
    expect(store.get(HOST_A, 'sess-1', tid)!.acked_offset).toBe(15); // high-water = host size
  });

  test('a fresh full drain ships from 0 to EOF and records the host size', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'one\ntwo\n', 1);
    const host = multiFakeHost();
    const store = memStore();
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, { session_id: 's', transcript_path: p });
    await q.flushBeforeForward(t);
    expect(host.content(HOST_A)).toBe('one\ntwo\n');
    expect(host.calls.map((c) => c.body.base_offset)).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// 409 gap + idempotency
// ---------------------------------------------------------------------------

describe('409 offset_gap + idempotent re-drain', () => {
  test('a gap resends from the host-returned size', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'AAAA\nBBBB\n', 1); // 10 bytes
    const store = memStore();
    const t = target();
    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: p, inode: 1 });
    // Member believes the host holds 5 bytes; the host actually holds 0 (restart/GC).
    store.put({
      host_id: HOST_A, session_id: 's', transcript_id: tid, project_id: t.projectId,
      grove_id: t.groveId, transcript_path: p, acked_offset: 5, updated_at: 'x',
    });
    const host = multiFakeHost(); // empty
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: host.transport, fileReader: files.reader, ...noThrottle });

    await q.flushBeforeForward(t);

    expect(host.calls.map((c) => c.body.base_offset)).toEqual([5, 0]); // gap (5>0) then resend from 0
    expect(host.content(HOST_A)).toBe('AAAA\nBBBB\n');
    expect(store.get(HOST_A, 's', tid)!.acked_offset).toBe(10);
  });

  test('re-draining after a full ack is a no-op (no further POSTs)', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'x\ny\n', 1);
    const host = multiFakeHost();
    const store = memStore();
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, { session_id: 's', transcript_path: p });
    await q.flushBeforeForward(t);
    const after = host.calls.length;
    await q.flushBeforeForward(t); // file unchanged → nothing to send
    expect(host.calls.length).toBe(after);
  });
});

// ---------------------------------------------------------------------------
// Multi-team — a member belongs to several teams at once, and each host's
// traffic must go to THAT host. Under the URL transport there is no shared
// tunnel or port allocator to keep them apart: the only thing separating two
// teams is that each host record carries its own address and its own bearer.
// ---------------------------------------------------------------------------

describe('multi-host', () => {
  test('two attached projects on two hosts drain to their OWN host URL', async () => {
    const files = memFiles();
    files.set('/a.jsonl', 'a1\na2\n', 1);
    files.set('/b.jsonl', 'b1\nb2\n', 2);
    const host = multiFakeHost();
    const store = memStore();
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: host.transport, fileReader: files.reader, ...noThrottle });

    const tA = target({ hostId: HOST_A, hostUrl: 'https://team-a.tailnet.ts.net:8443', projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const tB = target({ hostId: HOST_B, hostUrl: 'https://team-b.tailnet.ts.net:8443', projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    q.noteCollect(tA, { session_id: 'sa', transcript_path: '/a.jsonl' });
    q.noteCollect(tB, { session_id: 'sb', transcript_path: '/b.jsonl' });
    await q.flushBeforeForward(tA);
    await q.flushBeforeForward(tB);

    expect(host.content(HOST_A)).toBe('a1\na2\n');
    expect(host.content(HOST_B)).toBe('b1\nb2\n');
    const urlsA = new Set(host.calls.filter((c) => c.hostId === HOST_A).map((c) => c.hostUrl));
    const urlsB = new Set(host.calls.filter((c) => c.hostId === HOST_B).map((c) => c.hostUrl));
    expect([...urlsA]).toEqual(['https://team-a.tailnet.ts.net:8443']);
    expect([...urlsB]).toEqual(['https://team-b.tailnet.ts.net:8443']);
  });
});

// ---------------------------------------------------------------------------
// Persistence across restart + prune-only-acked + purge-on-detach
// ---------------------------------------------------------------------------

describe('durability discipline', () => {
  let tmp: string;
  let saved: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-drain-'));
    saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the high-water persists across a simulated daemon restart (fs store)', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'x1\nx2\n', 1);
    const t = target();

    const host1 = multiFakeHost();
    const q1 = new TranscriptDrainQueue({ machineId: MACHINE, store: createFsDrainStore(), transport: host1.transport, fileReader: files.reader, ...noThrottle });
    q1.noteCollect(t, { session_id: 's', transcript_path: p });
    await q1.flushBeforeForward(t);
    expect(host1.content(HOST_A)).toBe('x1\nx2\n');

    // The turn grows the transcript; a fresh queue (restart) reads the SAME store dir.
    files.append(p, 'x3\n');
    const host2 = multiFakeHost();
    host2.seed(HOST_A, 'x1\nx2\n'); // the host still holds what q1 shipped
    const q2 = new TranscriptDrainQueue({
      machineId: MACHINE, store: createFsDrainStore(), transport: host2.transport, fileReader: files.reader,
      resolveHostTarget: () => t, ...noThrottle,
    });
    await q2.drainAll();
    // Resumed from the PERSISTED high-water (6), not 0.
    expect(host2.calls.map((c) => c.body.base_offset)).toEqual([6]);
    expect(host2.content(HOST_A)).toBe('x1\nx2\nx3\n');
  });

  test('prune-only-acked: a failed POST leaves the high-water unadvanced (retry next tick)', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'q1\nq2\n', 1);
    const store = memStore();
    const t = target();
    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: p, inode: 1 });

    const throwing: TranscriptPostTransport = async () => { throw new Error('network down'); };
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: throwing, fileReader: files.reader, ...noThrottle });
    q.noteCollect(t, { session_id: 's', transcript_path: p });
    await q.flushBeforeForward(t); // never throws into the caller
    expect(store.get(HOST_A, 's', tid)!.acked_offset).toBe(0); // NOT advanced
    expect(q.pendingCount()).toBe(1);

    // A reachable host then drains it — the entry was retained, nothing lost.
    const host = multiFakeHost();
    const q2 = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    await q2.flushBeforeForward(t);
    expect(store.get(HOST_A, 's', tid)!.acked_offset).toBe(6);
    expect(host.content(HOST_A)).toBe('q1\nq2\n');
  });

  test('purge-on-detach clears the project entries for that host', () => {
    const files = memFiles();
    files.set('/a.jsonl', 'a\n', 1);
    const store = memStore();
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, { session_id: 's', transcript_path: '/a.jsonl' });
    expect(store.list()).toHaveLength(1);
    q.purgeProject(t.host.host_id, t.projectId as string);
    expect(store.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rotation + deep-sleep inhibitor
// ---------------------------------------------------------------------------

describe('rotation + hold.pending', () => {
  test('a rotated entry (inode changed) is not pending and never ships old-file bytes', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'old\n', 1);
    const store = memStore();
    const host = multiFakeHost();
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, { session_id: 's', transcript_path: p });
    const oldTid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: p, inode: 1 });

    // Rotate the file (new inode) BEFORE the old entry ever drained.
    files.rotate(p, 'brand new content\n', 2);
    expect(q.pendingCount()).toBe(0); // inode mismatch → inert, must not hold the machine awake

    await q.flushBeforeForward(t);
    // The old entry is removed (unreachable bytes), and no old-file bytes were shipped.
    expect(store.get(HOST_A, 's', oldTid)).toBeNull();
    expect(host.calls).toHaveLength(0);
  });

  test('pendingCount reflects un-shipped growth and drives the JobRunner deep-sleep hold', () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'a\nb\n', 1); // 4 bytes
    const store = memStore();
    const t = target();
    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: p, inode: 1 });
    store.put({
      host_id: HOST_A, session_id: 's', transcript_id: tid, project_id: t.projectId,
      grove_id: t.groveId, transcript_path: p, acked_offset: 0, updated_at: 'x',
    });
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, fileReader: files.reader, ...noThrottle });
    expect(q.pendingCount()).toBe(1);

    const runner = new JobRunner({ concurrency: 2, logger: new DaemonLogger(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-jr-'))) });
    runner.register({
      name: 'team-host-transcript-drain',
      runIn: ['sleep'],
      kind: 'housekeeping',
      hold: { pending: () => q.pendingCount() },
      fn: async () => {},
    });
    expect(runner.providesHold()).toBe('team-host-transcript-drain'); // pending → deep sleep inhibited

    store.put({ ...store.get(HOST_A, 's', tid)!, acked_offset: 4 }); // caught up
    expect(q.pendingCount()).toBe(0);
    expect(runner.providesHold()).toBeNull(); // no pending → deep sleep allowed
  });
});

// ---------------------------------------------------------------------------
// Session-terminal prune (consolidation Task C-2, item 1)
// ---------------------------------------------------------------------------

describe('noteSessionEnded prune (item 1 — prune only acked)', () => {
  test('a fully-acked entry for the ended session is pruned', () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'a\nb\n', 1); // 4 bytes
    const store = memStore();
    const t = target();
    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: p, inode: 1 });
    store.put({
      host_id: HOST_A, session_id: 's', transcript_id: tid, project_id: t.projectId,
      grove_id: t.groveId, transcript_path: p, acked_offset: 4, updated_at: 'x', // caught up
    });
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, fileReader: files.reader, ...noThrottle });

    q.noteSessionEnded(HOST_A, 's');

    expect(store.get(HOST_A, 's', tid)).toBeNull();
  });

  test('an entry with un-shipped bytes is left untouched — prune-only-acked', () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'a\nb\n', 1); // 4 bytes
    const store = memStore();
    const t = target();
    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: p, inode: 1 });
    store.put({
      host_id: HOST_A, session_id: 's', transcript_id: tid, project_id: t.projectId,
      grove_id: t.groveId, transcript_path: p, acked_offset: 2, updated_at: 'x', // NOT caught up
    });
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, fileReader: files.reader, ...noThrottle });

    q.noteSessionEnded(HOST_A, 's');

    expect(store.get(HOST_A, 's', tid)).not.toBeNull();
    expect(store.get(HOST_A, 's', tid)!.acked_offset).toBe(2); // unchanged
  });

  test('a rotated (inert) entry is pruned even though it never caught up', () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'old\n', 1);
    const store = memStore();
    const t = target();
    const oldTid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: p, inode: 1 });
    store.put({
      host_id: HOST_A, session_id: 's', transcript_id: oldTid, project_id: t.projectId,
      grove_id: t.groveId, transcript_path: p, acked_offset: 0, updated_at: 'x',
    });
    files.rotate(p, 'brand new\n', 2); // inode changed — old bytes unreachable
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, fileReader: files.reader, ...noThrottle });

    q.noteSessionEnded(HOST_A, 's');

    expect(store.get(HOST_A, 's', oldTid)).toBeNull();
  });

  test('a different session on the same host is left alone', () => {
    const files = memFiles();
    const p = '/m/other.jsonl';
    files.set(p, 'x\n', 1);
    const store = memStore();
    const t = target();
    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: p, inode: 1 });
    store.put({
      host_id: HOST_A, session_id: 'other-session', transcript_id: tid, project_id: t.projectId,
      grove_id: t.groveId, transcript_path: p, acked_offset: 2, updated_at: 'x', // caught up
    });
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, fileReader: files.reader, ...noThrottle });

    q.noteSessionEnded(HOST_A, 's'); // ends a DIFFERENT session

    expect(store.get(HOST_A, 'other-session', tid)).not.toBeNull();
  });

  test('an unreadable file (stat fails) is left untouched — cannot prove caught-up', () => {
    const store = memStore();
    const t = target();
    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: '/gone.jsonl', inode: 1 });
    store.put({
      host_id: HOST_A, session_id: 's', transcript_id: tid, project_id: t.projectId,
      grove_id: t.groveId, transcript_path: '/gone.jsonl', acked_offset: 0, updated_at: 'x',
    });
    const emptyReader: TranscriptFileReader = { stat: () => null, readSlice: () => Buffer.alloc(0) };
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, fileReader: emptyReader, ...noThrottle });

    q.noteSessionEnded(HOST_A, 's');

    expect(store.get(HOST_A, 's', tid)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Atomic drain-entry write (consolidation Task C-2, item 2)
// ---------------------------------------------------------------------------

describe('fs drain-entry store atomicity (item 2 — write-then-rename)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-drain-atomic-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('interrupt simulation: a torn `.tmp` leftover from a simulated crash never corrupts a read, and the next real write self-heals it', () => {
    const store = createFsDrainStore(tmp);
    const t = target();
    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: '/m/s.jsonl', inode: 1 });
    const entry: DrainEntry = {
      host_id: HOST_A, session_id: 's', transcript_id: tid, project_id: t.projectId,
      grove_id: t.groveId, transcript_path: '/m/s.jsonl', acked_offset: 4, updated_at: 'x',
    };
    store.put(entry); // establishes the real file via write-then-rename

    // Simulate a crash mid-write of a LATER put(): the tmp file was written but the
    // process died before the rename — leaving a torn/incomplete `.tmp` sibling.
    const finalPath = path.join(tmp, HOST_A, 's', `${tid}.json`);
    expect(fs.existsSync(finalPath)).toBe(true); // ground the assumed layout before relying on it
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, '{"host_id":"' + HOST_A); // deliberately truncated JSON

    // The read path only ever opens the FINAL path — the torn tmp is invisible.
    expect(store.get(HOST_A, 's', tid)).toEqual(entry);

    // A subsequent legitimate write overwrites both the stale tmp and the final
    // file cleanly (self-heals — no leftover torn state survives a real put()).
    const advanced = { ...entry, acked_offset: 8 };
    store.put(advanced);
    expect(store.get(HOST_A, 's', tid)).toEqual(advanced);
    expect(fs.existsSync(tmpPath)).toBe(false); // renamed away, not left dangling
  });

  test('a crash BEFORE the tmp write leaves the prior committed entry intact (rename never partially applies)', () => {
    const store = createFsDrainStore(tmp);
    const t = target();
    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: '/m/s.jsonl', inode: 1 });
    const entry: DrainEntry = {
      host_id: HOST_A, session_id: 's', transcript_id: tid, project_id: t.projectId,
      grove_id: t.groveId, transcript_path: '/m/s.jsonl', acked_offset: 4, updated_at: 'x',
    };
    store.put(entry);

    // No tmp file at all (the "crash" happens before writeFileSync even starts) —
    // reading must return the last fully-committed entry, never a partial one.
    expect(store.get(HOST_A, 's', tid)).toEqual(entry);
  });

  test('remove() reaps a torn `.tmp` sibling alongside the entry', () => {
    const store = createFsDrainStore(tmp);
    const t = target();
    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: '/m/s.jsonl', inode: 1 });
    store.put({
      host_id: HOST_A, session_id: 's', transcript_id: tid, project_id: t.projectId,
      grove_id: t.groveId, transcript_path: '/m/s.jsonl', acked_offset: 4, updated_at: 'x',
    });
    const finalPath = path.join(tmp, HOST_A, 's', `${tid}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, '{"torn'); // crash-mid-put leftover

    store.remove(HOST_A, 's', tid);

    expect(fs.existsSync(finalPath)).toBe(false);
    expect(fs.existsSync(tmpPath)).toBe(false); // sibling reaped, not orphaned
  });

  test('purgeProject reaps `.tmp` siblings of the purged entries', () => {
    const store = createFsDrainStore(tmp);
    const t = target();
    const tid = deriveTranscriptId({ machineId: MACHINE, transcriptPath: '/m/s.jsonl', inode: 1 });
    store.put({
      host_id: HOST_A, session_id: 's', transcript_id: tid, project_id: t.projectId,
      grove_id: t.groveId, transcript_path: '/m/s.jsonl', acked_offset: 4, updated_at: 'x',
    });
    const finalPath = path.join(tmp, HOST_A, 's', `${tid}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, '{"torn');

    store.purgeProject(HOST_A, t.projectId as string);

    expect(fs.existsSync(finalPath)).toBe(false);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Chokepoint wiring — flush + note threaded at BOTH dispatch chokepoints
// ---------------------------------------------------------------------------

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;

describe('chokepoint 1 (router dispatch) threads the capture deps', () => {
  let tmp: string;
  let saved: string | undefined;
  let server: DaemonServer;
  let base: string;
  let authToken: string;
  let flushCalls: number;
  let noteCalls: Array<Record<string, unknown>>;
  let sessionEndedCalls: Array<{ sessionId: string }>;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-drain-cp1-'));
    saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    flushCalls = 0;
    noteCalls = [];
    sessionEndedCalls = [];
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
      hostProxyDeps: {
        flushBeforeForward: async () => { flushCalls += 1; },
        noteCollectEvent: (_t, event) => { noteCalls.push(event); },
        bufferAppend: () => { /* keep the collect buffer off disk */ },
        noteSessionEnded: async (_t, sessionId) => { sessionEndedCalls.push({ sessionId }); },
      },
    });
    // Register stubs for the terminal collect routes so dispatch matches them.
    server.registerRoute('POST', '/events/stop', async () => ({ body: { ok: true } }));
    server.registerRoute('POST', '/sessions/unregister', async () => ({ body: { ok: true } }));
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

  test('a terminal collect route enqueues (note) and flushes before forwarding', async () => {
    const projectId = assertGroveProjectId(createProjectId());
    const host: HostRecord = {
      host_id: createHostId(),
      label: 'Mac Studio',
      // A CLOSED loopback port: the background forward fails at the dial,
      // AFTER the flush — which is the ordering under test. Deliberately not a
      // bogus hostname: that costs a real DNS lookup per run, and a resolver
      // with a wildcard or search-domain suffix answers it, turning an
      // instant refusal into a 10s timeout inside a unit suite.
      host_url: 'https://127.0.0.1:59',
      protocol_version: HOST_PROTOCOL_VERSION,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: createGroveId(), project_id: projectId }],
    };
    writeHostRecordFixture(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'host-bearer');

    const res = await fetch(`${base}/events/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-myco-project-id': projectId, 'x-myco-auth': authToken },
      body: JSON.stringify({ session_id: 's', type: 'stop', transcript_path: '/m/s.jsonl' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).buffered).toBe(true);

    // note fires synchronously (before the ack); flush fires in the background forward.
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].transcript_path).toBe('/m/s.jsonl');
    await waitFor(() => flushCalls > 0);
    expect(flushCalls).toBe(1);
    // /events/stop is a flush-before-forward route but NOT the session-terminal
    // one — noteSessionEnded must never fire for it (item 6/item-1 wiring).
    expect(sessionEndedCalls).toHaveLength(0);
  });

  test('/sessions/unregister flushes AND fires noteSessionEnded — after the flush, with the ended session id', async () => {
    const projectId = assertGroveProjectId(createProjectId());
    const host: HostRecord = {
      host_id: createHostId(),
      label: 'Mac Studio',
      // A CLOSED loopback port: the background forward fails at the dial,
      // AFTER the flush — which is the ordering under test. Deliberately not a
      // bogus hostname: that costs a real DNS lookup per run, and a resolver
      // with a wildcard or search-domain suffix answers it, turning an
      // instant refusal into a 10s timeout inside a unit suite.
      host_url: 'https://127.0.0.1:59',
      protocol_version: HOST_PROTOCOL_VERSION,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: createGroveId(), project_id: projectId }],
    };
    writeHostRecordFixture(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'host-bearer');

    const res = await fetch(`${base}/sessions/unregister`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-myco-project-id': projectId, 'x-myco-auth': authToken },
      body: JSON.stringify({ session_id: 'ending-session' }),
    });
    expect(res.status).toBe(200);

    await waitFor(() => sessionEndedCalls.length > 0);
    expect(flushCalls).toBe(1); // flush happened
    expect(sessionEndedCalls).toEqual([{ sessionId: 'ending-session' }]);
  });
});

describe('chokepoint 2 (/mcp) threads the capture deps', () => {
  let tmp: string;
  let vaultDir: string;
  let savedTeam: string | undefined;
  let savedAuth: string | undefined;
  let member: http.Server;
  let memberPort: number;
  let hostServer: http.Server;
  let hostHits: number;
  let hostUrl: string;
  let edge2: FunnelEdge;
  let dialCalls: number;
  let cp2FlushCalls: number;
  let cp2NoteCalls: number;
  let cp2SessionEndedCalls: number;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-drain-cp2-'));
    vaultDir = path.join(tmp, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    savedTeam = process.env.MYCO_TEAM_HOME;
    savedAuth = process.env.MYCO_DAEMON_AUTH;
    process.env.MYCO_TEAM_HOME = tmp;
    delete process.env.MYCO_DAEMON_AUTH;

    hostHits = 0;
    dialCalls = 0;
    cp2FlushCalls = 0;
    cp2NoteCalls = 0;
    cp2SessionEndedCalls = 0;
    hostServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hostHits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
      });
    });
    const hostPort = await new Promise<number>((resolve) =>
      hostServer.listen(0, '127.0.0.1', () => resolve((hostServer.address() as AddressInfo).port)));
    edge2 = await startFunnelEdge({ port: hostPort });
    hostUrl = edge2.url;

    const handler = createStreamableMcpHttpHandler(vaultDir, {
      lockNamespace: testPerUserLockNamespace,
      resolveDatabase: () => ({} as never),
      // The FULL capture-deps shape threaded at chokepoint 2 — the same object
      // shape main.ts's captureProxyDeps carries. A spy `dial` proves the
      // handler forwards hostProxyDeps into handleAttachedRequest; the three
      // capture seams are spied so their (non-)firing on the serve-only /mcp
      // path is asserted rather than assumed. Passing all of them here also
      // pins the seam names at compile time (a renamed/typo'd field is a TS
      // excess-property error), so chokepoint-2 wiring can't silently drift
      // from chokepoint-1's.
      hostProxyDeps: {
        dial: (t, opts) => { dialCalls += 1; return defaultDial(t, opts); },
        flushBeforeForward: async () => { cp2FlushCalls += 1; },
        noteCollectEvent: () => { cp2NoteCalls += 1; },
        noteSessionEnded: async () => { cp2SessionEndedCalls += 1; },
      },
    });
    member = http.createServer((req, res) => { void handler(req, res); });
    memberPort = await new Promise<number>((resolve) =>
      member.listen(0, '127.0.0.1', () => resolve((member.address() as AddressInfo).port)));
  });
  afterEach(async () => {
    (member as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    (hostServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await edge2.close();
    await new Promise<void>((resolve) => member.close(() => resolve()));
    await new Promise<void>((resolve) => hostServer.close(() => resolve()));
    if (savedTeam === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeam;
    if (savedAuth === undefined) delete process.env.MYCO_DAEMON_AUTH;
    else process.env.MYCO_DAEMON_AUTH = savedAuth;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('an attached /mcp call is proxied through the threaded dial', async () => {
    const projectId = assertGroveProjectId(createProjectId());
    const host: HostRecord = {
      host_id: createHostId(),
      label: 'Mac Studio',
      host_url: hostUrl,
      protocol_version: HOST_PROTOCOL_VERSION,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: createGroveId(), project_id: projectId }],
    };
    writeHostRecordFixture(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'host-bearer');

    const res = await fetch(`http://127.0.0.1:${memberPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [REQUEST_CONTEXT_HEADERS.projectId]: projectId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_search', arguments: { type: 'session' } } }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(dialCalls).toBe(1); // the threaded dial was used
    expect(hostHits).toBe(1);
    // The /mcp path is serve-only — none of the capture seams may fire here.
    // They are threaded (typed + accepted above) so the guarantee cannot
    // silently regress if /mcp ever carries a flush/collect/terminal route,
    // but on today's serve classification they must stay silent.
    expect(cp2FlushCalls).toBe(0);
    expect(cp2NoteCalls).toBe(0);
    expect(cp2SessionEndedCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Drain health (consolidation Task C-5 — routed-capture observability)
// ---------------------------------------------------------------------------

describe('drain health (consolidation Task C-5)', () => {
  test('a fully-shipped entry reports zero counters (no pendingUnits key)', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'x1\n', 1);
    const store = memStore();
    const host = multiFakeHost();
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, { session_id: 's', transcript_path: p });
    await q.flushBeforeForward(t);

    expect(q.health().get(HOST_A)).toEqual({ pendingEntries: 0, failingEntries: 0, hostUnreachableEntries: 0 });
  });

  test('a transport failure counts as failing AND host-unreachable, with pending bytes sized', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'q1\nq2\n', 1); // 6 bytes
    const store = memStore();
    const t = target();
    const throwing: TranscriptPostTransport = async () => { throw new Error('network down'); };
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: throwing, fileReader: files.reader, ...noThrottle });
    q.noteCollect(t, { session_id: 's', transcript_path: p });
    await q.flushBeforeForward(t);

    expect(q.health().get(HOST_A)).toEqual({
      pendingEntries: 1,
      pendingUnits: 6,
      failingEntries: 1,
      hostUnreachableEntries: 1,
    });
  });

  test('a rejected (unexpected) host response counts as failing but NOT host-unreachable', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'q1\n', 1);
    const store = memStore();
    const t = target();
    const rejecting: TranscriptPostTransport = async () => ({ status: 500, size: null });
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: rejecting, fileReader: files.reader, ...noThrottle });
    q.noteCollect(t, { session_id: 's', transcript_path: p });
    await q.flushBeforeForward(t);

    const counters = q.health().get(HOST_A);
    expect(counters?.failingEntries).toBe(1);
    expect(counters?.hostUnreachableEntries).toBe(0);
  });

  test('a later successful drain clears a prior failure', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'q1\nq2\n', 1);
    const store = memStore();
    const t = target();

    const throwing: TranscriptPostTransport = async () => { throw new Error('network down'); };
    const q1 = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: throwing, fileReader: files.reader, ...noThrottle });
    q1.noteCollect(t, { session_id: 's', transcript_path: p });
    await q1.flushBeforeForward(t);
    expect(q1.health().get(HOST_A)?.failingEntries).toBe(1);

    const host = multiFakeHost();
    const q2 = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    await q2.flushBeforeForward(t);
    expect(q2.health().get(HOST_A)).toEqual({ pendingEntries: 0, failingEntries: 0, hostUnreachableEntries: 0 });
  });

  test('an inert (rotated) entry\'s stale failure never counts — no permanent false doctor warning (reviewer repro)', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'q1\nq2\n', 1);
    const store = memStore();
    const t = target();

    // 1. One transport failure recorded against the inode-1 entry.
    const throwing: TranscriptPostTransport = async () => { throw new Error('network down'); };
    const q1 = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: throwing, fileReader: files.reader, ...noThrottle });
    q1.noteCollect(t, { session_id: 's', transcript_path: p });
    await q1.flushBeforeForward(t);
    expect(q1.health().get(HOST_A)?.hostUnreachableEntries).toBe(1);

    // 2. The file rotates (new inode) — the old entry's bytes are unreachable
    //    forever; drainEntry would remove the inert entry on the next LIVE
    //    cycle, but the doctor path never runs one.
    files.rotate(p, 'fresh\n', 2);

    // 3. A FRESH queue over the same store (doctor's disk-only construction):
    //    the stale failure must NOT read as failing/unreachable — otherwise
    //    every doctor run warns forever while the daemon is down.
    const q2 = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: throwing, fileReader: files.reader, ...noThrottle });
    expect(q2.health().get(HOST_A)).toEqual({ pendingEntries: 0, failingEntries: 0, hostUnreachableEntries: 0 });
  });

  test('a caught-up (fully-acked) pass clears a stale failure on the STORED entry, with no transport attempt', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'q1\nq2\n', 1); // 6 bytes
    const store = memStore();
    const t = target();
    const transcriptId = deriveTranscriptId({ machineId: MACHINE, transcriptPath: p, inode: 1 });

    // Seed an entry that is ALREADY fully acked (acked_offset === file size)
    // but still carries a stale failure from a past incident — the state a
    // genuinely-recovered entry is left in before this fix.
    store.put({
      host_id: HOST_A, session_id: 's', transcript_id: transcriptId,
      project_id: 'proj_0123456789abcdef0123456789abcdef', grove_id: 'grove_0123456789abcdef0123456789abcdef',
      transcript_path: p, acked_offset: 6, updated_at: '2020-01-01T00:00:00.000Z',
      consecutive_failures: 3, last_error_kind: 'unreachable', last_error_at: '2020-01-01T00:00:00.000Z',
    });

    const host = multiFakeHost();
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    await q.flushBeforeForward(t);

    // No POST happened — this was a genuine no-op, not a retry that happened to succeed.
    expect(host.calls).toHaveLength(0);
    const entry = store.get(HOST_A, 's', transcriptId);
    expect(entry?.consecutive_failures).toBe(0);
    expect(entry?.last_error_kind).toBeNull();
  });

  test('health aggregates per host — a second host with no entries is simply absent from the map', async () => {
    const files = memFiles();
    const p = '/m/s.jsonl';
    files.set(p, 'a\n', 1);
    const store = memStore();
    const host = multiFakeHost();
    const q = new TranscriptDrainQueue({ machineId: MACHINE, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    q.noteCollect(target({ hostId: HOST_A }), { session_id: 's', transcript_path: p });
    await q.flushBeforeForward(target({ hostId: HOST_A }));

    const health = q.health();
    expect(health.has(HOST_A)).toBe(true);
    expect(health.has(HOST_B)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default transport — the tenancy headers the host resolves the Grove DB from.
// Without these the host resolves groveId:null and the served-grove filter
// fail-closes POST /routed-capture/transcript for EVERY attached project
// (E-4 W2 T1c, the C2 regression).
// ---------------------------------------------------------------------------

describe('defaultTranscriptTransport (wire headers)', () => {
  let server: http.Server;
  let received: { method?: string; url?: string; headers: http.IncomingHttpHeaders } | null;
  let edge: FunnelEdge;

  beforeEach(async () => {
    received = null;
    server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        received = { method: req.method, url: req.url, headers: req.headers };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, size: 4, action: 'append' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    // The default transport dials HTTPS, so the fixture sits behind a real TLS
    // edge — the same shape a host's socket sits behind a Funnel.
    edge = await startFunnelEdge({ port: (server.address() as AddressInfo).port });
  });
  afterEach(async () => {
    await edge.close();
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('POSTs /routed-capture/transcript with the tenancy claims (project/grove/machine/session) + host bearer, no x-myco-auth', async () => {
    const t = target({ hostUrl: edge.url });
    const res = await defaultTranscriptTransport(t, {
      machine_id: MACHINE, session_id: 'sess-42', transcript_id: 'tid-1', base_offset: 0, bytes: Buffer.from('abcd').toString('base64'),
    });
    expect(res.status).toBe(200);
    expect(received).not.toBeNull();
    expect(received!.method).toBe('POST');
    expect(received!.url).toBe('/routed-capture/transcript');
    expect(received!.headers.authorization).toBe('Bearer b');
    expect(received!.headers[REQUEST_CONTEXT_HEADERS.projectId]).toBe(String(t.projectId));
    expect(received!.headers[REQUEST_CONTEXT_HEADERS.groveId]).toBe(t.groveId);
    expect(received!.headers[REQUEST_CONTEXT_HEADERS.machineId]).toBe(MACHINE);
    expect(received!.headers[REQUEST_CONTEXT_HEADERS.sessionId]).toBe('sess-42');
    // The member never sends x-myco-auth — the host re-stamps its own local bearer.
    expect(received!.headers['x-myco-auth']).toBeUndefined();
  });
});
