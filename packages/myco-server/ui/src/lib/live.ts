/**
 * How fresh the dashboard's data is, decided in one place. Every query declares its freshness here, and this is the
 * only file that sets a refresh interval (`tests/meta/dashboard-live-refresh.test.ts` fails on any other).
 *
 * - **The heartbeat** is the one read that refreshes by the clock: Myco's work now (`/api/work/now`), a bounded read
 *   whose rows-read ceilings are tested. It is read every `TICK_MS`, every `RUNNING_TICK_MS` while something runs,
 *   and never while the tab is hidden. `hooks/use-live.tsx` runs it.
 * - **`follows`**: a page's other reads re-read only when the heartbeat's marks they follow move — `runs` when a run
 *   starts, finishes, queues or fails, `sessions` when capture arrives, `fleet` when a runner's state changes. A page
 *   never polls a window of history by the clock.
 * - **`whileMoving`**: one small read of one thing in motion (a run that is running, a switch under way) is read every
 *   `MOVING_MS` while its own answer says it moves, and stops when it settles; `quick` reads a check a person just
 *   asked for every `QUICK_MS`.
 * - **`heavy`**: a measure over long windows is read once when shown and again only when a person asks; no clock,
 *   tab return or heartbeat re-reads it.
 *
 * A read the dashboard makes when no one has used it for a minute says so (`unattendedHeader`), so a page refreshing
 * itself in front of no one never counts as someone using the Deployment.
 */
import type { Query } from '@tanstack/react-query';

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

/** What moves the heartbeat reports, and a read can follow. */
export type Mark = 'runs' | 'sessions' | 'fleet';
export const MARKS: readonly Mark[] = ['runs', 'sessions', 'fleet'];

/** A query's freshness, as a page declares it. */
export type Freshness<T> =
  | { follows: readonly Mark[] }
  | { whileMoving: (data: T | undefined) => boolean; quick?: true }
  | 'heavy'
  | 'still';

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
};

/** The query options a freshness stands for. Spread them into `useQuery`; never set an interval beside them. */
export function live(freshness: { follows: readonly Mark[] } | 'heavy' | 'still'): StillOptions;
export function live<T>(freshness: Freshness<T>): LiveOptions<T>;
export function live<T>(freshness: Freshness<T>): LiveOptions<T> {
  if (freshness === 'still') return { refetchInterval: false };
  if (freshness === 'heavy') return { refetchInterval: false, refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: 5 * 60_000 };
  if ('follows' in freshness) return { refetchInterval: false, meta: { follows: freshness.follows } };
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
  return Array.isArray(follows) ? follows.filter((mark): mark is Mark => MARKS.includes(mark as Mark)) : [];
}

/** How long after a person last used the dashboard its reads stop counting as someone using the Deployment. */
export const PRESENCE_MS = 60_000;
export const UNATTENDED_HEADER = 'x-myco-unattended';

let lastPresenceAt = Date.now();

/** Note that a person is using the dashboard now. */
export function markPresence(at = Date.now()): void {
  lastPresenceAt = at;
}

/** The header a read carries when no one has used the dashboard within `PRESENCE_MS`, else none. */
export function unattendedHeader(now = Date.now()): Record<string, string> {
  return now - lastPresenceAt > PRESENCE_MS ? { [UNATTENDED_HEADER]: '1' } : {};
}

/** Follow a person's use of the dashboard: a key, a pointer, a scroll, or the tab coming back into view. */
export function watchPresence(target: Window = window): () => void {
  const seen = () => markPresence();
  const shown = () => { if (target.document.visibilityState === 'visible') markPresence(); };
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
  for (const event of events) target.addEventListener(event, seen, { passive: true });
  target.document.addEventListener('visibilitychange', shown);
  return () => {
    for (const event of events) target.removeEventListener(event, seen);
    target.document.removeEventListener('visibilitychange', shown);
  };
}
