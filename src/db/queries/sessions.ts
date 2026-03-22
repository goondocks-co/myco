/**
 * Session CRUD query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
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

/** Row shape returned from session queries (all columns, no embedding). */
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
// Column list (excludes embedding — not useful in CRUD results)
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
  'created_at',
] as const;

const SELECT_COLUMNS = SESSION_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a PGlite result row into a typed SessionRow.
 *
 * PGlite returns rows with column names as-is; the quoted "user" column
 * comes back as `user` in the result object.
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
export async function upsertSession(data: SessionInsert): Promise<SessionRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO sessions (
       id, agent, "user", project_root, branch,
       started_at, ended_at, status, prompt_count, tool_count,
       title, summary, transcript_path,
       parent_session_id, parent_session_reason,
       processed, content_hash, created_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, $13,
       $14, $15,
       $16, $17, $18
     )
     ON CONFLICT (id) DO UPDATE SET
       agent                 = EXCLUDED.agent,
       "user"                = EXCLUDED."user",
       project_root          = EXCLUDED.project_root,
       branch                = EXCLUDED.branch,
       started_at            = EXCLUDED.started_at,
       ended_at              = EXCLUDED.ended_at,
       status                = COALESCE(EXCLUDED.status, sessions.status),
       prompt_count          = COALESCE(EXCLUDED.prompt_count, sessions.prompt_count),
       tool_count            = COALESCE(EXCLUDED.tool_count, sessions.tool_count),
       title                 = EXCLUDED.title,
       summary               = EXCLUDED.summary,
       transcript_path       = EXCLUDED.transcript_path,
       parent_session_id     = EXCLUDED.parent_session_id,
       parent_session_reason = EXCLUDED.parent_session_reason,
       processed             = COALESCE(EXCLUDED.processed, sessions.processed),
       content_hash          = EXCLUDED.content_hash
     RETURNING ${SELECT_COLUMNS}`,
    [
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
    ],
  );

  return toSessionRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Retrieve a single session by id.
 *
 * @returns the session row, or null if not found.
 */
export async function getSession(id: string): Promise<SessionRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM sessions WHERE id = $1`,
    [id],
  );

  if (result.rows.length === 0) return null;
  return toSessionRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List sessions with optional filters, ordered by created_at DESC.
 */
export async function listSessions(
  options: ListSessionsOptions = {},
): Promise<SessionRow[]> {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.status !== undefined) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(options.status);
  }

  if (options.agent !== undefined) {
    conditions.push(`agent = $${paramIndex++}`);
    params.push(options.agent);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  params.push(limit);

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM sessions
     ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIndex}`,
    params,
  );

  return (result.rows as Record<string, unknown>[]).map(toSessionRow);
}

/**
 * Update specific fields on an existing session.
 *
 * @returns the updated row, or null if the session does not exist.
 */
export async function updateSession(
  id: string,
  updates: SessionUpdate,
): Promise<SessionRow | null> {
  const db = getDatabase();

  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

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
      setClauses.push(`${column} = $${paramIndex++}`);
      params.push((updates as Record<string, unknown>)[key] ?? null);
    }
  }

  if (setClauses.length === 0) return getSession(id);

  params.push(id);

  const result = await db.query(
    `UPDATE sessions
     SET ${setClauses.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING ${SELECT_COLUMNS}`,
    params,
  );

  if (result.rows.length === 0) return null;
  return toSessionRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Close a session — set status to 'completed' and record the end time.
 *
 * @returns the updated row, or null if the session does not exist.
 */
export async function closeSession(
  id: string,
  endedAt: number,
): Promise<SessionRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `UPDATE sessions
     SET status = $1, ended_at = $2
     WHERE id = $3
     RETURNING ${SELECT_COLUMNS}`,
    [STATUS_COMPLETED, endedAt, id],
  );

  if (result.rows.length === 0) return null;
  return toSessionRow(result.rows[0] as Record<string, unknown>);
}
