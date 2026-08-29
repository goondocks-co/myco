/** The resolved read scope. Every query takes one; no query resolves it. Phase 2's per-project contributor grants widen this type without touching a query. */
export interface ReadScope {
  readonly projectId: string;
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

/** Trims an over-fetched row set to the page and emits a cursor only when the extra row proved another page exists. */
export function page<T>(rows: readonly T[], limit: number, key: (row: T) => { createdAt: number; id: string }): Page<T> {
  const more = rows.length > limit;
  const out = more ? rows.slice(0, limit) : rows;
  if (!more || out.length === 0) return { rows: out, cursor: null };
  const last = key(out[out.length - 1]);
  return { rows: out, cursor: encodeCursor(last.createdAt, last.id) };
}
