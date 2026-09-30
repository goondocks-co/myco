import { registeredObjectKeySql } from '../core/blob-objects.js';
import type { RelationalStore } from '../core/adapters.js';
import { PLAN_STATUSES } from '../ingest/kinds.js';
import { clampLimit, encodeCursor, inListChunks, keyset, projectsDriving, type Page, type ProjectSet, type ReadScope } from './scope.js';

/** A plan as the project holds it: the projected row plus the tags the same event carried. `promptId` names the prompt the plan came from; `updatedBy` the member behind its last administrative edit, null when a capture event wrote last. */
export interface ProjectPlanRow {
  planKey: string;
  sessionId: string;
  promptId: string | null;
  title: string | null;
  status: string;
  content: string | null;
  blobKey: string | null;
  /** The stored object the plan's registered blob names, or null when it has none. */
  objectKey: string | null;
  originPath: string | null;
  /** `checked/total` over the plan's task list, or `N/A` when it has none. */
  progress: string;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

/** The statuses an administrative edit may write — the catalogue's; the list filter alone admits 'all'. */
export const WRITABLE_PLAN_STATUSES: ReadonlySet<string> = new Set(PLAN_STATUSES);
export const PLAN_STATUS_MESSAGE = `status must be one of: ${PLAN_STATUSES.join(', ')}`;

/** `checked/total` over the plan's task list, or `N/A` when it has none; a spilled plan reads as none. */
export function progressOf(content: string | null): string {
  const text = content ?? '';
  const checked = (text.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (text.match(/- \[ \]/g) ?? []).length;
  const total = checked + unchecked;
  return total === 0 ? 'N/A' : `${checked}/${total}`;
}

const COLUMNS = `plan_key, session_id, prompt_id, title, status, content, blob_key, ${registeredObjectKeySql('plans.project_id', 'plans.blob_key')} AS object_key, origin_path, updated_by, created_at, updated_at`;

function toPlan(row: Record<string, unknown>, tags: string[]): ProjectPlanRow {
  return {
    planKey: row.plan_key as string,
    sessionId: row.session_id as string,
    promptId: (row.prompt_id as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    status: row.status as string,
    content: (row.content as string | null) ?? null,
    blobKey: (row.blob_key as string | null) ?? null,
    objectKey: (row.object_key as string | null) ?? null,
    originPath: (row.origin_path as string | null) ?? null,
    progress: progressOf((row.content as string | null) ?? null),
    updatedBy: (row.updated_by as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    tags,
  };
}

/** The tags of each named plan, keyed by plan key; a plan with none maps to an empty list. */
async function tagsOf(db: RelationalStore, scope: ReadScope, planKeys: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(planKeys.map((k) => [k, []]));
  // A page of plans names more keys than one statement may bind, so the keys are read in runs.
  for (const run of inListChunks(planKeys)) {
    const { results } = await db
      .prepare(`SELECT entity_id, tag FROM tags WHERE project_id = ? AND entity_kind = 'plan' AND entity_id IN (${run.map(() => '?').join(', ')}) ORDER BY entity_id, tag`)
      .bind(scope.projectId, ...run)
      .all<{ entity_id: string; tag: string }>();
    for (const r of results) out.get(r.entity_id)?.push(r.tag);
  }
  return out;
}

/** The project's plans, most recently updated first; optionally one status or one session. */
export async function listProjectPlans(
  db: RelationalStore,
  scope: ReadScope,
  opts: { status?: string; sessionId?: string; limit?: number } = {},
): Promise<ProjectPlanRow[]> {
  return [...(await pageProjectPlans(db, scope, opts)).rows];
}

/**
 * One page of the project's plans, most recently updated first, and the cursor of the next. A plan edited while a
 * reader pages moves to the head of the list, which that reader already holds; a refresh reads it there.
 */
export async function pageProjectPlans(
  db: RelationalStore,
  scope: ReadScope,
  opts: { status?: string; sessionId?: string; limit?: number; cursor?: string } = {},
): Promise<Page<ProjectPlanRow>> {
  const listed = await selectPlans(db, { sql: 'project_id = ?', params: [scope.projectId] }, opts);
  return { cursor: listed.cursor, rows: listed.rows.map(({ projectId: _projectId, ...row }) => row) };
}

/** A plan of a read across Projects, with the Project it belongs to. */
export type PlanAcrossRow = ProjectPlanRow & { projectId: string };

/** One page of every plan in the set's Projects, most recently updated first, optionally only plans updated at or after a start instant. */
export async function pagePlansAcross(
  db: RelationalStore,
  set: ProjectSet,
  opts: { status?: string; since?: number; limit?: number; cursor?: string } = {},
): Promise<Page<PlanAcrossRow>> {
  return selectPlans(db, projectsDriving(set, 'project_id'), opts);
}

async function selectPlans(
  db: RelationalStore,
  projects: { sql: string; params: readonly unknown[] },
  opts: { status?: string; sessionId?: string; since?: number; limit?: number; cursor?: string },
): Promise<Page<PlanAcrossRow>> {
  const k = keyset({ limit: clampLimit(opts.limit), cursor: opts.cursor }, { order: 'updated_at', id: 'plan_key', direction: 'DESC' });
  if (k === null) return { rows: [], cursor: null };
  const conditions = [projects.sql];
  const params: unknown[] = [...projects.params];
  if (opts.status !== undefined) { conditions.push('status = ?'); params.push(opts.status); }
  if (opts.sessionId !== undefined) { conditions.push('session_id = ?'); params.push(opts.sessionId); }
  if (opts.since !== undefined) { conditions.push('updated_at >= ?'); params.push(opts.since); }
  if (k.where !== '') { conditions.push(k.where); params.push(...k.params); }
  const { results } = await db
    .prepare(`SELECT project_id, ${COLUMNS} FROM plans WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, plan_key DESC LIMIT ?`)
    .bind(...params, k.limit + 1)
    .all<Record<string, unknown>>();
  const shown = results.slice(0, k.limit);
  // Tags are keyed by Project first, so they are read per Project over its keys on the page.
  const keysByProject = new Map<string, string[]>();
  for (const r of shown) keysByProject.set(r.project_id as string, [...(keysByProject.get(r.project_id as string) ?? []), r.plan_key as string]);
  const tags = new Map<string, Map<string, string[]>>();
  for (const [projectId, keys] of keysByProject) tags.set(projectId, await tagsOf(db, { projectId }, keys));
  const rows = shown.map((r) => ({ ...toPlan(r, tags.get(r.project_id as string)?.get(r.plan_key as string) ?? []), projectId: r.project_id as string }));
  const last = rows[rows.length - 1];
  return { rows, cursor: results.length > k.limit && last !== undefined ? encodeCursor(last.updatedAt, last.planKey) : null };
}

/** One plan inside the scope, or null — including when the key exists under another project. */
export async function getPlan(db: RelationalStore, scope: ReadScope, planKey: string): Promise<ProjectPlanRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM plans WHERE project_id = ? AND plan_key = ?`).bind(scope.projectId, planKey).first<Record<string, unknown>>();
  if (row === null) return null;
  const tags = await tagsOf(db, scope, [planKey]);
  return toPlan(row, tags.get(planKey) ?? []);
}

/** True when the plan sits in the session inside the scope. */
export async function planInSession(db: RelationalStore, scope: ReadScope, sessionId: string, planKey: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM plans WHERE project_id = ? AND session_id = ? AND plan_key = ?`).bind(scope.projectId, sessionId, planKey).first<{ present: number }>();
  return row !== null;
}

/**
 * Writes a plan's status as an administrative edit by a member. The stamp lands strictly after the row's, so a capture event replayed with the row's old stamp never wins over the edit. False when no such plan sits in the scope or it already holds the status.
 */
export async function setPlanStatus(db: RelationalStore, scope: ReadScope, planKey: string, status: string, by: string, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE plans SET status = ?, updated_by = ?, updated_at = MAX(updated_at + 1, ?) WHERE project_id = ? AND plan_key = ? AND status <> ? RETURNING plan_key`)
    .bind(status, by, nowMs, scope.projectId, planKey, status)
    .first();
  return result !== null;
}
