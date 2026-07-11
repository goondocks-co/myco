/**
 * Session CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase, changesSince, type Database } from '@myco/db/client.js';
import { getTeamMachineId } from '@myco/team/context.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';
import { closeOpenBatches } from '@myco/db/queries/batches.js';
import { insertSessionTombstone, type SessionTombstoneSource } from '@myco/db/queries/session-tombstones.js';
import { appendProjectCondition, projectScopeClause, type ProjectScope } from '@myco/db/queries/project-scope.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of sessions returned by listSessions when no limit given. */
const DEFAULT_LIST_LIMIT = 100;

/** Session status value when a session is closed normally. */
export const STATUS_COMPLETED = 'completed';

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
  project_id?: string | null;
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
  machine_id?: string;
}

/** Row shape returned from session queries (all columns). */
export interface SessionRow {
  id: string;
  project_id: string | null;
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
  machine_id: string;
  synced_at: number | null;
  canopy_injections_offered: number | null;
  canopy_injection_total_tokens: number | null;
  canopy_skips_after_injection: number | null;
  canopy_reads_after_injection: number | null;
  canopy_tokens_saved: number | null;
  canopy_redundant_reads: number | null;
  canopy_map_tool_calls: number;
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
  scope: ProjectScope;
  limit?: number;
  offset?: number;
  status?: string;
  agent?: string;
  search?: string;
  /** Filter to sessions that ran on this git branch. */
  branch?: string;
  /** Filter to sessions authored by this user. */
  user?: string;
  /** Filter to this exact session id (used for plan→session resolution). */
  id?: string;
  /** Only return sessions created after this epoch-seconds timestamp. */
  since?: number;
  /**
   * When explicitly `false` and no `status` filter is set, exclude sessions
   * still in `status = 'active'` — intelligence-task reads opt in to this.
   * Defaults permissive so UI listings keep showing in-flight sessions.
   */
  includeActive?: boolean;
  /**
   * When true, restrict to sessions that produced at least one plan
   * (EXISTS join against `plans.session_id`). The Symbionts page uses
   * this to scope its "Plans" capability deep-link.
   */
  hasPlan?: boolean;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = [
  'id',
  'project_id',
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
  'machine_id',
  'synced_at',
  'canopy_injections_offered',
  'canopy_injection_total_tokens',
  'canopy_skips_after_injection',
  'canopy_reads_after_injection',
  'canopy_tokens_saved',
  'canopy_redundant_reads',
  'canopy_map_tool_calls',
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
    project_id: (row.project_id as string) ?? null,
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
    machine_id: (row.machine_id as string) ?? 'local',
    synced_at: (row.synced_at as number) ?? null,
    canopy_injections_offered: (row.canopy_injections_offered as number) ?? null,
    canopy_injection_total_tokens: (row.canopy_injection_total_tokens as number) ?? null,
    canopy_skips_after_injection: (row.canopy_skips_after_injection as number) ?? null,
    canopy_reads_after_injection: (row.canopy_reads_after_injection as number) ?? null,
    canopy_tokens_saved: (row.canopy_tokens_saved as number) ?? null,
    canopy_redundant_reads: (row.canopy_redundant_reads as number) ?? null,
    canopy_map_tool_calls: (row.canopy_map_tool_calls as number) ?? 0,
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
       id, project_id, agent, "user", project_root, branch,
       started_at, ended_at, status, prompt_count, tool_count,
       title, summary, transcript_path,
       parent_session_id, parent_session_reason,
       processed, content_hash, created_at, machine_id
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?,
       ?, ?, ?, ?
     )
     ON CONFLICT (id) DO UPDATE SET
       project_id            = COALESCE(EXCLUDED.project_id, sessions.project_id),
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
    data.project_id ?? null,
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
    data.machine_id ?? getTeamMachineId(),
    data.prompt_count !== undefined ? 1 : 0,
    data.tool_count !== undefined ? 1 : 0,
  );

  const row = toSessionRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM sessions WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );

  syncRow('sessions', row);

  return row;
}

/**
 * Retrieve a single session by id.
 *
 * @returns the session row, or null if not found.
 */
export function getSession(id: string, scopeArg: ProjectScope): SessionRow | null {
  const db = getDatabase();
  const scope = projectScopeClause(scopeArg);
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM sessions WHERE id = ?${scope.sql}`,
  ).get(id, ...scope.params) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toSessionRow(row);
}

/** Build WHERE clause and bound params from session filter options. */
function buildSessionsWhere(
  options: Omit<ListSessionsOptions, 'limit' | 'offset'>,
): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.status !== undefined) {
    conditions.push(`status = ?`);
    params.push(options.status);
  }

  appendProjectCondition(conditions, params, options.scope);

  if (options.agent !== undefined) {
    conditions.push(`agent = ?`);
    params.push(options.agent);
  }

  if (options.branch !== undefined) {
    conditions.push(`branch = ?`);
    params.push(options.branch);
  }

  if (options.user !== undefined) {
    conditions.push(`"user" = ?`);
    params.push(options.user);
  }

  if (options.id !== undefined) {
    conditions.push(`id = ?`);
    params.push(options.id);
  }

  if (options.search !== undefined && options.search.length > 0) {
    conditions.push(`(title LIKE ? OR id LIKE ?)`);
    const pattern = `%${options.search}%`;
    params.push(pattern, pattern);
  }
  if (options.since !== undefined) {
    conditions.push('created_at > ?');
    params.push(options.since);
  }

  // Exclude active sessions only when the caller explicitly opts in and
  // hasn't already constrained `status`. Intelligence-task reads set this
  // to avoid picking up in-flight work; UI/CLI leave it unset.
  if (options.includeActive === false && options.status === undefined) {
    conditions.push(`status != 'active'`);
  }

  if (options.hasPlan === true) {
    conditions.push(`EXISTS (SELECT 1 FROM plans p WHERE p.session_id = sessions.id)`);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * List sessions with optional filters, ordered by created_at DESC.
 */
export function listSessions(
  options: ListSessionsOptions,
): SessionRow[] {
  const db = getDatabase();
  const { where, params } = buildSessionsWhere(options);
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const offset = options.offset ?? 0;

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM sessions
     ${where}
     ORDER BY created_at DESC
     LIMIT ?
     OFFSET ?`,
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(toSessionRow);
}

/**
 * Count sessions matching optional filters (for pagination totals).
 */
export function countSessions(
  options: Omit<ListSessionsOptions, 'limit' | 'offset'>,
): number {
  const db = getDatabase();
  const { where, params } = buildSessionsWhere(options);

  const row = db.prepare(
    `SELECT COUNT(*) as count FROM sessions ${where}`,
  ).get(...params) as { count: number };

  return row.count;
}

/**
 * Return the set of session IDs currently in `status = 'active'`.
 *
 * Used by the semantic-search path, which can't apply a SQL join against
 * session status (the vector store is a separate concern), so it filters
 * results in-memory against this set instead. Bounded by the number of
 * concurrent in-flight sessions — typically small.
 */
export function getActiveSessionIds(scope: ProjectScope): Set<string>;
export function getActiveSessionIds(scope: ProjectScope, db: Database): Set<string>;
export function getActiveSessionIds(
  scopeArg: ProjectScope,
  db: Database = getDatabase(),
): Set<string> {
  const scope = projectScopeClause(scopeArg);
  const rows = db.prepare(
    `SELECT id FROM sessions WHERE status = 'active'${scope.sql}`,
  ).all(...scope.params) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * Flip a session back to `status = 'active'` if it's currently `'completed'`.
 *
 * Called on live user activity (`user_prompt` events) so a session that was
 * auto-completed by the stale sweep or manually completed via the API snaps
 * back to active transparently when the user resumes. No-op for sessions
 * that are already active or don't exist.
 *
 * The `ended_at` column is intentionally preserved — it records the most
 * recent completion time, and the next completion will overwrite it.
 *
 * @returns true if a row was updated (session was completed and is now active)
 */
export function reactivateSessionIfCompleted(id: string, scopeArg: ProjectScope): boolean {
  const db = getDatabase();
  const scope = projectScopeClause(scopeArg);
  const info = db.prepare(
    `UPDATE sessions SET status = 'active' WHERE id = ? AND status = 'completed'${scope.sql}`,
  ).run(id, ...scope.params);
  if (info.changes === 0) return false;

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM sessions WHERE id = ?${scope.sql}`,
  ).get(id, ...scope.params) as Record<string, unknown> | undefined;
  if (row) syncRow('sessions', toSessionRow(row));

  return true;
}

/**
 * Update specific fields on an existing session.
 *
 * @returns the updated row, or null if the session does not exist.
 */
export function updateSession(
  id: string,
  updates: SessionUpdate,
  scopeArg: ProjectScope,
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

  if (setClauses.length === 0) return getSession(id, scopeArg);

  params.push(id);
  const scope = projectScopeClause(scopeArg);
  params.push(...scope.params);

  db.prepare(
    `UPDATE sessions
     SET ${setClauses.join(', ')}
     WHERE id = ?${scope.sql}`,
  ).run(...params);

  const updated = getSession(id, scopeArg);

  if (updated) syncRow('sessions', updated);

  return updated;
}

/**
 * Close a session — set status to 'completed', record the end time, and close
 * any still-open prompt batches.
 *
 * This is the RAW DB WRITE, not the daemon's completion chokepoint. Daemon
 * paths that complete a session (SessionEnd, the manual API, the stale-session
 * sweep) must route through `completeSessionWithMining`
 * (`daemon/session-completion.ts`), which runs the final transcript-mining
 * convergence BEFORE calling here — the invariant the Team Host
 * routed-transcript cache GC relies on ("completed implies mined") lives in
 * that wrapper, not in this function. Calling this directly is only correct
 * where no transcript source can exist or mining is handled by the caller.
 *
 * The batch close IS structural here: without it, a session ended without a
 * final Stop (e.g. a plan-mode→execution run that never returned end_turn)
 * keeps its last turn open indefinitely.
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

  closeOpenBatches(id, endedAt);

  const closed = getSession(id, { kind: 'all' });

  if (closed) syncRow('sessions', closed);

  return closed;
}

// ---------------------------------------------------------------------------
// Cascade delete + impact query
// ---------------------------------------------------------------------------

/** Counts of related data that would be affected by a session delete. */
export interface SessionImpact {
  promptCount: number;
  sporeCount: number;
  attachmentCount: number;
  graphEdgeCount: number;
}

/** Result of a cascade delete operation. */
export interface DeleteCascadeResult {
  deleted: boolean;
  counts: {
    prompts: number;
    spores: number;
    attachments: number;
    graphEdges: number;
    resolutionEvents: number;
  };
  /** Spore IDs that were deleted (needed for vault file + vector cleanup). */
  deletedSporeIds: string[];
  /** Attachment file paths that were deleted from DB (needed for disk cleanup). */
  deletedAttachmentPaths: string[];
  /**
   * Project id of the deleted session, captured before the row was removed.
   * Multi-Grove session-maintenance uses this to look up the registered
   * project's vault dir and clean up the right project's session/spore
   * markdown files; null when the session row was not found.
   */
  projectId: string | null;
}

/**
 * Get counts of all data related to a session, for pre-delete impact display.
 */
export function getSessionImpact(sessionId: string): SessionImpact {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM prompt_batches WHERE session_id = ?) AS promptCount,
       (SELECT COUNT(*) FROM spores WHERE session_id = ?) AS sporeCount,
       (SELECT COUNT(*) FROM attachments WHERE session_id = ?) AS attachmentCount,
       (SELECT COUNT(*) FROM graph_edges WHERE session_id = ?) AS graphEdgeCount`,
  ).get(sessionId, sessionId, sessionId, sessionId) as SessionImpact;

  return row;
}

/**
 * Delete a session and ALL related data in a single transaction.
 *
 * This is the ONLY session deletion path — every deletion writes a
 * `session_tombstones` row inside the same transaction so the buffer
 * reconciler refuses to resurrect the session from a lingering buffer
 * file. `source` records which deletion path fired (user delete,
 * maintenance sweep, invalid-capture cleanup).
 *
 * Returns counts of deleted rows and IDs needed for post-transaction
 * cleanup (vault files, embedding vectors).
 */
export function deleteSessionCascade(
  sessionId: string,
  source: SessionTombstoneSource,
): DeleteCascadeResult {
  const db = getDatabase();

  const zeroCounts: DeleteCascadeResult = {
    deleted: false,
    counts: { prompts: 0, spores: 0, attachments: 0, graphEdges: 0, resolutionEvents: 0 },
    deletedSporeIds: [],
    deletedAttachmentPaths: [],
    projectId: null,
  };

  // Capture project_id and existence in one round-trip; we need it for
  // post-transaction vault cleanup since the row will be gone by then.
  const sessionRow = db.prepare(
    `SELECT project_id FROM sessions WHERE id = ?`,
  ).get(sessionId) as { project_id: string | null } | undefined;
  if (!sessionRow) return zeroCounts;
  const projectId = sessionRow.project_id;

  // Collect IDs/paths needed for post-transaction cleanup before deleting.
  // Spores can reference prompt_batches from a different session (cross-session
  // spore linkage), so we must also collect spores linked via prompt_batch_id.
  const sporeIds = (db.prepare(
    `SELECT id FROM spores
     WHERE session_id = ?
        OR prompt_batch_id IN (SELECT id FROM prompt_batches WHERE session_id = ?)`,
  ).all(sessionId, sessionId) as { id: string }[]).map((r) => r.id);

  const attachmentPaths = (db.prepare(
    `SELECT file_path FROM attachments WHERE session_id = ?`,
  ).all(sessionId) as { file_path: string }[]).map((r) => r.file_path);

  // Run all deletes in a single transaction.
  //
  // Order matters — foreign_keys = ON is set in client.ts, so every DELETE
  // is checked immediately. Child rows must be removed before their parents:
  //   - spores.prompt_batch_id     → prompt_batches(id)   [spores BEFORE prompt_batches]
  //   - plans.prompt_batch_id      → prompt_batches(id)   [plans BEFORE prompt_batches]
  //   - knowledge_* provenance     → sessions/prompt_batches(id)
  //   - resolution_events.spore_id → spores(id)           [resolution_events BEFORE spores]
  //   - skill_usage.session_id     → sessions(id) NOT NULL
  //   - plans.session_id           → sessions(id)
  // resolution_events can reference spores across sessions (e.g. a later
  // session supersedes an earlier session's spore), so we match by either
  // session_id OR spore_id-in-this-session to catch cross-session references.
  //
  // Spores can also reference prompt_batches from a different session
  // (cross-session prompt_batch_id linkage). We must delete those spores
  // BEFORE deleting prompt_batches to avoid FK violations.
  //
  // Counting: each `changesSince(db)` below reads the just-run DELETE's own
  // affected-row count. The AFTER DELETE team-sync triggers (and the FTS
  // triggers) insert into team_outbox / *_fts inside the same statement, but
  // those writes are excluded from `changes()`, so the per-table counts stay
  // accurate — they reflect only the rows removed from the named table.
  const result = db.transaction(() => {
    db.prepare(
      `DELETE FROM knowledge_release_state
       WHERE source_session_id = ?
          OR source_prompt_batch_id IN (SELECT id FROM prompt_batches WHERE session_id = ?)`,
    ).run(sessionId, sessionId);
    db.prepare(
      `DELETE FROM knowledge_git_provenance
       WHERE session_id = ?
          OR prompt_batch_id IN (SELECT id FROM prompt_batches WHERE session_id = ?)`,
    ).run(sessionId, sessionId);
    db.prepare(`DELETE FROM activities WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM attachments WHERE session_id = ?`).run(sessionId);
    const attachments = changesSince(db);
    db.prepare(`DELETE FROM plans WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM skill_usage WHERE session_id = ?`).run(sessionId);
    db.prepare(
      `DELETE FROM resolution_events
       WHERE session_id = ?
          OR spore_id IN (
            SELECT id FROM spores
            WHERE session_id = ?
               OR prompt_batch_id IN (SELECT id FROM prompt_batches WHERE session_id = ?)
          )`,
    ).run(sessionId, sessionId, sessionId);
    const resEvents = changesSince(db);
    db.prepare(`DELETE FROM graph_edges WHERE session_id = ?`).run(sessionId);
    const edges = changesSince(db);
    db.prepare(
      `DELETE FROM spores
       WHERE session_id = ?
          OR prompt_batch_id IN (SELECT id FROM prompt_batches WHERE session_id = ?)`,
    ).run(sessionId, sessionId);
    const spores = changesSince(db);
    db.prepare(`DELETE FROM prompt_batches WHERE session_id = ?`).run(sessionId);
    const prompts = changesSince(db);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    const sessionDeleted = changesSince(db) > 0;

    // Tombstone inside the same transaction: a committed cascade and its
    // resurrection guard are atomic — there is no window where the row is
    // gone but the reconciler could still replay the session's buffer.
    insertSessionTombstone(db, { sessionId, projectId, source });

    return {
      deleted: sessionDeleted,
      counts: {
        prompts,
        spores,
        attachments,
        graphEdges: edges,
        resolutionEvents: resEvents,
      },
    };
  })();

  return {
    ...result,
    deletedSporeIds: sporeIds,
    deletedAttachmentPaths: attachmentPaths,
    projectId,
  };
}
