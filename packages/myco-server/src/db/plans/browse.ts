import type { RelationalStore } from '../../core/adapters.js';
import { notTombstonedSql } from '../session-read-model.js';
import type { ProjectSet } from '../../read/scope.js';
import { read, readSet } from '../index.js';

/**
 * Plan lists: a plan's metadata, its stored preview and progress, and never its body, which only the plan's own read
 * answers. Each list walks one index in its own order and starts a later page after the last row's key:
 * - one Project, newest edit first, by `(updated_at, plan_key)`; with a status, on that status's index;
 * - one session, newest or oldest edit first, by `(updated_at, plan_key)` on the session index;
 * - across Projects, newest edit first, by `(updated_at, project_id, plan_key)`; with a status, on that status's index.
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
}

/** The key a page starts after: the edit instant and the plan, and across Projects the Project between them. */
export interface PlanPageKey { updatedAt: number; projectId?: string; planKey: string }

const PLAN_LIST_COLUMNS = `p.project_id,p.plan_key,p.session_id,p.prompt_id,p.title,p.status,p.origin_path,p.updated_by,p.created_at,p.updated_at,
  m.preview,m.progress_done,m.progress_total`;
const FROM = (index: string) => `FROM plans p INDEXED BY ${index} LEFT JOIN plan_metadata m ON m.project_id=p.project_id AND m.plan_key=p.plan_key`;
const SHOWN = notTombstonedSql('p');
/** After `(updated_at, plan_key)` at slots `at` and `key`. */
const afterInProject = (at: string, key: string) => `AND p.updated_at<=${at} AND (p.updated_at<${at} OR (p.updated_at=${at} AND p.plan_key<${key}))`;
/** After `(updated_at, project_id, plan_key)` at slots `at`, `project` and `key`. */
const afterAcross = (at: string, project: string, key: string) => `AND p.updated_at<=${at} AND (p.updated_at<${at} OR (p.updated_at=${at}
  AND (p.project_id<${project} OR (p.project_id=${project} AND p.plan_key<${key}))))`;
const IN_PROJECT_ORDER = 'ORDER BY p.updated_at DESC,p.plan_key DESC';
const ACROSS_ORDER = 'ORDER BY p.updated_at DESC,p.project_id DESC,p.plan_key DESC';
/** Every Project the caller may see when `projects` is null, else the Projects it names, bound as `,id,id,` (an id holds no comma). */
const inSet = (projects: string) => `(CASE WHEN ${projects} IS NULL THEN EXISTS (SELECT 1 FROM projects x WHERE x.project_id=p.project_id AND x.archived_at IS NULL)
  ELSE instr(${projects},','||p.project_id||',')>0 END)`;
/** A start instant bounds the walk; none starts from the earliest. */
const since = (slot: string) => `p.updated_at>=COALESCE(${slot},${Number.MIN_SAFE_INTEGER})`;

type ProjectPage = [project: string, limit: number];
type ProjectAfter = [project: string, limit: number, at: number, key: string];
const PROJECT = {
  first: read<ProjectPage, PlanListRow>({ name: 'planPages.projectFirst',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_project_updated')} WHERE p.project_id=?1 AND ${SHOWN} ${IN_PROJECT_ORDER} LIMIT ?2` }),
  after: read<ProjectAfter, PlanListRow>({ name: 'planPages.projectAfter',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_project_updated')} WHERE p.project_id=?1 ${afterInProject('?3', '?4')} AND ${SHOWN} ${IN_PROJECT_ORDER} LIMIT ?2` }),
};
const PROJECT_STATUS = {
  first: read<[...ProjectPage, status: string], PlanListRow>({ name: 'planPages.projectStatusFirst',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_project_status_updated')} WHERE p.project_id=?1 AND p.status=?3 AND ${SHOWN} ${IN_PROJECT_ORDER} LIMIT ?2` }),
  after: read<[...ProjectAfter, status: string], PlanListRow>({ name: 'planPages.projectStatusAfter',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_project_status_updated')} WHERE p.project_id=?1 AND p.status=?5 ${afterInProject('?3', '?4')} AND ${SHOWN}
      ${IN_PROJECT_ORDER} LIMIT ?2` }),
};
/** After `(updated_at, plan_key)` at slots `at` and `key`, oldest first. */
const beforeInProject = (at: string, key: string) => `AND p.updated_at>=${at} AND (p.updated_at>${at} OR (p.updated_at=${at} AND p.plan_key>${key}))`;
type SessionPage = [...ProjectPage, session: string, status: string | null];
type SessionAfter = [...ProjectAfter, session: string, status: string | null];
const sessionSql = (after: string, order: string, session: string, status: string) => `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_session')}
  WHERE p.project_id=?1 AND p.session_id=${session} ${after} AND (${status} IS NULL OR p.status=${status}) AND ${SHOWN} ${order} LIMIT ?2`;
/** A session's plans: the session bounds the walk, so a status is checked on each of its plans. The session's own tab reads them oldest first. */
const SESSION = {
  newest: {
    first: read<SessionPage, PlanListRow>({ name: 'planPages.sessionNewestFirst', sql: sessionSql('', IN_PROJECT_ORDER, '?3', '?4') }),
    after: read<SessionAfter, PlanListRow>({ name: 'planPages.sessionNewestAfter', sql: sessionSql(afterInProject('?3', '?4'), IN_PROJECT_ORDER, '?5', '?6') }),
  },
  oldest: {
    first: read<SessionPage, PlanListRow>({ name: 'planPages.sessionOldestFirst', sql: sessionSql('', 'ORDER BY p.updated_at,p.plan_key', '?3', '?4') }),
    after: read<SessionAfter, PlanListRow>({ name: 'planPages.sessionOldestAfter', sql: sessionSql(beforeInProject('?3', '?4'), 'ORDER BY p.updated_at,p.plan_key', '?5', '?6') }),
  },
};
type AcrossPage = [projects: string | null, limit: number, since: number | null];
type AcrossAfter = [...AcrossPage, at: number, project: string, key: string];
const ACROSS = {
  first: read<AcrossPage, PlanListRow>({ name: 'planPages.acrossFirst',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_across')} WHERE ${since('?3')} AND ${inSet('?1')} AND ${SHOWN} ${ACROSS_ORDER} LIMIT ?2` }),
  after: read<AcrossAfter, PlanListRow>({ name: 'planPages.acrossAfter',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_across')} WHERE ${since('?3')} ${afterAcross('?4', '?5', '?6')} AND ${inSet('?1')} AND ${SHOWN}
      ${ACROSS_ORDER} LIMIT ?2` }),
};
const ACROSS_STATUS = {
  first: read<[...AcrossPage, status: string], PlanListRow>({ name: 'planPages.acrossStatusFirst',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_across_status')} WHERE p.status=?4 AND ${since('?3')} AND ${inSet('?1')} AND ${SHOWN} ${ACROSS_ORDER} LIMIT ?2` }),
  after: read<[...AcrossAfter, status: string], PlanListRow>({ name: 'planPages.acrossStatusAfter',
    sql: `SELECT ${PLAN_LIST_COLUMNS} ${FROM('idx_plans_across_status')} WHERE p.status=?7 AND ${since('?3')} ${afterAcross('?4', '?5', '?6')} AND ${inSet('?1')}
      AND ${SHOWN} ${ACROSS_ORDER} LIMIT ?2` }),
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
    const [rows] = await readSet(db, after === null ? pages.first.bind(projectId, limit + 1, sessionId, status)
      : pages.after.bind(projectId, limit + 1, after.updatedAt, after.planKey, sessionId, status));
    return rows;
  }
  const start = 'since' in request ? request.since ?? null : null;
  const named = 'all' in request.scope && !request.scope.all ? request.scope.projectIds : null;
  const scope = named !== null && named.length === 1 && start === null ? { projectId: named[0]! } : request.scope;
  if ('projectId' in scope) {
    const page = status === null
      ? (after === null ? PROJECT.first.bind(scope.projectId, limit + 1) : PROJECT.after.bind(scope.projectId, limit + 1, after.updatedAt, after.planKey))
      : (after === null ? PROJECT_STATUS.first.bind(scope.projectId, limit + 1, status)
        : PROJECT_STATUS.after.bind(scope.projectId, limit + 1, after.updatedAt, after.planKey, status));
    const [rows] = await readSet(db, page);
    return rows;
  }
  const projects = scope.all ? null : `,${scope.projectIds.join(',')},`;
  const key = after === null ? null : [after.updatedAt, after.projectId ?? '', after.planKey] as const;
  const page = status === null
    ? (key === null ? ACROSS.first.bind(projects, limit + 1, start) : ACROSS.after.bind(projects, limit + 1, start, ...key))
    : (key === null ? ACROSS_STATUS.first.bind(projects, limit + 1, start, status) : ACROSS_STATUS.after.bind(projects, limit + 1, start, ...key, status));
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
