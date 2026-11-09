import { HARNESS_MEMBER_ID } from '../../constants.js';
import type { RelationalStore } from '../../core/adapters.js';
import type { Page } from '../../read/scope.js';
import { first, read, rows } from '../index.js';

/**
 * The repositories machines could not capture, as "Needs you" shows them: every machine's to an admin, and a member's
 * own to that member. A repository is named by its folder name, and its machine by name to the member it belongs to.
 */

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

interface UncapturedRow {
  machine_id: string; root_key: string; member_id: string; member_label: string | null; label: string; remote: string | null;
  reason: string; misses: number; held: string; first_seen_at: number; last_seen_at: number;
}

/** Whose repositories a read answers: every member's, or one member's own. */
type UncapturedScope = { all: true } | { all: false; memberId: string };

const toRoot = (row: UncapturedRow): UncapturedRoot => ({
  machineId: row.machine_id,
  rootKey: row.root_key,
  member: { id: row.member_id, label: row.member_id === HARNESS_MEMBER_ID ? 'Myco' : row.member_label },
  label: row.label,
  remote: row.remote,
  reason: row.reason,
  misses: Number(row.misses),
  held: row.held,
  firstSeenAt: Number(row.first_seen_at),
  lastSeenAt: Number(row.last_seen_at),
});

const COLUMNS = `u.machine_id, u.root_key, u.member_id, m.label AS member_label, u.label, u.remote, u.reason, u.misses, u.held, u.first_seen_at, u.last_seen_at`;
const FROM = 'uncaptured_roots u CROSS JOIN members m ON m.id = u.member_id';
/** The most repositories one page answers: the most recently missed, which are the ones still being worked in. */
export const UNCAPTURED_PAGE_LIMIT = 100;

const after = (at: string, machine: string, root: string) => `(u.last_seen_at < ${at} OR (u.last_seen_at = ${at} AND (u.machine_id < ${machine} OR (u.machine_id = ${machine} AND u.root_key < ${root}))))`;
const ORDER = 'ORDER BY u.last_seen_at DESC, u.machine_id DESC, u.root_key DESC';

const everyFirst = read<[limit: number], UncapturedRow>({ name: 'uncaptured.everyFirst', sql: `SELECT ${COLUMNS} FROM ${FROM} ${ORDER} LIMIT ?1` });
const everyAfter = read<[limit: number, at: number, machine: string, root: string], UncapturedRow>({ name: 'uncaptured.everyAfter',
  sql: `SELECT ${COLUMNS} FROM ${FROM} WHERE u.last_seen_at <= ?2 AND ${after('?2', '?3', '?4')} ${ORDER} LIMIT ?1` });
const ownFirst = read<[limit: number, member: string], UncapturedRow>({ name: 'uncaptured.ownFirst', sql: `SELECT ${COLUMNS} FROM ${FROM} WHERE u.member_id = ?2 ${ORDER} LIMIT ?1` });
const ownAfter = read<[limit: number, member: string, at: number, machine: string, root: string], UncapturedRow>({ name: 'uncaptured.ownAfter',
  sql: `SELECT ${COLUMNS} FROM ${FROM} WHERE u.member_id = ?2 AND u.last_seen_at <= ?3 AND ${after('?3', '?4', '?5')} ${ORDER} LIMIT ?1` });
const one = read<[machine: string, root: string], UncapturedRow>({ name: 'uncaptured.one', sql: `SELECT ${COLUMNS} FROM ${FROM} WHERE u.machine_id = ?1 AND u.root_key = ?2` });

interface UncapturedKey { lastSeenAt: number; machineId: string; rootKey: string }

const PREFIX = 'u1:';

/** The refusal of a cursor this list did not issue. */
export const UNCAPTURED_CURSOR_REFUSAL = 'malformed cursor: this list pages by the `cursor` its last answer returned, exactly as returned. Nothing was read: request the first page again without a cursor.';

const encodeCursor = (key: UncapturedKey) => `${PREFIX}${key.lastSeenAt}:${encodeURIComponent(key.machineId)}:${encodeURIComponent(key.rootKey)}`;

/** The key a page continues after, or null when the text is not a cursor this list issued. */
export function decodeUncapturedCursor(text: string): UncapturedKey | null {
  if (!text.startsWith(PREFIX)) return null;
  const parts = text.slice(PREFIX.length).split(':');
  if (parts.length !== 3 || parts[0] === '' || parts[1] === '' || parts[2] === '') return null;
  const lastSeenAt = Number(parts[0]);
  if (!Number.isSafeInteger(lastSeenAt)) return null;
  try {
    return { lastSeenAt, machineId: decodeURIComponent(parts[1]!), rootKey: decodeURIComponent(parts[2]!) };
  } catch {
    return null;
  }
}

/** One page of the repositories `scope` reaches, the most recently missed first, ties held apart by machine and root so a page boundary never skips or repeats one. */
export async function listUncaptured(db: RelationalStore, scope: UncapturedScope, opts: { cursor?: string } = {}): Promise<Page<UncapturedRoot>> {
  const key = opts.cursor === undefined ? null : decodeUncapturedCursor(opts.cursor);
  if (opts.cursor !== undefined && key === null) return { rows: [], cursor: null };
  const limit = UNCAPTURED_PAGE_LIMIT + 1;
  const statement = scope.all
    ? key === null ? everyFirst.bind(limit) : everyAfter.bind(limit, key.lastSeenAt, key.machineId, key.rootKey)
    : key === null ? ownFirst.bind(limit, scope.memberId) : ownAfter.bind(limit, scope.memberId, key.lastSeenAt, key.machineId, key.rootKey);
  const found = (await rows(db, statement)).map(toRoot);
  const more = found.length > UNCAPTURED_PAGE_LIMIT;
  const page = more ? found.slice(0, UNCAPTURED_PAGE_LIMIT) : found;
  const last = page.at(-1);
  return { rows: page, cursor: more && last !== undefined ? encodeCursor(last) : null };
}

/** One repository of one machine, or null where the machine reported none under that key. */
export async function getUncaptured(db: RelationalStore, machineId: string, rootKey: string): Promise<UncapturedRoot | null> {
  const row = await first(db, one.bind(machineId, rootKey));
  return row === null ? null : toRoot(row);
}
