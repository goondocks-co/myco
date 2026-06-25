/**
 * Unit tests for reconcilePartition — the orchestration that probes the worker,
 * diffs the local partition against the D1 manifest, runs the delete-safety
 * firewall, dedups against in-flight outbox rows, and seeds survivors into the
 * outbox under the reconcile↔flush mutex.
 *
 * All deps are injected mocks; this test touches NO real DB, network, or fs.
 * It is the contract test for the code path that actually SEEDS DELETES.
 */

import { describe, expect, it } from 'bun:test';
import {
  reconcilePartition,
  createReconcileFlushMutex,
  type ReconcilePartitionDeps,
  type ReconcileMutex,
} from '@myco/daemon/team-reconcile.js';
import type { ManifestItem, ManifestResponse } from '@myco/daemon/team-sync.js';
import type { OutboxInsert, OutboxRow, PartitionRow } from '@myco/db/queries/team-outbox.js';

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

interface ClientStub {
  getWorkerProtocolVersion(): number | undefined;
  health(): Promise<unknown>;
  supportsManifest(): boolean;
  getManifest(
    machineId: string,
    table: string,
    options: { projectId?: string; cursor?: string; limit?: number; summary?: boolean },
  ): Promise<ManifestResponse>;
}

interface Harness {
  deps: ReconcilePartitionDeps;
  enqueued: OutboxInsert[];
  healthCalls: number;
  summaryCalls: number;
  pageCalls: number;
  logs: string[];
}

/**
 * Build a reconcilePartition deps harness. `pages` is the ordered list of
 * paged-manifest responses (each may carry next_cursor); `summary` is the
 * cheap-count response. `local` is the local partition; `pending` is the set
 * of already-in-flight outbox row_ids.
 */
function makeHarness(opts: {
  protocolVersion?: number | undefined;
  local: PartitionRow[];
  pages: ManifestResponse[];
  summaryCount: number;
  pending?: Set<string>;
  membershipSeeded?: boolean;
  upsertPayload?: (table: string, id: string) => string | null;
  mutex?: ReconcileMutex;
}): Harness {
  let version = opts.protocolVersion;
  const enqueued: OutboxInsert[] = [];
  const logs: string[] = [];
  const harness: Harness = {
    deps: undefined as unknown as ReconcilePartitionDeps,
    enqueued,
    healthCalls: 0,
    summaryCalls: 0,
    pageCalls: 0,
    logs,
  };

  const client: ClientStub = {
    getWorkerProtocolVersion: () => version,
    health: async () => {
      harness.healthCalls += 1;
      // Probing learns the version (mirrors the real client populating it).
      if (version === undefined) version = opts.protocolVersion === undefined ? 3 : opts.protocolVersion;
      return {};
    },
    supportsManifest: () => version !== undefined && version >= 3,
    getManifest: async (_machineId, _table, options) => {
      if (options.summary) {
        harness.summaryCalls += 1;
        return {
          table: _table,
          machine_id: _machineId,
          count: opts.summaryCount,
        };
      }
      const idx = harness.pageCalls;
      harness.pageCalls += 1;
      const page = opts.pages[idx];
      if (!page) {
        return { table: _table, machine_id: _machineId, count: 0, items: [] };
      }
      return page;
    },
  };

  harness.deps = {
    client,
    localPartition: () => opts.local,
    pendingRowIdsForPartition: () => opts.pending ?? new Set<string>(),
    enqueueOutbox: (data: OutboxInsert) => {
      enqueued.push(data);
      // Return a minimal OutboxRow; reconcilePartition does not use the result.
      return {
        id: enqueued.length,
        table_name: data.table_name,
        row_id: data.row_id,
        operation: data.operation ?? 'upsert',
        payload: {},
        machine_id: data.machine_id,
        project_id: data.project_id ?? null,
        created_at: data.created_at,
        sent_at: null,
      } as OutboxRow;
    },
    buildUpsertPayload:
      opts.upsertPayload ?? ((_table, id) => JSON.stringify({ id, machine_id: 'm1' })),
    membershipSeeded: opts.membershipSeeded ?? true,
    mutex: opts.mutex ?? createReconcileFlushMutex(),
    logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
  };

  return harness;
}

function manifest(id: string, projectId?: string, hash?: string): ManifestItem {
  const item: ManifestItem = { id };
  if (projectId !== undefined) item.project_id = projectId;
  if (hash !== undefined) item.content_hash = hash;
  return item;
}

function page(items: ManifestItem[], count: number, nextCursor?: string): ManifestResponse {
  const r: ManifestResponse = { table: 'spores', machine_id: 'm1', count, items };
  if (nextCursor) r.next_cursor = nextCursor;
  return r;
}

const BASE = { machineId: 'm1', projectId: 'p1', table: 'spores', operatorConfirmed: false };

/**
 * A pool of `n` shared ids present in BOTH local and D1, used to give a
 * partition enough headroom that a single delete stays under the 20% fraction
 * cap (e.g. with n=20, deleting 1 of 21 D1 rows is ~4.8%). Returns the local
 * rows, the matching manifest items, and the shared count.
 */
function settled(n: number, projectId = 'p1'): {
  local: PartitionRow[];
  manifest: ManifestItem[];
  count: number;
} {
  const local: PartitionRow[] = [];
  const items: ManifestItem[] = [];
  for (let i = 0; i < n; i++) {
    local.push({ id: `s${i}` });
    items.push(manifest(`s${i}`, projectId));
  }
  return { local, manifest: items, count: n };
}

// ---------------------------------------------------------------------------
// Count-match fast path
// ---------------------------------------------------------------------------

describe('reconcilePartition — count-match fast path', () => {
  it('count equal → no paging, no enqueue', async () => {
    const h = makeHarness({
      protocolVersion: 3,
      local: [{ id: 'a' }, { id: 'b' }],
      pages: [],
      summaryCount: 2,
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    expect(h.summaryCalls).toBe(1);
    expect(h.pageCalls).toBe(0);
    expect(h.enqueued.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MF2: probe-before-feature-detect
// ---------------------------------------------------------------------------

describe('reconcilePartition — MF2 probe before feature detect', () => {
  it('unprobed client (version undefined) → calls health() then proceeds', async () => {
    const h = makeHarness({
      protocolVersion: undefined, // health() will populate it to 3
      local: [{ id: 'a' }],
      pages: [page([], 0)],
      summaryCount: 0,
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    expect(h.healthCalls).toBe(1);
    // version became 3 → supportsManifest → proceeds. Local has 1, D1 has 0:
    // count mismatch, so it pages and enqueues an upsert.
    expect(h.enqueued.length).toBe(1);
    expect(h.enqueued[0].operation ?? 'upsert').toBe('upsert');
  });

  it('confirmed v2 worker → skip + log, no paging, no enqueue', async () => {
    const h = makeHarness({
      protocolVersion: 2, // already probed, manifest unsupported
      local: [{ id: 'a' }],
      pages: [page([], 5)],
      summaryCount: 5,
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    expect(h.healthCalls).toBe(0); // already probed, no re-probe needed
    expect(h.summaryCalls).toBe(0);
    expect(h.pageCalls).toBe(0);
    expect(h.enqueued.length).toBe(0);
    expect(h.logs.some((l) => /manifest|protocol|skip/i.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delete seeding
// ---------------------------------------------------------------------------

describe('reconcilePartition — delete seeding', () => {
  it('D1 has an extra id (settled, small) → enqueues a delete', async () => {
    // 20 shared rows + 1 D1-only extra → 1/21 ≈ 4.8% delete, under the 20% cap.
    const s = settled(20);
    const h = makeHarness({
      protocolVersion: 3,
      local: s.local,
      pages: [page([...s.manifest, manifest('extra', 'p1')], s.count + 1)],
      summaryCount: s.count + 1, // D1 count 21 vs local 20 → mismatch
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    const deletes = h.enqueued.filter((e) => e.operation === 'delete');
    expect(deletes.length).toBe(1);
    expect(deletes[0].row_id).toBe('extra');
    expect(deletes[0].project_id).toBe('p1'); // FROM the manifest item
    const payload = JSON.parse(deletes[0].payload) as Record<string, unknown>;
    expect(payload).toEqual({ id: 'extra', machine_id: 'm1' });
  });

  it('delete count is accumulated into passAggregate', async () => {
    const s = settled(20);
    const h = makeHarness({
      protocolVersion: 3,
      local: s.local,
      pages: [page([...s.manifest, manifest('extra', 'p1')], s.count + 1)],
      summaryCount: s.count + 1,
    });
    const passAggregate = { count: 3 };
    await reconcilePartition(h.deps, { ...BASE, passAggregate });
    expect(passAggregate.count).toBe(4); // 3 + 1 applied delete
  });
});

// ---------------------------------------------------------------------------
// Upsert seeding
// ---------------------------------------------------------------------------

describe('reconcilePartition — upsert seeding', () => {
  it('local-missing id → enqueues an upsert with the built payload', async () => {
    const h = makeHarness({
      protocolVersion: 3,
      local: [{ id: 'a' }, { id: 'b' }],
      // D1 only has 'a' → 'b' is local-only → upsert. count 1 vs local 2.
      pages: [page([manifest('a', 'p1')], 1)],
      summaryCount: 1,
      upsertPayload: (table, id) => JSON.stringify({ id, machine_id: 'm1', table }),
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    const upserts = h.enqueued.filter((e) => (e.operation ?? 'upsert') === 'upsert');
    expect(upserts.length).toBe(1);
    expect(upserts[0].row_id).toBe('b');
    expect(upserts[0].project_id).toBe('p1'); // the partition being reconciled
    const payload = JSON.parse(upserts[0].payload) as Record<string, unknown>;
    expect(payload.id).toBe('b');
  });

  it('upsert whose payload build returns null (row vanished) is skipped', async () => {
    const h = makeHarness({
      protocolVersion: 3,
      local: [{ id: 'a' }, { id: 'gone' }],
      pages: [page([manifest('a', 'p1')], 1)],
      summaryCount: 1,
      upsertPayload: (_table, id) => (id === 'gone' ? null : JSON.stringify({ id })),
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    expect(h.enqueued.filter((e) => e.row_id === 'gone').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Resurrection guard / dedup
// ---------------------------------------------------------------------------

describe('reconcilePartition — resurrection guard', () => {
  it('id already pending in the outbox is skipped', async () => {
    const h = makeHarness({
      protocolVersion: 3,
      local: [{ id: 'a' }, { id: 'b' }],
      pages: [page([manifest('a', 'p1')], 1)],
      summaryCount: 1,
      pending: new Set(['b']), // 'b' already in flight
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    expect(h.enqueued.filter((e) => e.row_id === 'b').length).toBe(0);
  });

  it('id in BOTH upsert and delete sets is skipped from both', async () => {
    // The real diffPartition can never put one id in both sets, so the
    // contradiction guard is defense-in-depth. Exercise it deterministically by
    // injecting a diff that classifies 'dup' as BOTH a delete and an upsert.
    // 'dup' is present in the manifest under p1 (so it passes the N3 deletable
    // filter); the guard must then drop it from BOTH the upsert and delete sets.
    const s = settled(20);
    const h = makeHarness({
      protocolVersion: 3,
      local: [...s.local, { id: 'dup' }],
      pages: [page([...s.manifest, manifest('dup', 'p1')], s.count + 1)],
      summaryCount: s.count + 1, // mismatch → diff path
    });
    h.deps.diff = () => ({ upsertIds: ['dup'], deleteIds: ['dup'], staleIds: [] });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    // 'dup' is contradictory → skipped from both; nothing enqueued for it.
    expect(h.enqueued.filter((e) => e.row_id === 'dup').length).toBe(0);
  });

  it('stale id (in both, hash differs) re-pushes as a single upsert, never a delete', async () => {
    // A stale row does not change the partition count, so add a local-only id to
    // break count-equality and force the diff path. The stale id must then
    // produce exactly one upsert and no delete.
    const s = settled(20);
    const h = makeHarness({
      protocolVersion: 3,
      local: [...s.local, { id: 'dup', content_hash: 'h1' }, { id: 'localonly' }], // count 22
      pages: [page([...s.manifest, manifest('dup', 'p1', 'h2')], s.count + 1)],
      summaryCount: s.count + 1, // D1 count 21 ≠ local 22 → diff path
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    expect(h.enqueued.filter((e) => e.row_id === 'dup' && e.operation === 'delete').length).toBe(0);
    expect(h.enqueued.filter((e) => e.row_id === 'dup').length).toBe(1);
    // 'localonly' also upserts (local-only).
    expect(h.enqueued.filter((e) => e.row_id === 'localonly').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Delete safety firewall
// ---------------------------------------------------------------------------

describe('reconcilePartition — delete safety', () => {
  it('transient localCount=0 (d1Count>0) → NO delete, but does not throw', async () => {
    const h = makeHarness({
      protocolVersion: 3,
      local: [], // empty local → not_settled blocks deletes
      pages: [page([manifest('a', 'p1'), manifest('b', 'p1')], 2)],
      summaryCount: 2,
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    expect(h.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
    // No upserts either — local is empty.
    expect(h.enqueued.length).toBe(0);
    expect(h.logs.some((l) => /not_settled|blocked|safety/i.test(l))).toBe(true);
  });

  it('blocked deletes still allow upserts/stale re-pushes to proceed', async () => {
    // membershipSeeded=false blocks deletes; a local-only id still upserts.
    // Use a count mismatch (D1 has two extras, local has one extra) so the diff
    // path runs rather than the count-equal fast path.
    const s = settled(20);
    const h = makeHarness({
      protocolVersion: 3,
      local: [...s.local, { id: 'localonly' }], // count 21
      pages: [page([...s.manifest, manifest('d1extra1', 'p1'), manifest('d1extra2', 'p1')], s.count + 2)],
      summaryCount: s.count + 2, // D1 count 22 ≠ local 21
      membershipSeeded: false, // blocks deletes (membership_unseeded)
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    expect(h.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
    const upserts = h.enqueued.filter((e) => (e.operation ?? 'upsert') === 'upsert');
    expect(upserts.map((u) => u.row_id)).toEqual(['localonly']);
  });
});

// ---------------------------------------------------------------------------
// N3: per-home mismatch guard
// ---------------------------------------------------------------------------

describe('reconcilePartition — N3 per-home mismatch guard', () => {
  it('manifest item from a DIFFERENT project is NOT deleted', async () => {
    const h = makeHarness({
      protocolVersion: 3,
      local: [{ id: 'a' }],
      // 'other' belongs to project p2 (another home's grove) — must not delete.
      // count mismatch (D1 reports 2 for partition) to force the diff path.
      pages: [page([manifest('a', 'p1'), manifest('other', 'p2')], 2)],
      summaryCount: 2,
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    expect(h.enqueued.filter((e) => e.row_id === 'other').length).toBe(0);
    expect(h.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('reconcilePartition — pagination', () => {
  it('follows next_cursor until exhausted', async () => {
    const h = makeHarness({
      protocolVersion: 3,
      local: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      pages: [
        page([manifest('a', 'p1')], 3, 'cursor-2'),
        page([manifest('b', 'p1')], 3, 'cursor-3'),
        page([manifest('c', 'p1')], 3), // no next_cursor → stop
      ],
      summaryCount: 3, // count differs? equal to local (3) → fast path!
    });
    // Make count differ from local to force paging.
    h.deps.localPartition = () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    expect(h.pageCalls).toBe(3);
    // 'd' is local-only → one upsert.
    expect(h.enqueued.filter((e) => e.row_id === 'd').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// forceFullDiff: equal-count, different-set gap closure
// ---------------------------------------------------------------------------

describe('reconcilePartition — forceFullDiff gap closure', () => {
  // 5 shared rows so a 1-delete doesn't hit the 20% fraction cap (1/6 ≈ 16.7%).
  const baseShared = settled(5); // {s0..s4}

  it('forceFullDiff:false + equal counts → count-match fast path, no diff, no enqueue', async () => {
    const h = makeHarness({
      protocolVersion: 3,
      local: [...baseShared.local, { id: 'B' }],           // 6 local
      pages: [page([...baseShared.manifest, manifest('A', 'p1')], 6)], // 6 D1
      summaryCount: 6,  // D1 count == local count → fast-path skip
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 }, forceFullDiff: false });
    // Count-equality fast path: summary fetched, no paging, no enqueue.
    expect(h.summaryCalls).toBe(1);
    expect(h.pageCalls).toBe(0);
    expect(h.enqueued.length).toBe(0);
  });

  it('forceFullDiff:true + equal counts → full diff runs, seeds delete for D1-orphan and upsert for local-only', async () => {
    const h = makeHarness({
      protocolVersion: 3,
      local: [...baseShared.local, { id: 'B' }],           // 6 local: s0-s4 + B
      pages: [page([...baseShared.manifest, manifest('A', 'p1')], 6)], // 6 D1: s0-s4 + A
      summaryCount: 6,  // same count — would skip without forceFullDiff
    });
    await reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 }, forceFullDiff: true });
    // Summary skipped; paging ran.
    expect(h.summaryCalls).toBe(0);
    expect(h.pageCalls).toBe(1);
    // A is D1-orphan → delete; B is local-only → upsert.
    const deletes = h.enqueued.filter((e) => e.operation === 'delete');
    const upserts = h.enqueued.filter((e) => (e.operation ?? 'upsert') === 'upsert');
    expect(deletes.length).toBe(1);
    expect(deletes[0].row_id).toBe('A');
    expect(upserts.length).toBe(1);
    expect(upserts[0].row_id).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// MF3 mutex serialization
// ---------------------------------------------------------------------------

describe('reconcilePartition — MF3 mutex', () => {
  it('reconcile-seed and a concurrent flush-drain serialize via the shared mutex', async () => {
    const mutex = createReconcileFlushMutex();
    const order: string[] = [];

    // Instrument the seed to record entry/exit ordering. We slow the reconcile's
    // critical section by making enqueueOutbox await a microtask-deferred marker.
    const h = makeHarness({
      protocolVersion: 3,
      local: [{ id: 'a' }, { id: 'b' }],
      pages: [page([manifest('a', 'p1')], 1)],
      summaryCount: 1,
      mutex,
    });
    const realEnqueue = h.deps.enqueueOutbox;
    h.deps.enqueueOutbox = (data) => {
      order.push('seed:enqueue');
      return realEnqueue(data);
    };

    // A competing "flush-drain" that grabs the SAME mutex.
    const flush = async () => {
      await mutex.runExclusive(async () => {
        order.push('flush:start');
        await Promise.resolve();
        order.push('flush:end');
      });
    };

    // Start the reconcile, then immediately start the flush. Because the seed
    // section holds the mutex, the flush must run entirely before or entirely
    // after the seed — never interleaved with seed:enqueue.
    const recon = reconcilePartition(h.deps, { ...BASE, passAggregate: { count: 0 } });
    const fl = flush();
    await Promise.all([recon, fl]);

    // Assert no interleave: flush:start..flush:end must be contiguous, and the
    // seed:enqueue events must not appear between them.
    const flushStart = order.indexOf('flush:start');
    const flushEnd = order.indexOf('flush:end');
    expect(flushStart).toBeGreaterThanOrEqual(0);
    expect(flushEnd).toBe(flushStart + 1); // contiguous, nothing between
  });

  it('createReconcileFlushMutex returns a shareable lock with runExclusive', () => {
    const m = createReconcileFlushMutex();
    expect(typeof m.runExclusive).toBe('function');
  });
});
