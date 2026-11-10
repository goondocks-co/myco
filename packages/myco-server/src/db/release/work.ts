import type { RelationalStore } from '../../core/adapters.js';
import type { CapturePoint, Cleanliness } from '../../core/provenance.js';
import { first, read, rows } from '../index.js';

/** A session's commit to classify: the source as captured and the revision a settlement must still hold. */
export interface ReleaseWork {
  sessionId: string;
  point: CapturePoint;
  headSha: string;
  cleanliness: Cleanliness;
  sourceRevision: number;
}

const openWork = read<[project: string, generation: number, limit: number], ReleaseWork>({ name: 'releaseWork.open', sql:
  `SELECT session_id AS sessionId,point,head_sha AS headSha,cleanliness,source_revision AS sourceRevision FROM release_work_due
   WHERE project_id=?1 AND final=0 AND settled_generation<?2 ORDER BY settled_generation,captured_at DESC,session_id LIMIT ?3` });

/** The Project's open sessions not yet settled at `generation`, longest-unsettled first and newest capture first within that. */
export const openReleaseWork = (db: RelationalStore, project: string, generation: number, limit: number): Promise<ReleaseWork[]> =>
  rows(db, openWork.bind(project, generation, limit));

interface SessionPaths { state: string; toolCalls: number; files: string | null }

const pathsPage = read<[project: string, session: string, limit: number], SessionPaths>({ name: 'releaseWork.paths', sql:
  `SELECT d.state,COALESCE(d.tool_calls,0) AS toolCalls,CASE WHEN d.state='live' THEN (SELECT json_group_array(path) FROM (SELECT p.path FROM session_paths p
      WHERE p.project_id=d.project_id AND p.session_id=d.session_id AND p.generation=d.generation ORDER BY p.path LIMIT ?3)) END AS files
   FROM session_documents d WHERE d.project_id=?1 AND d.session_id=?2` });

/** The session's document row with up to `limit` of its paths, or null when it has no document. */
export const sessionPaths = (db: RelationalStore, project: string, session: string, limit: number) => first(db, pathsPage.bind(project, session, limit));
