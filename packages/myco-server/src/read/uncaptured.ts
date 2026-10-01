/**
 * The repositories machines could not capture, as "Needs you" shows them: every machine's to an admin, and a member's
 * own to that member. A repository is named by its folder name, and its machine by name to the member it belongs to.
 */
import type { RelationalStore } from '../core/adapters.js';
import { HARNESS_MEMBER_ID } from '../constants.js';

/** One repository a machine could not capture. */
export interface UncapturedRoot {
  machineId: string;
  rootKey: string;
  member: { id: string; label: string | null };
  label: string;
  remote: string | null;
  reason: string;
  misses: number;
  held: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Whose repositories a read answers: every member's, or one member's own. */
export type UncapturedScope = { all: true } | { all: false; memberId: string };

const toRow = (row: Record<string, unknown>): UncapturedRoot => ({
  machineId: String(row.machine_id),
  rootKey: String(row.root_key),
  member: { id: String(row.member_id), label: row.member_id === HARNESS_MEMBER_ID ? 'Myco' : (row.member_label as string | null) ?? null },
  label: String(row.label),
  remote: (row.remote as string | null) ?? null,
  reason: String(row.reason),
  misses: Number(row.misses),
  held: String(row.held),
  firstSeenAt: Number(row.first_seen_at),
  lastSeenAt: Number(row.last_seen_at),
});

const COLUMNS = `u.machine_id, u.root_key, u.member_id, m.label AS member_label, u.label, u.remote, u.reason, u.misses, u.held, u.first_seen_at, u.last_seen_at`;

/** The most repositories one read answers: the most recently missed, which are the ones still being worked in. */
export const UNCAPTURED_LIST_LIMIT = 100;

/** The repositories `scope` reaches, the most recently missed first, at most `UNCAPTURED_LIST_LIMIT`. */
export async function listUncaptured(db: RelationalStore, scope: UncapturedScope): Promise<UncapturedRoot[]> {
  const sql = `SELECT ${COLUMNS} FROM uncaptured_roots u CROSS JOIN members m ON m.id = u.member_id`;
  const statement = scope.all
    ? db.prepare(`${sql} ORDER BY u.last_seen_at DESC LIMIT ?`).bind(UNCAPTURED_LIST_LIMIT)
    : db.prepare(`${sql} WHERE u.member_id = ? ORDER BY u.last_seen_at DESC LIMIT ?`).bind(scope.memberId, UNCAPTURED_LIST_LIMIT);
  const { results } = await statement.all<Record<string, unknown>>();
  return (results ?? []).map(toRow);
}

/** One repository of one machine, or null where the machine reported none under that key. */
export async function getUncaptured(db: RelationalStore, machineId: string, rootKey: string): Promise<UncapturedRoot | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM uncaptured_roots u CROSS JOIN members m ON m.id = u.member_id WHERE u.machine_id = ? AND u.root_key = ?`)
    .bind(machineId, rootKey).first<Record<string, unknown>>();
  return row === null ? null : toRow(row);
}
