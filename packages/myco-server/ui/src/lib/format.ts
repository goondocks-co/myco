/** Server timestamps are epoch milliseconds; a value that small enough to be seconds is treated as seconds. */
function toMillis(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago a past instant was. A future instant reads "just now": a capturing machine's clock can run ahead of
 * this one. Say a deadline with `formatUntil`.
 */
export function formatRelative(ts: number | null, now: number = Date.now()): string {
  if (ts === null) return 'never';
  const delta = Math.max(0, now - toMillis(ts));
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  return new Date(toMillis(ts)).toLocaleDateString();
}

/**
 * How long until a future instant, as the span that follows "in": seconds until two minutes out (a lease renews on a
 * 30s heartbeat), then minutes, hours and days. `coarse` suits a schedule: no seconds, and hours from one hour out.
 * An instant already past is "now"; a caller says what past means.
 */
export function formatUntil(ts: number, now: number = Date.now(), coarse = false): string {
  const delta = toMillis(ts) - now;
  if (delta <= 0) return 'now';
  if (!coarse && delta < 2 * MINUTE) return `${Math.ceil(delta / 1000)}s`;
  if (delta < (coarse ? HOUR : 2 * HOUR)) return `${Math.max(1, Math.floor(delta / MINUTE))}m`;
  if (delta < 2 * DAY) return `${Math.round(delta / HOUR)}h`;
  return `${Math.round(delta / DAY)}d`;
}

export function formatDateTime(ts: number | null, options?: Intl.DateTimeFormatOptions): string {
  if (ts === null) return '—';
  return new Date(toMillis(ts)).toLocaleString(undefined, options);
}

export function formatCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

/** A duration already measured in milliseconds, as a tool call reports one. */
export function formatMillis(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

/** A span already measured in milliseconds, from milliseconds up to days: what a person waited. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return `${Math.floor(ms / 86_400_000)}d ${Math.floor((ms % 86_400_000) / 3_600_000)}h`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
