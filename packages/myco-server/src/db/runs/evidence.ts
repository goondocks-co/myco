import type { RelationalStore } from '../../core/adapters.js';
import { storedAudit, type RunAudit } from '../../core/run-audit.js';
import { notTombstonedSql } from '../../core/tombstones.js';
import { emit } from '../../telemetry.js';
import type { ReadScope } from '../../read/scope.js';
import { commit, read, write } from '../index.js';
import { runCallerGuard } from './claim.js';
import type { RunCaller } from './lifecycle.js';
import { RUN_EVIDENCE_READY_SQL } from './evidence-schema.js';

export interface ReportRow {
  id: number;
  runId: string;
  agentId: string;
  action: string;
  summary: string;
  details: string | null;
  /** The agent's account of the pass the report closes (`core/run-audit.ts`); null where the report carries none. */
  audit: RunAudit | null;
  createdAt: number;
  /** Whether the details or audit body lives in a verified blob; each stays null here until resolved through `db/runs/bodies.ts`. */
  detailsMoved: boolean;
  auditMoved: boolean;
}

/** The most reports a run's detail lists: the latest; `listReports` says when a run holds more. */
export const RUN_REPORTS_LIMIT = 200;

const REPORT_MOVED = (kind: string) => `EXISTS (SELECT 1 FROM run_bodies b WHERE b.project_id = agent_reports.project_id AND b.run_id = agent_reports.run_id AND b.body_kind = '${kind}' AND b.item_id = agent_reports.id)`;
type ReportRead = Omit<ReportRow, 'audit' | 'detailsMoved' | 'auditMoved'> & { audit: string | null; detailsMoved: number; auditMoved: number };
const reportsRead = read<[string, string, number], ReportRead>({ name: 'runs.reports', sql:
  `SELECT id, run_id AS runId, agent_id AS agentId, action, summary, details, audit, created_at AS createdAt,
     ${REPORT_MOVED('report_details')} AS detailsMoved, ${REPORT_MOVED('report_audit')} AS auditMoved
   FROM agent_reports WHERE project_id = ? AND run_id = ? ORDER BY created_at DESC, id DESC LIMIT ?` });

/** A run's latest `RUN_REPORTS_LIMIT` reports, oldest first, and whether it holds more; a moved body is flagged and answered null. */
export async function listReports(db: RelationalStore, scope: ReadScope, runId: string): Promise<{ reports: ReportRow[]; hasMore: boolean }> {
  const [rows] = await commit(db, reportsRead.bind(scope.projectId, runId, RUN_REPORTS_LIMIT + 1));
  const reports = rows.results.slice(0, RUN_REPORTS_LIMIT).reverse().map((row) => ({ ...row, audit: storedAudit(row.audit), detailsMoved: Number(row.detailsMoved) === 1, auditMoved: Number(row.auditMoved) === 1 }));
  return { reports, hasMore: rows.results.length > RUN_REPORTS_LIMIT };
}
export interface ReportInsert {
  runId: string;
  agentId: string;
  action: string;
  summary: string;
  details: string | null;
  /** The validated audit, serialized; null for a report that carries none. */
  audit: string | null;
  createdAt: number;
}

/** Record one report against a run this Project holds; an unknown run or an unregistered agent writes nothing and answers false — a foreign-key throw would read as retryable, and neither condition is. */
export async function insertReport(db: RelationalStore, scope: ReadScope, report: ReportInsert, caller?: RunCaller): Promise<boolean> {
  const guard = runCallerGuard(caller);
  const inserted = await db
    .prepare(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, details, audit, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?${guard.sql})
          AND EXISTS (SELECT 1 FROM agents WHERE id = ?) RETURNING id`)
    .bind(scope.projectId, report.runId, report.agentId, report.action, report.summary, report.details, report.audit, report.createdAt,
          scope.projectId, report.runId, ...guard.params, report.agentId)
    .all<{ id: number }>();
  return inserted.results.length === 1;
}

/**
 * The event type a run's own tool call is recorded under.
 *
 * A run's turns happen inside a harness the Deployment cannot see; the calls it
 * makes back are the only part of a run the Deployment observes directly. A run
 * that ended its turn without ever calling is the case this record exists to
 * make legible — an empty list against a closed run is the evidence.
 */
export const RUN_TOOL_EVENT = 'run_tool';

/** The outcome a run's call is recorded under when the Deployment answered it with a failure. */
export const RUN_CALL_FAILED = 'failed';

/** The longest failure message a recorded call keeps. */
export const RUN_CALL_FAILURE_CHARS = 300;

/** Why the Deployment answered a run's call with a failure: the error's code, and what it said. */
export interface RunCallFailure {
  code: string;
  message: string;
}

/**
 * Record one call a run made back to the Deployment, whichever door it came
 * through: an MCP tool the harness child called, or a run route a container
 * drove itself. One list holds both, so an empty one means the run reached this
 * Deployment not at all rather than reached it another way.
 *
 * A call answered with a failure is recorded with what the failure said, so a
 * run that ended without its work reads as the call that failed it.
 *
 * A store that refuses the row is named in telemetry rather than failing the
 * call the caller already has an answer to.
 */
export async function recordRunCall(
  db: RelationalStore,
  scope: ReadScope,
  call: { runId: string; toolName: string; op: string | null; durationMs: number | null; recordedAt: number; failure?: RunCallFailure },
): Promise<void> {
  const failure = call.failure === undefined ? undefined : { code: call.failure.code, message: call.failure.message.slice(0, RUN_CALL_FAILURE_CHARS) };
  const payload = { ...(call.op === null ? {} : { op: call.op }), ...(failure === undefined ? {} : { failure }) };
  try {
    await recordRunEvents(db, scope, [{
      runId: call.runId, phaseName: null, eventType: RUN_TOOL_EVENT, toolName: call.toolName,
      outcome: failure === undefined ? 'success' : RUN_CALL_FAILED, durationMs: call.durationMs,
      payload: Object.keys(payload).length === 0 ? null : JSON.stringify(payload), recordedAt: call.recordedAt,
    }]);
  } catch {
    emit({ kind: 'run_tool_unrecorded', runId: call.runId, tool: call.toolName, op: call.op });
  }
}

/**
 * The event type a run's LANDED write of its task's artifact is recorded under.
 *
 * A tool call says the run asked; this says the write took. The two differ
 * wherever a write is conditional — a titling run in `claim` mode writes only
 * where no title stands — and a postcondition that read the call alone would
 * pass a run whose write did nothing.
 *
 * It is the run key for an artifact whose own row carries none. Where the
 * artifact table names the run itself (`canopy_maps.source_run_id`) the rule
 * reads that instead.
 */
export const RUN_WRITE_EVENT = 'run_write';


const recordedWrite = read<[string, string, string], { one: number }>({ name: 'runs.recordedWrite', sql:
  `SELECT 1 AS one FROM agent_run_events WHERE project_id = ? AND run_id = ? AND event_type = '${RUN_WRITE_EVENT}' AND tool_name = ? LIMIT 1` });

/** Whether this run recorded a landed write through the named tool: one seek of the run's landed writes. */
export async function runRecordedWrite(db: RelationalStore, scope: ReadScope, runId: string, toolName: string): Promise<boolean> {
  return (await commit(db, recordedWrite.bind(scope.projectId, runId, toolName)))[0].results.length > 0;
}

export interface RunWrite {
  runId: string;
  toolName: string;
  op: string;
  recordedAt: number;
  detail?: Record<string, unknown>;
}

/** Record attribution for a write whose domain row already names its run. */
export async function recordRunWrite(db: RelationalStore, scope: ReadScope, write: RunWrite): Promise<void> {
  await recordRunEvents(db, scope, [{
    runId: write.runId, phaseName: null, eventType: RUN_WRITE_EVENT, toolName: write.toolName,
    outcome: 'written', durationMs: null,
    payload: JSON.stringify({ op: write.op, ...(write.detail ?? {}) }), recordedAt: write.recordedAt,
  }]);
}


/**
 * The most sessions one run's reads are recorded for. A run past it still reads; the sessions after the bound are
 * served and not recorded, so a run's record stays a bounded number of rows whatever it reads.
 */
export const MAX_RUN_READS = 200;

const runReadsInsert = write<[string, string, string, string, number, number], { landed: number }>({ name: 'runs.recordReads', sql:
  `INSERT INTO run_reads (project_id, run_id, session_id, token_id, received_at)
   SELECT ?1, ?2, j.value, ?3, ?5 FROM json_each(?4) j
     JOIN sessions s ON s.project_id = ?1 AND s.session_id = j.value
   WHERE EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ?1 AND id = ?2) AND ${notTombstonedSql('s')}
     AND NOT EXISTS (SELECT 1 FROM run_reads x WHERE x.project_id = ?1 AND x.run_id = ?2 AND x.session_id = j.value)
   LIMIT MAX(0, ?6 - (SELECT COUNT(*) FROM run_reads WHERE project_id = ?1 AND run_id = ?2))
   ON CONFLICT (project_id, run_id, session_id) DO NOTHING RETURNING 1 AS landed` });

/**
 * Record the sessions served to a run's call, against the run, over the run's own credential.
 *
 * One row per run and session: a session read again keeps the row, and the instant of its first read. A row lands only
 * while the Project holds the run and the session and the session carries no tombstone; the statement caps itself to
 * the run's remaining `MAX_RUN_READS` capacity. Answers how many rows landed.
 */
export async function recordRunReads(
  db: RelationalStore,
  scope: ReadScope,
  read: { runId: string; tokenId: string; sessionIds: readonly string[]; receivedAt: number },
): Promise<number> {
  const sessionIds = [...new Set(read.sessionIds)].slice(0, MAX_RUN_READS);
  if (sessionIds.length === 0) return 0;
  const [inserted] = await commit(db, runReadsInsert.bind(scope.projectId, read.runId, read.tokenId, JSON.stringify(sessionIds), read.receivedAt, MAX_RUN_READS));
  return inserted.results.length;
}

export interface RunEventRowInsert {
  runId: string;
  phaseName: string | null;
  eventType: string;
  toolName: string | null;
  outcome: string | null;
  durationMs: number | null;
  payload: string | null;
  recordedAt: number;
}

/** Record a burst of run events in one batch; each row lands independently through its own EXISTS guard, and a row naming a run this Project does not hold writes nothing. Answers how many landed. */
export async function recordRunEvents(db: RelationalStore, scope: ReadScope, events: readonly RunEventRowInsert[]): Promise<number> {
  const statements = events.map((event) => db
    .prepare(`INSERT INTO agent_run_events (project_id, run_id, phase_name, event_type, tool_name, outcome, duration_ms, payload, recorded_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?) RETURNING 1 AS landed`)
    .bind(scope.projectId, event.runId, event.phaseName, event.eventType, event.toolName, event.outcome, event.durationMs, event.payload, event.recordedAt,
          scope.projectId, event.runId));
  const results = await db.batch(statements);
  return results.reduce((landed, result) => landed + result.results.length, 0);
}

/** What a page or a run answers about its evidence, or null while the projection is still counting history. */
export interface RunEvidenceHead { attempts: number; calls: number; failed: number }
const headRead = read<[string, string], { ready: number; attempts: number | null; calls: number | null; failed: number | null }>({ name: 'runs.head', sql:
  `SELECT (${RUN_EVIDENCE_READY_SQL}) AS ready, h.attempts, h.calls, h.calls_failed AS failed
   FROM (SELECT 1) LEFT JOIN run_head h ON h.project_id = ? AND h.run_id = ?` });
const attemptHeadRead = read<[string, string, string], { ready: number; attemptId: string; received: number | null }>({ name: 'runs.attemptHeads', sql:
  `SELECT (${RUN_EVIDENCE_READY_SQL}) AS ready, a.value AS attemptId, h.received
   FROM json_each(?3) a LEFT JOIN attempt_head h ON h.project_id = ?1 AND h.run_id = ?2 AND h.attempt_id = a.value` });

/** A run's kept counters; null while the catch-up is counting a run's history. */
export async function runEvidenceHead(db: RelationalStore, scope: ReadScope, runId: string): Promise<RunEvidenceHead | null> {
  const row = (await commit(db, headRead.bind(scope.projectId, runId)))[0].results[0];
  if (row === undefined || Number(row.ready) !== 1) return null;
  return { attempts: Number(row.attempts ?? 0), calls: Number(row.calls ?? 0), failed: Number(row.failed ?? 0) };
}

/** Steps received per attempt; absent attempts hold none. Null while the catch-up is counting. */
export async function attemptsReceived(db: RelationalStore, scope: ReadScope, runId: string, attemptIds: readonly string[]): Promise<Map<string, number> | null> {
  if (attemptIds.length === 0) return new Map();
  const rows = (await commit(db, attemptHeadRead.bind(scope.projectId, runId, JSON.stringify(attemptIds))))[0].results;
  if (rows.some(row => Number(row.ready) !== 1)) return null;
  return new Map(rows.map(row => [row.attemptId, Number(row.received ?? 0)]));
}
