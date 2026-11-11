import type { RelationalStore } from '../../core/adapters.js';
import { retiringPlansSql } from '../plans/retirement.js';
import { read, readSet } from '../index.js';
import { firstPromptSql } from '../sessions/browse.js';
import { everyPhaseDone } from '../projections/family.js';
import { ACTIVITY_CATCHUP, ACTIVITY_PROJECTION, type ActivityKind } from './schema.js';

/** One feed row as the relation holds it. */
export interface ActivityRow { kind: ActivityKind; source_id: string; sort_at: number; preview: string | null; session_id: string | null }

/** The row a page starts after: its instant, kind and source, the order the feed index holds. */
export interface ActivityKey { sortAt: number; kind: string; sourceId: string }

/** What a session's feed line is labelled from, read with the page. */
export interface ActivitySessionLabel { session_id: string; title: string | null; first_prompt: string | null; agent: string | null }

const COLUMNS = 'kind,source_id,sort_at,preview,session_id';
const VISIBLE = `NOT ${retiringPlansSql('j.project_id=a.project_id AND j.session_id=a.session_id')}`;
const ORDER = 'ORDER BY sort_at DESC,kind DESC,source_id DESC';

const FIRST = read<[project: string, limit: number], ActivityRow>({ name: 'activityFeed.first',
  sql: `SELECT ${COLUMNS} FROM project_activity a INDEXED BY idx_project_activity_feed WHERE a.project_id=?1 AND ${VISIBLE} ${ORDER} LIMIT ?2` });
const AFTER = read<[project: string, limit: number, sortAt: number, kind: string, sourceId: string], ActivityRow>({ name: 'activityFeed.after',
  sql: `SELECT ${COLUMNS} FROM project_activity a INDEXED BY idx_project_activity_feed WHERE a.project_id=?1 AND ${VISIBLE}
    AND sort_at<=?3 AND (sort_at<?3 OR (sort_at=?3 AND (kind<?4 OR (kind=?4 AND source_id<?5)))) ${ORDER} LIMIT ?2` });
const PHASES = read<[projection: string], { phase: string; done: number }>({ name: 'activityFeed.phases',
  sql: 'SELECT phase,done FROM projection_catchup WHERE projection=?1' });
const SESSION_LABELS = read<[project: string, sessions: string], ActivitySessionLabel>({ name: 'activityFeed.sessionLabels',
  sql: `SELECT s.session_id,s.title,${firstPromptSql('s')} AS first_prompt,s.agent FROM json_each(?2) k
    CROSS JOIN sessions s ON s.project_id=?1 AND s.session_id=k.value` });

/**
 * One feed page, newest first, at most `limit` + 1 rows after `after`, the labels of the sessions on it, and whether
 * every existing source has been added yet: until then the page holds only what was added or written since.
 * Rows belonging to a session whose plans are retiring are withheld; unrelated activity remains visible.
 */
export async function readActivityPage(db: RelationalStore, request: { projectId: string; after: ActivityKey | null; limit: number }): Promise<{
  rows: ActivityRow[]; sessions: Map<string, ActivitySessionLabel>; building: boolean;
}> {
  const { projectId, after, limit } = request;
  const page = after === null ? FIRST.bind(projectId, limit + 1) : AFTER.bind(projectId, limit + 1, after.sortAt, after.kind, after.sourceId);
  const [rows, phases] = await readSet(db, page, PHASES.bind(ACTIVITY_PROJECTION));
  const sessionIds = rows.filter(row => row.kind === 'session').map(row => row.source_id);
  const [labels] = sessionIds.length === 0 ? [[]] : await readSet(db, SESSION_LABELS.bind(projectId, JSON.stringify(sessionIds)));
  return { rows, sessions: new Map(labels.map(label => [label.session_id, label])), building: !everyPhaseDone(ACTIVITY_CATCHUP, phases) };
}
