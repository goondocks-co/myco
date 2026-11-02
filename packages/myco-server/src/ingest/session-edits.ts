import { jsonPages } from '../db/json-pages.js';
import type { PreparedStatement, RelationalStore } from '../core/adapters.js';

/** Records distinct edited paths, including paths outside the visible file catalog's cap. */
export function sessionEditStatements(db: RelationalStore, projectId: string, sessionId: string, generation: number,
  paths: readonly string[]): PreparedStatement[] {
  return jsonPages([...new Set(paths)]).map(page => db.prepare(`INSERT OR IGNORE INTO session_edit_paths(project_id,session_id,generation,path)
    SELECT ?,?,?,value FROM json_each(?)`).bind(projectId, sessionId, generation, JSON.stringify(page)));
}
