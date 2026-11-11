/**
 * The repositories a member's machine met and could not capture, as the machine or the Deployment reports them.
 *
 * One row per machine and repository, keyed by the repository key the member derives from its path. A repository is
 * named by its folder name alone, never by a path, so no home directory reaches the Deployment. A report counts one
 * more miss and keeps the latest reason; a connection, the member's revocation, or a month with no report deletes the row.
 */
import type { HeldState, UncapturedReason } from '@goondocks/myco-shared/member-protocol';
import type { RelationalStore } from '../../core/adapters.js';
import { rows, write, type Bound } from '../index.js';

/** One report of a repository a machine could not capture. */
interface UncapturedReport {
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

const record = write<[machine: string, root: string, member: string, label: string, remote: string | null, reason: string,
  firstMisses: number, held: string, now: number, sessions: number]>({ name: 'uncaptured.record', sql:
  `INSERT INTO uncaptured_roots (machine_id, root_key, member_id, label, remote, reason, misses, held, first_seen_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT (machine_id, root_key) DO UPDATE SET label = excluded.label, remote = excluded.remote, reason = excluded.reason,
       misses = uncaptured_roots.misses + ?10, held = excluded.held, last_seen_at = excluded.last_seen_at` });
const clear = write<[machine: string, root: string]>({ name: 'uncaptured.clear', sql:
  `DELETE FROM uncaptured_roots WHERE machine_id = ?1 AND root_key = ?2` });
const held = write<[held: string, machine: string, root: string]>({ name: 'uncaptured.held', sql:
  `UPDATE uncaptured_roots SET held = ?1 WHERE machine_id = ?2 AND root_key = ?3` });
const prune = write<[before: number, batch: number], { machine_id: string }>({ name: 'uncaptured.prune', sql:
  `DELETE FROM uncaptured_roots WHERE rowid IN (SELECT rowid FROM uncaptured_roots WHERE last_seen_at < ?1 ORDER BY last_seen_at LIMIT ?2)
     RETURNING machine_id` });

/**
 * Record a report: a first one writes the row, a later one keeps the latest reason, name, remote and hold, and counts
 * the sessions that met the repository after the last. `misses` counts sessions, never attempts.
 */
export function recordUncaptured(r: UncapturedReport): Bound {
  return record.bind(r.machineId, r.rootKey, r.memberId, r.label, r.remote, r.reason, Math.max(r.sessions, 1), r.held, r.now, r.sessions);
}

/** Forget a repository once it is connected. */
export const clearUncaptured = (machineId: string, rootKey: string): Bound => clear.bind(machineId, rootKey);

/** Record that a machine no longer holds a repository's capture: past its cap, or discarded with age. */
export const heldUncaptured = (machineId: string, rootKey: string, state: Exclude<HeldState, 'held'>): Bound => held.bind(state, machineId, rootKey);

/** How long a repository no machine reports again stays listed. */
export const UNCAPTURED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Forget repositories no machine has reported for `UNCAPTURED_RETENTION_MS`, at most `batch` of them, oldest first; answers how many it forgot. */
export async function pruneUncaptured(db: RelationalStore, now: number, batch: number): Promise<number> {
  return (await rows(db, prune.bind(now - UNCAPTURED_RETENTION_MS, batch))).length;
}
