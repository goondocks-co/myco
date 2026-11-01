import type { RelationalStore } from '../core/adapters.js';

/** A document `d` conversion still owes: waiting, with its session header held and no tombstone. */
export const CONVERTIBLE_SQL = `d.state='convert' AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id=d.project_id AND s.session_id=d.session_id)
  AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=d.project_id AND t.session_id=d.session_id)`;

/** Sessions that predate documents still wait for conversion, counted as conversion selects them. */
export async function conversionBacklog(db: RelationalStore): Promise<boolean> {
  const row = await db
    .prepare(`SELECT EXISTS(SELECT 1 FROM session_documents d WHERE ${CONVERTIBLE_SQL}) backlog`)
    .first<{ backlog: number }>();
  return row?.backlog === 1;
}
