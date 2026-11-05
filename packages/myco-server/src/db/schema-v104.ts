import { IN_FLIGHT_RUN_STATUSES } from './run-statuses.js';

export const THIN_LEARNING_REMOVAL_VERSION = 104;
export const THIN_LEARNING_PAUSE_VERSION = 102;
export const THIN_LEARNING_NOT_DRAINED = 'thin_learning_not_drained';
export const THIN_LEARNING_PAUSE_REQUIRED = 'thin_learning_pause_required';
export const THIN_LEARNING_STEPPING_STONE_REQUIRED = 'thin_learning_stepping_stone_required';
export const THIN_LEARNING_STEPPING_STONE_REMEDY = 'Update to 2.0.0-alpha.13 first (schema 103), let in-flight learning runs finish or lapse, then update again.';
export const THIN_LEARNING_UPGRADE_REMEDY = 'let in-flight learning runs finish or lapse under the current version, then retry';

const validPause = `key='learning_paused_at' AND typeof(value)='text' AND length(value)>0
  AND value NOT GLOB '*[^0-9]*' AND CAST(value AS INTEGER)>0
  AND CAST(value AS INTEGER)<=${Number.MAX_SAFE_INTEGER}
  AND CAST(CAST(value AS INTEGER) AS TEXT)=value`;

const admissionRefusal = `SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM schema_meta WHERE ${validPause}) THEN '${THIN_LEARNING_PAUSE_REQUIRED}'
    WHEN EXISTS (SELECT 1 FROM thin_learning_runs WHERE task='extract-curate' AND ${IN_FLIGHT_RUN_STATUSES}
      AND (COALESCE(queued_at,started_at) IS NULL
        OR typeof(COALESCE(queued_at,started_at))!='integer'
        OR COALESCE(queued_at,started_at)<=(SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='learning_paused_at')))
      THEN '${THIN_LEARNING_NOT_DRAINED}'
    ELSE NULL END AS refusal`;

export const THIN_LEARNING_ADMISSION_SQL = `WITH thin_learning_runs AS (SELECT task,status,queued_at,started_at FROM agent_runs) ${admissionRefusal}`;

export const THIN_LEARNING_RUNS_TABLE_SQL = "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'";
export const THIN_LEARNING_PRE_PAUSE_ADMISSION_SQL = `SELECT CASE WHEN EXISTS (
  SELECT 1 FROM agent_runs WHERE task='extract-curate' AND ${IN_FLIGHT_RUN_STATUSES})
  THEN '${THIN_LEARNING_NOT_DRAINED}' ELSE NULL END AS refusal`;

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
