import type { RelationalStore } from '../../core/adapters.js';
import { read, rows, write, commit } from '../index.js';
import { TELEMETRY_DAY_MS, TELEMETRY_HOUR_MS, TELEMETRY_RETENTION_MS } from '../../core/telemetry-policy.js';
export interface TelemetryWork {
  keys: number;
  work_due: number | null;
  wake_revision: number;
}
export const workStatus = read<[], TelemetryWork>({
  name: 'telemetryWork.status',
  sql: 'SELECT keys,work_due,wake_revision FROM telemetry_totals WHERE id=1',
});
export const telemetryWork = async (db: RelationalStore) => (await rows(db, workStatus.bind()))[0]!;
export const isTelemetryWorkDue = (state: TelemetryWork, now: number): boolean =>
  state.keys > 0 && state.work_due !== null && state.work_due <= now;
export const telemetryWorkDue = async (db: RelationalStore, now: number) =>
  isTelemetryWorkDue(await telemetryWork(db), now);
const UNSCHEDULED = Number.MAX_SAFE_INTEGER;
const deadline = `CASE WHEN EXISTS(SELECT 1 FROM telemetry_keys WHERE revoked_at IS NOT NULL AND cleanup_done=0)
 OR EXISTS(SELECT 1 FROM telemetry_session_changes) OR EXISTS(SELECT 1 FROM telemetry_trace_keys WHERE spans=0)
 OR EXISTS(SELECT 1 FROM telemetry_traces WHERE spans=0) THEN 0 ELSE NULLIF(MIN(
 COALESCE((SELECT MIN(next_check) FROM telemetry_trace_keys WHERE next_check IS NOT NULL AND spans>0),${UNSCHEDULED}),
 COALESCE((SELECT MIN(received_at)+${TELEMETRY_RETENTION_MS} FROM telemetry_spans),${UNSCHEDULED}),
 COALESCE((SELECT MIN(hour)*${TELEMETRY_HOUR_MS}+${TELEMETRY_DAY_MS}+${TELEMETRY_HOUR_MS} FROM telemetry_counts),${UNSCHEDULED})),${UNSCHEDULED}) END`;
const refresh = write<[]>({
  name: 'telemetryWork.refresh',
  sql: `UPDATE telemetry_totals SET work_due=${deadline} WHERE id=1 AND work_due IS NOT (${deadline})`,
});
/** The final operation of a work pass publishes its next source deadline from current rows. */
export const refreshTelemetryWork = async (db: RelationalStore) => {
  await commit(db, refresh.bind());
};
