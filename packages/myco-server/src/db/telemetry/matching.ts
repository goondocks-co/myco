import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, read, rows, write, refused, refusalCode } from '../index.js';
import { notTombstonedSql } from '../session-read-model.js';
import { TELEMETRY_CLOCK_TOLERANCE_MS, TELEMETRY_MATCH_WAIT_MS, TELEMETRY_RECHECK_MS, TELEMETRY_RESOLUTION_PAGE, TELEMETRY_TRACE_PAGE } from '../../core/telemetry-policy.js';

export interface TraceRef { trace_id: string; received_at: number; last_received_at: number; revision: number }
export interface StoredSpan {
  trace_id: string; span_id: string; key_id: string; parent_span_id: string | null; service_name: string | null;
  conversation_id: string | null; agent_name: string | null; operation: string | null; attributes: string;
  start_ms: number; end_ms: number; received_at: number;
}
export interface SessionIdentity { project_id: string; session_id: string }
export interface Resolution extends SessionIdentity {
  span_id: string; key_id: string; parent_span_id: string | null; parent_project_id: string | null; parent_session_id: string | null; matched_by: 'exact' | 'inferred'; invocation: number; repository: string | null; ref: string | null; agent_name: string | null; inferenceRemote?: string;
}
const due = read<[now: number, limit: number], TraceRef>({ name: 'telemetryMatching.due', sql:
  `SELECT trace_id,received_at,last_received_at,revision FROM telemetry_traces
    WHERE next_check<=?1 ORDER BY next_check,trace_id LIMIT ?2` });
const spans = read<[trace: string], StoredSpan>({ name: 'telemetryMatching.spans', sql:
  `SELECT s.trace_id,s.span_id,s.key_id,s.parent_span_id,s.service_name,s.conversation_id,s.agent_name,s.operation,s.attributes,s.start_ms,s.end_ms,s.received_at
    FROM telemetry_spans s JOIN telemetry_keys k ON k.id=s.key_id WHERE s.trace_id=?1 AND k.revoked_at IS NULL ORDER BY s.span_id` });
const sessions = read<[ids: string], SessionIdentity>({ name: 'telemetryMatching.sessions', sql:
  `SELECT s.project_id,s.session_id FROM json_each(?1) j CROSS JOIN sessions s INDEXED BY idx_sessions_telemetry_id ON s.session_id=j.value
    WHERE ${notTombstonedSql('s')} ORDER BY s.session_id,s.project_id` });

/** The turn range stops at one more than the evidence bound; overflow can only refuse an inference. */
export const TELEMETRY_CANDIDATE_LIMIT = 512;
interface CandidateSlots { remote: string; branch: string; after: string; before: string; parent: string; parentProject: string; agent: string; trace: string; span: string; limit: string }
const candidateRows = (slot: CandidateSlots): string => `WITH project AS (SELECT project_id FROM project_remotes WHERE remote=${slot.remote}),
  starts AS (SELECT s.project_id,s.session_id,'session' AS source FROM project r JOIN sessions s INDEXED BY idx_sessions_telemetry_start
    ON s.project_id=r.project_id AND s.branch=${slot.branch} AND s.started_at BETWEEN ${slot.after} AND ${slot.before}
    WHERE s.session_id<>${slot.parent} AND ${notTombstonedSql('s')} LIMIT 3),
  turns AS (SELECT p.project_id,p.session_id,p.generation,p.prompt_id FROM project r
    JOIN session_prompts p INDEXED BY idx_session_prompts_telemetry_time ON p.project_id=r.project_id AND p.created_at BETWEEN ${slot.after} AND ${slot.before}
    WHERE p.turn_key=p.prompt_id ORDER BY p.created_at,p.session_id,p.prompt_id LIMIT ${slot.limit})
  SELECT project_id,session_id,source FROM starts UNION ALL
  SELECT p.project_id,p.session_id,CASE WHEN s.branch=${slot.branch} AND s.session_id<>${slot.parent} AND ${notTombstonedSql('s')}
    AND p.generation=(SELECT generation FROM session_documents d WHERE d.project_id=p.project_id AND d.session_id=p.session_id AND d.state='live')
    THEN 'turn' ELSE 'excluded' END AS source FROM turns p JOIN sessions s ON s.project_id=p.project_id AND s.session_id=p.session_id`;
const uniqueCandidate = (slots: CandidateSlots): string => `WITH linked AS (
  SELECT DISTINCT r.project_id,r.session_id FROM telemetry_resolutions r INDEXED BY idx_telemetry_resolutions_invoker
    JOIN telemetry_keys k ON k.id=r.key_id AND k.revoked_at IS NULL
    JOIN sessions child ON child.project_id=r.project_id AND child.session_id=r.session_id
    WHERE r.parent_project_id=${slots.parentProject} AND r.parent_session_id=${slots.parent} AND r.agent_name=${slots.agent}
      AND r.repository=${slots.remote} AND r.ref=${slots.branch} AND ${notTombstonedSql('child')}
      AND (r.trace_id<>${slots.trace} OR r.span_id<>${slots.span}) LIMIT 2),
  candidates AS (${candidateRows(slots)}),live AS (SELECT DISTINCT project_id,session_id FROM candidates WHERE source<>'excluded')
  SELECT project_id,session_id FROM linked WHERE (SELECT COUNT(*) FROM linked)=1
  UNION ALL SELECT project_id,session_id FROM live WHERE NOT EXISTS(SELECT 1 FROM linked)
    AND (SELECT COUNT(*) FROM candidates WHERE source<>'session')<=${TELEMETRY_CANDIDATE_LIMIT} AND (SELECT COUNT(*) FROM live)=1`;
const candidates = read<[matches: string], { span_id: string; candidate: string | null }>({ name: 'telemetryMatching.candidates',
  sql: `SELECT json_extract(j.value,'$.spanId') AS span_id,(SELECT json_object('project_id',project_id,'session_id',session_id)
    FROM (${uniqueCandidate({ remote: "json_extract(j.value,'$.remote')", branch: "json_extract(j.value,'$.branch')",
      after: `json_extract(j.value,'$.start')-${TELEMETRY_CLOCK_TOLERANCE_MS}`, before: `json_extract(j.value,'$.start')+${TELEMETRY_CLOCK_TOLERANCE_MS}`,
      parent: "json_extract(j.value,'$.parent')", parentProject: "json_extract(j.value,'$.parentProject')", agent: "json_extract(j.value,'$.agent')", trace: "json_extract(j.value,'$.traceId')", span: "json_extract(j.value,'$.spanId')", limit: String(TELEMETRY_CANDIDATE_LIMIT + 1) })})) AS candidate FROM json_each(?1) j` });
const inferenceStillUnique = `EXISTS(SELECT 1 FROM (${uniqueCandidate({ remote: "json_extract(j.value,'$.inferenceRemote')", branch: "json_extract(span.attributes,'$.\"vcs.ref.head.name\"')",
  after: `span.start_ms-${TELEMETRY_CLOCK_TOLERANCE_MS}`, before: `span.start_ms+${TELEMETRY_CLOCK_TOLERANCE_MS}`, parent: "json_extract(j.value,'$.parent_session_id')", parentProject: "json_extract(j.value,'$.parent_project_id')", agent: 'span.agent_name', trace: 'span.trace_id', span: 'span.span_id', limit: String(TELEMETRY_CANDIDATE_LIMIT + 1) })}) chosen
  WHERE chosen.project_id=s.project_id AND chosen.session_id=s.session_id)`;
const uniqueSession = (id: string) => `(SELECT COUNT(*) FROM (SELECT s.project_id FROM sessions s INDEXED BY idx_sessions_telemetry_id
  WHERE s.session_id=${id} AND ${notTombstonedSql('s')} LIMIT 2))=1`;
const clear = write<[trace: string]>({ name: 'telemetryMatching.clear', sql:
  `DELETE FROM telemetry_resolutions WHERE trace_id=?1` });
const put = write<[trace: string, payload: string]>({ name: 'telemetryMatching.put', sql:
  `INSERT INTO telemetry_resolutions(trace_id,span_id,key_id,project_id,session_id,parent_project_id,parent_session_id,parent_span_id,matched_by,invocation,repository,ref,agent_name)
    SELECT ?1,json_extract(j.value,'$.span_id'),span.key_id,s.project_id,s.session_id,
      json_extract(j.value,'$.parent_project_id'),json_extract(j.value,'$.parent_session_id'),json_extract(j.value,'$.parent_span_id'),json_extract(j.value,'$.matched_by'),json_extract(j.value,'$.invocation'),json_extract(j.value,'$.repository'),json_extract(j.value,'$.ref'),span.agent_name
    FROM json_each(?2) j JOIN telemetry_spans span ON span.trace_id=?1 AND span.span_id=json_extract(j.value,'$.span_id') AND span.key_id=json_extract(j.value,'$.key_id')
    JOIN telemetry_keys k ON k.id=span.key_id AND k.revoked_at IS NULL
    JOIN sessions s ON s.project_id=json_extract(j.value,'$.project_id') AND s.session_id=json_extract(j.value,'$.session_id')
    WHERE ${notTombstonedSql('s')}
      AND ((json_extract(j.value,'$.matched_by')='exact' AND span.conversation_id=s.session_id AND ${uniqueSession('span.conversation_id')})
        OR (json_extract(j.value,'$.matched_by')='inferred' AND span.conversation_id IS NULL AND (${inferenceStillUnique})))
      AND (json_extract(j.value,'$.parent_session_id') IS NULL OR EXISTS(
      SELECT 1 FROM sessions parent JOIN telemetry_spans ancestor ON ancestor.trace_id=span.trace_id
        AND ancestor.span_id=json_extract(j.value,'$.parent_span_id') AND ancestor.conversation_id=parent.session_id
      WHERE ${uniqueSession('ancestor.conversation_id')} AND parent.project_id=json_extract(j.value,'$.parent_project_id')
        AND parent.session_id=json_extract(j.value,'$.parent_session_id') AND ${notTombstonedSql('parent')}))` });
const checked = write<[trace: string, next: number]>({ name: 'telemetryMatching.checked', sql:
  'UPDATE telemetry_traces SET next_check=?2 WHERE trace_id=?1' });

export const telemetryTracesDue = (db: RelationalStore, now: number) => rows(db, due.bind(now, TELEMETRY_TRACE_PAGE));
export const telemetryTraceSpans = (db: RelationalStore, trace: TraceRef) => rows(db, spans.bind(trace.trace_id));
export const telemetrySessionsNamed = (db: RelationalStore, ids: readonly string[]) => rows(db, sessions.bind(JSON.stringify(ids)));
export interface InferenceMatch { traceId: string; spanId: string; remote: string; branch: string; start: number; parent: string; parentProject: string; agent: string | null }
export async function inferTelemetrySessions(db: RelationalStore, matches: readonly InferenceMatch[]): Promise<Map<string, SessionIdentity>> {
  const matched = new Map<string, SessionIdentity>();
  if (matches.length === 0) return matched;
  for (const row of await rows(db, candidates.bind(JSON.stringify(matches)))) {
    if (row.candidate !== null) matched.set(row.span_id, JSON.parse(row.candidate) as SessionIdentity);
  }
  return matched;
}
export async function settleTelemetryTrace(db: RelationalStore, trace: TraceRef, resolutions: readonly Resolution[], now: number): Promise<void> {
  const writes = [];
  for (let offset = 0; offset < resolutions.length; offset += TELEMETRY_RESOLUTION_PAGE) writes.push(put.bind(trace.trace_id, JSON.stringify(resolutions.slice(offset, offset + TELEMETRY_RESOLUTION_PAGE))));
  await commit(db, unchanged.bind(trace.trace_id, trace.revision), clear.bind(trace.trace_id), ...writes,
    checked.bind(trace.trace_id, now + TELEMETRY_RECHECK_MS));
}

const snapshotChanged = refusalCode('telemetry_snapshot_changed');
const unchanged = assertion<[trace: string, revision: number]>({ name: 'telemetryMatching.unchanged',
  when: 'EXISTS(SELECT 1 FROM telemetry_traces WHERE trace_id=?1 AND revision=?2)', refusal: snapshotChanged });
export const telemetrySnapshotChanged = (error: unknown): boolean => refused(error, snapshotChanged);

const pending = read<[now: number], { trace_id: string }>({ name: 'telemetryMatching.pending', sql: 'SELECT trace_id FROM telemetry_traces WHERE next_check<=?1 LIMIT 1' });
export const telemetryReconciliationDue = async (db: RelationalStore, now: number): Promise<boolean> => (await rows(db, pending.bind(now))).length > 0;
const dropUnresolved = write<[trace: string]>({ name: 'telemetryMatching.dropUnresolved', sql:
  `DELETE FROM telemetry_spans WHERE trace_id=?1 AND conversation_id IS NOT NULL AND NOT (${uniqueSession('telemetry_spans.conversation_id')})` });
export async function finishTelemetryWait(db: RelationalStore, trace: TraceRef, now: number): Promise<void> {
  await commit(db, unchanged.bind(trace.trace_id, trace.revision), dropUnresolved.bind(trace.trace_id), checked.bind(trace.trace_id, now + TELEMETRY_MATCH_WAIT_MS));
}
