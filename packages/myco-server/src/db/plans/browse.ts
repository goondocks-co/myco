import { supersededColumnsSql } from './resolution.js';
import type { RelationalStore } from '../../core/adapters.js';
import { notTombstonedSql } from '../session-read-model.js';
import { binaryOrder, type ProjectSet } from '../../read/scope.js';
import { read, readSet, type Bound } from '../index.js';

/**
 * Plan lists: a plan's metadata, its stored preview and progress, and never its body, which only the plan's own read
 * answers. Each contribution walks an index in its own order and starts a later page after the last row's key:
 * - one Project, newest edit first, by `(updated_at, plan_key)`; with a status, on that status's index;
 * - one session, newest or oldest edit first, by `(updated_at, plan_key)` on the session index;
 * - across Projects, newest edit first, by `(updated_at, project_id, plan_key)`; named Projects merge bounded
 *   Project-led contributions, and the all-Project list uses the timestamp-led index, optionally under one status.
 */

/** A listed plan as stored: metadata, with progress null until the plan's metadata has been derived. */
export interface PlanListRow {
  project_id: string;
  plan_key: string;
  session_id: string;
  prompt_id: string | null;
  title: string | null;
  status: string;
  origin_path: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
  preview: string | null;
  progress_done: number | null;
  progress_total: number | null;
  /** The later plan an abandoned plan was superseded by, and its title; null for every other plan. */
  superseded_by: string | null;
  superseded_by_title: string | null;
}

/** The key a page starts after: the edit instant and the plan, and across Projects the Project between them. */
export interface PlanPageKey { updatedAt: number; projectId?: string; planKey: string }

const PLAN_LIST_COLUMNS = `p.project_id,p.plan_key,p.session_id,p.prompt_id,p.title,p.status,p.origin_path,p.updated_by,p.created_at,p.updated_at,
  m.preview,m.progress_done,m.progress_total,${supersededColumnsSql('p')}`;
const FROM = (index: string) => `FROM plans p INDEXED BY ${index} LEFT JOIN plan_metadata m ON m.project_id=p.project_id AND m.plan_key=p.plan_key`;
const SHOWN = notTombstonedSql('p');
/** After `(updated_at, plan_key)` at slots `at` and `key`. */
const afterInProject = (at: string, key: string) => `AND (p.updated_at,p.plan_key)<(${at},${key})`;
/** After `(updated_at, project_id, plan_key)` at slots `at`, `project` and `key`. */
const afterAcross = (at: string, project: string, key: string) => `AND (p.updated_at,p.project_id,p.plan_key)<(${at},${project},${key})`;
const IN_PROJECT_ORDER = 'ORDER BY p.updated_at DESC,p.plan_key DESC';
const ACROSS_ORDER = 'ORDER BY p.updated_at DESC,p.project_id DESC,p.plan_key DESC';
const LIVE_PROJECT = 'EXISTS (SELECT 1 FROM projects x WHERE x.project_id=p.project_id AND x.archived_at IS NULL)';
/** The earliest edit instant bounds the walk; none starts from the earliest. */
const since = (slot: string) => `p.updated_at>=COALESCE(${slot},${Number.MIN_SAFE_INTEGER})`;

type ProjectPage = [project: string, limit: number, since: number | null];
type ProjectAfter = [...ProjectPage, at: number, key: string];
type ProjectRead = { projectId: string; limit: number; since: number | null; status: string | null; after: PlanPageKey | null };
const projectPages = (position: 'first' | 'after' | 'earlier' | 'through') => {
  const boundary = position === 'first' ? '' : position === 'after' ? afterInProject('?4', '?5')
    : `AND p.updated_at${position === 'earlier' ? '<' : '<='}?4`;
  const sql = (index: string, filter: string) => `SELECT ${PLAN_LIST_COLUMNS} ${FROM(index)} WHERE p.project_id=?1 AND ${since('?3')}
    ${boundary} ${filter} AND ${SHOWN} ${IN_PROJECT_ORDER} LIMIT ?2`;
  type Keys = ProjectPage | ProjectAfter | [...ProjectPage, at: number];
  const any = read<Keys, PlanListRow>({ name: `planPages.project${position}`, sql: sql('idx_plans_project_updated', '') });
  const filtered = read<[...Keys, status: string], PlanListRow>({ name: `planPages.projectStatus${position}`,
    sql: sql('idx_plans_project_status_updated', `AND p.status=?${position === 'first' ? 4 : position === 'after' ? 6 : 5}`) });
  return (request: ProjectRead): Bound<PlanListRow, 'read'> => {
    const { projectId, limit, since, status, after } = request;
    const base: ProjectPage = [projectId, limit, since];
    const keys: Keys = position === 'first' ? base : position === 'after' ? [...base, after!.updatedAt, after!.planKey] : [...base, after!.updatedAt];
    return status === null ? any.bind(...keys) : filtered.bind(...keys, status);
  };
};
const PROJECT = { first: projectPages('first'), after: projectPages('after'), earlier: projectPages('earlier'), through: projectPages('through') };
/** One Project's bounded contribution to a merged page; the cross-Project cursor orders Project before plan. */
function projectPage(request: ProjectRead): Bound<PlanListRow, 'read'> {
  const { projectId, after } = request;
  const page = after === null ? PROJECT.first : after.projectId === undefined || after.projectId === projectId ? PROJECT.after
    : binaryOrder(projectId, after.projectId) < 0 ? PROJECT.through : PROJECT.earlier;
  return page(request);
}

/** A session's tab reads oldest first; its filtered lists read through the same complete key under one status. */
const sessionPages = (order: 'newest' | 'oldest', position: 'first' | 'after') => {
  const sort = order === 'newest' ? IN_PROJECT_ORDER : 'ORDER BY p.updated_at,p.plan_key';
  const boundary = position === 'first' ? '' : `AND (p.updated_at,p.plan_key)${order === 'newest' ? '<' : '>'}(?4,?5)`;
  const sql = (index: string, filter: string) => `SELECT ${PLAN_LIST_COLUMNS} ${FROM(index)} WHERE p.project_id=?1 AND p.session_id=?3
    ${filter} ${boundary} AND ${SHOWN} ${sort} LIMIT ?2`;
  type Keys = [project: string, limit: number, session: string] | [project: string, limit: number, session: string, at: number, key: string];
  const any = read<Keys, PlanListRow>({ name: `planPages.session${order}${position}`, sql: sql('idx_plans_session_updated', '') });
  const filtered = read<[...Keys, status: string], PlanListRow>({ name: `planPages.sessionStatus${order}${position}`,
    sql: sql('idx_plans_session_status_updated', `AND p.status=?${position === 'first' ? 4 : 6}`) });
  return (request: { projectId: string; sessionId: string; limit: number; status: string | null; after: PlanPageKey | null }): Bound<PlanListRow, 'read'> => {
    const { projectId, sessionId, limit, status, after } = request;
    const keys: Keys = position === 'first' ? [projectId, limit, sessionId] : [projectId, limit, sessionId, after!.updatedAt, after!.planKey];
    return status === null ? any.bind(...keys) : filtered.bind(...keys, status);
  };
};
const SESSION = {
  newest: { first: sessionPages('newest', 'first'), after: sessionPages('newest', 'after') },
  oldest: { first: sessionPages('oldest', 'first'), after: sessionPages('oldest', 'after') },
};
type AcrossPage = [limit: number, since: number | null];
type AcrossAfter = [...AcrossPage, at: number, project: string, key: string];
const ACROSS = {
  first: read<AcrossPage, PlanListRow>({ name: 'planPages.acrossFirst',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_across')} WHERE ${since('?2')} AND ${LIVE_PROJECT} AND ${SHOWN} ${ACROSS_ORDER} LIMIT ?1` }),
  after: read<AcrossAfter, PlanListRow>({ name: 'planPages.acrossAfter',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_across')} WHERE ${since('?2')} ${afterAcross('?3', '?4', '?5')} AND ${LIVE_PROJECT} AND ${SHOWN}
      ${ACROSS_ORDER} LIMIT ?1` }),
};
const ACROSS_STATUS = {
  first: read<[...AcrossPage, status: string], PlanListRow>({ name: 'planPages.acrossStatusFirst',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_across_status')} WHERE p.status=?3 AND ${since('?2')} AND ${LIVE_PROJECT} AND ${SHOWN} ${ACROSS_ORDER} LIMIT ?1` }),
  after: read<[...AcrossAfter, status: string], PlanListRow>({ name: 'planPages.acrossStatusAfter',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_across_status')} WHERE p.status=?6 AND ${since('?2')} ${afterAcross('?3', '?4', '?5')} AND ${LIVE_PROJECT}
      AND ${SHOWN} ${ACROSS_ORDER} LIMIT ?1` }),
};

/** The tags of named plans, by Project and plan, in one statement over `[[projectId, planKey], …]`. */
const TAGS = read<[keys: string], { project_id: string; plan_key: string; tag: string }>({ name: 'planPages.tags',
  sql: `SELECT t.project_id,t.entity_id AS plan_key,t.tag FROM json_each(?1) k CROSS JOIN tags t
    ON t.project_id=json_extract(k.value,'$[0]') AND t.entity_kind='plan' AND t.entity_id=json_extract(k.value,'$[1]') ORDER BY t.project_id,t.entity_id,t.tag` });

/** A plan list's request: where it reads, its structured filters, the key it starts after, and at most how many rows. */
export type PlanPageRequest =
  | { scope: { projectId: string }; status?: string; after: PlanPageKey | null; limit: number }
  | { scope: { projectId: string; sessionId: string }; order: 'newest' | 'oldest'; status?: string; after: PlanPageKey | null; limit: number }
  | { scope: ProjectSet; status?: string; since?: number; after: PlanPageKey | null; limit: number };

/** One plan page of at most `limit` + 1 rows, most recently edited first. A set naming one Project reads as that Project. */
export async function readPlanPage(db: RelationalStore, request: PlanPageRequest): Promise<PlanListRow[]> {
  const { after, limit } = request;
  const status = request.status ?? null;
  if ('order' in request) {
    const { projectId, sessionId } = request.scope;
    const pages = SESSION[request.order];
    const page = after === null ? pages.first : pages.after;
    const [rows] = await readSet(db, page({ projectId, sessionId, limit: limit + 1, status, after }));
    return rows;
  }
  const since = 'since' in request ? request.since ?? null : null;
  const scope = request.scope;
  if ('projectId' in scope) {
    const [rows] = await readSet(db, projectPage({ projectId: scope.projectId, limit: limit + 1, since, status, after }));
    return rows;
  }
  if (!scope.all) {
    const pages = await readSet(db, ...[...new Set(scope.projectIds)].map(projectId => projectPage({ projectId, limit: limit + 1, since, status, after })));
    return pages.flat().sort((a, b) => b.updated_at - a.updated_at || binaryOrder(b.project_id, a.project_id) || binaryOrder(b.plan_key, a.plan_key)).slice(0, limit + 1);
  }
  const key = after === null ? null : [after.updatedAt, after.projectId ?? '', after.planKey] as const;
  const page = status === null
    ? (key === null ? ACROSS.first.bind(limit + 1, since) : ACROSS.after.bind(limit + 1, since, ...key))
    : (key === null ? ACROSS_STATUS.first.bind(limit + 1, since, status) : ACROSS_STATUS.after.bind(limit + 1, since, ...key, status));
  const [rows] = await readSet(db, page);
  return rows;
}

/** The tags of each named plan, keyed `projectId` then `planKey`; a plan with none maps to an empty list. */
export async function readPlanTags(db: RelationalStore, keys: readonly { projectId: string; planKey: string }[]): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>();
  for (const { projectId, planKey } of keys) {
    const plans = out.get(projectId) ?? new Map<string, string[]>();
    plans.set(planKey, []);
    out.set(projectId, plans);
  }
  if (keys.length === 0) return out;
  const [rows] = await readSet(db, TAGS.bind(JSON.stringify(keys.map(key => [key.projectId, key.planKey]))));
  for (const row of rows) out.get(row.project_id)?.get(row.plan_key)?.push(row.tag);
  return out;
}
