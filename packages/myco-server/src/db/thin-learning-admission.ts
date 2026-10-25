import type { RelationalStore } from '../core/adapters.js';
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

/** Upgrade admission precedes every schema step that crosses the removal boundary. */
export function* thinLearningUpgradeAdmission(
  before: number, target: number, report: (line: string) => void,
): Generator<string, void, Record<string, unknown>[]> {
  if (!(before < THIN_LEARNING_REMOVAL_VERSION && target >= THIN_LEARNING_REMOVAL_VERSION)) return;
  if (before === 0) {
    const tables = yield THIN_LEARNING_RUNS_TABLE_SQL;
    if (tables.length === 0) return;
    if (tables.length !== 1 || tables[0]!.name !== 'agent_runs') throw new Error('thin learning admission returned an invalid table result');
  }
  if (before < THIN_LEARNING_PAUSE_VERSION) {
    report(THIN_LEARNING_STEPPING_STONE_REMEDY);
    throw new Error(THIN_LEARNING_STEPPING_STONE_REQUIRED);
  }
  try {
    admitThinLearningRemoval(yield THIN_LEARNING_ADMISSION_SQL);
  } catch (error) {
    if (error instanceof Error && [THIN_LEARNING_NOT_DRAINED, THIN_LEARNING_PAUSE_REQUIRED].includes(error.message)) report(THIN_LEARNING_UPGRADE_REMEDY);
    throw error;
  }
}

/** A store failure or unrecognised result cannot establish that thin work drained. */
export function admitThinLearningRemoval(rows: readonly Record<string, unknown>[]): void {
  if (rows.length !== 1 || !Object.hasOwn(rows[0]!, 'refusal')) throw new Error('thin learning admission returned no result');
  const refusal = rows[0]!.refusal;
  if (refusal === THIN_LEARNING_NOT_DRAINED || refusal === THIN_LEARNING_PAUSE_REQUIRED) throw new Error(refusal);
  if (refusal !== null) throw new Error('thin learning admission returned an invalid refusal');
}

const incomingRunsAdmission = `WITH thin_learning_runs AS (SELECT json_extract(value,'$.task') AS task,json_extract(value,'$.status') AS status,
  json_extract(value,'$.queued_at') AS queued_at,json_extract(value,'$.started_at') AS started_at FROM json_each(?)) ${admissionRefusal}`;

/** Restored dispatches meet the same boundary before any artifact row is written. */
export async function assertThinLearningDrained(db: RelationalStore, runs?: readonly Record<string, unknown>[]): Promise<void> {
  const result = await (runs === undefined ? db.prepare(THIN_LEARNING_ADMISSION_SQL)
    : db.prepare(incomingRunsAdmission).bind(JSON.stringify(runs))).all<Record<string, unknown>>();
  admitThinLearningRemoval(result.results);
}
