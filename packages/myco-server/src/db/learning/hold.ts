import type { RelationalStore } from '../../core/adapters.js';
import { capabilityOnSql, learningEnabledSql } from '../../core/settings.js';
import { read, readSet } from '../index.js';

/** Learning retains raw source until its session has published a live document. */
export function learningHoldsSql(project: string, session: string): string {
  return `(${capabilityOnSql(project, "'vault_evolution'")}
    AND ${learningEnabledSql()}
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id = ${project} AND session_id = ${session})
    AND NOT EXISTS (SELECT 1 FROM session_documents d WHERE d.project_id = ${project}
      AND d.session_id = ${session} AND d.state = 'live' AND d.generation IS NOT NULL AND d.last_record_at IS NOT NULL))`;
}

const holds = read<[project: string, session: string], { held: number }>({ name: 'learningHold.read', sql: `SELECT ${learningHoldsSql('held.project_id', 'held.session_id')} AS held
  FROM (SELECT ?1 AS project_id, ?2 AS session_id) held` });

export async function learningHolds(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const [rows] = await readSet(db, holds.bind(projectId, sessionId));
  return rows[0]?.held === 1;
}
