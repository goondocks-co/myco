import { retireTelemetryPartitions } from './partitions.js';
import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, rows, write } from '../index.js';
import { TELEMETRY_RESOLUTION_PAGE } from '../../core/telemetry-policy.js';

const next = read<[], { id: string }>({
  name: 'telemetryRevocation.next',
  sql: 'SELECT id FROM telemetry_keys WHERE revoked_at IS NOT NULL AND cleanup_done=0 ORDER BY revoked_at,id LIMIT 1',
});
const affected = read<[key: string, limit: number], { trace_id: string; span_id: string }>({
  name: 'telemetryRevocation.affected',
  sql: 'SELECT trace_id,span_id FROM telemetry_resolution_keys WHERE key_id=?1 ORDER BY trace_id,span_id LIMIT ?2',
});
const mark = write<[rows: string]>({
  name: 'telemetryRevocation.mark',
  sql: `UPDATE telemetry_trace_keys SET next_check=0,revision=revision+1 WHERE (trace_id,key_id) IN(
 SELECT r.trace_id,r.key_id FROM json_each(?1) j JOIN telemetry_resolutions r ON r.trace_id=json_extract(j.value,'$.trace_id') AND r.span_id=json_extract(j.value,'$.span_id'))`,
});
const remove = write<[rows: string]>({
  name: 'telemetryRevocation.remove',
  sql: `DELETE FROM telemetry_resolutions WHERE (trace_id,span_id) IN(SELECT json_extract(value,'$.trace_id'),json_extract(value,'$.span_id') FROM json_each(?1))`,
});
const spans = write<[key: string, limit: number], { span_id: string }>({
  name: 'telemetryRevocation.spans',
  sql: 'DELETE FROM telemetry_spans WHERE (trace_id,span_id) IN(SELECT trace_id,span_id FROM telemetry_spans WHERE key_id=?1 ORDER BY trace_id,span_id LIMIT ?2) RETURNING span_id',
});
const counts = write<[key: string, limit: number], { hour: number }>({
  name: 'telemetryRevocation.counts',
  sql: 'DELETE FROM telemetry_counts WHERE (key_id,hour) IN(SELECT key_id,hour FROM telemetry_counts WHERE key_id=?1 ORDER BY hour LIMIT ?2) RETURNING hour',
});
const finish = write<[key: string]>({
  name: 'telemetryRevocation.finish',
  sql: `UPDATE telemetry_keys SET cleanup_done=1 WHERE id=?1 AND revoked_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM telemetry_spans WHERE key_id=?1)
 AND NOT EXISTS(SELECT 1 FROM telemetry_resolution_keys WHERE key_id=?1) AND NOT EXISTS(SELECT 1 FROM telemetry_counts WHERE key_id=?1) AND NOT EXISTS(SELECT 1 FROM telemetry_trace_keys WHERE key_id=?1)`,
});
export async function cleanRevokedTelemetry(db: RelationalStore): Promise<number> {
  const key = (await rows(db, next.bind()))[0];
  if (key === undefined) return 0;
  const dependencies = await rows(db, affected.bind(key.id, TELEMETRY_RESOLUTION_PAGE));
  if (dependencies.length > 0) {
    const payload = JSON.stringify(dependencies);
    await commit(db, mark.bind(payload), remove.bind(payload));
    return dependencies.length;
  }
  await retireTelemetryPartitions(db, { key: key.id, limit: TELEMETRY_RESOLUTION_PAGE });
  const [removed] = await commit(
    db,
    spans.bind(key.id, TELEMETRY_RESOLUTION_PAGE),
    counts.bind(key.id, TELEMETRY_RESOLUTION_PAGE),
    finish.bind(key.id),
  );
  return removed.results.length;
}
export const revokedTelemetryDue = async (db: RelationalStore): Promise<boolean> =>
  (await rows(db, next.bind())).length > 0;
