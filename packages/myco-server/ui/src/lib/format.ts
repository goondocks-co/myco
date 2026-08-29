/** Server timestamps are epoch milliseconds; a value that small enough to be seconds is treated as seconds. */
function toMillis(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

export function formatRelative(ts: number | null, now: number = Date.now()): string {
  if (ts === null) return 'never';
  const delta = Math.max(0, now - toMillis(ts));
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  if (delta < 30 * day) return `${Math.floor(delta / day)}d ago`;
  return new Date(toMillis(ts)).toLocaleDateString();
}

export function formatDateTime(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(toMillis(ts)).toLocaleString();
}

export function formatCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}
