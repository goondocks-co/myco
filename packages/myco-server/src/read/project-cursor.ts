/**
 * Cursors of lists that span Projects. A row of such a list is keyed by its Project and its id, so the cursor carries
 * `p1:<instant>:<projectId>:<id>` and the list orders by the instant, then the id, then the Project, all descending (the
 * session list orders the Project before the id, and its `p2:` cursors say so): two
 * rows of different Projects sharing an instant and an id each keep their own place across a page boundary. The `p1:`
 * prefix names the encoding, so a cursor without it, whatever its id holds, is never read as one of these.
 */
import type { Page } from './scope.js';

/** The Project id grammar the schema enforces: no `:`, so the cursor splits unambiguously. */
const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The refusal of a cursor this list did not issue, including one from before cursors carried the Project. */
export const PROJECT_CURSOR_REFUSAL =
  'malformed cursor: this list pages by "p1:<instant>:<projectId>:<id>" exactly as its last answer returned it in `cursor`; '
  + 'a cursor issued before lists across Projects carried the Project is refused. Nothing was read: request the first page again without a cursor.';

export interface ProjectCursor { createdAt: number; projectId: string; id: string }

const PREFIX = 'p1:';

/** The cursors of the session list across Projects, which orders by the instant, the Project and then the id. */
const SESSIONS_ACROSS_PREFIX = 'p2:';

/** The refusal of a cursor the session list across Projects did not issue, including one from before it ordered by the Project first. */
export const SESSIONS_ACROSS_CURSOR_REFUSAL =
  'malformed cursor: this list pages by "p2:<instant>:<projectId>:<id>" exactly as its last answer returned it in `cursor`; '
  + 'a cursor issued before the list ordered by Project and then id is refused. Nothing was read: request the first page again without a cursor.';

export function encodeProjectCursor(key: ProjectCursor): string {
  return `${PREFIX}${key.createdAt}:${key.projectId}:${key.id}`;
}

/** The cursor's key, or null when the text is not one this kind of list issues: every text without the `p1:` prefix is refused. */
export function decodeProjectCursor(text: string): ProjectCursor | null {
  return text.startsWith(PREFIX) ? decodeKey(text.slice(PREFIX.length)) : null;
}

/** The key of a cursor the session list across Projects issued, or null for any other text. */
export function decodeSessionsAcrossCursor(text: string): ProjectCursor | null {
  return text.startsWith(SESSIONS_ACROSS_PREFIX) ? decodeKey(text.slice(SESSIONS_ACROSS_PREFIX.length)) : null;
}

function decodeKey(cursor: string): ProjectCursor | null {
  const first = cursor.indexOf(':');
  const second = first < 0 ? -1 : cursor.indexOf(':', first + 1);
  if (first <= 0 || second < 0) return null;
  const createdAt = Number(cursor.slice(0, first));
  const projectId = cursor.slice(first + 1, second);
  const id = cursor.slice(second + 1);
  return Number.isSafeInteger(createdAt) && PROJECT_ID.test(projectId) && id.length > 0 ? { createdAt, projectId, id } : null;
}

function pageOf<T>(rows: readonly T[], limit: number, cursor: (row: T) => string): Page<T> {
  const more = rows.length > limit;
  const out = more ? rows.slice(0, limit) : rows;
  if (!more || out.length === 0) return { rows: out, cursor: null };
  return { rows: out, cursor: cursor(out[out.length - 1]!) };
}

/** The first `limit` rows and, when more remain, the cursor after the last. */
export function projectPage<T>(rows: readonly T[], limit: number, key: (row: T) => ProjectCursor): Page<T> {
  return pageOf(rows, limit, row => encodeProjectCursor(key(row)));
}

/** The first `limit` rows of the session list across Projects and, when more remain, the cursor after the last. */
export function sessionsAcrossPage<T>(rows: readonly T[], limit: number, key: (row: T) => ProjectCursor): Page<T> {
  return pageOf(rows, limit, row => {
    const at = key(row);
    return `${SESSIONS_ACROSS_PREFIX}${at.createdAt}:${at.projectId}:${at.id}`;
  });
}
