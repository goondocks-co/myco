/**
 * Log entry CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { LEVEL_ORDER, type LogLevel } from '@myco/daemon/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of log entries per page for search results. */
const DEFAULT_PAGE_SIZE = 100;

/** Default number of entries returned by getLogsSince. */
const DEFAULT_STREAM_LIMIT = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required when inserting a log entry. */
export interface LogEntryInsert {
  timestamp: string;
  level: string;
  kind: string;
  component: string;
  message: string;
  data: string | null;
  session_id: string | null;
}

/** Row shape returned from log_entries queries (all columns). */
export interface LogEntryRow {
  id: number;
  timestamp: string;
  level: string;
  kind: string;
  component: string;
  message: string;
  data: string | null;
  session_id: string | null;
}

/** Filter options for `searchLogs`. */
export interface LogSearchParams {
  q?: string;
  level?: string;
  component?: string;
  kind?: string;
  session_id?: string;
  from?: string;
  to?: string;
  page?: number;
  page_size?: number;
}

/** Paginated result from `searchLogs`. */
export interface LogSearchResult {
  entries: LogEntryRow[];
  total: number;
  page: number;
  page_size: number;
}

/** Result from `getLogsSince` for streaming/tailing. */
export interface LogStreamResult {
  entries: LogEntryRow[];
  cursor: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a raw SQLite result row into a typed LogEntryRow. */
function toLogEntryRow(row: Record<string, unknown>): LogEntryRow {
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    level: row.level as string,
    kind: row.kind as string,
    component: row.component as string,
    message: row.message as string,
    data: (row.data as string) ?? null,
    session_id: (row.session_id as string) ?? null,
  };
}

/**
 * Return all level names whose numeric order is >= the given minimum level.
 *
 * Example: levelsAtOrAbove('warn') → ['warn', 'error']
 */
function levelsAtOrAbove(minLevel: string): string[] {
  const minOrder = LEVEL_ORDER[minLevel as LogLevel] ?? 0;
  return (Object.keys(LEVEL_ORDER) as LogLevel[]).filter(
    (l) => LEVEL_ORDER[l] >= minOrder,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a log entry into `log_entries`.
 *
 * FTS sync is handled automatically by the `log_entries_ai` trigger.
 * Returns the new row's integer id.
 */
export function insertLogEntry(entry: LogEntryInsert): number {
  const db = getDatabase();

  const info = db.prepare(
    `INSERT INTO log_entries (timestamp, level, kind, component, message, data, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.timestamp,
    entry.level,
    entry.kind,
    entry.component,
    entry.message,
    entry.data,
    entry.session_id,
  );

  return info.lastInsertRowid as number;
}

/**
 * Search log entries with optional filters and pagination.
 *
 * Supports:
 * - Full-text search via FTS5 (q param)
 * - Level filter (returns entries at or above the specified level)
 * - Component filter (comma-separated list)
 * - Kind filter
 * - Session ID filter
 * - Time range (from / to ISO timestamps)
 * - Pagination (page / page_size, 1-based page index)
 *
 * Results are ordered by timestamp DESC, id DESC.
 */
export function searchLogs(params: LogSearchParams): LogSearchResult {
  const db = getDatabase();

  const page = params.page ?? 1;
  const pageSize = params.page_size ?? DEFAULT_PAGE_SIZE;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const queryParams: unknown[] = [];

  // Full-text search via FTS5 sub-select
  if (params.q !== undefined && params.q.length > 0) {
    conditions.push(`le.id IN (SELECT rowid FROM log_entries_fts WHERE log_entries_fts MATCH ?)`);
    queryParams.push(params.q);
  }

  // Level filter — include all levels at or above the minimum
  if (params.level !== undefined && params.level.length > 0) {
    const levels = levelsAtOrAbove(params.level);
    if (levels.length > 0) {
      conditions.push(`le.level IN (SELECT value FROM json_each(?))`);
      queryParams.push(JSON.stringify(levels));
    }
  }

  // Component filter — comma-separated list
  if (params.component !== undefined && params.component.length > 0) {
    const components = params.component.split(',').map((c) => c.trim()).filter(Boolean);
    if (components.length > 0) {
      conditions.push(`le.component IN (SELECT value FROM json_each(?))`);
      queryParams.push(JSON.stringify(components));
    }
  }

  // Kind filter
  if (params.kind !== undefined && params.kind.length > 0) {
    conditions.push(`le.kind = ?`);
    queryParams.push(params.kind);
  }

  // Session ID filter
  if (params.session_id !== undefined && params.session_id.length > 0) {
    conditions.push(`le.session_id = ?`);
    queryParams.push(params.session_id);
  }

  // Time range
  if (params.from !== undefined && params.from.length > 0) {
    conditions.push(`le.timestamp >= ?`);
    queryParams.push(params.from);
  }

  if (params.to !== undefined && params.to.length > 0) {
    conditions.push(`le.timestamp <= ?`);
    queryParams.push(params.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = db.prepare(
    `SELECT COUNT(*) as count FROM log_entries le ${where}`,
  ).get(...queryParams) as { count: number };

  const rows = db.prepare(
    `SELECT le.id, le.timestamp, le.level, le.kind, le.component, le.message, le.data, le.session_id
     FROM log_entries le
     ${where}
     ORDER BY le.timestamp DESC, le.id DESC
     LIMIT ?
     OFFSET ?`,
  ).all(...queryParams, pageSize, offset) as Record<string, unknown>[];

  return {
    entries: rows.map(toLogEntryRow),
    total: countRow.count,
    page,
    page_size: pageSize,
  };
}

/**
 * Return log entries with id > sinceId in ascending order, for streaming/tailing.
 *
 * Returns entries and a cursor (the id of the last entry returned,
 * or sinceId if no entries were found).
 */
export function getLogsSince(sinceId: number, limit?: number): LogStreamResult {
  const db = getDatabase();
  const effectiveLimit = limit ?? DEFAULT_STREAM_LIMIT;

  const rows = db.prepare(
    `SELECT id, timestamp, level, kind, component, message, data, session_id
     FROM log_entries
     WHERE id > ?
     ORDER BY id ASC
     LIMIT ?`,
  ).all(sinceId, effectiveLimit) as Record<string, unknown>[];

  const entries = rows.map(toLogEntryRow);
  const cursor = entries.length > 0 ? entries[entries.length - 1].id : sinceId;

  return { entries, cursor };
}

/**
 * Retrieve a single log entry by id.
 *
 * @returns the entry row, or null if not found.
 */
export function getLogEntry(id: number): LogEntryRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT id, timestamp, level, kind, component, message, data, session_id
     FROM log_entries
     WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toLogEntryRow(row);
}

/**
 * Delete log entries older than `beforeTimestamp`.
 *
 * FTS cleanup is handled automatically by the `log_entries_ad` trigger.
 *
 * @returns the number of rows deleted from log_entries.
 */
export function deleteOldLogs(beforeTimestamp: string): number {
  const db = getDatabase();

  const info = db.prepare(
    `DELETE FROM log_entries WHERE timestamp < ?`,
  ).run(beforeTimestamp);

  return info.changes;
}

/**
 * Return the maximum timestamp in the log_entries table.
 *
 * Used for reconciliation to detect gaps between file logs and DB logs.
 * Returns null if the table is empty.
 */
export function getMaxTimestamp(): string | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT MAX(timestamp) as max_ts FROM log_entries`,
  ).get() as { max_ts: string | null };

  return row.max_ts;
}
