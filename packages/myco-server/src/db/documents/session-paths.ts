import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { liveGenerationSql } from './live-generation.js';

export type PathKind = 'edited' | 'read' | 'all';
export interface SessionPathRow { path: string; tool_calls: number; edits: number; last_turn: string | null }

const LIVE = liveGenerationSql('?1', '?2');
const SELECT = 'SELECT path,tool_calls,edits,last_turn FROM session_paths WHERE project_id=?1 AND session_id=?2';
const firstPage = (name: string, filter: string) => read<[project: string, session: string, limit: number], SessionPathRow>({ name, sql:
  `${SELECT} AND generation=${LIVE}${filter} ORDER BY path LIMIT ?3` });
const nextPage = (name: string, filter: string) => read<[project: string, session: string, limit: number, after: string], SessionPathRow>({ name, sql:
  `${SELECT} AND generation=${LIVE} AND path>?4${filter} ORDER BY path LIMIT ?3` });
const FILTERS: Record<PathKind, string> = { all: '', edited: ' AND edits>0', read: ' AND edits=0' };
const firstPages = { all: firstPage('sessionPaths.firstAll', FILTERS.all), edited: firstPage('sessionPaths.firstEdited', FILTERS.edited), read: firstPage('sessionPaths.firstRead', FILTERS.read) };
const nextPages = { all: nextPage('sessionPaths.nextAll', FILTERS.all), edited: nextPage('sessionPaths.nextEdited', FILTERS.edited), read: nextPage('sessionPaths.nextRead', FILTERS.read) };
const capped = read<[project: string, session: string], { paths_capped: number }>({ name: 'sessionPaths.capped', sql:
  `SELECT paths_capped FROM session_documents WHERE project_id=?1 AND session_id=?2 AND state='live'` });

/** Up to `limit` paths of the session's live generation after `after`, of the named kind, and whether the path list was capped. */
export async function sessionPathPage(db: RelationalStore, request: { project: string; session: string; kind: PathKind; after: string | null; limit: number }):
  Promise<{ rows: SessionPathRow[]; capped: boolean }> {
  const { project, session, kind, after, limit } = request;
  const page = after === null ? firstPages[kind].bind(project, session, limit) : nextPages[kind].bind(project, session, limit, after);
  const [rows, state] = await readSet(db, page, capped.bind(project, session));
  return { rows, capped: state[0]?.paths_capped === 1 };
}
