/**
 * Suppressing a session, and everything the Deployment derived from it.
 *
 * A tombstone is the one record that outlives the deletion. The `sessions` row
 * is kept and every projection of it is removed, so the Deployment can still
 * answer "this session existed and was deleted" — which is what a re-import
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

/** The tables a session's derived rows live in, deepest first so a reader mid-delete never sees a parent without its children. */
export const DERIVED_TABLES = [
  'transcript_segments', 'transcripts', 'attachments', 'plans', 'responses', 'tool_calls', 'prompt_batches', 'events',
] as const;

/** The columns that reference a blob, by the table holding them. Every one is read before the delete and re-checked after it. */
const BLOB_REFERENCES: readonly { table: string; column: string }[] = [
  { table: 'prompt_batches', column: 'blob_key' },
  { table: 'responses', column: 'blob_key' },
  { table: 'plans', column: 'blob_key' },
  { table: 'attachments', column: 'blob_key' },
  { table: 'transcript_segments', column: 'blob_key' },
];

/** SQL naming a session that carries no tombstone. `alias` is the `sessions` alias in the query it joins. */
export const notTombstonedSql = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id)`;

/** The same predicate for a query that names its project and session by parameter rather than by alias. */
export const NOT_TOMBSTONED_PARAMS = `NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = ? AND t.session_id = ?)`;

export interface TombstoneOutcome {
  /** False when the Project holds no such session; the caller answers not-found rather than inventing a tombstone. */
  applied: boolean;
  /** Rows removed across every derived table. */
  removed: number;
  /** Blobs no surviving row referenced, removed from the store. */
  blobsFreed: number;
}

/** True when the Project holds this session at all, tombstoned or not: what separates "already deleted" from "never here". */
async function sessionPresent(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM sessions WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId).first<{ present: number }>();
  return row !== null;
}

/** Every blob key the session's rows name, before any of them are removed. */
async function blobKeysOf(db: RelationalStore, projectId: string, sessionId: string): Promise<string[]> {
  const union = BLOB_REFERENCES
    .map(({ table, column }) => `SELECT ${column} AS k FROM ${table} WHERE project_id = ? AND session_id = ? AND ${column} IS NOT NULL`)
    .join(' UNION ');
  const params = BLOB_REFERENCES.flatMap(() => [projectId, sessionId]);
  const { results } = await db.prepare(union).bind(...params).all<{ k: string }>();
  return [...new Set(results.map((r) => r.k))];
}

/** The keys among `keys` that no row anywhere in the Project still references. */
async function unreferenced(db: RelationalStore, projectId: string, keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const held = BLOB_REFERENCES
    .map(({ table, column }) => `EXISTS (SELECT 1 FROM ${table} WHERE project_id = ? AND ${column} = b.k)`)
    .join(' OR ');
  const values = keys.map(() => `SELECT ? AS k`).join(' UNION ALL ');
  const { results } = await db
    .prepare(`SELECT b.k FROM (${values}) b WHERE NOT (${held})`)
    .bind(...keys, ...BLOB_REFERENCES.map(() => projectId))
    .all<{ k: string }>();
  return results.map((r) => r.k);
}

/** Remove a blob's row and its stored bytes. A store that no longer holds the object is the state this converges on, so a repeat is a no-op. */
async function dropBlobs(db: RelationalStore, blobs: BlobStore, projectId: string, keys: readonly string[]): Promise<number> {
  for (const key of keys) {
    await blobs.delete(`${projectId}/${key}`);
    await db.prepare(`DELETE FROM blobs WHERE project_id = ? AND key = ?`).bind(projectId, key).run();
  }
  return keys.length;
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
  if (!(await sessionPresent(env.db, projectId, sessionId))) return { applied: false, removed: 0, blobsFreed: 0 };

  const keys = await blobKeysOf(env.db, projectId, sessionId);

  const statements = [
    env.db
      .prepare(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, session_id) DO NOTHING`)
      .bind(projectId, sessionId, reason ?? null, nowMs, by),
    ...DERIVED_TABLES.map((table) => env.db.prepare(`DELETE FROM ${table} WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId)),
    env.db.prepare(`DELETE FROM tags WHERE project_id = ? AND entity_kind = 'plan' AND entity_id NOT IN (SELECT plan_key FROM plans WHERE project_id = ?)`).bind(projectId, projectId),
  ];
  const results = await env.db.batch(statements);
  const removed = results.slice(1).reduce((n, r) => n + r.meta.changes, 0);

  const blobsFreed = await dropBlobs(env.db, env.blobs, projectId, await unreferenced(env.db, projectId, keys));
  emit({ kind: 'session_tombstoned', projectId, sessionId, removed, blobsFreed });
  return { applied: true, removed, blobsFreed };
}

/** Whether this session carries a tombstone. */
export async function isTombstoned(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM session_tombstones WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId).first<{ present: number }>();
  return row !== null;
}
