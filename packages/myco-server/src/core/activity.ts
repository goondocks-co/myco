/**
 * When the Deployment last saw activity, and the stamp an owner request leaves.
 *
 * Activity is what the power state follows: a capture receipt, a run starting,
 * a person on the dashboard. The first two already leave rows; the third is
 * stamped here, into the Deployment's own key-value row, at most once a minute.
 */
import type { RelationalStore } from './adapters.js';

/** The key under which the Deployment records the last owner request it served. */
export const LAST_REQUEST_KEY = 'last_request_at';
/** An owner request is stamped at most this often; the stamp is a write, and one per minute is as fresh as the tick can read. */
export const REQUEST_STAMP_INTERVAL_MS = 60_000;

/**
 * Record an owner request. One conditional write: the row is replaced only
 * when the stamp it holds is older than the interval, so a busy dashboard
 * costs one write a minute rather than one per request.
 */
export async function stampOwnerRequest(db: RelationalStore, now: number): Promise<void> {
  await db.prepare(
    `INSERT OR REPLACE INTO schema_meta (key, value)
       SELECT ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM schema_meta WHERE key = ? AND CAST(value AS INTEGER) > ?)`,
  ).bind(LAST_REQUEST_KEY, String(now), LAST_REQUEST_KEY, now - REQUEST_STAMP_INTERVAL_MS).run();
}

/** When the Deployment last saw activity — a capture receipt, a run starting, an owner request — or null when it never has. */
export async function lastActivityAt(db: RelationalStore): Promise<number | null> {
  const row = await db.prepare(
    `SELECT MAX(at) AS at FROM (
       SELECT MAX(last_received_at) AS at FROM sessions
       UNION ALL SELECT MAX(started_at) FROM agent_runs
       UNION ALL SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key = ?
     )`,
  ).bind(LAST_REQUEST_KEY).first<{ at: number | null }>();
  return row?.at ?? null;
}
