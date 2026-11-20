import { liveGenerationSql } from '../documents/live-generation.js';
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
    JOIN telemetry_keys k ON k.id=r.key_id
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

const sessionWindows = read<[project: string, session: string, tolerance: number], InvocationDisplayFact>({
  name: 'telemetryInvocations.sessionTurnWindows',
  sql: `SELECT s.start_ms AS startAt,s.end_ms AS endAt,r.matched_by AS matchedBy,k.label AS keyLabel,s.service_name AS serviceName,s.agent_name AS agentName
 FROM telemetry_resolutions r INDEXED BY idx_telemetry_invocation_window
 JOIN telemetry_spans s ON s.key_id=r.key_id AND s.trace_id=r.trace_id AND s.span_id=r.span_id
 JOIN telemetry_keys k ON k.id=r.key_id
 JOIN sessions session ON session.project_id=r.project_id AND session.session_id=r.session_id
 WHERE r.project_id=?1 AND r.session_id=?2 AND r.invocation=1 AND ${liveResolution('r')} AND ${notTombstonedSql('session')}
 AND EXISTS(SELECT 1 FROM session_prompts p INDEXED BY idx_session_prompts_telemetry_time
 WHERE p.project_id=?1 AND p.session_id=?2 AND p.generation=${liveGenerationSql('?1', '?2')} AND p.turn_key=p.prompt_id
 AND p.created_at BETWEEN r.started_at-?3 AND r.started_at+?3)
 ORDER BY r.started_at,r.trace_id,r.span_id,r.key_id`,
});
/** Every competing fact whose start is near a live turn head, independently of session pagination. */
export const sessionTurnInvocationFacts = (
  db: RelationalStore,
  options: { projectId: string; sessionId: string; tolerance: number },
) => rows(db, sessionWindows.bind(options.projectId, options.sessionId, options.tolerance));
