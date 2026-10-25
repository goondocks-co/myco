import { THIN_LEARNING_ADMISSION_SQL, THIN_LEARNING_NOT_DRAINED, THIN_LEARNING_PAUSE_REQUIRED } from './thin-learning-admission.js';

/** Thin extraction consumers can be removed only after their dispatches drain. */
export const V104_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS _v104_guard_thin_learning (
    pause_required INTEGER NOT NULL CONSTRAINT ${THIN_LEARNING_PAUSE_REQUIRED} CHECK(pause_required=0),
    not_drained INTEGER NOT NULL CONSTRAINT ${THIN_LEARNING_NOT_DRAINED} CHECK(not_drained=0))`,
  `INSERT INTO _v104_guard_thin_learning(pause_required,not_drained)
    SELECT CASE WHEN refusal='${THIN_LEARNING_PAUSE_REQUIRED}' THEN 1 ELSE 0 END,
      CASE WHEN refusal='${THIN_LEARNING_NOT_DRAINED}' THEN 1 ELSE 0 END FROM (${THIN_LEARNING_ADMISSION_SQL})`,
  'DROP TABLE _v104_guard_thin_learning',
];
