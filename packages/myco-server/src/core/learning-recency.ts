/** Work counts as fresh for this long after its source's last activity. */
export const FRESH_LEARNING_MS = 86_400_000;

/** Source activity classifies work independently of settlement, eligibility and retry clocks. */
export const learningRecencySql = (fresh: boolean, now: number): string =>
  `source_activity_at ${fresh ? '>' : '<='} ${Math.floor(now - FRESH_LEARNING_MS)}`;
