import type { WorkWindow } from './words';

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(at: number, days: number): number {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** A window's bounds on day boundaries, so they hold still while the day lasts: today, or the past seven days with today. */
export function workBounds(window: WorkWindow, now: number): { since: number; until: number } {
  const today = startOfDay(now);
  return { since: window === 'today' ? today : addDays(today, -6), until: addDays(today, 1) };
}
