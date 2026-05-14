/**
 * Activity-bucket helpers for the session/run rail cards.
 *
 * Each list row in the v6 design shows a mini sparkline of recent activity.
 * The wire payload is a fixed-length array of integers — one count per
 * 1-minute bucket over the last `BUCKET_COUNT` minutes, newest bucket last.
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

/** Number of 1-minute buckets returned per row. Matches the v6 sparkline width. */
export const BUCKET_COUNT = 8;

/** Width of each bucket, in seconds. */
const BUCKET_WIDTH_SECONDS = 60;

/** Total window width, in seconds (BUCKET_COUNT × BUCKET_WIDTH). */
const WINDOW_SECONDS = BUCKET_COUNT * BUCKET_WIDTH_SECONDS;

/** Wire shape: integers, newest bucket last (index BUCKET_COUNT-1 is the most recent minute). */
export type ActivityBuckets = number[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyBuckets(): ActivityBuckets {
  return new Array(BUCKET_COUNT).fill(0) as number[];
}

/**
 * Build the buckets map from a flat (id, started_at) result set.
 *
 * Buckets are anchored at `nowSeconds`: index 0 covers
 * `[now - WINDOW_SECONDS, now - WINDOW_SECONDS + 60)` and the last index
 * covers `[now - 60, now)`. A row outside the window is silently dropped.
 */
function bucketByIdFromRows(
  rows: Array<{ id: string; started_at: number }>,
  ids: readonly string[],
  nowSeconds: number,
): Map<string, ActivityBuckets> {
  const map = new Map<string, ActivityBuckets>();
  for (const id of ids) map.set(id, emptyBuckets());

  const windowStart = nowSeconds - WINDOW_SECONDS;
  for (const row of rows) {
    const buckets = map.get(row.id);
    if (!buckets) continue;
    const offset = row.started_at - windowStart;
    if (offset < 0 || offset >= WINDOW_SECONDS) continue;
    const idx = Math.floor(offset / BUCKET_WIDTH_SECONDS);
    if (idx < 0 || idx >= BUCKET_COUNT) continue;
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
 * when the session has no recent activity).
 *
 * An empty input list short-circuits without hitting the database.
 */
export function getSessionActivityBuckets(
  sessionIds: readonly string[],
  options: { nowSeconds?: number } = {},
): Map<string, ActivityBuckets> {
  const now = options.nowSeconds ?? epochSeconds();
  if (sessionIds.length === 0) return new Map();

  const db = getDatabase();
  const placeholders = sessionIds.map(() => '?').join(', ');
  const windowStart = now - WINDOW_SECONDS;
  const rows = db
    .prepare(
      `SELECT session_id AS id, started_at
         FROM prompt_batches
        WHERE session_id IN (${placeholders})
          AND started_at IS NOT NULL
          AND started_at >= ?
          AND started_at < ?`,
    )
    .all(...sessionIds, windowStart, now) as Array<{ id: string; started_at: number }>;

  return bucketByIdFromRows(rows, sessionIds, now);
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
  options: { nowSeconds?: number } = {},
): Map<string, ActivityBuckets> {
  const now = options.nowSeconds ?? epochSeconds();
  if (runIds.length === 0) return new Map();

  const db = getDatabase();
  const placeholders = runIds.map(() => '?').join(', ');
  const windowStart = now - WINDOW_SECONDS;
  const rows = db
    .prepare(
      `SELECT run_id AS id, started_at
         FROM agent_turns
        WHERE run_id IN (${placeholders})
          AND started_at IS NOT NULL
          AND started_at >= ?
          AND started_at < ?`,
    )
    .all(...runIds, windowStart, now) as Array<{ id: string; started_at: number }>;

  return bucketByIdFromRows(rows, runIds, now);
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
  // For each run, prefer the latest provenance row attached to its session;
  // we group by run_id and take MAX(captured_at). The outer SELECT projects
  // the branch attached to that captured_at via a self-join on (session_id,
  // captured_at) — safe because (session_id, captured_at) is effectively
  // unique within a session's capture stream.
  const rows = db
    .prepare(
      `SELECT r.id AS run_id, p.branch AS branch
         FROM agent_runs r
         JOIN sessions s ON s.id = r.session_ref
         JOIN knowledge_git_provenance p
           ON p.session_id = s.id
          AND p.captured_at = (
            SELECT MAX(captured_at)
              FROM knowledge_git_provenance
             WHERE session_id = s.id
          )
        WHERE r.id IN (${placeholders})`,
    )
    .all(...runIds) as Array<{ run_id: string; branch: string | null }>;

  for (const row of rows) {
    result.set(row.run_id, row.branch ?? null);
  }
  return result;
}
