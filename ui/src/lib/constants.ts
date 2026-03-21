export const POLL_INTERVALS = {
  HEALTH: 5_000,
  STATS: 10_000,
  LOGS: 3_000,
  PROGRESS: 1_000,
} as const;

export const STALE_TIME = 10_000;

/** Cache TTL for available model lists (30 seconds). */
export const MODELS_STALE_TIME = 30_000;
