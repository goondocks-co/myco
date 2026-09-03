import type { RelationalStore } from '../core/adapters.js';
import { PLAN_STATUSES } from '../ingest/kinds.js';
import { clampLimit, type ReadScope } from './scope.js';

/** A plan as the project holds it: the projected row plus the tags the same event carried. `promptId` names the prompt the plan came from; `updatedBy` the member behind its last administrative edit, null when a capture event wrote last. */
export interface ProjectPlanRow {
  planKey: string;
  sessionId: string;
  promptId: string | null;
  title: string | null;
  status: string;
  content: string | null;
  blobKey: string | null;
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

const COLUMNS = `plan_key, session_id, prompt_id, title, status, content, blob_key, origin_path, updated_by, created_at, updated_at`;

function toPlan(row: Record<string, unknown>, tags: string[]): ProjectPlanRow {
  return {
    planKey: row.plan_key as string,
    sessionId: row.session_id as string,
    promptId: (row.prompt_id as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    status: row.status as string,
    content: (row.content as string | null) ?? null,
    blobKey: (row.blob_key as string | null) ?? null,
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
  if (planKeys.length === 0) return out;
  const { results } = await db
    .prepare(`SELECT entity_id, tag FROM tags WHERE project_id = ? AND entity_kind = 'plan' AND entity_id IN (${planKeys.map(() => '?').join(', ')}) ORDER BY entity_id, tag`)
    .bind(scope.projectId, ...planKeys)
    .all<{ entity_id: string; tag: string }>();
  for (const r of results) out.get(r.entity_id)?.push(r.tag);
  return out;
}

/** The project's plans, most recently updated first; optionally one status or one session. */
export async function listProjectPlans(
  db: RelationalStore,
  scope: ReadScope,
  opts: { status?: string; sessionId?: string; limit?: number } = {},
): Promise<ProjectPlanRow[]> {
  const conditions = ['project_id = ?'];
  const params: unknown[] = [scope.projectId];
  if (opts.status !== undefined) { conditions.push('status = ?'); params.push(opts.status); }
  if (opts.sessionId !== undefined) { conditions.push('session_id = ?'); params.push(opts.sessionId); }
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM plans WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, plan_key DESC LIMIT ?`)
    .bind(...params, clampLimit(opts.limit))
    .all<Record<string, unknown>>();
  const tags = await tagsOf(db, scope, results.map((r) => r.plan_key as string));
  return results.map((r) => toPlan(r, tags.get(r.plan_key as string) ?? []));
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
    .prepare(`UPDATE plans SET status = ?, updated_by = ?, updated_at = MAX(updated_at + 1, ?) WHERE project_id = ? AND plan_key = ? AND status <> ?`)
    .bind(status, by, nowMs, scope.projectId, planKey, status)
    .run();
  return result.meta.changes === 1;
}
