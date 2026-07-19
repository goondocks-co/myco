/**
 * Reference check for the hosted-project prune (Team Host E-4 W2 T1e).
 *
 * A hosted (synthetic-root) registry row is safe to prune ONLY when the served
 * Grove DB holds NO durable content for its project id. This is the delete-only-
 * if-empty guard: a single session / spore / plan row makes the project real and
 * must keep its registry row (and thus its resolvable tenancy) alive regardless
 * of age. Keeping the predicate here — one indexed existence probe across the
 * three content tables — means the prune's structural invariant lives with the
 * schema it depends on, not scattered in the job.
 */
import type { Database } from '@myco/db/client.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

/**
 * True when the current Grove DB holds at least one sessions / spores / plans
 * row for `projectId`. A short-circuiting `EXISTS` over the union — it stops at
 * the first match and never counts, so a busy project costs one row read.
 */
export function hostedProjectHasDbReferences(db: Database, projectId: GroveProjectId): boolean {
  const row = db.prepare(
    `SELECT EXISTS(
       SELECT 1 FROM sessions WHERE project_id = ?
       UNION ALL
       SELECT 1 FROM spores   WHERE project_id = ?
       UNION ALL
       SELECT 1 FROM plans    WHERE project_id = ?
     ) AS has_refs`,
  ).get(projectId, projectId, projectId) as { has_refs: number } | undefined;
  return (row?.has_refs ?? 0) !== 0;
}
