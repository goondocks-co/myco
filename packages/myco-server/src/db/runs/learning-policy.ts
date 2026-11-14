/** Automatic learning reaches back this far from a session's last source activity. */
export const LEARNING_WINDOW_MS = 7 * 86_400_000;

/** Source activity bounds automatic learning independently of readiness and retry clocks. */
export const learningWindowSql = (now: number | string): string =>
  `aged_out_at IS NULL AND source_activity_at > ${typeof now === 'number' ? Math.floor(now - LEARNING_WINDOW_MS) : `(${now}-${LEARNING_WINDOW_MS})`}`;
