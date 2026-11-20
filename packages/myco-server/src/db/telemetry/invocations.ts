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
  [project: string, session: string, after: number, trace: string, span: string, limit: number],
  InvocationFact
>({
  name: 'telemetryInvocations.session',
  sql: `SELECT r.trace_id AS traceId,r.span_id AS spanId,r.key_id AS keyId,k.label AS keyLabel,s.service_name AS serviceName,s.agent_name AS agentName,
    s.start_ms AS startAt,s.end_ms AS endAt,r.matched_by AS matchedBy
    FROM telemetry_resolutions r JOIN telemetry_spans s ON s.trace_id=r.trace_id AND s.span_id=r.span_id
    JOIN sessions session ON session.project_id=r.project_id AND session.session_id=r.session_id
    JOIN telemetry_keys k ON k.id=r.key_id AND k.revoked_at IS NULL
    WHERE r.project_id=?1 AND r.session_id=?2 AND r.invocation=1 AND ${liveResolution('r')} AND ${notTombstonedSql('session')}
      AND (s.start_ms,r.trace_id,r.span_id)>(?3,?4,?5) ORDER BY s.start_ms,r.trace_id,r.span_id LIMIT ?6`,
});

/** Stored invocation windows, in sender time, for this exact Project/session. No prompt text or person identity. */
export async function invocationRows(
  db: RelationalStore,
  request: { projectId: string; sessionId: string; after: number; trace: string; span: string; limit: number },
): Promise<InvocationFact[]> {
  return rows(
    db,
    invocations.bind(request.projectId, request.sessionId, request.after, request.trace, request.span, request.limit),
  );
}
