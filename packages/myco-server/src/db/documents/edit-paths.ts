import { jsonPages } from '../json-pages.js';
import { write, type Bound } from '../index.js';

const record = write<[project: string, session: string, generation: number, paths: string]>({ name: 'documents.recordEditPaths', sql:
  `INSERT OR IGNORE INTO session_edit_paths(project_id,session_id,generation,path) SELECT ?1,?2,?3,value FROM json_each(?4)` });

/** Records distinct edited paths, including paths outside the visible file catalog's cap. */
export function sessionEditPaths(projectId: string, sessionId: string, generation: number, paths: readonly string[]): Bound[] {
  return jsonPages([...new Set(paths)]).map(page => record.bind(projectId, sessionId, generation, JSON.stringify(page)));
}
