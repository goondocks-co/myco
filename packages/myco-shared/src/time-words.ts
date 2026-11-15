/**
 * How every screen and status line says when something happened. Under a week it is relative, in minutes, hours
 * or days; from a week on it is the day itself. A missing or zero instant is no instant: it never reads as a date.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Epoch milliseconds; a value small enough to be seconds is read as seconds. */
function toMillis(at: number): number {
  return at < 1e12 ? at * 1000 : at;
}

/** Whether an instant is one: a missing, zero, negative or non-finite value is not. */
export function isInstant(at: number | null | undefined): at is number {
  return typeof at === 'number' && Number.isFinite(at) && at > 0;
}

/** A day as a short date: "Sep 12", with the year when it is not this one. */
export function dayWords(at: number, now: number = Date.now()): string {
  const date = new Date(toMillis(at));
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/**
 * How long ago a past instant was: "just now", "4 min ago", "4 h ago", "yesterday", "3 days ago", then the day,
 * "on Oct 11". A future instant reads "just now": a capturing machine's clock can run ahead of this one. A missing
 * or zero instant reads "never".
 */
export function agoWords(at: number | null, now: number = Date.now()): string {
  if (!isInstant(at)) return 'never';
  const ms = toMillis(at);
  const delta = Math.max(0, now - ms);
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} h ago`;
  if (delta < WEEK) {
    const days = Math.floor(delta / DAY);
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  return `on ${dayWords(ms, now)}`;
}

/** The time of day on the 24-hour clock: "09:39". */
export function clockWords(at: number): string {
  return new Date(toMillis(at)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** A date and time as a fact reads: "Sep 29, 14:02", with the year when it is not this one. */
export function dateTimeWords(at: number, now: number = Date.now()): string {
  return `${dayWords(at, now)}, ${clockWords(at)}`;
}
