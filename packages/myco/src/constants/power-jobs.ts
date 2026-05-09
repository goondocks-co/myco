/**
 * Canonical names for PowerManager-registered jobs. Centralized so call
 * sites (registration, fan-out, tests, log scrapers) reference one
 * source of truth instead of duplicating string literals.
 */
export const POWER_JOB_NAMES = {
  EMBEDDING_RECONCILE: 'embedding-reconcile',
  SESSION_MAINTENANCE: 'session-maintenance',
  LOG_RETENTION: 'log-retention',
  AUTO_BACKUP: 'auto-backup',
  DATABASE_OPTIMIZE: 'database-optimize',
  DATABASE_INTEGRITY_CHECK: 'database-integrity-check',
  STAGING_GC: 'staging-gc',
  CANOPY_BACKGROUND_SCAN: 'canopy-background-scan',
} as const;

export type PowerJobName = (typeof POWER_JOB_NAMES)[keyof typeof POWER_JOB_NAMES];
