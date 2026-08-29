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

/** How long something ran, from its start to its end or, unfinished, to now. */
export function formatDuration(startMs: number | null, endMs: number | null, now: number = Date.now()): string {
  if (startMs === null) return '—';
  const ms = Math.max(0, toMillis(endMs ?? now) - toMillis(startMs));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return minutes < 60 ? `${minutes}m ${seconds}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTokens(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

/** A cost in dollars, marked when it is an estimate rather than what the provider charged. */
export function formatCost(usd: number | null, source: string | null): string {
  if (usd === null) return '—';
  const amount = usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`;
  return source === 'estimated' ? `~${amount}` : amount;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
