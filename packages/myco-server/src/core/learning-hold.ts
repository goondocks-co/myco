import type { RelationalStore } from './adapters.js';
import { capabilityOnSql, learningEnabledSql } from './settings.js';

/** Learning retains raw source until its session has published a live document. */
export function learningHoldsSql(project: string, session: string): string {
  return `(${capabilityOnSql(project, "'vault_evolution'")}
    AND ${learningEnabledSql()}
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id = ${project} AND session_id = ${session})
    AND NOT EXISTS (SELECT 1 FROM session_documents d WHERE d.project_id = ${project}
      AND d.session_id = ${session} AND d.state = 'live' AND d.generation IS NOT NULL AND d.last_record_at IS NOT NULL))`;
}

export async function learningHolds(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT ${learningHoldsSql('held.project_id', 'held.session_id')} AS held
    FROM (SELECT ? AS project_id, ? AS session_id) held`).bind(projectId, sessionId).first<{ held: number }>();
  return row!.held === 1;
}
