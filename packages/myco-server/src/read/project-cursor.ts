/**
 * Cursors of lists that span Projects. A row of such a list is keyed by its Project and its id, so the cursor carries
 * `<instant>:<projectId>:<id>` and the list orders by the instant, then the Project, then the id, all descending: two rows
 * of different Projects sharing an instant and an id each keep their own place across a page boundary.
 */
import { clampLimit, type Page } from './scope.js';

/** The Project id grammar the schema enforces: no `:`, so the cursor splits unambiguously. */
const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The refusal of a cursor this list did not issue, including one from before cursors carried the Project. */
export const PROJECT_CURSOR_REFUSAL =
  'malformed cursor: this list pages by "<instant>:<projectId>:<id>" exactly as its last answer returned it in `cursor`; '
  + 'a cursor issued before lists across Projects carried the Project is refused. Nothing was read: request the first page again without a cursor.';

export interface ProjectCursor { createdAt: number; projectId: string; id: string }

export function encodeProjectCursor(key: ProjectCursor): string {
  return `${key.createdAt}:${key.projectId}:${key.id}`;
}

/** The cursor's key, or null when the text is not one this kind of list issues. */
export function decodeProjectCursor(cursor: string): ProjectCursor | null {
  const first = cursor.indexOf(':');
  const second = first < 0 ? -1 : cursor.indexOf(':', first + 1);
  if (first <= 0 || second < 0) return null;
  const createdAt = Number(cursor.slice(0, first));
  const projectId = cursor.slice(first + 1, second);
  const id = cursor.slice(second + 1);
  return Number.isSafeInteger(createdAt) && PROJECT_ID.test(projectId) && id.length > 0 ? { createdAt, projectId, id } : null;
}

/**
 * The page size and the predicate after the cursor for a newest-first list ordered by `order`, `project`, `id`, or
 * null for a cursor this list did not issue. `where` is empty on page one; its first parameter is the cursor's instant.
 */
export function projectKeyset(opts: { limit?: number; cursor?: string }, spec: { order: string; project: string; id: string }):
  { limit: number; where: string; params: readonly (number | string)[] } | null {
  const limit = clampLimit(opts.limit);
  if (opts.cursor === undefined) return { limit, where: '', params: [] };
  const after = decodeProjectCursor(opts.cursor);
  if (after === null) return null;
  const { order, project, id } = spec;
  return {
    limit,
    where: `${order} <= ? AND (${order} < ? OR (${order} = ? AND (${project} < ? OR (${project} = ? AND ${id} < ?))))`,
    params: [after.createdAt, after.createdAt, after.createdAt, after.projectId, after.projectId, after.id],
  };
}

/** The first `limit` rows and, when more remain, the cursor after the last. */
export function projectPage<T>(rows: readonly T[], limit: number, key: (row: T) => ProjectCursor): Page<T> {
  const more = rows.length > limit;
  const out = more ? rows.slice(0, limit) : rows;
  if (!more || out.length === 0) return { rows: out, cursor: null };
  return { rows: out, cursor: encodeProjectCursor(key(out[out.length - 1]!)) };
}
