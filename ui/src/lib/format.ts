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

/**
 * Format the duration between two epoch-second timestamps as a human-readable string.
 * Returns an em dash if either timestamp is null.
 */
export function formatDuration(startEpoch: number | null, endEpoch: number | null): string {
  if (startEpoch === null || endEpoch === null) return '\u2014';
  const ms = (endEpoch - startEpoch) * MS_PER_SECOND;
  if (ms < MS_PER_SECOND) return `${ms}ms`;
  if (ms < SECONDS_PER_MINUTE * MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
  const minutes = Math.floor(ms / (SECONDS_PER_MINUTE * MS_PER_SECOND));
  const seconds = Math.floor((ms % (SECONDS_PER_MINUTE * MS_PER_SECOND)) / MS_PER_SECOND);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format a millisecond duration as a human-readable string.
 * Returns an em dash if null.
 */
export function formatDurationMs(ms: number | null): string {
  if (ms === null) return '\u2014';
  if (ms < MS_PER_SECOND) return `${ms}ms`;
  return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
}

/**
 * Parse a string to a number, returning `fallback` when the input is empty,
 * non-numeric, or NaN. Unlike `Number(s) || fallback`, this correctly handles
 * the value `0` (which is a valid input for "disabled" fields).
 */
export function parseNumericField(value: string, fallback: number): number {
  if (value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Format a nullable epoch timestamp as a relative label, or return an em dash.
 * Convenience wrapper for components that frequently null-check before calling formatEpochAgo.
 */
export function formatEpochRelative(epoch: number | null): string {
  return epoch !== null ? formatEpochAgo(epoch) : '\u2014';
}
