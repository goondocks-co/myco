import { REQUIRED_REPOSITORY_TASKS, type RepositoryFailure } from '@goondocks/myco-shared/repository';
import { parseRepositoryFailure, parseRunError } from '@goondocks/myco-shared/run-text';
import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { SCHEDULE_ACTOR_SQL, SCHEDULE_ENTRY_SQL } from '../schedule-entry.js';

const STREAK_LIMIT = 8;
const RETRY_BASE_MS = 6 * 60 * 60 * 1000;
const RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1000;
interface Evidence { projectId: string; attempts: string; successAt: number | null }
interface Attempt { id: string; status: string; error: string | null; context: string | null; at: number }
export interface RepositoryFailureStreak {
  projectId: string;
  runId: string;
  failure: RepositoryFailure;
  failures: number;
  retryAt: number;
}

const evidence = read<[tasks: string, projects: string | null], Evidence>({
  name: 'runs.repositoryFailureStreaks', sql: `SELECT p.project_id AS projectId,
    (SELECT json_group_array(json_object('id',id,'status',status,'error',error,'context',run_context,'at',at)) FROM (
      SELECT id,status,error,run_context,COALESCE(queued_at,started_at) AS at FROM agent_runs INDEXED BY idx_agent_runs_schedule_entry
      WHERE project_id=p.project_id AND task=t.value AND ${SCHEDULE_ENTRY_SQL} AND ${SCHEDULE_ACTOR_SQL}='clock'
      ORDER BY COALESCE(queued_at,started_at) DESC LIMIT ${STREAK_LIMIT}
    )) AS attempts,
    (SELECT started_at FROM agent_runs INDEXED BY idx_agent_runs_task WHERE project_id=p.project_id AND task=t.value
      AND status='completed' AND dry_run=0 ORDER BY started_at DESC LIMIT 1) AS successAt
    FROM projects p CROSS JOIN json_each(?1) t WHERE p.archived_at IS NULL AND (?2 IS NULL OR p.project_id IN (SELECT value FROM json_each(?2)))`,
});

/** Bounded scheduled evidence yields one Project hold; any later successful source run clears it. */
export async function repositoryFailureStreaks(db: RelationalStore, projectId?: string): Promise<RepositoryFailureStreak[]> {
  const request = repositoryFailureRead(projectId);
  const [rows] = await readSet(db, request.statement);
  return request.read(rows);
}

/** The scheduler reads repository evidence in its shared snapshot. */
export function repositoryFailureRead(projectId?: string | readonly string[]) {
  return { statement: evidence.bind(JSON.stringify(REQUIRED_REPOSITORY_TASKS), projectId === undefined ? null : JSON.stringify(typeof projectId === 'string' ? [projectId] : projectId)), read: streaks };
}

function streaks(rows: readonly Evidence[]): RepositoryFailureStreak[] {
  const projects = new Map<string, { attempts: Attempt[]; successAt: number }>();
  for (const row of rows) {
    const held = projects.get(row.projectId) ?? { attempts: [], successAt: -1 };
    held.attempts.push(...JSON.parse(row.attempts) as Attempt[]);
    held.successAt = Math.max(held.successAt, row.successAt ?? -1);
    projects.set(row.projectId, held);
  }
  return [...projects].flatMap(([projectId, { attempts, successAt }]) => {
    const settled = attempts.filter(row => row.status === 'completed' || row.status === 'failed' || row.status === 'skipped').sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    let failure: RepositoryFailure | null = null;
    let failures = 0;
    const latest = settled[0];
    for (const row of settled.slice(0, STREAK_LIMIT)) {
      if (row.at <= successAt || row.status !== 'failed' || parseRunError(row.error ?? '')?.code !== 'repository_unprepared') break;
      const context = JSON.parse(row.context ?? '{}');
      const reason = parseRepositoryFailure({ code: context.repositoryFailureCode, summary: context.repositoryFailureSummary }) ?? { code: 'checkout_failed' as const };
      if (failure !== null && reason.code !== failure.code) break;
      failure ??= reason;
      failures++;
    }
    return latest === undefined || failure === null || failures < 2 ? [] : [{ projectId, runId: latest.id, failure, failures,
      retryAt: latest.at + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1)) }];
  });
}
