import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, rows, write } from '../index.js';
import { settleTelemetryTrace, type Resolution, type TraceRef } from './matching.js';

const ids = write<[trace: string, key: string, ids: string]>({
  name: 'telemetryWaits.ids',
  sql: `INSERT OR IGNORE INTO telemetry_dependency_ids(trace_id,key_id,session_id) SELECT ?1,?2,value FROM json_each(?3)`,
});
const clearIds = write<[trace: string, key: string, ids: string]>({
  name: 'telemetryWaits.clearIds',
  sql: 'DELETE FROM telemetry_dependency_ids WHERE trace_id=?1 AND key_id=?2 AND session_id NOT IN(SELECT value FROM json_each(?3))',
});
const epoch = read<[], { revision: number }>({
  name: 'telemetryWaits.epoch',
  sql: 'SELECT source_revision AS revision FROM telemetry_totals WHERE id=1',
});
async function watchTelemetryTrace(
  db: RelationalStore,
  trace: TraceRef,
  dependencies: { ids: readonly string[] },
): Promise<number> {
  const named = JSON.stringify(dependencies.ids);
  await commit(
    db,
    clearIds.bind(trace.trace_id, trace.key_id, named),
    ids.bind(trace.trace_id, trace.key_id, named),
  );
  return (await rows(db, epoch.bind()))[0]!.revision;
}
const snapshot = read<[trace: string, key: string], TraceRef>({
  name: 'telemetryWaits.snapshot',
  sql: `SELECT t.trace_id,t.received_at,t.last_received_at,t.revision,q.key_id,q.revision AS work_revision FROM telemetry_traces t JOIN telemetry_trace_keys q ON q.trace_id=t.trace_id AND q.key_id=t.key_id WHERE t.trace_id=?1 AND q.key_id=?2`,
});
export const telemetryTraceSnapshot = async (
  db: RelationalStore,
  trace: TraceRef,
): Promise<TraceRef | undefined> => (await rows(db, snapshot.bind(trace.trace_id, trace.key_id)))[0];

/** Registers dependencies before reading them and fences settlement against their source version. */
export async function withTelemetryInputs(
  db: RelationalStore,
  options: {
    trace: TraceRef;
    now: number;
    dependencies: { ids: readonly string[] };
  },
  derive: () => Promise<{ resolutions: Resolution[]; pending: boolean }>,
): Promise<number> {
  const epoch = await watchTelemetryTrace(db, options.trace, options.dependencies),
    result = await derive();
  await watchTelemetryTrace(db, options.trace, {
    ...options.dependencies,
    ids: [...new Set([...options.dependencies.ids, ...result.resolutions.map((row) => row.session_id)])],
  });
  await settleTelemetryTrace(db, options.trace, result.resolutions, {
    now: options.now,
    epoch,
    pending: result.pending,
  });
  return result.resolutions.length;
}
