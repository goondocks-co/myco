import type { RelationalStore } from '../../core/adapters.js';
import { registeredObjectKeySql } from '../../core/blob-objects.js';
import { processedResourceProofSql } from '../../core/processed-resources.js';
import { containsPattern, projectsFiltering, type ProjectSet } from '../../read/scope.js';
import { composedRead } from '../browse/composed.js';
import { readSet, type BindValue } from '../index.js';

/** A plan's stored fields, with the object key of a body spilled to a blob once its processing is proven. */
export const PLAN_COLUMNS = `plan_key, session_id, prompt_id, title, status, content, blob_key,
  CASE WHEN ${processedResourceProofSql('plans.project_id', 'plan', 'plans.plan_key', 'plans.blob_key')}
    THEN ${registeredObjectKeySql('plans.project_id', 'plans.blob_key')} END AS object_key,
  origin_path, updated_by, created_at, updated_at`;

/** The Deployment-wide order every read of plans across Projects walks: the update, the Project, the key. */
const PLANS_ACROSS_INDEX = 'idx_plans_updated_deployment';

/**
 * The plans a text matches: its title or its body as the Deployment holds it inline, with `%` and `_` read as text.
 * Case is folded for ASCII letters only: `é` does not match `É`. A body spilled to a blob is matched by
 * `/api/search`, not here.
 */
export function planText(q: string | undefined): { sql: string; params: string[] } | null {
  if (q === undefined || q.trim() === '') return null;
  const pattern = containsPattern(q.trim());
  return { sql: `(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`, params: [pattern, pattern] };
}

export interface PlanBrowseFilters { status?: string; sessionId?: string; since?: number; q?: string }

/** The key after which a page starts: within one Project the update and the key; across Projects the Project too. */
export interface PlanPageKey { createdAt: number; projectId?: string; id: string }

/**
 * One plan page as stored rows with their Project, at most `limit` + 1 of them, most recently updated first. A read
 * across Projects walks the Deployment-wide index and orders by the update, the Project and the key.
 */
export async function readPlanPage(db: RelationalStore, request: {
  scope: { projectId: string } | ProjectSet; filters: PlanBrowseFilters; after: PlanPageKey | null; limit: number;
}): Promise<Record<string, unknown>[]> {
  const { scope, filters, after, limit } = request;
  const across = !('projectId' in scope);
  const projects = across ? projectsFiltering(scope, 'plans') : { sql: 'project_id = ?', params: [scope.projectId] };
  const conditions = [projects.sql];
  const params: BindValue[] = [...projects.params];
  if (filters.status !== undefined) { conditions.push('status = ?'); params.push(filters.status); }
  if (filters.sessionId !== undefined) { conditions.push('session_id = ?'); params.push(filters.sessionId); }
  if (filters.since !== undefined) { conditions.push('updated_at >= ?'); params.push(filters.since); }
  const text = planText(filters.q);
  if (text !== null) { conditions.push(text.sql); params.push(...text.params); }
  if (after !== null) {
    if (across) {
      conditions.push('updated_at <= ? AND (updated_at < ? OR (updated_at = ? AND (project_id < ? OR (project_id = ? AND plan_key < ?))))');
      params.push(after.createdAt, after.createdAt, after.createdAt, after.projectId!, after.projectId!, after.id);
    } else {
      conditions.push('updated_at <= ? AND (updated_at < ? OR (updated_at = ? AND plan_key < ?))');
      params.push(after.createdAt, after.createdAt, after.createdAt, after.id);
    }
  }
  const sql = `SELECT project_id, ${PLAN_COLUMNS} FROM plans${across ? ` INDEXED BY ${PLANS_ACROSS_INDEX}` : ''} WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC,${across ? ' project_id DESC,' : ''} plan_key DESC LIMIT ?`;
  const [rows] = await readSet(db, composedRead<Record<string, unknown>>('planBrowse', sql).bind(...params, limit + 1));
  return rows;
}
