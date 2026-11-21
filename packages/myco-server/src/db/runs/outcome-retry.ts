import type { RelationalStore } from '../../core/adapters.js';
import { read, rows } from '../index.js';
import { SUBJECT_INTERRUPTED_REPEATED, subjectCanRetry } from './interruptions.js';

/**
 * Whether a pulled stage takes each failed run's subject again by itself: the run names a subject, it did not end
 * on repeated interruptions, and that subject's consecutive interruptions are still under the bound its claim admits.
 */
const retryable = read<[keys: string], { projectId: string; runId: string; retrying: number }>({
  name: 'runs.subjectsRetrying', sql: `SELECT r.project_id AS projectId,r.id AS runId,
    (r.subject IS NOT NULL AND r.error_code IS NOT '${SUBJECT_INTERRUPTED_REPEATED}' AND ${subjectCanRetry('r.project_id', 'r.task', 'r.subject')}) AS retrying
    FROM json_each(?1) k JOIN agent_runs r ON r.project_id=json_extract(k.value,'$.projectId') AND r.id=json_extract(k.value,'$.runId')`,
});

/** The failed runs, of `keys`, whose subject its stage will take again by itself, as `projectId/runId`. */
export async function subjectsRetrying(db: RelationalStore, keys: readonly { projectId: string; runId: string }[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  return new Set((await rows(db, retryable.bind(JSON.stringify(keys)))).filter(row => Number(row.retrying) === 1).map(row => `${row.projectId}/${row.runId}`));
}
