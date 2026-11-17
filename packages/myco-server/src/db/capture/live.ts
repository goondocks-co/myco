import { read } from '../index.js';

export const LIVE_CAPTURE_FIELDS = ['last_live_received_at', 'last_trust_start_at'] as const;
type LiveCaptureField = typeof LIVE_CAPTURE_FIELDS[number];
type LiveCaptureTable = 'sessions' | 'machine_capture_heads';

/** Null is absence; zero remains a captured instant. */
export function liveEvidenceMax(table: LiveCaptureTable, column: LiveCaptureField): string {
  return `CASE WHEN ${table}.${column} IS NULL THEN excluded.${column}
    WHEN excluded.${column} IS NULL THEN ${table}.${column} ELSE MAX(${table}.${column},excluded.${column}) END`;
}

export function liveEvidenceAdvances(table: LiveCaptureTable, column: LiveCaptureField): string {
  return `(excluded.${column} IS NOT NULL AND (${table}.${column} IS NULL OR excluded.${column}>${table}.${column}))`;
}

/** Machine heads and unclaimed legacy sessions jointly cover all live capture. */
const latest = read<[], { at: number | null }>({ name: 'meta.captureMark', sql: `SELECT MAX(at) AS at FROM (
  SELECT MAX(last_live_received_at) AS at FROM machine_capture_heads
  UNION ALL SELECT MAX(last_live_received_at) AS at FROM sessions INDEXED BY idx_sessions_unclaimed_live
    WHERE machine_id IS NULL AND last_live_received_at IS NOT NULL)` });

export const latestLiveCapture = () => latest.bind();
