export const POLL_INTERVALS = {
  HEALTH: 5_000,
  STATS: 10_000,
  LOGS: 3_000,
  PROGRESS: 1_000,
} as const;

export const STALE_TIME = 10_000;

/** Cache TTL for available model lists (30 seconds). */
export const MODELS_STALE_TIME = 30_000;

/** Log levels in severity order. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Task source labels — must match backend BUILT_IN_SOURCE / USER_TASK_SOURCE. */
export const TASK_SOURCE_BUILTIN = 'built-in';
export const TASK_SOURCE_USER = 'user';

/** Default agent run interval in seconds. */
export const DEFAULT_INTERVAL_SECONDS = 300;

/** Default summary batch interval (0 = disabled). */
export const DEFAULT_SUMMARY_BATCH_INTERVAL = 5;

/** Map log level to Badge variant. */
export function levelBadgeVariant(level: LogLevel): 'default' | 'secondary' | 'warning' | 'destructive' {
  switch (level) {
    case 'info': return 'default';
    case 'warn': return 'warning';
    case 'error': return 'destructive';
    default: return 'secondary';
  }
}

/** Colored dot indicator for log level. */
export function levelDotColor(level: LogLevel): string {
  switch (level) {
    case 'info':  return 'bg-primary';
    case 'debug': return 'bg-outline';
    case 'warn':  return 'bg-secondary';
    case 'error': return 'bg-tertiary';
    default:      return 'bg-outline';
  }
}
