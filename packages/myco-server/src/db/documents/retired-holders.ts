import type { RelationalStore } from '../../core/adapters.js';
import type { ContentPublicationGuard } from '../../core/registered-content.js';
import { read, rows } from '../index.js';

/** A row of `retired_objects`: a chunk version's holder until a live directory row adopts it. */
export interface Holder { p: string; s: string; k: string; i: string }

const due = read<[before: number, limit: number], Holder>({ name: 'documents.retiredHoldersDue', sql:
  `SELECT project_id p,session_id s,blob_key k,source_id i FROM retired_objects WHERE retired_at<=?1 ORDER BY retired_at LIMIT ?2` });

/** The oldest `limit` holders retired at or before `before`. */
export async function retiredHoldersDue(db: RelationalStore, before: number, limit: number): Promise<Holder[]> {
  return rows(db, due.bind(before, limit));
}

/** A live publication registers a chunk version only while its generation is still live and the version's holder still stands. */
export function liveGenerationHolderGuard(project: string, session: string, generation: number, key: string, sourceId: string): ContentPublicationGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND state='live' AND generation=?)
        AND EXISTS (SELECT 1 FROM retired_objects WHERE project_id=? AND session_id=? AND blob_key=? AND source_id=?)`,
    params: [project, session, generation, project, session, key, sourceId],
  };
}
