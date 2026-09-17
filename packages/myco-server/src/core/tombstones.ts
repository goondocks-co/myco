/**
 * Session deletion retains its identity and tombstone, clears its title and
 * summary, and removes captured projections. Saved knowledge and other sessions
 * remain. Reads exclude tombstones; ingestion refuses subsequent capture and
 * import for the same session ID. Unreferenced blobs are freed in bounded pages.
 */
import type { RelationalStore, ServerEnv } from './adapters.js';
import { recordBlobCandidates, releaseBlobs } from './object-release.js';
import { BLOB_REFERENCES, kindFilter, type BlobReference } from './blob-references.js';
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

/** The SQL naming a session's rows in a reference table, after `project_id = ?`, with the parameters it binds. */
interface SessionRoute { where: string; params(projectId: string, sessionId: string): string[] }

/** How a reference table names the session holding a row: by its own `session_id`, or through the transcripts of one. A catalogue table reached neither way has no route from a deletion and is refused at load. */
function sessionRoute(table: string): SessionRoute {
  if ((DERIVED_TABLES as readonly string[]).includes(table)) return { where: 'session_id = ?', params: (projectId, sessionId) => [projectId, sessionId] };
  if (table === 'transcript_segments') return { where: `transcript_id IN (${SEGMENTS_OF_SESSION})`, params: (projectId, sessionId) => [projectId, projectId, sessionId] };
  throw new Error(`no route from a session to blob references in ${table}`);
}

/** Every catalogue reference with the route from a session to its rows, resolved once at load. */
const SESSION_REFERENCES: readonly { ref: BlobReference; route: SessionRoute }[] =
  BLOB_REFERENCES.map((ref) => ({ ref, route: sessionRoute(ref.table) }));

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
  /** Blobs no surviving row referenced, journaled for deletion with their rows removed. */
  blobsFreed: number;
  /** Blobs this call left recorded as release candidates while a recovery hold is open; the drain decides them after it. */
  blobsLeft: number;
}

/** True when the Project holds this session at all, tombstoned or not: what separates "already deleted" from "never here". */
async function sessionPresent(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM sessions WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId).first<{ present: number }>();
  return row !== null;
}

/** Every blob key the session's rows name, before any of them are removed: one select per catalogue reference, sent as one batch. The hosted store caps a compound select at five terms. */
async function blobKeysOf(db: RelationalStore, projectId: string, sessionId: string): Promise<string[]> {
  const rows = await db.batch(SESSION_REFERENCES.map(({ ref, route }) => db
    .prepare(`SELECT DISTINCT ${ref.column} AS k FROM ${ref.table} WHERE project_id = ? AND ${route.where} AND ${ref.column} IS NOT NULL${kindFilter(ref)}`)
    .bind(...route.params(projectId, sessionId))));
  return [...new Set(rows.flatMap((r) => (r.results as { k: string }[]).map((row) => row.k)))];
}


/**
 * Suppress a session: record the tombstone, drop every derived row, and free
 * the blobs nothing else holds through the release owner, which journals their stored objects for deletion.
 *
 * The tombstone is written FIRST and in the same batch as the deletions. A
 * capture event arriving mid-delete is then refused by the shared check rather
 * than landing rows behind the sweep, which is what makes one pass enough.
 *
 * Idempotent: a second call finds the rows gone, writes the same tombstone
 * under `ON CONFLICT DO NOTHING`, and frees nothing.
 */
export async function tombstoneSession(
  env: Pick<ServerEnv, 'db'>, scope: ReadScope, sessionId: string, by: string, nowMs: number, reason?: string,
): Promise<TombstoneOutcome> {
  const { projectId } = scope;
  if (!(await sessionPresent(env.db, projectId, sessionId))) return { applied: false, removed: 0, blobsFreed: 0, blobsLeft: 0 };

  const keys = await blobKeysOf(env.db, projectId, sessionId);

  const metadata = [
    env.db
      .prepare(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, session_id) DO NOTHING`)
      .bind(projectId, sessionId, reason ?? null, nowMs, by),
    env.db.prepare(`UPDATE sessions SET title = NULL, summary = NULL, titled_at = NULL, titled_by = NULL
      WHERE project_id = ? AND session_id = ? AND (title IS NOT NULL OR summary IS NOT NULL OR titled_at IS NOT NULL OR titled_by IS NOT NULL)`).bind(projectId, sessionId),
  ];
  const statements = [
    ...metadata,
    // Segments first: `transcripts` is the only route to them.
    env.db.prepare(`DELETE FROM transcript_segments WHERE project_id = ? AND transcript_id IN (${SEGMENTS_OF_SESSION})`).bind(projectId, projectId, sessionId),
    ...DERIVED_TABLES.map((table) => env.db.prepare(`DELETE FROM ${table} WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId)),
    env.db.prepare(`DELETE FROM tags WHERE project_id = ? AND entity_kind = 'plan' AND entity_id NOT IN (SELECT plan_key FROM plans WHERE project_id = ?)`).bind(projectId, projectId),
  ];
  // Every blob the session's rows named is recorded as a release candidate in the transaction that removes the rows,
  // so an interruption before the decision below leaves the candidates for the drain rather than for no one.
  const pairs = keys.map((key) => ({ projectId, key }));
  const candidates = recordBlobCandidates(env.db, pairs, nowMs);
  const results = await env.db.batch([...statements, ...candidates]);
  const removed = results.slice(metadata.length, statements.length).reduce((n, r) => n + r.meta.changes, 0);

  const released = await releaseBlobs(env.db, pairs, nowMs);
  const blobsFreed = released.released;
  emit({ kind: 'session_tombstoned', projectId, sessionId, removed, blobsFreed, blobsLeft: released.deferred });
  return { applied: true, removed, blobsFreed, blobsLeft: released.deferred };
}

/** Whether this session carries a tombstone. */
export async function isTombstoned(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM session_tombstones WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId).first<{ present: number }>();
  return row !== null;
}
