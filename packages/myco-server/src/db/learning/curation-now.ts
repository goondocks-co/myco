import type { RelationalStore } from '../../core/adapters.js';
import { CURATION_DAILY_LIMIT_MAX, curationDailyLimitSql } from '../../core/settings.js';
import { CURATION_MAX_FAILURES } from '../runs/pull-policy.js';
import { BUDGET_WINDOW_MS } from '../../core/budget-policy.js';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { read, readSet } from '../index.js';

const NOW_FAILING_GROUPS = 3;
type Row = Record<string, unknown>;
const due = read<[string], Row>({ name: 'curation.todayDue', sql: `SELECT cluster_key,due_at FROM spore_curation_work INDEXED BY idx_curation_due
  WHERE project_id=? AND due_at IS NOT NULL AND failures=0 ORDER BY due_at LIMIT 1` });
const failed = read<[string], Row>({ name: 'curation.todayFailed', sql: `SELECT cluster_key,due_at,failures,run_id,write_refusal FROM spore_curation_work INDEXED BY idx_curation_failed
  WHERE project_id=? AND failures>0 AND failures<${CURATION_MAX_FAILURES} AND due_at IS NOT NULL ORDER BY due_at LIMIT ${NOW_FAILING_GROUPS}` });
const daily = read<[string, string, number], Row>({ name: 'curation.todayDaily', sql: `SELECT COUNT(*) AS started,MIN(first_started_at) AS oldest,${curationDailyLimitSql('?')} AS limit_value FROM
  (SELECT first_started_at FROM spore_curation_work INDEXED BY idx_curation_first_started WHERE project_id=? AND first_started_at IS NOT NULL AND first_started_at>?
    LIMIT ${CURATION_DAILY_LIMIT_MAX})` });
const map = read<[string], Row>({ name: 'curation.todayMap', sql: `SELECT COALESCE(queued_at,started_at) AS at FROM agent_runs INDEXED BY idx_agent_runs_entry
  WHERE project_id=? AND task='${MAP_TASK}' AND status!='skipped' ORDER BY COALESCE(queued_at,started_at) DESC LIMIT 1` });
const disposition = read<[string, string], Row>({ name: 'curation.todayDisposition', sql: 'SELECT decision,reason FROM spore_curation_work INDEXED BY idx_curation_evidence WHERE project_id=? AND run_id=? LIMIT 1' });
export async function todaySchedules(db: RelationalStore, curating: readonly string[], mapping: readonly string[], now: number) {
  return readSet(db, ...curating.flatMap(id => [due.bind(id), failed.bind(id), daily.bind(id, id, now - BUDGET_WINDOW_MS)]), ...mapping.map(id => map.bind(id)));
}
export async function curationDispositions(db: RelationalStore, runs: readonly { projectId: string; runId: string }[]) {
  return readSet(db, ...runs.map(run => disposition.bind(run.projectId, run.runId)));
}
