import type { RelationalStore } from '../../core/adapters.js';
import type { PulledWait, PulledWaitScope } from '../../core/pulled-stages.js';
import { read, readSet } from '../index.js';
import { curationAdmissionSql, curationDueWorkSql, curationReadySql } from '../runs/pull-policy.js';

const waiting = read<[projects: string, now: number, cutoff: number, estimateKey: string | null], PulledWait>({
  name: 'curation.waiting',
  sql: `WITH candidates AS MATERIALIZED (SELECT k.value AS projectId,(SELECT w.due_at
    FROM spore_curation_work w INDEXED BY idx_curation_due
    WHERE ${curationDueWorkSql('k.value', '?2')} AND w.due_at<=?3
      AND CASE WHEN ?4 IS NULL THEN ${curationReadySql('k.value', '?2')} ELSE ${curationAdmissionSql('k.value', '?2', undefined, '?4')} END
    ORDER BY w.due_at,w.cluster_key LIMIT 1) AS since FROM json_each(?1) k) SELECT * FROM candidates WHERE since IS NOT NULL`,
});

/** Open curation work's real deadline, with the stage's present admission and daily group limit. */
export async function curationWaiting(db: RelationalStore, scope: PulledWaitScope, estimateKey?: string): Promise<PulledWait[]> {
  const [rows] = await readSet(db, waiting.bind(JSON.stringify(scope.projects), scope.now, scope.cutoff, estimateKey ?? null));
  return rows;
}
