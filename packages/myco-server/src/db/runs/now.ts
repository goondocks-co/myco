import { taskHoldSql } from './queue.js';
import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import type { RelationalStore } from '../../core/adapters.js';
import { NOW_WATCHED_TASKS, unresolvedFailureRows } from './outcomes.js';
import { RUN_TOOL_EVENT } from './evidence.js';
import { read, readSet } from '../index.js';

export const NOW_PROJECTS_MAX = 25;
const NOW_RUNNING_MAX = 20;
type TodayScope = { projectId: string } | { all: true };
export interface ProjectCursor { priority: number; activity: number; projectId: string }
type Row = Record<string, unknown>;
const scopeSql = ({ all }: { all: boolean }) => all ? '?1 IS NULL AND EXISTS(SELECT 1 FROM projects p WHERE p.project_id=r.project_id AND p.archived_at IS NULL)' : 'r.project_id=?1';
const projectScope = ({ all }: { all: boolean }) => all ? '?1 IS NULL AND p.archived_at IS NULL' : 'p.project_id=?1';
const projectRows = ({ all }: { all: boolean }) => `WITH live AS MATERIALIZED (SELECT DISTINCT project_id FROM agent_runs INDEXED BY ${all ? 'idx_agent_runs_claimable' : 'idx_agent_runs_task'}
    WHERE ${IN_FLIGHT_RUN_STATUSES}${all ? '' : ' AND project_id=?1 LIMIT 1'})
  SELECT p.project_id,CASE WHEN EXISTS(SELECT 1 FROM live WHERE live.project_id=p.project_id)
    OR EXISTS(SELECT 1 FROM json_each('${JSON.stringify(NOW_WATCHED_TASKS)}') t
      WHERE EXISTS(SELECT 1 FROM (${unresolvedFailureRows('p.project_id', 't.value')}))) THEN 1 ELSE 0 END AS priority,
    COALESCE((SELECT f.last_received_at FROM session_read_facts f
      WHERE f.project_id=p.project_id AND f.has_session=1 AND f.tombstoned=0 ORDER BY f.last_received_at DESC LIMIT 1),p.created_at) AS activity
    FROM projects p WHERE ${projectScope({ all })}`;
const projects = [true, false].map(all => read<[project: string | null, priority: number | null, activity: number | null, after: string | null], { project_id: string; priority: number; activity: number }>({
  name: `runs.todayProjects${all ? 'All' : 'Named'}`, sql: `SELECT * FROM (${projectRows({ all })}) WHERE ?2 IS NULL OR priority<?2
    OR (priority=?2 AND (activity<?3 OR (activity=?3 AND project_id>?4)))
    ORDER BY priority DESC,activity DESC,project_id LIMIT ${NOW_PROJECTS_MAX + 1}`,
}));
const projectTotal = [true, false].map(all => read<[project: string | null], { n: number }>({ name: `runs.todayProjectTotal${all ? 'All' : 'Named'}`, sql: `SELECT COUNT(*) AS n FROM projects p WHERE ${projectScope({ all })}` }));
export async function todayProjects(db: RelationalStore, scope: TodayScope, cursor: ProjectCursor | null = null) {
  const id = 'projectId' in scope ? scope.projectId : null;
  const index = 'projectId' in scope ? 1 : 0;
  const [rows, total] = await readSet(db, projects[index]!.bind(id, cursor?.priority ?? null, cursor?.activity ?? null, cursor?.projectId ?? null), projectTotal[index]!.bind(id));
  const page = rows.slice(0, NOW_PROJECTS_MAX);
  const last = page.at(-1);
  const hasMore = rows.length > NOW_PROJECTS_MAX;
  return { read: page.map(row => row.project_id), total: total[0]!.n, hasMore,
    cursor: hasMore && last ? { priority: last.priority, activity: last.activity, projectId: last.project_id } : null };
}
const runningSql = ({ all }: { all: boolean }) => `SELECT r.project_id,r.id,r.task,r.harness,r.model,r.started_at,n.name AS runner,n.id AS runner_id,
  (SELECT c.last_seen_at FROM runner_contacts c WHERE c.runner_id=r.leased_runner_id) AS heard_at
  FROM agent_runs r INDEXED BY ${all ? 'idx_agent_runs_claimable' : 'idx_agent_runs_task'} LEFT JOIN runners n ON n.id=r.leased_runner_id
  WHERE r.status='running' AND ${scopeSql({ all })} ORDER BY r.queued_at,r.id LIMIT ${NOW_RUNNING_MAX}`;
const runningPage = [true, false].map(all => read<[project: string | null], Row>({ name: `runs.todayRunning${all ? 'All' : 'Named'}`, sql: runningSql({ all }) }));
const runningCount = [true, false].map(all => read<[project: string | null], { n: number }>({ name: `runs.todayRunningCount${all ? 'All' : 'Named'}`, sql: `SELECT COUNT(*) AS n
  FROM agent_runs r INDEXED BY ${all ? 'idx_agent_runs_claimable' : 'idx_agent_runs_task'} WHERE r.status='running' AND ${scopeSql({ all })}` }));
const keys = ({ all }: { all: boolean }) => `WITH keys AS (SELECT json_extract(value,'$[0]') AS project_id,json_extract(value,'$[1]') AS id
  FROM json_each((SELECT json_group_array(json_array(project_id,id)) FROM (${runningSql({ all })}))))`;
const profile = [true, false].map(all => read<[project: string | null], Row>({ name: `runs.todayProfiles${all ? 'All' : 'Named'}`, sql: `${keys({ all })} SELECT k.project_id,k.id,
  json_extract(a.profile_json,'$.harness') AS harness,json_extract(a.profile_json,'$.profile.model') AS model
  FROM keys k JOIN agent_run_attempts a ON a.project_id=k.project_id AND a.run_id=k.id AND a.attempt_id=(
    SELECT attempt_id FROM agent_run_attempts WHERE project_id=k.project_id AND run_id=k.id ORDER BY claimed_at DESC LIMIT 1)` }));
const steps = [true, false].map(all => read<[project: string | null], Row>({ name: `runs.todaySteps${all ? 'All' : 'Named'}`, sql: `${keys({ all })} SELECT k.project_id,k.id,s.kind,s.tool,s.target,s.started_at
  FROM keys k JOIN agent_run_steps s ON s.project_id=k.project_id AND s.run_id=k.id
    AND s.attempt_id=(SELECT attempt_id FROM agent_run_attempts WHERE project_id=k.project_id AND run_id=k.id ORDER BY claimed_at DESC LIMIT 1)
    AND s.seq=(SELECT seq FROM agent_run_steps WHERE project_id=k.project_id AND run_id=k.id AND attempt_id=s.attempt_id ORDER BY seq DESC LIMIT 1)` }));
const calls = [true, false].map(all => read<[project: string | null], Row>({ name: `runs.todayCalls${all ? 'All' : 'Named'}`, sql: `${keys({ all })} SELECT k.project_id,k.id,e.tool_name,CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.op') END AS op,e.recorded_at
  FROM keys k JOIN agent_run_events e ON e.project_id=k.project_id AND e.run_id=k.id AND e.id=(
    SELECT id FROM agent_run_events WHERE project_id=k.project_id AND run_id=k.id AND event_type='${RUN_TOOL_EVENT}' ORDER BY recorded_at DESC LIMIT 1)` }));
export async function todayRunning(db: RelationalStore, scope: TodayScope) {
  const id = 'projectId' in scope ? scope.projectId : null;
  const variant = 'projectId' in scope ? 1 : 0;
  const [rows, total, profiles, latestSteps, latestCalls] = await readSet(db, runningPage[variant]!.bind(id), runningCount[variant]!.bind(id), profile[variant]!.bind(id), steps[variant]!.bind(id), calls[variant]!.bind(id));
  const index = (entries: Row[]) => new Map(entries.map(row => [`${String(row.project_id)}\0${String(row.id)}`, row]));
  return { rows, total: total[0]!.n, hasMore: total[0]!.n > rows.length, profiles: index(profiles), steps: index(latestSteps), calls: index(latestCalls) };
}
const queued = [true, false].map(all => read<[project: string | null], Row>({ name: `runs.todayQueued${all ? 'All' : 'Named'}`, sql: `SELECT r.project_id,NULLIF(r.task,'') AS task,${taskHoldSql('r.hold_reason', 'r.origin')} AS held_by,r.queued_count AS count,
  r.oldest_queued_at AS since,r.oldest_run_id AS oldest_id
  FROM task_runtime r WHERE r.queued_count>0 AND ${scopeSql({ all })}` }));
export async function todayQueued(db: RelationalStore, scope: TodayScope): Promise<Row[]> {
  const [rows] = await readSet(db, queued['projectId' in scope ? 1 : 0]!.bind('projectId' in scope ? scope.projectId : null));
  return rows;
}
