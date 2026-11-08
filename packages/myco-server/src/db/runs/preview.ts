import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { RUN_ADMISSION_READY_SQL } from './live.js';
import { LIVE_RUN_STATUSES } from '../run-statuses.js';

/** Preview needs only enough hourly entries to decide the configured ceiling. */
export interface PreviewRunKey { projectId: string; runId: string }
interface PreviewLoadRow { liveRuns: number; liveTaskRuns: number; taskRunsLastHour: number; ready: number }
const loadSql = (task: string, floor: string, runId: string, hourlyLimit: string, projectId: string) => `SELECT ${RUN_ADMISSION_READY_SQL} AS ready,
  COALESCE((SELECT live FROM admission_contribution WHERE scope='fleet' AND scope_key=''),0)
    -EXISTS(SELECT 1 FROM run_live WHERE project_id=${projectId} AND run_id=${runId} AND ${LIVE_RUN_STATUSES}) AS liveRuns,
  COALESCE((SELECT live FROM admission_contribution WHERE scope='task' AND scope_key=${task}),0)
    -EXISTS(SELECT 1 FROM run_live WHERE project_id=${projectId} AND run_id=${runId} AND task=${task} AND ${LIVE_RUN_STATUSES}) AS liveTaskRuns,
  (SELECT COUNT(*) FROM (SELECT 1 FROM agent_runs INDEXED BY idx_agent_runs_task_started
    WHERE task=${task} AND started_at IS NOT NULL AND started_at>=${floor} AND (${runId} IS NULL OR id<>${runId} OR project_id<>${projectId}) LIMIT ${hourlyLimit})) AS taskRunsLastHour`;
const load = read<[string, number, string | null, number, string | null], PreviewLoadRow>({
  name: 'runs.previewLoad', sql: loadSql('?1','?2','?3','?4','?5'),
});
const loads = read<[string, number, number], PreviewLoadRow>({ name: 'runs.previewLoads', sql: `
  ${loadSql("json_extract(keys.value,'$.task')", '?2', "json_extract(keys.value,'$.runId')", '?3', "json_extract(keys.value,'$.projectId')")}
  FROM json_each(?1) keys ORDER BY CAST(keys.key AS INTEGER)` });
const loadCounts = ({ ready, ...counts }: PreviewLoadRow) => ready === 1 ? counts : { ...counts, ready: false };
export async function previewDispatchLoad(db: RelationalStore, task: string, now: number, hourlyLimit: number | null, exclude?: PreviewRunKey) {
  const [[row]] = await readSet(db, load.bind(task, now - 3_600_000, exclude?.runId ?? null, hourlyLimit ?? 0, exclude?.projectId ?? null));
  return loadCounts(row!);
}

/** All task heads share one statement and retain their exact Project/run exclusion. */
export async function previewDispatchLoads(db: RelationalStore, heads: readonly (PreviewRunKey & { task: string })[], now: number, hourlyLimit: number | null) {
  if (heads.length === 0) return [];
  const [rows] = await readSet(db, loads.bind(JSON.stringify(heads), now - 3_600_000, hourlyLimit ?? 0));
  return rows.map(loadCounts);
}

const owners = read<[string], { id: string; member_id: string | null; label: string | null }>({
  name: 'runs.previewOwners', sql: `SELECT c.id,c.member_id,m.label FROM json_each(?1) k
    JOIN member_credentials c ON c.id=k.value LEFT JOIN members m ON m.id=c.member_id`,
});
export async function previewOwners(db: RelationalStore, ids: readonly string[]) {
  return (await readSet(db, owners.bind(JSON.stringify(ids))))[0];
}

const liveTask = read<[string,string], { live: number; ready: number }>({
  name: 'runs.previewLiveTask', sql: `SELECT ${RUN_ADMISSION_READY_SQL} AS ready,
    (EXISTS(SELECT 1 FROM task_runtime WHERE project_id=?1 AND task=?2 AND queued_count>0)
      OR EXISTS(SELECT 1 FROM agent_runs r INDEXED BY idx_agent_runs_task_live
        JOIN run_live l ON l.project_id=r.project_id AND l.run_id=r.id
        WHERE r.task=?2 AND r.${LIVE_RUN_STATUSES} AND l.project_id=?1)) AS live`,
});
export async function previewLiveTask(db: RelationalStore, projectId: string, task: string): Promise<boolean | null> {
  const [[row]] = await readSet(db, liveTask.bind(projectId, task));
  if (row?.ready !== 1) return null;
  return row.live === 1;
}
