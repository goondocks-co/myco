/**
 * Prompt batch CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { getTeamMachineId } from '@myco/daemon/team-context.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';
import { appendProjectCondition, type ProjectScope } from '@myco/db/queries/project-scope.js';

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
  /** Synthetic batch opened when an activity arrives without a
   *  preceding user prompt. Required for the activities FK; rendered
   *  distinctly in the UI. */
  RECOVERED: 'recovered',
} as const;

export type BatchKind = typeof BATCH_KIND[keyof typeof BATCH_KIND];

/**
 * `user_prompt` body used when `ensureOpenBatch` fabricates a synthetic
 * RECOVERED batch (session has zero batches, an activity arrived first).
 * Exported so migrations and tests can target the row precisely without
 * a string duplicate going stale.
 */
export const RECOVERED_BATCH_SENTINEL = '(implicit batch — capture recovered)';

/**
 * Discriminated vocabulary for `prompt_batches.origin`. Orthogonal to `kind`
 * — every batch has both. `kind` records WHERE the batch sits in conversation
 * flow; `origin` records WHO issued the prompt.
 *
 *   human         — user-typed in their CLI/IDE (default)
 *   system        — transcript-synthesized continuation event injected by
 *                   the agent itself (e.g. <task-notification>,
 *                   <environment_context>, <skill> envelope expansions)
 *   agent_dispatch— prompts emitted by sub-agents back to the parent
 *                   (e.g. Codex <subagent_notification>)
 *   hook_injected — reserved; UserPromptSubmit hook output is currently
 *                   appended to a real human prompt and stays 'human'
 */
export const PROMPT_BATCH_ORIGIN = {
  HUMAN: 'human',
  SYSTEM: 'system',
  AGENT_DISPATCH: 'agent_dispatch',
  HOOK_INJECTED: 'hook_injected',
} as const;

export type PromptBatchOrigin = typeof PROMPT_BATCH_ORIGIN[keyof typeof PROMPT_BATCH_ORIGIN];

/**
 * Default origin filter for intelligence tasks (vault-evolve, extract-only,
 * etc.) and their scheduler counters. Excludes harness-injected `system`
 * batches (env_context, task notifications, skill envelopes) and
 * `agent_dispatch` sub-agent return prompts — neither carries user intent
 * and reasoning over them wastes LLM turns. Callers that genuinely need
 * the broader set (e.g. title-summary, classification) opt in explicitly.
 */
export const INTELLIGENCE_DEFAULT_ORIGINS: readonly PromptBatchOrigin[] = [
  PROMPT_BATCH_ORIGIN.HUMAN,
];

const VALID_ORIGINS = new Set<string>(Object.values(PROMPT_BATCH_ORIGIN));

/**
 * Coerce an unknown row column into a valid `PromptBatchOrigin`. Any value
 * outside the union — including a NULL leaked through a misconfigured
 * COALESCE — collapses to 'human' so legacy rows remain queryable.
 */
export function toPromptBatchOrigin(value: unknown): PromptBatchOrigin {
  if (typeof value === 'string' && VALID_ORIGINS.has(value)) {
    return value as PromptBatchOrigin;
  }
  return PROMPT_BATCH_ORIGIN.HUMAN;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Filter options for `listBatchesBySession`. */
export interface ListBatchesBySessionOptions {
  limit?: number;
  offset?: number;
  scope: ProjectScope;
  /**
   * If provided, only batches whose `origin` is in this set are returned.
   * Default (omitted) returns ALL origins, preserving legacy behavior for
   * intelligence tasks and reconcile callers that need to see every batch
   * regardless of provenance.
   */
  origins?: readonly PromptBatchOrigin[];
}

/** Fields required (or optional) when inserting a prompt batch. */
export interface BatchInsert {
  session_id: string;
  project_id?: string | null;
  created_at: number;
  origin?: PromptBatchOrigin;
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
  project_id: string | null;
  parent_prompt_batch_id: number | null;
  kind: string;
  origin: PromptBatchOrigin;
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
  'project_id',
  'parent_prompt_batch_id',
  'kind',
  'origin',
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
    project_id: (row.project_id as string) ?? null,
    parent_prompt_batch_id: row.parent_prompt_batch_id as number | null,
    kind: (row.kind as string) ?? 'initial',
    origin: toPromptBatchOrigin(row.origin),
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

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO prompt_batches (
         session_id, project_id, origin, prompt_number, user_prompt, response_summary,
         classification, started_at, ended_at, status,
         activity_count, processed, content_hash, created_at, machine_id
       ) VALUES (
         ?, COALESCE(?, (SELECT project_id FROM sessions WHERE id = ?)), ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?
       )`,
    ).run(
      data.session_id,
      data.project_id ?? null,
      data.session_id,
      data.origin ?? PROMPT_BATCH_ORIGIN.HUMAN,
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

    // Atomic counter bump — same rationale as `insertBatchStateless`.
    // This function is the OTHER public writer for `prompt_batches`
    // (used by the Grove importer and tests, where the caller
    // supplies prompt_number explicitly), so it also owns the
    // cached counter the column maintains. Using `MAX(prompt_number)`
    // keeps the cache correct whether the caller inserts in order
    // or fills gaps.
    db.prepare(
      `UPDATE sessions
         SET prompt_count = (
           SELECT MAX(prompt_number) FROM prompt_batches WHERE session_id = ?
         )
         WHERE id = ?`,
    ).run(data.session_id, data.session_id);

    return batchId;
  });

  const batchId = tx();

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

  // Match every batch (not just NULL-summary ones); the transcript is the
  // authoritative source so a newer response overwrites stale data from an
  // earlier Stop in the same logical turn.
  const available = batches.map((b) => ({
    id: b.id,
    key: prefixOf(b.user_prompt),
    existing: b.response_summary,
  }));

  const update = db.prepare(
    `UPDATE prompt_batches SET response_summary = ? WHERE id = ?`,
  );

  for (const { prompt, response } of turns) {
    const key = prefixOf(prompt);
    if (!key) continue;
    const trimmed = (response ?? '').trim();
    if (!trimmed) continue;
    const idx = available.findIndex((b) => b.key === key);
    if (idx === -1) continue;
    const target = available[idx]!;
    available.splice(idx, 1);
    if (target.existing === response) continue;
    update.run(response, target.id);
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
 *
 * `origins` narrows the result to specific `prompt_batches.origin` values.
 * Intelligence tasks default to `['human']` at their call sites so they
 * don't waste LLM turns on env-context wrappers, task-notifications, and
 * other harness-injected `system` batches. Omit to leave the result
 * permissive across all origins.
 */
export function getUnprocessedBatches(
  options: {
    after_id?: number;
    limit?: number;
    includeActive?: boolean;
    origins?: readonly PromptBatchOrigin[];
    scope: ProjectScope;
  },
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

  if (options.origins && options.origins.length > 0) {
    const placeholders = options.origins.map(() => '?').join(', ');
    conditions.push(`origin IN (${placeholders})`);
    params.push(...options.origins);
  }

  appendProjectCondition(conditions, params, options.scope);

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
 *
 * `origins` narrows the count to specific `prompt_batches.origin` values.
 * Intelligence-task schedulers default to `['human']` at their call sites
 * so accelerator thresholds aren't tripped by env-context noise. Omit to
 * leave the count permissive across all origins.
 */
export function countUnprocessedSettledBatches(
  scope: ProjectScope,
  options?: { limit?: number; origins?: readonly PromptBatchOrigin[] },
): number {
  const projectConditions: string[] = [];
  const projectParams: unknown[] = [];
  appendProjectCondition(projectConditions, projectParams, scope, 'pb');

  const origins = options?.origins;
  if (origins && origins.length > 0) {
    const placeholders = origins.map(() => '?').join(', ');
    projectConditions.push(`pb.origin IN (${placeholders})`);
    projectParams.push(...origins);
  }

  const projectWhere = projectConditions.length > 0
    ? ` AND ${projectConditions.join(' AND ')}`
    : '';

  const limit = options?.limit;
  if (limit !== undefined) {
    const boundedLimit = Math.max(1, Math.floor(limit));
    const row = getDatabase().prepare(
      `SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM prompt_batches pb
        WHERE pb.processed = 0
          ${projectWhere}
          AND EXISTS (
            SELECT 1 FROM sessions s
            WHERE s.id = pb.session_id AND s.status != 'active'
          )
        LIMIT ?
      )`,
    ).get(...projectParams, boundedLimit) as { n: number } | undefined;
    return row?.n ?? 0;
  }
  const row = getDatabase().prepare(
    `SELECT COUNT(*) AS n FROM prompt_batches pb
     WHERE pb.processed = 0
       ${projectWhere}
       AND EXISTS (
         SELECT 1 FROM sessions s
         WHERE s.id = pb.session_id AND s.status != 'active'
       )`,
  ).get(...projectParams) as { n: number } | undefined;
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
  scope: ProjectScope,
): BatchRow | null {
  const db = getDatabase();

  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  appendProjectCondition(conditions, params, scope);

  const info = db.prepare(
    `UPDATE prompt_batches
     SET processed = ?
     WHERE ${conditions.join(' AND ')}`,
  ).run(PROCESSED_FLAG, ...params);

  if (info.changes === 0) return null;

  return toBatchRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM prompt_batches WHERE ${conditions.join(' AND ')}`).get(...params) as Record<string, unknown>,
  );
}

/**
 * Fetch a single batch by id. Returns null if not found.
 */
export function getBatchById(id: number, scope: ProjectScope): BatchRow | null {
  const db = getDatabase();
  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM prompt_batches WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as Record<string, unknown> | undefined;
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
  project_id?: string | null;
  created_at: number;
  user_prompt?: string | null;
  started_at?: number | null;
  status?: string;
  machine_id?: string;
  kind?: string;                            // defaults to 'initial'
  origin?: PromptBatchOrigin;               // defaults to 'human'
  parent_prompt_batch_id?: number | null;   // defaults to null
}

/**
 * Insert a new prompt batch with prompt_number derived from an inline
 * subquery AND atomically bump the owning session's cached
 * `prompt_count` to match.
 *
 * The cached counter on `sessions.prompt_count` exists because several
 * MCP / CLI read paths and the Grove importer consult it directly. It
 * USED to be hand-bumped by callers via a follow-up
 * `updateSession({ prompt_count })`, which produced drift whenever a
 * new code path inserted a batch and forgot the second step. The
 * "single writer" tenet codified in AGENTS.md applies just as much
 * inside the DB-query layer as it does for `ProjectVault` or the
 * planned `CoTenantJsonWriter`: this function is the single writer
 * for `prompt_batches`, so it ALSO owns the counter the column
 * caches. No caller can insert without bumping; drift is structurally
 * impossible.
 *
 * The insert and the counter UPDATE are wrapped in a single SQLite
 * transaction so a crash between them can't leave a half-bumped
 * state. The inline `MAX(prompt_number) + 1` semantics make
 * concurrent inserts deterministic too — each insert reads its own
 * MAX inside the transaction.
 *
 * FTS5 index is kept in sync automatically via database triggers.
 */
export function insertBatchStateless(data: StatelessBatchInsert): BatchRow {
  const db = getDatabase();

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO prompt_batches (
         session_id, project_id, parent_prompt_batch_id, kind, origin,
         prompt_number, user_prompt, response_summary,
         classification, started_at, ended_at, status,
         activity_count, processed, content_hash, created_at, machine_id
       ) VALUES (
         ?, COALESCE(?, (SELECT project_id FROM sessions WHERE id = ?)), ?, ?, ?,
         (SELECT COALESCE(MAX(prompt_number), 0) + 1 FROM prompt_batches WHERE session_id = ?),
         ?, NULL,
         NULL, ?, NULL, ?,
         ?, ?, NULL, ?, ?
       )`,
    ).run(
      data.session_id,
      data.project_id ?? null,
      data.session_id,
      data.parent_prompt_batch_id ?? null,
      data.kind ?? 'initial',
      data.origin ?? PROMPT_BATCH_ORIGIN.HUMAN,
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

    // Atomic counter bump — folded INTO the single-writer for
    // `prompt_batches`. Sets `sessions.prompt_count` to the
    // freshly-derived `MAX(prompt_number)` for this session, which
    // is always the truth at this point in the transaction.
    db.prepare(
      `UPDATE sessions
         SET prompt_count = (
           SELECT MAX(prompt_number) FROM prompt_batches WHERE session_id = ?
         )
         WHERE id = ?`,
    ).run(data.session_id, data.session_id);

    return batchId;
  });

  const batchId = tx();

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
 *
 * Cross-batch dedupe: refuses to write a summary that already appears
 * verbatim on another batch in the same session. This guards against a
 * known race between live UserPromptSubmit hook capture and the Stop hook:
 * if a system-injected user prompt (e.g. a Claude Code <task-notification>
 * arriving from a backgrounded Agent) lands in the transcript while the AI
 * is still emitting its response, the Stop hook can fire BEFORE the live
 * hook inserts the new batch, causing setResponseSummary to back-stamp the
 * latest assistant text onto the previous (human) batch. By the time the
 * new batch is inserted, populateBatchResponses (or another setResponseSummary
 * call) writes the same text onto it, producing duplicate summaries
 * across two batches with different user_prompts. The dedupe gate breaks
 * that cycle: only the first batch to claim a given summary keeps it; the
 * second write is silently skipped, and a follow-up populateBatchResponses
 * pass fills the racing batch via prefix-keyed alignment with the correct
 * (later-emitted) assistant text.
 */
export function setResponseSummary(
  batchId: number,
  summary: string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE prompt_batches
       SET response_summary = ?
       WHERE id = ?
         AND response_summary IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM prompt_batches sib
           WHERE sib.session_id = (SELECT session_id FROM prompt_batches WHERE id = ?)
             AND sib.id != ?
             AND sib.response_summary = ?
         )`,
  ).run(summary, batchId, batchId, batchId, summary);
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
  options: ListBatchesBySessionOptions,
): BatchRow[] {
  const db = getDatabase();

  const limit = options.limit ?? BATCHES_DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  const conditions = ['session_id = ?'];
  const params: unknown[] = [sessionId];
  appendProjectCondition(conditions, params, options.scope);

  if (options.origins && options.origins.length > 0) {
    const placeholders = options.origins.map(() => '?').join(', ');
    conditions.push(`origin IN (${placeholders})`);
    params.push(...options.origins);
  }

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM prompt_batches
     WHERE ${conditions.join(' AND ')}
     ORDER BY prompt_number ASC
     LIMIT ?
     OFFSET ?`,
  ).all(...params, limit, offset) as Record<string, unknown>[];

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
 * Replace `user_prompt` (and reset `kind` to `'initial'`) on a batch only
 * when its `user_prompt` currently equals {@link RECOVERED_BATCH_SENTINEL}.
 * Updates `origin` as well so a sentinel batch claimed by a system-origin
 * prompt (e.g. a `<task-notification>` arriving first after recovery) is
 * tagged correctly. Returns true when a row was updated.
 */
export function replaceRecoveredBatchUserPrompt(
  batchId: number,
  realPrompt: string,
  origin: PromptBatchOrigin = PROMPT_BATCH_ORIGIN.HUMAN,
): boolean {
  if (!realPrompt) return false;
  const db = getDatabase();
  const info = db.prepare(
    `UPDATE prompt_batches
       SET user_prompt = ?, kind = ?, origin = ?
       WHERE id = ?
         AND user_prompt = ?`,
  ).run(realPrompt, BATCH_KIND.INITIAL, origin, batchId, RECOVERED_BATCH_SENTINEL);
  return info.changes > 0;
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

/** True if the session already has at least one batch (any kind, any state). */
export function hasAnyBatch(sessionId: string): boolean {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT 1 AS hit FROM prompt_batches WHERE session_id = ? LIMIT 1`,
  ).get(sessionId) as { hit: number } | undefined;
  return !!row;
}

/**
 * Count prompt batches for a session — authoritative prompt count.
 *
 * Pass `origins` to restrict the count (e.g. `['human']` to match the
 * vault-evolve / title-summary consumer view that filters via
 * `INTELLIGENCE_DEFAULT_ORIGINS`).
 */
export function countBatchesBySession(
  sessionId: string,
  options?: { origins?: readonly PromptBatchOrigin[] },
): number {
  const db = getDatabase();
  const origins = options?.origins;
  if (origins && origins.length > 0) {
    const placeholders = origins.map(() => '?').join(', ');
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM prompt_batches WHERE session_id = ? AND origin IN (${placeholders})`,
    ).get(sessionId, ...origins) as { count: number };
    return row.count;
  }
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM prompt_batches WHERE session_id = ?`,
  ).get(sessionId) as { count: number };
  return row.count;
}

/**
 * Bulk derived prompt counts for a list of session ids — authoritative count
 * via a single GROUP BY scan, suitable for the sessions list endpoint where
 * per-session COUNT(*) would be an N+1 anti-pattern.
 *
 * Returns a Map keyed by session id. Sessions with zero batches are absent
 * from the map (caller should treat missing as 0).
 *
 * R4.18 audit. Pairs with `sessions.prompt_count` (cached column) — readers
 * that need authoritative numbers should consult this helper; the cached
 * column can drift if a batch insert ran without bumping the session row.
 */
export function countBatchesBySessions(sessionIds: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (sessionIds.length === 0) return result;
  const placeholders = sessionIds.map(() => '?').join(', ');
  const rows = getDatabase().prepare(
    `SELECT session_id, COUNT(*) AS n FROM prompt_batches
     WHERE session_id IN (${placeholders})
     GROUP BY session_id`,
  ).all(...sessionIds) as Array<{ session_id: string; n: number }>;
  for (const row of rows) result.set(row.session_id, row.n);
  return result;
}
