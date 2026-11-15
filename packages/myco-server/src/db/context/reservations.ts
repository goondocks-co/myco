import type { RelationalStore } from '../../core/adapters.js';
import { commit, write } from '../index.js';

const expired = write<[now: number, limit: number], { item_id: string }>({
  name: 'context.pruneExpiredReservations',
  sql: `DELETE FROM session_served_items WHERE (project_id,session_id,kind,item_id) IN (
    SELECT s.project_id,s.session_id,s.kind,s.item_id FROM projects p CROSS JOIN session_served_items s INDEXED BY idx_session_served_expiry
    ON s.project_id=p.project_id WHERE s.reservation_expires_at>0 AND s.reservation_expires_at<=?1 LIMIT ?2) RETURNING item_id`,
});

/** Prune a bounded page of expired reservations, retaining every delivered exclusion. */
export async function pruneExpiredReservations(db: RelationalStore, now: number, limit: number): Promise<number> {
  const [removed] = await commit(db, expired.bind(now, limit));
  return removed!.results.length;
}
