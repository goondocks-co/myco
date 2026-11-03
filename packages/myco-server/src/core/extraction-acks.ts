import type { RelationalStore } from './adapters.js';
import { NOT_TOMBSTONED_PARAMS } from './tombstones.js';

/** Restore durable coverage independently of run retention, excluding deleted sessions. */
export function restoreExtractionAckStatement(db: RelationalStore, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  return db.prepare(`INSERT OR IGNORE INTO extraction_acks (${columns.join(', ')})
    SELECT ${columns.map(() => '?').join(', ')} WHERE ${NOT_TOMBSTONED_PARAMS} RETURNING rowid`)
    .bind(...columns.map(column => row[column] ?? null), row.project_id, row.session_id);
}
