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

/** Number of leading characters to show when rendering a session id compactly. */
export const SESSION_ID_PREVIEW_LENGTH = 8;

/** Return the first N characters of a session id, or empty string if null. */
export function shortSession(id: string | null | undefined): string {
  return id ? id.slice(0, SESSION_ID_PREVIEW_LENGTH) : '';
}

/** Return the final segment of a slash-separated path, or the input unchanged. */
export function basename(path: string): string {
  return path.split('/').pop() || path;
}

/** Capitalize the first letter of a string. */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Resolve an agent run's CURRENT-attempt start time: `resumed_at` when the
 * run has been resumed at least once, else `started_at`. `started_at` is
 * preserved as the run's ORIGINAL dispatch time across every resume (see
 * executor.ts) — per-attempt displays (duration, "started" recency,
 * rail-list section bucketing) must anchor on this instead, or a run
 * resumed long after its first dispatch reads as having a multi-day
 * duration / stale recency it never actually had.
 */
export function runAttemptStart(run: { started_at: number | null; resumed_at?: number | null }): number | null {
  return run.resumed_at ?? run.started_at;
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

/* ---------- Byte formatting ---------- */

const BYTES_PER_UNIT = 1024;
const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * Format a byte count as a human-readable string (e.g. "4.2 MB", "234 MB").
 * Values below 1024 are shown as bytes. Values at or above 100 in the chosen
 * unit lose the decimal for brevity (matches macOS Finder conventions).
 */
export function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_UNIT) return `${bytes} B`;
  let value = bytes / BYTES_PER_UNIT;
  let unitIdx = 0;
  while (value >= BYTES_PER_UNIT && unitIdx < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unitIdx++;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unitIdx]}`;
}
