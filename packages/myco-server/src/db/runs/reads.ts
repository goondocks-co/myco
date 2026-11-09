/**
 * What a run read, and what came of a session.
 *
 * `run_reads` holds the sessions a run's run tools served it: a titling run's own material, and the sessions whose
 * prompt bodies an extraction page carried. A spore a run writes names the writing run in `spores.author` and the
 * session it came from in `spores.session_id`. The two reads here join them from either side:
 *
 * - **A session's outcome** — the runs that read it, each with what it wrote from it (its spores, and its title when
 *   the run's dispatch named this session), and the spores written from it. A run with no recorded read of the
 *   session that wrote spores from it, or whose dispatch named it, is listed with no read time.
 * - **A run's reads and what it produced** — the sessions it read and the spores it wrote. A run with no recorded
 *   read is answered with the sessions it is known to have worked from — its dispatch's session and the sessions of
 *   the spores it wrote — and says so (`recorded: false`). `recorded: false` with no sessions means the Deployment
 *   holds no record of what the run read, never that it read nothing.
 *
 * A deleted session is never listed as read.
 *
 * Every statement names the Project, and every list is bounded; the totals count past the bound.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, type Bound } from '../index.js';
import { RUN_WRITE_EVENT } from './evidence.js';
import { TITLE_WRITE_TOOL } from '../../core/tool-catalogue.js';
import { notTombstonedSql } from '../session-read-model.js';
import { contextValue } from '../run-context.js';
import type { ReadScope } from '../../read/scope.js';

/** The most runs a session's outcome lists. */
export const OUTCOME_RUN_LIMIT = 20;
/** The most spores either read lists; the total counts every one. */
export const OUTCOME_SPORE_LIMIT = 10;
/** The most sessions a run's reads list; the total counts every one. */
const RUN_READ_LIMIT = 50;

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
  /** When the run first read the session through its run tools; null for a run known only by its dispatch or what it wrote from it. */
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
  /** When the run first read it; null when it is known only as its dispatch's session or a session a spore it wrote came from. */
  readAt: number | null;
}

/** What one run read and what it produced. */
export interface RunReads {
  read: {
    sessions: RunReadSession[];
    total: number;
    /**
     * True when the sessions are the run's recorded reads. False when the run recorded none: the sessions are then
     * its dispatch's session and those of the spores it wrote, and none listed means no record, not no read.
     */
    recorded: boolean;
  };
  produced: { spores: { total: number; items: OutcomeSpore[] } };
}

const SPORE_COLUMNS = `sp.id, sp.observation_type AS observationType, sp.status, sp.agent_line AS agentLine,
  sp.session_id AS sessionId, sp.created_at AS createdAt,
  CASE WHEN EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = sp.project_id AND r.id = sp.author) THEN sp.author END AS runId`;

/**
 * The runs that read a session, wrote from it, or were dispatched on it: one row per run, its first read if it has
 * one, newest run first.
 */
const SESSION_RUNS_SQL = `SELECT r.id AS runId, r.task, r.status, r.started_at AS startedAt, r.completed_at AS completedAt, x.readAt,
    COALESCE(${contextValue('session_id')} = ?1, 0) AS target,
    EXISTS (SELECT 1 FROM agent_run_events e WHERE e.project_id = r.project_id AND e.run_id = r.id AND e.event_type = '${RUN_WRITE_EVENT}' AND e.tool_name = ?2) AS wroteTitle,
    (SELECT COUNT(*) FROM spores s2 WHERE s2.project_id = r.project_id AND s2.author = r.id AND s2.session_id = ?1) AS spores
  FROM (SELECT runId, MIN(readAt) AS readAt FROM (
          SELECT run_id AS runId, received_at AS readAt FROM run_reads WHERE project_id = ?3 AND session_id = ?1
          UNION ALL
          SELECT author AS runId, NULL AS readAt FROM spores WHERE project_id = ?3 AND session_id = ?1 AND +author IS NOT NULL
          UNION ALL
          SELECT id AS runId, NULL AS readAt FROM agent_runs WHERE project_id = ?3 AND ${contextValue('session_id')} = ?1)
        GROUP BY runId) x
  CROSS JOIN agent_runs r ON r.project_id = ?3 AND r.id = x.runId
  ORDER BY COALESCE(r.started_at, r.queued_at, x.readAt) DESC, r.id DESC
  LIMIT ?4`;

const SESSION_SPORES_SQL = `SELECT ${SPORE_COLUMNS} FROM spores sp WHERE sp.project_id = ?1 AND sp.session_id = ?2
  ORDER BY sp.created_at DESC, sp.id DESC LIMIT ?3`;
const SESSION_SPORE_TOTAL_SQL = `SELECT COUNT(*) AS n FROM spores WHERE project_id = ?1 AND session_id = ?2`;

/** A run's recorded reads of sessions the Project still holds undeleted. */
const RUN_READS_SQL = `SELECT rr.session_id AS sessionId, s.title, rr.received_at AS readAt FROM run_reads rr
  JOIN sessions s ON s.project_id = rr.project_id AND s.session_id = rr.session_id
  WHERE rr.project_id = ?1 AND rr.run_id = ?2 AND ${notTombstonedSql('s')}
  ORDER BY rr.received_at ASC, rr.session_id ASC LIMIT ?3`;
/** One run (`?2` holds its id) or a page of them (`?2` holds a JSON array of ids): the run predicate the counts below are written over. */
const ONE_RUN = '= ?2';
const RUNS_IN = 'IN (SELECT value FROM json_each(?2))';

/** A run's recorded reads of sessions the Project still holds undeleted, counted per run. */
const recordedReads = (runs: string): string => `SELECT rr.run_id AS runId, COUNT(*) AS n FROM run_reads rr
  JOIN sessions s ON s.project_id = rr.project_id AND s.session_id = rr.session_id
  WHERE rr.project_id = ?1 AND rr.run_id ${runs} AND ${notTombstonedSql('s')} GROUP BY rr.run_id`;
const RUN_READ_TOTAL_SQL = recordedReads(ONE_RUN);

/**
 * The sessions a run with no recorded read worked from: its dispatch's session and those of the spores it wrote,
 * undeleted. The spores are found by their author: `+session_id` keeps the session index, which would read every spore
 * of the Project that has a session, out of the planner's reach. The spores and the dispatch drive and each session is
 * looked up by its key after them (`CROSS JOIN`), never the Project's sessions walked.
 */
const workedFrom = (runs: string): string => `(SELECT author AS runId, session_id AS sessionId, created_at AS at FROM spores WHERE project_id = ?1 AND author ${runs} AND +session_id IS NOT NULL
    UNION ALL
    SELECT id AS runId, ${contextValue('session_id')} AS sessionId, COALESCE(started_at, queued_at, 0) AS at FROM agent_runs WHERE project_id = ?1 AND id ${runs}) x
  CROSS JOIN sessions s ON s.project_id = ?1 AND s.session_id = x.sessionId
  WHERE ${notTombstonedSql('s')}`;
const WORKED_FROM_SQL = `SELECT x.sessionId, s.title, NULL AS readAt, MIN(x.at) AS firstAt FROM ${workedFrom(ONE_RUN)}
  GROUP BY x.sessionId ORDER BY firstAt ASC, x.sessionId ASC LIMIT ?3`;
const workedFromTotal = (runs: string): string => `SELECT x.runId, COUNT(DISTINCT x.sessionId) AS n FROM ${workedFrom(runs)} GROUP BY x.runId`;
const WORKED_FROM_TOTAL_SQL = workedFromTotal(ONE_RUN);

const RUN_SPORES_SQL = `SELECT ${SPORE_COLUMNS} FROM spores sp WHERE sp.project_id = ?1 AND sp.author = ?2
  ORDER BY sp.created_at DESC, sp.id DESC LIMIT ?3`;
/** The spores a run wrote, counted per run. */
const sporesWritten = (runs: string): string => `SELECT author AS runId, COUNT(*) AS n FROM spores WHERE project_id = ?1 AND author ${runs} GROUP BY author`;
const RUN_SPORE_TOTAL_SQL = sporesWritten(ONE_RUN);

const countOf = (rows: ReadonlyArray<{ n: number }>): number => Number(rows[0]?.n ?? 0);

type RunCount = { runId: string; n: number };
type SessionRunRow = Omit<SessionRun, 'target' | 'titled'> & { target: number; wroteTitle: number };
const sessionRuns = read<[session: string, titleTool: string, project: string, limit: number], SessionRunRow>({ name: 'runs.sessionRuns', sql: SESSION_RUNS_SQL });
const sessionSpores = read<[project: string, session: string, limit: number], OutcomeSpore>({ name: 'runs.sessionSpores', sql: SESSION_SPORES_SQL });
const sessionSporeTotal = read<[project: string, session: string], { n: number }>({ name: 'runs.sessionSporeTotal', sql: SESSION_SPORE_TOTAL_SQL });
const runReadPage = read<[project: string, run: string, limit: number], RunReadSession>({ name: 'runs.readsPage', sql: RUN_READS_SQL });
const runReadTotal = read<[project: string, run: string], RunCount>({ name: 'runs.readsTotal', sql: RUN_READ_TOTAL_SQL });
const runSporePage = read<[project: string, run: string, limit: number], OutcomeSpore>({ name: 'runs.sporesPage', sql: RUN_SPORES_SQL });
const runSporeTotal = read<[project: string, run: string], RunCount>({ name: 'runs.sporesTotal', sql: RUN_SPORE_TOTAL_SQL });
const workedFromPage = read<[project: string, run: string, limit: number], RunReadSession>({ name: 'runs.workedFromPage', sql: WORKED_FROM_SQL });
const workedFromCount = read<[project: string, run: string], RunCount>({ name: 'runs.workedFromTotal', sql: WORKED_FROM_TOTAL_SQL });
const readsPerRun = read<[project: string, runs: string], RunCount>({ name: 'runs.readsPerRun', sql: recordedReads(RUNS_IN) });
const sporesPerRun = read<[project: string, runs: string], RunCount>({ name: 'runs.sporesPerRun', sql: sporesWritten(RUNS_IN) });
const workedPerRun = read<[project: string, runs: string], RunCount>({ name: 'runs.workedPerRun', sql: workedFromTotal(RUNS_IN) });

/** What came of one session. The caller has found the session in the scope. */
export async function sessionOutcome(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<SessionOutcome> {
  const { projectId } = scope;
  const [runs, spores, total] = await readSet(db,
    sessionRuns.bind(sessionId, TITLE_WRITE_TOOL, projectId, OUTCOME_RUN_LIMIT),
    sessionSpores.bind(projectId, sessionId, OUTCOME_SPORE_LIMIT),
    sessionSporeTotal.bind(projectId, sessionId));
  return {
    runs: runs.map((row) => ({
      runId: row.runId,
      task: row.task ?? null,
      status: row.status,
      startedAt: row.startedAt ?? null,
      completedAt: row.completedAt ?? null,
      readAt: row.readAt ?? null,
      target: Number(row.target) === 1,
      titled: Number(row.target) === 1 && Number(row.wroteTitle) === 1,
      spores: Number(row.spores),
    })),
    spores: { total: countOf(total), items: spores },
  };
}

/** What a run in a list came to: the spores it wrote, and the sessions it read, counted as its detail's `read.total` counts them. */
export interface RunOutcomeCounts {
  spores: number;
  /** The sessions `read.sessions` lists on the run's detail: its recorded reads, or where it recorded none, the sessions it worked from. */
  sessions: number;
  /** Whether `sessions` counts recorded reads; as `read.recorded` on the detail. */
  readsRecorded: boolean;
}

/**
 * The outcome counts of a page of runs: three statements over the page's ids, each grouped by run, for the caller to
 * send in the batch it already makes, and the reading of their answers. A run absent from every answer wrote nothing
 * and read nothing the Deployment holds.
 */
export function runOutcomeCounts(scope: ReadScope, runIds: readonly string[]): {
  statements: readonly [Bound<RunCount, 'read'>, Bound<RunCount, 'read'>, Bound<RunCount, 'read'>];
  read: (answers: readonly [RunCount[], RunCount[], RunCount[]]) => Map<string, RunOutcomeCounts>;
} {
  const { projectId } = scope;
  const ids = JSON.stringify([...new Set(runIds)]);
  const statements = [readsPerRun.bind(projectId, ids), sporesPerRun.bind(projectId, ids), workedPerRun.bind(projectId, ids)] as const;
  const byRun = (rows: readonly RunCount[]): Map<string, number> => new Map(rows.map((row) => [String(row.runId), Number(row.n)]));
  const answer = (answers: readonly [RunCount[], RunCount[], RunCount[]]): Map<string, RunOutcomeCounts> => {
    const [recordedBy, sporesBy, workedBy] = [byRun(answers[0]), byRun(answers[1]), byRun(answers[2])];
    return new Map(runIds.map((id) => {
      const reads = recordedBy.get(id) ?? 0;
      return [id, { spores: sporesBy.get(id) ?? 0, sessions: reads > 0 ? reads : workedBy.get(id) ?? 0, readsRecorded: reads > 0 }];
    }));
  };
  return { statements, read: answer };
}

/** What one run read and what it produced. The caller has found the run in the scope. */
export async function runReads(db: RelationalStore, scope: ReadScope, runId: string): Promise<RunReads> {
  const { projectId } = scope;
  const [sessions, readTotal, spores, sporeTotal] = await readSet(db,
    runReadPage.bind(projectId, runId, RUN_READ_LIMIT), runReadTotal.bind(projectId, runId),
    runSporePage.bind(projectId, runId, OUTCOME_SPORE_LIMIT), runSporeTotal.bind(projectId, runId));
  const produced = { spores: { total: countOf(sporeTotal), items: spores } };
  const recordedTotal = countOf(readTotal);
  if (recordedTotal > 0) return { read: { sessions, total: recordedTotal, recorded: true }, produced };
  const [worked, workedTotal] = await readSet(db, workedFromPage.bind(projectId, runId, RUN_READ_LIMIT), workedFromCount.bind(projectId, runId));
  return { read: { sessions: worked.map(({ sessionId, title, readAt }) => ({ sessionId, title, readAt })), total: countOf(workedTotal), recorded: false }, produced };
}
