import { liveResolution } from './authority.js';
import type { RelationalStore } from '../../core/adapters.js';
import { read, rows } from '../index.js';
import { notTombstonedSql } from '../session-read-model.js';

export interface InvocationFact {
  traceId: string;
  spanId: string;
  keyId: string;
  keyLabel: string;
  serviceName: string | null;
  agentName: string | null;
  startAt: number;
  endAt: number;
  matchedBy: 'exact' | 'inferred';
}
const invocations = read<
  [project: string, session: string, after: number, trace: string, span: string, key: string, limit: number],
  InvocationFact
>({
  name: 'telemetryInvocations.session',
  sql: `SELECT r.trace_id AS traceId,r.span_id AS spanId,r.key_id AS keyId,k.label AS keyLabel,s.service_name AS serviceName,s.agent_name AS agentName,
    s.start_ms AS startAt,s.end_ms AS endAt,r.matched_by AS matchedBy
    FROM telemetry_resolutions r JOIN telemetry_spans s ON s.key_id=r.key_id AND s.trace_id=r.trace_id AND s.span_id=r.span_id
    JOIN sessions session ON session.project_id=r.project_id AND session.session_id=r.session_id
    JOIN telemetry_keys k ON k.id=r.key_id AND k.revoked_at IS NULL
    WHERE r.project_id=?1 AND r.session_id=?2 AND r.invocation=1 AND ${liveResolution('r')} AND ${notTombstonedSql('session')}
      AND (r.started_at,r.trace_id,r.span_id,r.key_id)>(?3,?4,?5,?6) ORDER BY r.started_at,r.trace_id,r.span_id,r.key_id LIMIT ?7`,
});

/** Stored invocation windows, in sender time, for this exact Project/session. No prompt text or person identity. */
export async function invocationRows(
  db: RelationalStore,
  request: {
    projectId: string;
    sessionId: string;
    after: number;
    trace: string;
    span: string;
    key: string;
    limit: number;
  },
): Promise<InvocationFact[]> {
  return rows(
    db,
    invocations.bind(
      request.projectId,
      request.sessionId,
      request.after,
      request.trace,
      request.span,
      request.key,
      request.limit,
    ),
  );
}

export interface InvocationDisplayFact {
  startAt: number;
  endAt: number;
  matchedBy: 'exact' | 'inferred';
  keyLabel: string;
  serviceName: string | null;
  agentName: string | null;
}
const windows = read<
  [project: string, session: string, starts: string, tolerance: number],
  InvocationDisplayFact
>({
  name: 'telemetryInvocations.turnWindows',
  sql: `WITH wanted AS (SELECT DISTINCT r.key_id,r.trace_id,r.span_id FROM json_each(?3) head
 CROSS JOIN telemetry_resolutions r INDEXED BY idx_telemetry_invocation_window ON r.project_id=?1 AND r.session_id=?2
 AND r.invocation=1 AND r.started_at BETWEEN head.value-?4 AND head.value+?4)
 SELECT s.start_ms AS startAt,s.end_ms AS endAt,r.matched_by AS matchedBy,k.label AS keyLabel,s.service_name AS serviceName,s.agent_name AS agentName
 FROM wanted w JOIN telemetry_resolutions r ON r.key_id=w.key_id AND r.trace_id=w.trace_id AND r.span_id=w.span_id
 JOIN telemetry_spans s ON s.key_id=r.key_id AND s.trace_id=r.trace_id AND s.span_id=r.span_id
 JOIN telemetry_keys k ON k.id=r.key_id AND k.revoked_at IS NULL
 JOIN sessions session ON session.project_id=r.project_id AND session.session_id=r.session_id
 WHERE ${notTombstonedSql('session')}
 ORDER BY s.start_ms,r.key_id,r.trace_id,r.span_id`,
});
/** Includes every competing fact for these turn heads; no session page cursor can hide ambiguity. */
export const invocationFactsForTurns = (
  db: RelationalStore,
  options: { projectId: string; sessionId: string; starts: readonly number[]; tolerance: number },
) =>
  rows(
    db,
    windows.bind(options.projectId, options.sessionId, JSON.stringify(options.starts), options.tolerance),
  );
