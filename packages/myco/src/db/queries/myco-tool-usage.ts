/**
 * Per-session Myco tool-call aggregation.
 *
 * Computes per-session counts of every Myco tool call from the persisted
 * `activities` rows. Run at each Stop boundary; the result is materialized
 * into `session_myco_tool_calls` by `materializeSessionMycoToolCalls`.
 *
 * Mirrors the pattern in `db/queries/canopy.ts`: pure SQL over the
 * authoritative activity log, no in-memory state, no dispatch-time
 * counters. Because every code path (MCP, HTTP, CLI, agent-internal) lands
 * activity rows, every code path rolls up here automatically — no per-tool
 * wiring required.
 *
 * Tool-name canonicalization rules applied in SQL:
 *   - `mcp__myco__myco_myco_<tool>` → `myco_<tool>`  (combined legacy artifact)
 *   - `mcp__myco__<tool>`           → `<tool>`        (MCP-routed names)
 *   - `myco_myco_<tool>`            → `myco_<tool>`   (legacy: pre-fix daemon
 *                                                     applied the `myco_`
 *                                                     prefix twice in
 *                                                     activity rows. Confirmed
 *                                                     in the dogfood vault;
 *                                                     no tool in
 *                                                     `TOOL_DEFINITIONS` is
 *                                                     actually named
 *                                                     `myco_myco_*`.)
 *
 * `op` is `COALESCE(json_extract(tool_input,'$.op'), '')`; empty string
 * (not NULL) is used so the composite PRIMARY KEY on
 * `(session_id, tool_name, op)` is stable for tools with no op dimension.
 *
 * Rows whose `tool_input` is not valid JSON are skipped via `json_valid` so
 * a single malformed payload cannot abort the GROUP BY.
 */

import type { Database } from 'bun:sqlite';
import { getDatabase } from '@myco/db/client.js';
import { MYCO_TOOL_LIKE_PATTERNS } from '@myco/db/queries/team-outbox.js';

export interface MycoToolCallAggregateRow {
  tool_name: string;
  op: string;
  count: number;
}

/**
 * Aggregation SQL. Selects the per-(tool, op) count for one session,
 * canonicalizing tool names (see module doc) and skipping malformed JSON.
 *
 * Tool-name allowlist is encoded inline as four LIKE patterns rather than
 * passed as a parameter list — the four patterns deliberately match the
 * shape of all current and historical Myco / Collective tool names without
 * needing TOOL_DEFINITIONS at the query layer. Adding a new tool that
 * follows the `myco_*` or `collective_*` convention surfaces here for free.
 *
 * Implementation note: the canonicalization runs inside a CTE, and the
 * outer GROUP BY references the CTE columns. SQLite resolves a bare
 * `GROUP BY tool_name` against the source table column when the alias
 * collides with one, which would put `mcp__myco__myco_cortex` and the
 * canonicalized `myco_cortex` into separate buckets even though the SELECT
 * shows the same label for both. The CTE avoids that resolution shadow.
 */
/** WHERE-clause fragment built from the shared `MYCO_TOOL_LIKE_PATTERNS`. */
const MYCO_TOOL_WHERE_ALLOWLIST = MYCO_TOOL_LIKE_PATTERNS
  .map((p) => `a.tool_name LIKE '${p}' ESCAPE '\\'`)
  .join('\n      OR ');

const AGGREGATE_SQL = `
WITH normalized AS (
  SELECT
    CASE
      WHEN a.tool_name LIKE 'mcp__myco__myco_myco_%' THEN substr(a.tool_name, 17)
      WHEN a.tool_name LIKE 'mcp__myco__%'           THEN substr(a.tool_name, 12)
      WHEN a.tool_name LIKE 'myco_myco_%'            THEN substr(a.tool_name, 6)
      ELSE a.tool_name
    END AS canonical_tool_name,
    COALESCE(json_extract(a.tool_input, '$.op'), '') AS canonical_op
  FROM activities a
  WHERE a.session_id = ?
    AND (
      ${MYCO_TOOL_WHERE_ALLOWLIST}
    )
    AND (a.tool_input IS NULL OR json_valid(a.tool_input))
)
SELECT
  canonical_tool_name AS tool_name,
  canonical_op        AS op,
  COUNT(*)            AS count
FROM normalized
GROUP BY canonical_tool_name, canonical_op
`;

/**
 * Compute the per-session Myco tool-call aggregate from persisted activity
 * rows. Pure SQL — no in-memory state. Safe to call repeatedly.
 *
 * Returns an empty array when the session has no Myco tool calls.
 */
export function aggregateSessionMycoToolCalls(
  db: Database | null,
  sessionId: string,
): MycoToolCallAggregateRow[] {
  const handle = db ?? getDatabase();
  const rows = handle.prepare(AGGREGATE_SQL).all(sessionId) as Array<{
    tool_name: string;
    op: string;
    count: number | null;
  }>;
  return rows.map((row) => ({
    tool_name: row.tool_name,
    op: row.op,
    count: Number(row.count ?? 0),
  }));
}

/**
 * Compute the aggregate and UPSERT it into `session_myco_tool_calls`.
 *
 * Idempotent: re-running produces the same final table state. Old rows
 * for tools the session no longer reports are deleted so the materialized
 * view is a faithful snapshot — never a stale superset — of the
 * activities truth.
 *
 * Resolves the owning session's `project_id` once and stamps it onto every
 * row so per-project queries (`WHERE project_id = ?`) work without a JOIN.
 *
 * Returns the number of rows now stored for the session, or `null` if the
 * underlying query failed. Internal failures are swallowed so this is
 * safe to call fire-and-forget from the Stop pipeline.
 */
export function materializeSessionMycoToolCalls(
  sessionId: string,
  db?: Database | null,
): number | null {
  const handle = db ?? getDatabase();
  let aggregate: MycoToolCallAggregateRow[];
  let projectId: string | null;
  try {
    const sessionRow = handle
      .prepare('SELECT project_id FROM sessions WHERE id = ?')
      .get(sessionId) as { project_id: string | null } | undefined;
    if (!sessionRow) return null;
    projectId = sessionRow.project_id ?? null;
    aggregate = aggregateSessionMycoToolCalls(handle, sessionId);
  } catch {
    return null;
  }

  // Single transaction: delete the previous snapshot for this session, then
  // insert the new one. Two-step keeps the deletion bounded to this session
  // (rather than relying on INSERT-or-replace, which leaves orphan rows when
  // a tool stops being called between snapshots).
  try {
    const tx = handle.transaction((rows: MycoToolCallAggregateRow[]) => {
      handle
        .prepare('DELETE FROM session_myco_tool_calls WHERE session_id = ?')
        .run(sessionId);
      if (rows.length === 0) return;
      const insert = handle.prepare(
        `INSERT INTO session_myco_tool_calls
           (session_id, project_id, tool_name, op, count, computed_at)
         VALUES (?, ?, ?, ?, ?, unixepoch())`,
      );
      for (const row of rows) {
        insert.run(sessionId, projectId, row.tool_name, row.op, row.count);
      }
    });
    tx(aggregate);
  } catch {
    return null;
  }

  return aggregate.length;
}

/**
 * Read-side helper for UI / API consumers — returns the materialized
 * per-(tool, op) counts for one session, ordered by descending count.
 *
 * This is what the session-detail page should query for the "Map calls"
 * metric and any future per-Myco-tool tiles.
 */
export function getSessionMycoToolCallCounts(
  sessionId: string,
  db?: Database | null,
): MycoToolCallAggregateRow[] {
  const handle = db ?? getDatabase();
  const rows = handle
    .prepare(
      `SELECT tool_name, op, count
         FROM session_myco_tool_calls
        WHERE session_id = ?
        ORDER BY count DESC, tool_name ASC, op ASC`,
    )
    .all(sessionId) as Array<{ tool_name: string; op: string; count: number | null }>;
  return rows.map((row) => ({
    tool_name: row.tool_name,
    op: row.op,
    count: Number(row.count ?? 0),
  }));
}
