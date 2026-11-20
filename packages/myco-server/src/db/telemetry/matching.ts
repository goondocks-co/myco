import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, read, readSet, rows, write, refused, refusalCode } from '../index.js';
import { notTombstonedSql } from '../session-read-model.js';
import {
  TELEMETRY_MATCH_WAIT_MS,
  TELEMETRY_RESOLUTION_PAGE,
  TELEMETRY_TRACE_PAGE,
} from '../../core/telemetry-policy.js';

export interface TraceRef {
  trace_id: string;
  received_at: number;
  last_received_at: number;
  key_id: string;
  revision: number;
  work_revision: number;
}
export interface StoredSpan {
  trace_id: string;
  span_id: string;
  key_id: string;
  parent_span_id: string | null;
  service_name: string | null;
  conversation_id: string | null;
  agent_name: string | null;
  operation: string | null;
  attributes: string;
  start_ms: number;
  end_ms: number;
  received_at: number;
}
export interface SessionIdentity {
  project_id: string;
  session_id: string;
}
export interface Resolution extends SessionIdentity {
  span_id: string;
  key_id: string;
  parent_span_id: string | null;
  parent_project_id: string | null;
  parent_session_id: string | null;
  matched_by: 'exact';
  invocation: number;
  repository: string | null;
  ref: string | null;
  agent_name: string | null;
}
const due = read<[now: number, limit: number], TraceRef>({
  name: 'telemetryMatching.due',
  sql: `SELECT t.trace_id,t.received_at,t.last_received_at,t.revision,q.key_id,q.revision AS work_revision
 FROM telemetry_trace_keys q INDEXED BY idx_telemetry_trace_key_due
 JOIN telemetry_keys k ON k.id=q.key_id AND k.revoked_at IS NULL
 JOIN telemetry_traces t ON t.trace_id=q.trace_id AND t.key_id=q.key_id
 WHERE q.spans>0 AND q.next_check IS NOT NULL AND q.next_check<=?1 ORDER BY q.next_check,q.key_id,q.trace_id LIMIT ?2`,
});
const spans = read<[trace: string, key: string], StoredSpan>({
  name: 'telemetryMatching.spans',
  sql: `SELECT s.trace_id,s.span_id,s.key_id,s.parent_span_id,s.service_name,s.conversation_id,s.agent_name,s.operation,
 s.attributes,s.start_ms,s.end_ms,s.received_at FROM telemetry_spans s
 JOIN telemetry_keys k ON k.id=s.key_id AND k.revoked_at IS NULL WHERE s.key_id=?2 AND s.trace_id=?1 ORDER BY s.span_id`,
});
const sessions = read<[ids: string], SessionIdentity>({
  name: 'telemetryMatching.sessions',
  sql: `SELECT s.project_id,s.session_id FROM json_each(?1) j CROSS JOIN sessions s INDEXED BY idx_sessions_telemetry_id ON s.session_id=j.value
    WHERE ${notTombstonedSql('s')} ORDER BY s.session_id,s.project_id`,
});

const uniqueSession = (
  id: string,
) => `(SELECT COUNT(*) FROM (SELECT s.project_id FROM sessions s INDEXED BY idx_sessions_telemetry_id
  WHERE s.session_id=${id} AND ${notTombstonedSql('s')} LIMIT 2))=1`;
const clear = write<[trace: string, key: string, payload: string]>({
  name: 'telemetryMatching.clear',
  sql: `DELETE FROM telemetry_resolutions WHERE trace_id=?1 AND key_id=?2 AND span_id NOT IN(SELECT json_extract(value,'$.span_id') FROM json_each(?3))`,
});
const put = write<[trace: string, key: string, payload: string]>({
  name: 'telemetryMatching.put',
  sql: `INSERT INTO telemetry_resolutions(trace_id,span_id,key_id,project_id,session_id,parent_project_id,parent_session_id,parent_span_id,matched_by,invocation,repository,ref,agent_name,service_name,reported_at,started_at)
    SELECT ?1,json_extract(j.value,'$.span_id'),span.key_id,s.project_id,s.session_id,
      json_extract(j.value,'$.parent_project_id'),json_extract(j.value,'$.parent_session_id'),json_extract(j.value,'$.parent_span_id'),'exact',json_extract(j.value,'$.invocation'),json_extract(j.value,'$.repository'),json_extract(j.value,'$.ref'),span.agent_name,span.service_name,span.received_at,span.start_ms
    FROM json_each(?3) j JOIN telemetry_spans span ON span.trace_id=?1 AND span.key_id=?2 AND span.span_id=json_extract(j.value,'$.span_id') AND span.key_id=json_extract(j.value,'$.key_id')
    JOIN telemetry_keys k ON k.id=span.key_id AND k.revoked_at IS NULL
    JOIN sessions s ON s.project_id=json_extract(j.value,'$.project_id') AND s.session_id=json_extract(j.value,'$.session_id')
    WHERE ${notTombstonedSql('s')}
      AND span.conversation_id=s.session_id AND ${uniqueSession('span.conversation_id')}
      AND (json_extract(j.value,'$.parent_session_id') IS NULL OR EXISTS(
      SELECT 1 FROM sessions parent JOIN telemetry_spans ancestor ON ancestor.trace_id=span.trace_id AND ancestor.key_id=span.key_id
        AND ancestor.span_id=json_extract(j.value,'$.parent_span_id') AND ancestor.conversation_id=parent.session_id
      WHERE ${uniqueSession('ancestor.conversation_id')} AND parent.project_id=json_extract(j.value,'$.parent_project_id')
        AND parent.session_id=json_extract(j.value,'$.parent_session_id') AND ${notTombstonedSql('parent')}))
 ON CONFLICT(key_id,trace_id,span_id) DO UPDATE SET project_id=excluded.project_id,session_id=excluded.session_id,parent_project_id=excluded.parent_project_id,
 parent_session_id=excluded.parent_session_id,parent_span_id=excluded.parent_span_id,matched_by=excluded.matched_by,invocation=excluded.invocation,
 repository=excluded.repository,ref=excluded.ref,agent_name=excluded.agent_name,service_name=excluded.service_name,reported_at=excluded.reported_at,started_at=excluded.started_at
 WHERE (project_id,session_id,COALESCE(parent_project_id,''),COALESCE(parent_session_id,''),COALESCE(parent_span_id,''),matched_by,invocation,COALESCE(repository,''),COALESCE(ref,''),COALESCE(agent_name,''))
 IS NOT (excluded.project_id,excluded.session_id,COALESCE(excluded.parent_project_id,''),COALESCE(excluded.parent_session_id,''),COALESCE(excluded.parent_span_id,''),excluded.matched_by,excluded.invocation,COALESCE(excluded.repository,''),COALESCE(excluded.ref,''),COALESCE(excluded.agent_name,''))`,
});
const checked = write<[trace: string, key: string, next: number | null]>({
  name: 'telemetryMatching.checked',
  sql: 'UPDATE telemetry_trace_keys SET next_check=?3 WHERE trace_id=?1 AND key_id=?2',
});

export const telemetryTracesDue = (db: RelationalStore, now: number) =>
  rows(db, due.bind(now, TELEMETRY_TRACE_PAGE));
export const telemetryTraceSpans = (db: RelationalStore, trace: TraceRef) =>
  rows(db, spans.bind(trace.trace_id, trace.key_id));
const SESSION_LOOKUP_PAGE = 256;
export const telemetrySessionsNamed = async (
  db: RelationalStore,
  ids: readonly string[],
): Promise<SessionIdentity[]> => {
  const pages = [];
  for (let offset = 0; offset < ids.length; offset += SESSION_LOOKUP_PAGE)
    pages.push(sessions.bind(JSON.stringify(ids.slice(offset, offset + SESSION_LOOKUP_PAGE))));
  return pages.length === 0 ? [] : (await readSet(db, ...pages)).flat();
};
export async function settleTelemetryTrace(
  db: RelationalStore,
  trace: TraceRef,
  resolutions: readonly Resolution[],
  options: { now: number; pending: boolean; epoch: number },
): Promise<void> {
  const payload = JSON.stringify(resolutions),
    writes = [];
  for (let offset = 0; offset < resolutions.length; offset += TELEMETRY_RESOLUTION_PAGE)
    writes.push(
      put.bind(
        trace.trace_id,
        trace.key_id,
        JSON.stringify(resolutions.slice(offset, offset + TELEMETRY_RESOLUTION_PAGE)),
      ),
    );
  await commit(
    db,
    unchanged.bind(trace.trace_id, trace.revision, trace.key_id, trace.work_revision, options.epoch),
    clear.bind(trace.trace_id, trace.key_id, payload),
    ...writes,
    checked.bind(
      trace.trace_id,
      trace.key_id,
      options.pending ? Math.max(options.now, trace.last_received_at + TELEMETRY_MATCH_WAIT_MS) : null,
    ),
  );
}

const snapshotChanged = refusalCode('telemetry_snapshot_changed');
const unchanged = assertion<
  [trace: string, revision: number, key: string, workRevision: number, epoch: number]
>({
  name: 'telemetryMatching.unchanged',
  when: 'EXISTS(SELECT 1 FROM telemetry_traces t JOIN telemetry_trace_keys q ON q.trace_id=t.trace_id AND q.key_id=t.key_id WHERE t.trace_id=?1 AND t.revision=?2 AND q.key_id=?3 AND q.revision=?4) AND (SELECT source_revision FROM telemetry_totals WHERE id=1)=?5',
  refusal: snapshotChanged,
});
export const telemetrySnapshotChanged = (error: unknown): boolean => refused(error, snapshotChanged);

export const telemetryReconciliationDue = async (db: RelationalStore, now: number): Promise<boolean> =>
  (await rows(db, due.bind(now, 1))).length > 0;
const dropUnresolved = write<[trace: string, key: string, revision: number, before: number]>({
  name: 'telemetryMatching.dropUnresolved',
  sql: `DELETE FROM telemetry_spans WHERE trace_id=?1 AND key_id=?2 AND EXISTS(SELECT 1 FROM telemetry_traces WHERE trace_id=?1 AND key_id=?2 AND revision=?3 AND last_received_at<=?4) AND conversation_id IS NOT NULL AND NOT (${uniqueSession('telemetry_spans.conversation_id')})`,
});
export async function finishTelemetryWait(db: RelationalStore, trace: TraceRef, now: number): Promise<void> {
  await commit(
    db,
    dropUnresolved.bind(trace.trace_id, trace.key_id, trace.revision, now - TELEMETRY_MATCH_WAIT_MS),
  );
}
