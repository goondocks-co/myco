import type { WorkWindow } from './words';

const DAY = 86_400_000;

/** A window's bounds on UTC days, so they hold still while the day lasts: today, or the last seven UTC days through today. */
export function workBounds(window: WorkWindow, now: number): { since: number; until: number } {
  const today = Math.floor(now / DAY) * DAY;
  return { since: window === 'today' ? today : today - 6 * DAY, until: today + DAY };
}
