/** Work counts as fresh for this long after its source's last activity. */
export const FRESH_LEARNING_MS = 86_400_000;

/** Source activity classifies work independently of settlement, eligibility and retry clocks. */
export const learningRecencySql = (fresh: boolean, now: number | string): string =>
  `source_activity_at ${fresh ? '>' : '<='} ${typeof now === 'number' ? Math.floor(now - FRESH_LEARNING_MS) : `(${now}-${FRESH_LEARNING_MS})`}`;

/** Consecutive claims an admitted fresh session may take per stage before history policy holds it. */
export const FRESH_LEARNING_ATTEMPTS = 4;

/** A session admitted while fresh retains bounded attempts for its unfinished stage. */
export const freshRetrySql = (kind: 'cards' | 'learning'): string =>
  `fresh_admitted = 1 AND ${kind === 'cards' ? 'card_failures' : 'failures'} < ${FRESH_LEARNING_ATTEMPTS}`;

/** Source freshness and the bounded continuation are separate admission conditions. */
export const learningRangeSql = (kind: 'cards' | 'learning', fresh: boolean, now: number | string): string => fresh
  ? `(${learningRecencySql(true, now)} OR (${freshRetrySql(kind)}))`
  : `(${learningRecencySql(false, now)} AND NOT (${freshRetrySql(kind)}))`;
