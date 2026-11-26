import type { RelationalStore } from '../../core/adapters.js';
import type { CapturePoint, Cleanliness } from '../../core/provenance.js';
import type { ReleaseGenerations } from './due.js';
import { RELEASE_WORK_OPEN } from './schema.js';
import { first, read, rows } from '../index.js';

/** A session's commit to classify: the source as captured and the revision a settlement must still hold. */
export interface ReleaseWork {
  sessionId: string;
  point: CapturePoint;
  headSha: string;
  cleanliness: Cleanliness;
  sourceRevision: number;
  ownTagsChecked: 0 | 1;
}

const openClass = (productionOnly: 0 | 1, generation: '?2' | '?3') => `
  SELECT session_id AS sessionId,point,head_sha AS headSha,cleanliness,source_revision AS sourceRevision,settled_generation,captured_at,
    settled_generation>0 AND own_tags_generation>=?3 AS ownTagsChecked
  FROM release_work_due WHERE project_id=?1 AND ${RELEASE_WORK_OPEN} AND production_only=${productionOnly} AND settled_generation<${generation}
  ORDER BY settled_generation,captured_at,session_id LIMIT ?4`;

const openWork = read<[project: string, current: number, production: number, limit: number], ReleaseWork>({ name: 'releaseWork.open', sql:
  `SELECT sessionId,point,headSha,cleanliness,sourceRevision,ownTagsChecked FROM (
     SELECT * FROM (${openClass(0, '?2')}) UNION ALL SELECT * FROM (${openClass(1, '?3')})
   ) ORDER BY settled_generation,captured_at,sessionId LIMIT ?4` });

/** Open sessions, longest-unsettled first and oldest capture first within that. */
export const openReleaseWork = (db: RelationalStore, project: string, generation: ReleaseGenerations, limit: number): Promise<ReleaseWork[]> =>
  rows(db, openWork.bind(project, generation.current, generation.production, limit));

interface SessionPaths { state: string; toolCalls: number; files: string | null }

const pathsPage = read<[project: string, session: string, limit: number], SessionPaths>({ name: 'releaseWork.paths', sql:
  `SELECT d.state,COALESCE(d.tool_calls,0) AS toolCalls,CASE WHEN d.state='live' THEN (SELECT json_group_array(path) FROM (SELECT p.path FROM session_paths p
      WHERE p.project_id=d.project_id AND p.session_id=d.session_id AND p.generation=d.generation ORDER BY p.path LIMIT ?3)) END AS files
   FROM session_documents d WHERE d.project_id=?1 AND d.session_id=?2` });

/** The session's document row with up to `limit` of its paths, or null when it has no document. */
export const sessionPaths = (db: RelationalStore, project: string, session: string, limit: number) => first(db, pathsPage.bind(project, session, limit));
