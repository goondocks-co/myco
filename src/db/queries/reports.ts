/**
 * Agent report CRUD query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of reports returned by list queries when no limit given. */
const DEFAULT_LIST_LIMIT = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting a report. */
export interface ReportInsert {
  run_id: string;
  curator_id: string;
  action: string;
  summary: string;
  details?: string | null;
  created_at: number;
}

/** Row shape returned from agent_reports queries (all columns). */
export interface ReportRow {
  id: number;
  run_id: string;
  curator_id: string;
  action: string;
  summary: string;
  details: string | null;
  created_at: number;
}

/** Filter options for `listReportsByCurator`. */
export interface ListReportsByCuratorOptions {
  limit?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const REPORT_COLUMNS = [
  'id',
  'run_id',
  'curator_id',
  'action',
  'summary',
  'details',
  'created_at',
] as const;

const SELECT_COLUMNS = REPORT_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed ReportRow. */
function toReportRow(row: Record<string, unknown>): ReportRow {
  return {
    id: row.id as number,
    run_id: row.run_id as string,
    curator_id: row.curator_id as string,
    action: row.action as string,
    summary: row.summary as string,
    details: (row.details as string) ?? null,
    created_at: row.created_at as number,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new agent report.
 */
export async function insertReport(data: ReportInsert): Promise<ReportRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO agent_reports (
       run_id, curator_id, action, summary, details, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6
     )
     RETURNING ${SELECT_COLUMNS}`,
    [
      data.run_id,
      data.curator_id,
      data.action,
      data.summary,
      data.details ?? null,
      data.created_at,
    ],
  );

  return toReportRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List all reports for a specific run, ordered by created_at ASC.
 */
export async function listReports(runId: string): Promise<ReportRow[]> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_reports
     WHERE run_id = $1
     ORDER BY created_at ASC`,
    [runId],
  );

  return (result.rows as Record<string, unknown>[]).map(toReportRow);
}

/**
 * List reports by curator, ordered by created_at DESC.
 */
export async function listReportsByCurator(
  curatorId: string,
  options: ListReportsByCuratorOptions = {},
): Promise<ReportRow[]> {
  const db = getDatabase();

  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_reports
     WHERE curator_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [curatorId, limit],
  );

  return (result.rows as Record<string, unknown>[]).map(toReportRow);
}
