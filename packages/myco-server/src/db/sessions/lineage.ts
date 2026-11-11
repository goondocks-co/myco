import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { notTombstonedSql } from '../session-read-model.js';
import { firstPromptSql, PRESENTED_ENDED_AT, PRESENTED_STARTED_AT } from './browse.js';

/** The parent column each edge kind reads, and the index its children are read through: it holds the parent and the child's id, so it supplies the order a bounded selection stops in. */
export type LineageEdgeKind = 'launched' | 'continuation';

export interface LineageSessionRow {
  session_id: string;
  agent: string | null;
  title: string | null;
  first_prompt: string | null;
  started_at: number | null;
  ended_at: number | null;
  parent_session_id: string | null;
  parent_reason: string | null;
  launch_parent_session_id: string | null;
}

const LIVE = notTombstonedSql('s');
const named = read<[project: string, sessions: string], LineageSessionRow>({ name: 'sessionLineage.named', sql:
  `SELECT s.session_id, s.agent, s.title, ${firstPromptSql('s')} AS first_prompt, ${PRESENTED_STARTED_AT} AS started_at,
  ${PRESENTED_ENDED_AT} AS ended_at, s.parent_session_id, s.parent_reason, s.launch_parent_session_id FROM sessions s
        WHERE s.project_id = ?1 AND s.session_id IN (SELECT value FROM json_each(?2)) AND ${LIVE}` });

type Children = [project: string, parents: string, limit: number];
const childrenBy = (name: string, index: string, column: string) => read<Children, { session_id: string }>({ name, sql:
  `SELECT s.session_id FROM sessions s INDEXED BY ${index}
        WHERE s.project_id = ?1 AND s.${column} IN (SELECT value FROM json_each(?2)) AND ${LIVE}
        ORDER BY s.${column}, s.session_id LIMIT ?3` });
const launched = childrenBy('sessionLineage.launchedChildren', 'idx_sessions_launch_parent', 'launch_parent_session_id');
const continued = childrenBy('sessionLineage.continuedChildren', 'idx_sessions_parent', 'parent_session_id');

/** The live sessions of the Project among `ids`, with the facts a lineage names them by. */
export async function lineageSessionRows(db: RelationalStore, project: string, ids: readonly string[]): Promise<LineageSessionRow[]> {
  const [rows] = await readSet(db, named.bind(project, JSON.stringify(ids)));
  return rows;
}

/** The ids of at most `limit` live sessions of the Project whose `kind` parent is one of `parents`, in the index's own order (parent, then child id). */
export async function lineageChildIds(db: RelationalStore, request: { project: string; kind: LineageEdgeKind; parents: readonly string[]; limit: number }): Promise<string[]> {
  const { project, kind, parents, limit } = request;
  const [rows] = await readSet(db, (kind === 'launched' ? launched : continued).bind(project, JSON.stringify(parents), limit));
  return rows.map(row => row.session_id);
}
