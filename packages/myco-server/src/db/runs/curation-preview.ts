import type { RelationalStore } from '../../core/adapters.js';
import { CURATION_TASK } from '../../core/task-catalogue.js';
import { first, read } from '../index.js';
import { SCHEDULE_ACTOR_SQL, SCHEDULE_ENTRY_SQL } from '../schedule-entry.js';

const window = read<[project: string, actor: string, since: number, limit: number], { used: number; pivot: number | null }>({
  name: 'curationPreview.window',
  sql: `SELECT COUNT(*) AS used,MIN(at) AS pivot FROM (
    SELECT COALESCE(queued_at,started_at) AS at FROM agent_runs INDEXED BY idx_agent_runs_schedule_entry
    WHERE project_id=?1 AND task='${CURATION_TASK}' AND ${SCHEDULE_ENTRY_SQL} AND ${SCHEDULE_ACTOR_SQL}=?2
      AND status<>'skipped' AND COALESCE(queued_at,started_at)>=?3
    ORDER BY COALESCE(queued_at,started_at) DESC LIMIT ?4)`,
});

/** The same per-Project preview window that queue admission counts. */
export async function curationPreviewWindow(db: RelationalStore, options: { projectId: string; actor: string; sinceMs: number; perDay: number }) {
  const row = await first(db, window.bind(options.projectId, options.actor, options.sinceMs, options.perDay));
  return { used: row!.used, pivotAt: row!.used >= options.perDay ? row!.pivot : null };
}
