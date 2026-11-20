import type { RelationalStore } from '../../core/adapters.js';
import type { TelemetrySpan } from '../../core/otlp.js';
import {
  TELEMETRY_SPAN_LIMIT,
  TELEMETRY_SPANS_PER_KEY,
  TELEMETRY_SPANS_PER_TRACE,
} from '../../core/telemetry-policy.js';
import { assertion, commit, read, rows, write, refusalCode, refused } from '../index.js';

const keyEnded = refusalCode('telemetry_key_ended');
const liveKey = assertion<[key: string]>({
  name: 'telemetryIngest.liveKey',
  when: 'EXISTS(SELECT 1 FROM telemetry_keys WHERE id=?1 AND revoked_at IS NULL)',
  refusal: keyEnded,
});
const held = read<[payload: string, key: string], { trace_id: string; span_id: string }>({
  name: 'telemetryIngest.held',
  sql: `SELECT s.trace_id,s.span_id FROM json_each(?1) j CROSS JOIN telemetry_spans s
    ON s.trace_id=json_extract(j.value,'$.traceId') AND s.span_id=json_extract(j.value,'$.spanId') WHERE s.key_id=?2`,
});
const fields = {
  trace_id: 'traceId',
  span_id: 'spanId',
  parent_span_id: 'parentSpanId',
  name: 'name',
  kind: 'kind',
  service_name: 'serviceName',
  service_version: 'serviceVersion',
  start_ns: 'startNs',
  end_ns: 'endNs',
  start_ms: 'startMs',
  end_ms: 'endMs',
  conversation_id: 'conversationId',
  agent_name: 'agentName',
  operation: 'operation',
  attributes: 'attributes',
  status: 'status',
};
const insert = write<
  [payload: string, key: string, now: number, capacity: number, traceCapacity: number, keyCapacity: number],
  { trace_id: string; span_id: string }
>({
  name: 'telemetryIngest.spans',
  sql: `WITH incoming AS MATERIALIZED (SELECT j.value,CAST(j.key AS INTEGER) AS ordinal,json_extract(j.value,'$.traceId') AS trace
      FROM json_each(?1) j WHERE NOT EXISTS(SELECT 1 FROM telemetry_spans s
        WHERE s.trace_id=json_extract(j.value,'$.traceId') AND s.span_id=json_extract(j.value,'$.spanId'))),
    counts AS MATERIALIZED (SELECT trace,COALESCE((SELECT spans FROM telemetry_trace_keys q WHERE q.trace_id=i.trace AND q.key_id=?2),0) AS held
      FROM (SELECT DISTINCT trace FROM incoming) i),
    ranked AS (SELECT i.value,c.held,ROW_NUMBER() OVER(PARTITION BY i.trace ORDER BY i.ordinal) AS rank FROM incoming i JOIN counts c ON c.trace=i.trace)
    INSERT INTO telemetry_spans(${Object.keys(fields).join(',')},key_id,received_at)
    SELECT ${Object.values(fields)
      .map((field) => `json_extract(value,'$.${field}')`)
      .join(',')},?2,?3 FROM ranked
    WHERE rank+held<=?5 LIMIT MAX(0,MIN(?4-(SELECT spans FROM telemetry_totals WHERE id=1),?6-(SELECT spans FROM telemetry_keys WHERE id=?2)))
    ON CONFLICT(trace_id,span_id) DO NOTHING RETURNING trace_id,span_id`,
});
const usage = read<[key: string], { spans: number }>({
  name: 'telemetryIngest.usage',
  sql: 'SELECT spans FROM telemetry_keys WHERE id=?1',
});
const touch = write<[key: string, now: number]>({
  name: 'telemetryIngest.touch',
  sql: 'UPDATE telemetry_keys SET last_used_at=?2 WHERE id=?1 AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at<?2)',
});
const count = write<[key: string, hour: number, accepted: number, rejected: number, logs: number, metrics: number]>({
  name: 'telemetryIngest.count',
  sql: `INSERT INTO telemetry_counts(key_id,hour,accepted,rejected,logs,metrics) VALUES(?1,?2,?3,?4,?5,?6)
    ON CONFLICT(key_id,hour) DO UPDATE SET accepted=accepted+excluded.accepted,rejected=rejected+excluded.rejected,
      logs=logs+excluded.logs,metrics=metrics+excluded.metrics`,
});

export const telemetryKeyEnded = (error: unknown): boolean => refused(error, keyEnded);
/** One span insert for the whole request; duplicate ids retain their first key and first immutable facts. */
export async function storeTelemetrySpans(
  db: RelationalStore,
  request: { key: string; spans: readonly TelemetrySpan[]; now: number },
): Promise<{ accepted: number; retained: number; quotaReached: boolean }> {
  const unique = new Map<string, TelemetrySpan>();
  for (const span of request.spans)
    if (!unique.has(`${span.traceId}/${span.spanId}`)) unique.set(`${span.traceId}/${span.spanId}`, span);
  const payload = JSON.stringify([...unique.values()]);
  const already = await rows(db, held.bind(payload, request.key));
  const [, saved] = await commit(
    db,
    liveKey.bind(request.key),
    insert.bind(
      payload,
      request.key,
      request.now,
      TELEMETRY_SPAN_LIMIT,
      TELEMETRY_SPANS_PER_TRACE,
      TELEMETRY_SPANS_PER_KEY,
    ),
    touch.bind(request.key, request.now),
    count.bind(request.key, Math.floor(request.now / 3_600_000), 0, 0, 0, 0),
  );
  const accepted = new Set([...already, ...saved.results].map((row) => `${row.trace_id}/${row.span_id}`));
  return {
    accepted: request.spans.filter((span) => accepted.has(`${span.traceId}/${span.spanId}`)).length,
    retained: saved.results.length,
    quotaReached: (await rows(db, usage.bind(request.key)))[0]!.spans >= TELEMETRY_SPANS_PER_KEY,
  };
}
export async function countTelemetry(
  db: RelationalStore,
  request: { key: string; now: number; accepted?: number; rejected?: number; logs?: number; metrics?: number },
): Promise<void> {
  await commit(
    db,
    liveKey.bind(request.key),
    touch.bind(request.key, request.now),
    count.bind(
      request.key,
      Math.floor(request.now / 3_600_000),
      request.accepted ?? 0,
      request.rejected ?? 0,
      request.logs ?? 0,
      request.metrics ?? 0,
    ),
  );
}
const counts = read<
  [sinceHour: number],
  { key_id: string; accepted: number; rejected: number; logs: number; metrics: number }
>({
  name: 'telemetryIngest.counts',
  sql: `SELECT key_id,SUM(accepted) AS accepted,SUM(rejected) AS rejected,SUM(logs) AS logs,SUM(metrics) AS metrics
    FROM telemetry_counts WHERE hour>=?1 GROUP BY key_id`,
});
export const telemetryCounts = (db: RelationalStore, since: number) =>
  rows(db, counts.bind(Math.floor(since / 3_600_000)));
