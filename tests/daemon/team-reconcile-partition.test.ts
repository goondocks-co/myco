/**
 * Unit tests for reconcilePartition — the orchestration that probes the worker,
 * diffs the local partition against the D1 manifest, runs the settledness
 * firewall + cross-pass drift stability gate, dedups against in-flight outbox
 * rows, and seeds survivors into the outbox under the reconcile↔flush mutex.
 *
 * All deps are injected mocks; this test touches NO real DB, network, or fs.
 * It is the contract test for the code path that actually SEEDS DELETES.
 *
 * Cross-pass model: a D1-only orphan is deleted only after it is observed on TWO
 * consecutive full-diff passes. The first sighting is recorded in the module's
 * in-memory drift map; the second sighting intersects with it and seeds the
 * delete. `resetReconcileDriftTracking()` clears that map between tests.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  reconcilePartition,
  resetReconcileDriftTracking,
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

interface HarnessOpts {
  protocolVersion?: number | undefined;
  local: PartitionRow[];
  pages: ManifestResponse[];
  summaryCount: number;
  pending?: Set<string>;
  membershipSeeded?: boolean;
  upsertPayload?: (table: string, id: string) => string | null;
  mutex?: ReconcileMutex;
}

/**
 * Build a reconcilePartition deps harness. `pages` is the ordered list of
 * paged-manifest responses (each may carry next_cursor); `summary` is the
 * cheap-count response. `local` is the local partition; `pending` is the set
 * of already-in-flight outbox row_ids.
 */
function makeHarness(opts: HarnessOpts): Harness {
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
        team_id: data.team_id ?? null,
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

const BASE = { machineId: 'm1', teamId: 'team-a', projectId: 'p1', table: 'spores' };

/**
 * A pool of `n` shared ids present in BOTH local and D1, used to give a
 * partition a non-empty (settled) local set. Returns the local rows, the
 * matching manifest items, and the shared count.
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

/**
 * Run `passes` consecutive reconcile passes against the SAME partition (a fresh
 * harness each pass so enqueued/page counters reset, but the module-level drift
 * map carries across). Returns the LAST harness so callers assert on the pass
 * whose outcome they care about.
 */
async function runPasses(
  opts: HarnessOpts,
  passes: number,
  argOverrides: { table?: string; forceFullDiff?: boolean } = {},
): Promise<Harness> {
  let last!: Harness;
  for (let i = 0; i < passes; i++) {
    last = makeHarness(opts);
    await reconcilePartition(last.deps, { ...BASE, ...argOverrides });
  }
  return last;
}

beforeEach(() => {
  // The cross-pass drift map is module state; clear it so each test starts with
  // no carried orphan candidates (and one test's candidates never leak forward).
  resetReconcileDriftTracking();
});

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
    await reconcilePartition(h.deps, { ...BASE });
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
    await reconcilePartition(h.deps, { ...BASE });
    expect(h.healthCalls).toBe(1);
    // version became 3 → supportsManifest → proceeds. Local has 1, D1 has 0:
    // count mismatch, so it pages and enqueues an upsert.
    expect(h.enqueued.length).toBe(1);
    expect(h.enqueued[0].operation ?? 'upsert').toBe('upsert');
    expect(h.enqueued[0].team_id).toBe('team-a');
  });

  it('confirmed v2 worker → skip + log, no paging, no enqueue', async () => {
    const h = makeHarness({
      protocolVersion: 2, // already probed, manifest unsupported
      local: [{ id: 'a' }],
      pages: [page([], 5)],
      summaryCount: 5,
    });
    await reconcilePartition(h.deps, { ...BASE });
    expect(h.healthCalls).toBe(0); // already probed, no re-probe needed
    expect(h.summaryCalls).toBe(0);
    expect(h.pageCalls).toBe(0);
    expect(h.enqueued.length).toBe(0);
    expect(h.logs.some((l) => /manifest|protocol|skip/i.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-pass drift stability (the delete-seeding contract)
// ---------------------------------------------------------------------------

describe('reconcilePartition — cross-pass drift stability', () => {
  /** A settled partition with one D1-only orphan ('extra'). */
  function orphanOpts(): HarnessOpts {
    const s = settled(2);
    return {
      protocolVersion: 3,
      local: s.local,
      pages: [page([...s.manifest, manifest('extra', 'p1')], s.count + 1)],
      summaryCount: s.count + 1, // D1 count 3 vs local 2 → mismatch → diff path
    };
  }

  it('an orphan observed in ONE pass is recorded but NOT deleted', async () => {
    const h = await runPasses(orphanOpts(), 1);
    expect(h.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
  });

  it('the SAME orphan observed in TWO consecutive passes is deleted on the second', async () => {
    const h = await runPasses(orphanOpts(), 2);
    const deletes = h.enqueued.filter((e) => e.operation === 'delete');
    expect(deletes.length).toBe(1);
    expect(deletes[0].row_id).toBe('extra');
    expect(deletes[0].project_id).toBe('p1'); // FROM the manifest item
    expect(deletes[0].team_id).toBe('team-a');
    const payload = JSON.parse(deletes[0].payload) as Record<string, unknown>;
    expect(payload).toEqual({ id: 'extra', machine_id: 'm1' });
  });

  it('an orphan that is resolved by the next pass is never deleted', async () => {
    const s = settled(2);
    // Pass 1: 'extra' is a D1 orphan → recorded as a candidate.
    const h1 = makeHarness(orphanOpts());
    await reconcilePartition(h1.deps, { ...BASE });
    expect(h1.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
    // Pass 2: drift resolved (D1 no longer has 'extra'; count now matches local).
    const h2 = makeHarness({
      protocolVersion: 3,
      local: s.local,
      pages: [page([...s.manifest], s.count)],
      summaryCount: s.count, // count match → fast path clears the candidate
    });
    await reconcilePartition(h2.deps, { ...BASE });
    expect(h2.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
  });

  it('a DIFFERENT orphan each pass is never deleted (no consecutive sighting)', async () => {
    const s = settled(2);
    // Pass 1: orphan 'X'.
    const h1 = makeHarness({
      protocolVersion: 3,
      local: s.local,
      pages: [page([...s.manifest, manifest('X', 'p1')], s.count + 1)],
      summaryCount: s.count + 1,
    });
    await reconcilePartition(h1.deps, { ...BASE });
    // Pass 2: a different orphan 'Y' (full diff runs; 'X' is gone from D1).
    const h2 = makeHarness({
      protocolVersion: 3,
      local: s.local,
      pages: [page([...s.manifest, manifest('Y', 'p1')], s.count + 1)],
      summaryCount: s.count + 1,
    });
    await reconcilePartition(h2.deps, { ...BASE });
    // Neither orphan was seen twice in a row → nothing deleted.
    expect(h1.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
    expect(h2.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
  });

  it('a large settled persistent drift heals fully across two passes (no magnitude cap)', async () => {
    const ORPHANS = 5000;
    const local: PartitionRow[] = [{ id: 'keep' }];
    const items: ManifestItem[] = [manifest('keep', 'p1')];
    for (let i = 0; i < ORPHANS; i++) items.push(manifest(`orphan${i}`, 'p1'));
    const opts: HarnessOpts = {
      protocolVersion: 3,
      local, // localCount 1 > 0 → settled
      pages: [page(items, ORPHANS + 1)],
      summaryCount: ORPHANS + 1, // D1 5001 vs local 1 → diff path
    };

    // Pass 1: records 5000 candidates, deletes nothing (not blocked, just first
    // sighting). Pass 2: every orphan was seen on both passes → all 5000 delete.
    const h1 = await runPasses(opts, 1);
    expect(h1.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);

    const h2 = await runPasses(opts, 2);
    const deletes = h2.enqueued.filter((e) => e.operation === 'delete');
    expect(deletes.length).toBe(ORPHANS);
    // No safety block was logged — a large settled drift is NOT magnitude-gated.
    expect(h2.logs.some((l) => /blocked/i.test(l))).toBe(false);
  });

  it('settledness gates BEFORE cross-pass: a recorded orphan in a not_settled pass seeds zero deletes', async () => {
    const s = settled(2);
    // Pass 1 (settled): 'extra' recorded as a candidate.
    const h1 = makeHarness({
      protocolVersion: 3,
      local: s.local,
      pages: [page([...s.manifest, manifest('extra', 'p1')], s.count + 1)],
      summaryCount: s.count + 1,
    });
    await reconcilePartition(h1.deps, { ...BASE });
    // Pass 2 (not settled): local has not loaded (empty) while D1 still reports
    // rows — including the recorded 'extra'. Settledness must block regardless of
    // the carried candidate.
    const h2 = makeHarness({
      protocolVersion: 3,
      local: [], // localCount 0, d1Count > 0 → not_settled
      pages: [page([...s.manifest, manifest('extra', 'p1')], s.count + 1)],
      summaryCount: s.count + 1,
    });
    await reconcilePartition(h2.deps, { ...BASE });
    expect(h2.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
    expect(h2.logs.some((l) => /not_settled|blocked/i.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Upsert seeding (independent of cross-pass; always proceeds)
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
    await reconcilePartition(h.deps, { ...BASE });
    const upserts = h.enqueued.filter((e) => (e.operation ?? 'upsert') === 'upsert');
    expect(upserts.length).toBe(1);
    expect(upserts[0].row_id).toBe('b');
    expect(upserts[0].project_id).toBe('p1'); // the partition being reconciled
    expect(upserts[0].team_id).toBe('team-a');
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
    await reconcilePartition(h.deps, { ...BASE });
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
    await reconcilePartition(h.deps, { ...BASE });
    expect(h.enqueued.filter((e) => e.row_id === 'b').length).toBe(0);
  });

  it('id in BOTH upsert and delete sets is skipped from both (on the delete-active pass)', async () => {
    // The real diffPartition can never put one id in both sets, so the
    // contradiction guard is defense-in-depth. Exercise it deterministically by
    // injecting a diff that classifies 'dup' as BOTH a delete and an upsert.
    // 'dup' is present in the manifest under p1 (so it passes the N3 deletable
    // filter). The delete only becomes active on the SECOND consecutive pass
    // (cross-pass), so run two passes; the guard must then drop 'dup' from BOTH.
    const s = settled(2);
    const opts: HarnessOpts = {
      protocolVersion: 3,
      local: [...s.local, { id: 'dup' }],
      pages: [page([...s.manifest, manifest('dup', 'p1')], s.count + 1)],
      summaryCount: s.count + 1, // mismatch → diff path
    };
    const inject = () => ({ upsertIds: ['dup'], deleteIds: ['dup'], staleIds: [] });

    const h1 = makeHarness(opts);
    h1.deps.diff = inject;
    await reconcilePartition(h1.deps, { ...BASE });

    const h2 = makeHarness(opts);
    h2.deps.diff = inject;
    await reconcilePartition(h2.deps, { ...BASE });

    // On pass 2 'dup' is a confirmed delete AND an upsert → contradiction →
    // dropped from both; nothing enqueued for it.
    expect(h2.enqueued.filter((e) => e.row_id === 'dup').length).toBe(0);
  });

  it('stale id (in both, hash differs) re-pushes as a single upsert, never a delete', async () => {
    // A stale row does not change the partition count, so add a local-only id to
    // break count-equality and force the diff path. The stale id must then
    // produce exactly one upsert and no delete.
    const s = settled(2);
    const h = makeHarness({
      protocolVersion: 3,
      local: [...s.local, { id: 'dup', content_hash: 'h1' }, { id: 'localonly' }], // count 4
      pages: [page([...s.manifest, manifest('dup', 'p1', 'h2')], s.count + 1)],
      summaryCount: s.count + 1, // D1 count 3 ≠ local 4 → diff path
    });
    await reconcilePartition(h.deps, { ...BASE });
    expect(h.enqueued.filter((e) => e.row_id === 'dup' && e.operation === 'delete').length).toBe(0);
    expect(h.enqueued.filter((e) => e.row_id === 'dup').length).toBe(1);
    // 'localonly' also upserts (local-only).
    expect(h.enqueued.filter((e) => e.row_id === 'localonly').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Delete safety firewall (settledness)
// ---------------------------------------------------------------------------

describe('reconcilePartition — delete safety', () => {
  it('transient localCount=0 (d1Count>0) → NO delete, but does not throw', async () => {
    // Even across two passes, a not_settled partition seeds no deletes.
    const opts: HarnessOpts = {
      protocolVersion: 3,
      local: [], // empty local → not_settled blocks deletes
      pages: [page([manifest('a', 'p1'), manifest('b', 'p1')], 2)],
      summaryCount: 2,
    };
    const h = await runPasses(opts, 2);
    expect(h.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
    // No upserts either — local is empty.
    expect(h.enqueued.length).toBe(0);
    expect(h.logs.some((l) => /not_settled|blocked|safety/i.test(l))).toBe(true);
  });

  it('blocked deletes still allow upserts/stale re-pushes to proceed', async () => {
    // membershipSeeded=false blocks deletes; a local-only id still upserts.
    // Use a count mismatch (D1 has two extras, local has one extra) so the diff
    // path runs rather than the count-equal fast path. Two passes prove the block
    // holds even once an orphan would otherwise be cross-pass confirmed.
    const s = settled(2);
    const opts: HarnessOpts = {
      protocolVersion: 3,
      local: [...s.local, { id: 'localonly' }], // count 3
      pages: [page([...s.manifest, manifest('d1extra1', 'p1'), manifest('d1extra2', 'p1')], s.count + 2)],
      summaryCount: s.count + 2, // D1 count 4 ≠ local 3
      membershipSeeded: false, // blocks deletes (membership_unseeded)
    };
    const h = await runPasses(opts, 2);
    expect(h.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
    const upserts = h.enqueued.filter((e) => (e.operation ?? 'upsert') === 'upsert');
    expect(upserts.map((u) => u.row_id)).toEqual(['localonly']);
  });
});

// ---------------------------------------------------------------------------
// N3: per-home mismatch guard
// ---------------------------------------------------------------------------

describe('reconcilePartition — N3 per-home mismatch guard', () => {
  it('manifest item from a DIFFERENT project is NOT deleted (even across passes)', async () => {
    const opts: HarnessOpts = {
      protocolVersion: 3,
      local: [{ id: 'a' }],
      // 'other' belongs to project p2 (another home's grove) — must not delete.
      // count mismatch (D1 reports 2 for partition) to force the diff path.
      pages: [page([manifest('a', 'p1'), manifest('other', 'p2')], 2)],
      summaryCount: 2,
    };
    const h = await runPasses(opts, 2);
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
      local: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      pages: [
        page([manifest('a', 'p1')], 3, 'cursor-2'),
        page([manifest('b', 'p1')], 3, 'cursor-3'),
        page([manifest('c', 'p1')], 3), // no next_cursor → stop
      ],
      summaryCount: 3, // D1 count 3 ≠ local 4 → diff path forces paging
    });
    await reconcilePartition(h.deps, { ...BASE });
    expect(h.pageCalls).toBe(3);
    // 'd' is local-only → one upsert.
    expect(h.enqueued.filter((e) => e.row_id === 'd').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// forceFullDiff: equal-count, different-set gap closure
// ---------------------------------------------------------------------------

describe('reconcilePartition — forceFullDiff gap closure', () => {
  const baseShared = settled(5); // {s0..s4}

  it('forceFullDiff:false + equal counts → count-match fast path, no diff, no enqueue', async () => {
    const h = makeHarness({
      protocolVersion: 3,
      local: [...baseShared.local, { id: 'B' }],           // 6 local
      pages: [page([...baseShared.manifest, manifest('A', 'p1')], 6)], // 6 D1
      summaryCount: 6,  // D1 count == local count → fast-path skip
    });
    await reconcilePartition(h.deps, { ...BASE, forceFullDiff: false });
    // Count-equality fast path: summary fetched, no paging, no enqueue.
    expect(h.summaryCalls).toBe(1);
    expect(h.pageCalls).toBe(0);
    expect(h.enqueued.length).toBe(0);
  });

  it('forceFullDiff:true + equal counts → full diff runs, upserts local-only immediately; D1-orphan deletes on the 2nd pass', async () => {
    const opts: HarnessOpts = {
      protocolVersion: 3,
      local: [...baseShared.local, { id: 'B' }],           // 6 local: s0-s4 + B
      pages: [page([...baseShared.manifest, manifest('A', 'p1')], 6)], // 6 D1: s0-s4 + A
      summaryCount: 6,  // same count — would skip without forceFullDiff
    };

    // Pass 1: summary skipped, paging ran; B (local-only) upserts now, A
    // (D1-orphan) is only recorded (first sighting), not yet deleted.
    const h1 = makeHarness(opts);
    await reconcilePartition(h1.deps, { ...BASE, forceFullDiff: true });
    expect(h1.summaryCalls).toBe(0);
    expect(h1.pageCalls).toBe(1);
    expect(h1.enqueued.filter((e) => e.operation === 'delete').length).toBe(0);
    expect(h1.enqueued.filter((e) => (e.operation ?? 'upsert') === 'upsert' && e.row_id === 'B').length).toBe(1);

    // Pass 2: A seen again → delete; B still upserts.
    const h2 = makeHarness(opts);
    await reconcilePartition(h2.deps, { ...BASE, forceFullDiff: true });
    const deletes = h2.enqueued.filter((e) => e.operation === 'delete');
    const upserts = h2.enqueued.filter((e) => (e.operation ?? 'upsert') === 'upsert');
    expect(deletes.length).toBe(1);
    expect(deletes[0].row_id).toBe('A');
    expect(upserts.length).toBe(1);
    expect(upserts[0].row_id).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// INTEGER-id partition: end-to-end type normalization
// ---------------------------------------------------------------------------

describe('reconcilePartition — INTEGER id partition (type normalization)', () => {
  it('number/string id mismatch does not cause spurious mass delete/upsert', async () => {
    // localPartition stringifies ids; the raw D1 manifest hands back numbers.
    // The 20 shared rows must be recognized as in-sync (no upsert, no delete);
    // only the genuine integer D1-orphan (999) is deleted, with a STRING row_id —
    // and only after it is observed on two consecutive passes.
    const local: PartitionRow[] = [];
    const items: ManifestItem[] = [];
    for (let i = 1; i <= 20; i++) {
      local.push({ id: String(100 + i) });                                       // '101'..'120'
      items.push({ id: 100 + i, project_id: 'p1' } as unknown as ManifestItem);  // numbers
    }
    items.push({ id: 999, project_id: 'p1' } as unknown as ManifestItem);        // D1 orphan

    const opts: HarnessOpts = {
      protocolVersion: 3,
      local,
      pages: [page(items, 21)],
      summaryCount: 21, // D1 21 vs local 20 → diff path
    };
    const h = await runPasses(opts, 2, { table: 'prompt_batches' });

    const deletes = h.enqueued.filter((e) => e.operation === 'delete');
    const upserts = h.enqueued.filter((e) => (e.operation ?? 'upsert') === 'upsert');

    expect(upserts.length).toBe(0); // no spurious all-upsert from a type mismatch
    expect(deletes.length).toBe(1); // only the genuine orphan
    expect(deletes[0].row_id).toBe('999');
    expect(typeof deletes[0].row_id).toBe('string');
    const payload = JSON.parse(deletes[0].payload) as Record<string, unknown>;
    expect(payload).toEqual({ id: '999', machine_id: 'm1' });
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
    const recon = reconcilePartition(h.deps, { ...BASE });
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
