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

/**
 * A local row as returned by `localPartition`.
 *
 * `id` is `string | number` because integer-id tables (prompt_batches,
 * knowledge_release_state) surface ids as JS numbers from bun:sqlite. The
 * comparison in `diffPartition` coerces both sides to strings before matching.
 */
export interface LocalRow {
  id: string | number;
  content_hash?: string;
}

/**
 * One item from the worker's GET /manifest response.
 *
 * `id` is `string | number` because D1 returns INTEGER id columns as JS
 * numbers; `diffPartition` normalizes to strings so a number id can never
 * mis-compare against a stringified local id.
 */
export interface ManifestItemLike {
  id: string | number;
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
  // Key both maps — and every returned id — by String(id). D1 returns INTEGER
  // id columns as JS numbers while the local side (localPartition) stringifies
  // ids; without this coercion an integer-id table would compare '101' against
  // 101, miss on every row, and classify EVERY id as a spurious delete/upsert.
  // For text-id tables String(uuid) === uuid, so this is a no-op there.
  const localMap = new Map<string, string | undefined>();
  for (const row of local) {
    localMap.set(String(row.id), row.content_hash);
  }

  const manifestMap = new Map<string, string | null | undefined>();
  for (const item of manifestItems) {
    manifestMap.set(String(item.id), item.content_hash);
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
// Delete-safety gate (settledness)
// ---------------------------------------------------------------------------

/** Inputs to the delete-safety gate. */
export interface DeleteSafetyInput {
  /** Number of rows in the local (authoritative) partition. */
  localCount: number;
  /** Number of rows the D1 manifest reports for this partition. */
  d1Count: number;
  /**
   * Whether the team membership registry has been seeded (i.e. the caller
   * confirmed that `memberProjectIdsForGrove(grove)` returned a non-empty set).
   * When false the local id-set may not yet reflect actual membership, so no
   * deletes may proceed.
   */
  membershipSeeded: boolean;
}

/** Result of the delete-safety gate. */
export interface DeleteSafetyResult {
  allow: boolean;
  /** Machine-readable reason when allow===false. */
  reason?: string;
}

/**
 * Evaluate whether deletes for a partition are safe to proceed.
 *
 * The reconcile path is a FULLY AUTOMATIC backstop: its actor is any member
 * daemon that just syncs (possibly headless), so this gate is machine-decidable
 * with zero human judgment. Magnitude is NOT gated here — delete blast radius is
 * bounded instead by cross-pass drift stability in `reconcilePartition` (an
 * orphan must be observed across two consecutive passes before it is deleted, so
 * a transient/partial-load orphan never reaches a delete). What remains are the
 * two settledness guards, which block unconditionally because no amount of drift
 * confirmation can make a not-yet-loaded local dataset trustworthy:
 *
 *   1. localCount===0 && d1Count>0 → not_settled
 *      The local set has simply not loaded yet; treating an empty local as
 *      authoritative would wipe the whole partition.
 *   2. !membershipSeeded → membership_unseeded
 *      Without a populated membership registry the daemon cannot tell a
 *      genuinely-absent row from one temporarily invisible behind an unseeded
 *      registry.
 *
 * Otherwise → allow.
 */
export function evaluateDeleteSafety(input: DeleteSafetyInput): DeleteSafetyResult {
  const { localCount, d1Count, membershipSeeded } = input;

  // Guard 1: transient-empty trap. A reconcile may never wipe a whole partition
  // — an empty local set has simply not loaded yet and cannot be trusted as
  // authoritative.
  if (localCount === 0 && d1Count > 0) {
    return { allow: false, reason: 'not_settled' };
  }

  // Guard 2: membership not yet seeded. Without a populated membership registry
  // the daemon cannot determine which rows are genuinely absent locally vs.
  // temporarily invisible due to an unseeded registry.
  if (!membershipSeeded) {
    return { allow: false, reason: 'membership_unseeded' };
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

export interface ReconcilePartitionArgs {
  machineId: string;
  teamId: string;
  projectId: string;
  table: string;
  /**
   * When true, skip the count-equality fast path and always run the full ID diff.
   * Used by the 6h periodic backstop and the on-demand reconcile to catch
   * equal-count / different-set drift (e.g. one local delete + one local add
   * that nets the same count). The frequent poll path keeps forceFullDiff false
   * so per-partition summary fetches stay cheap.
   */
  forceFullDiff?: boolean;
}

/** Page size for paged manifest fetches. */
const MANIFEST_PAGE_LIMIT = 500;

/**
 * Cross-pass drift tracking. Maps a partition key (machineId, projectId, table)
 * to the set of orphan-candidate ids — D1 rows absent locally — observed on the
 * PREVIOUS full-diff pass. An orphan is deleted only when it appears in TWO
 * consecutive passes: the first pass records it here, the second pass intersects
 * the current candidates with this set and seeds the survivors. A transient or
 * partial-load orphan that has vanished by the next pass is never deleted;
 * genuine drift persists and heals on the second pass. This is process memory,
 * not I/O, so the module stays import-pure. State is best-effort: a daemon
 * restart simply costs one extra pass before the first delete.
 */
const priorDeleteCandidates = new Map<string, Set<string>>();

/**
 * Stable partition key for the cross-pass drift map. NUL-separated to match
 * the sibling `rejectionKey` convention and eliminate any collision risk from
 * ids that contain spaces.
 */
function partitionKey(machineId: string, projectId: string, table: string): string {
  return `${machineId} ${projectId} ${table}`;
}

/**
 * Clear all in-memory cross-pass drift tracking. Test seam only — production
 * never resets this; the map lives for the daemon process's lifetime.
 */
export function resetReconcileDriftTracking(): void {
  priorDeleteCandidates.clear();
}

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
 *   6. Settledness firewall + cross-pass drift stability: evaluateDeleteSafety
 *      blocks deletes for an unsettled partition; otherwise only orphans also
 *      seen on the PREVIOUS pass are deleted now (current candidates are
 *      recorded for the next pass). Upserts/stale re-pushes always proceed.
 *   7. Resurrection guard / dedup: skip ids already pending in the outbox; skip
 *      any id that lands in BOTH the upsert/stale set and the delete set.
 *   8. Seed under the mutex (MF3): enqueue survivors via enqueueOutbox.
 */
export async function reconcilePartition(
  deps: ReconcilePartitionDeps,
  args: ReconcilePartitionArgs,
): Promise<void> {
  const { client, logger } = deps;
  const { machineId, projectId, table, forceFullDiff = false } = args;
  const key = partitionKey(machineId, projectId, table);

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

  // 3. Local partition. When forceFullDiff is false (the frequent poll path),
  // a cheap summary fetch gates paging: equal counts → no-op. When
  // forceFullDiff is true (the 6h backstop and on-demand trigger paths), skip
  // the count check so equal-count / different-set drift is always caught.
  const local = deps.localPartition(machineId, projectId, table);
  const localCount = local.length;

  let d1Count = 0;
  if (!forceFullDiff) {
    const summary = await client.getManifest(machineId, table, { projectId, summary: true });
    d1Count = summary.count;
    if (d1Count === localCount) {
      // No drift this pass — drop any candidate carried from a prior pass so a
      // since-resolved orphan can never linger as a stale second-pass match.
      //
      // NOTE: clearing here on a count-equal (not just zero-diff) pass can reset
      // the cross-pass accumulator even for an equal-count / different-set partition
      // (one local add + one local delete that nets the same count). That only DELAYS
      // healing by one pass, not permanently blocks it: the accompanying upsert for the
      // new local row lands in this same pass, D1 counts diverge on the next summary
      // fetch, and the full diff then deletes the orphan as a first-sighting candidate.
      priorDeleteCandidates.delete(key);
      return;
    }
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

  if (forceFullDiff) {
    // No summary was fetched; derive d1Count from the full paged result
    // (total paged items = D1 partition count) so the safety gate is accurate.
    d1Count = manifestItems.length;
  }

  const diff = (deps.diff ?? diffPartition)(local, manifestItems);

  // 5. Per-home mismatch guard (N3). machine_id is machine-GLOBAL, so a delete
  // must never target another home's partition. Only consider manifest items
  // whose project_id === projectId as deletable (defense-in-depth on top of the
  // already-strict project-scoped fetch).
  // Key by String(id) to match diff.deleteIds (which diffPartition stringifies)
  // — an integer-id table's manifest items arrive as numbers from D1.
  const deletableProjectById = new Map<string, string>();
  for (const item of manifestItems) {
    if (item.project_id === projectId) deletableProjectById.set(String(item.id), item.project_id);
  }
  const deleteCandidates = diff.deleteIds.filter((id) => deletableProjectById.has(id));

  // 6. Settledness firewall + cross-pass drift stability. Settledness gates
  // FIRST: an unsettled partition seeds zero deletes regardless of candidates,
  // and — being an untrustworthy observation — breaks the consecutive-pass chain
  // (drop any carried candidates). When settled, only orphans also seen on the
  // PREVIOUS pass are deleted now; the current candidate set is recorded for the
  // next pass so a transient/partial-load orphan (gone by then) is never deleted
  // while genuine drift heals on its second consecutive sighting.
  const safety = evaluateDeleteSafety({
    localCount,
    d1Count,
    membershipSeeded: deps.membershipSeeded,
  });
  let allowedDeletes: string[];
  if (!safety.allow) {
    logger.warn(
      `reconcile[${table}/${projectId}]: ${deleteCandidates.length} delete(s) blocked (${
        safety.reason ?? 'unknown'
      }); applying upserts only`,
    );
    allowedDeletes = [];
    priorDeleteCandidates.delete(key);
  } else {
    const prior = priorDeleteCandidates.get(key);
    allowedDeletes = prior ? deleteCandidates.filter((id) => prior.has(id)) : [];
    if (deleteCandidates.length === 0) priorDeleteCandidates.delete(key);
    else priorDeleteCandidates.set(key, new Set(deleteCandidates));
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
        team_id: args.teamId,
        project_id: projectId,
        created_at: now,
      });
    }

    for (const id of deleteIds) {
      // project_id MUST come from the manifest item — there is no local row to
      // source it from, and the worker's grove-project_id gate 409-rejects
      // deletes lacking project_id. Payload matches the delete-trigger shape:
      // json_object('id', id, 'machine_id', machine_id). `id` is a string here
      // (diffPartition stringifies all ids); a string id in the delete payload
      // still matches an INTEGER D1 row because the worker's `DELETE ... WHERE
      // id = ?` applies the id column's INTEGER affinity to the bound value, so
      // '12345' converts to 12345 and matches.
      const manifestProjectId = deletableProjectById.get(id)!;
      deps.enqueueOutbox({
        table_name: table,
        row_id: id,
        operation: 'delete',
        payload: JSON.stringify({ id, machine_id: machineId }),
        machine_id: machineId,
        team_id: args.teamId,
        project_id: manifestProjectId,
        created_at: now,
      });
    }
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
