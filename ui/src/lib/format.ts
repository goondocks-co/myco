/* ---------- Time formatting utilities ---------- */

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;

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

export function formatTimeAgo(timestamp: string): string {
  const diff = (Date.now() - new Date(timestamp).getTime()) / 1_000;
  if (diff < SECONDS_PER_MINUTE) return 'just now';
  if (diff < SECONDS_PER_HOUR) return `${Math.floor(diff / SECONDS_PER_MINUTE)}m ago`;
  if (diff < SECONDS_PER_DAY) return `${Math.floor(diff / SECONDS_PER_HOUR)}h ago`;
  return `${Math.floor(diff / SECONDS_PER_DAY)}d ago`;
}
