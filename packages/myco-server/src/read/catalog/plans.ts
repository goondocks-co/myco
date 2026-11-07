import { registeredObjectKeySql as plans_import_registeredObjectKeySql } from "../../core/blob-objects.js";
import { processedResourceProofSql as plans_import_processedResourceProofSql } from "../../core/processed-resources.js";
import type { RelationalStore as plans_import_RelationalStore } from "../../core/adapters.js";
import { PLAN_STATUSES as plans_import_PLAN_STATUSES } from "../../ingest/kinds.js";
import { clampLimit as plans_import_clampLimit } from "../scope.js";
import { containsPattern as plans_import_containsPattern } from "../scope.js";
import { encodeCursor as plans_import_encodeCursor } from "../scope.js";
import { inListChunks as plans_import_inListChunks } from "../scope.js";
import { keyset as plans_import_keyset } from "../scope.js";
import { projectsDriving as plans_import_projectsDriving } from "../scope.js";
import { projectsFiltering as plans_import_projectsFiltering } from "../scope.js";
import type { Page as plans_import_Page } from "../scope.js";
import type { ProjectSet as plans_import_ProjectSet } from "../scope.js";
import type { ReadScope as plans_import_ReadScope } from "../scope.js";
import type { PreparedStatement as sessions_import_PreparedStatement } from "../../core/adapters.js";
import { queryRows } from './shared.js';

/** Status edits affect surviving facts; classified parser rows remain immutable. */
export function planStatusStatement(db: plans_import_RelationalStore, scope: plans_import_ReadScope, planKey: string,
  status: string, by: string, nowMs: number): sessions_import_PreparedStatement {
  return db.prepare(`UPDATE plans SET status = ?, updated_by = ?, updated_at = MAX(updated_at + 1, ?) WHERE project_id = ? AND plan_key = ? AND status <> ? RETURNING plan_key`).bind(status, by, nowMs, scope.projectId, planKey, status);
}

/** A plan as the project holds it: the projected row plus the tags the same event carried. `promptId` names the prompt the plan came from; `updatedBy` the member behind its last administrative edit, null when a capture event wrote last. */
interface plans_ProjectPlanRow {
  planKey: string;
  sessionId: string;
  promptId: string | null;
  title: string | null;
  status: string;
  content: string | null;
  blobKey: string | null;
  /** The registered object admitted by this plan's processed-field provenance, or null. */
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
const plans_WRITABLE_PLAN_STATUSES: ReadonlySet<string> = new Set(plans_import_PLAN_STATUSES);

const plans_PLAN_STATUS_MESSAGE = `status must be one of: ${plans_import_PLAN_STATUSES.join(', ')}`;

/** `checked/total` over the plan's task list, or `N/A` when it has none; a spilled plan reads as none. */
function plans_progressOf(content: string | null): string {
  const text = content ?? '';
  const checked = (text.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (text.match(/- \[ \]/g) ?? []).length;
  const total = checked + unchecked;
  return total === 0 ? 'N/A' : `${checked}/${total}`;
}

const plans_COLUMNS = `plan_key, session_id, prompt_id, title, status, content, blob_key,
  CASE WHEN ${plans_import_processedResourceProofSql('plans.project_id', 'plan', 'plans.plan_key', 'plans.blob_key')}
    THEN ${plans_import_registeredObjectKeySql('plans.project_id', 'plans.blob_key')} END AS object_key,
  origin_path, updated_by, created_at, updated_at`;

function plans_toPlan(row: Record<string, unknown>, tags: string[]): plans_ProjectPlanRow {
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
    progress: plans_progressOf((row.content as string | null) ?? null),
    updatedBy: (row.updated_by as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    tags,
  };
}

/** The tags of each named plan, keyed by plan key; a plan with none maps to an empty list. */
async function plans_tagsOf(db: plans_import_RelationalStore, scope: plans_import_ReadScope, planKeys: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(planKeys.map((k) => [k, []]));
  // A page of plans names more keys than one statement may bind, so the keys are read in runs.
  for (const run of plans_import_inListChunks(planKeys)) {
    const { results } = await db.prepare(`SELECT entity_id, tag FROM tags WHERE project_id = ? AND entity_kind = 'plan' AND entity_id IN (${run.map(() => '?').join(', ')}) ORDER BY entity_id, tag`)
      .bind(scope.projectId, ...run)
      .all<{ entity_id: string; tag: string }>();
    for (const r of results) out.get(r.entity_id)?.push(r.tag);
  }
  return out;
}

/** The tags of each named plan of each Project, keyed by Project and then plan key, every statement in one batch. */
async function plans_tagsAcross(db: plans_import_RelationalStore, keysByProject: ReadonlyMap<string, readonly string[]>): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>();
  const reads: { projectId: string; statement: ReturnType<plans_import_RelationalStore['prepare']> }[] = [];
  for (const [projectId, keys] of keysByProject) {
    out.set(projectId, new Map(keys.map((k) => [k, []])));
    for (const run of plans_import_inListChunks(keys)) {
      reads.push({
        projectId, statement: db.prepare(`SELECT entity_id, tag FROM tags WHERE project_id = ? AND entity_kind = 'plan' AND entity_id IN (${run.map(() => '?').join(', ')}) ORDER BY entity_id, tag`)
          .bind(projectId, ...run)
      });
    }
  }
  if (reads.length === 0) return out;
  const results = await db.batch(reads.map((r) => r.statement));
  results.forEach((result, i) => {
    const held = out.get(reads[i]!.projectId)!;
    for (const r of result.results as { entity_id: string; tag: string }[]) held.get(r.entity_id)?.push(r.tag);
  });
  return out;
}

/** The project's plans, most recently updated first; optionally one status or one session. */
async function plans_listProjectPlans(
  db: plans_import_RelationalStore,
  scope: plans_import_ReadScope,
  opts: { status?: string; sessionId?: string; limit?: number } = {},
): Promise<plans_ProjectPlanRow[]> {
  return [...(await plans_pageProjectPlans(db, scope, opts)).rows];
}

/**
 * One page of the project's plans, most recently updated first, and the cursor of the next. A plan edited while a
 * reader pages moves to the head of the list, which that reader already holds; a refresh reads it there.
 */
async function plans_pageProjectPlans(
  db: plans_import_RelationalStore,
  scope: plans_import_ReadScope,
  opts: { status?: string; sessionId?: string; limit?: number; cursor?: string } = {},
): Promise<plans_import_Page<plans_ProjectPlanRow>> {
  const listed = await plans_selectPlans(db, { sql: 'project_id = ?', params: [scope.projectId] }, opts);
  return { cursor: listed.cursor, rows: listed.rows.map(({ projectId: _projectId, ...row }) => row) };
}

/** A plan of a read across Projects, with the Project it belongs to. */
type plans_PlanAcrossRow = plans_ProjectPlanRow & { projectId: string };

/** One page of every plan in the set's Projects, most recently updated first, optionally only plans updated at or after a start instant. */
async function plans_pagePlansAcross(
  db: plans_import_RelationalStore,
  set: plans_import_ProjectSet,
  opts: { status?: string; since?: number; q?: string; limit?: number; cursor?: string } = {},
): Promise<plans_import_Page<plans_PlanAcrossRow>> {
  return plans_selectPlans(db, plans_import_projectsFiltering(set, 'plans'), opts, 'idx_plans_updated_deployment');
}

/**
 * The plans a text matches: its title or its body as the Deployment holds it inline, with `%` and `_` read as text.
 * Case is folded for ASCII letters only: `é` does not match `É`. A body spilled to a blob is matched by
 * `/api/search`, not here.
 */
function plans_planText(q: string | undefined): { sql: string; params: string[] } | null {
  if (q === undefined || q.trim() === '') return null;
  const pattern = plans_import_containsPattern(q.trim());
  return { sql: `(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`, params: [pattern, pattern] };
}

/**
 * How many plans of each status the set holds under the other filters: a start instant and a text. Read through each
 * Project's own plans, one statement. A status no plan holds is absent. The totals and the page are two statements, so
 * a plan written between them can leave a total one off the page it sits beside.
 */
async function plans_planTotals(db: plans_import_RelationalStore, set: plans_import_ProjectSet, opts: { since?: number; q?: string } = {}): Promise<Record<string, number>> {
  const projects = plans_import_projectsDriving(set, 'project_id');
  const conditions = [projects.sql];
  const params: unknown[] = [...projects.params];
  if (opts.since !== undefined) { conditions.push('updated_at >= ?'); params.push(opts.since); }
  const text = plans_planText(opts.q);
  if (text !== null) { conditions.push(text.sql); params.push(...text.params); }
  const { results } = await db.prepare(`SELECT status, COUNT(*) AS n FROM plans WHERE ${conditions.join(' AND ')} GROUP BY status`)
    .bind(...params).all<{ status: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.status, Number(r.n)]));
}

/**
 * One plan page over the rows `projects` admits. A read that walks a Deployment-wide index (`walks`, named in the
 * statement) also takes the cursor's instant as an upper bound beside the keyset predicate, which the predicate
 * already implies, so the walk seeks to the cursor.
 */
async function plans_selectPlans(
  db: plans_import_RelationalStore,
  projects: { sql: string; params: readonly unknown[] },
  opts: { status?: string; sessionId?: string; since?: number; q?: string; limit?: number; cursor?: string },
  walks = '',
): Promise<plans_import_Page<plans_PlanAcrossRow>> {
  const k = plans_import_keyset({ limit: plans_import_clampLimit(opts.limit), cursor: opts.cursor }, { order: 'updated_at', id: 'plan_key', direction: 'DESC' });
  if (k === null) return { rows: [], cursor: null };
  const conditions = [projects.sql];
  const params: unknown[] = [...projects.params];
  if (opts.status !== undefined) { conditions.push('status = ?'); params.push(opts.status); }
  if (opts.sessionId !== undefined) { conditions.push('session_id = ?'); params.push(opts.sessionId); }
  if (opts.since !== undefined) { conditions.push('updated_at >= ?'); params.push(opts.since); }
  const text = plans_planText(opts.q);
  if (text !== null) { conditions.push(text.sql); params.push(...text.params); }
  if (k.where !== '') {
    if (walks !== '') { conditions.push('updated_at <= ?'); params.push(k.params[0]); }
    conditions.push(k.where); params.push(...k.params);
  }
  const { results } = await db.prepare(`SELECT project_id, ${plans_COLUMNS} FROM plans${walks === '' ? '' : ` INDEXED BY ${walks}`} WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, plan_key DESC LIMIT ?`)
    .bind(...params, k.limit + 1)
    .all<Record<string, unknown>>();
  const shown = results.slice(0, k.limit);
  // Tags are keyed by Project first, so they are read per Project over its keys on the page, in one batch.
  const keysByProject = new Map<string, string[]>();
  for (const r of shown) keysByProject.set(r.project_id as string, [...(keysByProject.get(r.project_id as string) ?? []), r.plan_key as string]);
  const tags = await plans_tagsAcross(db, keysByProject);
  const rows = shown.map((r) => ({ ...plans_toPlan(r, tags.get(r.project_id as string)?.get(r.plan_key as string) ?? []), projectId: r.project_id as string }));
  const last = rows[rows.length - 1];
  return { rows, cursor: results.length > k.limit && last !== undefined ? plans_import_encodeCursor(last.updatedAt, last.planKey) : null };
}

/** A plan's bounded metadata, including the content revision and source session. */
type plans_ProjectPlanSummary = Pick<plans_ProjectPlanRow, 'planKey' | 'title' | 'status' | 'sessionId'> & { contentHash: string | null };

function plans_getPlan(db: plans_import_RelationalStore, scope: plans_import_ReadScope, planKey: string, options: { summary: true }): Promise<plans_ProjectPlanSummary | null>;

function plans_getPlan(db: plans_import_RelationalStore, scope: plans_import_ReadScope, planKey: string): Promise<plans_ProjectPlanRow | null>;

 async function plans_getPlan(db: plans_import_RelationalStore, scope: plans_import_ReadScope, planKey: string, options: { summary?: boolean } = {}): Promise<plans_ProjectPlanSummary | plans_ProjectPlanRow | null> {
  const columns = options.summary ? 'plan_key, title, status, session_id, content_hash' : plans_COLUMNS;
  const row = (await queryRows<Record<string, unknown>>(db,`SELECT ${columns} FROM plans WHERE project_id = ? AND plan_key = ?`,[scope.projectId, planKey],'first'))[0] ?? null;
  if (row === null) return null;
  if (options.summary) return { planKey: row.plan_key as string, title: row.title as string | null, status: row.status as string,
    sessionId: row.session_id as string, contentHash: row.content_hash as string | null };
  const tags = await plans_tagsOf(db, scope, [planKey]);
  return plans_toPlan(row, tags.get(planKey) ?? []);
}

/** True when the plan sits in the session inside the scope. */
 async function plans_planInSession(db: plans_import_RelationalStore, scope: plans_import_ReadScope, sessionId: string, planKey: string): Promise<boolean> {
  const row = (await queryRows<{ present: number }>(db,`SELECT 1 AS present FROM plans WHERE project_id = ? AND session_id = ? AND plan_key = ?`,[scope.projectId, sessionId, planKey],'first'))[0] ?? null;
  return row !== null;
}

export { type plans_ProjectPlanRow, plans_WRITABLE_PLAN_STATUSES, plans_PLAN_STATUS_MESSAGE, plans_progressOf, plans_listProjectPlans, plans_pageProjectPlans, type plans_PlanAcrossRow, plans_pagePlansAcross, plans_planTotals, type plans_ProjectPlanSummary, plans_getPlan, plans_planInSession };
