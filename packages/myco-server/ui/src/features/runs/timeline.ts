import { shortTime } from '../work/words';
import type { RunHoursAnswer } from './RunsPage';

export type RunsWindow = 'day' | 'week';
interface Slice { at: number; worked: number; unchanged: number; failed: number }

/** A lane's counts in each slice of the window, oldest first, a slice with nothing finished included. */
export function slicesOf(answer: Pick<RunHoursAnswer, 'window'>, lane: RunHoursAnswer['lanes'][number]): Slice[] {
  const { since, until, sliceMs } = answer.window;
  const slices = Array.from({ length: Math.round((until - since) / sliceMs) }, (_, i): Slice => ({ at: since + i * sliceMs, worked: 0, unchanged: 0, failed: 0 }));
  for (const hour of lane.hours) {
    const slice = slices[Math.floor((hour.hour - since) / sliceMs)];
    if (slice === undefined) continue;
    slice.worked += hour.worked;
    slice.unchanged += hour.unchanged;
    slice.failed += hour.failed;
  }
  return slices;
}

/** The fewest hours in a row with nothing finished on any runner that the page names as a quiet spell. */
const QUIET_HOURS = 3;
const HOUR_MS = 3_600_000;
/** The most quiet spells the page names, longest first. */
const QUIET_SHOWN = 3;

/**
 * The spells of at least `QUIET_HOURS` whole hours in the window when nothing finished on any runner, longest first,
 * in words: "Nothing finished Mon 03:00 to Mon 06:00 (3 hours)". The hour still under way never counts as quiet.
 */
export function gapsOf(answer: Pick<RunHoursAnswer, 'window' | 'lanes'>, now: number): string[] {
  const { since } = answer.window;
  const end = Math.floor(now / HOUR_MS) * HOUR_MS;
  const busy = new Set(answer.lanes.flatMap((lane) => lane.hours.filter((h) => h.worked + h.unchanged + h.failed > 0).map((h) => h.hour)));
  const spells: Array<{ from: number; to: number }> = [];
  let from: number | null = null;
  for (let hour = since; hour <= end; hour += HOUR_MS) {
    const quiet = hour < end && !busy.has(hour);
    if (quiet && from === null) from = hour;
    if (!quiet && from !== null) { if (hour - from >= QUIET_HOURS * HOUR_MS) spells.push({ from, to: hour }); from = null; }
  }
  return spells.sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, QUIET_SHOWN)
    .map(({ from: start, to }) => `Nothing finished ${shortTime(start, now)} to ${shortTime(to, now)} (${(to - start) / HOUR_MS} hours)`);
}
