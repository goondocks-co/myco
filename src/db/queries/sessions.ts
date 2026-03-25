/**
 * Session CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of sessions returned by listSessions when no limit given. */
const DEFAULT_LIST_LIMIT = 100;

/** Session status value when a session is closed normally. */
const STATUS_COMPLETED = 'completed';

/** Default session status for new sessions. */
const DEFAULT_STATUS = 'active';

/** Default prompt count for new sessions. */
const DEFAULT_PROMPT_COUNT = 0;

/** Default tool count for new sessions. */
const DEFAULT_TOOL_COUNT = 0;

/** Default processed flag for new sessions. */
const DEFAULT_PROCESSED = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting/upserting a session. */
export interface SessionInsert {
  id: string;
  agent: string;
  started_at: number;
  created_at: number;
  user?: string | null;
  project_root?: string | null;
  branch?: string | null;
  ended_at?: number | null;
  status?: string;
  prompt_count?: number;
  tool_count?: number;
  title?: string | null;
  summary?: string | null;
  transcript_path?: string | null;
  parent_session_id?: string | null;
  parent_session_reason?: string | null;
  processed?: number;
  content_hash?: string | null;
}

/** Row shape returned from session queries (all columns). */
export interface SessionRow {
  id: string;
  agent: string;
  user: string | null;
  project_root: string | null;
  branch: string | null;
  started_at: number;
  ended_at: number | null;
  status: string;
  prompt_count: number;
  tool_count: number;
  title: string | null;
  summary: string | null;
  transcript_path: string | null;
  parent_session_id: string | null;
  parent_session_reason: string | null;
  processed: number;
  content_hash: string | null;
  embedded: number;
  created_at: number;
}

/** Updatable fields for `updateSession`. */
export interface SessionUpdate {
  agent?: string;
  user?: string | null;
  project_root?: string | null;
  branch?: string | null;
  ended_at?: number | null;
  status?: string;
  prompt_count?: number;
  tool_count?: number;
  title?: string | null;
  summary?: string | null;
  transcript_path?: string | null;
  parent_session_id?: string | null;
  parent_session_reason?: string | null;
  processed?: number;
  content_hash?: string | null;
}

/** Filter options for `listSessions`. */
export interface ListSessionsOptions {
  limit?: number;
  status?: string;
  agent?: string;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = [
  'id',
  'agent',
  '"user"',
  'project_root',
  'branch',
  'started_at',
  'ended_at',
  'status',
  'prompt_count',
  'tool_count',
  'title',
  'summary',
  'transcript_path',
  'parent_session_id',
  'parent_session_reason',
  'processed',
  'content_hash',
  'embedded',
  'created_at',
] as const;

const SELECT_COLUMNS = SESSION_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a SQLite result row into a typed SessionRow.
 *
 * The quoted "user" column comes back as `user` in the result object.
 */
function toSessionRow(row: Record<string, unknown>): SessionRow {
  return {
    id: row.id as string,
    agent: row.agent as string,
    user: (row.user as string) ?? null,
    project_root: (row.project_root as string) ?? null,
    branch: (row.branch as string) ?? null,
    started_at: row.started_at as number,
    ended_at: (row.ended_at as number) ?? null,
    status: row.status as string,
    prompt_count: row.prompt_count as number,
    tool_count: row.tool_count as number,
    title: (row.title as string) ?? null,
    summary: (row.summary as string) ?? null,
    transcript_path: (row.transcript_path as string) ?? null,
    parent_session_id: (row.parent_session_id as string) ?? null,
    parent_session_reason: (row.parent_session_reason as string) ?? null,
    processed: row.processed as number,
    content_hash: (row.content_hash as string) ?? null,
    embedded: (row.embedded as number) ?? 0,
    created_at: row.created_at as number,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a session or update it if the id already exists.
 *
 * On conflict the row is updated with the values from `data`, preserving
 * any columns not supplied via COALESCE with EXCLUDED values.
 */
export function upsertSession(data: SessionInsert): SessionRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO sessions (
       id, agent, "user", project_root, branch,
       started_at, ended_at, status, prompt_count, tool_count,
       title, summary, transcript_path,
       parent_session_id, parent_session_reason,
       processed, content_hash, created_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?,
       ?, ?, ?
     )
     ON CONFLICT (id) DO UPDATE SET
       agent                 = EXCLUDED.agent,
       "user"                = EXCLUDED."user",
       project_root          = EXCLUDED.project_root,
       branch                = EXCLUDED.branch,
       started_at            = EXCLUDED.started_at,
       ended_at              = COALESCE(EXCLUDED.ended_at, sessions.ended_at),
       status                = COALESCE(EXCLUDED.status, sessions.status),
       prompt_count          = CASE WHEN ? THEN EXCLUDED.prompt_count ELSE sessions.prompt_count END,
       tool_count            = CASE WHEN ? THEN EXCLUDED.tool_count ELSE sessions.tool_count END,
       title                 = COALESCE(EXCLUDED.title, sessions.title),
       summary               = COALESCE(EXCLUDED.summary, sessions.summary),
       transcript_path       = COALESCE(EXCLUDED.transcript_path, sessions.transcript_path),
       parent_session_id     = EXCLUDED.parent_session_id,
       parent_session_reason = EXCLUDED.parent_session_reason,
       processed             = COALESCE(EXCLUDED.processed, sessions.processed),
       content_hash          = EXCLUDED.content_hash`,
  ).run(
    data.id,
    data.agent,
    data.user ?? null,
    data.project_root ?? null,
    data.branch ?? null,
    data.started_at,
    data.ended_at ?? null,
    data.status ?? DEFAULT_STATUS,
    data.prompt_count ?? DEFAULT_PROMPT_COUNT,
    data.tool_count ?? DEFAULT_TOOL_COUNT,
    data.title ?? null,
    data.summary ?? null,
    data.transcript_path ?? null,
    data.parent_session_id ?? null,
    data.parent_session_reason ?? null,
    data.processed ?? DEFAULT_PROCESSED,
    data.content_hash ?? null,
    data.created_at,
    data.prompt_count !== undefined ? 1 : 0,
    data.tool_count !== undefined ? 1 : 0,
  );

  return toSessionRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM sessions WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );
}

/**
 * Retrieve a single session by id.
 *
 * @returns the session row, or null if not found.
 */
export function getSession(id: string): SessionRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM sessions WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toSessionRow(row);
}

/**
 * List sessions with optional filters, ordered by created_at DESC.
 */
export function listSessions(
  options: ListSessionsOptions = {},
): SessionRow[] {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.status !== undefined) {
    conditions.push(`status = ?`);
    params.push(options.status);
  }

  if (options.agent !== undefined) {
    conditions.push(`agent = ?`);
    params.push(options.agent);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  params.push(limit);

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM sessions
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(...params) as Record<string, unknown>[];

  return rows.map(toSessionRow);
}

/**
 * Update specific fields on an existing session.
 *
 * @returns the updated row, or null if the session does not exist.
 */
export function updateSession(
  id: string,
  updates: SessionUpdate,
): SessionRow | null {
  const db = getDatabase();

  const setClauses: string[] = [];
  const params: unknown[] = [];

  const fieldMap: Record<string, string> = {
    agent: 'agent',
    user: '"user"',
    project_root: 'project_root',
    branch: 'branch',
    ended_at: 'ended_at',
    status: 'status',
    prompt_count: 'prompt_count',
    tool_count: 'tool_count',
    title: 'title',
    summary: 'summary',
    transcript_path: 'transcript_path',
    parent_session_id: 'parent_session_id',
    parent_session_reason: 'parent_session_reason',
    processed: 'processed',
    content_hash: 'content_hash',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    if (key in updates) {
      setClauses.push(`${column} = ?`);
      params.push((updates as Record<string, unknown>)[key] ?? null);
    }
  }

  if (setClauses.length === 0) return getSession(id);

  params.push(id);

  db.prepare(
    `UPDATE sessions
     SET ${setClauses.join(', ')}
     WHERE id = ?`,
  ).run(...params);

  return getSession(id);
}

/**
 * Close a session — set status to 'completed' and record the end time.
 *
 * @returns the updated row, or null if the session does not exist.
 */
export function closeSession(
  id: string,
  endedAt: number,
): SessionRow | null {
  const db = getDatabase();

  db.prepare(
    `UPDATE sessions
     SET status = ?, ended_at = ?
     WHERE id = ?`,
  ).run(STATUS_COMPLETED, endedAt, id);

  return getSession(id);
}

/**
 * Delete a session and all its child rows (batches, activities, attachments).
 *
 * No ON DELETE CASCADE in the schema, so we delete children first.
 * Returns true if the session existed and was deleted.
 */
export function deleteSession(id: string): boolean {
  const db = getDatabase();

  db.prepare(`DELETE FROM activities WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM attachments WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM prompt_batches WHERE session_id = ?`).run(id);
  const info = db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);

  return info.changes > 0;
}
