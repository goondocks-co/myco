import type { PreparedStatement, RelationalStore } from '../core/adapters.js';

/** Records distinct edited paths, including paths outside the visible file catalog's cap. */
export function sessionEditStatement(db: RelationalStore, projectId: string, sessionId: string, generation: number,
  paths: readonly string[]): PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO session_edit_paths(project_id,session_id,generation,path)
    SELECT ?,?,?,value FROM json_each(?)`).bind(projectId, sessionId, generation, JSON.stringify([...new Set(paths)]));
}
