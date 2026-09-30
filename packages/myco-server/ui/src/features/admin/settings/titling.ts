/**
 * Where titling stands, in the reader's words: sessions that ended here are
 * titled on their own within the daily limit, and sessions imported from a
 * machine's history are titled while "Title imported sessions" and work on a
 * schedule are both on.
 */
import { formatUntil } from '../../../lib/format';
import type { TitlingBackfillProgress } from './wire';

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const STATE_WORDS: Readonly<Record<string, string>> = { active: 'in use', idle: 'idle', sleep: 'asleep' };

/** When titles may start and how often, as the schedule sets it. */
export function policyWords(p: Pick<TitlingBackfillProgress, 'runIn' | 'intervalSeconds'>): string {
  const states = p.runIn.map((s) => STATE_WORDS[s] ?? s);
  const when = states.length === 0
    ? 'in no state of the server'
    : `while the server is ${states.length === 1 ? states[0] : `${states.slice(0, -1).join(', ')} or ${states[states.length - 1]}`}`;
  const minutes = Math.max(1, Math.round(p.intervalSeconds / 60));
  return `Titles start ${when}, at most once every ${minutes} min.`;
}

/** An instant a hold lifts, as a clock time and how far off it is; one already reached, or unknown, reads "soon". */
export const liftsAt = (until: number | null, now: number): string =>
  (until === null || until <= now ? 'soon' : `at ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (in ${formatUntil(until, now, true)})`);

/**
 * Why no title is starting while sessions wait for one; empty when nothing
 * holds it. A title can start only in the states the schedule names, so a
 * lifted hold says when one can start, never when one will.
 */
export function waitingWords(p: Pick<TitlingBackfillProgress, 'waiting' | 'runsPerDay'>, now: number = Date.now()): string {
  const w = p.waiting;
  if (w === null) return '';
  if (w.reason === 'ceiling') {
    if (p.runsPerDay === 0) return 'The daily limit is 0, so nothing is titled until it is raised under Task overrides.';
    return `Today’s limit of ${p.runsPerDay ?? 0} is reached; the next title can start ${liftsAt(w.until, now)}.`;
  }
  if (w.reason === 'overlap') return 'Waiting for the title in progress to finish.';
  return `The next titles can start ${liftsAt(w.until, now)}.`;
}

/** Where titling stands in full: what waits for a title, what holds it, when titles start, and how today went. */
export function progressWords(p: TitlingBackfillProgress, now: number = Date.now()): string {
  const owed = p.owed === 0
    ? 'No session that ended here is waiting for a title.'
    : `${plural(p.owed, 'session that ended here is', 'sessions that ended here are')} waiting for a title; they are titled on their own within the daily limit.`;
  const left = p.remaining === 0
    ? 'No imported session is waiting for a title.'
    : `${plural(p.remaining, 'imported session is', 'imported sessions are')} waiting for a title.`;
  const imported = !p.backfillEnabled ? `${left} Titling imported sessions is off.`
    : !p.scheduledTasksEnabled ? `${left} Titling them is on, but runs only while Work on a schedule is on.`
    : left;
  const ceiling = p.runsPerDay === null ? `${p.usedToday} started` : `${p.usedToday} of ${p.runsPerDay} started`;
  const waiting = waitingWords(p, now);
  return `${owed} ${imported} ${waiting === '' ? '' : `${waiting} `}${policyWords(p)} Today: ${ceiling}, ${p.inFlight} in progress, ${p.completedToday} titled, ${p.failedToday} failed.`;
}
