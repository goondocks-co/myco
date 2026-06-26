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
import { allCanopyReadToolNames } from '@myco/symbionts/canopy-read-tools.js';
import { projectScopeClause, type ProjectScope } from './project-scope.js';
import type { CanopyEntry } from '@myco/db/schema.js';

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
 * `(project_id, path)` requires sessions.project_id. Absolute paths are
 * canonicalized against sessions.project_root, while already-normalized
 * activity file paths pass through unchanged. The join falls back to NULL
 * when there's no match (file not yet scanned, or excluded).
 *
 * The reads_after_injection branch *spends* injection tokens (negative
 * savings) since we paid the injection cost and then read the file anyway.
 * Skips *save* (file_tokens − injection_tokens).
 */
const AGGREGATE_SQL = `
WITH session_ctx AS (
  SELECT project_id, project_root
  FROM sessions
  WHERE id = ?
),
raw_reads AS (
  SELECT
    a.id                       AS tc_id,
    COALESCE(
      a.file_path,
      json_extract(a.tool_input, '$.file_path'),
      json_extract(a.tool_input, '$.filePath')
    ) AS raw_path,
    a.canopy_injection_tokens  AS injection_tokens,
    CASE WHEN a.canopy_injection_tokens IS NOT NULL THEN 1 ELSE 0 END AS had_injection,
    a.timestamp                AS ts
  FROM activities a
  WHERE a.session_id = ?
    AND a.tool_name IN (SELECT value FROM json_each(?))
),
reads AS (
  SELECT
    rr.tc_id,
    CASE
      WHEN rr.raw_path IS NOT NULL
       AND (SELECT project_root FROM session_ctx) IS NOT NULL
       AND rr.raw_path LIKE (SELECT project_root FROM session_ctx) || '/%'
      THEN substr(rr.raw_path, length((SELECT project_root FROM session_ctx)) + 2)
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
    ON ce.project_id = (SELECT project_id FROM session_ctx)
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
  // Tool-name allowlist comes from the union of canopyReadTools across all
  // installed manifests — manifest-driven so Codex's Bash reads, Claude's
  // Read calls, and any future symbiont's tool surface all roll up without
  // hardcoded checks here. Fast path: no manifests declare read tools →
  // there can't be any qualifying activities.
  const toolNames = allCanopyReadToolNames();
  if (toolNames.length === 0) {
    return {
      injections_offered: 0,
      injection_total_tokens: 0,
      skips_after_injection: 0,
      reads_after_injection: 0,
      tokens_saved: 0,
      redundant_reads: 0,
    };
  }
  const toolNamesJson = JSON.stringify(toolNames);
  const row = handle.prepare(AGGREGATE_SQL).get(sessionId, sessionId, toolNamesJson) as
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
 *
 * Scope MUST be applied: post-Grove the `sessions` table holds rows for
 * every project in the same Grove DB. An unscoped rollup leaks aggregate
 * metrics across project boundaries. Pass `ALL_PROJECTS_SCOPE` only when
 * a cross-project Grove-wide aggregate is genuinely intended.
 */
export function rollupCanopy(
  scope: ProjectScope,
  opts: CanopyRollupOptions = {},
  db: Database | null = null,
): CanopyRollup {
  const handle = db ?? getDatabase();
  const clauses: string[] = ['canopy_injections_offered IS NOT NULL'];
  const params: unknown[] = [];
  const scopeClause = projectScopeClause(scope);
  if (scopeClause.sql) {
    // scopeClause.sql starts with " AND "; strip the leading " AND " since
    // we're appending to a clauses array that's joined with ' AND '.
    clauses.push(scopeClause.sql.replace(/^ AND /, ''));
    params.push(...scopeClause.params);
  }
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

/**
 * Default canopy-describe retry budget per row. Mirrors the
 * `params.max_attempts` default in canopy-describe.yaml; a per-project
 * override of that param must be threaded through to every consumer of
 * `PENDING_CANOPY_DESCRIBE_PREDICATE` so fetch and count agree.
 */
export const DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS = 2;

/**
 * Canonical "needs an llm_description" predicate for canopy_entries:
 * description NULL or stale relative to mechanical_updated_at, AND the row
 * has not exhausted its describe retry budget (one `?` placeholder for
 * maxAttempts). Shared verbatim by the fetch (SELECT_PENDING_SQL in
 * agent/tools/canopy-tools.ts) and the scheduler count below so the two
 * can never disagree about what is pending. Attempts reset to 0 whenever
 * the mechanical scanner updates the row (canopy/scanner/upsert.ts).
 */
export const PENDING_CANOPY_DESCRIBE_PREDICATE = `(
      llm_updated_at IS NULL
      OR llm_updated_at < mechanical_updated_at
    )
    AND describe_attempts < ?`;

/**
 * Canonical "needs an llm_description but has exhausted its retry budget"
 * predicate for canopy_entries. Mirrors PENDING_CANOPY_DESCRIBE_PREDICATE's
 * needs-describe condition (`llm_updated_at IS NULL OR llm_updated_at <
 * mechanical_updated_at`) but gates on `describe_attempts >= ?` (one `?`
 * placeholder for maxAttempts). Used by getCanopyDescribeBacklog to surface
 * the stuck bucket — rows that will never be serviced by the current scribe
 * run until their attempt counter is reset.
 */
export const STUCK_CANOPY_DESCRIBE_PREDICATE = `(
      llm_updated_at IS NULL
      OR llm_updated_at < mechanical_updated_at
    )
    AND describe_attempts >= ?`;

/**
 * Count canopy_entries rows that need an llm_description (NULL or stale
 * relative to mechanical_updated_at, with describe_attempts under the
 * retry budget). Owned by the canopy domain — the predicate is literally
 * shared with SELECT_PENDING_SQL in agent/tools/canopy-tools.ts and the
 * boolean has-pending-canopy-rows precondition in
 * daemon/task-scheduling.ts. Co-located with the rest of the canopy
 * queries so the scheduler doesn't have to import schema knowledge it
 * doesn't own.
 */
export function countPendingCanopyDescribe(
  db: Database | null,
  projectId: string,
  limit?: number,
  maxAttempts: number = DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS,
): number {
  const conn = db ?? getDatabase();
  if (limit !== undefined) {
    const boundedLimit = Math.max(1, Math.floor(limit));
    const row = conn.prepare(
      `SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM canopy_entries
        WHERE project_id = ?
          AND ${PENDING_CANOPY_DESCRIBE_PREDICATE}
        LIMIT ?
      )`,
    ).get(projectId, maxAttempts, boundedLimit) as { n: number } | undefined;
    return row?.n ?? 0;
  }
  const row = conn.prepare(
    `SELECT COUNT(*) AS n FROM canopy_entries
      WHERE project_id = ?
        AND ${PENDING_CANOPY_DESCRIBE_PREDICATE}`,
  ).get(projectId, maxAttempts) as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface CanopyDescribeBacklog {
  pending: number;
  undescribed: number;
  stale: number;
  /** Rows that need a description but have exhausted the retry budget. */
  stuck: number;
}

export interface CanopyDescribeBacklogOptions {
  /**
   * Restrict the count to these project ids. Grove-wide callers pass the
   * active registered projects so rows from deleted or archived projects
   * (which no scribe run will ever service) don't inflate the backlog.
   */
  projectIds?: readonly string[];
  /**
   * Per-row describe retry budget (the task's `params.max_attempts`).
   * Callers without a resolved config take the yaml default so the backlog
   * applies the same serviceability bar as the fetch/count predicate.
   */
  maxAttempts?: number;
}

/**
 * Count the upstream Canopy scribe backlog. This is deliberately separate
 * from embedding queue depth: changed files keep their old vector until the
 * describe task refreshes llm_description and re-queues embedding.
 *
 * Every bucket shares the fetch predicate's describe_attempts cap — rows a
 * poisoned tail has exhausted are work no scribe run will ever service, so
 * they must not inflate the backlog (`pending` stays `undescribed + stale`).
 */
export function getCanopyDescribeBacklog(
  db: Database,
  scope: ProjectScope,
  options: CanopyDescribeBacklogOptions = {},
): CanopyDescribeBacklog {
  const maxAttempts = options.maxAttempts ?? DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS;
  const { sql: projectSql, params } = projectScopeClause(scope);
  let restrictSql = '';
  if (options.projectIds) {
    restrictSql = ' AND project_id IN (SELECT value FROM json_each(?))';
    params.push(JSON.stringify(options.projectIds));
  }
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN ${PENDING_CANOPY_DESCRIBE_PREDICATE} THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN llm_updated_at IS NULL AND describe_attempts < ? THEN 1 ELSE 0 END) AS undescribed,
       SUM(CASE WHEN llm_updated_at IS NOT NULL AND llm_updated_at < mechanical_updated_at AND describe_attempts < ? THEN 1 ELSE 0 END) AS stale,
       SUM(CASE WHEN ${STUCK_CANOPY_DESCRIBE_PREDICATE} THEN 1 ELSE 0 END) AS stuck
       FROM canopy_entries
      WHERE 1 = 1${projectSql}${restrictSql}`,
  ).get(maxAttempts, maxAttempts, maxAttempts, maxAttempts, ...params) as { pending: number | null; undescribed: number | null; stale: number | null; stuck: number | null } | undefined;
  return {
    pending: Number(row?.pending ?? 0),
    undescribed: Number(row?.undescribed ?? 0),
    stale: Number(row?.stale ?? 0),
    stuck: Number(row?.stuck ?? 0),
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
 *
 * Tool-name allowlist comes from the union of canopyReadTools across all
 * installed manifests — manifest-driven so Codex's Bash reads, Claude's
 * Read calls, and any future symbiont's tool surface all surface here
 * without hardcoded checks.
 */
export function listCanopyReads(db: Database | null, sessionId: string): CanopyReadRow[] {
  const handle = db ?? getDatabase();
  const toolNames = allCanopyReadToolNames();
  if (toolNames.length === 0) return [];
  const toolNamesJson = JSON.stringify(toolNames);
  return handle
    .prepare(
      `
        SELECT
          id,
          timestamp,
          COALESCE(file_path, json_extract(tool_input, '$.file_path'), json_extract(tool_input, '$.filePath')) AS file_path,
          canopy_injection_tokens
        FROM activities
        WHERE session_id = ?
          AND tool_name IN (SELECT value FROM json_each(?))
        ORDER BY timestamp ASC, id ASC
      `,
    )
    .all(sessionId, toolNamesJson) as CanopyReadRow[];
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
  /** project_id used to look up canopy_entries. */
  project_id: string | null;
  /** project root used only to canonicalize absolute filesystem paths. */
  project_root: string | null;
}

export function getCanopyToolCallContext(
  scope: ProjectScope,
  sessionId: string,
  activityId: number,
  db: Database | null = null,
): CanopyToolCallContext | null {
  const handle = db ?? getDatabase();
  const toolNames = allCanopyReadToolNames();
  // Tool-name allowlist is manifest-driven (matches aggregateSessionCanopy
  // and listCanopyReads). No manifest declares a canopy read tool → no
  // activity can have qualified, so the context cannot exist.
  if (toolNames.length === 0) return null;
  const toolNamesJson = JSON.stringify(toolNames);
  const scopeClause = projectScopeClause(scope, 'a');
  const row = handle
    .prepare(
      `
        SELECT
          a.id                                       AS activity_id,
          a.session_id                               AS session_id,
          COALESCE(a.file_path, json_extract(a.tool_input, '$.file_path'), json_extract(a.tool_input, '$.filePath')) AS file_path,
          a.canopy_injection_tokens                  AS injection_tokens,
          s.project_id                               AS project_id,
          s.project_root                             AS project_root
        FROM activities a
        LEFT JOIN sessions s ON s.id = a.session_id
        WHERE a.id = ?
          AND a.session_id = ?
          AND a.tool_name IN (SELECT value FROM json_each(?))
          AND a.canopy_injection_tokens IS NOT NULL
          ${scopeClause.sql}
      `,
    )
    .get(activityId, sessionId, toolNamesJson, ...scopeClause.params) as CanopyToolCallContext | undefined;

  if (!row || !row.file_path) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Canopy-describe tool queries (canopy-tools.ts data-access layer)
// ---------------------------------------------------------------------------

/**
 * Fetch up to `limit` canopy_entries rows that need an llm_description —
 * NULL or stale relative to mechanical_updated_at, with describe_attempts
 * under the retry budget. Bind order: (projectId, maxAttempts, limit).
 *
 * Uses PENDING_CANOPY_DESCRIBE_PREDICATE verbatim so fetch and count
 * cannot disagree about what is pending.
 */
export function selectPendingCanopyDescribe(
  db: Database,
  projectId: string,
  options: { maxAttempts: number; limit: number },
): CanopyEntry[] {
  return db.prepare(
    `SELECT *
       FROM canopy_entries
      WHERE project_id = ?
        AND ${PENDING_CANOPY_DESCRIBE_PREDICATE}
      ORDER BY (llm_updated_at IS NULL) DESC, mechanical_updated_at ASC
      LIMIT ?`,
  ).all(projectId, options.maxAttempts, options.limit) as CanopyEntry[];
}

/**
 * Charge one describe attempt against each of `paths` for the given project.
 * Called by canopy_describe_charge after the harness has evaluated a batch:
 * every path passed here is a row the model ran against but that produced no
 * accepted description (content failure or skip). Connectivity failures must
 * never reach this function — charging them would burn the per-row retry
 * budget during a provider outage. json_each fans the path list into the
 * IN-clause in a single statement. Returns the number of rows charged.
 * Bind order: (projectId, JSON path array).
 */
export function chargeDescribeAttempts(
  db: Database,
  projectId: string,
  paths: readonly string[],
): number {
  const result = db.prepare(
    `UPDATE canopy_entries
        SET describe_attempts = describe_attempts + 1
      WHERE project_id = ?
        AND path IN (SELECT value FROM json_each(?))`,
  ).run(projectId, JSON.stringify(paths));
  return Number(result.changes ?? 0);
}

/**
 * Reset `describe_attempts` to 0 for all stuck rows (rows matching
 * `STUCK_CANOPY_DESCRIBE_PREDICATE`) within `scope`. This re-eligibilizes
 * them for the next canopy-describe scribe run.
 *
 * Pass `options.projectIds` to restrict the reset to serviceable projects.
 * For a grove-wide ('all') reset, pass `projectIds` (the active registered
 * project list) so orphaned/archived-project rows are NOT cleared — mirrors
 * the same `projectIds` restrict in `getCanopyDescribeBacklog`.
 *
 * Bind order: (maxAttempts, ...scopeParams[, projectIds JSON]).
 * `STUCK_CANOPY_DESCRIBE_PREDICATE` supplies the leading `>= ?` placeholder;
 * scope params follow; the optional json_each param is last.
 *
 * Returns the number of rows reset.
 */
export function resetStuckDescribeAttempts(
  db: Database,
  scope: ProjectScope,
  options: { maxAttempts?: number; projectIds?: readonly string[] } = {},
): number {
  const maxAttempts = options.maxAttempts ?? DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS;
  const { sql: projectSql, params } = projectScopeClause(scope);
  let restrictSql = '';
  if (options.projectIds) {
    restrictSql = ' AND project_id IN (SELECT value FROM json_each(?))';
    params.push(JSON.stringify(options.projectIds));
  }
  const res = db.prepare(
    `UPDATE canopy_entries SET describe_attempts = 0
       WHERE ${STUCK_CANOPY_DESCRIBE_PREDICATE}${projectSql}${restrictSql}`,
  ).run(maxAttempts, ...params);
  return Number(res.changes ?? 0);
}

/**
 * Fetch a single canopy_entries row by (projectId, path).
 * Returns the full CanopyEntry or null if no row exists.
 * Bind order: (projectId, path).
 */
export function getCanopyEntryByPath(
  db: Database,
  projectId: string,
  entryPath: string,
): CanopyEntry | null {
  return db.prepare(
    `SELECT *
       FROM canopy_entries
      WHERE project_id = ? AND path = ?
      LIMIT 1`,
  ).get(projectId, entryPath) as CanopyEntry | null;
}

/**
 * Fetch only the exports_json column for a canopy_entries row.
 * Used by canopy_describe_write to run the post-process gate without
 * pulling the full row. Bind order: (projectId, path).
 *
 * Returns null when the path is unknown (triggers unknown_path rejection).
 */
export function getCanopyEntryExports(
  db: Database,
  projectId: string,
  entryPath: string,
): { exports_json: string | null } | null {
  return db.prepare(
    `SELECT exports_json
       FROM canopy_entries
      WHERE project_id = ? AND path = ?`,
  ).get(projectId, entryPath) as { exports_json: string | null } | null;
}

/**
 * Write a post-processed description onto a canopy_entries row and reset
 * embedded=0 so the embedding queue picks the row up again.
 * Bind order: (description, nowEpochSeconds, projectId, path).
 */
export function setCanopyDescription(
  db: Database,
  projectId: string,
  entryPath: string,
  description: string,
  nowEpochSeconds: number,
): void {
  db.prepare(
    `UPDATE canopy_entries
        SET llm_description = ?,
            llm_updated_at  = ?,
            embedded        = 0
      WHERE project_id = ? AND path = ?`,
  ).run(description, nowEpochSeconds, projectId, entryPath);
}

/**
 * Row shape returned by listCanopyEntries — the column subset the
 * canopy_list tool projects.
 */
export interface CanopyListRow {
  path: string;
  language: string | null;
  llm_description: string | null;
  exports_json: string | null;
  imports_json: string | null;
  token_estimate: number;
}

/**
 * List canopy_entries for a project.  When includeUndescribed is false
 * (default) only rows with a non-NULL llm_description are returned.
 * Uses describedCanopyEntriesPredicate and CANOPY_ENTRIES_ORDER_BY so the
 * sort and predicate cannot diverge from other consumers.
 */
export function listCanopyEntries(
  db: Database,
  projectId: string,
  options: { includeUndescribed: boolean; limit: number },
): CanopyListRow[] {
  const { where, params } = options.includeUndescribed
    ? { where: 'project_id = ?', params: [projectId] as unknown[] }
    : describedCanopyEntriesPredicate(projectId);
  return db.prepare(
    `SELECT path, language, llm_description, exports_json, imports_json, token_estimate
       FROM canopy_entries
      WHERE ${where}
      ORDER BY ${CANOPY_ENTRIES_ORDER_BY}
      LIMIT ?`,
  ).all(...params, options.limit) as CanopyListRow[];
}
