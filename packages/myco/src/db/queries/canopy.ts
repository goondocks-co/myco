/**
 * Canopy aggregation queries.
 *
 * Computes per-session injection outcomes from the persisted `activities`
 * (tool-call) rows. Run at each Stop boundary; the result is materialized
 * onto the `sessions` row by `materializeCanopyAggregates`.
 *
 * The aggregation is a pure SQL self-join — no in-memory state, no
 * correlator. The capture buffer remains authoritative for raw events.
 */

import type { Database } from 'bun:sqlite';
import { getDatabase } from '@myco/db/client.js';
import { CANOPY_SESSION_COLUMNS, CANOPY_ACTIVITY_COLUMN } from '@myco/db/schema-ddl.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Session-level Canopy aggregate computed by `aggregateSessionCanopy`. Field
 * order mirrors `CANOPY_SESSION_COLUMNS` so the UPDATE in
 * `materializeCanopyAggregates` reads cleanly.
 */
export interface CanopySessionAggregate {
  /** Number of Read tool-calls where Canopy offered an injection. */
  injections_offered: number;
  /** Sum of injection token costs across all offered injections. */
  injection_total_tokens: number;
  /** Injections followed by no later Read of the same path within this session. */
  skips_after_injection: number;
  /** Injections where the agent went on to Read the same path anyway (full file). */
  reads_after_injection: number;
  /**
   * Net tokens saved =
   *   Σ(file_tokens − injection_tokens)        over skips
   * − Σ(injection_tokens)                       over reads-after-injection.
   *
   * `file_tokens` is sourced from `canopy_entries.token_estimate` joined on
   * (project_id, path). When an injection's path is missing from
   * `canopy_entries` (deleted, race), the contribution is 0 — conservative.
   */
  tokens_saved: number;
  /** Count of (session, path) pairs read more than once in the session. */
  redundant_reads: number;
}

// ---------------------------------------------------------------------------
// Column-name guards
// ---------------------------------------------------------------------------

// The aggregation SQL hardcodes column names. Cross-check against the
// schema-ddl exports so a column rename triggers a compile error here, not a
// silent NULL aggregate at runtime.
const CANOPY_ACTIVITY_TOKEN_COLUMN = CANOPY_ACTIVITY_COLUMN[0];
const CANOPY_SESSION_COLUMN_NAMES = CANOPY_SESSION_COLUMNS.map(([name]) => name);

const EXPECTED_SESSION_COLUMNS = [
  'canopy_injections_offered',
  'canopy_injection_total_tokens',
  'canopy_skips_after_injection',
  'canopy_reads_after_injection',
  'canopy_tokens_saved',
  'canopy_redundant_reads',
] as const;

if (CANOPY_ACTIVITY_TOKEN_COLUMN !== 'canopy_injection_tokens') {
  throw new Error(
    `Canopy aggregation expects canopy_injection_tokens; schema-ddl exports ${CANOPY_ACTIVITY_TOKEN_COLUMN}`,
  );
}

for (const name of EXPECTED_SESSION_COLUMNS) {
  if (!CANOPY_SESSION_COLUMN_NAMES.includes(name)) {
    throw new Error(`Canopy aggregation expects sessions.${name}; not present in schema-ddl`);
  }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Aggregation SQL.
 *
 * `reads`            — every Read tool-call for the session, with the path
 *                      resolved from JSON tool_input.
 * `skip_resolution`  — for each Read with an injection, decide whether a
 *                      *later* Read of the same path also exists in this
 *                      session. If not, it's a skip.
 *
 * `LEFT JOIN canopy_entries` brings in the file's token estimate so the
 * tokens-saved arithmetic can run without a second round-trip. Joining on
 * `(project_id, path)` requires the project_id; we resolve it from the
 * sessions row's project_root since canopy_entries keys on project_id but
 * the sessions table tracks project_root. The join falls back to NULL when
 * there's no match (file not yet scanned, or excluded).
 *
 * The reads_after_injection branch *spends* injection tokens (negative
 * savings) since we paid the injection cost and then read the file anyway.
 * Skips *save* (file_tokens − injection_tokens).
 */
const AGGREGATE_SQL = `
WITH session_root AS (
  SELECT project_root AS project_id
  FROM sessions
  WHERE id = ?
),
raw_reads AS (
  SELECT
    a.id                       AS tc_id,
    COALESCE(
      json_extract(a.tool_input, '$.file_path'),
      json_extract(a.tool_input, '$.filePath'),
      a.file_path
    ) AS raw_path,
    a.canopy_injection_tokens  AS injection_tokens,
    CASE WHEN a.canopy_injection_tokens IS NOT NULL THEN 1 ELSE 0 END AS had_injection,
    a.timestamp                AS ts
  FROM activities a
  WHERE a.session_id = ?
    AND a.tool_name = 'Read'
),
reads AS (
  SELECT
    rr.tc_id,
    CASE
      WHEN rr.raw_path IS NOT NULL
       AND (SELECT project_id FROM session_root) IS NOT NULL
       AND rr.raw_path LIKE (SELECT project_id FROM session_root) || '/%'
      THEN substr(rr.raw_path, length((SELECT project_id FROM session_root)) + 2)
      ELSE rr.raw_path
    END AS path,
    rr.injection_tokens,
    rr.had_injection,
    rr.ts
  FROM raw_reads rr
),
skip_resolution AS (
  SELECT
    r.tc_id,
    r.path,
    r.injection_tokens,
    r.had_injection,
    CASE
      WHEN r.had_injection = 1
       AND NOT EXISTS (
         SELECT 1 FROM reads r2
         WHERE r2.path = r.path
           AND (
             r2.ts > r.ts
             OR (r2.ts = r.ts AND r2.tc_id > r.tc_id)
           )
       )
      THEN 1 ELSE 0
    END AS skipped
  FROM reads r
),
tokens AS (
  SELECT
    sr.tc_id,
    sr.path,
    sr.injection_tokens,
    sr.had_injection,
    sr.skipped,
    ce.token_estimate AS file_tokens
  FROM skip_resolution sr
  LEFT JOIN canopy_entries ce
    ON ce.project_id = (SELECT project_id FROM session_root)
   AND ce.path = sr.path
),
redundant AS (
  SELECT COUNT(*) AS redundant_reads
  FROM (
    SELECT path
    FROM reads
    WHERE path IS NOT NULL
    GROUP BY path
    HAVING COUNT(*) > 1
  )
)
SELECT
  COALESCE(SUM(t.had_injection), 0)                                              AS injections_offered,
  COALESCE(SUM(CASE WHEN t.had_injection = 1 THEN t.injection_tokens END), 0)    AS injection_total_tokens,
  COALESCE(SUM(CASE WHEN t.skipped = 1 THEN 1 ELSE 0 END), 0)                    AS skips_after_injection,
  COALESCE(SUM(CASE WHEN t.had_injection = 1 AND t.skipped = 0 THEN 1 ELSE 0 END), 0) AS reads_after_injection,
  COALESCE(
    SUM(
      CASE
        WHEN t.skipped = 1
          THEN COALESCE(t.file_tokens, 0) - COALESCE(t.injection_tokens, 0)
        WHEN t.had_injection = 1 AND t.skipped = 0
          THEN -COALESCE(t.injection_tokens, 0)
        ELSE 0
      END
    ),
    0
  )                                                                              AS tokens_saved,
  (SELECT redundant_reads FROM redundant)                                         AS redundant_reads
FROM tokens t
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the per-session Canopy aggregate from persisted activity rows.
 *
 * Pure SQL — no in-memory state, no correlator. Safe to call repeatedly
 * (e.g. once per Stop boundary): later calls overwrite earlier results.
 *
 * @param db - Optional Database handle. Defaults to the process-wide
 *             `getDatabase()` (matches the rest of the queries module).
 *             Pass an explicit handle for tests or when a non-default DB
 *             is in use.
 * @param sessionId - Session whose aggregates to compute.
 */
export function aggregateSessionCanopy(
  db: Database | null,
  sessionId: string,
): CanopySessionAggregate {
  const handle = db ?? getDatabase();
  const row = handle.prepare(AGGREGATE_SQL).get(sessionId, sessionId) as
    | {
        injections_offered: number | null;
        injection_total_tokens: number | null;
        skips_after_injection: number | null;
        reads_after_injection: number | null;
        tokens_saved: number | null;
        redundant_reads: number | null;
      }
    | undefined;

  return {
    injections_offered: Number(row?.injections_offered ?? 0),
    injection_total_tokens: Number(row?.injection_total_tokens ?? 0),
    skips_after_injection: Number(row?.skips_after_injection ?? 0),
    reads_after_injection: Number(row?.reads_after_injection ?? 0),
    tokens_saved: Number(row?.tokens_saved ?? 0),
    redundant_reads: Number(row?.redundant_reads ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Cross-session rollup
// ---------------------------------------------------------------------------

export interface CanopyRollup {
  sessions_with_data: number;
  total_tokens_saved: number;
  avg_tokens_saved_per_session: number;
  total_injections_offered: number;
  total_skips_after_injection: number;
  /** skips / injections, or 0 when no injections offered. */
  skip_ratio: number;
}

export interface CanopyRollupOptions {
  /** Inclusive lower bound on session.started_at (epoch seconds). */
  since?: number;
  /** Inclusive upper bound on session.started_at (epoch seconds). */
  until?: number;
}

/**
 * Cross-session Canopy rollup for the all-sessions UI surface. Only sessions
 * with non-NULL `canopy_injections_offered` contribute (pre-feature sessions
 * and disabled-injection sessions are excluded).
 */
export function rollupCanopy(
  db: Database | null,
  opts: CanopyRollupOptions = {},
): CanopyRollup {
  const handle = db ?? getDatabase();
  const clauses: string[] = ['canopy_injections_offered IS NOT NULL'];
  const params: number[] = [];
  if (opts.since !== undefined) {
    clauses.push('started_at >= ?');
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    clauses.push('started_at <= ?');
    params.push(opts.until);
  }

  const sql = `
    SELECT
      COUNT(*)                                          AS sessions_with_data,
      COALESCE(SUM(canopy_tokens_saved), 0)             AS total_tokens_saved,
      COALESCE(SUM(canopy_injections_offered), 0)       AS total_injections_offered,
      COALESCE(SUM(canopy_skips_after_injection), 0)    AS total_skips_after_injection
    FROM sessions
    WHERE ${clauses.join(' AND ')}
  `;
  const row = handle.prepare(sql).get(...params) as {
    sessions_with_data: number | null;
    total_tokens_saved: number | null;
    total_injections_offered: number | null;
    total_skips_after_injection: number | null;
  } | undefined;

  const sessions = Number(row?.sessions_with_data ?? 0);
  const tokens = Number(row?.total_tokens_saved ?? 0);
  const injections = Number(row?.total_injections_offered ?? 0);
  const skips = Number(row?.total_skips_after_injection ?? 0);

  return {
    sessions_with_data: sessions,
    total_tokens_saved: tokens,
    avg_tokens_saved_per_session: sessions > 0 ? tokens / sessions : 0,
    total_injections_offered: injections,
    total_skips_after_injection: skips,
    skip_ratio: injections > 0 ? skips / injections : 0,
  };
}

// ---------------------------------------------------------------------------
// Shared canopy_entries listing helpers
// ---------------------------------------------------------------------------

/**
 * Canonical ORDER BY for canopy_entries listings. Stable alphabetical order
 * keeps inputs_hash computation and pagination deterministic across calls.
 */
export const CANOPY_ENTRIES_ORDER_BY = 'path ASC';

/**
 * Build the WHERE clause + params for "described canopy entries scoped to
 * project". Callers append additional filters and shape the SELECT column
 * list themselves — the column lists differ across consumers (the agent
 * tool, the daemon API, and the render-phase context loader each project
 * a different subset), so this helper only fixes the canonical predicate.
 *
 * Returns: `{ where, params }` where `where` is everything after `WHERE`
 * (no leading keyword) and `params` matches the placeholder count.
 */
export function describedCanopyEntriesPredicate(
  projectId: string,
): { where: string; params: unknown[] } {
  return {
    where: 'project_id = ? AND llm_description IS NOT NULL',
    params: [projectId],
  };
}

// ---------------------------------------------------------------------------
// Per-session Read activities (with canopy column) for the UI
// ---------------------------------------------------------------------------

export interface CanopyReadRow {
  id: number;
  timestamp: number;
  file_path: string | null;
  canopy_injection_tokens: number | null;
}

/**
 * Read tool-calls for a session, ordered by timestamp. Used by the
 * `/sessions/:id/canopy` endpoint to render per-tool-call indicators.
 */
export function listCanopyReads(db: Database | null, sessionId: string): CanopyReadRow[] {
  const handle = db ?? getDatabase();
  return handle
    .prepare(
      `
        SELECT
          id,
          timestamp,
          COALESCE(json_extract(tool_input, '$.file_path'), json_extract(tool_input, '$.filePath'), file_path) AS file_path,
          canopy_injection_tokens
        FROM activities
        WHERE session_id = ?
          AND tool_name = 'Read'
        ORDER BY timestamp ASC, id ASC
      `,
    )
    .all(sessionId) as CanopyReadRow[];
}

/**
 * Look up the canopy_entries row that backs a specific tool-call's path, so
 * the read endpoint can replay the injection blob. Returns null if the
 * tool-call doesn't exist, isn't a Read, has no file_path in tool_input, or
 * the canopy_entries row is missing (deleted/excluded since the call ran).
 */
export interface CanopyToolCallContext {
  activity_id: number;
  session_id: string;
  file_path: string;
  injection_tokens: number | null;
  /** project_id used to look up canopy_entries — sessions.project_root. */
  project_id: string | null;
}

export function getCanopyToolCallContext(
  db: Database | null,
  sessionId: string,
  activityId: number,
): CanopyToolCallContext | null {
  const handle = db ?? getDatabase();
  const row = handle
    .prepare(
      `
        SELECT
          a.id                                       AS activity_id,
          a.session_id                               AS session_id,
          COALESCE(json_extract(a.tool_input, '$.file_path'), json_extract(a.tool_input, '$.filePath'), a.file_path) AS file_path,
          a.canopy_injection_tokens                  AS injection_tokens,
          s.project_root                             AS project_id
        FROM activities a
        LEFT JOIN sessions s ON s.id = a.session_id
        WHERE a.id = ?
          AND a.session_id = ?
          AND a.tool_name = 'Read'
          AND a.canopy_injection_tokens IS NOT NULL
      `,
    )
    .get(activityId, sessionId) as CanopyToolCallContext | undefined;

  if (!row || !row.file_path) return null;
  return row;
}
