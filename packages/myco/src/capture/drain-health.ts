/**
 * Shared failure-tracking + health-summary primitives for the three Team Host
 * member drains (`capture/transcript-drain.ts`, `capture/plan-drain.ts`,
 * `capture/event-replay-drain.ts`, consolidation Task C-5). All three are
 * warn-only today — a failed POST logs and retries next tick, but nothing
 * outside the log stream says WHY a host hasn't converged. Capture
 * observability is architectural here (project tenet): a drain's health must
 * be readable from persisted state, without tailing logs.
 *
 * KISS: no new database table. Each drain already persists one JSON entry per
 * work item (`DrainEntry` / `PlanDrainEntry` / `ReplayEntry`) in its own
 * machine-scoped queue dir — this module adds three small optional fields to
 * that SAME entry shape (`consecutive_failures`, `last_error_kind`,
 * `last_error_at`) and a pure aggregation helper that turns a flat list of
 * per-entry rows into a per-host {@link DrainHealthCounters} summary. Nothing
 * here touches disk itself; each drain queue supplies the rows from its own
 * store + file reader.
 *
 * Entries written before this change simply lack the three fields — reading
 * one back leaves them `undefined`, which every consumer here treats as "no
 * failure on record" (zero / null), so this is backward compatible with
 * already-persisted queue state.
 */

/** How a drain attempt failed, distinguishing "the host itself could not be
 *  reached" (transport-level: connection refused, timeout, DNS) from "the
 *  host answered but rejected the attempt" (an unexpected status/response
 *  shape). Both count as a failing entry; only the former counts toward
 *  host-unreachable occurrences — the doctor/status signal an operator most
 *  wants ("is the host down, or is something else wrong?"). */
export type DrainFailureKind = 'unreachable' | 'rejected';

/** The three fields every drain entry gains. Optional so a pre-existing
 *  persisted entry (no failure fields yet) round-trips as "healthy". */
export interface FailureTrackedEntry {
  consecutive_failures?: number;
  last_error_kind?: DrainFailureKind | null;
  last_error_at?: string | null;
}

/** Mutates `entry` in place to record a failed drain attempt. Call BEFORE
 *  `store.put(entry)` — this module never touches the store itself. */
export function recordDrainFailure<T extends FailureTrackedEntry>(
  entry: T,
  kind: DrainFailureKind,
  nowIso: string,
): T {
  entry.consecutive_failures = (entry.consecutive_failures ?? 0) + 1;
  entry.last_error_kind = kind;
  entry.last_error_at = nowIso;
  return entry;
}

/** Mutates `entry` in place to clear failure state after a successful drain
 *  attempt (a recovered entry reads as healthy again). */
export function clearDrainFailure<T extends FailureTrackedEntry>(entry: T): T {
  entry.consecutive_failures = 0;
  entry.last_error_kind = null;
  entry.last_error_at = null;
  return entry;
}

/** One drain's aggregated health for one host — the shape every drain
 *  queue's `health()` method reports per host_id, and what the daemon status
 *  API (`daemon/api/drain-health.ts`) and `myco doctor` both surface.
 *  `pendingUnits` is drain-specific: transcript-drain reports un-shipped
 *  BYTES, event-replay-drain reports un-shipped RECORDS, plan-drain reports
 *  un-shipped bytes of the current (whole-file) content when a push is
 *  outstanding — omitted only when there is nothing pending to size. */
export interface DrainHealthCounters {
  /** Entries/sessions with un-shipped content right now. */
  pendingEntries: number;
  /** Un-shipped bytes or records summed across pending entries — meaning is
   *  drain-specific (see the interface doc). */
  pendingUnits?: number;
  /** Entries currently in a failing state (`consecutive_failures > 0`),
   *  regardless of failure kind. */
  failingEntries: number;
  /** Of those, how many are failing because the HOST itself could not be
   *  reached (transport-level), rather than an unexpected-but-reachable
   *  response. */
  hostUnreachableEntries: number;
}

/** One entry's classification, as computed by the owning drain queue (which
 *  alone knows how to determine "pending" for its own entry shape — file
 *  stat + inode for transcript, content hash for plan, buffer record count
 *  for event-replay). Purely a data row; this module only aggregates. */
export interface DrainHealthRow {
  host_id: string;
  pending: boolean;
  pendingUnits?: number;
  consecutive_failures?: number;
  last_error_kind?: DrainFailureKind | null;
}

function emptyCounters(): DrainHealthCounters {
  return { pendingEntries: 0, failingEntries: 0, hostUnreachableEntries: 0 };
}

/** Aggregate a flat list of per-entry rows (already classified by the owning
 *  drain queue) into a per-host health map. Pure — no I/O. */
export function summarizeDrainHealth(rows: readonly DrainHealthRow[]): Map<string, DrainHealthCounters> {
  const out = new Map<string, DrainHealthCounters>();
  for (const row of rows) {
    let counters = out.get(row.host_id);
    if (!counters) {
      counters = emptyCounters();
      out.set(row.host_id, counters);
    }
    if (row.pending) {
      counters.pendingEntries += 1;
      if (row.pendingUnits !== undefined) {
        counters.pendingUnits = (counters.pendingUnits ?? 0) + row.pendingUnits;
      }
    }
    if ((row.consecutive_failures ?? 0) > 0) {
      counters.failingEntries += 1;
      if (row.last_error_kind === 'unreachable') counters.hostUnreachableEntries += 1;
    }
  }
  return out;
}
