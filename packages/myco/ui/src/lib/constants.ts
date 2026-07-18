export const POLL_INTERVALS = {
  // Generic buckets — used by consumers that don't yet adopt per-surface keys.
  HEALTH: 5_000,
  STATS: 10_000,
  LOGS: 3_000,
  PROGRESS: 1_000,
  UPDATE: 300_000,

  // Per-surface intervals — used by RefreshIndicator and the redesigned surfaces.
  RUNS_ACTIVE: 3_000,
  RUN_DETAIL: 5_000,
  SESSIONS: 8_000,
  SESSION_DETAIL: 8_000,
  SPORES: 30_000,
  CANOPY_ENTRIES: 60_000,
  GIT_IDENTITY: 5_000,
  TEAM: 5_000,
  CONTENT_CLAIMS: 15_000,
  HOST_MEMBERSHIP: 10_000,
  DRAIN_HEALTH: 15_000,
  HOST_SERVE_STATUS: 15_000,
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

/** Release channels — must match backend RELEASE_CHANNELS. */
export const RELEASE_CHANNELS = ['stable', 'beta'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** Default page size for paginated list views. */
export const DEFAULT_PAGE_SIZE = 50;

/** Default summary batch interval (0 = disabled). */
export const DEFAULT_SUMMARY_BATCH_INTERVAL = 5;

/** Default preferred digest tier for explicit Myco context retrieval. */
export const DEFAULT_DIGEST_TIER = 5000;

/** Default max spores injected per prompt. */
export const DEFAULT_MAX_SPORES = 3;

/** Milliseconds per second — used to convert stored epoch seconds for display. */
export const MS_PER_SECOND = 1_000;

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

/** Badge variant scheme shared by every Team Host health-classifier badge
 *  (designation/backup/key/mcp_coherence — `host-serve-status.ts`'s
 *  `health.*`), used by both dashboard cards that consume
 *  `useHostServeStatus` (`TeamHostServingCard`, `TeamHostServedCard`). */
export type HealthBadgeVariant = 'default' | 'secondary' | 'warning' | 'destructive';

/**
 * Map a health-classifier `kind` string to a badge tone. `ok` is positive;
 * `not_applicable`/`not_enabled` mean "nothing to check here" and get a
 * muted chip; `dangling`/`not_serving` are the designation kinds meaning
 * the served-grove reference no longer resolves on this machine — the
 * most severe case, since it means serving is running against a Grove that
 * doesn't (or no longer) exists here; every other kind (`stale`,
 * `missing_key`, `missing_token`, `undesignated`) is a plain warning.
 */
export function healthBadgeVariant(kind: string): HealthBadgeVariant {
  if (kind === 'ok') return 'default';
  if (kind === 'not_applicable' || kind === 'not_enabled') return 'secondary';
  if (kind === 'dangling' || kind === 'not_serving') return 'destructive';
  return 'warning';
}

/** `missing_key` → "missing key" — a health badge's visible label must
 *  never leak the classifier's own vocabulary (no "designation"/
 *  "classifier"/"coherence"), so callers pass the `kind` string through
 *  this instead of rendering it verbatim. */
export function humanizeHealthKind(kind: string): string {
  return kind.replace(/_/g, ' ');
}
