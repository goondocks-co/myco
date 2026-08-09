/**
 * Session deletion tombstones.
 *
 * A tombstone records that a session was deliberately deleted through
 * `deleteSessionCascade`, so the buffer reconciler can tell "deleted on
 * purpose — discard the lingering buffer" apart from "row lost — eligible
 * for gate-checked resurrection". Strictly machine-local: the table is
 * absent from every team-sync registry (the sessions delete itself already
 * journals via its own trigger).
 */

import { getDatabase, type Database } from '@myco/db/client.js';
import { epochSeconds, MS_PER_SECOND } from '@myco/constants.js';

/** Which deletion path wrote the tombstone. */
export const SESSION_TOMBSTONE_SOURCE = {
  /** DELETE /api/sessions/:id — explicit user delete. */
  API_DELETE: 'api_delete',
  /** session-maintenance dead-session sweep. */
  MAINTENANCE_SWEEP: 'maintenance_sweep',
  /** Stop-gate cleanup of an invalid captured session. */
  INVALID_CAPTURE: 'invalid_capture',
  /** Injection-only phantom session reaper (unregister + maintenance sweep). */
  PHANTOM_REAP: 'phantom_reap',
} as const;

export type SessionTombstoneSource =
  (typeof SESSION_TOMBSTONE_SOURCE)[keyof typeof SESSION_TOMBSTONE_SOURCE];

/** Row shape for `session_tombstones`. */
export interface SessionTombstoneRow {
  session_id: string;
  project_id: string | null;
  deleted_at: number;
  source: SessionTombstoneSource;
}

/**
 * Record a deletion tombstone for a session.
 *
 * Inside-transaction helper: the caller (deleteSessionCascade) passes its
 * own `db` handle so the tombstone commits or rolls back atomically with
 * the cascade itself. REPLACE keeps the newest deletion authoritative when
 * the same session id is deleted more than once (delete → same-id reload →
 * delete again).
 */
export function insertSessionTombstone(
  db: Database,
  row: { sessionId: string; projectId: string | null; source: SessionTombstoneSource },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO session_tombstones (session_id, project_id, deleted_at, source)
     VALUES (?, ?, ?, ?)`,
  ).run(row.sessionId, row.projectId, epochSeconds(), row.source);
}

/** True when a deletion tombstone exists for the session. */
export function hasSessionTombstone(sessionId: string): boolean {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT 1 AS present FROM session_tombstones WHERE session_id = ? LIMIT 1`,
  ).get(sessionId) as { present: number } | undefined;
  return row?.present === 1;
}

/**
 * Retrieve a single tombstone row (diagnostics / tests).
 */
/**
 * Remove a session's tombstone. Only EXPLICIT supersession may call this:
 * a user-driven /sessions/register for the same id (supported reload
 * flow), or a fresh human prompt arriving for a `phantom_reap` tombstone
 * (live human input disproves the phantom classification). Passive event
 * traffic must never clear a tombstone — deletion stays final against
 * event-driven recreation.
 */
export function deleteSessionTombstone(sessionId: string): boolean {
  const db = getDatabase();
  const res = db.prepare(`DELETE FROM session_tombstones WHERE session_id = ?`).run(sessionId);
  return res.changes > 0;
}

export function getSessionTombstone(sessionId: string): SessionTombstoneRow | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT session_id, project_id, deleted_at, source
       FROM session_tombstones WHERE session_id = ?`,
  ).get(sessionId) as SessionTombstoneRow | undefined;
  return row ?? null;
}

/**
 * Remove tombstones older than `olderThanMs`.
 *
 * Callers pass TOMBSTONE_RETENTION_MS, which must outlive every
 * buffer-retention window so no buffer file can survive its tombstone.
 *
 * @returns count of rows removed.
 */
export function pruneSessionTombstones(olderThanMs: number): number {
  const db = getDatabase();
  const cutoff = epochSeconds() - Math.floor(olderThanMs / MS_PER_SECOND);
  const info = db.prepare(
    `DELETE FROM session_tombstones WHERE deleted_at < ?`,
  ).run(cutoff);
  return info.changes;
}
