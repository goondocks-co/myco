import { NOT_TOMBSTONED_PARAMS } from '../session-read-model.js';
import { write, type BindValue, type Bound } from '../index.js';
import { restoredColumnStatements, restoredValues } from '../recovery/restored-columns.js';

const restores = restoredColumnStatements<{ rowid: number }, 'write'>('learning.restoreExtractionAck');

/** Restore durable coverage independently of run retention, excluding deleted sessions. */
export function restoreExtractionAck(row: Readonly<Record<string, unknown>>): Bound<{ rowid: number }, 'write'> {
  const columns = Object.keys(row);
  const definition = restores(columns, (name, list) => write<BindValue[], { rowid: number }>({ name, sql:
    `INSERT OR IGNORE INTO extraction_acks (${list.join(', ')})
    SELECT ${list.map(() => '?').join(', ')} WHERE ${NOT_TOMBSTONED_PARAMS} RETURNING rowid` }));
  return definition.bind(...restoredValues(row, columns), (row.project_id ?? null) as BindValue, (row.session_id ?? null) as BindValue);
}
