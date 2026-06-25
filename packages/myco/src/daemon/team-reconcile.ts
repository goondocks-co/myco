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
 * This module contains NO I/O, NO DB access, NO network calls. All inputs are
 * plain in-memory objects, making it trivially unit-testable.
 */

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
