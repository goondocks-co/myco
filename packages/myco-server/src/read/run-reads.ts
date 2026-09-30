/**
 * What a run read, and what came of a session.
 *
 * `run_reads` holds the sessions a run's run tools served it: a titling run's own material, and the sessions whose
 * prompt bodies an extraction page carried. A spore a run writes names the writing run in `spores.author` and the
 * session it came from in `spores.session_id`. The two reads here join them from either side:
 *
 * - **A session's outcome** — the runs that read it, each with what it wrote from it (its spores, and its title when
 *   the run's dispatch named this session), and the spores written from it. A run that wrote from a session with no
 *   recorded read of it is listed by its spores, with no read time.
 * - **A run's reads and what it produced** — the sessions it read and the spores it wrote. A run with no recorded
 *   read is answered with the sessions of the spores it wrote, and says so (`recorded: false`).
 *
 * Every statement names the Project, and every list is bounded; the totals count past the bound.
 */
import type { RelationalStore } from '../core/adapters.js';
import { RUN_WRITE_EVENT } from '../core/runs.js';
import { TITLE_WRITE_TOOL } from '../core/tool-catalogue.js';
import { notTombstonedSql } from '../core/tombstones.js';
import { contextValue } from './runs.js';
import type { ReadScope } from './scope.js';

/** The most runs a session's outcome lists. */
export const OUTCOME_RUN_LIMIT = 20;
/** The most spores either read lists; the total counts every one. */
export const OUTCOME_SPORE_LIMIT = 10;
/** The most sessions a run's reads list; the total counts every one. */
export const RUN_READ_LIMIT = 50;

/** A spore as an outcome lists it: its line, never its body. */
export interface OutcomeSpore {
  id: string;
  observationType: string;
  status: string;
  agentLine: string | null;
  sessionId: string | null;
  createdAt: number;
  /** The run that wrote it, while the Project still holds that run; null for a spore a member or a grant wrote. */
  runId: string | null;
}

/** A run that read a session, or wrote from it. */
export interface SessionRun {
  runId: string;
  task: string | null;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  /** When the run first read the session through its run tools; null for a run known only by what it wrote from it. */
  readAt: number | null;
  /** Whether the run's dispatch named this session. */
  target: boolean;
  /** Whether the run wrote this session's title. */
  titled: boolean;
  /** How many spores the run wrote from this session. */
  spores: number;
}

/** What came of one session: the runs that read it and the spores written from it. */
export interface SessionOutcome {
  runs: SessionRun[];
  spores: { total: number; items: OutcomeSpore[] };
}

/** A session a run read. */
export interface RunReadSession {
  sessionId: string;
  title: string | null;
  /** When the run first read it; null when it is known only as the session a spore the run wrote came from. */
  readAt: number | null;
}

/** What one run read and what it produced. */
export interface RunReads {
  read: {
    sessions: RunReadSession[];
    total: number;
    /** True when the sessions are the run's recorded reads; false when they are the sessions of the spores it wrote. */
    recorded: boolean;
  };
  produced: { spores: { total: number; items: OutcomeSpore[] } };
}

const SPORE_COLUMNS = `sp.id, sp.observation_type AS observationType, sp.status, sp.agent_line AS agentLine,
  sp.session_id AS sessionId, sp.created_at AS createdAt,
  CASE WHEN EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = sp.project_id AND r.id = sp.author) THEN sp.author END AS runId`;

/** The runs that read a session or wrote from it: one row per run, first read first, newest run first. */
const SESSION_RUNS_SQL = `SELECT r.id AS runId, r.task, r.status, r.started_at AS startedAt, r.completed_at AS completedAt, x.readAt,
    COALESCE(${contextValue('session_id')} = ?, 0) AS target,
    EXISTS (SELECT 1 FROM agent_run_events e WHERE e.project_id = r.project_id AND e.run_id = r.id AND e.event_type = ? AND e.tool_name = ?) AS wroteTitle,
    (SELECT COUNT(*) FROM spores s2 WHERE s2.project_id = r.project_id AND s2.author = r.id AND s2.session_id = ?) AS spores
  FROM (SELECT runId, MIN(readAt) AS readAt FROM (
          SELECT run_id AS runId, received_at AS readAt FROM run_reads WHERE project_id = ? AND session_id = ?
          UNION ALL
          SELECT author AS runId, NULL AS readAt FROM spores WHERE project_id = ? AND session_id = ? AND author IS NOT NULL)
        GROUP BY runId) x
  JOIN agent_runs r ON r.project_id = ? AND r.id = x.runId
  ORDER BY COALESCE(r.started_at, r.queued_at, x.readAt) DESC, r.id DESC
  LIMIT ?`;

const SESSION_SPORES_SQL = `SELECT ${SPORE_COLUMNS} FROM spores sp WHERE sp.project_id = ? AND sp.session_id = ?
  ORDER BY sp.created_at DESC, sp.id DESC LIMIT ?`;
const SESSION_SPORE_TOTAL_SQL = `SELECT COUNT(*) AS n FROM spores WHERE project_id = ? AND session_id = ?`;

const RUN_READS_SQL = `SELECT rr.session_id AS sessionId, s.title, rr.received_at AS readAt FROM run_reads rr
  LEFT JOIN sessions s ON s.project_id = rr.project_id AND s.session_id = rr.session_id
  WHERE rr.project_id = ? AND rr.run_id = ?
  ORDER BY rr.received_at ASC, rr.session_id ASC LIMIT ?`;
const RUN_READ_TOTAL_SQL = `SELECT COUNT(*) AS n FROM run_reads WHERE project_id = ? AND run_id = ?`;

/** The sessions of the spores a run wrote, for a run with no recorded read; a deleted session is not listed. */
const WRITTEN_FROM_SQL = `SELECT sp.session_id AS sessionId, s.title, NULL AS readAt, MIN(sp.created_at) AS firstAt FROM spores sp
  JOIN sessions s ON s.project_id = sp.project_id AND s.session_id = sp.session_id
  WHERE sp.project_id = ? AND sp.author = ? AND ${notTombstonedSql('s')}
  GROUP BY sp.session_id ORDER BY firstAt ASC, sp.session_id ASC LIMIT ?`;
const WRITTEN_FROM_TOTAL_SQL = `SELECT COUNT(DISTINCT sp.session_id) AS n FROM spores sp
  JOIN sessions s ON s.project_id = sp.project_id AND s.session_id = sp.session_id
  WHERE sp.project_id = ? AND sp.author = ? AND ${notTombstonedSql('s')}`;

const RUN_SPORES_SQL = `SELECT ${SPORE_COLUMNS} FROM spores sp WHERE sp.project_id = ? AND sp.author = ?
  ORDER BY sp.created_at DESC, sp.id DESC LIMIT ?`;
const RUN_SPORE_TOTAL_SQL = `SELECT COUNT(*) AS n FROM spores WHERE project_id = ? AND author = ?`;

const countOf = (rows: unknown[]): number => Number((rows[0] as { n?: number } | undefined)?.n ?? 0);

/** What came of one session. The caller has found the session in the scope. */
export async function sessionOutcome(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<SessionOutcome> {
  const { projectId } = scope;
  const [runs, spores, total] = await db.batch([
    db.prepare(SESSION_RUNS_SQL).bind(sessionId, RUN_WRITE_EVENT, TITLE_WRITE_TOOL, sessionId, projectId, sessionId, projectId, sessionId, projectId, OUTCOME_RUN_LIMIT),
    db.prepare(SESSION_SPORES_SQL).bind(projectId, sessionId, OUTCOME_SPORE_LIMIT),
    db.prepare(SESSION_SPORE_TOTAL_SQL).bind(projectId, sessionId),
  ]);
  return {
    runs: (runs!.results as Array<Record<string, unknown>>).map((row) => ({
      runId: row.runId as string,
      task: (row.task as string | null) ?? null,
      status: row.status as string,
      startedAt: (row.startedAt as number | null) ?? null,
      completedAt: (row.completedAt as number | null) ?? null,
      readAt: (row.readAt as number | null) ?? null,
      target: Number(row.target) === 1,
      titled: Number(row.target) === 1 && Number(row.wroteTitle) === 1,
      spores: Number(row.spores),
    })),
    spores: { total: countOf(total!.results), items: spores!.results as OutcomeSpore[] },
  };
}

/** What one run read and what it produced. The caller has found the run in the scope. */
export async function runReads(db: RelationalStore, scope: ReadScope, runId: string): Promise<RunReads> {
  const { projectId } = scope;
  const [read, readTotal, spores, sporeTotal] = await db.batch([
    db.prepare(RUN_READS_SQL).bind(projectId, runId, RUN_READ_LIMIT),
    db.prepare(RUN_READ_TOTAL_SQL).bind(projectId, runId),
    db.prepare(RUN_SPORES_SQL).bind(projectId, runId, OUTCOME_SPORE_LIMIT),
    db.prepare(RUN_SPORE_TOTAL_SQL).bind(projectId, runId),
  ]);
  const produced = { spores: { total: countOf(sporeTotal!.results), items: spores!.results as OutcomeSpore[] } };
  const recordedTotal = countOf(readTotal!.results);
  if (recordedTotal > 0) {
    return { read: { sessions: read!.results as RunReadSession[], total: recordedTotal, recorded: true }, produced };
  }
  if (produced.spores.total === 0) return { read: { sessions: [], total: 0, recorded: false }, produced };
  const [written, writtenTotal] = await db.batch([
    db.prepare(WRITTEN_FROM_SQL).bind(projectId, runId, RUN_READ_LIMIT),
    db.prepare(WRITTEN_FROM_TOTAL_SQL).bind(projectId, runId),
  ]);
  const sessions = (written!.results as Array<RunReadSession & { firstAt?: number }>).map(({ sessionId, title, readAt }) => ({ sessionId, title, readAt }));
  return { read: { sessions, total: countOf(writtenTotal!.results), recorded: false }, produced };
}
