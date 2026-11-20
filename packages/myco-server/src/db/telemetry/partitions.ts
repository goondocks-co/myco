import type { RelationalStore } from '../../core/adapters.js';
import { commit, write } from '../index.js';

const selection = (slots: { key?: string; limit: string }, table: 'ids' | 'windows') => {
  const item = table === 'ids' ? 'session_id' : 'span_id';
  return `SELECT d.trace_id,d.key_id,d.${item} FROM telemetry_trace_keys q JOIN telemetry_dependency_${table} d
    ON d.trace_id=q.trace_id AND d.key_id=q.key_id WHERE q.spans=0 ${slots.key === undefined ? '' : `AND q.key_id=${slots.key}`}
    ORDER BY q.key_id,q.trace_id LIMIT ${slots.limit}`;
};
const empty = (slots: {
  key?: string;
  limit: string;
}) => `SELECT q.trace_id,q.key_id FROM telemetry_trace_keys q WHERE q.spans=0
 ${slots.key === undefined ? '' : `AND q.key_id=${slots.key}`}
 AND NOT EXISTS(SELECT 1 FROM telemetry_dependency_ids d WHERE d.trace_id=q.trace_id AND d.key_id=q.key_id)
 AND NOT EXISTS(SELECT 1 FROM telemetry_dependency_windows d WHERE d.trace_id=q.trace_id AND d.key_id=q.key_id)
 ORDER BY q.key_id,q.trace_id LIMIT ${slots.limit}`;
const statements = (slots: { key?: string; limit: string }) => ({
  ids: `DELETE FROM telemetry_dependency_ids WHERE (trace_id,key_id,session_id) IN(${selection(slots, 'ids')})`,
  windows: `DELETE FROM telemetry_dependency_windows WHERE (trace_id,key_id,span_id) IN(${selection(slots, 'windows')})`,
  partitions: `DELETE FROM telemetry_trace_keys WHERE (trace_id,key_id) IN(${empty(slots)})`,
});
const all = statements({ limit: '?1' }),
  one = statements({ key: '?1', limit: '?2' });
const allIds = write<[limit: number]>({ name: 'telemetryPartitions.ids', sql: all.ids });
const allWindows = write<[limit: number]>({ name: 'telemetryPartitions.windows', sql: all.windows });
const allPartitions = write<[limit: number]>({ name: 'telemetryPartitions.empty', sql: all.partitions });
const keyIds = write<[key: string, limit: number]>({ name: 'telemetryPartitions.keyIds', sql: one.ids });
const keyWindows = write<[key: string, limit: number]>({ name: 'telemetryPartitions.keyWindows', sql: one.windows });
const keyPartitions = write<[key: string, limit: number]>({
  name: 'telemetryPartitions.keyEmpty',
  sql: one.partitions,
});
/** Empty work partitions lose their dependency watches before their final row is retired. */
export async function retireTelemetryPartitions(
  db: RelationalStore,
  options: { limit: number; key?: string },
): Promise<void> {
  if (options.key === undefined)
    await commit(db, allIds.bind(options.limit), allWindows.bind(options.limit), allPartitions.bind(options.limit));
  else
    await commit(
      db,
      keyIds.bind(options.key, options.limit),
      keyWindows.bind(options.key, options.limit),
      keyPartitions.bind(options.key, options.limit),
    );
}
