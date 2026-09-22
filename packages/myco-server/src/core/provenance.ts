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

/** The namespaces a caller names. */
export const RELEASE_NAMESPACES = ['spore', 'skill', 'session', 'plan'] as const;
export type ReleaseNamespace = (typeof RELEASE_NAMESPACES)[number];

/**
 * Each namespace's stored forms. The reconciler, the search filter and the
 * embedding sources write and join on the table name (`sessions`, `spores`);
 * a row may also carry the singular name. A read matches either, and names
 * the row by the singular one.
 */
const STORED_FORMS: Readonly<Record<ReleaseNamespace, readonly [string, string]>> = {
  spore: ['spore', 'spores'],
  skill: ['skill', 'skill_records'],
  session: ['session', 'sessions'],
  plan: ['plan', 'plans'],
};

/** The form the reconciler writes, which the search and embedding reads join on. */
export const storedNamespace = (namespace: ReleaseNamespace): string => STORED_FORMS[namespace][1];

const PUBLIC_BY_STORED = new Map<string, ReleaseNamespace>(
  RELEASE_NAMESPACES.flatMap((n) => STORED_FORMS[n].map((form) => [form, n] as const)),
);

/** A namespace as a caller or a stored row names it, or null when it names none. */
export const canonicalNamespace = (value: unknown): ReleaseNamespace | null =>
  typeof value === 'string' ? PUBLIC_BY_STORED.get(value) ?? null : null;

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

const named = (row: ReleaseStateRow): ReleaseStateRow => ({ ...row, namespace: canonicalNamespace(row.namespace) ?? row.namespace });

const COLUMNS = `id, namespace, record_id AS recordId, state, confidence,
  basis_kind AS basisKind, basis_ref AS basisRef, basis_sha AS basisSha,
  release_pr_number AS releasePrNumber, reason, checked_at AS checkedAt`;

export async function getReleaseState(
  db: RelationalStore, scope: ReadScope, namespace: ReleaseNamespace, recordId: string,
): Promise<ReleaseStateRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM knowledge_release_state
     WHERE project_id = ? AND namespace IN (?, ?) AND record_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1`)
    .bind(scope.projectId, ...STORED_FORMS[namespace], recordId).first<ReleaseStateRow>();
  return row === null ? null : named(row);
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
       WHERE project_id = ? AND namespace IN (?, ?) AND record_id IN (SELECT value FROM json_each(?))
       ORDER BY checked_at ASC, id ASC`)
    .bind(scope.projectId, ...STORED_FORMS[namespace], JSON.stringify([...new Set(recordIds)]))
    .all<ReleaseStateRow>();
  return Object.fromEntries(results.map((r) => [r.recordId, named(r)]));
}

export async function listReleaseStates(
  db: RelationalStore, scope: ReadScope, o: { namespace?: ReleaseNamespace; state?: string; limit?: number } = {},
): Promise<ReleaseStateRow[]> {
  const conditions = ['project_id = ?'];
  const params: unknown[] = [scope.projectId];
  if (o.namespace !== undefined) { conditions.push('namespace IN (?, ?)'); params.push(...STORED_FORMS[o.namespace]); }
  if (o.state !== undefined) { conditions.push('state = ?'); params.push(o.state); }
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM knowledge_release_state WHERE ${conditions.join(' AND ')}
       ORDER BY checked_at DESC, id DESC LIMIT ?`)
    .bind(...params, Math.min(o.limit ?? 100, 500)).all<ReleaseStateRow>();
  return results.map(named);
}

/** A record's release state as every surface presents it: the state, its age, and whether the Project's latest check failed after it. */
export interface ReleaseStatus {
  state: string;
  confidence: string;
  ref: string | null;
  reason: string | null;
  checkedAt: number;
  /** The Project's latest check, when it finished after this state's check without completing: the state shown is older than that attempt. */
  latestCheck: { status: string; failure: string | null; finishedAt: number } | null;
}

export async function getReleaseStatus(
  db: RelationalStore, scope: ReadScope, namespace: ReleaseNamespace, recordId: string,
): Promise<ReleaseStatus | null> {
  const row = await getReleaseState(db, scope, namespace, recordId);
  if (row === null) return null;
  const check = await db.prepare(`SELECT check_status AS status, check_failure AS failure, check_finished_at AS finishedAt
     FROM project_release_provenance WHERE project_id = ?`).bind(scope.projectId)
    .first<{ status: string | null; failure: string | null; finishedAt: number | null }>();
  const failedAfter = check !== null && check.status !== null && check.status !== 'complete' && check.failure !== null
    && check.finishedAt !== null && check.finishedAt > row.checkedAt;
  return {
    state: row.state, confidence: row.confidence, ref: row.basisRef, reason: row.reason, checkedAt: row.checkedAt,
    latestCheck: failedAfter ? { status: check.status!, failure: check.failure, finishedAt: check.finishedAt! } : null,
  };
}
