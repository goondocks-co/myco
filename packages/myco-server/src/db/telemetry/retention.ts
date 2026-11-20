import type { RelationalStore } from '../../core/adapters.js';
import { TELEMETRY_DAY_MS, TELEMETRY_RETENTION_MS } from '../../core/telemetry-policy.js';
import { commit, read, rows, write } from '../index.js';
import { retireTelemetryPartitions } from './partitions.js';

const expiredSpans = (before: string, limit: string) =>
  `SELECT trace_id,span_id FROM telemetry_spans WHERE received_at<${before} ORDER BY received_at,trace_id,span_id LIMIT ${limit}`;
const emptyTraces = (limit: string) =>
  `SELECT trace_id FROM telemetry_traces t WHERE spans=0 AND NOT EXISTS(SELECT 1 FROM telemetry_trace_keys q WHERE q.trace_id=t.trace_id) ORDER BY trace_id LIMIT ${limit}`;
const expiredCounts = (hour: string, limit: string) =>
  `SELECT key_id,hour FROM telemetry_counts WHERE hour<${hour} ORDER BY hour,key_id LIMIT ${limit}`;
const spans = write<[before: number, limit: number], { span_id: string }>({
  name: 'telemetryRetention.spans',
  sql: `DELETE FROM telemetry_spans WHERE (trace_id,span_id) IN(${expiredSpans('?1', '?2')}) RETURNING span_id`,
});
const traces = write<[limit: number]>({
  name: 'telemetryRetention.traces',
  sql: `DELETE FROM telemetry_traces WHERE trace_id IN(${emptyTraces('?1')})`,
});
const counts = write<[hour: number, limit: number]>({
  name: 'telemetryRetention.counts',
  sql: `DELETE FROM telemetry_counts WHERE (key_id,hour) IN(${expiredCounts('?1', '?2')})`,
});
export async function pruneTelemetry(db: RelationalStore, now: number, limit: number): Promise<number> {
  const [removed] = await commit(
    db,
    spans.bind(now - TELEMETRY_RETENTION_MS, limit),
    counts.bind(Math.floor((now - TELEMETRY_DAY_MS) / 3_600_000), limit),
  );
  await retireTelemetryPartitions(db, { limit });
  await commit(db, traces.bind(limit));
  return removed.results.length;
}
const pending = read<[before: number, hour: number], { due: number }>({
  name: 'telemetryRetention.due',
  sql: `SELECT 1 AS due FROM (${expiredSpans('?1', '1')}) UNION ALL SELECT 1 FROM (${emptyTraces('1')})
 UNION ALL SELECT 1 FROM (${expiredCounts('?2', '1')}) UNION ALL SELECT 1 FROM (SELECT trace_id FROM telemetry_trace_keys WHERE spans=0 LIMIT 1) LIMIT 1`,
});
export const telemetryRetentionDue = async (db: RelationalStore, now: number): Promise<boolean> =>
  (await rows(db, pending.bind(now - TELEMETRY_RETENTION_MS, Math.floor((now - TELEMETRY_DAY_MS) / 3_600_000))))
    .length > 0;
