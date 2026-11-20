import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, rows } from '../index.js';
import { notTombstonedSql } from '../session-read-model.js';
import { firstPromptSql, PRESENTED_ENDED_AT, PRESENTED_STARTED_AT } from './browse.js';

export interface SessionPair { projectId: string; sessionId: string }
export interface TelemetryLineageEdge {
  parentProjectId: string; parentId: string; childProjectId: string; childId: string; serviceName: string | null; inferred: number;
}
/** One preferred assertion per child; captured baggage always has authority over telemetry. */
const preferred = (project: string, session: string) => `(SELECT preferred.trace_id,preferred.span_id FROM telemetry_resolutions preferred INDEXED BY idx_telemetry_resolutions_links
  WHERE preferred.project_id=${project} AND preferred.session_id=${session} AND preferred.parent_session_id IS NOT NULL
  ORDER BY preferred.matched_by,preferred.trace_id,preferred.span_id LIMIT 1)`;
const keys = `SELECT json_extract(value,'$.projectId') AS project_id,json_extract(value,'$.sessionId') AS session_id FROM json_each(?1)`;
const incident = (name: string, on: string) => read<[pairs: string, limit: number], TelemetryLineageEdge>({ name, sql:
  `SELECT r.parent_project_id AS parentProjectId,r.parent_session_id AS parentId,r.project_id AS childProjectId,r.session_id AS childId,
      span.service_name AS serviceName,(r.matched_by='inferred') AS inferred
    FROM (${keys}) key CROSS JOIN telemetry_resolutions r ON ${on}
    JOIN sessions child ON child.project_id=r.project_id AND child.session_id=r.session_id
    JOIN sessions parent ON parent.project_id=r.parent_project_id AND parent.session_id=r.parent_session_id
    JOIN telemetry_spans span ON span.trace_id=r.trace_id AND span.span_id=r.span_id
    JOIN telemetry_keys k ON k.id=r.key_id AND k.revoked_at IS NULL
    WHERE child.launch_parent_session_id IS NULL AND ${notTombstonedSql('child')} AND ${notTombstonedSql('parent')}
      AND (r.trace_id,r.span_id)=${preferred('r.project_id', 'r.session_id')}
    ORDER BY r.parent_project_id,r.parent_session_id,r.project_id,r.session_id LIMIT ?2` });
const parents = incident('telemetryLineage.parents', `(r.trace_id,r.span_id)=${preferred('key.project_id', 'key.session_id')}`);
const children = incident('telemetryLineage.children', 'r.parent_project_id=key.project_id AND r.parent_session_id=key.session_id');
export async function telemetryLineageEdges(db: RelationalStore, pairs: readonly SessionPair[], limit: number): Promise<TelemetryLineageEdge[]> {
  const payload = JSON.stringify(pairs);
  const [up, down] = await readSet(db, parents.bind(payload, limit), children.bind(payload, limit));
  const unique = new Map([...up, ...down].map(edge => [JSON.stringify([edge.parentProjectId, edge.parentId, edge.childProjectId, edge.childId]), edge]));
  return [...unique.values()];
}
export interface TelemetryLineageSession {
  projectId: string; sessionId: string; label: string | null; firstPrompt: string | null; agent: string | null; startedAt: number | null; endedAt: number | null;
}
const named = read<[pairs: string], TelemetryLineageSession>({ name: 'telemetryLineage.named', sql:
  `SELECT s.project_id AS projectId,s.session_id AS sessionId,s.title AS label,${firstPromptSql('s')} AS firstPrompt,s.agent,
    ${PRESENTED_STARTED_AT} AS startedAt,${PRESENTED_ENDED_AT} AS endedAt FROM (${keys}) key
    CROSS JOIN sessions s ON s.project_id=key.project_id AND s.session_id=key.session_id WHERE ${notTombstonedSql('s')}` });
export const telemetryLineageSessions = (db: RelationalStore, pairs: readonly SessionPair[]) => rows(db, named.bind(JSON.stringify(pairs)));
