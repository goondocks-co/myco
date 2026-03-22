/* ---------- Time formatting utilities ---------- */

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;

/** Milliseconds per second — used for epoch conversions. */
const MS_PER_SECOND = 1_000;

export function formatUptime(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) return `${Math.floor(seconds)}s`;
  if (seconds < SECONDS_PER_HOUR) return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`;
  if (seconds < SECONDS_PER_DAY) {
    const h = Math.floor(seconds / SECONDS_PER_HOUR);
    const m = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / SECONDS_PER_DAY);
  const h = Math.floor((seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  return `${d}d ${h}h`;
}

/** Format an ISO timestamp string as a relative "X ago" label. */
export function formatTimeAgo(timestamp: string): string {
  const diff = (Date.now() - new Date(timestamp).getTime()) / MS_PER_SECOND;
  if (diff < SECONDS_PER_MINUTE) return 'just now';
  if (diff < SECONDS_PER_HOUR) return `${Math.floor(diff / SECONDS_PER_MINUTE)}m ago`;
  if (diff < SECONDS_PER_DAY) return `${Math.floor(diff / SECONDS_PER_HOUR)}h ago`;
  return `${Math.floor(diff / SECONDS_PER_DAY)}d ago`;
}

/** Format a Unix epoch (seconds) as a relative "X ago" label. */
export function formatEpochAgo(epochSeconds: number): string {
  return formatTimeAgo(new Date(epochSeconds * MS_PER_SECOND).toISOString());
}

/** Format a Unix epoch (seconds) as a locale-formatted absolute date/time string. */
export function formatEpochAbsolute(epochSeconds: number): string {
  return new Date(epochSeconds * MS_PER_SECOND).toLocaleString();
}

/** Truncate a string to a max length, appending an ellipsis if needed. */
export function truncate(text: string | null, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\u2026' : text;
}

/** Capitalize the first letter of a string. */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
