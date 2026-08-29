import type { RelationalStore } from '../core/adapters.js';
import { clampLimit, type ReadScope } from './scope.js';

/** A plan as the project holds it: the projected row plus the tags the same event carried. */
export interface ProjectPlanRow {
  planKey: string;
  sessionId: string;
  title: string | null;
  status: string;
  content: string | null;
  blobKey: string | null;
  originPath: string | null;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

const COLUMNS = `plan_key, session_id, title, status, content, blob_key, origin_path, created_at, updated_at`;

function toPlan(row: Record<string, unknown>, tags: string[]): ProjectPlanRow {
  return {
    planKey: row.plan_key as string,
    sessionId: row.session_id as string,
    title: (row.title as string | null) ?? null,
    status: row.status as string,
    content: (row.content as string | null) ?? null,
    blobKey: (row.blob_key as string | null) ?? null,
    originPath: (row.origin_path as string | null) ?? null,
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
