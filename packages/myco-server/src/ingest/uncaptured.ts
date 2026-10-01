/**
 * The repositories a member's machine met and could not capture, as the machine or the Deployment reports them.
 *
 * One row per machine and repository, keyed by the repository key the member derives from its path. A repository is
 * named by its folder name alone, never by a path, so no home directory reaches the Deployment. A report counts one
 * more miss and keeps the latest reason; a connection, the member's revocation, or a month with no report deletes the row.
 */
import type { PreparedStatement, RelationalStore } from '../core/adapters.js';

export { UNCAPTURED_REASONS, isUncapturedReason, type UncapturedReason } from '@goondocks/myco-shared/member-protocol';
import type { HeldState, UncapturedReason } from '@goondocks/myco-shared/member-protocol';
import { MEMBER_REVOKED_BY, memberRevokedByParams } from '../db/liveness.js';

/** One report of a repository a machine could not capture. */
export interface UncapturedReport {
  machineId: string;
  memberId: string;
  rootKey: string;
  label: string;
  remote: string | null;
  reason: UncapturedReason;
  /** What the machine holds of the repository's capture, as it says; the machine is its authority. */
  held: HeldState;
  /** How many sessions met the repository after the machine last reported it. */
  sessions: number;
  now: number;
}

/**
 * Record a report: a first one writes the row, a later one keeps the latest reason, name, remote and hold, and counts
 * the sessions that met the repository after the last. `misses` counts sessions, never attempts.
 */
export function recordUncapturedStatement(db: RelationalStore, r: UncapturedReport): PreparedStatement {
  return db.prepare(
    `INSERT INTO uncaptured_roots (machine_id, root_key, member_id, label, remote, reason, misses, held, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (machine_id, root_key) DO UPDATE SET label = excluded.label, remote = excluded.remote, reason = excluded.reason,
         misses = uncaptured_roots.misses + ?, held = excluded.held, last_seen_at = excluded.last_seen_at`,
  ).bind(r.machineId, r.rootKey, r.memberId, r.label, r.remote, r.reason, Math.max(r.sessions, 1), r.held, r.now, r.now, r.sessions);
}

/** Forget a repository once it is connected. */
export function clearUncapturedStatement(db: RelationalStore, machineId: string, rootKey: string): PreparedStatement {
  return db.prepare(`DELETE FROM uncaptured_roots WHERE machine_id = ? AND root_key = ?`).bind(machineId, rootKey);
}

/** Record that a machine no longer holds a repository's capture: past its cap, or discarded with age. */
export function heldUncapturedStatement(db: RelationalStore, machineId: string, rootKey: string, held: Exclude<HeldState, 'held'>): PreparedStatement {
  return db.prepare(`UPDATE uncaptured_roots SET held = ? WHERE machine_id = ? AND root_key = ?`).bind(held, machineId, rootKey);
}

/** Forget a revoked member's repositories, in the batch that revokes them: only once that batch's first statement has. */
export function clearMemberUncapturedStatement(db: RelationalStore, memberId: string, revokedBy: string, nowMs: number): PreparedStatement {
  return db.prepare(`DELETE FROM uncaptured_roots WHERE member_id = ? AND ${MEMBER_REVOKED_BY}`).bind(memberId, ...memberRevokedByParams(memberId, nowMs, revokedBy));
}

/** How long a repository no machine reports again stays listed. */
export const UNCAPTURED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Forget repositories no machine has reported for `UNCAPTURED_RETENTION_MS`, at most `batch` of them, oldest first. */
export async function pruneUncaptured(db: RelationalStore, now: number, batch: number): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM uncaptured_roots WHERE rowid IN (SELECT rowid FROM uncaptured_roots WHERE last_seen_at < ? ORDER BY last_seen_at LIMIT ?)`,
  ).bind(now - UNCAPTURED_RETENTION_MS, batch).run();
  return result.meta.changes ?? 0;
}
