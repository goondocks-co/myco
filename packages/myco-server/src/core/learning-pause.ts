import type { RelationalStore } from './adapters.js';
import { EXTRACTION_TASK } from './task-catalogue.js';

export const LEARNING_PAUSED = 'learning_paused';
export const LEARNING_PAUSED_AT = 'learning_paused_at';
export const LEARNING_RESUMED_AT = 'learning_resumed_at';
export const LEARNING_PAUSED_SQL = `EXISTS (SELECT 1 FROM schema_meta WHERE key = '${LEARNING_PAUSED_AT}')
  AND NOT EXISTS (SELECT 1 FROM schema_meta WHERE key = '${LEARNING_RESUMED_AT}')`;

export const pausedLearningSql = (task: string): string =>
  `(${task} = '${EXTRACTION_TASK}' AND ${LEARNING_PAUSED_SQL})`;

export async function learningPaused(db: RelationalStore): Promise<boolean> {
  return (await db.prepare(`SELECT ${LEARNING_PAUSED_SQL} AS paused`).first<{ paused: number }>())!.paused === 1;
}
