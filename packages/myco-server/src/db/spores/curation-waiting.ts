import type { RelationalStore } from '../../core/adapters.js';
import type { PulledWait, PulledWaitScope } from '../../core/pulled-stages.js';
import { read, readSet } from '../index.js';
import { curationAdmissionSql, curationDueWorkSql } from '../runs/pull-policy.js';

const waiting = read<[projects: string, now: number, cutoff: number], PulledWait>({
  name: 'curation.waiting',
  sql: `SELECT w.project_id AS projectId,MIN(w.due_at) AS since
    FROM json_each(?1) k CROSS JOIN spore_curation_work w INDEXED BY idx_curation_due ON w.project_id=k.value
    WHERE ${curationDueWorkSql('k.value', '?2')} AND w.due_at<=?3
      AND ${curationAdmissionSql('k.value', '?2')}
    GROUP BY w.project_id`,
});

/** Open curation work's real deadline, with the stage's present admission and daily group limit. */
export async function curationWaiting(db: RelationalStore, scope: PulledWaitScope): Promise<PulledWait[]> {
  const [rows] = await readSet(db, waiting.bind(JSON.stringify(scope.projects), scope.now, scope.cutoff));
  return rows;
}
