import type { RelationalStore } from '../core/adapters.js';
import { PARSERS } from './parsers/registry.js';

/** The batch has unfinished work, counting a waiting build only once its retry is due, and is not paused at the headroom limit. */
export async function cutoverPending(db: RelationalStore, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM transcripts WHERE agent IN(SELECT value FROM json_each(?)))
      AND NOT EXISTS(SELECT 1 FROM cutover_progress WHERE id=1 AND paused_reason IS NOT NULL)
      AND (NOT EXISTS(SELECT 1 FROM cutover_progress WHERE id=1 AND classified_at IS NOT NULL AND swept_at IS NOT NULL)
        OR EXISTS(SELECT 1 FROM view_build_work WHERE state<>'waiting' OR next_attempt_at<=?)
        OR EXISTS(SELECT 1 FROM view_instances WHERE base='frozen' AND state='building')) pending`,
    )
    .bind(JSON.stringify(Object.keys(PARSERS)), now)
    .first<{ pending: number }>();
  return row?.pending === 1;
}
