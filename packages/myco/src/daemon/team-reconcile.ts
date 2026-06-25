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
