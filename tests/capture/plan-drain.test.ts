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
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
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
import { ABSENT, present, unknown } from '@myco/utils/presence';
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
import { createHostRegistryOperations, type HostRecord } from '@myco/host/registry';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { HOST_BEARER_SECRET } from '@myco/constants';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const MACHINE = 'alice_a1b2c3d4';
const { writeHostSecret } = createHostRegistryOperations(testPerUserLockNamespace);
const HOST_A = 'host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOST_B = 'host_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const WATCH: PlanWatchConfig = { watchDirs: ['/plans'], projectRoot: '/', extensions: ['.md'] };

// --- fakes -----------------------------------------------------------------

/** In-memory plan files the {@link PlanFileReader} reads. A path in `unreadable`
 *  models a file that exists but cannot be read (EACCES/EMFILE) — distinct from
 *  one that is genuinely gone. */
function memFiles() {
  const files = new Map<string, string>();
  const unreadable = new Set<string>();
  const reader: PlanFileReader = {
    read: (p) => {
      if (unreadable.has(p)) {
        return unknown(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
      }
      return files.has(p) ? present(files.get(p)!) : ABSENT;
    },
  };
  return {
    reader,
    set(p: string, content: string) { files.set(p, content); },
    remove(p: string) { files.delete(p); },
    makeUnreadable(p: string) { unreadable.add(p); },
    makeReadable(p: string) { unreadable.delete(p); },
  };
}

/** A fake host recording every plan POST with its dial target — including the
 *  target's TENANCY (projectId/groveId), so cross-tenant routing is assertable. */
function fakeHost() {
  const calls: Array<{ hostId: string; proxyPort?: number; projectId: string; groveId: string; body: PlanChunkRequest }> = [];
  const transport: PlanPostTransport = async (target, body) => {
    calls.push({
      hostId: target.host.host_id,
      proxyPort: target.host.proxy_port,
      projectId: String(target.projectId),
      groveId: target.groveId,
      body,
    });
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

function target(opts: { hostId?: string; proxyPort?: number; overlay?: string; projectId?: string; groveId?: string; root?: string } = {}): RemoteTarget {
  return {
    projectId: (opts.projectId ?? 'proj_0123456789abcdef0123456789abcdef') as RemoteTarget['projectId'],
    groveId: opts.groveId ?? 'grove_0123456789abcdef0123456789abcdef',
    root: opts.root,
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
  lockNamespace: testPerUserLockNamespace,
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

/** Mirrors plan-drain.ts's private `hashContent` (sha256 hex) so tests can seed
 *  a store entry's `acked_hash` to match — or deliberately mismatch — content. */
function hashOf(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

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
// Per-request root scoping (C7) — a multi-project member's non-anchor
// attached project must classify plan writes against ITS OWN root, never
// the daemon's bootstrap-anchor root the queue was constructed with.
// ---------------------------------------------------------------------------

describe('per-request root scoping (non-anchor attached project)', () => {
  // Bound at construction to the bootstrap-anchor project — deliberately
  // NOT the non-anchor project this test's target represents. Relative
  // watchDirs (the realistic default — `agent.tasks`/`capture.plan_dirs`
  // config, e.g. `.agents/plans`) so root actually participates in the
  // match, unlike the absolute '/plans' fixture used elsewhere in this file.
  const ANCHOR_WATCH: PlanWatchConfig = { watchDirs: ['.agents/plans'], projectRoot: '/anchor-project', extensions: ['.md'] };

  test('a plan write under the NON-ANCHOR project root is classified using target.root, not the anchor root', () => {
    const files = memFiles();
    files.set('/other-project/.agents/plans/x.md', '# Plan\n\nbody');
    const host = fakeHost();
    const q = new PlanDrainQueue({
      machineId: MACHINE, planWatchConfig: ANCHOR_WATCH, store: memStore(),
      transport: host.transport, fileReader: files.reader, ...noThrottle,
    });
    // Attached to a DIFFERENT project than the anchor — its own checkout root.
    const t = target({ projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', root: '/other-project' });

    q.noteCollect(t, planEvent('s', '/other-project/.agents/plans/x.md'));

    // Classified relative to the REQUEST's root: '/other-project/.agents/plans'
    // is a plan dir for THIS project, even though it falls outside the
    // anchor's '/anchor-project/.agents/plans' watch dir.
    expect(q.pendingCount()).toBe(1);
  });

  test('without a root on the target (pre-root attach record), the anchor root is still the fallback', () => {
    const files = memFiles();
    files.set('/anchor-project/.agents/plans/x.md', '# Plan\n\nbody');
    const q = new PlanDrainQueue({
      machineId: MACHINE, planWatchConfig: ANCHOR_WATCH, store: memStore(), fileReader: files.reader, ...noThrottle,
    });
    const t = target(); // no root — legacy attach record
    q.noteCollect(t, planEvent('s', '/anchor-project/.agents/plans/x.md'));
    expect(q.pendingCount()).toBe(1);
  });

  test('a write that only matches the WRONG (anchor) root is correctly rejected when scoped by target.root', () => {
    const files = memFiles();
    const q = new PlanDrainQueue({
      machineId: MACHINE, planWatchConfig: ANCHOR_WATCH, store: memStore(), fileReader: files.reader, ...noThrottle,
    });
    const t = target({ projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', root: '/other-project' });
    // Under the ANCHOR's plans dir, not the request project's — must NOT enqueue.
    q.noteCollect(t, planEvent('s', '/anchor-project/.agents/plans/x.md'));
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
// Cross-tenant safety — two projects on ONE host (the misroute the batch drain
// would produce if the transport stamped the batch target's tenancy)
// ---------------------------------------------------------------------------

describe('cross-tenant safety (two projects, one host)', () => {
  const PROJ_A = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const PROJ_B = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const GROVE_A = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const GROVE_B = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  test('each project’s plan POSTs with ITS OWN tenancy — B never lands in A’s Grove', async () => {
    const files = memFiles();
    files.set('/plans/a.md', 'A plan');
    files.set('/plans/b.md', 'B plan');
    const host = fakeHost();
    const store = memStore();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: host.transport, fileReader: files.reader, ...noThrottle });

    // Both projects are attached to the SAME host H (same host_id), different Grove.
    const tA = target({ hostId: HOST_A, projectId: PROJ_A, groveId: GROVE_A });
    const tB = target({ hostId: HOST_A, projectId: PROJ_B, groveId: GROVE_B });
    q.noteCollect(tA, planEvent('sa', '/plans/a.md'));
    q.noteCollect(tB, planEvent('sb', '/plans/b.md'));

    // A SINGLE host-drain (triggered by A's terminal route) drains BOTH entries.
    await q.flushBeforeForward(tA);

    expect(host.calls).toHaveLength(2);
    const byPlan = new Map(host.calls.map((c) => [c.body.plan_path, c]));
    // A's plan carries A's tenancy…
    expect(byPlan.get('/plans/a.md')).toMatchObject({ projectId: PROJ_A, groveId: GROVE_A });
    // …and B's plan carries B's tenancy, NOT A's (the leak the fix prevents).
    expect(byPlan.get('/plans/b.md')).toMatchObject({ projectId: PROJ_B, groveId: GROVE_B });
    // Belt-and-suspenders: B was never stamped with A's Grove.
    expect(byPlan.get('/plans/b.md')!.groveId).not.toBe(GROVE_A);
  });

  test('the backstop drainAll also scopes tenancy per-entry (resolveHostTarget path)', async () => {
    const files = memFiles();
    files.set('/plans/a.md', 'A');
    files.set('/plans/b.md', 'B');
    const host = fakeHost();
    const store = memStore();
    const tA = target({ hostId: HOST_A, projectId: PROJ_A, groveId: GROVE_A });
    const tB = target({ hostId: HOST_A, projectId: PROJ_B, groveId: GROVE_B });
    // Enqueue both, then drain via drainAll — the target is resolved from entries[0]
    // (project A), so a batch-tenancy bug would stamp BOTH as A.
    const q = new PlanDrainQueue({
      machineId: MACHINE, planWatchConfig: WATCH, store, transport: host.transport, fileReader: files.reader,
      resolveHostTarget: () => tA, ...noThrottle,
    });
    q.noteCollect(tA, planEvent('sa', '/plans/a.md'));
    q.noteCollect(tB, planEvent('sb', '/plans/b.md'));
    await q.drainAll();

    const byPlan = new Map(host.calls.map((c) => [c.body.plan_path, c]));
    expect(byPlan.get('/plans/a.md')).toMatchObject({ projectId: PROJ_A, groveId: GROVE_A });
    expect(byPlan.get('/plans/b.md')).toMatchObject({ projectId: PROJ_B, groveId: GROVE_B });
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

  test('an UNREADABLE plan file is kept for retry, not dequeued like a deleted one', async () => {
    const files = memFiles();
    files.set('/plans/x.md', 'here');
    const store = memStore();
    const host = fakeHost();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, planEvent('s', '/plans/x.md'));
    const ref = derivePlanRef('/plans/x.md');

    files.makeUnreadable('/plans/x.md'); // present on disk, but EACCES right now
    expect(q.pendingCount()).toBe(1); // still owed → must hold the machine awake
    await q.flushBeforeForward(t);

    const kept = store.get(HOST_A, 's', ref);
    expect(kept).not.toBeNull();
    expect(kept!.last_error_kind).toBe('unreadable');
    expect(host.calls).toHaveLength(0); // nothing shipped — the content was never read

    // The transient condition clears and the plan ships on a later tick.
    files.makeReadable('/plans/x.md');
    await q.flushBeforeForward(t);
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]!.body.content).toBe('here');
  });

  test('an unreadable entry surfaces as pending in drain health, not as healthy', () => {
    const files = memFiles();
    files.set('/plans/x.md', 'here');
    const store = memStore();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, fileReader: files.reader, ...noThrottle });
    q.noteCollect(target(), planEvent('s', '/plans/x.md'));

    files.makeUnreadable('/plans/x.md');

    expect(q.health().get(HOST_A)?.pendingEntries).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Session-terminal prune (consolidation Task C-2, item 3 — plan-drain
// equivalent of the transcript drain's noteSessionEnded)
// ---------------------------------------------------------------------------

describe('noteSessionEnded prune (item 3 — prune only acked)', () => {
  test('a fully-acked (unchanged since last ack) entry for the ended session is pruned', () => {
    const files = memFiles();
    files.set('/plans/x.md', 'content');
    const store = memStore();
    const t = target();
    const ref = derivePlanRef('/plans/x.md');
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, fileReader: files.reader, ...noThrottle });
    store.put({
      host_id: HOST_A, session_id: 's', plan_ref: ref, project_id: t.projectId, grove_id: t.groveId,
      plan_path: '/plans/x.md', acked_hash: hashOf('content'), updated_at: 'x', // caught up
    });

    q.noteSessionEnded(HOST_A, 's');

    expect(store.get(HOST_A, 's', ref)).toBeNull();
  });

  test('a changed (un-acked) file is left untouched — prune-only-acked', () => {
    const files = memFiles();
    files.set('/plans/x.md', 'new content');
    const store = memStore();
    const t = target();
    const ref = derivePlanRef('/plans/x.md');
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, fileReader: files.reader, ...noThrottle });
    store.put({
      host_id: HOST_A, session_id: 's', plan_ref: ref, project_id: t.projectId, grove_id: t.groveId,
      plan_path: '/plans/x.md', acked_hash: hashOf('stale content'), updated_at: 'x', // stale — NOT caught up
    });

    q.noteSessionEnded(HOST_A, 's');

    expect(store.get(HOST_A, 's', ref)).not.toBeNull();
  });

  test('a missing plan file is pruned (mirrors drainEntry\'s existing missing-file prune)', () => {
    const files = memFiles(); // '/plans/x.md' never set — file is "gone"
    const store = memStore();
    const t = target();
    const ref = derivePlanRef('/plans/x.md');
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, fileReader: files.reader, ...noThrottle });
    store.put({
      host_id: HOST_A, session_id: 's', plan_ref: ref, project_id: t.projectId, grove_id: t.groveId,
      plan_path: '/plans/x.md', acked_hash: null, updated_at: 'x',
    });

    q.noteSessionEnded(HOST_A, 's');

    expect(store.get(HOST_A, 's', ref)).toBeNull();
  });

  test('a different session on the same host is left alone', () => {
    const files = memFiles();
    files.set('/plans/other.md', 'content');
    const store = memStore();
    const t = target();
    const ref = derivePlanRef('/plans/other.md');
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, fileReader: files.reader, ...noThrottle });
    store.put({
      host_id: HOST_A, session_id: 'other-session', plan_ref: ref, project_id: t.projectId, grove_id: t.groveId,
      plan_path: '/plans/other.md', acked_hash: hashOf('content'), updated_at: 'x', // caught up
    });

    q.noteSessionEnded(HOST_A, 's'); // ends a DIFFERENT session

    expect(store.get(HOST_A, 'other-session', ref)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Atomic drain-entry write (consolidation Task C-2, item 2 — plan-drain
// equivalent of the transcript drain's write-then-rename verification)
// ---------------------------------------------------------------------------

describe('fs drain-entry store atomicity (item 2 — write-then-rename)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-drain-atomic-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('interrupt simulation: a torn `.tmp` leftover never corrupts a read, and the next real write self-heals it', () => {
    const store = createFsPlanDrainStore(tmp);
    const t = target();
    const ref = derivePlanRef('/plans/x.md');
    const entry: PlanDrainEntry = {
      host_id: HOST_A, session_id: 's', plan_ref: ref, project_id: t.projectId, grove_id: t.groveId,
      plan_path: '/plans/x.md', acked_hash: 'abc', updated_at: 'x',
    };
    store.put(entry);

    const finalPath = path.join(tmp, HOST_A, 's', `${ref}.json`);
    expect(fs.existsSync(finalPath)).toBe(true);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, '{"host_id":"' + HOST_A); // deliberately truncated JSON

    expect(store.get(HOST_A, 's', ref)).toEqual(entry); // torn tmp is invisible to reads

    const advanced = { ...entry, acked_hash: 'def' };
    store.put(advanced);
    expect(store.get(HOST_A, 's', ref)).toEqual(advanced);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  test('remove() reaps a torn `.tmp` sibling alongside the entry', () => {
    const store = createFsPlanDrainStore(tmp);
    const t = target();
    const ref = derivePlanRef('/plans/x.md');
    store.put({
      host_id: HOST_A, session_id: 's', plan_ref: ref, project_id: t.projectId, grove_id: t.groveId,
      plan_path: '/plans/x.md', acked_hash: 'abc', updated_at: 'x',
    });
    const finalPath = path.join(tmp, HOST_A, 's', `${ref}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, '{"torn'); // crash-mid-put leftover

    store.remove(HOST_A, 's', ref);

    expect(fs.existsSync(finalPath)).toBe(false);
    expect(fs.existsSync(tmpPath)).toBe(false); // sibling reaped, not orphaned
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
  let store: PlanDrainStore;
  let q: PlanDrainQueue;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-cp1-'));
    saved = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    host = fakeHost();
    files = memFiles();
    files.set('/plans/x.md', '# routed plan\n\nshipped on Stop flush');
    store = memStore();
    q = new PlanDrainQueue({
      machineId: MACHINE, planWatchConfig: WATCH, store, transport: host.transport, fileReader: files.reader, ...noThrottle,
    });
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      lockNamespace: testPerUserLockNamespace,
      hostProxyDeps: { ...q.proxyDeps(), bufferAppend: () => { /* keep the collect buffer off disk */ } },
    });
    // Stub both collect routes so the router matches them and the collect proxy
    // (attached-project classification) engages — the same setup the transcript
    // chokepoint test uses. The local handlers never run for a routed request.
    server.registerRoute('POST', '/events', async () => ({ body: { ok: true } }));
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
    writeHostRecordFixture(rec);
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

  test('/sessions/unregister flushes the plan content, then prunes the now-caught-up entry (item 3)', async () => {
    const projectId = assertGroveProjectId(createProjectId());
    const rec: HostRecord = {
      host_id: createHostId(),
      label: 'Mac Studio',
      overlay_address: '127.0.0.1:59', // dead port: the background forward fails AFTER flush
      protocol_version: 1,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: createGroveId(), project_id: projectId }],
    };
    writeHostRecordFixture(rec);
    writeHostSecret(rec.host_id, HOST_BEARER_SECRET, 'host-bearer');

    await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-myco-project-id': projectId, 'x-myco-auth': authToken },
      body: JSON.stringify(planEvent('ending-session', '/plans/x.md')),
    });
    expect(store.list()).toHaveLength(1); // enqueued, not yet shipped

    const res = await fetch(`${base}/sessions/unregister`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-myco-project-id': projectId, 'x-myco-auth': authToken },
      body: JSON.stringify({ session_id: 'ending-session' }),
    });
    expect(res.status).toBe(200);

    await waitFor(() => host.calls.length > 0); // the flush shipped the content
    expect(host.calls[0].body).toMatchObject({ session_id: 'ending-session', plan_path: '/plans/x.md' });
    await waitFor(() => store.list().length === 0); // then noteSessionEnded pruned the caught-up entry
  });
});

// ---------------------------------------------------------------------------
// Drain health (consolidation Task C-5 — routed-capture observability)
// ---------------------------------------------------------------------------

describe('drain health (consolidation Task C-5)', () => {
  test('a fully-shipped entry reports zero counters (no pendingUnits key)', async () => {
    const files = memFiles();
    files.set('/plans/x.md', '# plan');
    const store = memStore();
    const host = fakeHost();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    const t = target();
    q.noteCollect(t, planEvent('s', '/plans/x.md'));
    await q.flushBeforeForward(t);

    expect(q.health().get(HOST_A)).toEqual({ pendingEntries: 0, failingEntries: 0, hostUnreachableEntries: 0 });
  });

  test('a transport failure counts as failing AND host-unreachable, sized by the current content', async () => {
    const files = memFiles();
    files.set('/plans/x.md', '# plan body'); // 11 bytes
    const store = memStore();
    const t = target();
    const throwing: PlanPostTransport = async () => { throw new Error('network down'); };
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: throwing, fileReader: files.reader, ...noThrottle });
    q.noteCollect(t, planEvent('s', '/plans/x.md'));
    await q.flushBeforeForward(t);

    expect(q.health().get(HOST_A)).toEqual({
      pendingEntries: 1,
      pendingUnits: Buffer.byteLength('# plan body', 'utf-8'),
      failingEntries: 1,
      hostUnreachableEntries: 1,
    });
  });

  test('a rejected (unexpected) host response counts as failing but NOT host-unreachable', async () => {
    const files = memFiles();
    files.set('/plans/x.md', '# plan');
    const store = memStore();
    const t = target();
    const rejecting: PlanPostTransport = async () => ({ status: 500 });
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: rejecting, fileReader: files.reader, ...noThrottle });
    q.noteCollect(t, planEvent('s', '/plans/x.md'));
    await q.flushBeforeForward(t);

    const counters = q.health().get(HOST_A);
    expect(counters?.failingEntries).toBe(1);
    expect(counters?.hostUnreachableEntries).toBe(0);
  });

  test('a later successful drain clears a prior failure', async () => {
    const files = memFiles();
    files.set('/plans/x.md', '# plan');
    const store = memStore();
    const t = target();

    const throwing: PlanPostTransport = async () => { throw new Error('network down'); };
    const q1 = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: throwing, fileReader: files.reader, ...noThrottle });
    q1.noteCollect(t, planEvent('s', '/plans/x.md'));
    await q1.flushBeforeForward(t);
    expect(q1.health().get(HOST_A)?.failingEntries).toBe(1);

    const host = fakeHost();
    const q2 = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    await q2.flushBeforeForward(t);
    expect(q2.health().get(HOST_A)).toEqual({ pendingEntries: 0, failingEntries: 0, hostUnreachableEntries: 0 });
  });

  test('an inert (deleted-file) entry\'s stale failure never counts — no permanent false doctor warning (reviewer repro)', async () => {
    const files = memFiles();
    files.set('/plans/x.md', '# plan');
    const store = memStore();
    const t = target();

    // 1. One transport failure recorded against the plan entry.
    const throwing: PlanPostTransport = async () => { throw new Error('network down'); };
    const q1 = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: throwing, fileReader: files.reader, ...noThrottle });
    q1.noteCollect(t, planEvent('s', '/plans/x.md'));
    await q1.flushBeforeForward(t);
    expect(q1.health().get(HOST_A)?.hostUnreachableEntries).toBe(1);

    // 2. The plan file is deleted — its content is unreachable forever;
    //    drainEntry would remove the inert entry on the next LIVE cycle, but
    //    the doctor path never runs one.
    files.remove('/plans/x.md');

    // 3. A FRESH queue over the same store (doctor's disk-only construction):
    //    the stale failure must NOT read as failing/unreachable — otherwise
    //    every doctor run warns forever while the daemon is down.
    const q2 = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: throwing, fileReader: files.reader, ...noThrottle });
    expect(q2.health().get(HOST_A)).toEqual({ pendingEntries: 0, failingEntries: 0, hostUnreachableEntries: 0 });
  });

  test('a caught-up (unchanged-content) pass clears a stale failure on the STORED entry, with no transport attempt', async () => {
    const files = memFiles();
    files.set('/plans/x.md', '# plan');
    const store = memStore();
    const t = target();
    const hash = hashOf('# plan');

    // Seed an entry that is ALREADY caught up (acked_hash matches current
    // content) but still carries a stale failure from a past incident —
    // the state a genuinely-recovered entry is left in before this fix.
    store.put({
      host_id: HOST_A, session_id: 's', plan_ref: derivePlanRef('/plans/x.md'),
      project_id: 'proj_0123456789abcdef0123456789abcdef', grove_id: 'grove_0123456789abcdef0123456789abcdef',
      plan_path: '/plans/x.md', acked_hash: hash, updated_at: '2020-01-01T00:00:00.000Z',
      consecutive_failures: 3, last_error_kind: 'unreachable', last_error_at: '2020-01-01T00:00:00.000Z',
    });

    const host = fakeHost();
    const q = new PlanDrainQueue({ machineId: MACHINE, planWatchConfig: WATCH, store, transport: host.transport, fileReader: files.reader, ...noThrottle });
    await q.flushBeforeForward(t);

    // No POST happened — this was a genuine no-op, not a retry that happened to succeed.
    expect(host.calls).toHaveLength(0);
    const entry = store.get(HOST_A, 's', derivePlanRef('/plans/x.md'));
    expect(entry?.consecutive_failures).toBe(0);
    expect(entry?.last_error_kind).toBeNull();
  });
});
