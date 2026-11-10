import type { RelationalStore } from '../../core/adapters.js';
import { first, read, write, type Bound } from '../index.js';

/**
 * Replaces the Deployment's stamp under `key` only when the stamp it holds is older than `staleBefore`, so a burst of
 * requests costs one write per interval.
 */
const STAMP = write<[key: string, value: string, staleBefore: number]>({
  name: 'lastActivity.stamp',
  sql: `INSERT OR REPLACE INTO schema_meta (key, value) SELECT ?1,?2
    WHERE NOT EXISTS (SELECT 1 FROM schema_meta WHERE key=?1 AND CAST(value AS INTEGER)>?3)`,
});

/** The stamp write, bound for a caller's commit. */
export const stampWrite = (key: string, now: number, staleBefore: number): Bound<never, 'write'> => STAMP.bind(key, String(now), staleBefore);

/** The latest of a capture receipt, a run start and the stamp under `?1`. */
const LATEST = read<[key: string], { at: number | null }>({
  name: 'lastActivity.latest',
  sql: `SELECT MAX(at) AS at FROM (
       SELECT MAX(last_received_at) AS at FROM sessions
       UNION ALL SELECT MAX(started_at) FROM agent_runs
       UNION ALL SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key = ?1
     )`,
});

/** When the Deployment last saw a capture receipt, a run start or the stamp under `key`, or null when it never has. */
export async function latestActivityAt(db: RelationalStore, key: string): Promise<number | null> {
  return (await first(db, LATEST.bind(key)))?.at ?? null;
}
