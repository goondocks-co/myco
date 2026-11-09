/**
 * Per-body move failures: why a body has not moved, and when it is tried again.
 *
 * A body that cannot move is marked and skipped until its backoff passes, so it never holds the queue behind it. The
 * mark stays until the body moves or its run retires, which is how a body that can never move stays in front of an
 * administrator.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, write, commit } from '../index.js';

export type RunBodyKind = 'instruction' | 'report_details' | 'report_audit';

export const RUN_BODY_RETRY_MS = 60 * 60 * 1000;
const RUN_BODY_RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a body keeps failing before an administrator is told. */
export const RUN_BODY_STUCK_MS = 24 * 60 * 60 * 1000;

/** The mark that holds a body back while its backoff runs, for a body identified by `run` and `item` in the enclosing query. */
export const bodyFailureHeld = (kind: RunBodyKind, project: string, run: string, item: string, now: string): string =>
  `EXISTS (SELECT 1 FROM run_body_failures f WHERE f.project_id = ${project} AND f.run_id = ${run} AND f.body_kind = '${kind}' AND f.item_id = ${item} AND f.retry_at > ${now})`;

type FailureParams = [project: string, run: string, item: number, error: string, now: number, retryMs: number, retryMaxMs: number];
const failureInsert = (kind: RunBodyKind, source: string) => `INSERT INTO run_body_failures (project_id, run_id, body_kind, item_id, failures, error, first_failed_at, retry_at)
  SELECT ?1, ?2, '${kind}', ?3, 1, ?4, ?5, ?5 + ?6 WHERE EXISTS (${source})
  ON CONFLICT (project_id, run_id, body_kind, item_id) DO UPDATE SET
    failures = run_body_failures.failures + 1, error = excluded.error,
    retry_at = ?5 + MIN(?7, ?6 << MIN(run_body_failures.failures, 16))
  RETURNING failures`;
const reportHolds = (column: string) => `SELECT 1 FROM agent_reports WHERE project_id = ?1 AND run_id = ?2 AND id = ?3 AND ${column} IS NOT NULL`;
const marks = {
  instruction: write<FailureParams, { failures: number }>({ name: 'runs.bodyFailInstruction', sql: failureInsert('instruction', `SELECT 1 FROM agent_runs WHERE project_id = ?1 AND id = ?2 AND ?3 = 0 AND instruction IS NOT NULL`) }),
  report_details: write<FailureParams, { failures: number }>({ name: 'runs.bodyFailDetails', sql: failureInsert('report_details', reportHolds('details')) }),
  report_audit: write<FailureParams, { failures: number }>({ name: 'runs.bodyFailAudit', sql: failureInsert('report_audit', reportHolds('audit')) }),
};

export const clearBodyFailure = write<[project: string, run: string, kind: string, item: number]>({ name: 'runs.bodyFailureClear', sql:
  `DELETE FROM run_body_failures WHERE project_id = ?1 AND run_id = ?2 AND body_kind = ?3 AND item_id = ?4` });

export interface BodyIdentity { kind: RunBodyKind; projectId: string; runId: string; item: number }

/** Record a failed move while the body is still on its row; answers how many times it has failed, or null when the body has left its row. */
export async function recordBodyFailure(db: RelationalStore, body: BodyIdentity, error: string, now: number): Promise<number | null> {
  const [marked] = await commit(db, marks[body.kind].bind(body.projectId, body.runId, body.item, error, now, RUN_BODY_RETRY_MS, RUN_BODY_RETRY_MAX_MS));
  return marked.results[0]?.failures ?? null;
}

export interface StuckRunBody { projectId: string; runId: string; kind: string; item: number; failures: number; error: string; since: number }
const stuck = read<[before: number, limit: number], StuckRunBody>({ name: 'runs.bodiesStuck', sql:
  `SELECT project_id AS projectId, run_id AS runId, body_kind AS kind, item_id AS item, failures, error, first_failed_at AS since
   FROM run_body_failures WHERE first_failed_at < ?1
   ORDER BY first_failed_at, project_id, run_id, body_kind, item_id LIMIT ?2` });
const STUCK_LISTED = 5;

/** The bodies longest stuck, naming each, and whether more are stuck than are listed. */
export async function stuckRunBodies(db: RelationalStore, now: number): Promise<{ bodies: StuckRunBody[]; hasMore: boolean }> {
  const [rows] = await readSet(db, stuck.bind(now - RUN_BODY_STUCK_MS, STUCK_LISTED + 1));
  return { bodies: rows.slice(0, STUCK_LISTED), hasMore: rows.length > STUCK_LISTED };
}
