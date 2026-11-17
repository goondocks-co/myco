import type { RelationalStore } from '../../core/adapters.js';
import { curationDueWorkSql } from '../runs/pull-policy.js';
import { first, read, rows } from '../index.js';
import type { CurationWork } from './curation-work.js';

const outcomeCounts = read<[project: string, run: string], { action: string; n: number }>({
  name: 'curationRun.outcomeCounts',
  sql: 'SELECT action,COUNT(DISTINCT spore_id) AS n FROM resolution_events INDEXED BY idx_curation_resolution_author WHERE project_id=?1 AND author=?2 GROUP BY action',
});
/** Source transition counts from this run's persisted lifecycle evidence. A run holds at most one cluster, so this read costs at most the cluster cap. */
export async function curationOutcomeCounts(db: RelationalStore, project: string, run: string): Promise<{ obsoleted: number; superseded: number; consolidated: number }> {
  const counted = await rows(db, outcomeCounts.bind(project, run));
  const count = (action: string) => counted.find(row => row.action === action)?.n ?? 0;
  return { obsoleted: count('obsolete'), superseded: count('supersede'), consolidated: count('consolidate') };
}

const dueHead = read<[project: string, now: number], Pick<CurationWork, 'cluster_key' | 'due_at'>>({
  name: 'curationRun.dueHead',
  sql: `SELECT cluster_key,due_at FROM spore_curation_work w INDEXED BY idx_curation_due WHERE ${curationDueWorkSql('?1', '?2')} ORDER BY due_at,cluster_key LIMIT 1`,
});
export const readCurationDueHead = (db: RelationalStore, project: string, now: number) => first(db, dueHead.bind(project, now));
