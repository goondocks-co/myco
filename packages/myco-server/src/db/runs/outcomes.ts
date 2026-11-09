import type { RelationalStore } from '../../core/adapters.js';
import { RUN_FAILURE_WORDS } from '@goondocks/myco-shared/run-control';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { EXTRACTION_TASK, CURATION_TASK, SEEDING_TASK } from '../../core/task-catalogue.js';
import { producedSql } from '../../read/run-outcome.js';
import { contextValue, FAILURE_REASON_KEY } from '../run-context.js';
import { FAILED_CALL_INDEX, FAILED_CALL_SQL } from '../schema-v701.js';
import { read, readSet } from '../index.js';

const FAILURE_STREAK_SHOWN = 5;
export const NOW_WATCHED_TASKS: readonly string[] = [EXTRACTION_TASK, MAP_TASK, CURATION_TASK, SEEDING_TASK];
interface OutcomePair { projectId: string; task: string }

/** When the task's latest completed run started; a failure before it is recovered. */
export const failureThreshold = (projectId: string, task: string) => `COALESCE((SELECT s.started_at FROM agent_runs s INDEXED BY idx_agent_runs_task
    WHERE s.project_id=${projectId} AND s.task=${task} AND s.status='completed' ORDER BY s.started_at DESC LIMIT 1),-1)`;
const startedAfter = (run: string, threshold: string) => `${run}.started_at>${threshold}`;
const admissionAfter = (run: string, threshold: string) => `${run}.started_at IS NULL AND ${run}.completed_at>${threshold}`;
/** Failed starts and failed queued admissions both remain unresolved until a later run starts and completes. */
export const unresolvedFailure = (run: string, threshold: string) => `(${startedAfter(run, threshold)} OR (${admissionAfter(run, threshold)}))`;
export function unresolvedFailureRows(projectId: string, task: string): string {
  const threshold = failureThreshold(projectId, task);
  const branch = (range: string, order: string) => `SELECT r.id,COALESCE(r.completed_at,r.started_at) AS at,
    COALESCE(r.started_at,r.completed_at) AS failed_at FROM agent_runs r INDEXED BY idx_agent_runs_task
    WHERE r.project_id=${projectId} AND r.task=${task} AND r.status='failed' AND ${range}
    AND NOT ${producedSql('r')} ORDER BY ${order} DESC LIMIT ${FAILURE_STREAK_SHOWN + 1}`;
  return `SELECT * FROM (${branch(startedAfter('r', threshold), 'r.started_at')})
    UNION ALL SELECT * FROM (${branch(admissionAfter('r', threshold), 'r.completed_at')})`;
}
const unresolved = read<[string, string], { id: string; at: number }>({
  name: 'runs.unresolvedFailures', sql: `SELECT id,at FROM (${unresolvedFailureRows('?1', '?2')})
    ORDER BY failed_at DESC,id LIMIT ${FAILURE_STREAK_SHOWN + 1}`,
});
export async function unresolvedFailures(db: RelationalStore, pairs: readonly OutcomePair[]) {
  const answers = await readSet(db, ...pairs.map(pair => unresolved.bind(pair.projectId, pair.task)));
  return pairs.flatMap((pair, i) => {
    const rows = answers[i]!;
    const latest = rows[0];
    return latest ? [{ ...pair, runId: latest.id, at: latest.at, failures: Math.min(rows.length, FAILURE_STREAK_SHOWN), hasMore: rows.length > FAILURE_STREAK_SHOWN }] : [];
  });
}
const reasons = read<[string], { projectId: string; runId: string; error_code: string | null; error: string | null; reason: string | null; refusal: string | null }>({
  name: 'runs.failureReasons', sql: `SELECT r.project_id AS projectId,r.id AS runId,r.error_code,r.error,${contextValue(FAILURE_REASON_KEY)} AS reason,
    (SELECT CASE WHEN json_valid(e.payload) THEN CASE WHEN json_type(e.payload,'$.failure.message')='text'
      THEN json_extract(e.payload,'$.failure.message') END END FROM agent_run_events e INDEXED BY ${FAILED_CALL_INDEX}
      WHERE e.project_id=r.project_id AND e.run_id=r.id AND ${FAILED_CALL_SQL} ORDER BY e.recorded_at DESC LIMIT 1) AS refusal
    FROM json_each(?) k JOIN agent_runs r ON r.project_id=json_extract(k.value,'$.projectId') AND r.id=json_extract(k.value,'$.runId')`,
});
export async function failureReasons(db: RelationalStore, runs: ReadonlyArray<{ projectId: string; runId: string }>): Promise<Map<string, string>> {
  const [rows] = await readSet(db, reasons.bind(JSON.stringify(runs)));
  return new Map(rows.map(row => [`${row.projectId}\0${row.runId}`, [row.refusal, row.reason, row.error].find(value => value?.trim())
    ?? (row.error_code === null ? 'Myco didn’t record why.' : RUN_FAILURE_WORDS[row.error_code] ?? RUN_FAILURE_WORDS.run_failed!)]));
}
