import { taskHoldSql } from './queue.js';
import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import type { RelationalStore } from '../../core/adapters.js';
import { NOW_WATCHED_TASKS, unresolvedFailureRows } from './outcomes.js';
import { RUN_TOOL_EVENT } from '../../core/runs.js';
import { read, readSet } from '../index.js';

export const NOW_PROJECTS_MAX = 25;
export const NOW_RUNNING_MAX = 20;
export type TodayScope = { projectId: string } | { all: true };
export interface ProjectCursor { priority: number; activity: number; projectId: string }
type Row = Record<string, unknown>;
const scopeSql = `(?1 IS NULL AND EXISTS(SELECT 1 FROM projects p WHERE p.project_id=r.project_id AND p.archived_at IS NULL) OR r.project_id=?1)`;
const projectScope = '(?1 IS NULL AND p.archived_at IS NULL OR p.project_id=?1)';
const projectRows = `WITH live AS MATERIALIZED (SELECT DISTINCT project_id FROM agent_runs INDEXED BY idx_agent_runs_claimable
    WHERE ${IN_FLIGHT_RUN_STATUSES})
  SELECT p.project_id,CASE WHEN EXISTS(SELECT 1 FROM live WHERE live.project_id=p.project_id)
    OR EXISTS(SELECT 1 FROM json_each('${JSON.stringify(NOW_WATCHED_TASKS)}') t
      WHERE EXISTS(SELECT 1 FROM (${unresolvedFailureRows('p.project_id', 't.value')}))) THEN 1 ELSE 0 END AS priority,
    COALESCE((SELECT f.last_received_at FROM session_read_facts f
      WHERE f.project_id=p.project_id AND f.has_session=1 AND f.tombstoned=0 ORDER BY f.last_received_at DESC LIMIT 1),p.created_at) AS activity
    FROM projects p WHERE ${projectScope}`;
const projects = read<[string | null, number | null, number | null, string | null], { project_id: string; priority: number; activity: number }>({
  name: 'runs.todayProjects', sql: `SELECT * FROM (${projectRows}) WHERE ?2 IS NULL OR priority<?2
    OR (priority=?2 AND (activity<?3 OR (activity=?3 AND project_id>?4)))
    ORDER BY priority DESC,activity DESC,project_id LIMIT ${NOW_PROJECTS_MAX + 1}`,
});
const projectTotal = read<[string | null], { n: number }>({ name: 'runs.todayProjectTotal', sql: `SELECT COUNT(*) AS n FROM projects p WHERE ${projectScope}` });
export async function todayProjects(db: RelationalStore, scope: TodayScope, cursor: ProjectCursor | null = null) {
  const id = 'projectId' in scope ? scope.projectId : null;
  const [rows, total] = await readSet(db, projects.bind(id, cursor?.priority ?? null, cursor?.activity ?? null, cursor?.projectId ?? null), projectTotal.bind(id));
  const page = rows.slice(0, NOW_PROJECTS_MAX);
  const last = page.at(-1);
  const hasMore = rows.length > NOW_PROJECTS_MAX;
  return { read: page.map(row => row.project_id), total: total[0]!.n, hasMore,
    cursor: hasMore && last ? { priority: last.priority, activity: last.activity, projectId: last.project_id } : null };
}
const runningSql = `SELECT r.project_id,r.id,r.task,r.harness,r.model,r.started_at,n.name AS runner
  FROM agent_runs r INDEXED BY idx_agent_runs_claimable LEFT JOIN runners n ON n.id=r.leased_runner_id
  WHERE r.status='running' AND ${scopeSql} ORDER BY r.queued_at,r.id LIMIT ${NOW_RUNNING_MAX}`;
const runningPage = read<[string | null], Row>({ name: 'runs.todayRunning', sql: runningSql });
const runningCount = read<[string | null], { n: number }>({ name: 'runs.todayRunningCount', sql: `SELECT COUNT(*) AS n
  FROM agent_runs r INDEXED BY idx_agent_runs_claimable WHERE r.status='running' AND ${scopeSql}` });
const keys = `WITH keys AS (SELECT json_extract(value,'$[0]') AS project_id,json_extract(value,'$[1]') AS id
  FROM json_each((SELECT json_group_array(json_array(project_id,id)) FROM (${runningSql}))))`;
const profile = read<[string | null], Row>({ name: 'runs.todayProfiles', sql: `${keys} SELECT k.project_id,k.id,
  json_extract(a.profile_json,'$.harness') AS harness,json_extract(a.profile_json,'$.profile.model') AS model
  FROM keys k JOIN agent_run_attempts a ON a.project_id=k.project_id AND a.run_id=k.id AND a.attempt_id=(
    SELECT attempt_id FROM agent_run_attempts WHERE project_id=k.project_id AND run_id=k.id ORDER BY claimed_at DESC LIMIT 1)` });
const steps = read<[string | null], Row>({ name: 'runs.todaySteps', sql: `${keys} SELECT k.project_id,k.id,s.kind,s.tool,s.target,s.started_at
  FROM keys k JOIN agent_run_steps s ON s.project_id=k.project_id AND s.run_id=k.id
    AND s.attempt_id=(SELECT attempt_id FROM agent_run_attempts WHERE project_id=k.project_id AND run_id=k.id ORDER BY claimed_at DESC LIMIT 1)
    AND s.seq=(SELECT seq FROM agent_run_steps WHERE project_id=k.project_id AND run_id=k.id AND attempt_id=s.attempt_id ORDER BY seq DESC LIMIT 1)` });
const calls = read<[string | null], Row>({ name: 'runs.todayCalls', sql: `${keys} SELECT k.project_id,k.id,e.tool_name,CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.op') END AS op,e.recorded_at
  FROM keys k JOIN agent_run_events e ON e.project_id=k.project_id AND e.run_id=k.id AND e.id=(
    SELECT id FROM agent_run_events WHERE project_id=k.project_id AND run_id=k.id AND event_type='${RUN_TOOL_EVENT}' ORDER BY recorded_at DESC LIMIT 1)` });
export async function todayRunning(db: RelationalStore, scope: TodayScope) {
  const id = 'projectId' in scope ? scope.projectId : null;
  const [rows, total, profiles, latestSteps, latestCalls] = await readSet(db, runningPage.bind(id), runningCount.bind(id), profile.bind(id), steps.bind(id), calls.bind(id));
  const index = (entries: Row[]) => new Map(entries.map(row => [`${String(row.project_id)}\0${String(row.id)}`, row]));
  return { rows, total: total[0]!.n, hasMore: total[0]!.n > rows.length, profiles: index(profiles), steps: index(latestSteps), calls: index(latestCalls) };
}
const queued = read<[string | null], Row>({ name: 'runs.todayQueued', sql: `SELECT r.project_id,NULLIF(r.task,'') AS task,${taskHoldSql('r.hold_reason', 'r.origin')} AS held_by,r.queued_count AS count,
  r.oldest_queued_at AS since,r.oldest_run_id AS oldest_id
  FROM task_runtime r WHERE r.queued_count>0 AND ${scopeSql}` });
export async function todayQueued(db: RelationalStore, scope: TodayScope): Promise<Row[]> {
  const [rows] = await readSet(db, queued.bind('projectId' in scope ? scope.projectId : null));
  return rows;
}
