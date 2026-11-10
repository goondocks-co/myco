import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, readSet, write } from '../index.js';

/**
 * A search's stored ranking: the `doc_id`s its later pages list, in rank order, and per kind where the walk below it
 * resumes. A reader holds at most `SEARCH_WINDOWS_PER_READER`; storing one more evicts that reader's oldest in the same
 * batch, and each store also removes a few windows that have expired, so the table never needs a sweep of its own.
 */
export const SEARCH_WINDOWS_PER_READER = 64;
/** Expired windows each store removes. */
const EXPIRED_PER_STORE = 8;

interface StoredWindow {
  search_id: string;
  reader: string;
  binding: string;
  asof: number;
  expires_at: number;
  round: number;
  /** JSON: per kind, the lowest `doc_id` ranked and whether older matches remain below it. */
  kinds: string;
  /** JSON array of `doc_id`s in rank order. */
  hits: string;
}

const evict = write<[reader: string, keep: number, now: number]>({ name: 'searchWindows.evict',
  sql: `DELETE FROM search_result_windows WHERE reader = ?1 AND (expires_at < ?3 OR search_id IN (
    SELECT search_id FROM search_result_windows WHERE reader = ?1 ORDER BY expires_at DESC, search_id LIMIT -1 OFFSET ?2))` });
const expire = write<[now: number, limit: number]>({ name: 'searchWindows.expire',
  sql: 'DELETE FROM search_result_windows WHERE search_id IN (SELECT search_id FROM search_result_windows WHERE expires_at < ?1 ORDER BY expires_at LIMIT ?2)' });
const store = write<[id: string, reader: string, binding: string, asof: number, expires: number, round: number, kinds: string, hits: string]>({ name: 'searchWindows.store',
  sql: `INSERT INTO search_result_windows(search_id, reader, binding, asof, expires_at, round, kinds, hits) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(search_id) DO UPDATE SET asof = excluded.asof, expires_at = excluded.expires_at, round = excluded.round, kinds = excluded.kinds, hits = excluded.hits
    WHERE search_result_windows.reader = excluded.reader AND search_result_windows.binding = excluded.binding` });
const held = read<[id: string], StoredWindow>({ name: 'searchWindows.held',
  sql: 'SELECT search_id, reader, binding, asof, expires_at, round, kinds, hits FROM search_result_windows WHERE search_id = ?1' });

/** Stores (or, for the same reader and search, replaces) one window, evicting the reader's oldest beyond the cap. */
export async function storeWindow(db: RelationalStore, window: StoredWindow, now: number): Promise<void> {
  await commit(db,
    evict.bind(window.reader, SEARCH_WINDOWS_PER_READER - 1, now),
    expire.bind(now, EXPIRED_PER_STORE),
    store.bind(window.search_id, window.reader, window.binding, window.asof, window.expires_at, window.round, window.kinds, window.hits));
}

/** The window `id` names, or null when it expired or was evicted. */
export async function heldWindow(db: RelationalStore, id: string, now: number): Promise<StoredWindow | null> {
  const [rows] = await readSet(db, held.bind(id));
  const row = rows[0];
  return row === undefined || Number(row.expires_at) < now ? null : row;
}
