/**
 * Prompt batch CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { getTeamMachineId } from '@myco/daemon/team-context.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of unprocessed batches returned when no limit given. */
const DEFAULT_UNPROCESSED_LIMIT = 100;

/** Default number of batches returned by listBatchesBySession when no limit given. */
export const BATCHES_DEFAULT_LIMIT = 200;

/** Batch status value when a batch is closed normally. */
const STATUS_COMPLETED = 'completed';

/** Default batch status for new batches. */
const DEFAULT_STATUS = 'active';

/** Default activity count for new batches. */
const DEFAULT_ACTIVITY_COUNT = 0;

/** Default processed flag for new batches. */
const DEFAULT_PROCESSED = 0;

/** Processed flag value indicating a batch has been processed. */
const PROCESSED_FLAG = 1;

/**
 * Number of characters used for prompt prefix matching. Shared across any
 * code path that aligns captured batches against transcript events
 * (reconcile, attachment linking, repair).
 */
export const PROMPT_PREFIX_MATCH_CHARS = 60;

/**
 * Discriminated vocabulary for `prompt_batches.kind`. The schema stores the
 * raw string; using these constants + the `BatchKind` union keeps a typo from
 * becoming an unknown kind silently.
 */
export const BATCH_KIND = {
  INITIAL: 'initial',
  STEERING: 'steering',
  INTERRUPT: 'interrupt',
} as const;

export type BatchKind = typeof BATCH_KIND[keyof typeof BATCH_KIND];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Filter options for `listBatchesBySession`. */
export interface ListBatchesBySessionOptions {
  limit?: number;
  offset?: number;
}

/** Fields required (or optional) when inserting a prompt batch. */
export interface BatchInsert {
  session_id: string;
  created_at: number;
  prompt_number?: number | null;
  user_prompt?: string | null;
  response_summary?: string | null;
  classification?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  status?: string;
  activity_count?: number;
  processed?: number;
  content_hash?: string | null;
  machine_id?: string;
}

/** Row shape returned from batch queries. */
export interface BatchRow {
  id: number;
  session_id: string;
  parent_prompt_batch_id: number | null;
  kind: string;
  prompt_number: number | null;
  user_prompt: string | null;
  response_summary: string | null;
  classification: string | null;
  started_at: number | null;
  ended_at: number | null;
  status: string;
  activity_count: number;
  processed: number;
  content_hash: string | null;
  created_at: number;
  machine_id: string;
  synced_at: number | null;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const BATCH_COLUMNS = [
  'id',
  'session_id',
  'parent_prompt_batch_id',
  'kind',
  'prompt_number',
  'user_prompt',
  'response_summary',
  'classification',
  'started_at',
  'ended_at',
  'status',
  'activity_count',
  'processed',
  'content_hash',
  'created_at',
  'machine_id',
  'synced_at',
] as const;

const SELECT_COLUMNS = BATCH_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed BatchRow. */
function toBatchRow(row: Record<string, unknown>): BatchRow {
  return {
    id: row.id as number,
    session_id: row.session_id as string,
    parent_prompt_batch_id: row.parent_prompt_batch_id as number | null,
    kind: (row.kind as string) ?? 'initial',
    prompt_number: (row.prompt_number as number) ?? null,
    user_prompt: (row.user_prompt as string) ?? null,
    response_summary: (row.response_summary as string) ?? null,
    classification: (row.classification as string) ?? null,
    started_at: (row.started_at as number) ?? null,
    ended_at: (row.ended_at as number) ?? null,
    status: row.status as string,
    activity_count: row.activity_count as number,
    processed: row.processed as number,
    content_hash: (row.content_hash as string) ?? null,
    created_at: row.created_at as number,
    machine_id: (row.machine_id as string) ?? 'local',
    synced_at: (row.synced_at as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new prompt batch.
 *
 * The `id` is auto-generated by the INTEGER PRIMARY KEY (AUTOINCREMENT).
 * FTS5 index is kept in sync automatically via database triggers.
 */
export function insertBatch(data: BatchInsert): BatchRow {
  const db = getDatabase();

  const info = db.prepare(
    `INSERT INTO prompt_batches (
       session_id, prompt_number, user_prompt, response_summary,
       classification, started_at, ended_at, status,
       activity_count, processed, content_hash, created_at, machine_id
     ) VALUES (
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?
     )`,
  ).run(
    data.session_id,
    data.prompt_number ?? null,
    data.user_prompt ?? null,
    data.response_summary ?? null,
    data.classification ?? null,
    data.started_at ?? null,
    data.ended_at ?? null,
    data.status ?? DEFAULT_STATUS,
    data.activity_count ?? DEFAULT_ACTIVITY_COUNT,
    data.processed ?? DEFAULT_PROCESSED,
    data.content_hash ?? null,
    data.created_at,
    data.machine_id ?? getTeamMachineId(),
  );

  const batchId = Number(info.lastInsertRowid);

  const row = toBatchRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM prompt_batches WHERE id = ?`).get(batchId) as Record<string, unknown>,
  );

  syncRow('prompt_batches', row);

  return row;
}

/**
 * Close a batch — set status to 'completed' and record the end time.
 *
 * @returns the updated row, or null if the batch does not exist.
 */
export function closeBatch(
  id: number,
  endedAt: number,
): BatchRow | null {
  const db = getDatabase();

  const info = db.prepare(
    `UPDATE prompt_batches
     SET status = ?, ended_at = ?
     WHERE id = ?`,
  ).run(STATUS_COMPLETED, endedAt, id);

  if (info.changes === 0) return null;

  return toBatchRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM prompt_batches WHERE id = ?`).get(id) as Record<string, unknown>,
  );
}

/**
 * Populate response_summary on batches by matching transcript turns to
 * batches by prompt-text prefix. Robust to transcripts that don't start at
 * Myco's batch 1 (Cursor rewrites its transcript per conversation, not per
 * session) and to daemon-restart prompt_number resets. Only fills batches
 * whose response_summary is still NULL.
 */
export function populateBatchResponses(
  sessionId: string,
  turns: Array<{ prompt: string; response: string }>,
): void {
  const db = getDatabase();
  const batches = db.prepare(
    `SELECT id, user_prompt, response_summary
       FROM prompt_batches
      WHERE session_id = ?
      ORDER BY id ASC`,
  ).all(sessionId) as Array<{ id: number; user_prompt: string | null; response_summary: string | null }>;

  const prefixOf = (s: string | null | undefined) =>
    (s ?? '').trim().slice(0, PROMPT_PREFIX_MATCH_CHARS);

  const available = batches
    .filter((b) => b.response_summary == null)
    .map((b) => ({ id: b.id, key: prefixOf(b.user_prompt) }));

  const update = db.prepare(
    `UPDATE prompt_batches SET response_summary = ? WHERE id = ? AND response_summary IS NULL`,
  );

  for (const { prompt, response } of turns) {
    const key = prefixOf(prompt);
    if (!key) continue;
    const idx = available.findIndex((b) => b.key === key);
    if (idx === -1) continue;
    update.run(response, available[idx].id);
    available.splice(idx, 1);
  }
}

/**
 * Get unprocessed batches, ordered by id ASC (insertion order).
 *
 * Supports cursor-based pagination via `after_id` and a `limit` cap.
 *
 * When `includeActive` is explicitly `false`, batches from sessions still
 * in `status = 'active'` are excluded — intelligence tasks opt in to this
 * so they don't reason over in-flight work. The default is permissive to
 * preserve behavior for tests and any non-agent caller.
 */
export function getUnprocessedBatches(
  options: { after_id?: number; limit?: number; includeActive?: boolean } = {},
): BatchRow[] {
  const db = getDatabase();

  const conditions: string[] = [`processed = ?`];
  const params: unknown[] = [DEFAULT_PROCESSED];

  if (options.after_id !== undefined) {
    conditions.push(`id > ?`);
    params.push(options.after_id);
  }

  if (options.includeActive === false) {
    conditions.push(
      `EXISTS (SELECT 1 FROM sessions s WHERE s.id = prompt_batches.session_id AND s.status != 'active')`,
    );
  }

  const limit = options.limit ?? DEFAULT_UNPROCESSED_LIMIT;
  params.push(limit);

  const where = conditions.join(' AND ');

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM prompt_batches
     WHERE ${where}
     ORDER BY id ASC
     LIMIT ?`,
  ).all(...params) as Record<string, unknown>[];

  return rows.map(toBatchRow);
}

/**
 * Count unprocessed batches from settled (non-active) sessions. Mirrors
 * the boolean has-unprocessed-batches predicate used by vault-evolve's
 * scheduler precondition — both must answer the same question. Owned by
 * the batches/sessions domain so the scheduler doesn't have to reason
 * about prompt_batches schema.
 */
export function countUnprocessedSettledBatches(): number {
  const row = getDatabase().prepare(
    `SELECT COUNT(*) AS n FROM prompt_batches pb
     WHERE pb.processed = 0
       AND EXISTS (
         SELECT 1 FROM sessions s
         WHERE s.id = pb.session_id AND s.status != 'active'
       )`,
  ).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Increment the activity_count for a batch by 1.
 *
 * @returns the updated row, or null if the batch does not exist.
 */
export function incrementActivityCount(
  id: number,
): BatchRow | null {
  const db = getDatabase();

  const info = db.prepare(
    `UPDATE prompt_batches
     SET activity_count = activity_count + 1
     WHERE id = ?`,
  ).run(id);

  if (info.changes === 0) return null;

  return toBatchRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM prompt_batches WHERE id = ?`).get(id) as Record<string, unknown>,
  );
}

/**
 * Mark a batch as processed (processed = 1).
 *
 * @returns the updated row, or null if the batch does not exist.
 */
export function markBatchProcessed(
  id: number,
): BatchRow | null {
  const db = getDatabase();

  const info = db.prepare(
    `UPDATE prompt_batches
     SET processed = ?
     WHERE id = ?`,
  ).run(PROCESSED_FLAG, id);

  if (info.changes === 0) return null;

  return toBatchRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM prompt_batches WHERE id = ?`).get(id) as Record<string, unknown>,
  );
}

/**
 * Fetch a single batch by id. Returns null if not found.
 */
export function getBatchById(id: number): BatchRow | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM prompt_batches WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? toBatchRow(row) : null;
}

/**
 * Get a batch's ID by session and prompt number.
 * Used to link attachments to their prompt batch at stop time.
 */
export function getBatchIdByPromptNumber(
  sessionId: string,
  promptNumber: number,
): number | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT id FROM prompt_batches WHERE session_id = ? AND prompt_number = ? LIMIT 1`,
  ).get(sessionId, promptNumber) as { id: number } | undefined;

  return row ? row.id : null;
}

/**
 * Find a batch by matching the start of its user_prompt text.
 * Used for attachment matching after transcript compaction where turn indices no longer
 * align with prompt_numbers.
 */
export function findBatchByPromptPrefix(
  sessionId: string,
  promptPrefix: string,
): { id: number; prompt_number: number } | null {
  const db = getDatabase();
  // Match first N chars — enough to be unique, tolerant of minor differences
  const prefix = promptPrefix.slice(0, PROMPT_PREFIX_MATCH_CHARS);
  const row = db.prepare(
    `SELECT id, prompt_number FROM prompt_batches
     WHERE session_id = ? AND user_prompt LIKE ? || '%'
     LIMIT 1`,
  ).get(sessionId, prefix) as { id: number; prompt_number: number } | undefined;
  return row ?? null;
}

/** Fields required when inserting a batch statelessly (prompt_number derived from DB). */
export interface StatelessBatchInsert {
  session_id: string;
  created_at: number;
  user_prompt?: string | null;
  started_at?: number | null;
  status?: string;
  machine_id?: string;
  kind?: string;                            // defaults to 'initial'
  parent_prompt_batch_id?: number | null;   // defaults to null
}

/**
 * Insert a new prompt batch with prompt_number derived from an inline subquery.
 *
 * The prompt_number is set to `COALESCE(MAX(prompt_number), 0) + 1` for the
 * session, so the caller never needs a separate SELECT. This makes the insert
 * stateless — no in-memory counter required.
 *
 * FTS5 index is kept in sync automatically via database triggers.
 */
export function insertBatchStateless(data: StatelessBatchInsert): BatchRow {
  const db = getDatabase();

  const info = db.prepare(
    `INSERT INTO prompt_batches (
       session_id, parent_prompt_batch_id, kind,
       prompt_number, user_prompt, response_summary,
       classification, started_at, ended_at, status,
       activity_count, processed, content_hash, created_at, machine_id
     ) VALUES (
       ?, ?, ?,
       (SELECT COALESCE(MAX(prompt_number), 0) + 1 FROM prompt_batches WHERE session_id = ?),
       ?, NULL,
       NULL, ?, NULL, ?,
       ?, ?, NULL, ?, ?
     )`,
  ).run(
    data.session_id,
    data.parent_prompt_batch_id ?? null,
    data.kind ?? 'initial',
    data.session_id,
    data.user_prompt ?? null,
    data.started_at ?? null,
    data.status ?? DEFAULT_STATUS,
    DEFAULT_ACTIVITY_COUNT,
    DEFAULT_PROCESSED,
    data.created_at,
    data.machine_id ?? getTeamMachineId(),
  );

  const batchId = Number(info.lastInsertRowid);

  return toBatchRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM prompt_batches WHERE id = ?`).get(batchId) as Record<string, unknown>,
  );
}

/**
 * Close all open batches for a session — blind UPDATE, no prior SELECT needed.
 *
 * Sets `status = 'completed'` and `ended_at` on every batch that has no
 * `ended_at` value yet. Returns the number of batches closed.
 */
export function closeOpenBatches(
  sessionId: string,
  endedAt: number,
): number {
  const db = getDatabase();

  const info = db.prepare(
    `UPDATE prompt_batches
     SET status = ?, ended_at = ?
     WHERE session_id = ? AND ended_at IS NULL`,
  ).run(STATUS_COMPLETED, endedAt, sessionId);

  return info.changes;
}

/**
 * Set response_summary on a batch if it doesn't already have one.
 *
 * Idempotent — only updates NULL response_summary.
 */
export function setResponseSummary(
  batchId: number,
  summary: string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE prompt_batches SET response_summary = ? WHERE id = ? AND response_summary IS NULL`,
  ).run(summary, batchId);
}

/**
 * Get the most recent batch for a session in transcript order, regardless
 * of status. Orders by `prompt_number DESC` with `id DESC` as the tie-
 * breaker — this matters when the Stop-time reconciler inserts recovered
 * prompts that end up with high ids but earlier prompt_numbers, because
 * the summary for the current turn belongs on the last transcript-order
 * batch, not the last-inserted one.
 */
export function getLatestBatch(
  sessionId: string,
): BatchRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM prompt_batches
     WHERE session_id = ?
     ORDER BY prompt_number DESC, id DESC LIMIT 1`,
  ).get(sessionId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toBatchRow(row);
}

/**
 * Get the most recent active batch for a session (by id DESC).
 */
export function getLatestOpenBatch(
  sessionId: string,
): BatchRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM prompt_batches
     WHERE session_id = ? AND status = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(sessionId, DEFAULT_STATUS) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toBatchRow(row);
}

export function listBatchesBySession(
  sessionId: string,
  options: ListBatchesBySessionOptions = {},
): BatchRow[] {
  const db = getDatabase();

  const limit = options.limit ?? BATCHES_DEFAULT_LIMIT;
  const offset = options.offset ?? 0;

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM prompt_batches
     WHERE session_id = ?
     ORDER BY prompt_number ASC
     LIMIT ?
     OFFSET ?`,
  ).all(sessionId, limit, offset) as Record<string, unknown>[];

  return rows.map(toBatchRow);
}

/**
 * Update the kind and parent_prompt_batch_id of an existing batch.
 * Used by the transcript miner to reconcile batch kinds post-turn.
 */
export function updateBatchKind(
  batchId: number,
  kind: string,
  parentPromptBatchId: number | null,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE prompt_batches
     SET kind = ?, parent_prompt_batch_id = ?
     WHERE id = ?`,
  ).run(kind, parentPromptBatchId, batchId);
}

/**
 * Set an explicit prompt_number on an existing batch.
 *
 * Used by the transcript-miner reconciler to renumber batches after inserting
 * recovered prompts — `insertBatchStateless` assigns MAX+1, so a prompt that
 * should land between two existing rows needs its number fixed up afterward.
 */
export function setBatchPromptNumber(batchId: number, promptNumber: number): void {
  const db = getDatabase();
  db.prepare(`UPDATE prompt_batches SET prompt_number = ? WHERE id = ?`).run(promptNumber, batchId);
}

/**
 * Return the most recently opened parent (kind='initial') batch for a session
 * whose turn has not yet completed (ended_at IS NULL). Returns null if none.
 *
 * Used by handleUserPrompt to decide whether an incoming prompt should be
 * nested as a child or start a new parent.
 */
export function findOpenParentBatch(sessionId: string): BatchRow | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM prompt_batches
     WHERE session_id = ? AND ended_at IS NULL AND kind = 'initial'
     ORDER BY id DESC LIMIT 1`,
  ).get(sessionId) as Record<string, unknown> | undefined;
  return row ? toBatchRow(row) : null;
}

/**
 * Count prompt batches for a session — authoritative prompt count.
 */
export function countBatchesBySession(sessionId: string): number {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM prompt_batches WHERE session_id = ?`,
  ).get(sessionId) as { count: number };
  return row.count;
}
