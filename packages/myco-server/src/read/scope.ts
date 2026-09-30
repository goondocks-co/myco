/** The resolved read scope. Every query takes one; no query resolves it. Phase 2's per-project contributor grants widen this type without touching a query. */
export interface ReadScope {
  readonly projectId: string;
}

/**
 * The Projects a read spanning more than one covers: every Project the caller may see, or the ones it named. Resolved
 * by `api/scope.ts` and never by a query. `all` is expressed in SQL over the `projects` table rather than as a list,
 * so it binds nothing and holds however many Projects a Deployment has; a named set is at most `MAX_NAMED_PROJECTS`
 * ids.
 */
export type ProjectSet =
  | { readonly all: true }
  | { readonly all: false; readonly projectIds: readonly string[] };

/** The Projects `all` covers: those accepting capture, which are the ones every listing shows by default. */
const VISIBLE_PROJECTS = `SELECT project_id FROM projects WHERE archived_at IS NULL`;

/**
 * The set as a predicate that drives the read by Project: one index search per Project on an index led by
 * `project_id`. The form for a table read through its Project-led indexes.
 */
export function projectsDriving(set: ProjectSet, column: string): { sql: string; params: string[] } {
  if (set.all) return { sql: `${column} IN (${VISIBLE_PROJECTS})`, params: [] };
  return { sql: `${column} IN (${set.projectIds.map(() => '?').join(', ')})`, params: [...set.projectIds] };
}

/**
 * The set as a predicate checked per row against the Project's own key, so an index not led by `project_id` can
 * order the read. The form for a read that walks a Deployment-wide index and stops at its page.
 */
export function projectsFiltering(set: ProjectSet, alias: string): { sql: string; params: string[] } {
  if (set.all) return { sql: `EXISTS (SELECT 1 FROM projects p WHERE p.project_id = ${alias}.project_id AND p.archived_at IS NULL)`, params: [] };
  return projectsDriving(set, `${alias}.project_id`);
}

/**
 * The set as a predicate on `${alias}.project_id` that binds at most one value however many Projects it names, for a
 * statement that repeats the predicate or binds many values of its own. A named set travels as one JSON array; every
 * Project is checked per row, as `projectsFiltering` checks it.
 */
export function projectsBoundOnce(set: ProjectSet, alias: string): { sql: string; params: string[] } {
  if (set.all) return projectsFiltering(set, alias);
  return { sql: `${alias}.project_id IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(set.projectIds)] };
}

/**
 * A LIKE pattern matching `text` anywhere, with the pattern's own metacharacters escaped; the statement names `\` as
 * its escape (`LIKE ? ESCAPE '\'`). SQLite's LIKE folds case for ASCII letters only.
 */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** A page of rows and the cursor that fetches the next one, or null at the end of the set. */
export interface Page<T> {
  readonly rows: readonly T[];
  readonly cursor: string | null;
}

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/** A cursor is `<createdAt>:<id>` — the (created_at, id) key the projection indexes are ordered by. */
export function encodeCursor(createdAt: number, id: string): string {
  return `${createdAt}:${id}`;
}

/** The cursor's key, or null when the text is not one; a malformed cursor is refused rather than treated as absent, so a client never silently receives page one when it asked for page nine. */
export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  const split = cursor.indexOf(':');
  if (split <= 0) return null;
  const createdAt = Number(cursor.slice(0, split));
  const id = cursor.slice(split + 1);
  return Number.isSafeInteger(createdAt) && id.length > 0 ? { createdAt, id } : null;
}

/** The caller's page size within bounds; anything absent, non-integer or below one takes the default. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1) return DEFAULT_PAGE;
  return Math.min(limit, MAX_PAGE);
}

/** How a keyset page is ordered: the column no later write moves, the tie-breaking id, and the direction. */
export interface KeysetSpec {
  order: string;
  id: string;
  direction: 'ASC' | 'DESC';
}

/** The page size and the cursor's predicate for one keyset read, or null for a malformed cursor — refused rather than treated as absent. `where` is empty on page one; `params` bind it. */
export function keyset(opts: { limit?: number; cursor?: string }, spec: KeysetSpec): { limit: number; where: string; params: readonly (number | string)[] } | null {
  const limit = clampLimit(opts.limit);
  if (opts.cursor === undefined) return { limit, where: '', params: [] };
  const after = decodeCursor(opts.cursor);
  if (after === null) return null;
  const cmp = spec.direction === 'DESC' ? '<' : '>';
  return {
    limit,
    where: `(${spec.order} ${cmp} ? OR (${spec.order} = ? AND ${spec.id} ${cmp} ?))`,
    params: [after.createdAt, after.createdAt, after.id],
  };
}

/** The most ids one statement names in an `IN (…)` list. The hosted store admits 100 bound parameters per statement; the scope's own binding takes one, and a margin keeps a statement that binds a few more still under the ceiling. */
export const MAX_IN_LIST = 90;

/**
 * The most Projects a read across Projects may name. Its statements bind the list beside their own filters, a keyset
 * cursor and a limit, which come to at most 16 more values, and the whole stays under the store's 100.
 */
export const MAX_NAMED_PROJECTS = 64;

/** `ids` in runs no longer than `MAX_IN_LIST`, so every statement over one run stays under the store's parameter ceiling. */
export function inListChunks<T>(ids: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += MAX_IN_LIST) out.push(ids.slice(i, i + MAX_IN_LIST));
  return out;
}

/** Trims an over-fetched row set to the page and emits a cursor only when the extra row proved another page exists. */
export function page<T>(rows: readonly T[], limit: number, key: (row: T) => { createdAt: number; id: string }): Page<T> {
  const more = rows.length > limit;
  const out = more ? rows.slice(0, limit) : rows;
  if (!more || out.length === 0) return { rows: out, cursor: null };
  const last = key(out[out.length - 1]);
  return { rows: out, cursor: encodeCursor(last.createdAt, last.id) };
}
