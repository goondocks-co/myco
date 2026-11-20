import type { RelationalStore } from '../../core/adapters.js';
import { TELEMETRY_DAY_MS, TELEMETRY_RETENTION_MS } from '../../core/telemetry-policy.js';
import { commit, write } from '../index.js';

const spans = write<[before: number, limit: number], { span_id: string }>({ name: 'telemetryRetention.spans', sql:
  `DELETE FROM telemetry_spans WHERE (trace_id,span_id) IN (SELECT trace_id,span_id FROM telemetry_spans
    WHERE received_at<?1 ORDER BY received_at,trace_id,span_id LIMIT ?2) RETURNING span_id` });
const traces = write<[before: number, limit: number]>({ name: 'telemetryRetention.traces', sql:
  `DELETE FROM telemetry_traces WHERE trace_id IN (SELECT trace_id FROM telemetry_traces
    WHERE next_check<?1 AND NOT EXISTS(SELECT 1 FROM telemetry_spans s WHERE s.trace_id=telemetry_traces.trace_id)
    ORDER BY next_check,trace_id LIMIT ?2)` });
const counts = write<[hour: number, limit: number]>({ name: 'telemetryRetention.counts', sql:
  `DELETE FROM telemetry_counts WHERE (key_id,hour) IN (SELECT key_id,hour FROM telemetry_counts WHERE hour<?1 ORDER BY hour,key_id LIMIT ?2)` });
export async function pruneTelemetry(db: RelationalStore, now: number, limit: number): Promise<number> {
  const [removed] = await commit(db, spans.bind(now - TELEMETRY_RETENTION_MS, limit), traces.bind(now, limit),
    counts.bind(Math.floor((now - TELEMETRY_DAY_MS) / 3_600_000), limit));
  return removed.results.length;
}
