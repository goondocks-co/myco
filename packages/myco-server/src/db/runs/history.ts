/**
 * Run history reads: Work summaries over supported UTC windows from the maintained rollups, keyset run timelines, the
 * run list and one run's row, and the failure and hold reads attention takes.
 *
 * Counts never read history: they read `work_daily` and `work_window_totals`. A range that is not a supported UTC
 * window has no totals; it reads the paged timeline only.
 */
import type { RelationalStore } from '../../core/adapters.js';
import type { ReadScope, ProjectSet } from '../../read/scope.js';
import { EMBEDDING_TASK } from '../../core/embedding/task.js';
import { producedSql, runResultSql } from '../../read/run-outcome.js';
import { costProvenanceValue } from '../run-accounting.js';
import { requestedProfileValue } from '../run-profile.js';
import { contextValue, DISPATCH_ACTOR_SQL, ENDED_NOTE_KEY, FAILURE_REASON_KEY, HARNESS_STOP_KEY, REPOSITORY_FAILURE_CODE_KEY, REPOSITORY_FAILURE_SUMMARY_KEY } from '../run-context.js';
import { read, readSet, type BindValue } from '../index.js';
import { RUN_ADMISSION_READY_SQL } from './live.js';
import { LIVE_RUN_STATUSES } from '../run-statuses.js';
import { WORK_HISTORY_READY_SQL, WORK_TASKS, WORK_WINDOW_SPANS } from './history-schema.js';
import { failureThreshold, unresolvedFailure } from './outcomes.js';

export const OUTCOME_TASKS: readonly string[] = WORK_TASKS;
/** A window read by supported UTC days, its end excluded. */
export interface UtcWindow { since: number; until: number; firstDay: number; lastDay: number; spanDays: number }
export const DAY_MS = 86_400_000;

/** The window as supported UTC days, or null for a range the rollups do not answer. */
export function supportedUtcWindow(since: number, until: number): UtcWindow | null {
  if (since % DAY_MS !== 0 || until % DAY_MS !== 0) return null;
  const spanDays = (until - since) / DAY_MS;
  if (!(WORK_WINDOW_SPANS as readonly number[]).includes(spanDays)) return null;
  return { since, until, firstDay: since / DAY_MS, lastDay: until / DAY_MS - 1, spanDays };
}

type Row = Record<string, unknown>;
const TASKS_JSON = JSON.stringify(WORK_TASKS);
const setIn = (all: boolean, column: string) => all
  ? `${column} IN (SELECT project_id FROM projects WHERE archived_at IS NULL AND ?1 IS NOT NULL)`
  : `${column} IN (SELECT value FROM json_each(?1))`;
const setValue = (set: ProjectSet) => set.all ? '' : JSON.stringify(set.projectIds);
const bySet = <T>(build: (all: boolean, tag: string) => T): [T, T] => [build(true, 'All'), build(false, 'Named')];
const forSet = <T>(pair: [T, T], set: ProjectSet): T => pair[set.all ? 0 : 1];

const readiness = read<[], { history: number; admission: number }>({ name: 'runs.workReadiness', sql: `SELECT ${WORK_HISTORY_READY_SQL} AS history,${RUN_ADMISSION_READY_SQL} AS admission` });
export interface WorkReadiness { history: boolean; admission: boolean }
/** Whether the rollups cover history yet: a timeline read answers `building` until they do, never a partial page. */
export async function workHistoryReady(db: RelationalStore): Promise<boolean> {
  const [rows] = await readSet(db, readiness.bind());
  return rows[0]?.history === 1;
}

const daily = bySet((all, tag) => read<[string, number, number], Row>({ name: `runs.workDaily${tag}`, sql: `SELECT d.project_id,d.task,d.status,SUM(d.runs) AS runs,SUM(d.tokens) AS tokens,
    SUM(d.cost)+SUM(d.cost_carry) AS cost,SUM(d.no_cost) AS no_cost,SUM(d.produced) AS produced,SUM(d.spores) AS spores,
    MIN(d.tokens_low) AS tokens_low,MAX(d.tokens_high) AS tokens_high,MIN(d.cost_low) AS cost_low,MAX(d.cost_high) AS cost_high,MIN(d.duration_low) AS duration_low,MAX(d.duration_high) AS duration_high
  FROM work_daily d WHERE ${setIn(all, 'd.project_id')} AND d.day BETWEEN ?2 AND ?3 GROUP BY d.project_id,d.task,d.status` }));
const sessions = bySet((all, tag) => read<[string, number, number, string], Row>({ name: `runs.workSessions${tag}`, sql: `SELECT w.project_id,w.task,w.sessions FROM work_window_totals w
  WHERE ${setIn(all, 'w.project_id')} AND w.span_days=?2 AND w.end_day=?3 AND w.task IN (SELECT value FROM json_each(?4))` }));
const heads = bySet((all, tag) => read<[string, number, number, number, number], Row>({ name: `runs.workHeads${tag}`, sql: `SELECT h.*,
    CASE WHEN h.failed_run IS NULL THEN 0 ELSE EXISTS(SELECT 1 FROM work_run_contribution c INDEXED BY idx_work_run_failed CROSS JOIN agent_runs r ON r.project_id=c.project_id AND r.id=c.run_id
      WHERE c.project_id=h.project_id AND c.task=h.task AND c.status='failed' AND c.produced=0 AND c.at>=MAX(?4,h.threshold) AND c.at<?5 AND ${unresolvedFailure('r', 'h.threshold')}) END AS unresolved FROM (
    SELECT p.project_id,p.task,${failureThreshold('p.project_id', 'p.task')} AS threshold,
      (SELECT MAX(c.at) FROM work_run_contribution c INDEXED BY idx_work_run_latest WHERE c.project_id=p.project_id AND c.task=p.task AND c.at>=?4 AND c.at<?5) AS latest_at,
      (SELECT c.run_id FROM work_run_contribution c INDEXED BY idx_work_run_failed WHERE c.project_id=p.project_id AND c.task=p.task AND c.status='failed' AND c.produced=0 AND c.at>=?4 AND c.at<?5 ORDER BY c.at DESC,c.run_id DESC LIMIT 1) AS failed_run,
      (SELECT MAX(c.at) FROM work_run_contribution c INDEXED BY idx_work_run_failed WHERE c.project_id=p.project_id AND c.task=p.task AND c.status='failed' AND c.produced=0 AND c.at>=?4 AND c.at<?5) AS failed_at
    FROM (SELECT DISTINCT project_id,task FROM work_daily d WHERE ${setIn(all, 'd.project_id')} AND d.day BETWEEN ?2 AND ?3) p) h` }));
const queued = bySet((all, tag) => read<[string, string], Row>({ name: `runs.workQueued${tag}`, sql: `SELECT t.project_id,t.task,t.queued_count AS runs,
    (SELECT MAX(d.queued_at) FROM task_due d WHERE d.project_id=t.project_id AND d.task=t.task AND d.origin=t.origin) AS latest
  FROM task_runtime t WHERE ${setIn(all, 't.project_id')} AND t.task IN (SELECT value FROM json_each(?2)) AND t.queued_count>0` }));
const running = bySet((all, tag) => read<[string, string], Row>({ name: `runs.workRunning${tag}`, sql: `SELECT r.project_id,r.task,r.status,COUNT(*) AS runs,MAX(COALESCE(r.queued_at,r.started_at)) AS latest
  FROM agent_runs r INDEXED BY idx_agent_runs_claimable WHERE r.${LIVE_RUN_STATUSES} AND r.task IN (SELECT value FROM json_each(?2)) AND ${setIn(all, 'r.project_id')}
  GROUP BY r.project_id,r.task,r.status` }));

/** Full-window counts by Project, task and status from the rollups, read in one snapshot; `liveNow` adds running and queued work. */
export async function workSummary(db: RelationalStore, set: ProjectSet, window: UtcWindow, liveNow: boolean) {
  const arg = setValue(set);
  const [ready, dailyRows, sessionRows, headRows, queuedRows, runningRows] = await readSet(db,
    readiness.bind(),
    forSet(daily, set).bind(arg, window.firstDay, window.lastDay),
    forSet(sessions, set).bind(arg, window.spanDays, window.lastDay, TASKS_JSON),
    forSet(heads, set).bind(arg, window.firstDay, window.lastDay, window.since, window.until),
    forSet(queued, set).bind(arg, TASKS_JSON),
    forSet(running, set).bind(arg, TASKS_JSON));
  return { ready: { history: ready[0]?.history === 1, admission: ready[0]?.admission === 1 }, daily: dailyRows, sessions: sessionRows, heads: headRows, queued: liveNow ? queuedRows : [], running: liveNow ? runningRows : [] };
}

const SCOPE_PAGE = 201;
const timelineRow = `c.project_id,c.run_id AS id,c.task,c.status,c.at,c.tokens AS tokens_used,c.cost AS cost_usd,c.produced,c.spores,c.sessions AS spore_sessions,c.title_session AS titled_session,
  r.queued_at,r.started_at,r.completed_at,${requestedProfileValue('r.')} AS requested_profile,r.harness,r.model,r.provider,r.usage_data,${costProvenanceValue('r.')} AS cost_provenance,
  CASE WHEN c.status='failed' THEN r.error END AS error,CASE WHEN c.status='failed' THEN r.error_code END AS error_code,
  CASE WHEN c.status='failed' THEN ${contextValue(FAILURE_REASON_KEY)} END AS error_reason,
  CASE WHEN c.status='failed' THEN ${contextValue(REPOSITORY_FAILURE_CODE_KEY)} END AS repository_failure_code,
  CASE WHEN c.status='failed' THEN ${contextValue(REPOSITORY_FAILURE_SUMMARY_KEY)} END AS repository_failure_summary`;
const timeline = (name: string, indexed: string, match: string, keyed: boolean) => read<BindValue[], Row>({ name,
  sql: `SELECT ${timelineRow} FROM work_run_contribution c INDEXED BY ${indexed} CROSS JOIN agent_runs r ON r.project_id=c.project_id AND r.id=c.run_id
    WHERE ${match} AND c.listed=1 AND c.at>=?2 AND c.at<?3 ${keyed ? 'AND (c.at,c.project_id,c.run_id)<(?4,?5,?6)' : ''}
    ORDER BY c.at DESC,c.project_id DESC,c.run_id DESC LIMIT ${SCOPE_PAGE}` });
const timelines = {
  project: [false, true].map(keyed => timeline(`runs.workTimelineProject${Number(keyed)}`, 'idx_work_timeline_project', 'c.project_id=?1', keyed)),
  all: [false, true].map(keyed => timeline(`runs.workTimelineAll${Number(keyed)}`, 'idx_work_timeline', `EXISTS(SELECT 1 FROM projects p WHERE p.project_id=c.project_id AND p.archived_at IS NULL AND ?1 IS NOT NULL)`, keyed)),
  named: [false, true].map(keyed => timeline(`runs.workTimelineNamed${Number(keyed)}`, 'idx_work_timeline', 'c.project_id IN (SELECT value FROM json_each(?1))', keyed)),
};
export interface TimelineCursor { at: number; projectId: string; id: string }
export const WORK_TIMELINE_PAGE = SCOPE_PAGE - 1;

/** One keyset page of the runs that published output or failed, newest first. Bounded by the page however wide the range. */
export async function workTimeline(db: RelationalStore, set: ProjectSet, since: number, until: number, cursor?: TimelineCursor): Promise<{ rows: Row[]; hasMore: boolean }> {
  const single = !set.all && set.projectIds.length === 1;
  const statement = (single ? timelines.project : set.all ? timelines.all : timelines.named)[Number(cursor !== undefined)]!;
  const arg = single ? set.projectIds[0]! : setValue(set);
  const [rows] = await readSet(db, statement.bind(arg, since, until, ...(cursor === undefined ? [] : [cursor.at, cursor.projectId, cursor.id])));
  return { rows: rows.slice(0, WORK_TIMELINE_PAGE), hasMore: rows.length > WORK_TIMELINE_PAGE };
}

const maps = bySet((all, tag) => read<[string], Row>({ name: `runs.workMaps${tag}`, sql: `SELECT m.project_id,m.repository_branch,m.repository_commit,m.generated_at,m.source_run_id
  FROM canopy_maps m WHERE ${setIn(all, 'm.project_id')}` }));
export async function currentMaps(db: RelationalStore, set: ProjectSet): Promise<Row[]> {
  const [rows] = await readSet(db, forSet(maps, set).bind(setValue(set)));
  return rows;
}

const failedAfter = (bound: string) => `FROM agent_runs r WHERE r.project_id=u.project_id AND r.task=?2 AND r.status='failed' AND r.started_at>${bound}`;
const upkeep = bySet((all, tag) => read<[string, string, number, number], Row>({ name: `runs.workUpkeep${tag}`, sql: `SELECT u.project_id,u.last_success,u.failed_in_window,
    (SELECT COUNT(*) ${failedAfter('COALESCE(u.last_success,-1)')}) AS unrecovered,
    (SELECT MIN(r.started_at) ${failedAfter('COALESCE(u.last_success,-1)')}) AS unrecovered_since,
    (SELECT json_object('projectId',r.project_id,'runId',r.id,'at',COALESCE(r.completed_at,r.started_at),'code',r.error_code,'error',r.error) ${failedAfter('COALESCE(u.last_success,-1)')} ORDER BY COALESCE(r.completed_at,r.started_at) DESC,r.id DESC LIMIT 1) AS latest_failure
  FROM (SELECT p.project_id,
      (SELECT MAX(r.started_at) FROM agent_runs r WHERE r.project_id=p.project_id AND r.task=?2 AND r.status='completed') AS last_success,
      (SELECT COUNT(*) FROM agent_runs r WHERE r.project_id=p.project_id AND r.task=?2 AND r.status='failed' AND r.started_at>=?3 AND r.started_at<?4) AS failed_in_window
    FROM projects p WHERE ${setIn(all, 'p.project_id')}) u` }));
export async function upkeepRows(db: RelationalStore, set: ProjectSet, since: number, until: number): Promise<Row[]> {
  const [rows] = await readSet(db, forSet(upkeep, set).bind(setValue(set), EMBEDDING_TASK, since, until));
  return rows;
}

const FAILING_AT = 'COALESCE(r.started_at,r.queued_at,r.completed_at)';
const VISIBLE = `r.project_id IN (SELECT project_id FROM projects WHERE archived_at IS NULL)`;
const failing = read<[string, number], Row>({ name: 'runs.failingOutcomes', sql: `SELECT r.project_id,r.task,COUNT(*) AS failures,MIN(${FAILING_AT}) AS since,MAX(${FAILING_AT}) AS latest_at,
    (SELECT l.id FROM agent_runs l WHERE l.project_id=r.project_id AND l.task=r.task AND l.status='failed' AND NOT ${producedSql('l')}
      ORDER BY COALESCE(l.started_at,l.queued_at,l.completed_at) DESC,l.id DESC LIMIT 1) AS latest_run
  FROM agent_runs r INDEXED BY idx_agent_runs_task
  WHERE ${VISIBLE} AND r.task IN (SELECT value FROM json_each(?1)) AND r.status='failed' AND ${FAILING_AT}>=?2
    AND ${FAILING_AT}>COALESCE((SELECT MAX(s.started_at) FROM agent_runs s WHERE s.project_id=r.project_id AND s.task=r.task AND s.status='completed'),-1)
    AND NOT ${producedSql('r')}
  GROUP BY r.project_id,r.task ORDER BY latest_at DESC` });
export const failingRows = async (db: RelationalStore, tasks: readonly string[], lookbackFrom: number): Promise<Row[]> => (await readSet(db, failing.bind(JSON.stringify(tasks), lookbackFrom)))[0];

const audits = read<[string, string, number], Row>({ name: 'runs.auditFailures', sql: `SELECT r.project_id,COUNT(*) AS closed,SUM(r.error_code=?1) AS runs,
    MIN(CASE WHEN r.error_code=?1 THEN r.completed_at END) AS since,MAX(CASE WHEN r.error_code=?1 THEN r.completed_at END) AS latest_at,
    (SELECT l.id FROM agent_runs l WHERE l.project_id=r.project_id AND l.error_code=?1 AND l.task IN (SELECT value FROM json_each(?2)) AND l.completed_at>=?3
      ORDER BY l.completed_at DESC,l.id DESC LIMIT 1) AS latest_run
  FROM agent_runs r INDEXED BY idx_agent_runs_task
  WHERE ${VISIBLE} AND r.task IN (SELECT value FROM json_each(?2)) AND r.status IN ('completed','failed') AND r.completed_at>=?3
    AND EXISTS (SELECT 1 FROM agent_run_attempts a WHERE a.project_id=r.project_id AND a.run_id=r.id)
  GROUP BY r.project_id HAVING SUM(r.error_code=?1)>0 ORDER BY latest_at DESC` });
export const auditRows = async (db: RelationalStore, code: string, tasks: readonly string[], lookbackFrom: number): Promise<Row[]> => (await readSet(db, audits.bind(code, JSON.stringify(tasks), lookbackFrom)))[0];

const holds = read<[number, string], Row>({ name: 'runs.capabilityHolds', sql: `SELECT held_by,COUNT(*) AS runs,MIN(queued_at) AS since FROM agent_runs r
  WHERE r.status='queued' AND r.queued_at<=?1 AND r.held_by IN (SELECT value FROM json_each(?2)) AND ${VISIBLE} GROUP BY held_by ORDER BY held_by` });
export const holdRows = async (db: RelationalStore, capabilities: readonly string[], queuedBefore: number): Promise<Row[]> => (await readSet(db, holds.bind(queuedBefore, JSON.stringify(capabilities))))[0];

const awaiting = read<[string], Row>({ name: 'runs.awaitingWorker', sql: `SELECT COUNT(*) AS runs,MIN(queued_at) AS since FROM agent_runs r
  WHERE r.status='queued' AND r.dispatched_by IS NULL AND r.task IS NOT NULL AND r.task NOT IN (SELECT value FROM json_each(?1)) AND ${VISIBLE}` });
export const awaitingRow = async (db: RelationalStore, runtimeServed: readonly string[]): Promise<Row> => (await readSet(db, awaiting.bind(JSON.stringify(runtimeServed))))[0][0] ?? {};

/** The run list's filters; a set filter narrows a page before its cursor applies. */
export interface RunListFilters { status?: string; task?: string; agentId?: string; since?: number; until?: number }
export interface RunListCursor { at: number; id: string }
export const LIST_ORDER = 'COALESCE(queued_at, started_at)';
export const WINDOW_ORDER = 'COALESCE(completed_at, queued_at, started_at)';
const COLUMNS = `id, agent_id, task, status, provider, model, usage_data,
  ${runResultSql('agent_runs')} AS result,
  ${requestedProfileValue()} AS requested_profile,
  ${costProvenanceValue()} AS cost_provenance, started_at, resumed_at, completed_at,
  tokens_used, cost_usd, cost_source, dry_run, resumable, resume_status, (error IS NOT NULL) AS failed,
  queued_at, held_by,
  ${contextValue('replaced')} AS replaced, ${contextValue('replaces')} AS replaces,
  harness, leased_by, lease_expires_at, leased_runner_id, leased_runner_credential_id,
  (SELECT r.name FROM runners r WHERE r.id = agent_runs.leased_runner_id) AS leased_runner_name,
  (SELECT c.machine_id FROM member_credentials c WHERE c.id = agent_runs.leased_by) AS leased_machine,
  (SELECT c.member_id FROM member_credentials c WHERE c.id = agent_runs.leased_by) AS leased_member,
  (SELECT m.label FROM member_credentials c CROSS JOIN members m ON m.id = c.member_id WHERE c.id = agent_runs.leased_by) AS leased_member_label,
  ${DISPATCH_ACTOR_SQL} AS started_by, ${contextValue('session_id')} AS target_session_id,
  CASE WHEN status = 'skipped' THEN ${contextValue('reason')} END AS skip_reason`;
const DETAIL_COLUMNS = `${COLUMNS},
  ${contextValue('repository.branch')} AS source_branch, ${contextValue('repository.commit')} AS source_commit,
  instruction, session_ref, actual_cost_usd, estimated_cost_usd, reasoning_level,
  resume_mode, resume_attempts, error, error_code, CASE WHEN status = 'failed' THEN ${contextValue(FAILURE_REASON_KEY)} END AS error_reason,
  CASE WHEN status = 'failed' THEN ${contextValue(REPOSITORY_FAILURE_CODE_KEY)} END AS repository_failure_code,
  CASE WHEN status = 'failed' THEN ${contextValue(REPOSITORY_FAILURE_SUMMARY_KEY)} END AS repository_failure_summary,
  CASE WHEN json_valid(${contextValue(HARNESS_STOP_KEY)}) THEN ${contextValue(HARNESS_STOP_KEY)} END AS harness_stop,
  ${contextValue(ENDED_NOTE_KEY)} AS ended_note,
  dispatched_by, actions_taken, checkpoints`;

const FILTERS = [['status', 'status = ?'], ['task', 'task = ?'], ['agentId', 'agent_id = ?'], ['since', 'WINDOW >= ?'], ['until', 'WINDOW < ?']] as const;
const pageStatement = (mask: number, order: string, keyed: boolean) => read<BindValue[], Row>({ name: `runs.listPage${order === WINDOW_ORDER ? 'Window' : 'Entry'}${mask}${keyed ? 'After' : ''}`,
  sql: `SELECT ${COLUMNS} FROM agent_runs WHERE project_id = ?${FILTERS.filter((_, bit) => mask & (1 << bit)).map(([, condition]) => ` AND ${condition.replace('WINDOW', WINDOW_ORDER)}`).join('')}
    ${keyed ? `AND ${order} <= ? AND (${order} < ? OR (${order} = ? AND id < ?))` : ''} ORDER BY ${order} DESC, id DESC LIMIT ?` });
const pageStatements = Array.from({ length: 1 << FILTERS.length }, (_, mask) => ({
  windowed: [false, true].map(keyed => pageStatement(mask, WINDOW_ORDER, keyed)),
  entry: [false, true].map(keyed => pageStatement(mask, LIST_ORDER, keyed)),
}));
/** One page of a Project's runs, newest first, on the entry order or, for a windowed read, on the effective-time order. */
export async function runListRows(db: RelationalStore, scope: ReadScope, filters: RunListFilters, limit: number, cursor?: RunListCursor): Promise<Row[]> {
  const mask = FILTERS.reduce((bits, [key], bit) => filters[key] === undefined ? bits : bits | (1 << bit), 0);
  const order = filters.since !== undefined || filters.until !== undefined;
  const statement = pageStatements[mask]![order ? 'windowed' : 'entry'][Number(cursor !== undefined)]!;
  const filtered = FILTERS.flatMap(([key]) => filters[key] === undefined ? [] : [filters[key]!]);
  const [rows] = await readSet(db, statement.bind(scope.projectId, ...filtered, ...(cursor === undefined ? [] : [cursor.at, cursor.at, cursor.at, cursor.id]), limit));
  return rows;
}

const detail = read<[string, string], Row>({ name: 'runs.detailRow', sql: `SELECT ${DETAIL_COLUMNS} FROM agent_runs WHERE project_id = ?1 AND id = ?2` });
export async function runDetailRow(db: RelationalStore, scope: ReadScope, runId: string): Promise<Row | null> {
  const [rows] = await readSet(db, detail.bind(scope.projectId, runId));
  return rows[0] ?? null;
}
