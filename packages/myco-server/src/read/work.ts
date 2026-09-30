/**
 * Myco's work: what the Deployment's own runs produced over a window, read across Projects.
 *
 * One read serves the dashboard's Today page and its Myco's work page, so a count a page shows and the runs it lists
 * come from one snapshot: every statement of the read goes in one batch.
 *
 * **The outcome, not the status.** A run is counted by what it left in the store: the spores it wrote (`spores.author`
 * names the run), the session title it landed and the map it wrote (each a write the run recorded). A learning run
 * marked failed that saved spores reports its spores, with the failure beside them as a note, and a run that completed
 * having written nothing is counted but never listed.
 *
 * **Upkeep is summarised, never listed.** The search index's own runs are frequent enough that a list of them would
 * drown every other run, so the read answers when the index last succeeded, how many of its runs failed in the window,
 * and how many have failed after that success. A failure a later success followed is a retry, not a failure.
 */
import type { RelationalStore } from '../core/adapters.js';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { EXTRACTION_TASK, SEEDING_TASK, TITLING_TASK } from '../core/task-catalogue.js';
import { MAP_WRITE_TOOL, TITLE_WRITE_TOOL } from '../core/tool-catalogue.js';
import { RUN_WRITE_EVENT } from '../core/runs.js';
import { EMBEDDING_TASK } from '../core/embedding/jobs.js';
import { projectsDriving, projectsFiltering, type ProjectSet } from './scope.js';

/** What an outcome task produces, in the words the dashboard groups work by. */
export type OutcomeKind = 'learn' | 'title' | 'map' | 'seed';

/** Each outcome task and the kind of work it is. */
export const OUTCOME_KINDS: Readonly<Record<string, OutcomeKind>> = {
  [EXTRACTION_TASK]: 'learn',
  [TITLING_TASK]: 'title',
  [MAP_TASK]: 'map',
  [SEEDING_TASK]: 'seed',
};

const OUTCOME_TASK_NAMES = Object.keys(OUTCOME_KINDS);
const SPORE_TASKS = [EXTRACTION_TASK, SEEDING_TASK];

/** The most runs one answer lists; the counts cover every run in the window whatever this cuts. */
export const MAX_WORK_RUNS = 200;
/** The longest window one read covers, a little over the retention a run is kept for by default. */
export const MAX_WORK_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
/** The window a read covers when it names none. */
export const DEFAULT_WORK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A least and greatest value over the runs that reported one; null where none did. */
export type Range = readonly [number, number] | null;

/** One Project's work of one kind over the window. */
export interface WorkOutcome {
  projectId: string;
  kind: OutcomeKind;
  task: string;
  /** Runs by status, every run in the window counted once. */
  runs: Record<string, number>;
  /** What the runs left: spores written, sessions those spores came from or that a title landed on, and maps written. */
  outcome: { spores: number; sessions: number; maps: number };
  /** Failed runs that still produced something; their output is counted above and the failure is a note. */
  failedWithOutput: number;
  /** Failed runs that produced nothing. */
  failed: number;
  /** The latest instant a run of this kind is shown at (`at` on a listed run). */
  latestAt: number | null;
  /** Tokens and cost as the runs themselves reported them, and how many runs that started and finished reported no cost. */
  tokens: number;
  costUsd: number;
  runsWithoutCost: number;
  /** What one completed run spent: tokens, cost and wall time, least to greatest. */
  spend: { tokens: Range; costUsd: Range; durationMs: Range };
  /** The Project's current map, for the map kind; null for every other kind and for a Project with none. */
  map: { branch: string; commit: string; generatedAt: number; sourceRunId: string } | null;
}

/** How a listed run ended, by what it produced rather than by its status alone. */
export type RunResult = 'produced' | 'failed' | 'failed_with_output';

/** One run the timeline lists: a run that produced something, or one that failed. */
export interface WorkRun {
  id: string;
  projectId: string;
  task: string;
  kind: OutcomeKind;
  status: string;
  result: RunResult;
  /** When the run ended, else when it queued, else when it started: the instant the window is read by. */
  at: number | null;
  outcome: { spores: number; sessions: number; maps: number };
  /** The session a title run titled; null for every other run. */
  sessionId: string | null;
  /** Why a failed run failed: the run's own last report where it filed one, which names the cause the stored error hides, else the error. */
  failure: { cause: string; source: 'report' | 'error' } | null;
  tokens: number | null;
  costUsd: number | null;
}

/** The search index's upkeep over the window. */
export interface Upkeep {
  task: string;
  /** When an upkeep run last completed, whenever that was. */
  lastSuccessAt: number | null;
  /** Upkeep runs started inside the window that failed, retries included. */
  failedInWindow: number;
  /** Upkeep runs that failed after the last success, and the first of them: the ones no success has answered yet. */
  unrecovered: { runs: number; since: number } | null;
}

export interface WorkAnswer {
  window: { since: number; until: number };
  outcomes: WorkOutcome[];
  runs: WorkRun[];
  /** Whether more runs matched than `MAX_WORK_RUNS`; the counts in `outcomes` cover them all either way. */
  truncated: boolean;
  upkeep: Upkeep;
}

const list = (values: readonly unknown[]): string => values.map(() => '?').join(', ');

/**
 * The one instant a run is windowed, shown and counted at: when it ended, or for a run that has not ended, when it
 * entered the queue, else when it started. A run belongs to the window its outcome landed in.
 */
const RUN_AT = 'COALESCE(r.completed_at, r.queued_at, r.started_at)';
/** The index every read of a window's runs goes through: by Project, task and status. */
const RUNS_BY_TASK = 'agent_runs r INDEXED BY idx_agent_runs_task';

const wroteSpores = (a: string): string => `EXISTS (SELECT 1 FROM spores sp WHERE sp.project_id = ${a}.project_id AND sp.author = ${a}.id)`;
const recordedWrite = (a: string, tool: string): string => `EXISTS (SELECT 1 FROM agent_run_events e
  WHERE e.project_id = ${a}.project_id AND e.run_id = ${a}.id AND e.event_type = '${RUN_WRITE_EVENT}' AND e.tool_name = '${tool}')`;

/** Whether the run aliased `a` produced what its task exists to produce: spores, a session's title, or a map. */
export const producedSql = (a: string): string => `(CASE ${a}.task
  WHEN '${EXTRACTION_TASK}' THEN ${wroteSpores(a)}
  WHEN '${SEEDING_TASK}' THEN ${wroteSpores(a)}
  WHEN '${TITLING_TASK}' THEN ${recordedWrite(a, TITLE_WRITE_TOOL)}
  WHEN '${MAP_TASK}' THEN ${recordedWrite(a, MAP_WRITE_TOOL)}
  ELSE 0 END)`;
const PRODUCED_SQL = producedSql('r');

/** The session a title run's recorded write names. */
const TITLED_SESSION = `(SELECT CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.session_id') END FROM agent_run_events e
  WHERE e.project_id = r.project_id AND e.run_id = r.id AND e.event_type = '${RUN_WRITE_EVENT}' AND e.tool_name = '${TITLE_WRITE_TOOL}'
  ORDER BY e.id DESC LIMIT 1)`;

const num = (value: unknown): number => Number(value ?? 0);
const orNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const range = (low: unknown, high: unknown): Range => (low === null || low === undefined || high === null || high === undefined ? null : [Number(low), Number(high)]);

/** The statements of the upkeep summary over the set's Projects: one row per Project. */
function upkeepStatement(db: RelationalStore, set: ProjectSet, since: number, until: number) {
  const projects = projectsDriving(set, 'p.project_id');
  const failedAfter = (bound: string) => `FROM agent_runs r WHERE r.project_id = u.project_id AND r.task = ? AND r.status = 'failed' AND r.started_at > ${bound}`;
  return db.prepare(
    `SELECT u.project_id, u.last_success, u.failed_in_window,
            (SELECT COUNT(*) ${failedAfter('COALESCE(u.last_success, -1)')}) AS unrecovered,
            (SELECT MIN(r.started_at) ${failedAfter('COALESCE(u.last_success, -1)')}) AS unrecovered_since
       FROM (SELECT p.project_id,
                    (SELECT MAX(r.started_at) FROM agent_runs r WHERE r.project_id = p.project_id AND r.task = ? AND r.status = 'completed') AS last_success,
                    (SELECT COUNT(*) FROM agent_runs r WHERE r.project_id = p.project_id AND r.task = ? AND r.status = 'failed'
                       AND r.started_at >= ? AND r.started_at < ?) AS failed_in_window
               FROM projects p WHERE ${projects.sql}) u`,
  ).bind(EMBEDDING_TASK, EMBEDDING_TASK, EMBEDDING_TASK, EMBEDDING_TASK, since, until, ...projects.params);
}

/** The upkeep rows of the upkeep statement, summed over the Projects. */
function upkeepOf(rows: readonly Record<string, unknown>[]): Upkeep {
  let lastSuccessAt: number | null = null;
  let failedInWindow = 0;
  let unrecovered = 0;
  let since: number | null = null;
  for (const row of rows) {
    const last = orNull(row.last_success);
    if (last !== null && (lastSuccessAt === null || last > lastSuccessAt)) lastSuccessAt = last;
    failedInWindow += num(row.failed_in_window);
    const open = num(row.unrecovered);
    unrecovered += open;
    const first = orNull(row.unrecovered_since);
    if (open > 0 && first !== null && (since === null || first < since)) since = first;
  }
  return { task: EMBEDDING_TASK, lastSuccessAt, failedInWindow, unrecovered: unrecovered > 0 && since !== null ? { runs: unrecovered, since } : null };
}

/** The search index's upkeep over the set's Projects and the window. */
export async function readUpkeep(db: RelationalStore, set: ProjectSet, since: number, until: number): Promise<Upkeep> {
  const { results } = await upkeepStatement(db, set, since, until).all<Record<string, unknown>>();
  return upkeepOf(results);
}

/** What the Deployment's runs produced in the set's Projects over the window, its end excluded. */
export async function readWork(db: RelationalStore, set: ProjectSet, since: number, until: number): Promise<WorkAnswer> {
  const projects = projectsDriving(set, 'r.project_id');
  const window = `${RUN_AT} >= ? AND ${RUN_AT} < ?`;
  const scoped = (tasks: readonly string[]) => ({
    sql: `${projects.sql} AND r.task IN (${list(tasks)}) AND ${window}`,
    params: [...projects.params, ...tasks, since, until],
  });
  const all = scoped(OUTCOME_TASK_NAMES);
  const spores = scoped(SPORE_TASKS);
  const titles = scoped([TITLING_TASK]);
  const maps = projectsDriving(set, 'project_id');

  // `CROSS JOIN` keeps the window's runs as the outer loop, so the rows a run wrote are sought by that run rather than
  // every row of its Project being read to find them.
  const [aggregate, sporeOutcome, titleOutcome, mapHeads, listed, upkeep] = await db.batch([
    db.prepare(
      `SELECT r.project_id, r.task, r.status, COUNT(*) AS runs, MAX(${RUN_AT}) AS latest_at,
              SUM(COALESCE(r.tokens_used, 0)) AS tokens, SUM(COALESCE(r.cost_usd, 0)) AS cost,
              SUM(CASE WHEN r.status IN ('completed', 'failed') AND r.started_at IS NOT NULL AND r.cost_usd IS NULL THEN 1 ELSE 0 END) AS no_cost,
              SUM(${PRODUCED_SQL}) AS produced,
              MIN(r.tokens_used) AS tokens_low, MAX(r.tokens_used) AS tokens_high,
              MIN(r.cost_usd) AS cost_low, MAX(r.cost_usd) AS cost_high,
              MIN(r.completed_at - r.started_at) AS duration_low, MAX(r.completed_at - r.started_at) AS duration_high
         FROM ${RUNS_BY_TASK} WHERE ${all.sql}
        GROUP BY r.project_id, r.task, r.status`,
    ).bind(...all.params),
    db.prepare(
      `SELECT r.project_id, r.task, COUNT(sp.id) AS spores, COUNT(DISTINCT sp.session_id) AS sessions
         FROM ${RUNS_BY_TASK} CROSS JOIN spores sp ON sp.project_id = r.project_id AND sp.author = r.id
        WHERE ${spores.sql}
        GROUP BY r.project_id, r.task`,
    ).bind(...spores.params),
    db.prepare(
      `SELECT r.project_id, COUNT(DISTINCT CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.session_id') END) AS sessions
         FROM ${RUNS_BY_TASK} CROSS JOIN agent_run_events e ON e.project_id = r.project_id AND e.run_id = r.id
          AND e.event_type = '${RUN_WRITE_EVENT}' AND e.tool_name = '${TITLE_WRITE_TOOL}'
        WHERE ${titles.sql}
        GROUP BY r.project_id`,
    ).bind(...titles.params),
    db.prepare(`SELECT project_id, repository_branch, repository_commit, generated_at, source_run_id FROM canopy_maps WHERE ${maps.sql}`)
      .bind(...maps.params),
    db.prepare(
      `SELECT r.project_id, r.id, r.task, r.status, ${RUN_AT} AS at, r.tokens_used, r.cost_usd, ${PRODUCED_SQL} AS produced,
              CASE WHEN r.task IN (${list(SPORE_TASKS)}) THEN (SELECT COUNT(*) FROM spores sp WHERE sp.project_id = r.project_id AND sp.author = r.id) ELSE 0 END AS spores,
              CASE WHEN r.task IN (${list(SPORE_TASKS)}) THEN (SELECT COUNT(DISTINCT sp.session_id) FROM spores sp WHERE sp.project_id = r.project_id AND sp.author = r.id) ELSE 0 END AS spore_sessions,
              CASE WHEN r.task = ? THEN ${TITLED_SESSION} END AS titled_session,
              CASE WHEN r.status = 'failed' THEN (SELECT rep.summary FROM agent_reports rep WHERE rep.project_id = r.project_id AND rep.run_id = r.id ORDER BY rep.id DESC LIMIT 1) END AS report,
              CASE WHEN r.status = 'failed' THEN r.error END AS error
         FROM ${RUNS_BY_TASK}
        WHERE ${all.sql} AND r.status IN ('completed', 'failed') AND (r.status = 'failed' OR ${PRODUCED_SQL})
        ORDER BY at DESC, r.id DESC LIMIT ?`,
    ).bind(...SPORE_TASKS, ...SPORE_TASKS, TITLING_TASK, ...all.params, MAX_WORK_RUNS + 1),
    upkeepStatement(db, set, since, until),
  ]);

  const key = (projectId: unknown, task: unknown): string => `${String(projectId)}\u0000${String(task)}`;
  const sporesBy = new Map((sporeOutcome.results as Record<string, unknown>[]).map((r) => [key(r.project_id, r.task), r]));
  const titlesBy = new Map((titleOutcome.results as Record<string, unknown>[]).map((r) => [String(r.project_id), num(r.sessions)]));
  const mapsBy = new Map((mapHeads.results as Record<string, unknown>[]).map((r) => [String(r.project_id), {
    branch: String(r.repository_branch), commit: String(r.repository_commit), generatedAt: num(r.generated_at), sourceRunId: String(r.source_run_id),
  }]));

  const outcomes = new Map<string, WorkOutcome>();
  for (const row of aggregate.results as Record<string, unknown>[]) {
    const task = String(row.task);
    const projectId = String(row.project_id);
    const kind = OUTCOME_KINDS[task]!;
    let outcome = outcomes.get(key(projectId, task));
    if (outcome === undefined) {
      const written = sporesBy.get(key(projectId, task));
      outcome = {
        projectId, kind, task, runs: {},
        outcome: {
          spores: num(written?.spores),
          sessions: kind === 'title' ? titlesBy.get(projectId) ?? 0 : num(written?.sessions),
          maps: 0,
        },
        failedWithOutput: 0, failed: 0, latestAt: null, tokens: 0, costUsd: 0, runsWithoutCost: 0,
        spend: { tokens: null, costUsd: null, durationMs: null },
        map: kind === 'map' ? mapsBy.get(projectId) ?? null : null,
      };
      outcomes.set(key(projectId, task), outcome);
    }
    const status = String(row.status);
    const runs = num(row.runs);
    const produced = num(row.produced);
    outcome.runs[status] = runs;
    if (kind === 'map') outcome.outcome.maps += produced;
    if (status === 'failed') { outcome.failedWithOutput += produced; outcome.failed += runs - produced; }
    const latest = orNull(row.latest_at);
    if (latest !== null && (outcome.latestAt === null || latest > outcome.latestAt)) outcome.latestAt = latest;
    outcome.tokens += num(row.tokens);
    outcome.costUsd += num(row.cost);
    outcome.runsWithoutCost += num(row.no_cost);
    if (status === 'completed') {
      outcome.spend = {
        tokens: range(row.tokens_low, row.tokens_high),
        costUsd: range(row.cost_low, row.cost_high),
        durationMs: range(row.duration_low, row.duration_high),
      };
    }
  }

  const rows = listed.results as Record<string, unknown>[];
  const runs: WorkRun[] = rows.slice(0, MAX_WORK_RUNS).map((row) => {
    const task = String(row.task);
    const kind = OUTCOME_KINDS[task]!;
    const produced = num(row.produced) === 1;
    const failed = String(row.status) === 'failed';
    const titled = row.titled_session === null || row.titled_session === undefined ? null : String(row.titled_session);
    const report = typeof row.report === 'string' && row.report.trim() !== '' ? row.report : null;
    const error = typeof row.error === 'string' && row.error.trim() !== '' ? row.error : null;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      task,
      kind,
      status: String(row.status),
      result: failed ? (produced ? 'failed_with_output' : 'failed') : 'produced',
      at: orNull(row.at),
      outcome: {
        spores: num(row.spores),
        sessions: kind === 'title' ? (produced && titled !== null ? 1 : 0) : num(row.spore_sessions),
        maps: kind === 'map' && produced ? 1 : 0,
      },
      sessionId: kind === 'title' ? titled : null,
      failure: !failed ? null : report !== null ? { cause: report, source: 'report' } : { cause: error ?? 'the run failed without saying why', source: 'error' },
      tokens: orNull(row.tokens_used),
      costUsd: orNull(row.cost_usd),
    };
  });

  return {
    window: { since, until },
    outcomes: [...outcomes.values()].sort((a, b) => (b.latestAt ?? 0) - (a.latestAt ?? 0) || a.projectId.localeCompare(b.projectId) || a.task.localeCompare(b.task)),
    runs,
    truncated: rows.length > MAX_WORK_RUNS,
    upkeep: upkeepOf(upkeep.results as Record<string, unknown>[]),
  };
}

/** An outcome task that is failing in a Project: its runs that failed having produced nothing after the task last completed there. */
export interface FailingOutcome {
  projectId: string;
  task: string;
  kind: OutcomeKind;
  failures: number;
  since: number;
  latestAt: number;
  latestRunId: string;
}

/**
 * The outcome tasks of `tasks` failing in any Project that accepts capture: runs that failed within the lookback having
 * produced nothing, and that no completed run of the same task in the same Project started after. A failed run that
 * saved its output is not a failed outcome, and a failure a later run recovered from is not a failure at all.
 */
export async function failingOutcomes(db: RelationalStore, tasks: readonly string[], lookbackFrom: number): Promise<FailingOutcome[]> {
  if (tasks.length === 0) return [];
  const projects = projectsDriving({ all: true }, 'r.project_id');
  const failedAt = 'COALESCE(r.started_at, r.queued_at, r.completed_at)';
  const { results } = await db.prepare(
    `SELECT r.project_id, r.task, COUNT(*) AS failures, MIN(${failedAt}) AS since, MAX(${failedAt}) AS latest_at,
            (SELECT l.id FROM agent_runs l WHERE l.project_id = r.project_id AND l.task = r.task AND l.status = 'failed' AND NOT ${producedSql('l')}
              ORDER BY COALESCE(l.started_at, l.queued_at, l.completed_at) DESC, l.id DESC LIMIT 1) AS latest_run
       FROM ${RUNS_BY_TASK}
      WHERE ${projects.sql} AND r.task IN (${list(tasks)}) AND r.status = 'failed' AND ${failedAt} >= ?
        AND ${failedAt} > COALESCE((SELECT MAX(s.started_at) FROM agent_runs s
              WHERE s.project_id = r.project_id AND s.task = r.task AND s.status = 'completed'), -1)
        AND NOT ${PRODUCED_SQL}
      GROUP BY r.project_id, r.task
      ORDER BY latest_at DESC`,
  ).bind(...projects.params, ...tasks, lookbackFrom).all<Record<string, unknown>>();
  return results.map((row) => ({
    projectId: String(row.project_id),
    task: String(row.task),
    kind: OUTCOME_KINDS[String(row.task)]!,
    failures: num(row.failures),
    since: num(row.since),
    latestAt: num(row.latest_at),
    latestRunId: String(row.latest_run),
  }));
}

/** Queued runs of Projects that accept capture held for a worker capability from before `queuedBefore`, by the capability that holds them. */
export async function capabilityHolds(db: RelationalStore, capabilities: readonly string[], queuedBefore: number): Promise<{ capability: string; runs: number; since: number }[]> {
  if (capabilities.length === 0) return [];
  const projects = projectsFiltering({ all: true }, 'agent_runs');
  const { results } = await db.prepare(
    `SELECT held_by, COUNT(*) AS runs, MIN(queued_at) AS since FROM agent_runs
      WHERE status = 'queued' AND queued_at <= ? AND held_by IN (${list(capabilities)}) AND ${projects.sql}
      GROUP BY held_by ORDER BY held_by`,
  ).bind(queuedBefore, ...capabilities, ...projects.params).all<Record<string, unknown>>();
  return results.map((row) => ({ capability: String(row.held_by), runs: num(row.runs), since: num(row.since) }));
}

/** Queued runs of Projects that accept capture that a worker would take, the tasks a runtime serves itself excepted, and the oldest of them. */
export async function runsAwaitingWorker(db: RelationalStore, runtimeServed: readonly string[]): Promise<{ runs: number; since: number | null }> {
  const excluded = runtimeServed.length === 0 ? '' : ` AND task NOT IN (${list(runtimeServed)})`;
  const projects = projectsFiltering({ all: true }, 'agent_runs');
  const row = await db.prepare(
    `SELECT COUNT(*) AS runs, MIN(queued_at) AS since FROM agent_runs
      WHERE status = 'queued' AND dispatched_by IS NULL AND task IS NOT NULL${excluded} AND ${projects.sql}`,
  ).bind(...runtimeServed, ...projects.params).first<Record<string, unknown>>();
  return { runs: num(row?.runs), since: orNull(row?.since) };
}
