/**
 * Activity-bucket helpers for the session/run rail cards.
 *
 * Each list row in the v6 design shows a mini activity distribution.
 * The wire payload is a fixed-length array of integers — one count per
 * bucket across the session/run lifetime, oldest bucket first.
 *
 * The naive shape is one subquery per session × 8 buckets. For lists of
 * 50–200 rows that's 400–1600 round-trips per page load. We instead issue a
 * single ranged SELECT covering every visible id, then bucket in JS. The DB
 * touches each row once; the bucketing is O(rows) and runs at near-memory
 * speed.
 */

import { getDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of lifetime buckets returned per row. Matches the rail chart width. */
export const BUCKET_COUNT = 8;

/** Wire shape: integers, oldest bucket first. */
export type ActivityBuckets = number[];

interface ActivityRange {
  id: string;
  started_at: number | null;
  ended_at: number | null;
}

interface ObservedActivityRange {
  started_at: number;
  ended_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyBuckets(): ActivityBuckets {
  return new Array(BUCKET_COUNT).fill(0) as number[];
}

function observeActivityRows(
  rows: Array<{ id: string; started_at: number }>,
): Map<string, ObservedActivityRange> {
  const observed = new Map<string, ObservedActivityRange>();
  for (const row of rows) {
    const current = observed.get(row.id);
    if (!current) {
      observed.set(row.id, { started_at: row.started_at, ended_at: row.started_at });
      continue;
    }
    current.started_at = Math.min(current.started_at, row.started_at);
    current.ended_at = Math.max(current.ended_at, row.started_at);
  }
  return observed;
}

function resolveActivityRange(
  explicit: ActivityRange | undefined,
  observed: ObservedActivityRange | undefined,
  nowSeconds: number,
): { started_at: number; ended_at: number } | null {
  if (!explicit && !observed) return null;

  const explicitStart = explicit?.started_at ?? null;
  const observedStart = observed?.started_at ?? null;
  const startCandidates = [explicitStart, observedStart].filter((value): value is number => value !== null);
  if (startCandidates.length === 0) return null;

  const start = Math.min(...startCandidates);
  const explicitEnd = explicit?.started_at !== null && explicit?.started_at !== undefined
    ? (explicit.ended_at ?? nowSeconds)
    : null;
  const endCandidates = [explicitEnd, observed?.ended_at ?? null].filter((value): value is number => value !== null);
  const end = Math.max(start + 1, ...endCandidates);

  return { started_at: start, ended_at: end };
}

/**
 * Build the buckets map from a flat (id, started_at) result set.
 *
 * Buckets are anchored to each item's lifetime. Stored session/run ranges are
 * treated as hints and widened from observed activity rows so resumed or
 * defensively re-registered rows do not hide older captured activity.
 */
function bucketByIdFromRows(
  rows: Array<{ id: string; started_at: number }>,
  ids: readonly string[],
  ranges: readonly ActivityRange[],
  nowSeconds: number,
): Map<string, ActivityBuckets> {
  const map = new Map<string, ActivityBuckets>();
  for (const id of ids) map.set(id, emptyBuckets());

  const rangeById = new Map<string, ActivityRange>();
  for (const range of ranges) rangeById.set(range.id, range);
  const observedById = observeActivityRows(rows);

  for (const row of rows) {
    const buckets = map.get(row.id);
    if (!buckets) continue;
    const range = resolveActivityRange(
      rangeById.get(row.id),
      observedById.get(row.id),
      nowSeconds,
    );
    if (!range) continue;

    const start = range.started_at;
    const end = range.ended_at;
    if (row.started_at < start || row.started_at > end) continue;

    const span = Math.max(1, end - start);
    const offset = Math.max(0, Math.min(span, row.started_at - start));
    const idx = Math.min(BUCKET_COUNT - 1, Math.floor((offset / span) * BUCKET_COUNT));
    buckets[idx] += 1;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API — sessions
// ---------------------------------------------------------------------------

/**
 * Compute per-session activity buckets for a list of session ids.
 *
 * "Activity" for a session is a captured prompt_batch. Returns a map keyed
 * by session id; every input id appears in the map (with all-zero buckets
 * when the session has no captured prompt batches).
 *
 * An empty input list short-circuits without hitting the database.
 */
export function getSessionActivityBuckets(
  sessionIds: readonly string[],
  options: { ranges?: readonly ActivityRange[]; nowSeconds?: number } = {},
): Map<string, ActivityBuckets> {
  const now = options.nowSeconds ?? epochSeconds();
  if (sessionIds.length === 0) return new Map();

  const db = getDatabase();
  const placeholders = sessionIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT session_id AS id, started_at
         FROM prompt_batches
        WHERE session_id IN (${placeholders})
          AND started_at IS NOT NULL`,
    )
    .all(...sessionIds) as Array<{ id: string; started_at: number }>;

  return bucketByIdFromRows(rows, sessionIds, options.ranges ?? [], now);
}

// ---------------------------------------------------------------------------
// Public API — runs
// ---------------------------------------------------------------------------

/**
 * Compute per-run activity buckets for a list of run ids.
 *
 * "Activity" for an agent run is a recorded `agent_turns` row — each turn
 * represents one tool call the agent made, which is the closest analog to
 * the prompt-batch granularity used for sessions.
 *
 * Same contract as `getSessionActivityBuckets`: every input id appears in
 * the returned map.
 */
export function getRunActivityBuckets(
  runIds: readonly string[],
  options: { ranges?: readonly ActivityRange[]; nowSeconds?: number } = {},
): Map<string, ActivityBuckets> {
  const now = options.nowSeconds ?? epochSeconds();
  if (runIds.length === 0) return new Map();

  const db = getDatabase();
  const placeholders = runIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT run_id AS id, started_at
         FROM agent_turns
        WHERE run_id IN (${placeholders})
          AND started_at IS NOT NULL`,
    )
    .all(...runIds) as Array<{ id: string; started_at: number }>;

  return bucketByIdFromRows(rows, runIds, options.ranges ?? [], now);
}

// ---------------------------------------------------------------------------
// Public API — run branch lookup
// ---------------------------------------------------------------------------

/**
 * Resolve the most recent captured git branch for each run.
 *
 * Runs themselves don't store branch — release-provenance captures it per
 * session/prompt_batch. We follow each run's `session_ref` to its session
 * and read the most-recent provenance row's `branch`. A run without a
 * session_ref, or a session with no captured provenance, maps to `null`.
 *
 * The query joins `agent_runs → sessions → knowledge_git_provenance` so we
 * pick up the right row even when the session_ref string and a sessions.id
 * shape differ (the join enforces the FK relationship).
 */
export function getRunBranches(runIds: readonly string[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const id of runIds) result.set(id, null);
  if (runIds.length === 0) return result;

  const db = getDatabase();
  const placeholders = runIds.map(() => '?').join(', ');
  // Use a window function to pick the latest provenance row per session in
  // a single pass — the previous correlated subquery re-ran MAX(captured_at)
  // for every matched session row, turning into N+1 round trips on large
  // result sets.
  const rows = db
    .prepare(
      `SELECT r.id AS run_id, latest.branch AS branch
         FROM agent_runs r
         JOIN sessions s ON s.id = r.session_ref
         JOIN (
           SELECT session_id, branch,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY captured_at DESC) AS rn
             FROM knowledge_git_provenance
         ) latest ON latest.session_id = s.id AND latest.rn = 1
        WHERE r.id IN (${placeholders})`,
    )
    .all(...runIds) as Array<{ run_id: string; branch: string | null }>;

  for (const row of rows) {
    result.set(row.run_id, row.branch ?? null);
  }
  return result;
}
