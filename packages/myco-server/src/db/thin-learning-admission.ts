import { THIN_LEARNING_REMOVAL_VERSION, THIN_LEARNING_PAUSE_VERSION, THIN_LEARNING_STEPPING_STONE_REMEDY,
  THIN_LEARNING_STEPPING_STONE_REQUIRED, THIN_LEARNING_ADMISSION_SQL, THIN_LEARNING_UPGRADE_REMEDY,
  THIN_LEARNING_NOT_DRAINED, THIN_LEARNING_PAUSE_REQUIRED, THIN_LEARNING_RUNS_TABLE_SQL } from './schema-v104.js';
export { THIN_LEARNING_REMOVAL_VERSION, THIN_LEARNING_PAUSE_VERSION, THIN_LEARNING_ADMISSION_SQL, THIN_LEARNING_NOT_DRAINED, THIN_LEARNING_PAUSE_REQUIRED,
  THIN_LEARNING_STEPPING_STONE_REQUIRED, THIN_LEARNING_STEPPING_STONE_REMEDY, THIN_LEARNING_UPGRADE_REMEDY,
  THIN_LEARNING_RUNS_TABLE_SQL, THIN_LEARNING_PRE_PAUSE_ADMISSION_SQL } from './schema-v104.js';

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
