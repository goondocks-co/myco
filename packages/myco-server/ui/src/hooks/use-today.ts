import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { buildTimeline, ledeCounts, type LedeCounts, type TimelineEntry } from '../features/today/timeline';
import type { TodaySession, TodaySessionPage, TodaySporePage } from '../features/today/wire';
import { freshness, LIVE_REFRESH_MS, useWork } from './use-work';

/** The most sessions one read of a day asks for at a time, and how many pages it reads before it says there are more. */
export const SESSION_PAGE = 200;
export const MAX_SESSION_PAGES = 5;
/** The most spores one read of a day asks for; a run's spore lines beyond these read as "and N more". */
export const SPORE_PAGE = 200;

/** One local day, from its first instant to the next day's. */
export interface DayWindow {
  start: number;
  end: number;
  /** Whether the day is today, so what it shows can still change. */
  isToday: boolean;
  /** The day as the `day` query parameter names it. */
  param: string;
  /** The day before, as a `day` parameter. */
  previous: string;
}

const DAY_PARAM = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A local day as `YYYY-MM-DD`. */
export function dayParam(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(start: number, days: number): number {
  const date = new Date(start);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** The day a `day` parameter names; today when it names none, names nothing, or names a day still to come. */
export function dayWindow(day: string | null, now: number): DayWindow {
  const today = startOfDay(now);
  const match = day === null ? null : DAY_PARAM.exec(day);
  let start = today;
  if (match !== null) {
    const named = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
    if (Number.isFinite(named) && dayParam(named) === day && named < today) start = named;
  }
  return { start, end: addDays(start, 1), isToday: start === today, param: dayParam(start), previous: dayParam(addDays(start, -1)) };
}

const projectParam = (projectId: string | null): string => (projectId === null ? '' : `&project=${encodeURIComponent(projectId)}`);

/** The `since` and `until` bounds of a day, its end excluded. */
const dayBounds = (window: DayWindow): string => `since=${window.start}&until=${window.end}`;

/**
 * The sessions active on the day, read page by page between its bounds: those
 * running at some point in it, whenever they started, so a session begun the
 * day before and live now is today's too. `truncated` when the day holds more
 * than the pages read.
 */
async function readDaySessions(projectId: string | null, window: DayWindow, signal: AbortSignal): Promise<{ rows: TodaySession[]; truncated: boolean }> {
  const base = `/api/sessions?${dayBounds(window)}&window=activity&limit=${SESSION_PAGE}${projectParam(projectId)}`;
  const rows: TodaySession[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
    const answer: TodaySessionPage = await fetchJson<TodaySessionPage>(cursor === null ? base : `${base}&cursor=${encodeURIComponent(cursor)}`, signal);
    rows.push(...answer.rows);
    cursor = answer.cursor;
    if (cursor === null) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export interface TodayQuery {
  /** The Project the page is narrowed to, or null for every Project. */
  projectId: string | null;
  /** The `day` parameter, or null for today. */
  day: string | null;
  now: number;
}

/**
 * Today: the day's sessions and Myco's work merged into one timeline, with the
 * lede's counts read off that same timeline. While the day is today, every read
 * asks again every 30 s, and never while the tab is hidden.
 */
export function useToday({ projectId, day, now }: TodayQuery) {
  const window = dayWindow(day, now);
  const scope = projectId ?? 'all';
  const live = freshness(window.isToday);
  const sessions = useQuery({
    queryKey: ['today', 'sessions', scope, window.start],
    queryFn: ({ signal }) => readDaySessions(projectId, window, signal),
    ...live,
  });
  const spores = useQuery({
    queryKey: ['today', 'spores', scope, window.start],
    queryFn: ({ signal }) => fetchJson<TodaySporePage>(`/api/spores?${dayBounds(window)}&limit=${SPORE_PAGE}${projectParam(projectId)}`, signal),
    ...live,
  });
  const work = useWork({ projectId, since: window.start, until: window.end, live: window.isToday });

  const entries = useMemo<TimelineEntry[] | undefined>(() => {
    if (sessions.data === undefined || work.data === undefined || spores.data === undefined) return undefined;
    return buildTimeline({ sessions: sessions.data.rows, runs: work.data.runs, spores: spores.data.spores, window, now });
  }, [sessions.data, work.data, spores.data, window.start, window.end, now]);
  const counts = useMemo<LedeCounts | undefined>(() => (entries === undefined ? undefined : ledeCounts(entries)), [entries]);

  return {
    window,
    entries,
    counts,
    work: work.data,
    /** Whether the day held more sessions or runs than were read. */
    truncated: (sessions.data?.truncated ?? false) || (work.data?.truncated ?? false),
    isPending: sessions.isPending || work.isPending || spores.isPending,
    error: sessions.error ?? work.error ?? spores.error,
    retry: () => { void sessions.refetch(); void work.refetch(); void spores.refetch(); },
  };
}

/** The clock a page reads relative times against, moved on every `intervalMs` so "4 min ago" stays true. */
export function useNow(intervalMs: number = LIVE_REFRESH_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
