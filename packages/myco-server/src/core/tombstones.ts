/**
 * Suppressing a session, and everything the Deployment derived from it.
 *
 * A tombstone is the one record that outlives the deletion. The `sessions` row
 * is kept and every projection of it is removed, so the Deployment can still
 * answer that a session existed and is now deleted — which is what a re-import
 * needs in order to refuse, and what an operator needs in order to tell a
 * deleted session from one that never arrived.
 *
 * Suppression has two halves and both are structural rather than per-caller.
 * Reads go through one predicate this module owns, applied at the read layer's
 * own seams. Writes are refused by a shared check derived from the kind
 * catalogue, so a live hook cannot repopulate a session a person just deleted —
 * without that half, the deletion appears to fail for no visible reason while
 * capture is still running.
 *
 * Blobs are content-addressed and shared between rows, so a freed key is
 * removed from the store only once nothing else references it. Deleting them
 * with the session would take a surviving prompt's body with a segment's.
 */
import type { BlobStore, RelationalStore, ServerEnv } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { emit } from '../telemetry.js';

/** The tables a session's derived rows live in, each carrying `session_id` itself. */
export const DERIVED_TABLES = [
  'transcripts', 'attachments', 'plans', 'responses', 'tool_calls', 'prompt_batches', 'events',
] as const;

/**
 * A segment belongs to a session through its transcript, not directly.
 *
 * `transcript_segments` is keyed `(project_id, transcript_id, base_offset)` and
 * carries no `session_id`, so it is reached by naming the transcripts the
 * session held — and it must be swept BEFORE `transcripts`, whose rows are the
 * only route to it.
 */
const SEGMENTS_OF_SESSION = `SELECT transcript_id FROM transcripts WHERE project_id = ? AND session_id = ?`;

/** Where a blob key may be referenced, and how each table names the session holding it. */
const BLOB_REFERENCES: readonly { table: string; where: string }[] = [
  { table: 'prompt_batches', where: 'session_id = ?' },
  { table: 'responses', where: 'session_id = ?' },
  { table: 'plans', where: 'session_id = ?' },
  { table: 'attachments', where: 'session_id = ?' },
  { table: 'transcript_segments', where: `transcript_id IN (${SEGMENTS_OF_SESSION})` },
];

/** SQL naming a session that carries no tombstone. `alias` is the `sessions` alias in the query it joins. */
export const notTombstonedSql = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id)`;

/** The same predicate for a query that names its project and session by parameter rather than by alias. */
export const NOT_TOMBSTONED_PARAMS = `NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = ? AND t.session_id = ?)`;

/** Which of these sessions this Project has deleted. The set an import checks before it offers anything: a tombstoned session is never held again. */
export async function tombstonedAmong(db: RelationalStore, projectId: string, sessionIds: readonly string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const { results } = await db
    .prepare(`SELECT session_id FROM session_tombstones WHERE project_id = ? AND session_id IN (${sessionIds.map(() => '?').join(', ')})`)
    .bind(projectId, ...sessionIds)
    .all<{ session_id: string }>();
  return new Set(results.map((r) => r.session_id));
}

export interface TombstoneOutcome {
  /** False when the Project holds no such session; the caller answers not-found rather than inventing a tombstone. */
  applied: boolean;
  /** Rows removed across every derived table. */
  removed: number;
  /** Blobs no surviving row referenced, removed from the store. */
  blobsFreed: number;
  /** Blobs this call left for a later sweep, its bound reached. */
  blobsLeft: number;
}

/** True when the Project holds this session at all, tombstoned or not: what separates "already deleted" from "never here". */
async function sessionPresent(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM sessions WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId).first<{ present: number }>();
  return row !== null;
}

/** Every blob key the session's rows name, before any of them are removed. */
async function blobKeysOf(db: RelationalStore, projectId: string, sessionId: string): Promise<string[]> {
  const union = BLOB_REFERENCES
    .map(({ table, where }) => `SELECT blob_key AS k FROM ${table} WHERE project_id = ? AND ${where} AND blob_key IS NOT NULL`)
    .join(' UNION ');
  const params = BLOB_REFERENCES.flatMap(({ table }) =>
    table === 'transcript_segments' ? [projectId, projectId, sessionId] : [projectId, sessionId]);
  const { results } = await db.prepare(union).bind(...params).all<{ k: string }>();
  return [...new Set(results.map((r) => r.k))];
}

/** The keys among `keys` that no row anywhere in the Project still references. */
async function unreferenced(db: RelationalStore, projectId: string, keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const held = BLOB_REFERENCES
    .map(({ table }) => `EXISTS (SELECT 1 FROM ${table} WHERE project_id = ? AND blob_key = b.k)`)
    .join(' OR ');
  const values = keys.map(() => `SELECT ? AS k`).join(' UNION ALL ');
  const { results } = await db
    .prepare(`SELECT b.k FROM (${values}) b WHERE NOT (${held})`)
    .bind(...keys, ...BLOB_REFERENCES.map(() => projectId))
    .all<{ k: string }>();
  return results.map((r) => r.k);
}

/**
 * How many blobs one deletion frees before leaving the rest for a later call.
 *
 * A session holding thousands of attachments would spend thousands of calls
 * here, past what one invocation may make on a hosted runtime. The remainder is
 * not stranded: the rows naming those blobs are gone, so the retention job's
 * orphan sweep collects them, and `blobsLeft` reports what this call deferred
 * rather than swallowing it.
 */
export const TOMBSTONE_BLOBS_PER_CALL = 16;

/** Remove a blob's row and its stored bytes, as far as the bound reaches. A store that no longer holds the object is the state this converges on, so a repeat is a no-op. */
async function dropBlobs(db: RelationalStore, blobs: BlobStore, projectId: string, keys: readonly string[]): Promise<number> {
  const taken = keys.slice(0, TOMBSTONE_BLOBS_PER_CALL);
  for (const key of taken) await blobs.delete(`${projectId}/${key}`);
  if (taken.length > 0) {
    await db.batch(taken.map((key) => db.prepare(`DELETE FROM blobs WHERE project_id = ? AND key = ?`).bind(projectId, key)));
  }
  return taken.length;
}


/**
 * Suppress a session: record the tombstone, drop every derived row, and free
 * the blobs nothing else holds.
 *
 * The tombstone is written FIRST and in the same batch as the deletions. A
 * capture event arriving mid-delete is then refused by the shared check rather
 * than landing rows behind the sweep, which is what makes one pass enough.
 *
 * Idempotent: a second call finds the rows gone, writes the same tombstone
 * under `ON CONFLICT DO NOTHING`, and frees nothing.
 */
export async function tombstoneSession(
  env: Pick<ServerEnv, 'db' | 'blobs'>, scope: ReadScope, sessionId: string, by: string, nowMs: number, reason?: string,
): Promise<TombstoneOutcome> {
  const { projectId } = scope;
  if (!(await sessionPresent(env.db, projectId, sessionId))) return { applied: false, removed: 0, blobsFreed: 0, blobsLeft: 0 };

  const keys = await blobKeysOf(env.db, projectId, sessionId);

  const statements = [
    env.db
      .prepare(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, session_id) DO NOTHING`)
      .bind(projectId, sessionId, reason ?? null, nowMs, by),
    // Segments first: `transcripts` is the only route to them.
    env.db.prepare(`DELETE FROM transcript_segments WHERE project_id = ? AND transcript_id IN (${SEGMENTS_OF_SESSION})`).bind(projectId, projectId, sessionId),
    ...DERIVED_TABLES.map((table) => env.db.prepare(`DELETE FROM ${table} WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId)),
    env.db.prepare(`DELETE FROM tags WHERE project_id = ? AND entity_kind = 'plan' AND entity_id NOT IN (SELECT plan_key FROM plans WHERE project_id = ?)`).bind(projectId, projectId),
  ];
  const results = await env.db.batch(statements);
  const removed = results.slice(1).reduce((n, r) => n + r.meta.changes, 0);

  const orphaned = await unreferenced(env.db, projectId, keys);
  const blobsFreed = await dropBlobs(env.db, env.blobs, projectId, orphaned);
  emit({ kind: 'session_tombstoned', projectId, sessionId, removed, blobsFreed, blobsLeft: orphaned.length - blobsFreed });
  return { applied: true, removed, blobsFreed, blobsLeft: orphaned.length - blobsFreed };
}

/** Whether this session carries a tombstone. */
export async function isTombstoned(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM session_tombstones WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId).first<{ present: number }>();
  return row !== null;
}
