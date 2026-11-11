import { shortTime } from '../work/words';
import type { RunHoursAnswer } from './RunsPage';

export type RunsWindow = 'day' | 'week';
interface Slice { at: number; worked: number; unchanged: number; failed: number }
type Lane = RunHoursAnswer['lanes'][number];

const HOUR_MS = 3_600_000;

/** A lane's counts in each slice of the window, oldest first, a slice with nothing finished included. */
export function slicesOf(answer: Pick<RunHoursAnswer, 'window'>, lane: Lane): Slice[] {
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

/** Whether a slice of the window is before check-ins were recorded, or else whether the lane's runner checked in during it. */
export type Presence = 'unrecorded' | 'checked-in' | 'silent';

/** A runner lane's check-ins in each slice of the window, oldest first. */
export function presenceOf(answer: Pick<RunHoursAnswer, 'window' | 'recordedSince'>, lane: Lane): Presence[] {
  const { since, until, sliceMs } = answer.window;
  const seen = new Set(lane.checkins.map((hour) => Math.floor((hour - since) / sliceMs)));
  return Array.from({ length: Math.round((until - since) / sliceMs) }, (_, i): Presence => {
    const end = since + (i + 1) * sliceMs;
    if (answer.recordedSince === null || end <= answer.recordedSince) return 'unrecorded';
    return seen.has(i) ? 'checked-in' : 'silent';
  });
}

/** The fewest hours in a row with nothing finished on any runner that the page names as a quiet spell. */
const QUIET_HOURS = 3;
/** The most quiet spells the page names, longest first. */
const QUIET_SHOWN = 3;

/** A spell of whole hours in which nothing finished on any runner, and its name in words. */
export interface QuietSpell { from: number; to: number; words: string }

/**
 * The spells of at least `QUIET_HOURS` whole hours in the window when nothing finished on any runner, longest first,
 * in words: "Nothing finished Mon 03:00 to Mon 06:00 (3 hours)". The hour still under way never counts as quiet.
 */
export function gapsOf(answer: Pick<RunHoursAnswer, 'window' | 'lanes'>, now: number): QuietSpell[] {
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
    .map(({ from: start, to }) => ({ from: start, to, words: `Nothing finished ${shortTime(start, now)} to ${shortTime(to, now)} (${(to - start) / HOUR_MS} hours)` }));
}

/** What a quiet spell's facts come to: nothing to look at, something worth a look, or facts not recorded for it. */
export type GapVerdict = 'normal' | 'look' | 'unrecorded';
export interface GapReading { verdict: GapVerdict; headline: string; facts: string[] }

const runs = (n: number) => `${n.toLocaleString()} run${n === 1 ? '' : 's'}`;
function names(list: readonly string[]): string {
  if (list.length <= 2) return list.join(' and ');
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`;
}

/** "once", "twice", "9 times". */
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n.toLocaleString()} times`);

/**
 * A quiet spell read from the counters alone: the waits in the queue that overlapped it (a stay that began before it
 * ended and ended after it began, whether a machine took the run or it left the queue unclaimed), whether queued work
 * from before its end still waits, and which runners checked in. The unit is a wait, one stay of a run in the queue: a
 * run that went back to the queue waits again. It looks normal only when nothing waited and a runner checked in; it is
 * worth a look when work waited or no runner checked in. A spell that starts before check-ins and waits were recorded
 * reads as not recorded, never as a verdict.
 */
export function gapReading(answer: Pick<RunHoursAnswer, 'lanes' | 'recordedSince' | 'waits' | 'stillWaiting'>, spell: Pick<QuietSpell, 'from' | 'to'>, now: number): GapReading {
  if (answer.recordedSince === null || spell.from < answer.recordedSince) {
    return { verdict: 'unrecorded', facts: [],
      headline: answer.recordedSince === null ? 'Not recorded: no runner check-ins are kept yet.' : `Not recorded: Myco keeps check-ins and waits from ${shortTime(answer.recordedSince, now)}.` };
  }
  const overlapping = answer.waits.filter((w) => w.leftHour >= spell.from && w.enteredHour < spell.to);
  const waited = overlapping.reduce((n, w) => n + w.waits, 0);
  const taken = overlapping.filter((w) => w.taken).reduce((n, w) => n + w.waits, 0);
  const still = answer.stillWaiting.filter((w) => w.since < spell.to);
  const checkedIn = answer.lanes.filter((lane) => lane.runnerId !== null && lane.checkins.some((hour) => hour >= spell.from && hour < spell.to)).map((lane) => lane.name ?? 'A runner no longer registered');
  const ended = [taken > 0 ? `a machine took the run ${times(taken)}` : null, waited - taken > 0 ? `it left the queue without a machine ${times(waited - taken)}` : null]
    .filter((part) => part !== null).join('; ');
  const facts = [
    waited === 0 ? (still.length === 0 ? 'Nothing was waiting.' : 'Nothing that has since left the queue waited during it.') : `Queued work waited ${times(waited)} during it: ${ended}.`,
    ...(still.length === 0 ? [] : [`Work queued before it ended still waits: ${runs(still.reduce((n, w) => n + w.runs, 0))} queued now.`]),
    checkedIn.length === 0 ? 'No runner checked in.' : `${names(checkedIn)} checked in.`,
  ];
  if (waited === 0 && still.length === 0 && checkedIn.length > 0) {
    return { verdict: 'normal', facts, headline: `Looks normal: nothing was waiting, ${checkedIn.length === 1 ? '1 runner' : `${checkedIn.length} runners`} checked in` };
  }
  const why = [waited > 0 ? `queued work waited ${times(waited)}` : null, still.length > 0 ? `${waited > 0 ? 'and ' : ''}work queued before it ended still waits` : null]
    .filter((part) => part !== null).join(', ');
  return { verdict: 'look', facts, headline: `Worth a look: ${why === '' ? 'no runner checked in' : why}` };
}
