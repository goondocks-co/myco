import type { RelationalStore } from '../../core/adapters.js';
import { composedStatements } from '../composed-statements.js';
import { read, rows, type BindValue } from '../index.js';
import { SUBJECT_INTERRUPTED_REPEATED, subjectCanRetry } from './interruptions.js';

/** A task's own admission of a failed run's subject, as a SQL boolean over `r.project_id`, `r.subject` and `?2` (now). */
export interface RetryTerm { task: string; sql: string }

const retryReads = composedStatements<{ projectId: string; runId: string; retrying: number }, 'read'>('runs.subjectsRetrying');

/**
 * The failed runs, of `keys`, whose subject the claim takes again by itself at `now`, as `projectId/runId`, in one read:
 * the run names a subject, did not end on repeated interruptions, its interruptions are under the claim's bound, and
 * its task's own admission (`terms`) still takes it. A task with no term is never retrying.
 */
export async function subjectsRetrying(db: RelationalStore, keys: readonly { projectId: string; runId: string }[], terms: readonly RetryTerm[], now: number): Promise<Set<string>> {
  if (keys.length === 0 || terms.length === 0) return new Set();
  const admitted = `CASE r.task ${terms.map((term) => `WHEN '${term.task}' THEN (${term.sql})`).join(' ')} ELSE 0 END`;
  const sql = `SELECT r.project_id AS projectId,r.id AS runId,
    (r.subject IS NOT NULL AND r.error_code IS NOT '${SUBJECT_INTERRUPTED_REPEATED}' AND ${subjectCanRetry('r.project_id', 'r.task', 'r.subject')} AND ${admitted}) AS retrying
    FROM json_each(?1) k JOIN agent_runs r ON r.project_id=json_extract(k.value,'$.projectId') AND r.id=json_extract(k.value,'$.runId')`;
  const statement = retryReads(sql, (name) => read<BindValue[], { projectId: string; runId: string; retrying: number }>({ name, sql }));
  return new Set((await rows(db, statement.bind(JSON.stringify(keys), now))).filter((row) => Number(row.retrying) === 1).map((row) => `${row.projectId}/${row.runId}`));
}
