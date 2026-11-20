import { retireTelemetryPartitions } from './partitions.js';
import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, rows, write } from '../index.js';
import { TELEMETRY_RESOLUTION_PAGE } from '../../core/telemetry-policy.js';

const next = read<[], { id: string }>({
  name: 'telemetryRevocation.next',
  sql: 'SELECT id FROM telemetry_keys WHERE revoked_at IS NOT NULL AND cleanup_done=0 ORDER BY revoked_at,id LIMIT 1',
});
const resolutions = write<[key: string, limit: number], { span_id: string }>({
  name: 'telemetryRevocation.resolutions',
  sql: `DELETE FROM telemetry_resolutions WHERE (key_id,trace_id,span_id) IN(
 SELECT key_id,trace_id,span_id FROM telemetry_resolutions WHERE key_id=?1 ORDER BY trace_id,span_id LIMIT ?2) RETURNING span_id`,
});
const traces = write<[key: string, limit: number]>({
  name: 'telemetryRevocation.traces',
  sql: `DELETE FROM telemetry_traces WHERE (key_id,trace_id) IN(
 SELECT key_id,trace_id FROM telemetry_traces t WHERE key_id=?1 AND spans=0
 AND NOT EXISTS(SELECT 1 FROM telemetry_trace_keys q WHERE q.key_id=t.key_id AND q.trace_id=t.trace_id) LIMIT ?2)`,
});
const spans = write<[key: string, limit: number], { span_id: string }>({
  name: 'telemetryRevocation.spans',
  sql: 'DELETE FROM telemetry_spans WHERE (key_id,trace_id,span_id) IN(SELECT key_id,trace_id,span_id FROM telemetry_spans WHERE key_id=?1 ORDER BY trace_id,span_id LIMIT ?2) RETURNING span_id',
});
const counts = write<[key: string, limit: number], { hour: number }>({
  name: 'telemetryRevocation.counts',
  sql: 'DELETE FROM telemetry_counts WHERE (key_id,hour) IN(SELECT key_id,hour FROM telemetry_counts WHERE key_id=?1 ORDER BY hour LIMIT ?2) RETURNING hour',
});
const finish = write<[key: string]>({
  name: 'telemetryRevocation.finish',
  sql: `UPDATE telemetry_keys SET cleanup_done=1 WHERE id=?1 AND revoked_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM telemetry_spans WHERE key_id=?1)
 AND NOT EXISTS(SELECT 1 FROM telemetry_counts WHERE key_id=?1) AND NOT EXISTS(SELECT 1 FROM telemetry_trace_keys WHERE key_id=?1) AND NOT EXISTS(SELECT 1 FROM telemetry_traces WHERE key_id=?1)`,
});
export async function cleanRevokedTelemetry(db: RelationalStore): Promise<number> {
  const key = (await rows(db, next.bind()))[0];
  if (key === undefined) return 0;
  const [facts] = await commit(db, resolutions.bind(key.id, TELEMETRY_RESOLUTION_PAGE));
  if (facts.results.length > 0) return facts.results.length;
  await retireTelemetryPartitions(db, { key: key.id, limit: TELEMETRY_RESOLUTION_PAGE });
  const [removed] = await commit(
    db,
    spans.bind(key.id, TELEMETRY_RESOLUTION_PAGE),
    counts.bind(key.id, TELEMETRY_RESOLUTION_PAGE),
    traces.bind(key.id, TELEMETRY_RESOLUTION_PAGE),
    finish.bind(key.id),
  );
  return removed.results.length;
}
export const revokedTelemetryDue = async (db: RelationalStore): Promise<boolean> =>
  (await rows(db, next.bind())).length > 0;
