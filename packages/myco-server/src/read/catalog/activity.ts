import type { RelationalStore } from '../../core/adapters.js';
import type { ReadScope } from '../scope.js';
import { readActivityPage, type ActivityKey } from '../../db/activity/feed.js';
import { ACTIVITY_KINDS, type ActivityKind } from '../../db/activity/schema.js';
import { sessions_sessionLabel } from './sessions.js';

/** One line of a project's recent activity: a session that started, a run that ran, a spore that landed, a plan edited. */
interface activity_FeedItem {
  type: ActivityKind;
  id: string;
  summary: string;
  at: number;
  /** The Myco session the item belongs to, when it has one. A run's provider session ref is not one. */
  sessionId: string | null;
}

/** One feed page, newest first: `nextCursor` continues it while `hasMore`; `building` while existing records are still being added. */
interface activity_FeedPage { items: activity_FeedItem[]; nextCursor: string | null; hasMore: boolean; building: boolean }

const activity_DEFAULT_FEED = 20;

const activity_MAX_FEED = 100;

/**
 * The prefix naming the feed cursor's encoding: the instant, the kind, then the source. It marks a position, not a
 * snapshot: unedited records neither repeat nor drop across pages, and a record edited meanwhile moves to the head, where
 * a fresh first page shows it.
 */
const CURSOR_PREFIX = 'a1:';

/** The refusal of a cursor the feed did not issue. */
const activity_CURSOR_REFUSAL = `malformed cursor: the activity feed pages by "${CURSOR_PREFIX}<instant>:<kind>:<id>" exactly as its last answer returned it in \`nextCursor\`. `
  + 'Nothing was read: request the first page again without a cursor.';

const KINDS: ReadonlySet<string> = new Set(ACTIVITY_KINDS);

/** The key of a cursor the feed issued, or null for any other text. */
function activity_decodeCursor(text: string): ActivityKey | null {
  if (!text.startsWith(CURSOR_PREFIX)) return null;
  const body = text.slice(CURSOR_PREFIX.length);
  const first = body.indexOf(':');
  const second = first < 0 ? -1 : body.indexOf(':', first + 1);
  if (first <= 0 || second < 0) return null;
  const sortAt = Number(body.slice(0, first));
  const kind = body.slice(first + 1, second);
  const sourceId = body.slice(second + 1);
  return Number.isSafeInteger(sortAt) && KINDS.has(kind) && sourceId.length > 0 ? { sortAt, kind, sourceId } : null;
}

/**
 * The project's recent activity, newest first, across sessions, runs, active spores and plans, a page at a time; null
 * for a cursor the feed did not issue. A record edited while a reader pages moves to the head of the feed: a reader
 * already past it does not see it again, a reader not yet at it does not reach it on later pages, and a fresh first page
 * shows it. Every unedited record keeps its place, so later pages neither repeat nor drop one. A session's line
 * carries the label the session list shows; a deleted session and its plans are not listed.
 */
async function activity_activityFeed(db: RelationalStore, scope: ReadScope, opts: { limit?: number; cursor?: string } = {}): Promise<activity_FeedPage | null> {
  const { limit: requested } = opts;
  const limit = requested === undefined || !Number.isSafeInteger(requested) || requested < 1 ? activity_DEFAULT_FEED : Math.min(requested, activity_MAX_FEED);
  const after = opts.cursor === undefined ? null : activity_decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return null;
  const page = await readActivityPage(db, { projectId: scope.projectId, after, limit });
  const shown = page.rows.slice(0, limit);
  const items = shown.map((row): activity_FeedItem => {
    const label = row.kind === 'session' ? page.sessions.get(row.source_id) : undefined;
    return {
      type: row.kind, id: row.source_id, at: row.sort_at, sessionId: row.session_id,
      summary: row.kind === 'session' ? sessions_sessionLabel(label?.title ?? null, label?.first_prompt ?? null, label?.agent ?? null)
        : row.preview ?? '',
    };
  });
  const last = shown.at(-1);
  const more = page.rows.length > limit && last !== undefined;
  return { items, hasMore: more, nextCursor: more ? `${CURSOR_PREFIX}${last.sort_at}:${last.kind}:${last.source_id}` : null, building: page.building };
}

export { type activity_FeedItem, type activity_FeedPage, activity_MAX_FEED, activity_CURSOR_REFUSAL, activity_activityFeed };
