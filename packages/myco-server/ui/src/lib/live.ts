/**
 * How fresh the dashboard's data is, decided in one place. Every query declares its freshness through `live(...)`
 * (or is the heartbeat), and this is the only file that sets a refresh interval; `tests/meta/dashboard-live-refresh.test.ts`
 * fails on a query that declares nothing and on an interval set anywhere else.
 *
 * - **The heartbeat** is the one read that refreshes by the clock: Myco's work now (`/api/work/now`), a bounded read
 *   whose rows-read ceilings are tested. It is read every `TICK_MS`, every `RUNNING_TICK_MS` while something runs,
 *   and never while the tab is hidden. `hooks/use-live.tsx` runs it.
 * - **`follows`**: a page's other reads re-read only when the heartbeat's marks they follow move — `runs` when a run
 *   starts, finishes, queues or fails, `sessions` when capture arrives, `knowledge` when a spore is written, edited,
 *   retired or deleted or a plan changes, `recovery` when a backup attempt starts, advances or settles, `fleet` when a
 *   runner's state changes, `attention` when a notice no other mark covers appears or clears. A page never polls a window of history by the clock. `until`
 *   adds the instant the answer goes stale by time alone (a live session falling quiet), so it is read again then
 *   even when nothing is stored.
 * - **`whileMoving`**: one read of work in motion (a running run, a switch, KPI historical measurement) is read every
 *   `MOVING_MS` while its own answer says it moves, and stops when it settles; `quick` reads a check a person just
 *   asked for every `QUICK_MS`.
 * - **`heavy`**: an aggregate is read once when shown and again only when a person asks; no clock,
 *   tab return or heartbeat re-reads it.
 * - **`still`**: a read that changes only when a person changes it here (settings, members), or one a parent read
 *   that itself follows a mark re-reads when its revision moves (a session's turns, files and commits).
 *
 * Every read the dashboard makes on its own carries `AUTOMATIC_HEADER`, so fetch traffic never counts as someone
 * using the Deployment; a person's presence is reported apart from it (`watchPresence`).
 */
import type { Query } from '@tanstack/react-query';
import { AUTOMATIC_HEADER, MARKS, PRESENCE_PATH, type Mark } from '@goondocks/myco-shared/live-marks';

export { AUTOMATIC_HEADER, MARKS, PRESENCE_PATH, type Mark };

/** How often the heartbeat reads while nothing runs. */
export const TICK_MS = 30_000;
/** How often the heartbeat reads while something runs. */
export const RUNNING_TICK_MS = 10_000;
/** How often one read of one thing in motion is read again. */
export const MOVING_MS = 10_000;
/** How often one row a person just set moving (a check they asked for) is read again until it settles. */
export const QUICK_MS = 2_000;
/** How often a page's clock moves, so "4 min ago" stays true. */
export const CLOCK_MS = 30_000;
/** The least wait before a read that goes stale by time is read again. */
const EXPIRY_FLOOR_MS = 1_000;


/** A query's freshness, as a page declares it. */
export type Freshness<T> =
  | { follows: readonly Mark[]; until?: (data: T | undefined) => number | null }
  | { whileMoving: (data: T | undefined) => boolean; quick?: true }
  | 'heavy'
  | 'still';

/** The freshness a cursor-paged read may declare: it follows marks, or holds still. */
export type PagedFreshness = { follows: readonly Mark[] } | 'heavy' | 'still';

/** Options that never refresh by the clock. */
interface StillOptions {
  refetchInterval: false;
  refetchOnWindowFocus?: boolean;
  refetchOnReconnect?: boolean;
  staleTime?: number;
  meta?: { follows: readonly Mark[] };
}

/** The query options a freshness stands for. */
type LiveOptions<T> = StillOptions | {
  refetchInterval: (query: Query<T, Error, T, readonly unknown[]>) => number | false;
  refetchIntervalInBackground: false;
  meta?: { follows: readonly Mark[] };
};

/** The query options a freshness stands for. Spread them into `useQuery`; never set an interval beside them. */
export function live(freshness: PagedFreshness): StillOptions;
export function live<T>(freshness: Freshness<T>): LiveOptions<T>;
export function live<T>(freshness: Freshness<T>): LiveOptions<T> {
  if (freshness === 'still') return { refetchInterval: false };
  if (freshness === 'heavy') return { refetchInterval: false, refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: 5 * 60_000 };
  if ('follows' in freshness) {
    const { follows, until } = freshness;
    if (until === undefined) return { refetchInterval: false, meta: { follows } };
    return {
      meta: { follows },
      refetchInterval: (query) => {
        const at = until(query.state.data);
        return at === null ? false : Math.max(EXPIRY_FLOOR_MS, at - Date.now());
      },
      refetchIntervalInBackground: false,
    };
  }
  const { whileMoving, quick } = freshness;
  return {
    refetchInterval: (query) => (whileMoving(query.state.data) ? (quick ? QUICK_MS : MOVING_MS) : false),
    refetchIntervalInBackground: false,
  };
}

/**
 * The heartbeat's own options: read every tick, faster while `running` says something runs, never while hidden. An
 * answer younger than the fast tick is fresh, so the shell and a page's panel mounting together share one read.
 */
export function heartbeat<T>(running: (data: T | undefined) => boolean) {
  return {
    staleTime: RUNNING_TICK_MS,
    refetchInterval: (query: Query<T, Error, T, readonly unknown[]>) => (running(query.state.data) ? RUNNING_TICK_MS : TICK_MS),
    refetchIntervalInBackground: false,
  };
}

/** The marks a query follows, read off its declared freshness. */
export function followedMarks(query: { meta?: Record<string, unknown> }): readonly Mark[] {
  const follows = query.meta?.follows;
  return Array.isArray(follows) ? follows.filter((mark): mark is Mark => (MARKS as readonly string[]).includes(mark)) : [];
}

/** A person's presence is reported at most this often. */
export const PRESENCE_MS = 60_000;

/**
 * Report a person's use of the dashboard, apart from every fetch it makes: on opening, and on a key, a pointer, a
 * scroll or the tab coming back into view, at most once per `PRESENCE_MS`. `report` sends the presence request.
 */
export function watchPresence(report: () => void, target: Window = window, now: () => number = Date.now): () => void {
  let reportedAt = -Infinity;
  const seen = () => {
    if (now() - reportedAt < PRESENCE_MS) return;
    reportedAt = now();
    report();
  };
  const shown = () => { if (target.document.visibilityState === 'visible') seen(); };
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
  for (const event of events) target.addEventListener(event, seen, { passive: true });
  target.document.addEventListener('visibilitychange', shown);
  if (target.document.visibilityState === 'visible') seen();
  return () => {
    for (const event of events) target.removeEventListener(event, seen);
    target.document.removeEventListener('visibilitychange', shown);
  };
}
