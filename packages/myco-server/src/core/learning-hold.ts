import type { RelationalStore } from './adapters.js';
import { capabilityOnSql, learningEnabledSql } from './settings.js';

/** Learning retains unread facts and transcript sessions awaiting their first publication. */
export function learningHoldsSql(project: string, session: string): string {
  return `(${capabilityOnSql(project, "'vault_evolution'")}
    AND ${learningEnabledSql()}
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id = ${project} AND session_id = ${session})
    AND (EXISTS (SELECT 1 FROM session_read_facts WHERE project_id = ${project} AND session_id = ${session}
      AND eligible_prompts > 0)
      OR (EXISTS (SELECT 1 FROM transcripts WHERE project_id = ${project} AND session_id = ${session})
        AND NOT EXISTS (SELECT 1 FROM session_views WHERE project_id = ${project} AND session_id = ${session}
          AND live_instance IS NOT NULL))))`;
}

export async function learningHolds(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT ${learningHoldsSql('held.project_id', 'held.session_id')} AS held
    FROM (SELECT ? AS project_id, ? AS session_id) held`).bind(projectId, sessionId).first<{ held: number }>();
  return row!.held === 1;
}
