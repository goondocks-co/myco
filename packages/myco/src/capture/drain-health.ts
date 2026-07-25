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
 *  shape). `unreadable` is neither remote case: the local source the entry
 *  points at could not be read, so the drain cannot tell whether the work is
 *  still owed. All three count as a failing entry; only `unreachable` counts
 *  toward host-unreachable occurrences — the doctor/status signal an operator
 *  most wants ("is the host down, or is something else wrong?"). */
export type DrainFailureKind = 'unreachable' | 'rejected' | 'unreadable';

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
  /** PENDING entries currently in a failing state (`consecutive_failures >
   *  0`), regardless of failure kind. Always <= `pendingEntries`: a failure
   *  only counts while the entry still has un-shipped content the failure is
   *  blocking. An INERT entry (rotated transcript, deleted plan file) with a
   *  stale prior failure never counts — its bytes are unreachable, no retry
   *  will ever run for it, and the next live drain cycle removes it
   *  (`drainEntry`'s inert-check); counting it would leave a permanent false
   *  "failing" signal on the disk-only doctor path, where no drain cycle
   *  ever runs to self-heal it. */
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
 *  drain queue) into a per-host health map. Pure — no I/O.
 *
 *  Failure counts are gated on `row.pending` — the aggregation-level twin of
 *  the inert-check each `drainEntry` applies (rotated inode, deleted plan
 *  file). An entry can only be "failing" while it has un-shipped content the
 *  failure is actually blocking: an inert entry's recorded failure is stale
 *  by definition (its bytes are unreachable, no retry will ever fire, and
 *  the next live drain cycle removes the entry), and on the disk-only
 *  doctor path — fresh queue instances, no drain cycle ever running — an
 *  ungated count would report that stale failure as a warning FOREVER.
 *  Gating here (rather than having each `health()` skip inert rows) keeps
 *  the invariant in one place for all three drains and keeps `pending` and
 *  `failing` semantics coupled by construction: `failingEntries` is always
 *  a subset of `pendingEntries`. */
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
      if ((row.consecutive_failures ?? 0) > 0) {
        counters.failingEntries += 1;
        if (row.last_error_kind === 'unreachable') counters.hostUnreachableEntries += 1;
      }
    }
  }
  return out;
}
