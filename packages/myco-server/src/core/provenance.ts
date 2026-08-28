/**
 * Release state, read-side.
 *
 * The agent consumes release provenance to annotate what it reads; it does not
 * write it. Writes arrive through capture and through the reconciler job, so
 * only the reads a task needs live here.
 *
 * **The bulk lookup is one statement, not one per record.** Search hydration
 * annotates every result row, and a lookup per row is the N+1 that makes
 * annotation cost scale with the page. `json_each` carries the id set into a
 * single query, and the ids are de-duplicated first so a page repeating a
 * record does not widen it.
 *
 * **An unknown namespace is refused rather than queried.** A namespace that
 * matches nothing returns an empty answer indistinguishable from a record with
 * no release state, so a caller misspelling one would read "not released"
 * forever.
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';

export const RELEASE_NAMESPACES = ['spore', 'skill', 'session', 'plan'] as const;
export type ReleaseNamespace = (typeof RELEASE_NAMESPACES)[number];

export const isReleaseNamespace = (value: unknown): value is ReleaseNamespace =>
  typeof value === 'string' && (RELEASE_NAMESPACES as readonly string[]).includes(value);

export interface ReleaseStateRow {
  id: string;
  namespace: string;
  recordId: string;
  state: string;
  confidence: string;
  basisKind: string | null;
  basisRef: string | null;
  basisSha: string | null;
  releasePrNumber: number | null;
  reason: string | null;
  checkedAt: number;
}

const COLUMNS = `id, namespace, record_id AS recordId, state, confidence,
  basis_kind AS basisKind, basis_ref AS basisRef, basis_sha AS basisSha,
  release_pr_number AS releasePrNumber, reason, checked_at AS checkedAt`;

export async function getReleaseState(
  db: RelationalStore, scope: ReadScope, namespace: ReleaseNamespace, recordId: string,
): Promise<ReleaseStateRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM knowledge_release_state
     WHERE project_id = ? AND namespace = ? AND record_id = ? LIMIT 1`)
    .bind(scope.projectId, namespace, recordId).first<ReleaseStateRow>();
}

/**
 * Release state for many records in one query.
 *
 * A record with no release state is simply absent from the result, which is a
 * different answer from one whose state is unknown.
 */
export async function getReleaseStatesForRecords(
  db: RelationalStore, scope: ReadScope, namespace: ReleaseNamespace, recordIds: readonly string[],
): Promise<Record<string, ReleaseStateRow>> {
  if (recordIds.length === 0) return {};
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM knowledge_release_state
       WHERE project_id = ? AND namespace = ? AND record_id IN (SELECT value FROM json_each(?))`)
    .bind(scope.projectId, namespace, JSON.stringify([...new Set(recordIds)]))
    .all<ReleaseStateRow>();
  return Object.fromEntries(results.map((r) => [r.recordId, r]));
}

export async function listReleaseStates(
  db: RelationalStore, scope: ReadScope, o: { namespace?: ReleaseNamespace; state?: string; limit?: number } = {},
): Promise<ReleaseStateRow[]> {
  const conditions = ['project_id = ?'];
  const params: unknown[] = [scope.projectId];
  if (o.namespace !== undefined) { conditions.push('namespace = ?'); params.push(o.namespace); }
  if (o.state !== undefined) { conditions.push('state = ?'); params.push(o.state); }
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM knowledge_release_state WHERE ${conditions.join(' AND ')}
       ORDER BY checked_at DESC, id DESC LIMIT ?`)
    .bind(...params, Math.min(o.limit ?? 100, 500)).all<ReleaseStateRow>();
  return results;
}
