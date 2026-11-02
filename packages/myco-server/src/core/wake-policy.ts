/** Timing shared by the Deployment's hosted alarm and native wake loop. */
export const ENSURE_SOON_MS = 1_000;
export const CONTINUATION_FLOOR_MS = 2_000;
export const WAKE_FAILURE_MIN_MS = 30_000;
export const WAKE_FAILURE_MAX_MS = 5 * 60_000;

/** The sooner requested deadline; an idle clock cannot cancel a continuation. */
export function soonestWake(tickMs: number | null, continuationMs: number | null): number | null {
  if (tickMs === null) return continuationMs;
  if (continuationMs === null) return tickMs;
  return Math.min(tickMs, continuationMs);
}

/** Failed ticks hold ordinary work until their bounded retry deadline; successful ticks reset it. */
export function wakePolicy() {
  let failures = 0;
  let retryAt = 0;
  return {
    remaining: (now: number): number => Math.max(0, retryAt - now),
    workAt: (now: number, delayMs = ENSURE_SOON_MS): number => Math.max(now + delayMs, retryAt),
    failed: (now: number): number => {
      const delay = Math.min(WAKE_FAILURE_MIN_MS * 2 ** failures, WAKE_FAILURE_MAX_MS);
      failures = Math.min(failures + 1, Math.ceil(Math.log2(WAKE_FAILURE_MAX_MS / WAKE_FAILURE_MIN_MS)));
      retryAt = now + delay;
      return delay;
    },
    succeeded: (): void => { failures = 0; retryAt = 0; },
  };
}
