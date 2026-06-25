/**
 * Pure fingerprint + diff logic for symmetric team-sync reconcile.
 *
 * Compares a local partition (rows from the SQLite vault) against the D1
 * manifest (rows the worker knows about) and classifies each id into one of
 * three buckets:
 *
 *   upsertIds — present locally but absent in D1 → daemon must (re-)push.
 *   deleteIds — present in D1 but absent locally → daemon must delete from D1.
 *   staleIds  — present in both but content_hash differs (content-hash tables
 *               only) → daemon must re-push to refresh the D1 copy.
 *
 * The pure diff/safety functions contain NO I/O. `reconcilePartition` is the
 * orchestrator: it DOES perform I/O (manifest fetch, local reads, outbox
 * writes) but only through an INJECTED `deps` object, so the MODULE itself
 * stays import-pure (no DB/network/fs imports — only type-only imports, which
 * are erased at compile time). The real wiring lives in the team-sync init
 * path; this module is unit-testable end-to-end with mock deps.
 */

import type { ManifestItem, ManifestResponse } from '@myco/daemon/team-sync.js';
import type { OutboxInsert, OutboxRow, PartitionRow } from '@myco/db/queries/team-outbox.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A local row as returned by `localPartition`. */
export interface LocalRow {
  id: string;
  content_hash?: string;
}

/** One item from the worker's GET /manifest response. */
export interface ManifestItemLike {
  id: string;
  content_hash?: string | null;
}

/** Result of diffPartition. */
export interface PartitionDiff {
  /** Ids present locally but missing from D1. */
  upsertIds: string[];
  /** Ids present in D1 but absent locally (D1 has extra rows; delete them). */
  deleteIds: string[];
  /**
   * Ids present in both but whose content_hash differs.
   * Only populated for content-hash-bearing tables; always empty for others.
   */
  staleIds: string[];
}

// ---------------------------------------------------------------------------
// diffPartition
// ---------------------------------------------------------------------------

/**
 * Diff a local partition against the D1 manifest for the same partition.
 *
 * Semantics:
 *   - id in local ONLY           → upsertIds (D1 is missing it)
 *   - id in manifest ONLY        → deleteIds (D1 has an extra row)
 *   - id in both, hashes match   → no action
 *   - id in both, hashes differ, AND both items carry content_hash
 *                                → staleIds (re-upsert needed)
 *   - id in both, no content_hash on either item (presence-only table)
 *                                → no action (stale detection is not possible)
 *
 * `staleIds` is always empty for tables that do not carry content_hash because
 * there is no hash to compare — presence alone confirms the row is in sync.
 */
export function diffPartition(
  local: ReadonlyArray<LocalRow>,
  manifestItems: ReadonlyArray<ManifestItemLike>,
): PartitionDiff {
  const localMap = new Map<string, string | undefined>();
  for (const row of local) {
    localMap.set(row.id, row.content_hash);
  }

  const manifestMap = new Map<string, string | null | undefined>();
  for (const item of manifestItems) {
    manifestMap.set(item.id, item.content_hash);
  }

  const upsertIds: string[] = [];
  const deleteIds: string[] = [];
  const staleIds: string[] = [];

  // Classify each local id.
  for (const [id, localHash] of localMap) {
    if (!manifestMap.has(id)) {
      // Local only → D1 is missing it.
      upsertIds.push(id);
    } else {
      // Present in both. Check for content_hash drift only when both sides
      // carry a hash (content-hash tables). If either side lacks a hash, the
      // table is presence-only and no stale detection is possible.
      const manifestHash = manifestMap.get(id);
      if (
        localHash !== undefined && localHash !== null &&
        manifestHash !== undefined && manifestHash !== null &&
        localHash !== manifestHash
      ) {
        staleIds.push(id);
      }
    }
  }

  // Classify each manifest id not seen locally.
  for (const id of manifestMap.keys()) {
    if (!localMap.has(id)) {
      deleteIds.push(id);
    }
  }

  return { upsertIds, deleteIds, staleIds };
}

// ---------------------------------------------------------------------------
// Delete-safety gate
// ---------------------------------------------------------------------------

/**
 * Maximum per-partition deletes the AUTOMATIC reconcile path may apply in one
 * pass. Chosen as 50: large enough to heal genuine bulk-drift (e.g. a restore
 * that wiped a few dozen rows) without approaching the scale of a full-
 * partition wipe on any realistic team dataset. `== floor` is allowed;
 * `> floor` requires operator confirmation.
 */
export const MIN_ABSOLUTE_DELETE_FLOOR = 50;

/**
 * Maximum fraction of the D1 partition the AUTOMATIC path may delete in one
 * pass. 0.2 (20%) bounds blast radius relative to partition size while still
 * allowing meaningful drift healing. Values above 0.2 would let a 300-row
 * partition lose 60+ rows automatically — closer to a wipe than drift repair.
 */
export const MAX_DELETE_FRACTION = 0.2;

/**
 * Per-pass cap across ALL partitions. Set to 4× the per-partition floor so
 * N partitions each under the floor cannot SUM to an unbounded wipe across
 * the full reconcile pass. 200 allows roughly 4 fully-drifted partitions to
 * heal in one pass while still bounding the worst-case aggregate.
 */
export const MAX_PASS_AGGREGATE_DELETES = 200;

/** Inputs to the delete-safety gate. */
export interface DeleteSafetyInput {
  /** Number of rows in the local (authoritative) partition. */
  localCount: number;
  /** Number of rows the D1 manifest reports for this partition. */
  d1Count: number;
  /** How many D1 rows the current partition diff wants to delete. */
  partitionDeleteCount: number;
  /** Running total of delete ops already approved across all partitions in this pass. */
  passAggregateDeleteCount: number;
  /**
   * Whether the team membership registry has been seeded (i.e. the caller
   * confirmed that `memberProjectIdsForGrove(grove)` returned a non-empty set).
   * When false the local id-set may not yet reflect actual membership, so no
   * deletes may proceed.
   */
  membershipSeeded: boolean;
  /**
   * When true the operator has explicitly confirmed this reconcile, which
   * bypasses the magnitude caps (floor, fraction, aggregate). Settledness
   * guards (localCount==0 and membershipSeeded) are NEVER overridable —
   * an operator confirming does not make not-yet-loaded data trustworthy.
   */
  operatorConfirmed: boolean;
}

/** Result of the delete-safety gate. */
export interface DeleteSafetyResult {
  allow: boolean;
  /** Machine-readable reason when allow===false. */
  reason?: string;
}

/**
 * Evaluate whether a set of delete ops is safe to proceed.
 *
 * Guards are evaluated in strict order. The first two are settledness guards
 * that block unconditionally — even operator confirmation cannot override them,
 * because no human decision can make a not-yet-loaded local dataset trustworthy.
 *
 * Guard order:
 *   1. localCount===0 && d1Count>0   → not_settled         (unconditional)
 *   2. !membershipSeeded             → membership_unseeded  (unconditional)
 *   3. operatorConfirmed             → allow (magnitude caps bypassed)
 *   4. partitionDeleteCount > floor  → requires_operator
 *   5. fraction > MAX_DELETE_FRACTION (when d1Count>0) → exceeds_fraction
 *   6. passAggregateDeleteCount > aggregate cap → exceeds_aggregate
 *   7. otherwise                     → allow
 */
export function evaluateDeleteSafety(input: DeleteSafetyInput): DeleteSafetyResult {
  const {
    localCount,
    d1Count,
    partitionDeleteCount,
    passAggregateDeleteCount,
    membershipSeeded,
    operatorConfirmed,
  } = input;

  // Guard 1: transient-empty trap. A reconcile may never wipe a whole
  // partition, regardless of operator intent — the local set has simply not
  // loaded yet and cannot be trusted as authoritative.
  if (localCount === 0 && d1Count > 0) {
    return { allow: false, reason: 'not_settled' };
  }

  // Guard 2: membership not yet seeded. Without a populated membership
  // registry the daemon cannot determine which rows are genuinely absent
  // locally vs. temporarily invisible due to an unseeded registry.
  if (!membershipSeeded) {
    return { allow: false, reason: 'membership_unseeded' };
  }

  // Guard 3: operator confirmed — settledness already passed above; bypass
  // all magnitude caps.
  if (operatorConfirmed) {
    return { allow: true };
  }

  // Guard 4: per-partition absolute floor. Deleting more than this many rows
  // from a single partition in one automatic pass requires a human decision.
  if (partitionDeleteCount > MIN_ABSOLUTE_DELETE_FLOOR) {
    return { allow: false, reason: 'requires_operator' };
  }

  // Guard 5: fraction cap. Even if the count is under the floor, a high
  // fraction signals the local set diverged from D1 by an unusual proportion.
  // Skip when d1Count===0 — there are no D1 rows to bound.
  if (d1Count > 0 && (partitionDeleteCount / d1Count) > MAX_DELETE_FRACTION) {
    return { allow: false, reason: 'exceeds_fraction' };
  }

  // Guard 6: per-pass aggregate cap. Prevents N partitions each under the
  // per-partition floor from summing to an unbounded total wipe.
  if (passAggregateDeleteCount > MAX_PASS_AGGREGATE_DELETES) {
    return { allow: false, reason: 'exceeds_aggregate' };
  }

  return { allow: true };
}

// ---------------------------------------------------------------------------
// Reconcile ↔ flush mutex (MF3)
// ---------------------------------------------------------------------------

/**
 * In-process async mutex shared by the reconcile-seed path (reconcilePartition)
 * and the flush-drain path (the team-sync flush job). The two lanes must NEVER
 * interleave: a reconcile that is part-way through seeding deletes into the
 * outbox must not have the flush drain a half-seeded batch, and the flush must
 * not mark rows sent while reconcile is mid-decision.
 *
 * `runExclusive` queues callers FIFO; each runs to completion (including async
 * awaits inside it) before the next acquires the lock. A SINGLE instance must
 * guard both lanes — create one via `createReconcileFlushMutex()` and hand the
 * same object to reconcilePartition (via deps) and to the flush job.
 */
export interface ReconcileMutex {
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T>;
}

/**
 * Create a fresh reconcile↔flush mutex. The returned object is the share-able
 * lock instance: pass the SAME object to both the reconcile-seed deps and the
 * flush-drain job so they serialize against each other.
 */
export function createReconcileFlushMutex(): ReconcileMutex {
  // Tail of the promise chain. Each acquirer awaits the previous tail before
  // running, then becomes the new tail. Errors are isolated so one caller's
  // rejection does not poison the chain for the next caller.
  let tail: Promise<unknown> = Promise.resolve();

  return {
    runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
      const run = tail.then(() => fn());
      // Advance the tail to a settled (never-rejecting) continuation so a
      // failure in `fn` does not break serialization for subsequent callers.
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

// ---------------------------------------------------------------------------
// reconcilePartition — orchestration (probe → check → diff → safety → dedup → seed)
// ---------------------------------------------------------------------------

/** Minimal logger surface used for skip/blocked diagnostics. */
export interface ReconcileLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** The worker-client surface reconcilePartition depends on (a subset of TeamSyncClient). */
export interface ReconcileClient {
  getWorkerProtocolVersion(): number | undefined;
  health(): Promise<unknown>;
  supportsManifest(): boolean;
  getManifest(
    machineId: string,
    table: string,
    options: { projectId?: string; cursor?: string; limit?: number; summary?: boolean },
  ): Promise<ManifestResponse>;
}

/**
 * Injected I/O surface for reconcilePartition. Keeping the module import-pure
 * means every DB/network seam arrives through this object. The real wiring
 * binds these to TeamSyncClient + the team-outbox query helpers.
 */
export interface ReconcilePartitionDeps {
  client: ReconcileClient;
  /** Local rows for the (machineId, projectId, table) partition. */
  localPartition(machineId: string, projectId: string, table: string): PartitionRow[];
  /** Row ids already pending (sent_at IS NULL) in the outbox for this partition. */
  pendingRowIdsForPartition(table: string, machineId: string, projectId: string): Set<string>;
  /** The ONLY outbox write seam — matches the existing push pipeline. */
  enqueueOutbox(data: OutboxInsert): OutboxRow;
  /**
   * Build the upsert payload (full sanitized row JSON) for a local row id,
   * matching the existing push pipeline's upsert payload shape. Returns null
   * when the row has vanished between diff and seed (skip that upsert).
   */
  buildUpsertPayload(table: string, id: string): string | null;
  /**
   * Whether the team membership registry is seeded for this grove (the caller
   * derives this from memberProjectIdsForGrove(grove) being non-empty). Threaded
   * into the delete-safety gate.
   */
  membershipSeeded: boolean;
  /** The shared reconcile↔flush mutex (MF3). */
  mutex: ReconcileMutex;
  logger: ReconcileLogger;
  /**
   * Diff function. Defaults to the pure `diffPartition` in this module; exposed
   * as a seam only so tests can deterministically exercise the contradiction
   * guard (an id classified into BOTH the upsert/stale set AND the delete set,
   * which the real diff never produces but which the seed path defends against).
   */
  diff?: typeof diffPartition;
}

/**
 * A shared, mutable per-pass delete accumulator. reconcilePartition adds this
 * partition's APPLIED delete count to it and passes the running cumulative to
 * evaluateDeleteSafety, so N partitions' deletes can't sum to a wipe.
 */
export interface PassAggregate {
  count: number;
}

export interface ReconcilePartitionArgs {
  machineId: string;
  projectId: string;
  table: string;
  operatorConfirmed: boolean;
  passAggregate: PassAggregate;
}

/** Page size for paged manifest fetches. */
const MANIFEST_PAGE_LIMIT = 500;

/**
 * Reconcile one (machineId, projectId, table) partition against D1 and seed the
 * resulting upserts/deletes into the outbox.
 *
 * Flow (strict (machine_id, project_id) scope throughout):
 *   1. Probe-before-feature-detect (MF2): probe via health() if the worker
 *      protocol version is unknown — never silently skip an unprobed client.
 *   2. Version gate: skip+log if the worker does not support /manifest (v2).
 *   3. Cheap count check: if D1 count === local count, no-op (no paging/seed).
 *   4. Full diff: page the manifest, diff against the local partition.
 *   5. Per-home mismatch guard (N3): only delete manifest items whose
 *      project_id === projectId (machine_id is machine-global, shared by both
 *      daemon homes — a delete must never target another home's partition).
 *   6. Delete safety firewall: evaluateDeleteSafety; on block, skip ONLY the
 *      deletes (upserts/stale re-pushes are always safe and still proceed).
 *   7. Resurrection guard / dedup: skip ids already pending in the outbox; skip
 *      any id that lands in BOTH the upsert/stale set and the delete set.
 *   8. Seed under the mutex (MF3): enqueue survivors via enqueueOutbox.
 */
export async function reconcilePartition(
  deps: ReconcilePartitionDeps,
  args: ReconcilePartitionArgs,
): Promise<void> {
  const { client, logger } = deps;
  const { machineId, projectId, table, operatorConfirmed, passAggregate } = args;

  // 1. Probe-before-feature-detect (MF2). An unprobed client reports undefined;
  // learn the version via health() rather than silently skipping.
  if (client.getWorkerProtocolVersion() === undefined) {
    try {
      await client.health();
    } catch (err) {
      logger.warn(
        `reconcile[${table}/${projectId}]: skipped — worker health probe failed: ${String(err)}`,
      );
      return;
    }
  }

  // 2. Version gate. A confirmed v2 worker has no /manifest endpoint; skip
  // gracefully (other sync is unaffected). Not an error.
  if (!client.supportsManifest()) {
    logger.info(
      `reconcile[${table}/${projectId}]: skipped — worker does not support manifest (protocol ${
        client.getWorkerProtocolVersion() ?? 'unknown'
      })`,
    );
    return;
  }

  // 3. Cheap count check (fast path). Compare D1 count to local count; equal →
  // no-op. (cheap_agg is MAX(rowid) on the D1 side and is NOT comparable to any
  // local rowid sequence — the skip condition is COUNT equality only.)
  const local = deps.localPartition(machineId, projectId, table);
  const localCount = local.length;
  const summary = await client.getManifest(machineId, table, { projectId, summary: true });
  const d1Count = summary.count;
  if (d1Count === localCount) {
    return;
  }

  // 4. Full diff. Page the manifest (strict project scope) until exhausted.
  const manifestItems: ManifestItem[] = [];
  let cursor: string | undefined;
  do {
    const resp = await client.getManifest(machineId, table, {
      projectId,
      cursor,
      limit: MANIFEST_PAGE_LIMIT,
    });
    if (resp.items) manifestItems.push(...resp.items);
    cursor = resp.next_cursor;
  } while (cursor);

  const diff = (deps.diff ?? diffPartition)(local, manifestItems);

  // 5. Per-home mismatch guard (N3). machine_id is machine-GLOBAL, so a delete
  // must never target another home's partition. Only consider manifest items
  // whose project_id === projectId as deletable (defense-in-depth on top of the
  // already-strict project-scoped fetch).
  const deletableProjectById = new Map<string, string>();
  for (const item of manifestItems) {
    if (item.project_id === projectId) deletableProjectById.set(item.id, item.project_id);
  }
  const deleteCandidates = diff.deleteIds.filter((id) => deletableProjectById.has(id));

  // 6. Delete safety firewall. The running cumulative INCLUDES this partition's
  // candidates so an aggregate wipe across partitions is bounded.
  const partitionDeleteCount = deleteCandidates.length;
  const safety = evaluateDeleteSafety({
    localCount,
    d1Count,
    partitionDeleteCount,
    passAggregateDeleteCount: passAggregate.count + partitionDeleteCount,
    membershipSeeded: deps.membershipSeeded,
    operatorConfirmed,
  });
  let allowedDeletes = deleteCandidates;
  if (!safety.allow) {
    logger.warn(
      `reconcile[${table}/${projectId}]: ${partitionDeleteCount} delete(s) blocked (${
        safety.reason ?? 'unknown'
      }); applying upserts only`,
    );
    allowedDeletes = [];
  }

  // 7. Resurrection guard / dedup. Build the upsert/stale id set, the delete id
  // set, then: (a) drop any id present in BOTH (a contradictory op would
  // resurrect or thrash the row), (b) drop any id already pending in the outbox.
  const upsertSet = new Set<string>([...diff.upsertIds, ...diff.staleIds]);
  const deleteSet = new Set<string>(allowedDeletes);
  for (const id of upsertSet) {
    if (deleteSet.has(id)) {
      upsertSet.delete(id);
      deleteSet.delete(id);
    }
  }
  const pending = deps.pendingRowIdsForPartition(table, machineId, projectId);

  const upsertIds = [...upsertSet].filter((id) => !pending.has(id));
  const deleteIds = [...deleteSet].filter((id) => !pending.has(id));

  if (upsertIds.length === 0 && deleteIds.length === 0) return;

  // 8. Seed under the mutex (MF3). The reconcile-seed and the flush-drain share
  // this lock instance and must not interleave.
  await deps.mutex.runExclusive(() => {
    const now = nowSeconds();

    for (const id of upsertIds) {
      const payload = deps.buildUpsertPayload(table, id);
      if (payload === null) continue; // row vanished between diff and seed
      deps.enqueueOutbox({
        table_name: table,
        row_id: id,
        operation: 'upsert',
        payload,
        machine_id: machineId,
        project_id: projectId,
        created_at: now,
      });
    }

    let appliedDeletes = 0;
    for (const id of deleteIds) {
      // project_id MUST come from the manifest item — there is no local row to
      // source it from, and the worker's grove-project_id gate 409-rejects
      // deletes lacking project_id. Payload matches the delete-trigger shape:
      // json_object('id', id, 'machine_id', machine_id).
      const manifestProjectId = deletableProjectById.get(id)!;
      deps.enqueueOutbox({
        table_name: table,
        row_id: id,
        operation: 'delete',
        payload: JSON.stringify({ id, machine_id: machineId }),
        machine_id: machineId,
        project_id: manifestProjectId,
        created_at: now,
      });
      appliedDeletes += 1;
    }

    // Accumulate APPLIED deletes into the shared per-pass aggregate.
    passAggregate.count += appliedDeletes;
  });
}

/**
 * Current wall-clock time in whole seconds. Kept local (not imported from
 * @myco/constants) so the module has zero runtime imports and stays trivially
 * unit-testable without pulling the constants graph.
 */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
